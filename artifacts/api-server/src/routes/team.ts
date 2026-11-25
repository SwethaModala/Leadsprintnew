import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { businessesTable, db as defaultDb, membershipsTable, usersTable } from "@workspace/db";
import {
  AcceptTeamInvitationBody,
  CreateOrganizationBody,
  GetAuditLogsQueryParams,
  InviteTeamMemberBody,
  SwitchOrganizationBody,
  UpdateTeamMemberRoleBody,
} from "@workspace/api-zod";
import {
  ADMIN_ROLES,
  normalizeOrgRole,
  READ_ROLES,
  requireRole,
} from "../middlewares/rbac";
import {
  listUserOrganizations,
  setActiveBusinessCookie,
} from "../lib/orgContext";
import {
  acceptTeamInvitation,
  createOrganizationForUser,
  createTeamInvitation,
  getTeamRoster,
  listAuditLogsForBusiness,
  removeTeamMember,
  revokeTeamInvitation,
  TeamServiceError,
  updateTeamMemberRole,
  writeAuditLog,
} from "../lib/team";
import { getProfile } from "../lib/verticals";
import { logger } from "../lib/logger";

type Database = typeof defaultDb;
let db: Database = defaultDb;

/** Test seam for swapping the database in isolated router tests. */
export function __setTeamDb(next: Database): void {
  db = next;
}

export function __resetTeamDb(): void {
  db = defaultDb;
}

const router: IRouter = Router();

function requireActor(req: Request, res: Response): {
  userId: string;
  businessId: string;
  role: ReturnType<typeof normalizeOrgRole>;
} | null {
  if (!req.leadSprintUserId || !req.leadSprintBusinessId || !req.leadSprintRole) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return {
    userId: req.leadSprintUserId,
    businessId: req.leadSprintBusinessId,
    role: req.leadSprintRole,
  };
}

function handleTeamError(res: Response, err: unknown): void {
  if (err instanceof TeamServiceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err }, "Unexpected team/org route error");
  res.status(500).json({ error: "Internal server error" });
}

router.get("/orgs", async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  try {
    const organizations = await listUserOrganizations(db, actor.userId, actor.businessId);
    res.json({
      organizations,
      active_business_id: actor.businessId,
      active_role: actor.role,
    });
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.post("/orgs", async (req, res): Promise<void> => {
  if (!req.leadSprintUserId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = CreateOrganizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid organization payload" });
    return;
  }
  try {
    const created = await createOrganizationForUser(db, {
      userId: req.leadSprintUserId,
      name: parsed.data.name,
      vertical: parsed.data.vertical,
      market: parsed.data.market,
      timezone: parsed.data.timezone,
    });
    setActiveBusinessCookie(req, res, created.active_business_id);
    res.status(201).json(created);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.post("/orgs/switch", async (req, res): Promise<void> => {
  if (!req.leadSprintUserId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = SwitchOrganizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Valid business_id is required" });
    return;
  }

  try {
    const targetBusinessId = parsed.data.business_id.trim();
    const [row] = await db
      .select({
        membershipId: membershipsTable.id,
        role: membershipsTable.role,
        id: businessesTable.id,
        name: businessesTable.name,
        slug: businessesTable.slug,
        vertical: businessesTable.vertical,
      })
      .from(membershipsTable)
      .innerJoin(businessesTable, eq(membershipsTable.businessId, businessesTable.id))
      .where(
        and(
          eq(membershipsTable.userId, req.leadSprintUserId),
          eq(membershipsTable.businessId, targetBusinessId),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(403).json({ error: "You do not have access to this organization" });
      return;
    }

    const activeRole = normalizeOrgRole(row.role);
    setActiveBusinessCookie(req, res, row.id);
    await writeAuditLog(db, {
      businessId: row.id,
      userId: req.leadSprintUserId,
      entity: "business",
      entityId: row.id,
      action: "org.switched",
      details: { role: activeRole },
    });

    res.json({
      active_business_id: row.id,
      active_role: activeRole,
      organization: {
        id: row.id,
        name: row.name,
        slug: row.slug ?? null,
        vertical: getProfile(row.vertical).id,
        role: activeRole,
        is_active: true,
      },
    });
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.get("/team", requireRole(...READ_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  try {
    const roster = await getTeamRoster(db, actor.businessId, actor.userId, actor.role);
    res.json(roster);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.post("/team/invitations", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const parsed = InviteTeamMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid invitation request" });
    return;
  }
  const emailCheck = parsed.data.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCheck)) {
    res.status(400).json({ error: "Please enter a valid email address" });
    return;
  }
  try {
    const result = await createTeamInvitation(db, {
      businessId: actor.businessId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      email: emailCheck,
      role: parsed.data.role,
    });
    res.status(201).json(result);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.post("/team/invitations/accept", async (req, res): Promise<void> => {
  if (!req.leadSprintUserId) {
    res.status(401).json({ error: "Sign in to accept this invitation" });
    return;
  }
  const parsed = AcceptTeamInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid invitation token" });
    return;
  }
  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, req.leadSprintUserId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User account is not provisioned" });
      return;
    }

    const accepted = await acceptTeamInvitation(db, {
      token: parsed.data.token,
      actorUserId: user.id,
      actorEmail: user.email,
    });

    setActiveBusinessCookie(req, res, accepted.membership.business_id);
    res.json(accepted);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.delete("/team/invitations/:invitationId", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  try {
    const result = await revokeTeamInvitation(db, {
      businessId: actor.businessId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      invitationId: String(req.params.invitationId),
    });
    res.json(result);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.patch("/team/members/:membershipId", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const parsed = UpdateTeamMemberRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }
  try {
    const result = await updateTeamMemberRole(db, {
      businessId: actor.businessId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      membershipId: String(req.params.membershipId),
      nextRole: parsed.data.role,
    });
    res.json(result);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.delete("/team/members/:membershipId", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  try {
    const result = await removeTeamMember(db, {
      businessId: actor.businessId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      membershipId: String(req.params.membershipId),
    });
    res.json(result);
  } catch (err) {
    handleTeamError(res, err);
  }
});

router.get("/audit-logs", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireActor(req, res);
  if (!actor) return;
  const parsed = GetAuditLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }
  try {
    const logs = await listAuditLogsForBusiness(db, actor.businessId, parsed.data.limit);
    res.json(logs);
  } catch (err) {
    handleTeamError(res, err);
  }
});

export default router;

