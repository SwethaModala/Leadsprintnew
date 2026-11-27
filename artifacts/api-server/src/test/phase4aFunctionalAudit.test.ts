import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express, { type Express } from "express";
import request from "supertest";
import {
  agentsTable,
  businessesTable,
  callsTable,
  contactsTable,
  leadsTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "./testDb";
import { tenantEventBus } from "../lib/eventBus";
import eventsRouter from "../routes/events";
import leadsprintRouter, {
  __resetLeadsprintDb,
  __setLeadsprintDb,
} from "../routes/leadsprint";
import healthRouter from "../routes/health";
function formatElapsed(seconds: number): string {
  if (Number.isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function parseElapsedSeconds(startedAt?: string | null): number | null {
  if (!startedAt) return null;
  const time = new Date(startedAt).getTime();
  if (Number.isNaN(time)) return null;
  const diff = Math.floor((Date.now() - time) / 1000);
  return diff < 0 ? 0 : diff;
}

const BIZ_A = "biz_audit_a";
const BIZ_B = "biz_audit_b";
const STATIC_DIR = path.resolve(__dirname, "../../../leadsprint/dist/public");

describe("Phase 4A: Comprehensive Local Functional Testing Audit", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    __setLeadsprintDb(db as any);
    tenantEventBus.reset();

    await db.insert(businessesTable).values(pilotBusiness({ id: BIZ_A, name: "Tenant A" }) as never);
    await db.insert(businessesTable).values(pilotBusiness({ id: BIZ_B, name: "Tenant B" }) as never);
  });

  afterEach(() => {
    __resetLeadsprintDb();
    tenantEventBus.reset();
  });

  function createTestApp(options: {
    auth?: boolean;
    businessId?: string;
    role?: string;
    serveStatic?: boolean;
  } = {}): Express {
    const app = express();
    app.use(express.json());

    // Health endpoint (unauthenticated)
    app.use("/api", healthRouter);

    // Simulated auth layer
    if (options.auth !== false) {
      app.use((req, _res, next) => {
        req.leadSprintUserId = "user_audit";
        req.leadSprintBusinessId = options.businessId ?? BIZ_A;
        req.leadSprintRole = (options.role as any) ?? "owner";
        next();
      });
    }

    // Phase 4A routes
    app.use("/api", eventsRouter);
    app.use("/api", leadsprintRouter);

    // Static frontend serving (simulating single-process Coolify / start-demo mode)
    if (options.serveStatic !== false && fs.existsSync(STATIC_DIR)) {
      app.use(express.static(STATIC_DIR, { index: false }));
      app.get(/^(?!\/api).*/, (_req, res) => {
        res.sendFile("index.html", { root: STATIC_DIR });
      });
    }

    return app;
  }

  // -------------------------------------------------------------------------
  // Test 1: Start the local database, backend and frontend
  // -------------------------------------------------------------------------
  it("Test 1: boots backend, serves healthcheck and static frontend SPA", async () => {
    const app = createTestApp({ auth: true, serveStatic: true });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      // Healthcheck
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData).toEqual({ status: "ok" });

      // Static Frontend SPA index.html
      const pageRes = await fetch(`http://127.0.0.1:${port}/workspace/calls`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get("content-type")).toContain("text/html");
      const html = await pageRes.text();
      expect(html.toLowerCase()).toContain("<!doctype html>");
      expect(html).toContain("<title>LeadSprint");
    } finally {
      server.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Active Calls API returns correct active and queued calls
  // -------------------------------------------------------------------------
  it("Test 2: GET /api/calls/active filters strictly by queued and in_progress", async () => {
    // Seed contact, lead, and agent for BIZ_A
    await db.insert(contactsTable).values({
      id: "c_1",
      businessId: BIZ_A,
      name: "John Lead",
      phone: "+12125550100",
      timezone: "America/New_York",
    });
    await db.insert(leadsTable).values({
      id: "l_1",
      businessId: BIZ_A,
      contactId: "c_1",
      source: "Website",
      campaign: "Pilot",
      project: "Condo",
      propertyType: "Condo",
      budgetLabel: "$500k",
      location: "NY",
      timeline: "Immediate",
    });
    await db.insert(agentsTable).values({
      id: "agt_1",
      businessId: BIZ_A,
      name: "Samantha Sales",
      publishedVersion: 1,
      status: "active",
    });

    // 1. in_progress call
    await db.insert(callsTable).values({
      id: "call_act_1",
      businessId: BIZ_A,
      contactId: "c_1",
      leadId: "l_1",
      agentId: "agt_1",
      direction: "outbound",
      status: "in_progress",
      startedAt: new Date(Date.now() - 45_000),
      idempotencyKey: "k_act_1",
    });

    // 2. queued call
    await db.insert(callsTable).values({
      id: "call_act_2",
      businessId: BIZ_A,
      contactId: "c_1",
      leadId: "l_1",
      direction: "outbound",
      status: "queued",
      idempotencyKey: "k_act_2",
    });

    // 3. completed call (should be excluded)
    await db.insert(callsTable).values({
      id: "call_comp",
      businessId: BIZ_A,
      contactId: "c_1",
      leadId: "l_1",
      status: "completed",
      idempotencyKey: "k_comp",
    });

    // 4. policy_blocked call (should be excluded)
    await db.insert(callsTable).values({
      id: "call_blocked",
      businessId: BIZ_A,
      contactId: "c_1",
      leadId: "l_1",
      status: "policy_blocked",
      idempotencyKey: "k_blocked",
    });

    // 5. failed call (should be excluded)
    await db.insert(callsTable).values({
      id: "call_failed",
      businessId: BIZ_A,
      contactId: "c_1",
      leadId: "l_1",
      status: "failed",
      idempotencyKey: "k_failed",
    });

    const app = createTestApp({ auth: true, businessId: BIZ_A });
    const res = await request(app).get("/api/calls/active");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const ids = res.body.map((c: any) => c.id);
    expect(ids).toContain("call_act_1");
    expect(ids).toContain("call_act_2");
    expect(ids).not.toContain("call_comp");
    expect(ids).not.toContain("call_blocked");
    expect(ids).not.toContain("call_failed");

    const call1 = res.body.find((c: any) => c.id === "call_act_1");
    expect(call1.status).toBe("in_progress");
    expect(call1.agent_name).toBe("Samantha Sales");
    expect(call1.lead_name).toBe("John Lead");
    expect(call1.direction).toBe("outbound");

    const call2 = res.body.find((c: any) => c.id === "call_act_2");
    expect(call2.status).toBe("queued");
  });

  // -------------------------------------------------------------------------
  // Test 3: Live Calls page displays call information correctly
  // -------------------------------------------------------------------------
  it("Test 3: formats call information and handles direction, caller, and destination", async () => {
    await db.insert(contactsTable).values({
      id: "c_out",
      businessId: BIZ_A,
      name: "Outbound Contact",
      phone: "+12125550200",
      timezone: "America/New_York",
    });
    await db.insert(leadsTable).values({
      id: "l_out",
      businessId: BIZ_A,
      contactId: "c_out",
      source: "Website",
      campaign: "Pilot",
      project: "Skyline",
      propertyType: "Condo",
      budgetLabel: "$500k",
      location: "NY",
      timeline: "Immediate",
    });
    await db.insert(callsTable).values({
      id: "call_info_out",
      businessId: BIZ_A,
      contactId: "c_out",
      leadId: "l_out",
      direction: "outbound",
      destinationNumber: "+12125550200",
      status: "in_progress",
      startedAt: new Date(Date.now() - 120_000),
      idempotencyKey: "k_info_out",
    });

    const app = createTestApp({ auth: true, businessId: BIZ_A });
    const res = await request(app).get("/api/calls/active");

    expect(res.status).toBe(200);
    const item = res.body.find((c: any) => c.id === "call_info_out");
    expect(item).toBeDefined();
    expect(item.lead_name).toBe("Outbound Contact");
    expect(item.destination_number).toBe("+12125550200");
    expect(item.direction).toBe("outbound");
    expect(item.started_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 4: SSE connects using Clerk authentication
  // -------------------------------------------------------------------------
  it("Test 4: SSE rejects unauthenticated requests and connects authenticated operators", async () => {
    // 1. Unauthenticated rejection
    const unauthApp = createTestApp({ auth: false });
    const unauthRes = await request(unauthApp).get("/api/events/live");
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.body).toEqual({ error: "Authentication required" });

    // 2. Authenticated streaming handshake
    const authApp = createTestApp({ auth: true, businessId: BIZ_A });
    const server = http.createServer(authApp);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      let received = "";
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/events/live`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toBe("text/event-stream");
          expect(res.headers["cache-control"]).toBe("no-cache, no-transform");

          res.on("data", (chunk: Buffer) => {
            received += chunk.toString();
            if (received.includes("event: connected")) {
              req.destroy();
              resolve();
            }
          });
        });
        req.on("error", (err) => {
          if ((err as any).code === "ECONNRESET") resolve();
          else reject(err);
        });
      });

      expect(received).toContain("event: connected");
      expect(received).toContain(BIZ_A);
    } finally {
      server.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Live events update the dashboard without refreshing the page
  // -------------------------------------------------------------------------
  it("Test 5: broadcasts real-time call_update and call_ended events over SSE", async () => {
    const app = createTestApp({ auth: true, businessId: BIZ_A });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      let received = "";
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/events/live`, (res) => {
          res.on("data", (chunk: Buffer) => {
            received += chunk.toString();

            // When connection greeting is received, broadcast mock live events
            if (received.includes("event: connected") && !received.includes("call_update")) {
              tenantEventBus.broadcast(BIZ_A, "call_update", {
                id: "call_live_5",
                status: "in_progress",
                duration_seconds: 15,
              });
            }

            if (received.includes("event: call_update")) {
              req.destroy();
              resolve();
            }
          });
        });
        req.on("error", (err) => {
          if ((err as any).code === "ECONNRESET") resolve();
          else reject(err);
        });
      });

      expect(received).toContain("event: call_update");
      expect(received).toContain("call_live_5");
      expect(received).toContain("in_progress");
    } finally {
      server.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: Tenant isolation
  // -------------------------------------------------------------------------
  it("Test 6: strictly isolates live events and active calls across tenants", async () => {
    const appA = createTestApp({ auth: true, businessId: BIZ_A });
    const appB = createTestApp({ auth: true, businessId: BIZ_B });

    const serverA = http.createServer(appA);
    const serverB = http.createServer(appB);
    await new Promise<void>((resolve) => serverA.listen(0, resolve));
    await new Promise<void>((resolve) => serverB.listen(0, resolve));
    const portA = (serverA.address() as any).port;
    const portB = (serverB.address() as any).port;

    let receivedA = "";
    let receivedB = "";

    try {
      // Connect client A to Tenant A stream
      const reqA = http.get(`http://127.0.0.1:${portA}/api/events/live`, (res) => {
        res.on("data", (c) => (receivedA += c.toString()));
      });

      // Connect client B to Tenant B stream
      const reqB = http.get(`http://127.0.0.1:${portB}/api/events/live`, (res) => {
        res.on("data", (c) => (receivedB += c.toString()));
      });

      // Wait 100ms for connections to be registered
      await new Promise((r) => setTimeout(r, 100));

      // Broadcast event exclusively to Tenant A
      tenantEventBus.broadcast(BIZ_A, "call_update", {
        id: "call_secret_tenant_a",
        status: "in_progress",
      });

      // Wait 100ms for delivery
      await new Promise((r) => setTimeout(r, 100));

      reqA.destroy();
      reqB.destroy();

      // Tenant A received the event
      expect(receivedA).toContain("call_secret_tenant_a");

      // Tenant B MUST NOT receive Tenant A's event
      expect(receivedB).not.toContain("call_secret_tenant_a");
    } finally {
      serverA.close();
      serverB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: SSE reconnection and query resynchronization
  // -------------------------------------------------------------------------
  it("Test 7: handles disconnection and successfully reconnects with fresh state", async () => {
    const app = createTestApp({ auth: true, businessId: BIZ_A });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      // 1. First connection
      let firstReceived = "";
      await new Promise<void>((resolve) => {
        const req1 = http.get(`http://127.0.0.1:${port}/api/events/live`, (res) => {
          res.on("data", (chunk: Buffer) => {
            firstReceived += chunk.toString();
            if (firstReceived.includes("event: connected")) {
              req1.destroy(); // Abrupt disconnect
              resolve();
            }
          });
        });
        req1.on("error", () => resolve());
      });
      expect(firstReceived).toContain("event: connected");

      // Verify connection count drops back to 0 on disconnect
      await new Promise((r) => setTimeout(r, 50));
      expect(tenantEventBus.getClientCount(BIZ_A)).toBe(0);

      // 2. Reconnection
      let reconnected = "";
      await new Promise<void>((resolve) => {
        const req2 = http.get(`http://127.0.0.1:${port}/api/events/live`, (res) => {
          res.on("data", (chunk: Buffer) => {
            reconnected += chunk.toString();
            if (reconnected.includes("event: connected")) {
              req2.destroy();
              resolve();
            }
          });
        });
        req2.on("error", () => resolve());
      });
      expect(reconnected).toContain("event: connected");
    } finally {
      server.close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 8: Empty call lists, missing contact details and missing agent details
  // -------------------------------------------------------------------------
  it("Test 8: gracefully handles empty call lists and nullable/missing contact & agent relations", async () => {
    const app = createTestApp({ auth: true, businessId: BIZ_A });

    // 1. Empty call list
    const emptyRes = await request(app).get("/api/calls/active");
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body).toEqual([]);

    // 2. Inbound call with placeholder "Unknown caller" and null agent
    await db.insert(contactsTable).values({
      id: "c_unknown",
      businessId: BIZ_A,
      name: "Unknown caller",
      phone: "+19175550000",
      timezone: "America/New_York",
    });
    await db.insert(leadsTable).values({
      id: "l_unknown",
      businessId: BIZ_A,
      contactId: "c_unknown",
      source: "inbound",
      campaign: "Inbound",
      project: "Inbound",
      propertyType: "Unknown",
      budgetLabel: "Unknown",
      location: "Unknown",
      timeline: "Immediate",
    });
    await db.insert(callsTable).values({
      id: "call_null_relations",
      businessId: BIZ_A,
      contactId: "c_unknown",
      leadId: "l_unknown",
      agentId: null,
      direction: "inbound",
      callerNumber: "+19175550000",
      status: "in_progress",
      startedAt: new Date(),
      idempotencyKey: "k_null_rel",
    });

    const populatedRes = await request(app).get("/api/calls/active");
    expect(populatedRes.status).toBe(200);
    expect(populatedRes.body).toHaveLength(1);

    const call = populatedRes.body[0];
    expect(call.id).toBe("call_null_relations");
    expect(call.lead_name).toBeNull(); // Normalized cleanly from "Unknown caller"
    expect(call.agent_name).toBeNull(); // Cleanly null
    expect(call.caller_number).toBe("+19175550000");
    expect(call.direction).toBe("inbound");
  });

  // -------------------------------------------------------------------------
  // Test 9: Verify elapsed-time display and invalid timestamps
  // -------------------------------------------------------------------------
  it("Test 9: verifies parseElapsedSeconds and formatElapsed NaN guard", () => {
    // 1. Null / undefined / empty
    expect(parseElapsedSeconds(null)).toBeNull();
    expect(parseElapsedSeconds(undefined)).toBeNull();
    expect(parseElapsedSeconds("")).toBeNull();

    // 2. Malformed / invalid timestamps
    expect(parseElapsedSeconds("invalid-date-string")).toBeNull();
    expect(parseElapsedSeconds("NaN")).toBeNull();
    expect(parseElapsedSeconds("undefined")).toBeNull();

    // 3. NaN guard in formatElapsed
    expect(formatElapsed(NaN)).toBe("00:00");
    expect(formatElapsed(-100)).toBe("00:00");
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(5)).toBe("00:05");
    expect(formatElapsed(75)).toBe("01:15");
    expect(formatElapsed(3600)).toBe("60:00");

    // 4. Valid timestamp
    const past = new Date(Date.now() - 30_000).toISOString();
    const elapsed = parseElapsedSeconds(past);
    expect(elapsed).toBeGreaterThanOrEqual(29);
    expect(elapsed).toBeLessThanOrEqual(32);
  });

  // -------------------------------------------------------------------------
  // Test 10: Check server logs, error states and backpressure safety
  // -------------------------------------------------------------------------
  it("Test 10: backpressure safety drops unresponsive sockets without crashing server", async () => {
    const app = createTestApp({ auth: true, businessId: BIZ_A });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      const client = {
        id: "mock_slow_client",
        businessId: BIZ_A,
        userId: "u1",
        req: {} as any,
        res: {
          writableEnded: false,
          write: () => false, // Always returns false to simulate clogged socket buffer
          once: () => {},
          end: () => {
            client.res.writableEnded = true;
          },
        } as any,
        bufferedCount: 0,
      };

      (tenantEventBus as any).tenants.set(BIZ_A, new Map([[client.id, client]]));

      // Broadcast 60 messages to trigger MAX_BUFFERED_MESSAGES_BEFORE_DROP (50)
      for (let i = 0; i < 60; i++) {
        tenantEventBus.broadcast(BIZ_A, "call_update", { i });
      }

      // Assert slow client was safely disconnected without throwing unhandled exceptions
      expect(client.res.writableEnded).toBe(true);
      expect(tenantEventBus.getClientCount(BIZ_A)).toBe(0);
    } finally {
      server.close();
    }
  });
});
