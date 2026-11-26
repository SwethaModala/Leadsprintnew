import http from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentsTable,
  businessesTable,
  callsTable,
  contactsTable,
  leadsTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import leadsprintRouter, {
  __resetLeadsprintDb,
  __setLeadsprintDb,
} from "./leadsprint";
import eventsRouter from "./events";
import { tenantEventBus } from "../lib/eventBus";

const BIZ_A = "biz_events_a";
const BIZ_B = "biz_events_b";

describe("Phase 4A: Events & Active Calls Routes", () => {
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

  function buildApp(options: { auth?: boolean; businessId?: string; role?: string } = {}): Express {
    const app = express();
    app.use(express.json());
    if (options.auth !== false) {
      app.use((req, _res, next) => {
        req.leadSprintUserId = "user_test";
        req.leadSprintBusinessId = options.businessId ?? BIZ_A;
        req.leadSprintRole = (options.role as any) ?? "owner";
        next();
      });
    }
    app.use("/api", eventsRouter);
    app.use("/api", leadsprintRouter);
    return app;
  }

  describe("GET /api/events/live", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const app = buildApp({ auth: false });
      const res = await request(app).get("/api/events/live");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Authentication required" });
    });

    it("registers client and returns SSE stream for authenticated operator", async () => {
      const app = buildApp({ auth: true, businessId: BIZ_A });
      const server = http.createServer(app);

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

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
          if ((err as any).code === "ECONNRESET") {
            resolve();
          } else {
            reject(err);
          }
        });
      });

      server.close();
      expect(received).toContain("event: connected");
      expect(received).toContain(BIZ_A);
    });
  });

  describe("GET /api/calls/active", () => {
    it("returns only queued and in_progress calls for the tenant", async () => {
      // Seed contacts and leads for BIZ_A
      await db.insert(contactsTable).values({
        id: "c_1",
        businessId: BIZ_A,
        name: "Alice Active",
        phone: "+12125550101",
        timezone: "America/New_York",
      });
      await db.insert(leadsTable).values({
        id: "l_1",
        businessId: BIZ_A,
        contactId: "c_1",
        source: "Website",
        campaign: "Pilot",
        project: "Skyline",
        propertyType: "Condo",
        budgetLabel: "$500k - $1M",
        location: "Manhattan",
        timeline: "0-3 months",
      });

      // Seed an agent
      await db.insert(agentsTable).values({
        id: "agt_1",
        businessId: BIZ_A,
        name: "Samantha Sales",
        publishedVersion: 1,
        status: "active",
      });

      // Insert calls with varying statuses for BIZ_A
      await db.insert(callsTable).values({
        id: "call_active_1",
        businessId: BIZ_A,
        contactId: "c_1",
        leadId: "l_1",
        agentId: "agt_1",
        direction: "outbound",
        status: "in_progress",
        startedAt: new Date(Date.now() - 30_000), // 30s ago
        idempotencyKey: "k_1",
      });

      await db.insert(callsTable).values({
        id: "call_queued_1",
        businessId: BIZ_A,
        contactId: "c_1",
        leadId: "l_1",
        direction: "outbound",
        status: "queued",
        idempotencyKey: "k_2",
      });

      await db.insert(callsTable).values({
        id: "call_completed_1",
        businessId: BIZ_A,
        contactId: "c_1",
        leadId: "l_1",
        status: "completed",
        idempotencyKey: "k_3",
      });

      await db.insert(callsTable).values({
        id: "call_blocked_1",
        businessId: BIZ_A,
        contactId: "c_1",
        leadId: "l_1",
        status: "policy_blocked",
        idempotencyKey: "k_4",
      });

      // Insert call for BIZ_B (cross-tenant)
      await db.insert(contactsTable).values({
        id: "c_b",
        businessId: BIZ_B,
        name: "Bob Other",
        phone: "+12125550202",
        timezone: "America/New_York",
      });
      await db.insert(leadsTable).values({
        id: "l_b",
        businessId: BIZ_B,
        contactId: "c_b",
        source: "Website",
        campaign: "Pilot",
        project: "Other",
        propertyType: "Condo",
        budgetLabel: "$500k - $1M",
        location: "Brooklyn",
        timeline: "0-3 months",
      });
      await db.insert(callsTable).values({
        id: "call_other_tenant",
        businessId: BIZ_B,
        contactId: "c_b",
        leadId: "l_b",
        status: "in_progress",
        idempotencyKey: "k_5",
      });

      const app = buildApp({ auth: true, businessId: BIZ_A });
      const res = await request(app).get("/api/calls/active");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      const ids = res.body.map((c: any) => c.id);
      expect(ids).toContain("call_active_1");
      expect(ids).toContain("call_queued_1");
      expect(ids).not.toContain("call_completed_1");
      expect(ids).not.toContain("call_blocked_1");
      expect(ids).not.toContain("call_other_tenant"); // Strict tenant isolation

      const activeCall = res.body.find((c: any) => c.id === "call_active_1");
      expect(activeCall.agent_name).toBe("Samantha Sales");
      expect(activeCall.lead_name).toBe("Alice Active");
      expect(activeCall.status).toBe("in_progress");
      expect(activeCall.direction).toBe("outbound");
    });

    it("handles inbound calls without matching CRM leads with null lead properties", async () => {
      // Inbound contact with placeholder/unknown name
      await db.insert(contactsTable).values({
        id: "c_anon",
        businessId: BIZ_A,
        name: "Unknown caller",
        phone: "+19175559999",
        timezone: "America/New_York",
      });
      await db.insert(leadsTable).values({
        id: "l_anon",
        businessId: BIZ_A,
        contactId: "c_anon",
        source: "inbound",
        campaign: "Inbound call",
        project: "Inbound",
        propertyType: "Unknown",
        budgetLabel: "Unknown",
        location: "Unknown",
        timeline: "Immediate",
      });
      await db.insert(callsTable).values({
        id: "call_inbound_unknown",
        businessId: BIZ_A,
        contactId: "c_anon",
        leadId: "l_anon",
        direction: "inbound",
        callerNumber: "+19175559999",
        status: "in_progress",
        startedAt: new Date(),
        idempotencyKey: "k_inbound",
      });

      const app = buildApp({ auth: true, businessId: BIZ_A });
      const res = await request(app).get("/api/calls/active");

      expect(res.status).toBe(200);
      const inboundCall = res.body.find((c: any) => c.id === "call_inbound_unknown");
      expect(inboundCall).toBeDefined();
      expect(inboundCall.direction).toBe("inbound");
      expect(inboundCall.caller_number).toBe("+19175559999");
      expect(inboundCall.lead_name).toBeNull(); // Cleanly null
      expect(inboundCall.agent_name).toBeNull();
    });

    it("strictly isolates contact and agent details using explicit businessId conditions", async () => {
      // Seed contact and lead under BIZ_A
      await db.insert(contactsTable).values({
        id: "c_biz_a",
        businessId: BIZ_A,
        name: "Tenant A Contact",
        phone: "+12125550101",
        timezone: "America/New_York",
      });
      await db.insert(leadsTable).values({
        id: "l_biz_a",
        businessId: BIZ_A,
        contactId: "c_biz_a",
        source: "Website",
        campaign: "Pilot",
        project: "Skyline",
        propertyType: "Condo",
        budgetLabel: "$500k",
        location: "Manhattan",
        timeline: "Immediate",
      });

      // Seed contact and agent under BIZ_B (different tenant)
      await db.insert(contactsTable).values({
        id: "c_biz_b",
        businessId: BIZ_B,
        name: "Foreign Tenant Contact",
        phone: "+12125557777",
        timezone: "America/New_York",
      });
      await db.insert(agentsTable).values({
        id: "agt_biz_b",
        businessId: BIZ_B,
        name: "Foreign Tenant Agent",
        publishedVersion: 1,
        status: "active",
      });

      // Insert call for BIZ_A that references BIZ_B's contact and agent IDs
      await db.insert(callsTable).values({
        id: "call_cross_ref",
        businessId: BIZ_A,
        contactId: "c_biz_b",
        leadId: "l_biz_a",
        agentId: "agt_biz_b",
        direction: "outbound",
        status: "in_progress",
        startedAt: new Date(),
        idempotencyKey: "k_cross_ref",
      });

      const app = buildApp({ auth: true, businessId: BIZ_A });
      const res = await request(app).get("/api/calls/active");

      expect(res.status).toBe(200);
      const call = res.body.find((c: any) => c.id === "call_cross_ref");
      expect(call).toBeDefined();
      // Should NOT resolve BIZ_B's contact name or agent name due to explicit businessId condition
      expect(call.lead_name).toBeNull();
      expect(call.agent_name).toBeNull();
    });
  });
});
