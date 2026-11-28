import http from "node:http";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import {
  businessesTable,
  callsTable,
  contactsTable,
  leadsTable,
  providerCredentialsTable,
  usersTable,
} from "@workspace/db";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import leadsprintRouter, { __setLeadsprintDb, resolveTenantRetellApiKey } from "./leadsprint";
import {
  callMonitorManager,
  __setWebSocketFactory,
  __resetWebSocketFactory,
  type WebSocketFactory,
} from "../lib/callMonitor";
import { upsertTenantProviderCredential } from "../lib/security";

const RETELL_KEY = "test_retell_monitor_key";
const BUSINESS_ID = "business_pilot";
const OTHER_BUSINESS_ID = "business_other";
const CALL_ID = "call_mon_1";
const PROVIDER_CALL_ID = "retell_call_mon_1";

let db: TestDb;
let createdSockets: MockWebSocket[] = [];

class MockWebSocket {
  url: string;
  options?: { headers?: Record<string, string> };
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1; // OPEN

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function buildApp(options?: {
  businessId?: string;
  role?: string;
  unauthenticated?: boolean;
}): Express {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    if (options?.unauthenticated) {
      return next();
    }
    const tenantId = options?.businessId ?? BUSINESS_ID;
    const role = (options?.role ?? "admin") as any;
    (req as any).leadSprintBusinessId = tenantId;
    (req as any).leadSprintUserId = "user_pilot";
    (req as any).leadSprintRole = role;
    (req as any).leadSprintOrgRole = role;
    (req as any).auth = {
      userId: "user_pilot",
      sessionClaims: {
        org_id: tenantId,
        org_role: role === "owner" ? "org:admin" : `org:${role}`,
      },
    };
    next();
  });

  app.use("/api", leadsprintRouter);
  return app;
}

describe("GET /api/calls/:id/monitor-stream", () => {
  beforeEach(async () => {
    process.env.LEADSPRINT_DEMO_AUTH = "true";
    process.env.NODE_ENV = "development";
    process.env.RETELL_API_KEY = RETELL_KEY;
    process.env.APP_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    db = await createTestDb();
    __setLeadsprintDb(db as never);
    callMonitorManager.reset();
    createdSockets = [];

    const factory: WebSocketFactory = (url, options) => {
      const ws = new MockWebSocket(url, options);
      createdSockets.push(ws);
      return ws as unknown as WebSocket;
    };
    __setWebSocketFactory(factory);

    await db.insert(businessesTable).values(pilotBusiness() as never);
    await db.insert(businessesTable).values({
      ...pilotBusiness(),
      id: OTHER_BUSINESS_ID,
      name: "Other Realty",
    } as never);

    await db.insert(usersTable).values({
      id: "user_pilot",
      businessId: BUSINESS_ID,
      email: "pilot@example.com",
      name: "Pilot Admin",
      role: "owner",
    });

    await db.insert(contactsTable).values({
      id: "contact_mon_1",
      businessId: BUSINESS_ID,
      name: "Alice Walker",
      phone: "+19175550188",
      consentStatus: "valid",
      consentSource: "web_form",
      consentAt: new Date(),
      timezone: "America/New_York",
    });

    await db.insert(leadsTable).values({
      id: "lead_mon_1",
      businessId: BUSINESS_ID,
      contactId: "contact_mon_1",
      project: "Downtown Condos",
      propertyType: "Condo",
      budgetLabel: "$850k – $1.1M",
      location: "Williamsburg",
      timeline: "0–3 months",
      status: "in_progress",
      score: "warm",
    });

    await db.insert(callsTable).values({
      id: CALL_ID,
      businessId: BUSINESS_ID,
      contactId: "contact_mon_1",
      leadId: "lead_mon_1",
      direction: "outbound",
      status: "in_progress",
      provider: "retell",
      providerCallId: PROVIDER_CALL_ID,
      idempotencyKey: "idem_call_mon_1",
      startedAt: new Date(),
    });
  });

  afterEach(() => {
    callMonitorManager.reset();
    __resetWebSocketFactory();
    delete process.env.APP_ENCRYPTION_KEY;
  });

  it("rejects non-operations roles (e.g. member) with 403", async () => {
    const res = await request(buildApp({ role: "member" }))
      .get(`/api/calls/${CALL_ID}/monitor-stream`)
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Insufficient permissions for this action");
  });

  it("returns 404 when call does not exist", async () => {
    const res = await request(buildApp({ role: "admin" }))
      .get("/api/calls/non_existent_call/monitor-stream")
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Call not found");
  });

  it("enforces tenant boundary: returns 404 if call belongs to a different business", async () => {
    const res = await request(buildApp({ businessId: OTHER_BUSINESS_ID, role: "admin" }))
      .get(`/api/calls/${CALL_ID}/monitor-stream`)
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Call not found");
  });

  it("rejects calls that are not in_progress (e.g. queued or ended) with 400", async () => {
    await db.insert(callsTable).values({
      id: "call_queued_1",
      businessId: BUSINESS_ID,
      contactId: "contact_mon_1",
      leadId: "lead_mon_1",
      direction: "outbound",
      status: "queued",
      provider: "retell",
      providerCallId: "retell_queued_1",
      idempotencyKey: "idem_call_queued_1",
    });

    const res = await request(buildApp({ role: "admin" }))
      .get("/api/calls/call_queued_1/monitor-stream")
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Only in-progress calls can be monitored");
  });

  it("rejects calls without a providerCallId with 400", async () => {
    await db.insert(callsTable).values({
      id: "call_no_provider_id",
      businessId: BUSINESS_ID,
      contactId: "contact_mon_1",
      leadId: "lead_mon_1",
      direction: "outbound",
      status: "in_progress",
      provider: "retell",
      providerCallId: null,
      idempotencyKey: "idem_call_no_provider_id",
    });

    const res = await request(buildApp({ role: "admin" }))
      .get("/api/calls/call_no_provider_id/monitor-stream")
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Call has no active provider call ID");
  });

  it("successfully streams SSE headers and initial connected event for valid in-progress call", async () => {
    const app = buildApp({ role: "admin" });
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    let received = "";
    let statusCode = 0;
    let contentType = "";
    let cacheControl = "";

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/calls/${CALL_ID}/monitor-stream`, (res) => {
        statusCode = res.statusCode ?? 0;
        contentType = res.headers["content-type"] ?? "";
        cacheControl = res.headers["cache-control"] ?? "";

        res.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
          if (received.includes("event: connected")) {
            req.destroy();
            resolve();
          }
        });
      });

      req.on("error", (err) => {
        if ((err as any).code === "ECONNRESET") {
          resolve();
        } else {
          reject(err);
        }
      });
    });

    server.close();

    expect(statusCode).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(cacheControl).toContain("no-cache");
    expect(received).toContain("event: connected");
    expect(received).toContain(CALL_ID);
    expect(received).not.toContain(RETELL_KEY);
  });

  describe("Tenant Credential Isolation for Live Monitoring", () => {
    it("1. valid tenant key: uses tenant-specific encrypted Retell key instead of global key", async () => {
      await upsertTenantProviderCredential(db as never, {
        businessId: BUSINESS_ID,
        userId: "user_pilot",
        provider: "retell",
        config: { api_key: "retell_custom_tenant_alpha_key" },
      });

      const resolved = await resolveTenantRetellApiKey(db as never, BUSINESS_ID);
      expect(resolved).toBe("retell_custom_tenant_alpha_key");

      const app = buildApp({ role: "admin" });
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/calls/${CALL_ID}/monitor-stream`, (res) => {
          res.on("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => resolve());
      });
      server.close();

      expect(createdSockets).toHaveLength(1);
      expect(createdSockets[0].options?.headers?.Authorization).toBe("Bearer retell_custom_tenant_alpha_key");
      expect(createdSockets[0].options?.headers?.Authorization).not.toBe(`Bearer ${RETELL_KEY}`);
    });

    it("2. no tenant credentials: safely falls back to global Retell key for pilot workspace", async () => {
      const resolved = await resolveTenantRetellApiKey(db as never, BUSINESS_ID);
      expect(resolved).toBe(RETELL_KEY);

      const app = buildApp({ role: "admin" });
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      await new Promise<void>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/calls/${CALL_ID}/monitor-stream`, (res) => {
          res.on("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => resolve());
      });
      server.close();

      expect(createdSockets).toHaveLength(1);
      expect(createdSockets[0].options?.headers?.Authorization).toBe(`Bearer ${RETELL_KEY}`);
    });

    it("3. tenant credential exists but API key is missing: fails closed (503) and never leaks global key", async () => {
      await upsertTenantProviderCredential(db as never, {
        businessId: BUSINESS_ID,
        userId: "user_pilot",
        provider: "retell",
        config: { agent_id: "agent_without_key_only" },
      });

      const resolved = await resolveTenantRetellApiKey(db as never, BUSINESS_ID);
      expect(resolved).toBeUndefined();

      const res = await request(buildApp({ role: "admin" }))
        .get(`/api/calls/${CALL_ID}/monitor-stream`)
        .set("Accept", "text/event-stream");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Retell API key is not configured for this workspace");
      expect(createdSockets).toHaveLength(0);
    });

    it("4. tenant credential decryption failure: fails closed (503) and never leaks global key", async () => {
      await db.insert(providerCredentialsTable).values({
        id: "cred_corrupt",
        businessId: BUSINESS_ID,
        provider: "retell",
        encryptedConfig: "v1:corrupt_iv:corrupt_ciphertext:corrupt_tag",
        keyFingerprint: "fingerprint_test",
        updatedBy: "user_pilot",
        updatedAt: new Date(),
      } as never);

      const resolved = await resolveTenantRetellApiKey(db as never, BUSINESS_ID);
      expect(resolved).toBeUndefined();

      const res = await request(buildApp({ role: "admin" }))
        .get(`/api/calls/${CALL_ID}/monitor-stream`)
        .set("Accept", "text/event-stream");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Retell API key is not configured for this workspace");
      expect(createdSockets).toHaveLength(0);
    });

    it("5. confirmation that another tenant's key is never used across workspaces", async () => {
      // Configure Tenant A with dedicated key
      await upsertTenantProviderCredential(db as never, {
        businessId: BUSINESS_ID,
        userId: "user_pilot",
        provider: "retell",
        config: { api_key: "retell_key_tenant_alpha" },
      });

      // Configure Tenant B with dedicated key
      await upsertTenantProviderCredential(db as never, {
        businessId: OTHER_BUSINESS_ID,
        userId: "user_pilot",
        provider: "retell",
        config: { api_key: "retell_key_tenant_beta" },
      });

      // Tenant A resolves strictly Tenant A's key
      const keyA = await resolveTenantRetellApiKey(db as never, BUSINESS_ID);
      expect(keyA).toBe("retell_key_tenant_alpha");

      // Tenant B resolves strictly Tenant B's key
      const keyB = await resolveTenantRetellApiKey(db as never, OTHER_BUSINESS_ID);
      expect(keyB).toBe("retell_key_tenant_beta");
      expect(keyA).not.toBe(keyB);

      // Create contact, lead and call for Tenant B
      await db.insert(contactsTable).values({
        id: "contact_mon_b",
        businessId: OTHER_BUSINESS_ID,
        name: "Bob Builder",
        phone: "+19175550177",
        consentStatus: "valid",
        consentSource: "web_form",
        consentAt: new Date(),
        timezone: "America/New_York",
      });

      await db.insert(leadsTable).values({
        id: "lead_mon_b",
        businessId: OTHER_BUSINESS_ID,
        contactId: "contact_mon_b",
        project: "Uptown Condos",
        propertyType: "Condo",
        budgetLabel: "$500k – $800k",
        location: "Manhattan",
        timeline: "0–3 months",
        status: "in_progress",
        score: "warm",
      });

      await db.insert(callsTable).values({
        id: "call_tenant_b",
        businessId: OTHER_BUSINESS_ID,
        contactId: "contact_mon_b",
        leadId: "lead_mon_b",
        direction: "outbound",
        status: "in_progress",
        provider: "retell",
        providerCallId: "retell_call_b",
        idempotencyKey: "idem_call_b",
        startedAt: new Date(),
      });

      // Tenant A requests Tenant B's call -> rejected with 404, never sees Tenant B's key
      const resA = await request(buildApp({ businessId: BUSINESS_ID, role: "admin" }))
        .get("/api/calls/call_tenant_b/monitor-stream")
        .set("Accept", "text/event-stream");

      expect(resA.status).toBe(404);
      expect(resA.body.error).toBe("Call not found");
      expect(createdSockets).toHaveLength(0);
    });
  });
});
