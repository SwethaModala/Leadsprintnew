import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  businessesTable,
  membershipsTable,
  usageTable,
  usersTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import { __resetAuthDb, __setAuthDb, requireAuth } from "./auth";

let mockAuthUser: { userId: string | null; sessionClaims?: Record<string, unknown> } = {
  userId: null,
};

vi.mock("@clerk/express", () => ({
  getAuth: () => mockAuthUser,
}));

describe("requireAuth middleware", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
    __setAuthDb(db as any);
    mockAuthUser = { userId: null };
  });

  afterEach(() => {
    __resetAuthDb();
  });

  function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use(requireAuth);
    app.get("/api/test-session", (req, res) => {
      res.json({
        userId: req.leadSprintUserId,
        businessId: req.leadSprintBusinessId,
        role: req.leadSprintRole,
      });
    });
    return app;
  }

  it("returns 401 Authentication required when user is not authenticated", async () => {
    mockAuthUser = { userId: null };
    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("provisions business, user, owner membership and usage on first sign-in", async () => {
    const userId = "user_clerk_12345";
    mockAuthUser = {
      userId,
      sessionClaims: {
        email: "alice@example.com",
        name: "Alice Operator",
      },
    };

    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.businessId).toBe(`business_${userId}`);
    expect(res.body.role).toBe("owner");

    // Verify database rows created
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user).toBeDefined();
    expect(user?.email).toBe("alice@example.com");

    const [membership] = await db
      .select()
      .from(membershipsTable)
      .where(and(eq(membershipsTable.userId, userId), eq(membershipsTable.businessId, `business_${userId}`)));
    expect(membership).toBeDefined();
    expect(membership?.role).toBe("owner");

    const [usage] = await db.select().from(usageTable).where(eq(usageTable.businessId, `business_${userId}`));
    expect(usage).toBeDefined();
  });

  it("self-heals missing membership for existing user with businessId", async () => {
    const existingUserId = "user_legacy_555";
    const existingBusinessId = "biz_legacy_555";

    // Insert business and user without membership row (legacy state)
    await db.insert(businessesTable).values(pilotBusiness({ id: existingBusinessId }) as never);
    await db.insert(usersTable).values({
      id: existingUserId,
      businessId: existingBusinessId,
      name: "Legacy User",
      email: "legacy@example.com",
      role: "owner",
    });

    // Verify membership does not exist initially
    const [initialMembership] = await db
      .select()
      .from(membershipsTable)
      .where(and(eq(membershipsTable.userId, existingUserId), eq(membershipsTable.businessId, existingBusinessId)));
    expect(initialMembership).toBeUndefined();

    mockAuthUser = {
      userId: existingUserId,
      sessionClaims: { email: "legacy@example.com", name: "Legacy User" },
    };

    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(existingUserId);
    expect(res.body.businessId).toBe(existingBusinessId);
    expect(res.body.role).toBe("owner");

    // Verify self-healed membership row was created
    const [healedMembership] = await db
      .select()
      .from(membershipsTable)
      .where(and(eq(membershipsTable.userId, existingUserId), eq(membershipsTable.businessId, existingBusinessId)));
    expect(healedMembership).toBeDefined();
    expect(healedMembership?.role).toBe("owner");
  });

  it("fails safely and does NOT grant owner membership for non-owner user without membership", async () => {
    const memberUserId = "user_member_777";
    const bizId = "biz_member_777";

    await db.insert(businessesTable).values(pilotBusiness({ id: bizId }) as never);
    await db.insert(usersTable).values({
      id: memberUserId,
      businessId: bizId,
      name: "Standard Member",
      email: "member@example.com",
      role: "member",
    });

    mockAuthUser = {
      userId: memberUserId,
      sessionClaims: { email: "member@example.com", name: "Standard Member" },
    };

    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Organization membership could not be verified");

    // Verify NO membership row was created
    const [membership] = await db
      .select()
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, memberUserId));
    expect(membership).toBeUndefined();
  });

  it("fails safely when user's businessId does not exist in businessesTable", async () => {
    const orphanUserId = "user_orphan_888";
    const nonExistentBizId = "biz_does_not_exist";

    // Temporarily disable FK checks to simulate orphaned user record
    await db.execute(sql`SET session_replication_role = 'replica'`);
    await db.insert(usersTable).values({
      id: orphanUserId,
      businessId: nonExistentBizId,
      name: "Orphan User",
      email: "orphan@example.com",
      role: "owner",
    });
    await db.execute(sql`SET session_replication_role = 'origin'`);

    mockAuthUser = {
      userId: orphanUserId,
      sessionClaims: { email: "orphan@example.com", name: "Orphan User" },
    };

    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Organization does not exist");
  });

  it("prevents cross-tenant takeover when user claims a business with an existing owner", async () => {
    const originalOwnerId = "user_real_owner";
    const attackerUserId = "user_attacker";
    const targetBizId = "biz_victim_company";

    // Legitimate business and owner with existing membership
    await db.insert(businessesTable).values(pilotBusiness({ id: targetBizId }) as never);
    await db.insert(usersTable).values({
      id: originalOwnerId,
      businessId: targetBizId,
      name: "Real Owner",
      email: "owner@victim.com",
      role: "owner",
    });
    await db.insert(membershipsTable).values({
      id: `mem_${originalOwnerId}_${targetBizId}`,
      userId: originalOwnerId,
      businessId: targetBizId,
      role: "owner",
    });

    // Attacker user has legacy role 'owner' pointing to targetBizId, but no membership
    await db.insert(usersTable).values({
      id: attackerUserId,
      businessId: targetBizId,
      name: "Malicious User",
      email: "attacker@external.com",
      role: "owner",
    });

    mockAuthUser = {
      userId: attackerUserId,
      sessionClaims: { email: "attacker@external.com", name: "Malicious User" },
    };

    const app = buildApp();
    const res = await request(app).get("/api/test-session");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Organization membership could not be verified");

    // Attacker must NOT have gained membership
    const [attackerMembership] = await db
      .select()
      .from(membershipsTable)
      .where(and(eq(membershipsTable.userId, attackerUserId), eq(membershipsTable.businessId, targetBizId)));
    expect(attackerMembership).toBeUndefined();
  });
});
