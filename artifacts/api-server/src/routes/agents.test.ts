import request from "supertest";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentsTable,
  agentVersionsTable,
  businessesTable,
  phoneNumbersTable,
  usersTable,
} from "@workspace/db";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import agentsRouter, { __resetAgentsDb, __setAgentsDb, getTenantRetellKey } from "./agents";
import * as retellService from "../lib/retellAgentService";
import { upsertTenantProviderCredential } from "../lib/security";

const BIZ_A = "biz_agents_alpha";
const BIZ_B = "biz_agents_beta";
const USER_A_ADMIN = "user_alpha_admin";
const USER_A_MEMBER = "user_alpha_member";
const USER_B_ADMIN = "user_beta_admin";

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
  app.use("/api", agentsRouter);
  return app;
}

beforeEach(async () => {
  process.env["RETELL_API_KEY"] = "key_test_agents";
  process.env["APP_ENCRYPTION_KEY"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  db = await createTestDb();
  __setAgentsDb(db as never);

  // Seed businesses
  await db.insert(businessesTable).values([
    pilotBusiness({ id: BIZ_A, name: "Alpha Real Estate" }),
    pilotBusiness({ id: BIZ_B, name: "Beta Properties" }),
  ]);

  // Seed users
  await db.insert(usersTable).values([
    { id: USER_A_ADMIN, businessId: BIZ_A, email: "admin@alpha.com", name: "Alpha Admin" },
    { id: USER_A_MEMBER, businessId: BIZ_A, email: "member@alpha.com", name: "Alpha Member" },
    { id: USER_B_ADMIN, businessId: BIZ_B, email: "admin@beta.com", name: "Beta Admin" },
  ]);
});

afterEach(() => {
  __resetAgentsDb();
  vi.restoreAllMocks();
  delete process.env["RETELL_API_KEY"];
  delete process.env["APP_ENCRYPTION_KEY"];
});

describe("Phase 3 Agents API", () => {
  describe("Agent CRUD & Tenant Isolation", () => {
    it("creates a draft agent and returns agent detail", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({
          name: "Sara Realtor",
          use_case: "real_estate",
          greeting_message: "Hi, thanks for reaching out!",
          system_prompt: "You are a real estate qualifier.",
          voice_id: "11labs-Adrian",
          language: "en-US",
          temperature: 0.7,
        });

      expect(res.status).toBe(201);
      expect(res.body.agent).toMatchObject({
        name: "Sara Realtor",
        use_case: "real_estate",
        status: "draft",
        greeting_message: "Hi, thanks for reaching out!",
        system_prompt: "You are a real estate qualifier.",
        voice_id: "11labs-Adrian",
        language: "en-US",
      });
      expect(res.body.agent.id).toBeDefined();
    });

    it("rejects creation when required fields are missing", async () => {
      const app = buildApp();
      const res = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("required");
    });

    it("enforces RBAC: members cannot create or delete agents", async () => {
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_MEMBER)
        .set("x-test-role", "member")
        .send({ name: "Rogue Agent", use_case: "general" });

      expect(createRes.status).toBe(403);

      const deleteRes = await request(app)
        .delete("/api/agents/agt_nonexistent")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_MEMBER)
        .set("x-test-role", "member");

      expect(deleteRes.status).toBe(403);
    });

    it("retrieves, updates, and deletes an agent", async () => {
      const app = buildApp();

      // Create
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Alex Lead Qualifier", use_case: "real_estate" });
      const agentId = created.body.agent.id;

      // Get
      const getRes = await request(app)
        .get(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_MEMBER)
        .set("x-test-role", "member");
      expect(getRes.status).toBe(200);
      expect(getRes.body.agent.name).toBe("Alex Lead Qualifier");

      // Patch
      const patchRes = await request(app)
        .patch(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Alex Senior Qualifier", status: "paused" });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.agent.name).toBe("Alex Senior Qualifier");
      expect(patchRes.body.agent.status).toBe("paused");

      // Delete
      const delRes = await request(app)
        .delete(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");
      expect(delRes.status).toBe(200);
      expect(delRes.body.deleted_id).toBe(agentId);

      // Verify deletion
      const getAfter = await request(app)
        .get(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");
      expect(getAfter.status).toBe(404);
    });

    it("prevents cross-tenant access to agents", async () => {
      const app = buildApp();

      // Create agent in Tenant A
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Alpha Exclusive Agent", use_case: "real_estate" });
      const agentId = created.body.agent.id;

      // Tenant B tries to get it -> 404
      const getRes = await request(app)
        .get(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin");
      expect(getRes.status).toBe(404);

      // Tenant B tries to patch it -> 404
      const patchRes = await request(app)
        .patch(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Hacked Name" });
      expect(patchRes.status).toBe(404);

      // Tenant B tries to delete it -> 404
      const delRes = await request(app)
        .delete(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin");
      expect(delRes.status).toBe(404);

      // Tenant B lists agents -> does not see Alpha's agent
      const listRes = await request(app)
        .get("/api/agents")
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin");
      expect(listRes.status).toBe(200);
      expect(listRes.body.agents).toHaveLength(0);
    });
  });

  describe("Agent Publishing and Versions", () => {
    it("publishes an agent and tracks version history", async () => {
      const app = buildApp();

      // Create
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({
          name: "Publishable Agent",
          use_case: "real_estate",
          system_prompt: "Version 1 prompt",
          greeting_message: "Version 1 greeting",
          voice_id: "11labs-Adrian",
        });
      const agentId = created.body.agent.id;

      // Publish
      const pubRes = await request(app)
        .post(`/api/agents/${agentId}/publish`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");
      expect(pubRes.status).toBe(200);
      expect(pubRes.body.version_number).toBe(1);

      // Verify agent is now active
      const getRes = await request(app)
        .get(`/api/agents/${agentId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");
      expect(getRes.body.agent.status).toBe("active");

      // Verify versions list
      const versionsRes = await request(app)
        .get(`/api/agents/${agentId}/versions`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");
      expect(versionsRes.status).toBe(200);
      expect(versionsRes.body.versions).toHaveLength(1);
      expect(versionsRes.body.versions[0].version_number).toBe(1);

      // Cross-tenant check on versions
      const tenantBVersions = await request(app)
        .get(`/api/agents/${agentId}/versions`)
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin");
      expect(tenantBVersions.status).toBe(404);
    });
  });

  describe("Retell Integration & Web Calls", () => {
    it("links a Retell agent ID to a local agent", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Unlinked Agent", use_case: "real_estate" });
      const agentId = created.body.agent.id;

      const linkRes = await request(app)
        .post(`/api/agents/${agentId}/retell-link`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ retell_agent_id: "agent_retell_123", retell_llm_id: "llm_retell_456" });

      expect(linkRes.status).toBe(200);
      expect(linkRes.body.agent.retell_agent_id).toBe("agent_retell_123");
      expect(linkRes.body.agent.retell_llm_id).toBe("llm_retell_456");
    });

    it("rejects web-call sandbox test if agent is not linked", async () => {
      const app = buildApp();
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Unlinked Agent", use_case: "real_estate" });
      const agentId = created.body.agent.id;

      const testCallRes = await request(app)
        .post(`/api/agents/${agentId}/test-web-call`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");

      expect(testCallRes.status).toBe(409);
      expect(testCallRes.body.error).toContain("not linked");
    });

    it("creates a web-call sandbox test when linked", async () => {
      vi.spyOn(retellService, "createRetellWebCall").mockResolvedValueOnce({
        access_token: "jwt_token_sample",
        call_id: "call_web_sample",
      });

      const app = buildApp();
      const created = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Linked Agent", use_case: "real_estate" });
      const agentId = created.body.agent.id;

      await request(app)
        .post(`/api/agents/${agentId}/retell-link`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ retell_agent_id: "agent_retell_123" });

      const testCallRes = await request(app)
        .post(`/api/agents/${agentId}/test-web-call`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");

      expect(testCallRes.status).toBe(200);
      expect(testCallRes.body.access_token).toBe("jwt_token_sample");
      expect(testCallRes.body.call_id).toBe("call_web_sample");
    });

    it("lists Retell voices", async () => {
      vi.spyOn(retellService, "listRetellVoices").mockResolvedValueOnce([
        { voice_id: "11labs-Adrian", voice_name: "Adrian", provider: "elevenlabs" },
        { voice_id: "deepgram-Asteria", voice_name: "Asteria", provider: "deepgram" },
      ]);

      const app = buildApp();
      const res = await request(app)
        .get("/api/agents/retell/voices")
        .set("x-test-business-id", BIZ_A);

      expect(res.status).toBe(200);
      expect(res.body.voices).toHaveLength(2);
      expect(res.body.voices[0].voice_name).toBe("Adrian");
    });
  });

  describe("Phone Numbers Management", () => {
    it("syncs phone numbers from Retell and binds to an agent", async () => {
      vi.spyOn(retellService, "listRetellPhoneNumbers").mockResolvedValueOnce([
        {
          phone_number: "+14155552671",
          nickname: "Main Inbound Line",
          area_code: 415,
        },
      ]);
      const updateBindingSpy = vi.spyOn(retellService, "updateRetellPhoneNumberBinding").mockResolvedValueOnce();

      const app = buildApp();

      // Sync
      const syncRes = await request(app)
        .post("/api/phone-numbers/sync")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin");

      expect(syncRes.status).toBe(200);
      expect(syncRes.body.synced).toBe(1);
      expect(syncRes.body.phone_numbers[0].e164_number).toBe("+14155552671");
      const phoneId = syncRes.body.phone_numbers[0].id;

      // Create an agent to bind to
      const agentRes = await request(app)
        .post("/api/agents")
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ name: "Inbound Receptionist", use_case: "real_estate" });
      const agentId = agentRes.body.agent.id;

      // Link Retell ID to agent
      await request(app)
        .post(`/api/agents/${agentId}/retell-link`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({ retell_agent_id: "agent_retell_inbound" });

      // Patch phone number binding
      const patchPhone = await request(app)
        .patch(`/api/phone-numbers/${phoneId}`)
        .set("x-test-business-id", BIZ_A)
        .set("x-test-user-id", USER_A_ADMIN)
        .set("x-test-role", "admin")
        .send({
          nickname: "Updated Front Desk",
          inbound_agent_id: agentId,
        });

      expect(patchPhone.status).toBe(200);
      expect(patchPhone.body.phone_number.nickname).toBe("Updated Front Desk");
      expect(patchPhone.body.phone_number.inbound_agent_id).toBe(agentId);
      expect(updateBindingSpy).toHaveBeenCalledWith(
        "+14155552671",
        { inbound_agent_id: "agent_retell_inbound" },
        "key_test_agents",
      );

      // Verify list
      const listPhone = await request(app)
        .get("/api/phone-numbers")
        .set("x-test-business-id", BIZ_A);
      expect(listPhone.status).toBe(200);
      expect(listPhone.body.phone_numbers).toHaveLength(1);
    });

    it("prevents cross-tenant modification of phone numbers", async () => {
      const app = buildApp();
      // Insert phone number for Tenant A
      const [inserted] = await db
        .insert(phoneNumbersTable)
        .values({
          id: "pn_alpha_1",
          businessId: BIZ_A,
          e164Number: "+12125550199",
          nickname: "Alpha Line",
          status: "active",
        })
        .returning();

      // Tenant B tries to patch it -> 404
      const res = await request(app)
        .patch(`/api/phone-numbers/${inserted!.id}`)
        .set("x-test-business-id", BIZ_B)
        .set("x-test-user-id", USER_B_ADMIN)
        .set("x-test-role", "admin")
        .send({ nickname: "Hijacked" });

      expect(res.status).toBe(404);
    });
  });

  describe("Retell Credential Resolution & Fallback Isolation", () => {
    it("falls back to global RETELL_API_KEY for pilot tenant without stored credentials", async () => {
      const resolved = await getTenantRetellKey(BIZ_A);
      expect(resolved).toBe("key_test_agents");
    });

    it("strictly uses tenant-specific encrypted credential when configured and does not leak to other tenants", async () => {
      // Configure tenant A with dedicated Retell credentials
      await upsertTenantProviderCredential(db as never, {
        businessId: BIZ_A,
        userId: USER_A_ADMIN,
        provider: "retell",
        config: { api_key: "key_custom_tenant_alpha" },
      });

      const keyA = await getTenantRetellKey(BIZ_A);
      expect(keyA).toBe("key_custom_tenant_alpha");

      // Tenant B has no stored credentials -> still gets pilot/global key, NOT tenant A's key
      const keyB = await getTenantRetellKey(BIZ_B);
      expect(keyB).toBe("key_test_agents");
    });

    it("fails closed without fallback when tenant credential exists but has no api_key", async () => {
      await upsertTenantProviderCredential(db as never, {
        businessId: BIZ_A,
        userId: USER_A_ADMIN,
        provider: "retell",
        config: { agent_id: "agent_alpha_only" },
      });

      const keyA = await getTenantRetellKey(BIZ_A);
      // Must NOT fall back to global RETELL_API_KEY
      expect(keyA).toBeUndefined();
    });
  });
});
