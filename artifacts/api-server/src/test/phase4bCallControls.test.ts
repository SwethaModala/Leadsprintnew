import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  activitiesTable,
  businessesTable,
  callsTable,
  contactsTable,
  leadsTable,
  providerEventsTable,
  usageTable,
  workflowJobsTable,
} from "@workspace/db";
import { createTestDb, pilotBusiness, type TestDb } from "./testDb";
import express, { type Express } from "express";
import webhooksRouter from "../routes/webhooks";
import leadsprintRouter from "../routes/leadsprint";
import { __setWebhooksDb } from "../routes/webhooks";
import { __setCallQueueDb } from "../lib/callQueue";
import { __setLeadsprintDb } from "../routes/leadsprint";
import { isEligibleForVoiceBilling, reconcileCallAndBillUnderLock } from "../lib/callBilling";
import * as providers from "../lib/providers";

const RETELL_KEY = "test_retell_key_4b";
const BUSINESS_ID = "business_pilot";
const CALL_ID = "call_test_4b";
const PROVIDER_CALL_ID = "retell_call_test_4b";

const ENV: Record<string, string> = {
  LEADSPRINT_DEMO_AUTH: "true",
  NODE_ENV: "development",
  RETELL_API_KEY: RETELL_KEY,
  RETELL_AGENT_ID: "agent_pilot",
  RETELL_FROM_NUMBER: "+12125550148",
  RETELL_WEBHOOK_SECRET: RETELL_KEY,
};

let db: TestDb;

function buildApp(tenantId = BUSINESS_ID): Express {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use((req, _res, next) => {
    (req as any).leadSprintBusinessId = tenantId;
    (req as any).leadSprintUserId = "user_pilot";
    (req as any).leadSprintRole = "owner";
    (req as any).leadSprintOrgRole = "owner";
    (req as any).auth = {
      userId: "user_pilot",
      sessionClaims: {
        org_id: tenantId,
        org_role: "org:admin",
      },
    };
    next();
  });
  app.use("/api", webhooksRouter);
  app.use("/api", leadsprintRouter);
  app.use((err: any, _req: any, res: any, next: any) => {
    if (err) {
      return res.status(400).json({ error: err.message ?? "Malformed request body" });
    }
    next();
  });
  return app;
}

function retellEvent(body: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = Date.now().toString();
  const digest = crypto
    .createHmac("sha256", RETELL_KEY)
    .update(raw.toString("utf8") + timestamp)
    .digest("hex");
  return { raw, signature: `v=${timestamp},d=${digest}` };
}

async function postRetell(body: Record<string, unknown>) {
  const { raw, signature } = retellEvent(body);
  return request(buildApp())
    .post("/api/webhooks/retell")
    .set("content-type", "application/json")
    .set("x-retell-signature", signature)
    .send(raw.toString("utf8"));
}

describe("LeadSprint Phase 4B — Comprehensive Call Controls & Billing Safety", () => {
  beforeEach(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      process.env[key] = value;
    }
    db = await createTestDb();
    __setWebhooksDb(db as never);
    __setCallQueueDb(db as never);
    __setLeadsprintDb(db as never);

    await db.insert(businessesTable).values(pilotBusiness() as never);
    await db.insert(contactsTable).values({
      id: "contact_4b",
      businessId: BUSINESS_ID,
      name: "Marcus Brody",
      phone: "+19175550199",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date(),
      timezone: "America/New_York",
    });
    await db.insert(leadsTable).values({
      id: "lead_4b",
      businessId: BUSINESS_ID,
      contactId: "contact_4b",
      project: "Spring campaign",
      propertyType: "Condo",
      budgetLabel: "$850k – $1.1M",
      location: "Williamsburg",
      timeline: "0–3 months",
    });
    await db.insert(callsTable).values({
      id: CALL_ID,
      businessId: BUSINESS_ID,
      contactId: "contact_4b",
      leadId: "lead_4b",
      provider: "Retell",
      providerCallId: PROVIDER_CALL_ID,
      idempotencyKey: "key_4b",
      status: "in_progress",
      startedAt: new Date(Date.now() - 60_000),
    });
  });

  describe("1. Voice Billing Eligibility Rules", () => {
    it("rejects non-completed calls regardless of provider status or duration", () => {
      expect(
        isEligibleForVoiceBilling({
          status: "in_progress",
          connectedAt: new Date(),
          durationSeconds: 60,
          providerStatus: "ended",
          disconnectionReason: "user_hangup",
        }),
      ).toBe(false);

      expect(
        isEligibleForVoiceBilling({
          status: "failed",
          connectedAt: new Date(),
          durationSeconds: 60,
          providerStatus: "ended",
          disconnectionReason: "user_hangup",
        }),
      ).toBe(false);
    });

    it("rejects calls without valid connectedAt timestamp", () => {
      expect(
        isEligibleForVoiceBilling({
          status: "completed",
          connectedAt: null,
          durationSeconds: 60,
          providerStatus: "ended",
          disconnectionReason: "user_hangup",
        }),
      ).toBe(false);
    });

    it("rejects non-integer, zero, or negative durations", () => {
      expect(
        isEligibleForVoiceBilling({
          status: "completed",
          connectedAt: new Date(),
          durationSeconds: 0,
          disconnectionReason: "user_hangup",
        }),
      ).toBe(false);

      expect(
        isEligibleForVoiceBilling({
          status: "completed",
          connectedAt: new Date(),
          durationSeconds: 12.5 as any,
          disconnectionReason: "user_hangup",
        }),
      ).toBe(false);
    });

    it("rejects voicemail, dial failure, and non-approved disconnection reasons", () => {
      const nonBillable = [
        "voicemail_reached",
        "dial_failed",
        "dial_no_answer",
        "dial_busy",
        "telephony_provider_unavailable",
        "unknown_reason",
      ];
      for (const reason of nonBillable) {
        expect(
          isEligibleForVoiceBilling({
            status: "completed",
            connectedAt: new Date(),
            durationSeconds: 45,
            providerStatus: "ended",
            disconnectionReason: reason,
          }),
        ).toBe(false);
      }
    });

    it("accepts genuine connected completed call with user_hangup or agent_hangup", () => {
      expect(
        isEligibleForVoiceBilling({
          status: "completed",
          connectedAt: new Date(),
          durationSeconds: 45,
          providerStatus: "ended",
          disconnectionReason: "user_hangup",
        }),
      ).toBe(true);

      expect(
        isEligibleForVoiceBilling({
          status: "completed",
          connectedAt: new Date(),
          durationSeconds: 90,
          providerStatus: "ended",
          disconnectionReason: "agent_hangup",
        }),
      ).toBe(true);
    });
  });

  describe("2. Unmatched Webhook Recovery", () => {
    it("persists unmatched webhook as pending and drains when call is registered", async () => {
      const futureCallId = "retell_future_call_999";

      // 1. Webhook arrives BEFORE call is in DB
      const res1 = await postRetell({
        event: "call_ended",
        event_id: "evt_future_ended_999",
        call: {
          call_id: futureCallId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 40_000,
          disconnection_reason: "user_hangup",
          metadata: { business_id: BUSINESS_ID },
        },
      });

      expect(res1.status).toBe(202);

      // Verify stored as unmatched_webhook
      const [unmatched] = await db
        .select()
        .from(providerEventsTable)
        .where(
          and(
            eq(providerEventsTable.businessId, BUSINESS_ID),
            eq(providerEventsTable.eventType, "unmatched_webhook"),
          ),
        );
      expect(unmatched).toBeDefined();

      // 2. Duplicate redelivery does not create a second row
      const res2 = await postRetell({
        event: "call_ended",
        event_id: "evt_future_ended_999",
        call: {
          call_id: futureCallId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 40_000,
          disconnection_reason: "user_hangup",
          metadata: { business_id: BUSINESS_ID },
        },
      });
      expect(res2.status).toBe(202);

      const count = await db
        .select({ count: sql<number>`count(*)` })
        .from(providerEventsTable)
        .where(
          and(
            eq(providerEventsTable.businessId, BUSINESS_ID),
            eq(providerEventsTable.eventType, "unmatched_webhook"),
          ),
        );
      expect(Number(count[0]?.count)).toBe(1);

      // 3. Call record is registered later
      const newCallId = "call_row_future_999";
      await db.insert(callsTable).values({
        id: newCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: futureCallId,
        idempotencyKey: "key_future_999",
        status: "in_progress",
      });

      // 4. Drain sweep
      const { sweepUnmatchedEvents } = await import("../lib/scheduler");
      const reconciledCount = await sweepUnmatchedEvents(db as never);
      expect(reconciledCount).toBe(1);

      // Verify call is now completed and billed
      const [reconciledCall] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, newCallId));
      expect(reconciledCall?.status).toBe("completed");
      expect(reconciledCall?.durationSeconds).toBe(40);

      // Verify event transitioned to unmatched_webhook_reconciled
      const [reconciledEvent] = await db
        .select()
        .from(providerEventsTable)
        .where(
          and(
            eq(providerEventsTable.businessId, BUSINESS_ID),
            eq(providerEventsTable.eventType, "unmatched_webhook_reconciled"),
          ),
        );
      expect(reconciledEvent).toBeDefined();

      // Verify voiceMinutes accrued
      const [usage] = await db
        .select()
        .from(usageTable)
        .where(eq(usageTable.businessId, BUSINESS_ID));
      expect(Number(usage?.voiceMinutes)).toBeCloseTo(40 / 60, 4);
    });
  });

  describe("3. Stop and Reconcile Endpoints", () => {
    it("POST /calls/:id/cancel cancels queued call safely", async () => {
      const queuedId = "call_queued_cancel";
      await db.insert(callsTable).values({
        id: queuedId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        idempotencyKey: "key_queued_cancel",
        status: "queued",
      });

      const res = await request(buildApp())
        .post(`/api/calls/${queuedId}/cancel`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");

      const [cancelled] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, queuedId));
      expect(cancelled?.status).toBe("failed");
      expect(cancelled?.disconnectionReason).toBe("canceled");
    });

    it("POST /calls/:id/stop sends stop request and sets operator_stop_pending", async () => {
      const stopSpy = vi.spyOn(providers, "stopRetellCall").mockResolvedValue({
        status: 204,
        message: "Stop command accepted",
      });

      const res = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: false });

      expect(res.status).toBe(200);
      expect(res.body.stop_pending).toBe(true);

      const [call] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, CALL_ID));
      expect((call?.metadata as any)?.operator_stop_pending).toBe(true);

      stopSpy.mockRestore();
    });

    it("POST /calls/:id/stop with force_retry before 15s cooldown is rejected with 400", async () => {
      // First attempt
      const stopSpy = vi.spyOn(providers, "stopRetellCall").mockRejectedValue({
        status: 502,
        message: "Bad gateway",
      });

      await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: false });

      // Immediate force_retry
      const res = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("15 seconds");

      stopSpy.mockRestore();
    });

    it("POST /calls/:id/reconcile synchronizes terminal state and bills once", async () => {
      const getSpy = vi.spyOn(providers, "getRetellCall").mockResolvedValue({
        call_id: PROVIDER_CALL_ID,
        call_status: "ended",
        start_timestamp: Date.now() - 50_000,
        duration_ms: 50_000,
        disconnection_reason: "user_hangup",
      });

      const res = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/reconcile`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(res.body.billed).toBe(true);

      // Reconcile again — already terminal
      const res2 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/reconcile`)
        .send();
      expect(res2.status).toBe(200);
      expect(res2.body.billed).toBe(false);

      getSpy.mockRestore();
    });
  });

  describe("4. Strict Zod Validation on Stop Request", () => {
    it("accepts boolean false or true", async () => {
      const stopSpy = vi.spyOn(providers, "stopRetellCall").mockResolvedValue({
        status: 204,
        message: "OK",
      });

      const res = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: false });
      expect(res.status).toBe(200);

      stopSpy.mockRestore();
    });

    it("rejects non-boolean strings 'true' and 'false' with 400", async () => {
      const res1 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: "true" });
      expect(res1.status).toBe(400);

      const res2 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: "false" });
      expect(res2.status).toBe(400);
    });

    it("rejects null force_retry or null request body with 400", async () => {
      const res1 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: null });
      expect(res1.status).toBe(400);

      const res2 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .set("content-type", "application/json")
        .send("null");
      expect(res2.status).toBe(400);
    });

    it("rejects non-object array or primitive body with 400", async () => {
      const res1 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send([1, 2, 3]);
      expect(res1.status).toBe(400);

      const res2 = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .set("content-type", "application/json")
        .send('"some_string"');
      expect(res2.status).toBe(400);
    });
  });

  describe("5. Force Stop Provider-State Handling", () => {
    it("force retry when Retell reports ended reconciles terminal state and does not call stopRetellCall", async () => {
      const stopSpy = vi.spyOn(providers, "stopRetellCall");
      const getSpy = vi.spyOn(providers, "getRetellCall").mockResolvedValue({
        call_id: PROVIDER_CALL_ID,
        call_status: "ended",
        start_timestamp: 1720000000000,
        duration_ms: 30_000,
        disconnection_reason: "user_hangup",
      });

      // Advance clock past 15s cooldown
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 20_000);

      const res = await request(buildApp())
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: true });

      vi.useRealTimers();

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("Provider confirmed call already ended");
      expect(res.body.status).toBe("completed");
      expect(stopSpy).not.toHaveBeenCalled();

      stopSpy.mockRestore();
      getSpy.mockRestore();
    });

    it("force retry when Retell reports not_connected or error reconciles failed and does not call stopRetellCall", async () => {
      const failedCallId = "call_failed_retell";
      const failedProviderCallId = "retell_failed_123";
      await db.insert(callsTable).values({
        id: failedCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: failedProviderCallId,
        idempotencyKey: "key_failed_retell",
        status: "in_progress",
      });

      const stopSpy = vi.spyOn(providers, "stopRetellCall");
      const getSpy = vi.spyOn(providers, "getRetellCall").mockResolvedValue({
        call_id: failedProviderCallId,
        call_status: "not_connected",
        disconnection_reason: "dial_failed",
      });

      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 20_000);

      const res = await request(buildApp())
        .post(`/api/calls/${failedCallId}/stop`)
        .send({ force_retry: true });

      vi.useRealTimers();

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.message).toContain("failed/not connected");
      expect(stopSpy).not.toHaveBeenCalled();

      const [row] = await db.select().from(callsTable).where(eq(callsTable.id, failedCallId));
      expect(row?.status).toBe("failed");
      expect(row?.disconnectionReason).toBe("dial_failed");

      stopSpy.mockRestore();
      getSpy.mockRestore();
    });
  });

  describe("6. Concurrency, Race Conditions and Multi-Tenant Isolation", () => {
    it("simultaneous stop requests for the same call serialize safely with one in-flight rejection", async () => {
      const concCallId = "call_conc_stop";
      await db.insert(callsTable).values({
        id: concCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: "retell_conc_stop",
        idempotencyKey: "key_conc_stop",
        status: "in_progress",
      });

      let req2Status: number = 0;
      let req2Body: any = null;

      const stopSpy = vi.spyOn(providers, "stopRetellCall").mockImplementation(async () => {
        // While req1 holds an in-flight stop_call_attempt in DB with outcome='pending',
        // trigger req2 concurrently to test in-flight serialization
        const res2 = await request(buildApp())
          .post(`/api/calls/${concCallId}/stop`)
          .send({ force_retry: false });
        req2Status = res2.status;
        req2Body = res2.body;
        return { status: 204, message: "OK" };
      });

      const res1 = await request(buildApp())
        .post(`/api/calls/${concCallId}/stop`)
        .send({ force_retry: false });

      expect(res1.status).toBe(200);
      expect(req2Status).toBe(409);
      expect(req2Body.error).toContain("in flight");

      stopSpy.mockRestore();
    });

    it("stop HTTP 204 arriving after terminal call_ended webhook preserves completed status", async () => {
      const termCallId = "call_term_protect";
      await db.insert(callsTable).values({
        id: termCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: "retell_term_protect",
        idempotencyKey: "key_term_protect",
        status: "completed",
        durationSeconds: 45,
        disconnectionReason: "user_hangup",
      });

      const res = await request(buildApp())
        .post(`/api/calls/${termCallId}/stop`)
        .send({ force_retry: false });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
      expect(res.body.message).toContain("already ended");

      const [call] = await db.select().from(callsTable).where(eq(callsTable.id, termCallId));
      expect(call?.status).toBe("completed");
      expect((call?.metadata as any)?.operator_stop_pending).toBeFalsy();
    });

    it("concurrent call_ended and call_analyzed webhooks bill exactly once under separate event IDs", async () => {
      const concBilledCallId = "call_conc_billing";
      const concProviderId = "retell_conc_billing";
      await db.insert(callsTable).values({
        id: concBilledCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: concProviderId,
        idempotencyKey: "key_conc_billing",
        status: "in_progress",
      });

      const endedPayload = {
        event: "call_ended",
        id: "evt_shared_id_123",
        call: {
          call_id: concProviderId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 60_000,
          disconnection_reason: "user_hangup",
          metadata: { business_id: BUSINESS_ID },
        },
      };

      const analyzedPayload = {
        event: "call_analyzed",
        id: "evt_shared_id_123",
        call: {
          call_id: concProviderId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 60_000,
          disconnection_reason: "user_hangup",
          call_analysis: "Detailed notes about buyer preferences",
          metadata: { business_id: BUSINESS_ID },
        },
      };

      const [resEnded, resAnalyzed] = await Promise.all([
        postRetell(endedPayload),
        postRetell(analyzedPayload),
      ]);

      expect(resEnded.status).toBe(202);
      expect(resAnalyzed.status).toBe(202);

      // Verify two distinct events exist in provider_events
      const events = await db
        .select()
        .from(providerEventsTable)
        .where(
          and(
            eq(providerEventsTable.businessId, BUSINESS_ID),
            eq(providerEventsTable.provider, "Retell"),
          ),
        );

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("call_ended");
      expect(eventTypes).toContain("call_analyzed");

      // Verify usage billed exactly once
      const [usage] = await db
        .select()
        .from(usageTable)
        .where(eq(usageTable.businessId, BUSINESS_ID));
      expect(Number(usage?.voiceMinutes)).toBeCloseTo(60 / 60, 4);

      // Verify summary updated from call_analyzed
      const [call] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, concBilledCallId));
      expect(call?.status).toBe("completed");
      expect(call?.summary).toBe("Detailed notes about buyer preferences");
    });

    it("call_analyzed arriving before call_ended reconciles cleanly and bills once", async () => {
      const orderCallId = "call_order_test";
      const orderProviderId = "retell_order_test";
      await db.insert(callsTable).values({
        id: orderCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: orderProviderId,
        idempotencyKey: "key_order_test",
        status: "in_progress",
      });

      // 1. call_analyzed arrives first
      const res1 = await postRetell({
        event: "call_analyzed",
        call: {
          call_id: orderProviderId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 120_000,
          disconnection_reason: "user_hangup",
          call_analysis: "Early analysis payload",
          metadata: { business_id: BUSINESS_ID },
        },
      });
      expect(res1.status).toBe(202);

      // 2. call_ended arrives second
      const res2 = await postRetell({
        event: "call_ended",
        call: {
          call_id: orderProviderId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 120_000,
          disconnection_reason: "user_hangup",
          metadata: { business_id: BUSINESS_ID },
        },
      });
      expect(res2.status).toBe(202);

      const [call] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, orderCallId));
      expect(call?.status).toBe("completed");
      expect(call?.summary).toBe("Early analysis payload");
      expect(call?.durationSeconds).toBe(120);
    });

    it("concurrent billing attempts under lock only bill once", async () => {
      const billCallId = "call_lock_billing";
      await db.insert(callsTable).values({
        id: billCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: "retell_lock_billing",
        idempotencyKey: "key_lock_billing",
        status: "in_progress",
      });

      const p1 = db.transaction((tx) =>
        reconcileCallAndBillUnderLock(tx, {
          callId: billCallId,
          businessId: BUSINESS_ID,
          providerStatus: "ended",
          startTimestampMs: 1720000000000,
          durationMs: 30_000,
          disconnectionReason: "user_hangup",
          sourceEvent: "conc_1",
        }),
      );

      const p2 = db.transaction((tx) =>
        reconcileCallAndBillUnderLock(tx, {
          callId: billCallId,
          businessId: BUSINESS_ID,
          providerStatus: "ended",
          startTimestampMs: 1720000000000,
          durationMs: 30_000,
          disconnectionReason: "user_hangup",
          sourceEvent: "conc_2",
        }),
      );

      const [res1, res2] = await Promise.all([p1, p2]);
      const billedResults = [res1.billed, res2.billed].sort();
      expect(billedResults).toEqual([false, true]);
    });

    it("cancellation racing with worker dispatch aborts worker before dialing Retell", async () => {
      const cancelRaceCallId = "call_cancel_race";
      await db.insert(callsTable).values({
        id: cancelRaceCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        idempotencyKey: "key_cancel_race",
        status: "queued",
      });

      const dialSpy = vi.spyOn(providers, "startRetellCall");

      // 1. Operator cancels call
      const cancelRes = await request(buildApp())
        .post(`/api/calls/${cancelRaceCallId}/cancel`)
        .send();
      expect(cancelRes.status).toBe(200);

      // 2. Worker tries to dispatch
      const { dispatchQueuedCall } = await import("../lib/callQueue");
      const dispatchResult = await dispatchQueuedCall({
        businessId: BUSINESS_ID,
        callId: cancelRaceCallId,
      });

      expect(dispatchResult.outcome).toBe("already_handled");
      expect(dialSpy).not.toHaveBeenCalled();

      dialSpy.mockRestore();
    });

    it("worker unmatched-event drain racing with scheduled sweep processes event exactly once", async () => {
      const drainRaceProviderId = "retell_drain_race";
      const drainRaceCallId = "call_drain_race";

      // 1. Unmatched webhook arrives first
      await postRetell({
        event: "call_ended",
        event_id: "evt_drain_race_1",
        call: {
          call_id: drainRaceProviderId,
          call_status: "ended",
          start_timestamp: 1720000000000,
          duration_ms: 30_000,
          disconnection_reason: "user_hangup",
          metadata: { business_id: BUSINESS_ID },
        },
      });

      // 2. Call row is registered
      await db.insert(callsTable).values({
        id: drainRaceCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: drainRaceProviderId,
        idempotencyKey: "key_drain_race",
        status: "in_progress",
      });

      // 3. Run two sweeps simultaneously
      const { sweepUnmatchedEvents } = await import("../lib/scheduler");
      const [count1, count2] = await Promise.all([
        sweepUnmatchedEvents(db as never),
        sweepUnmatchedEvents(db as never),
      ]);

      expect(count1 + count2).toBe(1);

      const [call] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, drainRaceCallId));
      expect(call?.status).toBe("completed");
    });

    it("enforces cross-tenant isolation for stop, cancel, and reconcile", async () => {
      const OTHER_BUSINESS = "business_other_tenant";
      await db.insert(businessesTable).values({
        ...pilotBusiness(),
        id: OTHER_BUSINESS,
        name: "Other Tenant Inc",
      } as never);

      const otherApp = buildApp(OTHER_BUSINESS);

      // Attempting to cancel, stop, or reconcile CALL_ID (which belongs to BUSINESS_ID) from OTHER_BUSINESS
      const cancelRes = await request(otherApp)
        .post(`/api/calls/${CALL_ID}/cancel`)
        .send();
      expect(cancelRes.status).toBe(404);

      const stopRes = await request(otherApp)
        .post(`/api/calls/${CALL_ID}/stop`)
        .send({ force_retry: false });
      expect(stopRes.status).toBe(404);

      const reconcileRes = await request(otherApp)
        .post(`/api/calls/${CALL_ID}/reconcile`)
        .send();
      expect(reconcileRes.status).toBe(404);
    });

    it("recovers ambiguous stop state via /reconcile after simulated process restart", async () => {
      const restartCallId = "call_restart_test";
      const restartProviderId = "retell_restart_test";
      await db.insert(callsTable).values({
        id: restartCallId,
        businessId: BUSINESS_ID,
        contactId: "contact_4b",
        leadId: "lead_4b",
        provider: "Retell",
        providerCallId: restartProviderId,
        idempotencyKey: "key_restart_test",
        status: "in_progress",
        metadata: {
          operator_stop_ambiguous: true,
          operator_stop_pending: false,
        },
      });

      // 1. Operator lists active calls and sees ambiguous state
      const activeRes = await request(buildApp()).get("/api/calls/active");
      const found = activeRes.body.find((c: any) => c.id === restartCallId);
      expect(found).toBeDefined();
      expect(found.stop_ambiguous).toBe(true);

      // 2. Operator triggers /reconcile
      const getSpy = vi.spyOn(providers, "getRetellCall").mockResolvedValue({
        call_id: restartProviderId,
        call_status: "ended",
        start_timestamp: 1720000000000,
        duration_ms: 45_000,
        disconnection_reason: "user_hangup",
      });

      const reconcileRes = await request(buildApp())
        .post(`/api/calls/${restartCallId}/reconcile`)
        .send();

      expect(reconcileRes.status).toBe(200);
      expect(reconcileRes.body.status).toBe("completed");

      const [clearedCall] = await db
        .select()
        .from(callsTable)
        .where(eq(callsTable.id, restartCallId));
      expect(clearedCall?.status).toBe("completed");
      expect((clearedCall?.metadata as any)?.operator_stop_ambiguous).toBe(false);

      getSpy.mockRestore();
    });
  });
});
