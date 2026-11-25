import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  apiKeysTable,
  auditLogsTable,
  businessesTable,
  contactsTable,
  leadsTable,
  providerCredentialsTable,
  usersTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import securityRouter, { __resetSecurityDb, __setSecurityDb } from "./security";
import webhooksRouter, { __resetWebhooksDb, __setWebhooksDb } from "./webhooks";
import { __resetCallQueueDb, __setCallQueueDb } from "../lib/callQueue";
import { upsertTenantProviderCredential } from "../lib/security";
import * as providers from "../lib/providers";

const ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BIZ_A = "biz_alpha";
const BIZ_B = "biz_beta";

let db: TestDb;
const startRetellCall = vi.spyOn(providers, "startRetellCall");

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
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user-id");
    const businessId = req.get("x-test-business-id");
    const role = req.get("x-test-role");
    if (userId) req.leadSprintUserId = userId;
    if (businessId) req.leadSprintBusinessId = businessId;
    if (role) req.leadSprintRole = role as never;
    next();
  });
  app.use("/api", securityRouter);
  return app;
}

function signHmac(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function signRetell(rawBody: string, key: string): string {
  const ts = String(Date.now());
  const d = crypto.createHmac("sha256", key).update(rawBody + ts).digest("hex");
  return `v=${ts},d=${d}`;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T18:00:00Z")); // 14:00 EDT, 11:00 PDT, 23:30 IST
  db = await createTestDb();
  __setSecurityDb(db as never);
  __setWebhooksDb(db as never);
  __setCallQueueDb(db as never);
  process.env["APP_ENCRYPTION_KEY"] = ENC_KEY;
  startRetellCall.mockReset();
  startRetellCall.mockResolvedValue({ callId: "retell_call_sec" });

  await db.insert(businessesTable).values([
    pilotBusiness({ id: BIZ_A, name: "Alpha Realty" }) as never,
    pilotBusiness({ id: BIZ_B, name: "Beta India", market: "IN", timezone: "Asia/Kolkata", quietHours: "21:00-09:00" }) as never,
  ]);
  await db.insert(usersTable).values([
    { id: "user_a_owner", businessId: BIZ_A, name: "Alice", email: "a@alpha.example", role: "owner" },
    { id: "user_b_owner", businessId: BIZ_B, name: "Bob", email: "b@beta.example", role: "owner" },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  __resetSecurityDb();
  __resetWebhooksDb();
  __resetCallQueueDb();
  delete process.env["APP_ENCRYPTION_KEY"];
  delete process.env["LEAD_INTAKE_WEBHOOK_SECRET"];
  delete process.env["CALCOM_WEBHOOK_SECRET"];
  delete process.env["RETELL_WEBHOOK_SECRET"];
});

describe("Phase 2 Security: API Keys, Encrypted Credentials, Tenant Intake & Replay", () => {
  it("manages per-tenant hashed API keys with RBAC, one-time reveal, and cross-tenant isolation", async () => {
    const app = buildApp();

    // Member & manager cannot list, create, or revoke API keys.
    expect(
      (
        await request(app)
          .get("/api/api-keys")
          .set("x-test-user-id", "user_a_owner")
          .set("x-test-business-id", BIZ_A)
          .set("x-test-role", "member")
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/api-keys")
          .set("x-test-user-id", "user_a_owner")
          .set("x-test-business-id", BIZ_A)
          .set("x-test-role", "manager")
          .send({ name: "Nope" })
      ).status,
    ).toBe(403);

    // Owner creates an API key: raw secret returned ONCE, DB holds SHA-256 only.
    const created = await request(app)
      .post("/api/api-keys")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner")
      .send({ name: "Meta Ads Key", scopes: ["leads:intake"] });
    expect(created.status).toBe(201);
    const rawKey = created.body.secret_key as string;
    const keyId = created.body.api_key.id as string;
    expect(rawKey.startsWith("ls_live_")).toBe(true);

    const [stored] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, keyId));
    expect(stored?.keyHash).toBe(crypto.createHash("sha256").update(rawKey).digest("hex"));
    expect(stored?.keyHash).not.toBe(rawKey);

    // List endpoint never exposes raw key or hash.
    const listed = await request(app)
      .get("/api/api-keys")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(rawKey);
    expect(JSON.stringify(listed.body)).not.toContain(stored!.keyHash);

    // Org B cannot revoke Org A's key.
    const crossRevoke = await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set("x-test-user-id", "user_b_owner")
      .set("x-test-business-id", BIZ_B)
      .set("x-test-role", "owner");
    expect(crossRevoke.status).toBe(404);

    // Org A revokes key -> immediate 401 on intake.
    const revoked = await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner");
    expect(revoked.status).toBe(200);

    const rejected = await request(app)
      .post("/api/webhooks/intake")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ name: "Blocked", phone: "+19175550111", consent_status: "valid", consent_source: "form" });
    expect(rejected.status).toBe(401);
  });

  it("encrypts provider credentials with AES-256-GCM, redacts secrets on read, and fails closed without APP_ENCRYPTION_KEY", async () => {
    const app = buildApp();

    const saveRes = await request(app)
      .put("/api/credentials/retell")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "admin")
      .send({
        config: {
          api_key: "key_super_secret_9988",
          webhook_secret: "whsec_secret_1122",
          agent_id: "agent_alpha_1",
        },
      });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.credential.configured).toBe(true);
    expect(saveRes.body.credential.masked_hints.api_key).toBe("••••9988");
    expect(JSON.stringify(saveRes.body)).not.toContain("key_super_secret_9988");
    expect(JSON.stringify(saveRes.body)).not.toContain("whsec_secret_1122");

    const [row] = await db
      .select()
      .from(providerCredentialsTable)
      .where(eq(providerCredentialsTable.businessId, BIZ_A));
    expect(row?.encryptedConfig.startsWith("enc:v1:")).toBe(true);
    expect(row?.encryptedConfig).not.toContain("key_super_secret_9988");

    const listRes = await request(app)
      .get("/api/credentials")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner");
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(listRes.body)).not.toContain("key_super_secret_9988");

    // Fails closed with 503 if APP_ENCRYPTION_KEY is absent.
    delete process.env["APP_ENCRYPTION_KEY"];
    const failClosed = await request(app)
      .put("/api/credentials/calcom")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner")
      .send({ config: { webhook_secret: "cal_sec" } });
    expect(failClosed.status).toBe(503);

    // Audit log recorded credential update without leaking plaintext secrets.
    const audits = await db.select().from(auditLogsTable).where(eq(auditLogsTable.businessId, BIZ_A));
    expect(JSON.stringify(audits)).not.toContain("key_super_secret_9988");
  });

  it("rejects global LEAD_INTAKE_WEBHOOK_SECRET, enforces tenant API key/HMAC scope & replay protection, and resolves +91 timezone", async () => {
    const app = buildApp();
    process.env["LEAD_INTAKE_WEBHOOK_SECRET"] = "legacy_global_secret";

    // Global secret must NO LONGER authenticate /api/webhooks/intake.
    const legacyRaw = JSON.stringify({
      business_id: BIZ_A,
      name: "Legacy Attacker",
      phone: "+19175550120",
      consent_status: "valid",
      consent_source: "form",
    });
    const globalRejected = await request(app)
      .post("/api/webhooks/intake")
      .set("content-type", "application/json")
      .set("x-leadsprint-signature", signHmac(legacyRaw, "legacy_global_secret"))
      .set("x-webhook-timestamp", new Date().toISOString())
      .send(legacyRaw);
    expect(globalRejected.status).toBe(401);

    // Create Org A API key and test cross-tenant business_id spoofing -> 403.
    const keyRes = await request(app)
      .post("/api/api-keys")
      .set("x-test-user-id", "user_a_owner")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-role", "owner")
      .send({ name: "Alpha Intake", scopes: ["leads:intake"] });
    const keyA = keyRes.body.secret_key as string;

    const crossTenantSpoof = await request(app)
      .post("/api/webhooks/intake")
      .set("Authorization", `Bearer ${keyA}`)
      .send({
        business_id: BIZ_B,
        name: "Spoofed Lead",
        phone: "+919876543210",
        consent_status: "valid",
        consent_source: "form",
      });
    expect(crossTenantSpoof.status).toBe(403);

    // Configure Org B's own encrypted intake webhook secret & submit an India +91 lead via HMAC.
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_B,
      userId: "user_b_owner",
      provider: "intake",
      config: { webhook_secret: "beta_tenant_secret" },
    });

    const indiaRaw = JSON.stringify({
      business_id: BIZ_B,
      name: "Aarav Sharma",
      phone: "+91 98765 43210",
      consent_status: "valid",
      consent_source: "meta_lead_form:in_1",
    });
    const indiaTs = new Date().toISOString();

    // Missing timestamp on HMAC intake fails closed with 401.
    const missingTs = await request(app)
      .post(`/api/webhooks/intake/${BIZ_B}`)
      .set("content-type", "application/json")
      .set("x-leadsprint-signature", signHmac(indiaRaw, "beta_tenant_secret"))
      .send(indiaRaw);
    expect(missingTs.status).toBe(401);

    // Valid timestamp + Org B secret succeeds and resolves Asia/Kolkata timezone (and blocks 23:30 IST call cleanly).
    const okIndia = await request(app)
      .post(`/api/webhooks/intake/${BIZ_B}`)
      .set("content-type", "application/json")
      .set("x-leadsprint-signature", signHmac(indiaRaw, "beta_tenant_secret"))
      .set("x-webhook-timestamp", indiaTs)
      .send(indiaRaw);
    expect(okIndia.status).toBe(201);
    const [contactIn] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.businessId, BIZ_B));
    expect(contactIn?.phone).toBe("+919876543210");
    expect(contactIn?.timezone).toBe("Asia/Kolkata");

    // Identical replay within 300s is rejected with 409!
    const replay = await request(app)
      .post(`/api/webhooks/intake/${BIZ_B}`)
      .set("content-type", "application/json")
      .set("x-leadsprint-signature", signHmac(indiaRaw, "beta_tenant_secret"))
      .set("x-webhook-timestamp", indiaTs)
      .send(indiaRaw);
    expect(replay.status).toBe(409);

    // Tenant A cannot use Org B's intake secret.
    const wrongTenantHmac = await request(app)
      .post(`/api/webhooks/intake/${BIZ_A}`)
      .set("content-type", "application/json")
      .set("x-leadsprint-signature", signHmac(indiaRaw, "beta_tenant_secret"))
      .set("x-webhook-timestamp", new Date().toISOString())
      .send(indiaRaw);
    expect(wrongTenantHmac.status).toBe(401);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.businessId, BIZ_A))).toHaveLength(0);
  });

  it("verifies per-tenant Retell and Cal.com webhook signatures & rejects missing Cal.com createdAt", async () => {
    const app = buildApp();
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: "user_a_owner",
      provider: "retell",
      config: { webhook_secret: "retell_alpha_key" },
    });
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: "user_a_owner",
      provider: "calcom",
      config: { webhook_secret: "cal_alpha_secret" },
    });

    const retellBody = JSON.stringify({
      event: "call_ended",
      call: {
        call_id: "call_ext_a",
        call_status: "ended",
        metadata: { business_id: BIZ_A },
      },
    });
    expect(
      (
        await request(app)
          .post("/api/webhooks/retell")
          .set("content-type", "application/json")
          .set("x-retell-signature", signRetell(retellBody, "wrong_key"))
          .send(retellBody)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/webhooks/retell")
          .set("content-type", "application/json")
          .set("x-retell-signature", signRetell(retellBody, "retell_alpha_key"))
          .send(retellBody)
      ).status,
    ).toBe(202);

    // Cal.com webhook missing createdAt fails closed with 401.
    const calNoTs = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { metadata: { business_id: BIZ_A } },
    });
    expect(
      (
        await request(app)
          .post("/api/webhooks/calcom")
          .set("content-type", "application/json")
          .set("x-cal-signature-256", signHmac(calNoTs, "cal_alpha_secret"))
          .send(calNoTs)
      ).status,
    ).toBe(401);

    const calFresh = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      createdAt: new Date().toISOString(),
      payload: { metadata: { business_id: BIZ_A }, bookingId: "bk_1" },
    });
    expect(
      (
        await request(app)
          .post("/api/webhooks/calcom")
          .set("content-type", "application/json")
          .set("x-cal-signature-256", signHmac(calFresh, "cal_alpha_secret"))
          .send(calFresh)
      ).status,
    ).toBe(202);
  });
});

