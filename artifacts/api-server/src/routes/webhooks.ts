import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  activitiesTable,
  appointmentsTable,
  businessesTable,
  callsTable,
  contactsTable,
  db as defaultDb,
  leadsTable,
  providerEventsTable,
} from "@workspace/db";
import { normalizePhone, samePhone, suppressContact } from "../lib/suppression";
import {
  extractRetellCall,
  hasTwilioSmsConfig,
  providerConfig,
  sendTwilioSms,
  type CalcomCredentialOverride,
  type RetellCredentialOverride,
  type TwilioCredentialOverride,
  verifyCalSignature,
  verifyRetellSignature,
  verifyTwilioSignature,
  verifyWebhookSignature,
} from "../lib/providers";
import { timezoneForPhoneNumber } from "../lib/areaCodeTimezones";
import {
  authenticateTenantApiKey,
  loadTenantProviderSecrets,
} from "../lib/security";
import { sha256Hex, timingSafeEqualString } from "../lib/crypto";
import {
  ConsentEvidenceError,
  describeConsent,
  normalizeConsentEvidence,
} from "../lib/consent";
import {
  dispatchQueuedCall,
  enqueueCallForLead,
  intakeIdempotencyKey,
} from "../lib/callQueue";
import { recordVoiceUsage, VOICE_COST_PER_MINUTE } from "../lib/usage";
import { reconcileCallAndBillUnderLock } from "../lib/callBilling";
import { tenantEventBus } from "../lib/eventBus";
import { createWebhookLimiter } from "../middlewares/rateLimit";
import { classifyUrgency, getProfile, isOutOfArea, validateDetails } from "../lib/verticals";
import { sendBusinessAlertEmail } from "../lib/mailer";

const router: IRouter = Router();

// Provider callbacks arrive without an operator session, so the limiter
// runs before any signature check — a flood must be shed cheaply.
// Scoped to /webhooks: this router is mounted at the /api root, so a bare
// router.use(limiter) would also throttle every operator-console request.
router.use("/webhooks", createWebhookLimiter());

/**
 * Validates timestamp freshness to prevent webhook replay attacks.
 * Accepts Date, ISO string, or numeric epoch timestamp (seconds or milliseconds).
 * Returns true if the timestamp is within maxAgeSeconds (default 300s = 5m) of now.
 */
export function isTimestampFresh(
  timestamp: Date | string | number | undefined | null,
  maxAgeSeconds = 300,
): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    return false;
  }
  let time: number;
  if (typeof timestamp === "number") {
    time = timestamp > 1e11 ? timestamp : timestamp * 1000;
  } else if (timestamp instanceof Date) {
    time = timestamp.getTime();
  } else if (typeof timestamp === "string") {
    if (/^\d+$/.test(timestamp.trim())) {
      const num = Number(timestamp.trim());
      time = num > 1e11 ? num : num * 1000;
    } else {
      time = new Date(timestamp).getTime();
    }
  } else {
    return false;
  }

  if (!Number.isFinite(time) || Number.isNaN(time)) {
    return false;
  }

  const skewMs = Math.abs(Date.now() - time);
  return skewMs <= maxAgeSeconds * 1000;
}

// Overridable database handle — see lib/callQueue.ts for why the
// acceptance tests run against a real embedded PostgreSQL rather than a mock.
let db: typeof defaultDb = defaultDb;

export function __setWebhooksDb(next: typeof defaultDb): void {
  db = next;
}

export function __resetWebhooksDb(): void {
  db = defaultDb;
}

function rawBody(req: Request): Buffer {
  return (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
}

function eventId(req: Request, body: Record<string, unknown>, eventType?: string): string {
  const candidate =
    (typeof body.event_id === "string" && body.event_id) ||
    req.get("x-event-id") ||
    undefined;
  if (candidate) {
    return eventType && !candidate.startsWith(`${eventType}_`) ? `${eventType}_${candidate}` : candidate;
  }
  const prefix = eventType ? `${eventType}_` : "";
  if (typeof body.id === "string" && body.id) {
    return `${prefix}${body.id}`;
  }
  return `${prefix}${crypto.createHash("sha256").update(rawBody(req)).digest("hex")}`;
}

async function acceptProviderEvent(
  input: {
    businessId: string;
    provider: string;
    externalEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
  dbHandle: any = db,
): Promise<boolean> {
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(input.payload))
    .digest("hex");
  const [created] = await dbHandle
    .insert(providerEventsTable)
    .values({
      id: `event_${crypto.randomUUID().slice(0, 12)}`,
      businessId: input.businessId,
      provider: input.provider,
      externalEventId: input.externalEventId,
      payloadHash,
      eventType: input.eventType,
      payload: input.payload,
      processedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        providerEventsTable.businessId,
        providerEventsTable.provider,
        providerEventsTable.externalEventId,
      ],
    })
    .returning({ id: providerEventsTable.id });
  return Boolean(created);
}

function signatureFor(req: Request): string | undefined {
  return req.get("x-retell-signature") ?? req.get("x-leadsprint-signature");
}

function bearerOrApiKeyFrom(req: Request): string | undefined {
  const authHeader = req.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const headerKey = req.get("x-api-key")?.trim();
  if (headerKey) return headerKey;
  const legacyKey = req.get("x-leadsprint-key")?.trim();
  if (legacyKey && legacyKey.startsWith("ls_live_")) return legacyKey;
  return undefined;
}

/**
 * Optional key auth for no-code senders against a *tenant-specific* encrypted
 * intake webhook secret when INTAKE_ALLOW_KEY_AUTH=true. Never falls back to a
 * deployment-global secret.
 */
function tenantLegacyKeyAccepted(req: Request, tenantSecret: string | undefined): boolean {
  if (process.env["INTAKE_ALLOW_KEY_AUTH"] !== "true" || !tenantSecret) return false;
  const provided = req.get("x-leadsprint-key")?.trim();
  if (!provided) return false;
  return timingSafeEqualString(provided, tenantSecret);
}

type IntakeConsent = ReturnType<typeof normalizeConsentEvidence> & { evidenceText: string | null };

/**
 * Consent for an incoming lead. For Meta lead-ad leads a sender cannot simply
 * assert `consent_status: "valid"`: consent is valid only when the form's
 * explicit consent was given AND its wording and form id are present, and that
 * wording is kept as evidence. Anything less stays "unknown" and the safety
 * gate refuses to call. A source may still REVOKE. Every other source behaves
 * exactly as it always has.
 */
function resolveIntakeConsent(body: Record<string, unknown>, formId: string, consentText: string): IntakeConsent {
  if (body.source === "meta_lead_ads" && body.consent_status !== "revoked") {
    const source = formId ? `meta_lead_form:${formId}` : null;
    if (body.consent_given === true && consentText && formId) {
      return { consentStatus: "valid", consentSource: source, consentAt: new Date(), evidenceText: consentText };
    }
    return { consentStatus: "unknown", consentSource: source, consentAt: null, evidenceText: null };
  }
  return {
    ...normalizeConsentEvidence({ status: body.consent_status, source: body.consent_source, at: body.consent_at }),
    evidenceText: null,
  };
}

/**
 * Fire-and-forget: tells the client's owner about an emergency lead the moment
 * it arrives. Never awaited by intake and never allowed to fail it.
 */
function notifyEmergencyLead(
  req: Request,
  input: {
    to: string;
    businessName: string;
    name: string;
    phone: string;
    source: string;
    details: Record<string, string | number | boolean>;
    consentStatus: string;
    outOfArea: boolean;
  },
): void {
  const { details } = input;
  const place = [details.address, details.zip].filter((v) => v !== undefined && v !== "").join(" · ");
  const status = input.outOfArea
    ? "OUT OF SERVICE AREA: the AI will not call this lead. Please decide how to respond."
    : input.consentStatus === "valid"
      ? "The AI assistant is calling this lead now, or as soon as legal calling hours allow."
      : "No valid consent is recorded, so the AI will not call. Please contact the customer yourself.";
  const lines = [
    `EMERGENCY lead for ${input.businessName}`,
    `Name: ${input.name}`,
    `Phone: ${input.phone}`,
    `Problem: ${details.problem ?? "not provided"}`,
    `Service: ${details.service_type ?? "not provided"}`,
    `Where: ${place || "not provided"}`,
    `Source: ${input.source}`,
    status,
  ];
  Promise.resolve()
    .then(() => sendBusinessAlertEmail(input.to, `EMERGENCY lead: ${input.name}`, lines))
    .catch((err) => req.log?.warn?.({ err }, "Emergency lead email could not be sent"));
}

async function handleIntakeWebhook(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const paramBusinessId =
    typeof req.params.businessId === "string" ? req.params.businessId.trim() : "";
  const bodyBusinessId =
    typeof body.business_id === "string" ? body.business_id.trim() : "";
  const headerBusinessId = req.get("x-business-id")?.trim() ?? "";

  let businessId = "";
  let authenticatedVia: "api_key" | "hmac" | "legacy_key" | null = null;

  const rawApiKey = bearerOrApiKeyFrom(req);
  if (rawApiKey) {
    const keyAuth = await authenticateTenantApiKey(db, rawApiKey, "leads:intake");
    if (!keyAuth) {
      res.status(401).json({ error: "Invalid or expired API key" });
      return;
    }
    const requestedTenant = paramBusinessId || bodyBusinessId || headerBusinessId;
    if (requestedTenant && requestedTenant !== keyAuth.businessId) {
      res.status(403).json({ error: "API key is not authorized for the requested workspace" });
      return;
    }
    businessId = keyAuth.businessId;
    authenticatedVia = "api_key";
  } else {
    const candidateTenant = paramBusinessId || bodyBusinessId || headerBusinessId;
    if (!candidateTenant) {
      res.status(401).json({ error: "Tenant authentication required" });
      return;
    }
    let intakeSecrets: Record<string, string> | null = null;
    try {
      intakeSecrets = await loadTenantProviderSecrets(db, candidateTenant, "intake");
    } catch {
      res.status(401).json({ error: "Invalid intake signature" });
      return;
    }
    const tenantSecret = intakeSecrets?.webhook_secret;
    const sigHeader = signatureFor(req);
    const hmacValid = verifyWebhookSignature(rawBody(req), sigHeader, tenantSecret);
    if (hmacValid) {
      businessId = candidateTenant;
      authenticatedVia = "hmac";
    } else if (tenantLegacyKeyAccepted(req, tenantSecret)) {
      businessId = candidateTenant;
      authenticatedVia = "legacy_key";
    } else {
      res.status(401).json({ error: "Invalid intake signature" });
      return;
    }
  }

  const rawTimestamp = req.get("x-webhook-timestamp") ?? body.timestamp;
  if (authenticatedVia === "hmac") {
    if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === "") {
      res.status(401).json({ error: "Webhook timestamp header (x-webhook-timestamp) or body.timestamp is required" });
      return;
    }
    if (!isTimestampFresh(rawTimestamp as string | number | Date, 300)) {
      res.status(400).json({ error: "Webhook timestamp expired" });
      return;
    }
  } else if (rawTimestamp !== undefined && rawTimestamp !== null && rawTimestamp !== "") {
    if (!isTimestampFresh(rawTimestamp as string | number | Date, 300)) {
      res.status(400).json({ error: "Webhook timestamp expired" });
      return;
    }
  }

  const [business] = await db.select().from(businessesTable).where(eq(businessesTable.id, businessId)).limit(1);
  if (!business) {
    res.status(404).json({ error: "Business not found" });
    return;
  }

  const market = (business.market === "IN" ? "IN" : "US") as "US" | "IN";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const rawPhone = typeof body.phone === "string" ? body.phone : "";
  const phone = rawPhone ? normalizePhone(rawPhone, market) : "";
  if (!businessId || !name || !phone) {
    res.status(400).json({ error: "business_id, name, and phone are required" });
    return;
  }

  const explicitEventId = req.get("x-event-id")?.trim() || req.get("x-webhook-id")?.trim();
  if (authenticatedVia === "hmac" || explicitEventId) {
    const replayId =
      explicitEventId ??
      sha256Hex(`${signatureFor(req) ?? ""}:${String(rawTimestamp)}:${rawBody(req).toString("utf8")}`);
    const freshEvent = await acceptProviderEvent({
      businessId,
      provider: "intake",
      externalEventId: replayId,
      eventType: "lead_intake",
      payload: body,
    });
    if (!freshEvent) {
      res.status(409).json({ error: "Duplicate webhook replay detected" });
      return;
    }
  }

  // Industry fields. Validated before anything is written, so a malformed
  // payload creates nothing.
  const detailsResult = validateDetails(body.details);
  if (!detailsResult.ok) {
    res.status(400).json({ error: detailsResult.error });
    return;
  }
  const details = detailsResult.details;
  if (body.consent_text !== undefined && (typeof body.consent_text !== "string" || body.consent_text.length > 1000)) {
    res.status(400).json({ error: "consent_text must be a string of at most 1000 characters." });
    return;
  }
  const dndStatus =
    body.dnd_status === "clear" || body.dnd_status === "registered" || body.dnd_status === "unknown"
      ? body.dnd_status
      : "unknown";
  const consentCategory =
    body.consent_category === "transactional" ||
    body.consent_category === "promotional" ||
    body.consent_category === "inquiry"
      ? body.consent_category
      : "inquiry";

  const consentText = typeof body.consent_text === "string" ? body.consent_text.trim() : "";
  const formId = typeof body.form_id === "string" ? body.form_id.trim().slice(0, 100) : "";
  const [existing] = await db.select({ id: contactsTable.id, phone: contactsTable.phone }).from(contactsTable).where(and(eq(contactsTable.businessId, businessId), samePhone(contactsTable.phone, rawPhone, market))).limit(1);
  if (existing) {
    // A lead source revoking consent for someone we already hold must take
    // effect. Previously the duplicate check returned first, so a
    // "consent_status: revoked" update was silently dropped and the person
    // stayed callable.
    if (body.consent_status === "revoked") {
      await suppressContact(db, { businessId, contactId: existing.id, phone: existing.phone, reason: "Consent revoked by lead source", source: "intake_revoked" });
      res.status(200).json({ accepted: true, reason: "consent_revoked", contact_id: existing.id });
      return;
    }
    res.status(200).json({ accepted: false, reason: "duplicate" });
    return;
  }
  // Launch gate: the signed intake payload must carry explicit consent
  // evidence. A lead with no recorded reason it is lawful to call lands as
  // "unknown" and is never dialed — the policy gate blocks it and the
  // console shows why. `consent_status: "valid"` without a
  // `consent_source` is rejected outright rather than silently downgraded,
  // so a miswired lead source is visible to whoever integrated it.
  let consent: IntakeConsent;
  try {
    consent = resolveIntakeConsent(body, formId, consentText);
  } catch (error) {
    if (error instanceof ConsentEvidenceError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }

  const contactId = `contact_${crypto.randomUUID().slice(0, 12)}`;
  const leadId = `lead_${crypto.randomUUID().slice(0, 12)}`;
  await db.insert(contactsTable).values({
    id: contactId,
    businessId,
    name,
    phone,
    email: typeof body.email === "string" ? body.email : null,
    timezone: timezoneForPhoneNumber(phone, market),
    consentStatus: consent.consentStatus,
    consentSource: consent.consentSource,
    consentAt: consent.consentAt,
    consentEvidence: consent.evidenceText,
    dndStatus,
    consentCategory,
  });
  // Urgency and the service-area decision are made here, once, from the
  // workspace's profile; the engine itself never branches on an industry.
  const urgency = classifyUrgency(getProfile(business.vertical), { urgency: body.urgency, problem: details.problem });
  const outOfArea = isOutOfArea(business.serviceAreaZips ?? [], details);
  await db.insert(leadsTable).values({
    id: leadId,
    businessId,
    contactId,
    source: typeof body.source === "string" ? body.source : "webhook",
    campaign: typeof body.campaign === "string" ? body.campaign : "Inbound enquiry",
    project: typeof body.project === "string" ? body.project : "Configured project",
    propertyType: typeof body.property_type === "string" ? body.property_type : "Not specified",
    budgetLabel: typeof body.budget_label === "string" ? body.budget_label : "Not specified",
    location: typeof body.location === "string" ? body.location : "Not specified",
    timeline: typeof body.timeline === "string" ? body.timeline : "Not specified",
    intentScore: 50,
    score: "warm",
    status: "new",
    nextAction: outOfArea ? "Out of service area — review" : "Call lead",
    details,
    urgency,
  });
  await db.insert(activitiesTable).values({ id: `activity_${crypto.randomUUID().slice(0, 12)}`, businessId, type: "intake", title: `New lead received for ${name}`, detail: `Authenticated intake webhook accepted · ${describeConsent(consent)}` });
  if (outOfArea) {
    await db.insert(activitiesTable).values({
      id: `activity_${crypto.randomUUID().slice(0, 12)}`,
      businessId,
      type: "intake",
      title: `${name} is outside the service area`,
      detail: `ZIP ${String(details.zip ?? "from address")} is not in this business's service area, so no call was placed.`,
    });
  }
  if (urgency === "emergency" && business.notifyEmail) {
    notifyEmergencyLead(req, {
      to: business.notifyEmail,
      businessName: business.name,
      name,
      phone,
      source: typeof body.source === "string" ? body.source : "webhook",
      details,
      consentStatus: consent.consentStatus,
      outOfArea,
    });
  }

  // THE speed-to-lead step. Previously this webhook stopped at "lead
  // created" and a human had to open the console and press Call, which
  // makes the product an operator-assisted response desk, not LeadSprint.
  // Intake now creates one idempotent call job and dispatches it
  // immediately; the safety policy gate still runs inside
  // dispatchQueuedCall, so consent/suppression/quiet hours/attempt limits
  // and the kill switch are all enforced before any provider request.
  // A lead outside the business's service area is kept for review but never
  // queued: calling someone the company cannot serve wastes provider minutes.
  const queued = outOfArea
    ? null
    : await enqueueCallForLead({
        businessId,
        leadId,
        idempotencyKey: intakeIdempotencyKey(leadId),
        source: "intake",
      });

  let callState: { call_id?: string; status: string; detail?: string } = {
    status: "not_queued",
    ...(outOfArea ? { detail: "Outside the service area" } : {}),
  };
  if (queued) {
    const dispatch = await dispatchQueuedCall({ businessId, callId: queued.call.id });
    callState = {
      call_id: queued.call.id,
      status: dispatch.outcome,
      detail: dispatch.message,
    };
    if (dispatch.outcome !== "started") {
      // A call that could not be placed right now is not lost: the
      // workflow job stays queued and POST /api/cron/process-jobs retries
      // it under the same idempotency key. Non-retryable outcomes (e.g.
      // revoked consent) are already recorded as policy_blocked and are
      // operator-visible.
      req.log?.warn?.(
        { businessId, leadId, callId: queued.call.id, outcome: dispatch.outcome },
        "Intake call was not started immediately",
      );
    }
  }

  res.status(201).json({
    accepted: true,
    lead_id: leadId,
    consent_status: consent.consentStatus,
    urgency,
    call: callState,
  });
}

router.post("/webhooks/intake", handleIntakeWebhook);
router.post("/webhooks/intake/:businessId", handleIntakeWebhook);

router.post("/webhooks/retell", async (req, res): Promise<void> => {
  const config = providerConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Retell's real envelope is { event, call: {...} } — pull call fields
  // from the nested object, not the top level.
  const call = extractRetellCall(body);
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  const metadata = (call.metadata && typeof call.metadata === "object" ? call.metadata : {}) as Record<string, unknown>;
  const businessId = typeof metadata.business_id === "string" ? metadata.business_id : "";

  let tenantRetell: RetellCredentialOverride | null = null;
  if (businessId) {
    try {
      tenantRetell = (await loadTenantProviderSecrets(db, businessId, "retell")) as RetellCredentialOverride | null;
    } catch {
      res.status(401).json({ error: "Invalid Retell signature" });
      return;
    }
  }
  const webhookKey =
    tenantRetell?.webhook_secret ??
    tenantRetell?.api_key ??
    config.retell.webhookSecret ??
    config.retell.apiKey;
  if (!verifyRetellSignature(rawBody(req), req.get("x-retell-signature"), webhookKey)) {
    res.status(401).json({ error: "Invalid Retell signature" });
    return;
  }
  if (!callId || !businessId) {
    res.status(400).json({ error: "call.call_id and call.metadata.business_id are required" });
    return;
  }
  const [business] = await db.select({ id: businessesTable.id }).from(businessesTable).where(eq(businessesTable.id, businessId)).limit(1);
  if (!business) {
    // Without this check, an unknown business_id (malformed payload, stale
    // metadata, or a bad-faith request that got past signature verification
    // some other way) hits the providerEventsTable foreign-key constraint
    // and throws a raw 500 instead of a clean rejection.
    res.status(404).json({ error: "Unknown business_id" });
    return;
  }
  const eventType = typeof body.event === "string" ? body.event : "call_update";
  const rawExtEventId = eventId(req, body, eventType);

  let reconcileResult: { billed: boolean; status: string; callId?: string; isTerminal?: boolean } = {
    billed: false,
    status: "unmatched",
  };

  await db.transaction(async (tx) => {
    // Standard lock hierarchy: 1. Lock call row
    const [callRow] = await tx
      .select()
      .from(callsTable)
      .where(and(eq(callsTable.businessId, businessId), eq(callsTable.providerCallId, callId)))
      .for("update");

    if (!callRow) {
      // Unmatched path: call row does not exist yet.
      // Store as unmatched_webhook with payload; on conflict (redelivery), safely update latest_retry_at.
      const payloadHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      await tx
        .insert(providerEventsTable)
        .values({
          id: `event_${crypto.randomUUID().slice(0, 12)}`,
          businessId,
          provider: "Retell",
          externalEventId: rawExtEventId,
          payloadHash,
          eventType: "unmatched_webhook",
          payload: {
            ...body,
            unmatched_call_id: callId,
            received_at: new Date().toISOString(),
          },
          processedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            providerEventsTable.businessId,
            providerEventsTable.provider,
            providerEventsTable.externalEventId,
          ],
          set: {
            payload: sql`jsonb_set(${providerEventsTable.payload}, '{latest_retry_at}', to_jsonb(${new Date().toISOString()}::text))`,
          },
          where: eq(providerEventsTable.eventType, "unmatched_webhook"),
        });

      return;
    }

    // Call row exists: record provider event idempotency
    const accepted = await acceptProviderEvent(
      {
        businessId,
        provider: "Retell",
        externalEventId: rawExtEventId,
        eventType,
        payload: body,
      },
      tx,
    );

    if (!accepted) {
      // Duplicate delivery of an already processed event
      reconcileResult = { billed: false, status: callRow.status, callId: callRow.id };
      return;
    }

    const startTimestampMs = typeof call.start_timestamp === "number" ? call.start_timestamp : undefined;
    const endTimestampMs = typeof call.end_timestamp === "number" ? call.end_timestamp : undefined;
    const durationMs = typeof call.duration_ms === "number" ? call.duration_ms : undefined;
    const disconnectionReason = typeof call.disconnection_reason === "string" ? call.disconnection_reason : undefined;

    const res = await reconcileCallAndBillUnderLock(tx, {
      callId: callRow.id,
      businessId,
      providerStatus: typeof call.call_status === "string" ? call.call_status : undefined,
      startTimestampMs,
      endTimestampMs,
      durationMs,
      disconnectionReason,
      transcript: typeof call.transcript === "string" ? call.transcript : undefined,
      analysis: typeof call.call_analysis === "string" ? call.call_analysis : undefined,
      sourceEvent: `webhook:${eventType}`,
    });

    const isTerminal = res.status === "completed" || res.status === "failed";
    reconcileResult = { billed: res.billed, status: res.status, callId: callRow.id, isTerminal };

    // Transfer failure tracking
    const transferAttempted = call.transfer_attempted === true || typeof call.transfer_to_number === "string";
    const transferSucceeded = call.transferred === true || call.transfer_successful === true;
    const failedTransferReasons = ["dial_failed", "dial_no_answer", "dial_busy", "voicemail_reached", "transfer_failed"];
    const transferFailed = transferAttempted && !transferSucceeded && (disconnectionReason ? failedTransferReasons.includes(disconnectionReason) : true);

    if (transferFailed) {
      await tx.insert(activitiesTable).values({
        id: `activity_${crypto.randomUUID().slice(0, 12)}`,
        businessId,
        type: "message",
        title: "Transfer failed — message captured",
        detail: `Call ${callId}: human transfer did not connect (${disconnectionReason ?? "unknown reason"}). Caller's message/callback request needs manual follow-up.`,
      });
      await tx
        .update(leadsTable)
        .set({
          nextAction: "Call back — transfer to human did not connect",
          updatedAt: new Date(),
        })
        .where(and(eq(leadsTable.id, callRow.leadId), eq(leadsTable.businessId, businessId)));
    }
  });

  if (reconcileResult.callId) {
    tenantEventBus.broadcast(businessId, "call_update", {
      id: reconcileResult.callId,
      status: reconcileResult.status,
    });
  }

  res.status(202).json({ accepted: true, status: reconcileResult.status, billed: reconcileResult.billed });
});

router.post("/webhooks/twilio/status", async (req, res): Promise<void> => {
  const config = providerConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const callId = typeof body.CallSid === "string" ? body.CallSid : "";
  const businessId =
    (typeof body.BusinessId === "string" && body.BusinessId) ||
    (typeof req.query.businessId === "string" && req.query.businessId) ||
    "";

  let tenantTwilio: TwilioCredentialOverride | null = null;
  if (businessId) {
    try {
      tenantTwilio = (await loadTenantProviderSecrets(db, businessId, "twilio")) as TwilioCredentialOverride | null;
    } catch {
      res.status(401).json({ error: "Invalid Twilio signature" });
      return;
    }
  }

  const twilioAuthToken = tenantTwilio?.auth_token ?? config.twilio.authToken;
  const twilioWebhookSecret = tenantTwilio?.webhook_secret ?? config.twilio.webhookSecret;
  const twilioSignatureValid = verifyTwilioSignature(
    `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    body,
    req.get("x-twilio-signature"),
    twilioAuthToken,
  );
  const signedBodyValid = verifyWebhookSignature(rawBody(req), signatureFor(req), twilioWebhookSecret);
  if (!twilioSignatureValid && !signedBodyValid) {
    res.status(401).json({ error: "Invalid Twilio signature" });
    return;
  }
  const rawTwilioTs = req.get("x-twilio-timestamp") ?? req.get("x-webhook-timestamp");
  if (rawTwilioTs !== undefined && rawTwilioTs !== null && rawTwilioTs !== "") {
    if (!isTimestampFresh(rawTwilioTs, 300)) {
      res.status(401).json({ error: "Stale Twilio webhook timestamp" });
      return;
    }
  }
  if (!callId || !businessId) {
    res.status(400).json({ error: "CallSid and a business-scoped callback (businessId) are required" });
    return;
  }
  // Calls are persisted before any provider work, so the CallSid must
  // already exist for THIS business. Rejecting unknown pairs keeps a
  // misconfigured (or foreign) callback from writing provider events or
  // call state into the wrong tenant.
  const [callRow] = await db
    .select({ id: callsTable.id })
    .from(callsTable)
    .where(and(eq(callsTable.businessId, businessId), eq(callsTable.providerCallId, callId)))
    .limit(1);
  if (!callRow) {
    res.status(400).json({ error: "CallSid must match a known LeadSprint call for this business" });
    return;
  }
  const accepted = await acceptProviderEvent({ businessId, provider: "Twilio", externalEventId: eventId(req, body), eventType: typeof body.CallStatus === "string" ? body.CallStatus : "status", payload: body });
  if (accepted) {
    const status = typeof body.CallStatus === "string" ? body.CallStatus : "unknown";
    await db.update(callsTable).set({
      providerCallId: callId,
      status: status === "completed" ? "completed" : status === "failed" || status === "busy" || status === "no-answer" ? "failed" : "in_progress",
      endedAt: status === "completed" || status === "failed" || status === "busy" || status === "no-answer" ? new Date() : undefined,
      errorState: status === "failed" || status === "busy" || status === "no-answer" ? `Twilio reported ${status}` : undefined,
    }).where(and(eq(callsTable.businessId, businessId), eq(callsTable.providerCallId, callId)));
  }
  res.status(202).json({ accepted: true, duplicate: !accepted });
});

router.post("/webhooks/calcom", async (req, res): Promise<void> => {
  const config = providerConfig();
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Cal.com's real webhook envelope is { triggerEvent, createdAt, payload }.
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
  const metadata = (payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}) as Record<string, unknown>;
  const businessId = typeof metadata.business_id === "string" ? metadata.business_id : "";

  let tenantCalcom: CalcomCredentialOverride | null = null;
  if (businessId) {
    try {
      tenantCalcom = (await loadTenantProviderSecrets(db, businessId, "calcom")) as CalcomCredentialOverride | null;
    } catch {
      res.status(401).json({ error: "Invalid Cal.com signature" });
      return;
    }
  }
  const calcomSecret = tenantCalcom?.webhook_secret ?? config.calcom.webhookSecret;
  if (!verifyCalSignature(rawBody(req), req.get("x-cal-signature-256"), calcomSecret)) {
    res.status(401).json({ error: "Invalid Cal.com signature" });
    return;
  }
  if (!isTimestampFresh(body.createdAt as string | undefined, 300)) {
    res.status(401).json({ error: "Stale Cal.com webhook timestamp" });
    return;
  }
  if (!businessId) {
    res.status(400).json({ error: "payload.metadata.business_id is required" });
    return;
  }
  const [business] = await db.select({ id: businessesTable.id }).from(businessesTable).where(eq(businessesTable.id, businessId)).limit(1);
  if (!business) {
    res.status(404).json({ error: "Unknown business_id" });
    return;
  }
  const triggerEvent = typeof body.triggerEvent === "string" ? body.triggerEvent : "booking";
  const accepted = await acceptProviderEvent({ businessId, provider: "Cal.com", externalEventId: eventId(req, body), eventType: triggerEvent, payload: body });
  if (accepted) {
    // A webhook that only archives the event never updates the console —
    // the appointment row itself has to reflect cancellation/reschedule,
    // or the operator keeps seeing a confirmed appointment that no longer
    // exists on the actual calendar.
    const externalId = typeof payload.uid === "string" ? payload.uid : typeof payload.bookingId !== "undefined" ? String(payload.bookingId) : "";
    if (externalId) {
      if (triggerEvent === "BOOKING_CANCELLED") {
        await db.update(appointmentsTable).set({ status: "cancelled" }).where(and(eq(appointmentsTable.businessId, businessId), eq(appointmentsTable.externalId, externalId)));
      } else if (triggerEvent === "BOOKING_RESCHEDULED") {
        const startTime = typeof payload.startTime === "string" ? new Date(payload.startTime) : undefined;
        const endTime = typeof payload.endTime === "string" ? new Date(payload.endTime) : undefined;
        await db.update(appointmentsTable).set({
          startTime,
          endTime,
          // If Cal.com didn't include the new times in this payload, don't
          // silently keep showing the old time as confirmed — force a look.
          status: startTime && endTime ? "confirmed" : "needs_review",
        }).where(and(eq(appointmentsTable.businessId, businessId), eq(appointmentsTable.externalId, externalId)));
      }
    }
  }
  res.status(202).json({ accepted: true, duplicate: !accepted });
});

export default router;