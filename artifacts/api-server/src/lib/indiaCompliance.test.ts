import { describe, expect, it } from "vitest";
import { businessesTable, suppressionsTable } from "@workspace/db/schema";
import { createTestDb, pilotBusiness } from "../test/testDb";
import { timezoneForPhoneNumber, timezoneForUSPhoneNumber } from "./areaCodeTimezones";
import { evaluateCallPolicy, isWithinQuietHours, nextAllowedCallTime } from "./policy";
import { isPhoneSuppressed, normalizePhone } from "./suppression";

describe("India (+91) phone normalization, Asia/Kolkata timezone & TRAI compliance", () => {
  it("fixes +91 timezone parsing to Asia/Kolkata while keeping unknown numbers fail-closed", () => {
    expect(timezoneForPhoneNumber("+91 98765 43210", "IN")).toBe("Asia/Kolkata");
    expect(timezoneForPhoneNumber("+919876543210", "US")).toBe("Asia/Kolkata");
    expect(timezoneForUSPhoneNumber("+919876543210")).toBe("Asia/Kolkata");
    expect(timezoneForPhoneNumber("9876543210", "IN")).toBe("Asia/Kolkata");
    expect(timezoneForPhoneNumber("09876543210", "IN")).toBe("Asia/Kolkata");
    expect(timezoneForPhoneNumber("+91 22 2654 1234", "IN")).toBe("Asia/Kolkata");

    // Malformed +91 or unrecognized international codes must return null (fail closed).
    expect(timezoneForPhoneNumber("+91 123", "IN")).toBeNull();
    expect(timezoneForPhoneNumber("+44 20 7946 0958", "IN")).toBeNull();

    // US NANP numbers still resolve to their US timezone even from an IN workspace.
    expect(timezoneForPhoneNumber("+1 212 555 0100", "IN")).toBe("America/New_York");
  });

  it("normalizes Indian phone formats consistently and matches cross-format DND suppression", async () => {
    expect(normalizePhone("+91 98765 43210", "IN")).toBe("+919876543210");
    expect(normalizePhone("09876543210", "IN")).toBe("+919876543210");
    expect(normalizePhone("9876543210", "IN")).toBe("+919876543210");
    expect(normalizePhone("919876543210", "US")).toBe("+919876543210");

    const db = await createTestDb();
    await db.insert(businessesTable).values(
      pilotBusiness({ id: "biz_in", market: "IN", timezone: "Asia/Kolkata" }) as never,
    );
    await db.insert(suppressionsTable).values({
      id: "supp_in_1",
      businessId: "biz_in",
      phone: "+919876543210",
      reason: "DND / caller opt-out",
      source: "operator",
    });

    expect(await isPhoneSuppressed(db as never, "biz_in", "9876543210", "IN")).toBe(true);
    expect(await isPhoneSuppressed(db as never, "biz_in", "098765 43210", "IN")).toBe(true);
    expect(await isPhoneSuppressed(db as never, "biz_in", "+91 98765-43210", "IN")).toBe(true);
    expect(await isPhoneSuppressed(db as never, "biz_in", "+91 91234 56789", "IN")).toBe(false);
  });

  it("enforces TRAI 09:00–21:00 Asia/Kolkata (UTC+05:30) calling hours", () => {
    const quietHours = "21:00-09:00";

    // 03:29 UTC = 08:59 IST -> blocked (US allows 08:00, TRAI requires 09:00)
    expect(isWithinQuietHours(quietHours, "Asia/Kolkata", new Date("2026-09-07T03:29:00Z"), "IN")).toBe(true);
    // 03:30 UTC = 09:00 IST -> allowed
    expect(isWithinQuietHours(quietHours, "Asia/Kolkata", new Date("2026-09-07T03:30:00Z"), "IN")).toBe(false);
    // 15:29 UTC = 20:59 IST -> allowed
    expect(isWithinQuietHours(quietHours, "Asia/Kolkata", new Date("2026-09-07T15:29:00Z"), "IN")).toBe(false);
    // 15:30 UTC = 21:00 IST -> blocked
    expect(isWithinQuietHours(quietHours, "Asia/Kolkata", new Date("2026-09-07T15:30:00Z"), "IN")).toBe(true);

    // Even if an IN workspace misconfigured 23:00-06:00, TRAI floor blocks 08:30 IST (03:00 UTC).
    expect(isWithinQuietHours("23:00-06:00", "Asia/Kolkata", new Date("2026-09-07T03:00:00Z"), "IN")).toBe(true);

    // Retry scheduled from 08:15 IST (02:45 UTC) lands cleanly >= 09:00 IST (03:30 UTC).
    const retryAt = nextAllowedCallTime("21:00-09:00", "Asia/Kolkata", new Date("2026-09-07T02:45:00Z"), 5 * 60 * 1000, "IN");
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(new Date("2026-09-07T03:30:00Z").getTime());
    expect(retryAt.getTime()).toBeLessThanOrEqual(new Date("2026-09-07T03:36:00Z").getTime());
  });

  it("blocks India DND-registered numbers and unverified promotional calls", () => {
    const inBusiness = {
      market: "IN" as const,
      timezone: "Asia/Kolkata",
      quietHours: "21:00-09:00",
      maxCallAttempts: 3,
    };
    const middayIst = new Date("2026-09-07T07:30:00Z"); // 13:00 IST

    const dndRegistered = evaluateCallPolicy({
      business: inBusiness,
      contact: {
        consentStatus: "valid",
        suppressedAt: null,
        dndStatus: "registered",
        consentCategory: "inquiry",
        timezone: "Asia/Kolkata",
      },
      attemptsSoFar: 0,
      now: middayIst,
    });
    expect(dndRegistered.allowed).toBe(false);
    expect(dndRegistered.reason).toBe("dnd_registered");

    const promoUnverified = evaluateCallPolicy({
      business: inBusiness,
      contact: {
        consentStatus: "valid",
        suppressedAt: null,
        dndStatus: "unknown",
        consentCategory: "promotional",
        timezone: "Asia/Kolkata",
      },
      attemptsSoFar: 0,
      now: middayIst,
    });
    expect(promoUnverified.allowed).toBe(false);
    expect(promoUnverified.reason).toBe("dnd_unverified");

    const promoClear = evaluateCallPolicy({
      business: inBusiness,
      contact: {
        consentStatus: "valid",
        suppressedAt: null,
        dndStatus: "clear",
        consentCategory: "promotional",
        timezone: "Asia/Kolkata",
      },
      attemptsSoFar: 0,
      now: middayIst,
    });
    expect(promoClear.allowed).toBe(true);
  });
});

