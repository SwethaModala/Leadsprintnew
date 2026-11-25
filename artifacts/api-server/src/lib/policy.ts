/**
 * Call policy gate — implements the non-negotiable safety rules from the
 * LeadSprint product plan (section 11 "Safety policy" / section 8 "n8n
 * workflows: 04 Error and safety"):
 *
 *   consent valid?
 *     -> not suppressed?
 *       -> within quiet hours?
 *         -> attempt limit available?
 *           -> provider kill switch off?
 *             -> enqueue call
 *
 * This runs before any outbound provider request (Retell/Twilio) is made,
 * so a business misconfiguration or a bad lead state fails closed instead
 * of placing a call it shouldn't.
 */

export type PolicyBlockReason =
  | "consent_invalid"
  | "suppressed"
  | "dnd_registered"
  | "dnd_unverified"
  | "location_unknown"
  | "quiet_hours"
  | "attempt_limit"
  | "kill_switch";

export interface PolicyDecision {
  allowed: boolean;
  reason?: PolicyBlockReason;
  message?: string;
}

export interface PolicyBusinessInput {
  market?: "US" | "IN";
  timezone: string;
  quietHours: string | null | undefined;
  maxCallAttempts: number;
}

export interface PolicyContactInput {
  consentStatus: string;
  suppressedAt: Date | null;
  dndStatus?: string | null;
  consentCategory?: string | null;
  // True when this contact's number is on the business's do-not-call list
  // (lib/suppression.ts), whichever contact row the opt-out was recorded on.
  // Optional only so pure unit tests can omit it; the dispatcher always sets it.
  onSuppressionList?: boolean;
  // The CALLED PARTY's IANA timezone (see lib/areaCodeTimezones.ts) — not
  // the business's. TCPA quiet hours (8am–9pm) / TRAI hours (9am–9pm IST)
  // are defined by the recipient's local time.
  timezone: string | null | undefined;
}

/**
 * The widest window LeadSprint will ever dial in, in the RECIPIENT's local
 * time, whatever a business configures.
 * - US: 08:00–20:00 (covers FL/OK 8pm cutoffs)
 * - IN (TRAI TCCCPR): 09:00–21:00 IST
 */
export const CALLING_WINDOW_FLOOR = { start: 8 * 60, end: 20 * 60 } as const;
export const TRAI_CALLING_WINDOW_FLOOR = { start: 9 * 60, end: 21 * 60 } as const;

export function callingWindowFloorForMarket(market: "US" | "IN" = "US") {
  return market === "IN" ? TRAI_CALLING_WINDOW_FLOOR : CALLING_WINDOW_FLOOR;
}

interface QuietHoursWindow {
  startMinutes: number;
  endMinutes: number;
}

function parseQuietHours(quietHours: string | null | undefined): QuietHoursWindow | null {
  if (!quietHours) return null;
  const match = quietHours.trim().match(/^(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, startH, startM, endH, endM] = match.map(Number);
  if (startH > 23 || endH > 23 || startM > 59 || endM > 59) return null;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  // An empty window ("21:00-21:00") can't express anything meaningful.
  if (startMinutes === endMinutes) return null;
  return { startMinutes, endMinutes };
}

/**
 * Returns a human-readable problem with a quiet-hours setting, or `null`
 * when it is usable. Used to reject bad values when they are saved, instead
 * of discovering them at dial time.
 */
export function validateQuietHours(quietHours: string | null | undefined): string | null {
  if (parseQuietHours(quietHours)) return null;
  return 'Quiet hours must be a 24-hour window like "21:00-08:00" (start and end must differ).';
}

function localMinutesIn(timezone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Whether calling this recipient is blocked right now: inside the business's
 * quiet-hours window, or outside the CALLING_WINDOW_FLOOR, both measured in
 * the recipient's local time. Handles overnight windows such as 21:00–08:00.
 *
 * Fails CLOSED. An unparseable or missing quiet-hours value, or a timezone
 * that can't be resolved, blocks the call. (It used to fail open: "9pm-8am"
 * or an unknown zone meant "never blocked", and a bad zone silently fell
 * back to UTC.)
 */
export function isWithinQuietHours(
  quietHours: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
  market: "US" | "IN" = "US",
): boolean {
  const window = parseQuietHours(quietHours);
  if (!window) return true;
  const nowMinutes = localMinutesIn(timezone, now);
  if (nowMinutes === null) return true;

  const floor = callingWindowFloorForMarket(market);
  if (nowMinutes < floor.start || nowMinutes >= floor.end) return true;

  const { startMinutes, endMinutes } = window;
  if (startMinutes < endMinutes) {
    // Same-day window, e.g. 09:00–17:00
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight window, e.g. 21:00–08:00
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function nextAllowedCallTime(
  quietHours: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
  stepMs = 5 * 60 * 1000,
  market: "US" | "IN" = "US",
): Date {
  if (!isWithinQuietHours(quietHours, timezone, now, market)) return now;
  const limit = now.getTime() + 24 * 60 * 60 * 1000;
  for (let t = now.getTime() + stepMs; t <= limit; t += stepMs) {
    if (!isWithinQuietHours(quietHours, timezone, new Date(t), market)) {
      // One minute past the boundary, so the retry cannot land a second
      // before the window opens and read as still-blocked.
      return new Date(t + 60 * 1000);
    }
  }
  // A window that is 24h wide is a misconfiguration; block, don't guess.
  return new Date(limit);
}

export function isKillSwitchEngaged(): boolean {
  const value = process.env["LEADSPRINT_KILL_SWITCH"]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "on";
}

export function evaluateCallPolicy(input: {
  business: PolicyBusinessInput;
  contact: PolicyContactInput;
  attemptsSoFar: number;
  now?: Date;
}): PolicyDecision {
  const { business, contact, attemptsSoFar } = input;
  const now = input.now ?? new Date();

  if (contact.consentStatus !== "valid") {
    return {
      allowed: false,
      reason: "consent_invalid",
      message: "Contact consent is not valid for outbound contact.",
    };
  }

  const market = business.market === "IN" ? "IN" : "US";

  if (contact.suppressedAt || contact.onSuppressionList) {
    return {
      allowed: false,
      reason: "suppressed",
      message: "This contact is suppressed and cannot be called.",
    };
  }

  if (market === "IN") {
    if (contact.dndStatus === "registered") {
      return {
        allowed: false,
        reason: "dnd_registered",
        message: "Contact number is marked as DND registered under TRAI rules and cannot be dialed.",
      };
    }
    if (contact.consentCategory === "promotional" && contact.dndStatus !== "clear") {
      return {
        allowed: false,
        reason: "dnd_unverified",
        message: "Promotional calls in India require verified non-DND (clear) status.",
      };
    }
  }

  if (!contact.timezone) {
    return {
      allowed: false,
      reason: "location_unknown",
      message: "Could not determine the recipient's timezone; blocking rather than guessing.",
    };
  }

  if (isWithinQuietHours(business.quietHours, contact.timezone, now, market)) {
    const floorLabel = market === "IN" ? "never before 09:00 or after 21:00 IST" : "never before 08:00 or after 20:00";
    return {
      allowed: false,
      reason: "quiet_hours",
      message: `Outside allowed calling hours (quiet hours ${business.quietHours}, ${floorLabel}; ${contact.timezone}, recipient local time).`,
    };
  }

  if (attemptsSoFar >= business.maxCallAttempts) {
    return {
      allowed: false,
      reason: "attempt_limit",
      message: `Maximum call attempts (${business.maxCallAttempts}) already reached for this lead.`,
    };
  }

  if (isKillSwitchEngaged()) {
    return {
      allowed: false,
      reason: "kill_switch",
      message: "LEADSPRINT_KILL_SWITCH is engaged; all outbound calling is paused.",
    };
  }

  return { allowed: true };
}
