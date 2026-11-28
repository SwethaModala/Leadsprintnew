import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  callsTable,
  contactsTable,
  leadsTable,
  businessesTable,
  activitiesTable,
  providerEventsTable,
} from "@workspace/db";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import express, { type Express } from "express";
import webhooksRouter, { __setWebhooksDb, __resetWebhooksDb } from "./webhooks";
import { tenantEventBus } from "../lib/eventBus";
import { callMonitorManager } from "../lib/callMonitor";

const RETELL_KEY = "test_retell_webhook_key";

function buildApp(): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use("/api", webhooksRouter);
  return app;
}

function retellEvent(body: Record<string, unknown>, secret = RETELL_KEY) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const digest = crypto
    .createHmac("sha256", secret)
    .update(raw.toString("utf8") + timestamp)
    .digest("hex");
  return { raw: raw.toString("utf8"), signature: `v=${timestamp},d=${digest}` };
}

describe("LeadSprint Phase 4D — Native Warm Transfer Monitoring & Audit Trail", () => {
  let db: TestDb;
  let app: Express;

  const BIZ_ID = "biz_transfer_test";
  const BIZ_OTHER = "biz_other_tenant";
  const CALL_ID = "call_transfer_001";
  const PROVIDER_CALL_ID = "retell_call_transfer_999";

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.RETELL_API_KEY = RETELL_KEY;
    process.env.RETELL_WEBHOOK_SECRET = RETELL_KEY;

    db = await createTestDb();
    __setWebhooksDb(db as any);
    tenantEventBus.reset();
    callMonitorManager.reset();
    app = buildApp();

    // Seed primary business
    await db.insert(businessesTable).values(
      pilotBusiness({
        id: BIZ_ID,
        name: "Premier Realty",
        transferNumber: "+12125550199",
      }) as never,
    );

    // Seed other business for cross-tenant testing
    await db.insert(businessesTable).values(
      pilotBusiness({
        id: BIZ_OTHER,
        name: "Other Tenant Homes",
        transferNumber: "+13125550177",
      }) as never,
    );

    // Seed contact & lead
    await db.insert(contactsTable).values({
      id: "contact_trans_1",
      businessId: BIZ_ID,
      name: "Marcus Buyer",
      phone: "+19175550184",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date(),
    });

    await db.insert(leadsTable).values({
      id: "lead_trans_1",
      businessId: BIZ_ID,
      contactId: "contact_trans_1",
      source: "Zillow",
      project: "Northstar Realty",
      propertyType: "Condo",
      budgetLabel: "$1M",
      location: "Manhattan",
      timeline: "Immediate",
      status: "in_progress",
    });

    // Seed initial in-progress call
    await db.insert(callsTable).values({
      id: CALL_ID,
      businessId: BIZ_ID,
      contactId: "contact_trans_1",
      leadId: "lead_trans_1",
      provider: "Retell",
      providerCallId: PROVIDER_CALL_ID,
      idempotencyKey: "idemp_trans_001",
      status: "in_progress",
      startedAt: new Date(Date.now() - 60000),
      transferred: false,
      metadata: {},
    });
  });

  afterEach(() => {
    __resetWebhooksDb();
    tenantEventBus.reset();
    callMonitorManager.reset();
  });

  it("1. Rejects webhook requests with invalid or missing Retell signatures", async () => {
    const payload = JSON.stringify({
      event: "transfer_started",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    });

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", "invalid_signature")
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid Retell signature");
  });

  it("2. Handles transfer_started: updates metadata, logs activity, does not mark call as completed or transferred", async () => {
    const payloadObj = {
      event: "transfer_started",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(res.status).toBe(202);

    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    expect(call?.status).toBe("in_progress");
    expect(call?.transferred).toBe(false);

    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_started");
    expect(meta.transfer_destination).toBe("+12125550199");

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.businessId, BIZ_ID), eq(activitiesTable.type, "call")));
    expect(activities.some((a) => a.title === "Warm transfer initiated")).toBe(true);
  });

  it("3. Handles transfer_bridged: marks transferred=true and updates state to transfer_bridged", async () => {
    const payloadObj = {
      event: "transfer_bridged",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(res.status).toBe(202);

    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    expect(call?.transferred).toBe(true);

    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_bridged");
    expect(meta.transfer_destination).toBe("+12125550199");

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.businessId, BIZ_ID), eq(activitiesTable.type, "call")));
    expect(activities.some((a) => a.title === "Warm transfer connected")).toBe(true);
  });

  it("4. Handles transfer_cancelled: updates state, logs failure activity, and sets lead nextAction", async () => {
    const payloadObj = {
      event: "transfer_cancelled",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
        disconnection_reason: "dial_no_answer",
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(res.status).toBe(202);

    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_cancelled");
    expect(meta.transfer_cancelled_reason).toBe("dial_no_answer");

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, "lead_trans_1"));
    expect(lead?.nextAction).toBe("Call back — transfer to human did not connect");

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.businessId, BIZ_ID), eq(activitiesTable.type, "message")));
    expect(activities.some((a) => a.title === "Transfer unsuccessful")).toBe(true);
  });

  it("5. Handles transfer_ended: updates state and logs conclusion activity", async () => {
    const payloadObj = {
      event: "transfer_ended",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(res.status).toBe(202);

    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_ended");

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.businessId, BIZ_ID), eq(activitiesTable.type, "call")));
    expect(activities.some((a) => a.title === "Transferred call ended")).toBe(true);
  });

  it("6. Idempotency: duplicate transfer webhook deliveries are silently accepted without re-inserting activities", async () => {
    const payloadObj = {
      event: "transfer_started",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    // First delivery
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    // Second delivery (same event)
    const res2 = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(res2.status).toBe(202);

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.businessId, BIZ_ID), eq(activitiesTable.title, "Warm transfer initiated")));
    expect(activities.length).toBe(1);
  });

  it("7. Monotonicity: out-of-order transfer_started does not overwrite a bridged state", async () => {
    // 1. Deliver transfer_bridged
    const bridgedPayload = {
      event: "transfer_bridged",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const bridged = retellEvent(bridgedPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", bridged.signature)
      .send(bridged.raw);

    // 2. Deliver late-arriving transfer_started
    const startedPayload = {
      event: "transfer_started",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const started = retellEvent(startedPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", started.signature)
      .send(started.raw);

    // State should remain transfer_bridged
    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_bridged");
    expect(call?.transferred).toBe(true);
  });

  it("8. Cross-tenant isolation: webhook with other business metadata cannot modify Tenant A call", async () => {
    const spoofedPayload = {
      event: "transfer_started",
      transfer_destination: "+13125550177",
      call: {
        call_id: PROVIDER_CALL_ID, // Call belongs to BIZ_ID, not BIZ_OTHER
        metadata: { business_id: BIZ_OTHER },
      },
    };
    const { raw, signature } = retellEvent(spoofedPayload);

    const res = await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    // Call row was not found under BIZ_OTHER, so stored as unmatched webhook
    expect(res.status).toBe(202);

    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBeUndefined();
  });

  it("9. Broadcasts real-time events to tenant event bus and live monitor manager", async () => {
    const broadcastSpy = vi.spyOn(tenantEventBus, "broadcast");
    const monitorSpy = vi.spyOn(callMonitorManager, "notifyTransferEvent");

    const payloadObj = {
      event: "transfer_bridged",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const { raw, signature } = retellEvent(payloadObj);

    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", signature)
      .send(raw);

    expect(broadcastSpy).toHaveBeenCalledWith(
      BIZ_ID,
      "call_update",
      expect.objectContaining({
        id: CALL_ID,
        transfer_state: "transfer_bridged",
        transfer_destination: "+12125550199",
      }),
    );

    expect(monitorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: CALL_ID,
        businessId: BIZ_ID,
        transferStatus: "transfer_bridged",
        destination: "+12125550199",
      }),
    );
  });

  it("10. Sanitizes invalid transfer_destination and preserves valid international E.164 phone numbers", async () => {
    // A: Invalid destination (script/garbage string) is sanitized to undefined
    const invalidPayload = {
      event: "transfer_started",
      transfer_destination: "malicious_string_not_a_phone_number_1234567890",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const invalidEvent = retellEvent(invalidPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", invalidEvent.signature)
      .send(invalidEvent.raw);

    const [call1] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta1 = (call1?.metadata ?? {}) as Record<string, unknown>;
    expect(meta1.transfer_destination).toBeNull();

    // B: Valid international UK E.164 number (+44 20 7946 0991) is preserved
    const validIntlPayload = {
      event: "transfer_started",
      transfer_destination: "+44 20 7946 0991",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const validEvent = retellEvent(validIntlPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", validEvent.signature)
      .send(validEvent.raw);

    const [call2] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta2 = (call2?.metadata ?? {}) as Record<string, unknown>;
    expect(meta2.transfer_destination).toBe("+44 20 7946 0991");
  });

  it("11. Monotonicity: late-arriving transfer_cancelled cannot overwrite transfer_bridged or transfer_ended", async () => {
    // 1. Establish bridged state
    const bridgedPayload = {
      event: "transfer_bridged",
      transfer_destination: "+12125550199",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
      },
    };
    const bridged = retellEvent(bridgedPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", bridged.signature)
      .send(bridged.raw);

    // 2. Deliver late-arriving transfer_cancelled
    const cancelledPayload = {
      event: "transfer_cancelled",
      call: {
        call_id: PROVIDER_CALL_ID,
        metadata: { business_id: BIZ_ID },
        disconnection_reason: "dial_no_answer",
      },
    };
    const cancelled = retellEvent(cancelledPayload);
    await request(app)
      .post("/api/webhooks/retell")
      .set("Content-Type", "application/json")
      .set("x-retell-signature", cancelled.signature)
      .send(cancelled.raw);

    // State MUST remain transfer_bridged, not regress to transfer_cancelled
    const [call] = await db.select().from(callsTable).where(eq(callsTable.id, CALL_ID));
    const meta = (call?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.transfer_state).toBe("transfer_bridged");
    expect(call?.transferred).toBe(true);
  });
});
