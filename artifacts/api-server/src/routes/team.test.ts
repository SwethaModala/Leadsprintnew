import crypto from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLogsTable,
  businessesTable,
  invitationsTable,
  leadsTable,
  membershipsTable,
  usersTable,
} from "@workspace/db/schema";
import { createTestDb, pilotBusiness, type TestDb } from "../test/testDb";
import leadsprintRouter, {
  __resetLeadsprintDb,
  __setLeadsprintDb,
} from "./leadsprint";
import teamRouter, { __resetTeamDb, __setTeamDb } from "./team";
import {
  __resetTeamEmailSender,
  __setTeamEmailSender,
  removeTeamMember,
  updateTeamMemberRole,
} from "../lib/team";
import { resolveActiveOrganization } from "../lib/orgContext";

let db: TestDb;
let sentEmails: Array<{ to: string; acceptUrl: string; role: string }> = [];

function extractTokenFromAcceptUrl(acceptUrl: string): string {
  const idx = acceptUrl.indexOf("#token=");
  if (idx === -1) return "";
  return decodeURIComponent(acceptUrl.slice(idx + "#token=".length));
}

/**
 * Simulates the authenticated session middleware after Clerk verifies identity:
 * reads `x-test-user-id` and runs real `resolveActiveOrganization()` against DB
 * (which validates `X-Business-Id` and signed `ls_active_business` cookies).
 */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    const userId = req.get("x-test-user-id");
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const [user] = await db
      .select({ id: usersTable.id, businessId: usersTable.businessId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!user) {
      res.status(401).json({ error: "User not provisioned" });
      return;
    }
    const resolved = await resolveActiveOrganization(
      db as never,
      user.id,
      user.businessId,
      req,
      res,
    );
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    req.leadSprintUserId = user.id;
    req.leadSprintBusinessId = resolved.businessId;
    req.leadSprintRole = resolved.role;
    next();
  });
  app.use("/api", teamRouter);
  app.use("/api", leadsprintRouter);
  return app;
}

async function seedTenant(opts: {
  businessId: string;
  businessName: string;
  ownerId: string;
  ownerEmail: string;
  ownerName: string;
}) {
  await db.insert(businessesTable).values(
    pilotBusiness({ id: opts.businessId, name: opts.businessName }) as never,
  );
  await db.insert(usersTable).values({
    id: opts.ownerId,
    businessId: opts.businessId,
    name: opts.ownerName,
    email: opts.ownerEmail,
    role: "owner",
  });
  await db.insert(membershipsTable).values({
    id: `mem_${opts.ownerId}_${opts.businessId}`,
    userId: opts.ownerId,
    businessId: opts.businessId,
    role: "owner",
  });
}

async function seedUserWithPersonalWorkspace(opts: {
  userId: string;
  email: string;
  name: string;
}) {
  const businessId = `biz_personal_${opts.userId}`;
  await seedTenant({
    businessId,
    businessName: `${opts.name} Workspace`,
    ownerId: opts.userId,
    ownerEmail: opts.email,
    ownerName: opts.name,
  });
  return businessId;
}

beforeEach(async () => {
  db = await createTestDb();
  __setLeadsprintDb(db as never);
  __setTeamDb(db as never);
  sentEmails = [];
  __setTeamEmailSender(async (input) => {
    sentEmails.push({
      to: input.to,
      acceptUrl: input.acceptUrl,
      role: input.role,
    });
    return true;
  });
});

afterEach(() => {
  __resetLeadsprintDb();
  __resetTeamDb();
  __resetTeamEmailSender();
});

describe("Phase 1 Multi-Org, RBAC & Invitation Security", () => {
  it("prevents unauthorized X-Business-Id switching and forged cookies across tenants", async () => {
    await seedTenant({
      businessId: "biz_a",
      businessName: "Org Alpha",
      ownerId: "user_a",
      ownerEmail: "alice@alpha.example",
      ownerName: "Alice",
    });
    await seedTenant({
      businessId: "biz_b",
      businessName: "Org Beta",
      ownerId: "user_b",
      ownerEmail: "bob@beta.example",
      ownerName: "Bob",
    });

    const app = buildApp();

    // Cross-tenant header must fail closed with 403.
    const spoofedHeader = await request(app)
      .get("/api/team")
      .set("x-test-user-id", "user_a")
      .set("x-business-id", "biz_b");
    expect(spoofedHeader.status).toBe(403);

    // POST /orgs/switch for non-member business must fail closed with 403.
    const badSwitch = await request(app)
      .post("/api/orgs/switch")
      .set("x-test-user-id", "user_a")
      .send({ business_id: "biz_b" });
    expect(badSwitch.status).toBe(403);

    // Forged active-org cookie must fail closed with 403.
    const forgedCookie = await request(app)
      .get("/api/team")
      .set("x-test-user-id", "user_a")
      .set("Cookie", "ls_active_business=biz_b.forgedsig123");
    expect(forgedCookie.status).toBe(403);
  });

  it("supports creating a second organization and switching between authorized workspaces", async () => {
    await seedTenant({
      businessId: "biz_a",
      businessName: "Org Alpha",
      ownerId: "user_a",
      ownerEmail: "alice@alpha.example",
      ownerName: "Alice",
    });
    const app = buildApp();

    const created = await request(app)
      .post("/api/orgs")
      .set("x-test-user-id", "user_a")
      .send({ name: "Org Second", vertical: "home_services", market: "IN" });
    expect(created.status).toBe(201);
    const secondId = created.body.active_business_id as string;
    expect(created.body.organization).toMatchObject({
      name: "Org Second",
      vertical: "home_services",
      role: "owner",
    });

    const cookieHeader = created.headers["set-cookie"];
    expect(cookieHeader).toBeDefined();

    // Switching back to biz_a works cleanly and updates active context.
    const switched = await request(app)
      .post("/api/orgs/switch")
      .set("x-test-user-id", "user_a")
      .send({ business_id: "biz_a" });
    expect(switched.status).toBe(200);
    expect(switched.body.active_business_id).toBe("biz_a");

    const backCookies = switched.headers["set-cookie"];
    const teamA = await request(app)
      .get("/api/team")
      .set("x-test-user-id", "user_a")
      .set("Cookie", backCookies!);
    expect(teamA.status).toBe(200);
    expect(teamA.body.organization.id).toBe("biz_a");

    const orgList = await request(app)
      .get("/api/orgs")
      .set("x-test-user-id", "user_a")
      .set("x-business-id", secondId);
    expect(orgList.status).toBe(200);
    expect(orgList.body.organizations).toHaveLength(2);
    expect(orgList.body.active_business_id).toBe(secondId);
  });

  it("hashes invitation tokens, checks email match, prevents replay/revoked/expired tokens, and rate-limits invites", async () => {
    await seedTenant({
      businessId: "biz_a",
      businessName: "Org Alpha",
      ownerId: "user_owner",
      ownerEmail: "owner@alpha.example",
      ownerName: "Owner",
    });
    await seedUserWithPersonalWorkspace({
      userId: "user_invitee",
      email: "invitee@alpha.example",
      name: "Invitee User",
    });
    await seedUserWithPersonalWorkspace({
      userId: "user_wrong",
      email: "wrong@other.example",
      name: "Wrong User",
    });

    const app = buildApp();

    // 1. Invite member: raw token must NOT be returned in HTTP response or stored plaintext in DB.
    const inviteRes = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_owner")
      .send({ email: "Invitee@Alpha.Example", role: "manager" });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.delivery_status).toBe("sent");
    expect(sentEmails).toHaveLength(1);
    const rawToken = extractTokenFromAcceptUrl(sentEmails[0]!.acceptUrl);
    expect(rawToken.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(inviteRes.body)).not.toContain(rawToken);

    const [storedInv] = await db
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.id, inviteRes.body.invitation.id));
    expect(storedInv?.tokenHash).toBe(
      crypto.createHash("sha256").update(rawToken).digest("hex"),
    );
    expect(storedInv?.tokenHash).not.toBe(rawToken);

    // 2. Wrong email user cannot accept the invitation.
    const wrongEmailRes = await request(app)
      .post("/api/team/invitations/accept")
      .set("x-test-user-id", "user_wrong")
      .send({ token: rawToken });
    expect(wrongEmailRes.status).toBe(403);

    // 3. Correct email user accepts invitation and joins as manager.
    const acceptRes = await request(app)
      .post("/api/team/invitations/accept")
      .set("x-test-user-id", "user_invitee")
      .send({ token: rawToken });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.membership).toMatchObject({
      business_id: "biz_a",
      role: "manager",
    });

    // 4. Replaying the same token fails cleanly with 409.
    const replayRes = await request(app)
      .post("/api/team/invitations/accept")
      .set("x-test-user-id", "user_invitee")
      .send({ token: rawToken });
    expect(replayRes.status).toBe(409);

    // 5. Revoked and expired tokens fail cleanly.
    const invite2 = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_owner")
      .send({ email: "revoked@alpha.example", role: "member" });
    expect(invite2.status).toBe(201);
    const revokedToken = extractTokenFromAcceptUrl(sentEmails[1]!.acceptUrl);
    const revokeRes = await request(app)
      .delete(`/api/team/invitations/${invite2.body.invitation.id}`)
      .set("x-test-user-id", "user_owner");
    expect(revokeRes.status).toBe(200);
    const acceptRevoked = await request(app)
      .post("/api/team/invitations/accept")
      .set("x-test-user-id", "user_wrong")
      .send({ token: revokedToken });
    expect(acceptRevoked.status).toBe(400);

    const invite3 = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_owner")
      .send({ email: "wrong@other.example", role: "member" });
    expect(invite3.status).toBe(201);
    const expiredToken = extractTokenFromAcceptUrl(sentEmails[2]!.acceptUrl);
    await db
      .update(invitationsTable)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invitationsTable.id, invite3.body.invitation.id));
    const acceptExpired = await request(app)
      .post("/api/team/invitations/accept")
      .set("x-test-user-id", "user_wrong")
      .send({ token: expiredToken });
    expect(acceptExpired.status).toBe(400);

    // 6. Inviting an already-active member returns 409.
    const duplicateMemberInvite = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_owner")
      .send({ email: "invitee@alpha.example", role: "member" });
    expect(duplicateMemberInvite.status).toBe(409);

    // 7. Rate limit: 3 invitations were already sent in the last hour; 4th & 5th succeed, 6th returns 429.
    for (const i of [4, 5]) {
      const ok = await request(app)
        .post("/api/team/invitations")
        .set("x-test-user-id", "user_owner")
        .send({ email: `rate${i}@alpha.example`, role: "member" });
      expect(ok.status).toBe(201);
    }
    const rateLimited = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_owner")
      .send({ email: "rate6@alpha.example", role: "member" });
    expect(rateLimited.status).toBe(429);
  });

  it("enforces RBAC across owner/admin/manager/member and blocks privilege escalation, self-removal, and last-owner removal", async () => {
    await seedTenant({
      businessId: "biz_a",
      businessName: "Org Alpha",
      ownerId: "user_owner",
      ownerEmail: "owner@alpha.example",
      ownerName: "Owner",
    });

    // Seed admin, manager, and member into biz_a.
    for (const u of [
      { id: "user_admin", email: "admin@alpha.example", name: "Admin", role: "admin" },
      { id: "user_manager", email: "manager@alpha.example", name: "Manager", role: "manager" },
      { id: "user_member", email: "member@alpha.example", name: "Member", role: "member" },
    ]) {
      await db.insert(usersTable).values({
        id: u.id,
        businessId: "biz_a",
        name: u.name,
        email: u.email,
        role: u.role,
      });
      await db.insert(membershipsTable).values({
        id: `mem_${u.id}_biz_a`,
        userId: u.id,
        businessId: "biz_a",
        role: u.role,
      });
    }

    const app = buildApp();

    // Admin CANNOT invite admin or owner.
    expect(
      (
        await request(app)
          .post("/api/team/invitations")
          .set("x-test-user-id", "user_admin")
          .send({ email: "newadmin@alpha.example", role: "admin" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/team/invitations")
          .set("x-test-user-id", "user_admin")
          .send({ email: "newowner@alpha.example", role: "owner" })
      ).status,
    ).toBe(403);

    // Admin CANNOT promote member to admin or modify owner.
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_member_biz_a")
          .set("x-test-user-id", "user_admin")
          .send({ role: "admin" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_owner_biz_a")
          .set("x-test-user-id", "user_admin")
          .send({ role: "member" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .delete("/api/team/members/mem_user_owner_biz_a")
          .set("x-test-user-id", "user_admin")
      ).status,
    ).toBe(403);

    // Admin CAN change member -> manager and update business-settings.
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_member_biz_a")
          .set("x-test-user-id", "user_admin")
          .send({ role: "manager" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch("/api/business-settings")
          .set("x-test-user-id", "user_admin")
          .send({ name: "Org Alpha Updated" })
      ).status,
    ).toBe(200);

    // Restore member role cleanly.
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_member_biz_a")
          .set("x-test-user-id", "user_admin")
          .send({ role: "member" })
      ).status,
    ).toBe(200);

    // Manager CANNOT change settings, invite, or read audit logs, but CAN trigger lead/call ops (e.g. leads import).
    expect(
      (
        await request(app)
          .patch("/api/business-settings")
          .set("x-test-user-id", "user_manager")
          .send({ name: "Nope" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/team/invitations")
          .set("x-test-user-id", "user_manager")
          .send({ email: "x@alpha.example", role: "member" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/audit-logs")
          .set("x-test-user-id", "user_manager")
      ).status,
    ).toBe(403);
    const managerImport = await request(app)
      .post("/api/leads/import")
      .set("x-test-user-id", "user_manager")
      .send({ leads: [] });
    expect(managerImport.status).toBe(400); // Reached handler (passed RBAC)

    // Member CAN read /leads and /team (without seeing pending invitations), CANNOT import leads or edit settings.
    expect(
      (await request(app).get("/api/leads").set("x-test-user-id", "user_member")).status,
    ).toBe(200);
    const memberTeam = await request(app)
      .get("/api/team")
      .set("x-test-user-id", "user_member");
    expect(memberTeam.status).toBe(200);
    expect(memberTeam.body.invitations).toEqual([]);
    expect(
      (
        await request(app)
          .post("/api/leads/import")
          .set("x-test-user-id", "user_member")
          .send({ leads: [] })
      ).status,
    ).toBe(403);

    // Self-role-change and self-removal are blocked even for owner.
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_owner_biz_a")
          .set("x-test-user-id", "user_owner")
          .send({ role: "admin" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .delete("/api/team/members/mem_user_owner_biz_a")
          .set("x-test-user-id", "user_owner")
      ).status,
    ).toBe(400);

    // Removing the last owner directly via service or promoting another user then demoting:
    // Promote admin -> owner, then original owner CAN demote new owner back, and cannot remove last owner.
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_admin_biz_a")
          .set("x-test-user-id", "user_owner")
          .send({ role: "owner" })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch("/api/team/members/mem_user_admin_biz_a")
          .set("x-test-user-id", "user_owner")
          .send({ role: "admin" })
      ).status,
    ).toBe(200);

    // Audit logs recorded all sensitive changes in biz_a only.
    const audits = await request(app)
      .get("/api/audit-logs")
      .set("x-test-user-id", "user_owner");
    expect(audits.status).toBe(200);
    expect(audits.body.logs.length).toBeGreaterThanOrEqual(4);
    expect(
      audits.body.logs.every((l: { business_id: string }) => l.business_id === "biz_a"),
    ).toBe(true);
  });

  it("enforces strict cross-tenant isolation on members, invitations, and audit logs", async () => {
    await seedTenant({
      businessId: "biz_a",
      businessName: "Org Alpha",
      ownerId: "user_a",
      ownerEmail: "a@alpha.example",
      ownerName: "Owner A",
    });
    await seedTenant({
      businessId: "biz_b",
      businessName: "Org Beta",
      ownerId: "user_b",
      ownerEmail: "b@beta.example",
      ownerName: "Owner B",
    });

    const app = buildApp();
    const invB = await request(app)
      .post("/api/team/invitations")
      .set("x-test-user-id", "user_b")
      .send({ email: "teammate@beta.example", role: "member" });
    expect(invB.status).toBe(201);

    // Owner A cannot revoke Owner B's invitation or modify Owner B's membership.
    const crossRevoke = await request(app)
      .delete(`/api/team/invitations/${invB.body.invitation.id}`)
      .set("x-test-user-id", "user_a");
    expect(crossRevoke.status).toBe(404);

    const crossPatch = await request(app)
      .patch("/api/team/members/mem_user_b_biz_b")
      .set("x-test-user-id", "user_a")
      .send({ role: "member" });
    expect(crossPatch.status).toBe(404);

    const crossDelete = await request(app)
      .delete("/api/team/members/mem_user_b_biz_b")
      .set("x-test-user-id", "user_a");
    expect(crossDelete.status).toBe(404);

    // Owner A's audit logs do not contain Org B's invitation event.
    const auditsA = await request(app)
      .get("/api/audit-logs")
      .set("x-test-user-id", "user_a");
    expect(auditsA.status).toBe(200);
    expect(
      auditsA.body.logs.some(
        (l: { entity_id: string | null }) => l.entity_id === invB.body.invitation.id,
      ),
    ).toBe(false);

    // Also verify leads stay isolated across tenants when seeded cleanly.
    const [bLead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.businessId, "biz_b")))
      .limit(1);
    expect(bLead).toBeUndefined();

    const storedAuditsB = await db
      .select()
      .from(auditLogsTable)
      .where(eq(auditLogsTable.businessId, "biz_b"));
    expect(storedAuditsB).toHaveLength(1);
  });

  it("blocks removing or demoting the final owner of an organization", async () => {
    await seedTenant({
      businessId: "biz_solo",
      businessName: "Solo Org",
      ownerId: "user_solo",
      ownerEmail: "solo@example.com",
      ownerName: "Solo Owner",
    });

    await expect(
      updateTeamMemberRole(db as never, {
        businessId: "biz_solo",
        actorUserId: "system_admin_actor",
        actorRole: "owner",
        membershipId: "mem_user_solo_biz_solo",
        nextRole: "admin",
      }),
    ).rejects.toThrow("At least one organization owner must remain");

    await expect(
      removeTeamMember(db as never, {
        businessId: "biz_solo",
        actorUserId: "system_admin_actor",
        actorRole: "owner",
        membershipId: "mem_user_solo_biz_solo",
      }),
    ).rejects.toThrow("At least one organization owner must remain");
  });
});
