import request from "supertest";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentsTable,
  businessesTable,
  usersTable,
} from "@workspace/db";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import leadsprintRouter, { __resetLeadsprintDb, __setLeadsprintDb } from "./leadsprint";
import { upsertTenantProviderCredential } from "../lib/security";

const BIZ_A = "biz_connected_alpha";
const BIZ_B = "biz_connected_beta";
const USER_A_ADMIN = "user_alpha_admin";

let db: TestDb;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user-id");
    const businessId = req.get("x-test-business-id");
    const role = req.get("x-test-role");
    if (userId) req.leadSprintUserId = userId;
    if (businessId) req.leadSprintBusinessId = businessId;
    if (role) req.leadSprintRole = role as never;
    next();
  });
  app.use("/api", leadsprintRouter);
  return app;
}

beforeEach(async () => {
  process.env["APP_ENCRYPTION_KEY"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env["RETELL_API_KEY"] = "retell_global_key";
  process.env["RETELL_AGENT_ID"] = "agent_global_id";
  process.env["CALCOM_API_KEY"] = "calcom_global_key";
  process.env["CALCOM_EVENT_TYPE_ID"] = "event_global_123";

  db = await createTestDb();
  __setLeadsprintDb(db as never);

  await db.insert(businessesTable).values([
    pilotBusiness({ id: BIZ_A, name: "Alpha Real Estate", retellAgentId: null, calEventTypeId: null }),
    pilotBusiness({ id: BIZ_B, name: "Beta Properties", retellAgentId: null, calEventTypeId: null }),
  ]);

  await db.insert(usersTable).values([
    { id: USER_A_ADMIN, businessId: BIZ_A, email: "admin@alpha.com", name: "Alpha Admin" },
  ]);
});

afterEach(() => {
  __resetLeadsprintDb();
  delete process.env["APP_ENCRYPTION_KEY"];
  delete process.env["RETELL_API_KEY"];
  delete process.env["RETELL_AGENT_ID"];
  delete process.env["CALCOM_API_KEY"];
  delete process.env["CALCOM_EVENT_TYPE_ID"];
});

describe("Connected Services Resolution", () => {
  it("resolves active linked agent from agentsTable for business-settings and checklist", async () => {
    const app = buildApp();

    // Initially, no agent in agentsTable and business.retellAgentId is null
    const res1 = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res1.status).toBe(200);
    expect(res1.body.retell_agent_id).toBeNull();

    // Insert an active linked agent in agentsTable for BIZ_A
    await db.insert(agentsTable).values({
      id: "agent_local_1",
      businessId: BIZ_A,
      name: "Alpha Sales Bot",
      useCase: "real_estate",
      status: "active",
      retellAgentId: "agent_retell_custom_999",
    });

    const res2 = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res2.status).toBe(200);
    expect(res2.body.retell_agent_id).toBe("agent_retell_custom_999");

    // Also check onboarding checklist reflects this as complete
    const checkRes = await request(app)
      .get("/api/onboarding/checklist")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(checkRes.status).toBe(200);
    const retellItem = checkRes.body.items.find((i: any) => i.key === "retell_agent");
    expect(retellItem?.complete).toBe(true);
  });

  it("strictly enforces tenant credential isolation for Cal.com event type", async () => {
    const app = buildApp();

    // 1. Without tenant-specific credentials, falls back to global CALCOM_EVENT_TYPE_ID
    const res1 = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res1.body.cal_event_type_id).toBe("event_global_123");

    // 2. Configure tenant A with own credentials but MISSING event_type_id -> must fail closed (return null, never fallback!)
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: USER_A_ADMIN,
      provider: "calcom",
      config: { api_key: "cal_tenant_alpha_key" },
    });

    const res2 = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res2.body.cal_event_type_id).toBeNull();

    // 3. Configure tenant A with valid event_type_id
    await upsertTenantProviderCredential(db as never, {
      businessId: BIZ_A,
      userId: USER_A_ADMIN,
      provider: "calcom",
      config: { api_key: "cal_tenant_alpha_key", event_type_id: "event_tenant_alpha_456" },
    });

    const res3 = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_A)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res3.body.cal_event_type_id).toBe("event_tenant_alpha_456");

    // Tenant B must not see Tenant A's event type
    const resB = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_B)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(resB.body.cal_event_type_id).toBe("event_global_123");
  });

  it("preserves valid seeded business.calEventTypeId when no tenant credential record exists and global CALCOM_API_KEY is unset", async () => {
    delete process.env["CALCOM_API_KEY"];
    delete process.env["CALCOM_EVENT_TYPE_ID"];

    // Update BIZ_B with seeded calEventTypeId
    await db
      .update(businessesTable)
      .set({ calEventTypeId: "event_seeded_frostline_999" })
      .where(eq(businessesTable.id, BIZ_B));

    const app = buildApp();
    const res = await request(app)
      .get("/api/business-settings")
      .set("x-test-business-id", BIZ_B)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    expect(res.body.cal_event_type_id).toBe("event_seeded_frostline_999");

    const checkRes = await request(app)
      .get("/api/onboarding/checklist")
      .set("x-test-business-id", BIZ_B)
      .set("x-test-user-id", USER_A_ADMIN)
      .set("x-test-role", "admin");

    const calItem = checkRes.body.items.find((i: any) => i.key === "calendar_event_type");
    expect(calItem?.complete).toBe(true);
  });
});
