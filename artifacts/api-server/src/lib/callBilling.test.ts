import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { businessesTable, callsTable, contactsTable, leadsTable, usageTable } from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import {
  isEligibleForVoiceBilling,
  parseDurationSeconds,
  parseValidDurationMs,
  parseValidEpochMs,
  reconcileCallAndBillUnderLock,
} from "./callBilling";

const BUSINESS_ID = "business_pilot";

describe("callBilling timestamp evidence and billing gates", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(businessesTable).values(pilotBusiness() as never);
    await db.insert(contactsTable).values({
      id: "contact_billing_test",
      businessId: BUSINESS_ID,
      name: "Jordan Lee",
      phone: "+19175550199",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date("2024-06-01T10:00:00Z"),
      timezone: "America/New_York",
    });
    await db.insert(leadsTable).values({
      id: "lead_billing_test",
      businessId: BUSINESS_ID,
      contactId: "contact_billing_test",
      project: "Test Campaign",
      propertyType: "Condo",
      budgetLabel: "$500k",
      location: "New York",
      timeline: "Immediate",
    });
  });

  async function createTestCall(id: string, initialConnectedAt: Date | null = null) {
    const [call] = await db
      .insert(callsTable)
      .values({
        id,
        businessId: BUSINESS_ID,
        contactId: "contact_billing_test",
        leadId: "lead_billing_test",
        provider: "Retell",
        providerCallId: `provider_${id}`,
        idempotencyKey: `idemp_${id}`,
        status: "in_progress",
        startedAt: new Date("2024-01-01T00:00:00Z"), // Dispatch time (must never become connectedAt)
        connectedAt: initialConnectedAt,
      })
      .returning();
    return call;
  }

  it("parses valid epoch milliseconds within supported window", () => {
    expect(parseValidEpochMs(1720000000000)).toBe(1720000000000);
    expect(parseValidEpochMs(1704067200000)).toBe(1704067200000); // 2024 boundary
    expect(parseValidEpochMs(2082758400000)).toBe(2082758400000); // 2035 boundary

    // Rejections
    expect(parseValidEpochMs(null)).toBeNull();
    expect(parseValidEpochMs(undefined)).toBeNull();
    expect(parseValidEpochMs("1720000000000")).toBeNull();
    expect(parseValidEpochMs(NaN)).toBeNull();
    expect(parseValidEpochMs(-1)).toBeNull();
    expect(parseValidEpochMs(1000)).toBeNull(); // Pre-2024 epoch
    expect(parseValidEpochMs(3000000000000)).toBeNull(); // Post-2035 epoch
  });

  it("validates original duration milliseconds", () => {
    expect(parseValidDurationMs(45250)).toBe(45250);
    expect(parseValidDurationMs(1)).toBe(1);
    expect(parseValidDurationMs(0)).toBeNull();
    expect(parseValidDurationMs(-500)).toBeNull();
    expect(parseValidDurationMs(NaN)).toBeNull();
    expect(parseValidDurationMs("45000")).toBeNull();
  });

  it("1. valid start_timestamp populates connectedAt and triggers billing", async () => {
    const call = await createTestCall("call_valid_start");
    const startEpoch = 1720000000000;

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: startEpoch,
        durationMs: 45_000,
        disconnectionReason: "user_hangup",
        sourceEvent: "webhook:call_ended",
      }),
    );

    expect(res.billed).toBe(true);
    expect(res.status).toBe("completed");
    expect(res.call?.connectedAt).toEqual(new Date(startEpoch));
    expect(res.call?.connectedAt).not.toEqual(call.startedAt); // Proves dispatch time was NOT used
  });

  it("2. missing start_timestamp but valid end_timestamp and duration_ms derives connectedAt mathematically", async () => {
    const call = await createTestCall("call_derived_start");
    const endEpoch = 1720000095500;
    const durationMs = 95_500;
    const expectedDerivedEpoch = 1720000000000;

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: undefined,
        endTimestampMs: endEpoch,
        durationMs,
        disconnectionReason: "agent_hangup",
        sourceEvent: "webhook:call_ended",
      }),
    );

    expect(res.billed).toBe(true);
    expect(res.status).toBe("completed");
    expect(res.call?.connectedAt).toEqual(new Date(expectedDerivedEpoch));
  });

  it("3. missing both timestamps keeps connectedAt null and denies billing", async () => {
    const call = await createTestCall("call_missing_both_timestamps");

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: undefined,
        endTimestampMs: undefined,
        durationMs: 30_000,
        disconnectionReason: "user_hangup",
        sourceEvent: "webhook:call_ended",
      }),
    );

    expect(res.billed).toBe(false);
    expect(res.status).toBe("completed");
    expect(res.call?.connectedAt).toBeNull();
  });

  it("4. invalid timestamp keeps connectedAt null and denies billing", async () => {
    const call = await createTestCall("call_invalid_timestamp");

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: -500, // Invalid negative epoch
        endTimestampMs: NaN as any,
        durationMs: 30_000,
        disconnectionReason: "user_hangup",
        sourceEvent: "webhook:call_ended",
      }),
    );

    expect(res.billed).toBe(false);
    expect(res.status).toBe("completed");
    expect(res.call?.connectedAt).toBeNull();
  });

  it("5. delayed webhook does not use server Date.now() for connection evidence", async () => {
    const call = await createTestCall("call_delayed_webhook");
    const historicalEnd = 1720000060000; // July 2024
    const durationMs = 60_000;
    const historicalStart = 1720000000000;

    const beforeCall = Date.now();
    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        endTimestampMs: historicalEnd,
        durationMs,
        disconnectionReason: "call_transfer",
        sourceEvent: "cron:sweep_unmatched",
      }),
    );

    expect(res.billed).toBe(true);
    expect(res.call?.connectedAt).toEqual(new Date(historicalStart));
    // Must NOT be within seconds of server Date.now()
    expect(Math.abs(res.call!.connectedAt!.getTime() - beforeCall)).toBeGreaterThan(1000 * 60 * 60 * 24);
  });

  it("6. existing valid connectedAt is preserved on subsequent events", async () => {
    const originalConnected = new Date("2024-06-15T14:30:00Z");
    const call = await createTestCall("call_preserve_connected", originalConnected);

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: 1725000000000, // Different incoming timestamp
        durationMs: 45_000,
        disconnectionReason: "user_hangup",
        sourceEvent: "webhook:call_analyzed",
      }),
    );

    expect(res.call?.connectedAt).toEqual(originalConnected);
  });

  it("7. non-billable disconnection reason keeps connectedAt null and denies billing", async () => {
    const call = await createTestCall("call_non_billable_voicemail");

    const res = await db.transaction((tx) =>
      reconcileCallAndBillUnderLock(tx, {
        callId: call.id,
        businessId: BUSINESS_ID,
        providerStatus: "ended",
        startTimestampMs: 1720000000000,
        endTimestampMs: 1720000030000,
        durationMs: 30_000,
        disconnectionReason: "voicemail_reached",
        sourceEvent: "webhook:call_ended",
      }),
    );

    expect(res.billed).toBe(false);
    expect(res.status).toBe("failed");
    expect(res.call?.connectedAt).toBeNull();
  });
});
