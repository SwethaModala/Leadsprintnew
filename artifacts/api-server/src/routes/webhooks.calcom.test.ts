import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appointmentsTable,
  businessesTable,
  contactsTable,
  leadsTable,
  providerCredentialsTable,
  providerEventsTable,
  usersTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import webhooksRouter, {
  __resetWebhooksDb,
  __setWebhooksDb,
} from "./webhooks";
import { upsertTenantProviderCredential } from "../lib/security";

const CALCOM_SECRET = "test_calcom_webhook_secret";
const BIZ_A = "business_tenant_a";
const BIZ_B = "business_tenant_b";
const USER_A_ID = "user_cal_alpha";
const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

function signCal(body: Record<string, unknown>, secret = CALCOM_SECRET): string {
  const raw = Buffer.from(JSON.stringify(body));
  return `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
}

describe("LeadSprint Phase 4E — Cal.com Reschedule Identity & Booking Lifecycle", () => {
  let db: TestDb;
  let app: Express;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.APP_ENCRYPTION_KEY = ENC_KEY;
    process.env.CALCOM_WEBHOOK_SECRET = CALCOM_SECRET;

    db = await createTestDb();
    __setWebhooksDb(db as any);
    app = buildApp();

    // Seed Tenant A & Tenant B
    await db.insert(businessesTable).values(
      pilotBusiness({
        id: BIZ_A,
        name: "Tenant A Realty",
      }) as never,
    );
    await db.insert(businessesTable).values(
      pilotBusiness({
        id: BIZ_B,
        name: "Tenant B Realty",
      }) as never,
    );

    // Seed User for Tenant A
    await db.insert(usersTable).values({
      id: USER_A_ID,
      businessId: BIZ_A,
      email: "operator_a@test.local",
      name: "Operator A",
      role: "admin",
    });

    // Seed Contact & Lead for Tenant A
    await db.insert(contactsTable).values({
      id: "contact_cal_a",
      businessId: BIZ_A,
      name: "Marcus Buyer",
      phone: "+19175550184",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date(),
    });

    await db.insert(leadsTable).values({
      id: "lead_cal_a",
      businessId: BIZ_A,
      contactId: "contact_cal_a",
      source: "Zillow",
      project: "Northstar Realty",
      propertyType: "Condo",
      budgetLabel: "$1M",
      location: "Manhattan",
      timeline: "Immediate",
      status: "booked",
      nextAction: "Appointment confirmed",
    });

    // Seed Initial Confirmed Appointment for Tenant A
    await db.insert(appointmentsTable).values({
      id: "appt_cal_001",
      businessId: BIZ_A,
      contactId: "contact_cal_a",
      leadId: "lead_cal_a",
      serviceOrProperty: "Northstar Realty",
      startTime: new Date("2026-11-29T14:00:00.000Z"),
      endTime: new Date("2026-11-29T14:30:00.000Z"),
      timezone: "America/New_York",
      calendarProvider: "Cal.com",
      externalId: "cal_uid_orig_100",
      status: "confirmed",
    });
  });

  afterEach(() => {
    __resetWebhooksDb();
  });

  it("1. Original UID → new UID reschedule updates the existing appointment", async () => {
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.status).toBe("confirmed");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(and(eq(appointmentsTable.id, "appt_cal_001"), eq(appointmentsTable.businessId, BIZ_A)));

    expect(appt.externalId).toBe("cal_uid_v2_200");
    expect(appt.startTime.toISOString()).toBe("2026-11-30T16:00:00.000Z");
    expect(appt.endTime.toISOString()).toBe("2026-11-30T16:30:00.000Z");
    expect(appt.status).toBe("confirmed");
  });

  it("2. Appointment count remains exactly one after rescheduling", async () => {
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    const appts = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.businessId, BIZ_A));

    expect(appts.length).toBe(1);
    expect(appts[0].id).toBe("appt_cal_001");
  });

  it("3. Cancellation after rescheduling matches the new UID", async () => {
    // 1. Reschedule from orig -> v2
    const reschedPayload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };
    await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(reschedPayload))
      .send(reschedPayload);

    // 2. Cancellation referencing the new UID v2
    const cancelPayload = {
      triggerEvent: "BOOKING_CANCELLED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        metadata: { business_id: BIZ_A },
      },
    };
    const cancelRes = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(cancelPayload))
      .send(cancelPayload);

    expect(cancelRes.status).toBe(202);
    expect(cancelRes.body.status).toBe("cancelled");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(and(eq(appointmentsTable.id, "appt_cal_001"), eq(appointmentsTable.businessId, BIZ_A)));

    expect(appt.externalId).toBe("cal_uid_v2_200");
    expect(appt.status).toBe("cancelled");
  });

  it("4. Multiple sequential reschedules correctly transition the UID each time", async () => {
    // Reschedule 1: orig -> v2
    const payload1 = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };
    await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload1))
      .send(payload1);

    // Reschedule 2: v2 -> v3
    const payload2 = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v3_300",
        rescheduleUid: "cal_uid_v2_200",
        startTime: "2026-12-01T10:00:00.000Z",
        endTime: "2026-12-01T10:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };
    await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload2))
      .send(payload2);

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(and(eq(appointmentsTable.id, "appt_cal_001"), eq(appointmentsTable.businessId, BIZ_A)));

    expect(appt.externalId).toBe("cal_uid_v3_300");
    expect(appt.startTime.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(appt.endTime.toISOString()).toBe("2026-12-01T10:30:00.000Z");
    expect(appt.status).toBe("confirmed");
  });

  it("5. Duplicate reschedule webhook does not create or mutate duplicate appointments", async () => {
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    // First delivery
    const res1 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res1.status).toBe(202);
    expect(res1.body.duplicate).toBe(false);

    // Second delivery (duplicate payload)
    const res2 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res2.status).toBe(202);
    expect(res2.body.duplicate).toBe(true);

    const appts = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.businessId, BIZ_A));
    expect(appts.length).toBe(1);
  });

  it("6. Cancelled appointment cannot be reactivated by a delayed reschedule", async () => {
    // 1. Cancel the appointment
    await db
      .update(appointmentsTable)
      .set({ status: "cancelled" })
      .where(eq(appointmentsTable.id, "appt_cal_001"));

    // 2. Deliver delayed reschedule event
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("cancelled");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_001"));

    expect(appt.status).toBe("cancelled");
  });

  it("7. Same-UID reschedule works when no rescheduleUid is supplied", async () => {
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_orig_100", // Same UID as stored in appointment
        startTime: "2026-11-30T18:00:00.000Z",
        endTime: "2026-11-30T18:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmed");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_001"));

    expect(appt.externalId).toBe("cal_uid_orig_100");
    expect(appt.startTime.toISOString()).toBe("2026-11-30T18:00:00.000Z");
    expect(appt.endTime.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    expect(appt.status).toBe("confirmed");
  });

  it("8. Invalid dates and end times before start are rejected or safely marked for review", async () => {
    // End time before start time
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T18:00:00.000Z",
        endTime: "2026-11-30T17:00:00.000Z", // Invalid: before start
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("needs_review");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_001"));

    expect(appt.status).toBe("needs_review");
  });

  it("9. Unknown appointment does not silently become a permanently processed event", async () => {
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_unknown_999",
        rescheduleUid: "cal_uid_nonexistent_888",
        startTime: "2026-11-30T18:00:00.000Z",
        endTime: "2026-11-30T18:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("unmatched");

    // Check providerEventsTable: must be recorded as unmatched_webhook with processedAt = null
    const events = await db
      .select()
      .from(providerEventsTable)
      .where(eq(providerEventsTable.businessId, BIZ_A));

    const unmatched = events.find((e) => e.eventType === "unmatched_webhook");
    expect(unmatched).toBeDefined();
    expect(unmatched?.provider).toBe("Cal.com");
    expect(unmatched?.processedAt).toBeNull();
  });

  it("10. Tenant A's webhook cannot update Tenant B's appointment", async () => {
    // Seed an appointment for Tenant B
    await db.insert(contactsTable).values({
      id: "contact_cal_b",
      businessId: BIZ_B,
      name: "Tenant B Contact",
      phone: "+19175550999",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date(),
    });
    await db.insert(leadsTable).values({
      id: "lead_cal_b",
      businessId: BIZ_B,
      contactId: "contact_cal_b",
      source: "Website",
      project: "Tenant B Property",
      propertyType: "Condo",
      budgetLabel: "$500k",
      location: "Brooklyn",
      timeline: "Immediate",
      status: "booked",
      nextAction: "Appointment confirmed",
    });
    await db.insert(appointmentsTable).values({
      id: "appt_cal_b_002",
      businessId: BIZ_B,
      contactId: "contact_cal_b",
      leadId: "lead_cal_b",
      serviceOrProperty: "Tenant B Property",
      startTime: new Date("2026-11-29T14:00:00.000Z"),
      endTime: new Date("2026-11-29T14:30:00.000Z"),
      timezone: "America/New_York",
      calendarProvider: "Cal.com",
      externalId: "cal_uid_tenant_b_shared",
      status: "confirmed",
    });

    // Tenant A sends a webhook attempting to update Tenant B's externalId
    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_hacked_new",
        rescheduleUid: "cal_uid_tenant_b_shared",
        startTime: "2026-12-10T14:00:00.000Z",
        endTime: "2026-12-10T14:30:00.000Z",
        metadata: { business_id: BIZ_A }, // Tenant A's business_id
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("unmatched");

    // Tenant B's appointment MUST remain untouched
    const [apptB] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_b_002"));

    expect(apptB.externalId).toBe("cal_uid_tenant_b_shared");
    expect(apptB.startTime.toISOString()).toBe("2026-11-29T14:00:00.000Z");
    expect(apptB.status).toBe("confirmed");
  });

  it("11. Unmatched reschedule event retry reconciles appointment and promotes event", async () => {
    const UNMATCHED_ORIG_UID = "cal_uid_pending_orig_777";
    const NEW_UID = "cal_uid_reconciled_888";

    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: NEW_UID,
        rescheduleUid: UNMATCHED_ORIG_UID,
        startTime: "2026-12-05T10:00:00.000Z",
        endTime: "2026-12-05T10:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    // 1. Initial delivery when appointment does NOT exist yet
    const res1 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res1.status).toBe(202);
    expect(res1.body.status).toBe("unmatched");

    // Verify stored as unmatched_webhook with processedAt: null
    const [initialEvent] = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.eventType, "unmatched_webhook")));
    expect(initialEvent).toBeDefined();
    expect(initialEvent.processedAt).toBeNull();

    // 2. The appointment is subsequently inserted (e.g. late database sync or worker catch-up)
    await db.insert(appointmentsTable).values({
      id: "appt_cal_late_777",
      businessId: BIZ_A,
      contactId: "contact_cal_a",
      leadId: "lead_cal_a",
      serviceOrProperty: "Northstar Realty",
      startTime: new Date("2026-12-01T14:00:00.000Z"),
      endTime: new Date("2026-12-01T14:30:00.000Z"),
      timezone: "America/New_York",
      calendarProvider: "Cal.com",
      externalId: UNMATCHED_ORIG_UID,
      status: "confirmed",
    });

    // 3. Cal.com retries the exact same webhook
    const res2 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res2.status).toBe(202);
    expect(res2.body.duplicate).toBe(false);
    expect(res2.body.status).toBe("confirmed");

    // The appointment must be updated to the new UID and new times
    const [updatedAppt] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_late_777"));
    expect(updatedAppt.externalId).toBe(NEW_UID);
    expect(updatedAppt.startTime.toISOString()).toBe("2026-12-05T10:00:00.000Z");
    expect(updatedAppt.endTime.toISOString()).toBe("2026-12-05T10:30:00.000Z");

    // The provider event must be promoted from unmatched_webhook to BOOKING_RESCHEDULED with non-null processedAt
    const [promotedEvent] = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.externalEventId, initialEvent.externalEventId)));
    expect(promotedEvent.eventType).toBe("BOOKING_RESCHEDULED");
    expect(promotedEvent.processedAt).not.toBeNull();

    // 4. A further identical delivery is treated as duplicate without changing anything
    const res3 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res3.status).toBe(202);
    expect(res3.body.duplicate).toBe(true);
  });

  it("12. Credential isolation: tenant with dedicated webhook secret accepts its own valid signature and rejects global secret", async () => {
    const TENANT_CUSTOM_SECRET = "custom_tenant_alpha_secret_999";

    // Configure dedicated Cal.com credentials for Tenant A
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: USER_A_ID,
      provider: "calcom",
      config: {
        api_key: "cal_live_key_a",
        event_type_id: "123456",
        webhook_secret: TENANT_CUSTOM_SECRET,
      },
    });

    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    // A: Signed with tenant's dedicated secret -> ACCEPTED (202)
    const validTenantSig = signCal(payload, TENANT_CUSTOM_SECRET);
    const resValid = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", validTenantSig)
      .send(payload);
    expect(resValid.status).toBe(202);
    expect(resValid.body.accepted).toBe(true);

    // B: Attempting to authenticate Tenant A's webhook with the global secret -> REJECTED (401)
    const globalSig = signCal(payload, CALCOM_SECRET);
    const resGlobal = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", globalSig)
      .send(payload);
    expect(resGlobal.status).toBe(401);
    expect(resGlobal.body.error).toBe("Invalid Cal.com signature");
  });

  it("13. Credential isolation: tenant with missing webhook secret rejects global secret (fails closed)", async () => {
    // Configure Tenant A with Cal.com credentials that lack a webhook_secret
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: USER_A_ID,
      provider: "calcom",
      config: {
        api_key: "cal_live_key_a",
        event_type_id: "123456",
        // webhook_secret is intentionally omitted
      },
    });

    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    // Must NOT fall back to global CALCOM_SECRET. Signature with global secret must be rejected.
    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload, CALCOM_SECRET))
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid Cal.com signature");
  });

  it("14. Credential isolation: tenant without credential record can still use configured global pilot secret", async () => {
    // Tenant B has NO credentials row in provider_credentials
    const payload = {
      triggerEvent: "BOOKING_CREATED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_b_pilot_booking_123",
        metadata: { business_id: BIZ_B },
      },
    };

    // Signed with global platform secret -> ACCEPTED (202)
    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload, CALCOM_SECRET))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
  });

  it("15. Credential isolation: tenant with undecryptable credential record fails closed", async () => {
    // Insert corrupted credential record directly
    await db.insert(providerCredentialsTable).values({
      id: "cred_corrupt_cal",
      businessId: BIZ_A,
      provider: "calcom",
      encryptedConfig: "corrupted_non_decryptable_iv:ciphertext:tag",
      keyVersion: 1,
    });

    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: "cal_uid_v2_200",
        rescheduleUid: "cal_uid_orig_100",
        startTime: "2026-11-30T16:00:00.000Z",
        endTime: "2026-11-30T16:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    const res = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload, CALCOM_SECRET))
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid Cal.com signature");
  });

  it("16. Transaction rollback: failure during appointment update rolls back event promotion and preserves unmatched retryability", async () => {
    const UNMATCHED_ORIG_UID = "cal_uid_rollback_orig_999";
    const NEW_UID = "cal_uid_rollback_new_1000";

    const payload = {
      triggerEvent: "BOOKING_RESCHEDULED",
      createdAt: new Date().toISOString(),
      payload: {
        uid: NEW_UID,
        rescheduleUid: UNMATCHED_ORIG_UID,
        startTime: "2026-12-10T11:00:00.000Z",
        endTime: "2026-12-10T11:30:00.000Z",
        metadata: { business_id: BIZ_A },
      },
    };

    // 1. Initial delivery before appointment exists -> stored as unmatched_webhook with processedAt = null
    const res1 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res1.status).toBe(202);
    expect(res1.body.status).toBe("unmatched");

    const [unmatchedEvent] = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.eventType, "unmatched_webhook")));
    expect(unmatchedEvent).toBeDefined();
    expect(unmatchedEvent.processedAt).toBeNull();
    const unmatchedEventId = unmatchedEvent.externalEventId;

    // 2. Create matching appointment with original rescheduleUid
    const origStartTime = new Date("2026-12-08T10:00:00.000Z");
    const origEndTime = new Date("2026-12-08T10:30:00.000Z");
    await db.insert(appointmentsTable).values({
      id: "appt_cal_rollback_test",
      businessId: BIZ_A,
      contactId: "contact_cal_a",
      leadId: "lead_cal_a",
      serviceOrProperty: "Northstar Realty",
      startTime: origStartTime,
      endTime: origEndTime,
      timezone: "America/New_York",
      calendarProvider: "Cal.com",
      externalId: UNMATCHED_ORIG_UID,
      status: "confirmed",
    });

    // 3. Inject controlled failure during appointment update inside transaction
    let failAppointmentUpdate = true;
    const originalTransaction = db.transaction.bind(db);
    const txSpy = vi.spyOn(db, "transaction").mockImplementation(async (cb: any, ...args: any[]) => {
      return originalTransaction(async (tx: any) => {
        const originalUpdate = tx.update.bind(tx);
        tx.update = (table: any, ...uArgs: any[]) => {
          if (failAppointmentUpdate && table === appointmentsTable) {
            throw new Error("Controlled failure injected during appointment update");
          }
          return originalUpdate(table, ...uArgs);
        };
        return cb(tx);
      }, ...args);
    });

    let res2: request.Response;
    try {
      // Redelivery attempt that fails during tx.update(appointmentsTable)
      res2 = await request(app)
        .post("/api/webhooks/calcom")
        .set("Content-Type", "application/json")
        .set("x-cal-signature-256", signCal(payload))
        .send(payload);
    } finally {
      failAppointmentUpdate = false;
      txSpy.mockRestore();
    }
    expect(res2.status).toBe(500);

    // 4. Verify transaction rolled back:
    // - Appointment remains unchanged
    const [apptAfterRollback] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_rollback_test"));
    expect(apptAfterRollback.externalId).toBe(UNMATCHED_ORIG_UID);
    expect(apptAfterRollback.startTime.toISOString()).toBe(origStartTime.toISOString());
    expect(apptAfterRollback.status).toBe("confirmed");

    // - Provider event remains unmatched_webhook with processedAt = null
    const [eventAfterRollback] = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.externalEventId, unmatchedEventId)));
    expect(eventAfterRollback.eventType).toBe("unmatched_webhook");
    expect(eventAfterRollback.processedAt).toBeNull();

    // - No partially promoted row exists
    const promotedEvents = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.eventType, "BOOKING_RESCHEDULED")));
    expect(promotedEvents).toHaveLength(0);

    // 5. Retry the exact same webhook: must reconcile successfully
    const res3 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res3.status).toBe(202);
    expect(res3.body.duplicate).toBe(false);
    expect(res3.body.status).toBe("confirmed");

    // Appointment updated
    const [finalAppt] = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.id, "appt_cal_rollback_test"));
    expect(finalAppt.externalId).toBe(NEW_UID);
    expect(finalAppt.startTime.toISOString()).toBe("2026-12-10T11:00:00.000Z");

    // Provider event promoted with non-null processedAt
    const [promotedEvent] = await db
      .select()
      .from(providerEventsTable)
      .where(and(eq(providerEventsTable.businessId, BIZ_A), eq(providerEventsTable.externalEventId, unmatchedEventId)));
    expect(promotedEvent.eventType).toBe("BOOKING_RESCHEDULED");
    expect(promotedEvent.processedAt).not.toBeNull();

    // 7. Send the same webhook again: treated as duplicate without appointment mutation
    const res4 = await request(app)
      .post("/api/webhooks/calcom")
      .set("Content-Type", "application/json")
      .set("x-cal-signature-256", signCal(payload))
      .send(payload);
    expect(res4.status).toBe(202);
    expect(res4.body.duplicate).toBe(true);
    expect(res4.body.status).toBe("confirmed");
  });
});
