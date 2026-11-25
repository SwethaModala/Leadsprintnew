import crypto from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  auditLogsTable,
  businessesTable,
  db as defaultDb,
  invitationsTable,
  membershipsTable,
  usageTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sendTeamInvitationEmail, type TeamInvitationEmailInput } from "./mailer";
import { getProfile } from "./verticals";
import { listUserOrganizations, type OrganizationSummaryDto } from "./orgContext";
import {
  normalizeOrgRole,
  type OrgRole,
} from "../middlewares/rbac";

type Database = typeof defaultDb;
type TxExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_RATE_LIMIT_PER_HOUR = 5;

const ROLE_RANK: Record<OrgRole, number> = {
  owner: 4,
  admin: 3,
  manager: 2,
  member: 1,
};

export class TeamServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TeamServiceError";
  }
}

export type TeamEmailSender = (input: TeamInvitationEmailInput) => Promise<boolean>;

let teamEmailSender: TeamEmailSender = sendTeamInvitationEmail;

/** Test seam for capturing invitation delivery without external SMTP. */
export function __setTeamEmailSender(fn: TeamEmailSender): void {
  teamEmailSender = fn;
}

export function __resetTeamEmailSender(): void {
  teamEmailSender = sendTeamInvitationEmail;
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "workspace"}-${crypto.randomBytes(3).toString("hex")}`;
}

export function allowedInviteRolesFor(actorRole: OrgRole): OrgRole[] {
  if (actorRole === "owner") return ["admin", "manager", "member"];
  if (actorRole === "admin") return ["manager", "member"];
  return [];
}

export function canInviteRole(actorRole: OrgRole, invitedRole: OrgRole): boolean {
  return allowedInviteRolesFor(actorRole).includes(invitedRole);
}

export function canManageMemberRole(
  actorRole: OrgRole,
  currentTargetRole: OrgRole,
  nextRole: OrgRole,
): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") {
    return (
      ROLE_RANK[currentTargetRole] < ROLE_RANK.admin &&
      ROLE_RANK[nextRole] < ROLE_RANK.admin
    );
  }
  return false;
}

export function canRemoveMember(actorRole: OrgRole, targetRole: OrgRole): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return ROLE_RANK[targetRole] < ROLE_RANK.admin;
  return false;
}

export function buildTeamPermissions(role: OrgRole) {
  const allowed_invite_roles = allowedInviteRolesFor(role);
  return {
    can_invite: allowed_invite_roles.length > 0,
    allowed_invite_roles,
    can_manage_roles: role === "owner" || role === "admin",
    can_remove_members: role === "owner" || role === "admin",
    can_edit_settings: role === "owner" || role === "admin",
  };
}

export async function writeAuditLog(
  executor: TxExecutor,
  input: {
    businessId: string | null;
    userId: string | null;
    entity: string;
    entityId?: string | null;
    action: string;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await executor.insert(auditLogsTable).values({
    id: makeId("audit"),
    businessId: input.businessId,
    userId: input.userId,
    entity: input.entity,
    entityId: input.entityId ?? null,
    action: input.action,
    details: input.details ?? null,
  });
}

function appOrigin(): string {
  const configured =
    process.env["APP_URL"]?.trim() ||
    process.env["PUBLIC_APP_URL"]?.trim() ||
    process.env["CORS_ORIGINS"]?.split(",")[0]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const port = process.env["PORT"]?.trim() || "5000";
  return `http://localhost:${port}`;
}

export async function getTeamRoster(
  database: Database,
  businessId: string,
  actorUserId: string,
  actorRole: OrgRole,
) {
  const orgs = await listUserOrganizations(database, actorUserId, businessId);
  const currentOrg = orgs.find((org) => org.id === businessId);
  if (!currentOrg) {
    throw new TeamServiceError(403, "Active organization membership not found");
  }

  const memberRows = await database
    .select({
      membershipId: membershipsTable.id,
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: membershipsTable.role,
      joinedAt: membershipsTable.createdAt,
      lastLoginAt: usersTable.lastLoginAt,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(membershipsTable.userId, usersTable.id))
    .where(eq(membershipsTable.businessId, businessId));

  memberRows.sort((a, b) => {
    const rankDiff =
      ROLE_RANK[normalizeOrgRole(b.role)] - ROLE_RANK[normalizeOrgRole(a.role)];
    if (rankDiff !== 0) return rankDiff;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });

  const canInspectInvitations = actorRole === "owner" || actorRole === "admin";
  const invitationRows = canInspectInvitations
    ? await database
      .select({
        id: invitationsTable.id,
        email: invitationsTable.email,
        role: invitationsTable.role,
        status: invitationsTable.status,
        invitedByUserId: invitationsTable.invitedByUserId,
        invitedByName: usersTable.name,
        expiresAt: invitationsTable.expiresAt,
        createdAt: invitationsTable.createdAt,
      })
      .from(invitationsTable)
      .leftJoin(usersTable, eq(invitationsTable.invitedByUserId, usersTable.id))
      .where(eq(invitationsTable.businessId, businessId))
      .orderBy(desc(invitationsTable.createdAt))
      .limit(50)
    : [];

  const now = Date.now();
  return {
    organization: currentOrg,
    current_user_id: actorUserId,
    current_role: actorRole,
    permissions: buildTeamPermissions(actorRole),
    members: memberRows.map((m) => ({
      membership_id: m.membershipId,
      user_id: m.userId,
      name: m.name,
      email: m.email,
      role: normalizeOrgRole(m.role),
      joined_at: m.joinedAt.toISOString(),
      last_login_at: m.lastLoginAt ? m.lastLoginAt.toISOString() : null,
    })),
    invitations: invitationRows.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: normalizeOrgRole(inv.role),
      status:
        inv.status === "pending" && inv.expiresAt.getTime() <= now
          ? ("expired" as const)
          : (inv.status as "pending" | "accepted" | "revoked"),
      invited_by_user_id: inv.invitedByUserId,
      invited_by_name: inv.invitedByName ?? null,
      expires_at: inv.expiresAt.toISOString(),
      created_at: inv.createdAt.toISOString(),
    })),
  };
}

export async function createTeamInvitation(
  database: Database,
  input: {
    businessId: string;
    actorUserId: string;
    actorRole: OrgRole;
    email: string;
    role: OrgRole;
  },
) {
  if (!canInviteRole(input.actorRole, input.role)) {
    throw new TeamServiceError(
      403,
      `Role "${input.actorRole}" is not allowed to invite "${input.role}" members`,
    );
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  const [business] = await database
    .select({ id: businessesTable.id, name: businessesTable.name })
    .from(businessesTable)
    .where(eq(businessesTable.id, input.businessId))
    .limit(1);
  if (!business) {
    throw new TeamServiceError(404, "Organization not found");
  }

  const [inviter] = await database
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, input.actorUserId))
    .limit(1);
  const inviterName = inviter?.name || "A workspace administrator";

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const created = await database.transaction(async (tx) => {
    const existingMember = await tx
      .select({ membershipId: membershipsTable.id })
      .from(membershipsTable)
      .innerJoin(usersTable, eq(membershipsTable.userId, usersTable.id))
      .where(
        and(
          eq(membershipsTable.businessId, input.businessId),
          sql`lower(${usersTable.email}) = ${normalizedEmail}`,
        ),
      )
      .limit(1);

    if (existingMember.length > 0) {
      throw new TeamServiceError(409, "A user with this email already belongs to this organization");
    }

    const recentInvites = await tx
      .select({ id: invitationsTable.id })
      .from(invitationsTable)
      .where(
        and(
          eq(invitationsTable.businessId, input.businessId),
          eq(invitationsTable.invitedByUserId, input.actorUserId),
          gte(invitationsTable.createdAt, oneHourAgo),
        ),
      );

    if (recentInvites.length >= INVITATION_RATE_LIMIT_PER_HOUR) {
      throw new TeamServiceError(429, "Invitation limit exceeded. Please try again later.");
    }

    await tx
      .update(invitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(invitationsTable.businessId, input.businessId),
          eq(invitationsTable.email, normalizedEmail),
          eq(invitationsTable.status, "pending"),
        ),
      );

    const [invitation] = await tx
      .insert(invitationsTable)
      .values({
        id: makeId("inv"),
        businessId: input.businessId,
        invitedByUserId: input.actorUserId,
        email: normalizedEmail,
        role: input.role,
        tokenHash,
        status: "pending",
        expiresAt,
      })
      .returning();

    await writeAuditLog(tx, {
      businessId: input.businessId,
      userId: input.actorUserId,
      entity: "invitation",
      entityId: invitation!.id,
      action: "invitation.created",
      details: { email: normalizedEmail, role: input.role },
    });

    return invitation!;
  });

  const acceptUrl = `${appOrigin()}/accept-invitation#token=${encodeURIComponent(rawToken)}`;
  let sent = false;
  try {
    sent = await teamEmailSender({
      to: normalizedEmail,
      organizationName: business.name,
      inviterName,
      role: input.role,
      acceptUrl,
      expiresAt,
    });
  } catch (err) {
    await database
      .update(invitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(invitationsTable.id, created.id));
    logger.error({ err, businessId: input.businessId, invitationId: created.id }, "Failed to send team invitation email");
    throw new TeamServiceError(502, "Failed to send invitation email");
  }

  const demoMode =
    process.env["LEADSPRINT_DEMO_AUTH"]?.trim().toLowerCase() === "true" &&
    process.env["NODE_ENV"] !== "production";

  if (!sent && process.env["NODE_ENV"] === "production") {
    await database
      .update(invitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(invitationsTable.id, created.id));
    throw new TeamServiceError(503, "Email delivery is not configured for team invitations");
  }

  const delivery_status: "sent" | "smtp_unconfigured" | "demo_logged" = sent
    ? "sent"
    : demoMode
      ? "demo_logged"
      : "smtp_unconfigured";

  return {
    invitation: {
      id: created.id,
      email: created.email,
      role: normalizeOrgRole(created.role),
      status: "pending" as const,
      invited_by_user_id: created.invitedByUserId,
      invited_by_name: inviterName,
      expires_at: created.expiresAt.toISOString(),
      created_at: created.createdAt.toISOString(),
    },
    delivery_status,
  };
}

export async function revokeTeamInvitation(
  database: Database,
  input: {
    businessId: string;
    actorUserId: string;
    actorRole: OrgRole;
    invitationId: string;
  },
) {
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    throw new TeamServiceError(403, "Insufficient permissions to revoke invitations");
  }

  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(invitationsTable)
      .where(
        and(
          eq(invitationsTable.id, input.invitationId),
          eq(invitationsTable.businessId, input.businessId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new TeamServiceError(404, "Invitation not found");
    }

    const existingRole = normalizeOrgRole(existing.role);
    if (input.actorRole === "admin" && ROLE_RANK[existingRole] >= ROLE_RANK.admin) {
      throw new TeamServiceError(403, "Admins cannot revoke owner or admin invitations");
    }

    if (existing.status !== "pending") {
      throw new TeamServiceError(400, `Cannot revoke an invitation with status "${existing.status}"`);
    }

    const [updated] = await tx
      .update(invitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(invitationsTable.id, existing.id),
          eq(invitationsTable.businessId, input.businessId),
          eq(invitationsTable.status, "pending"),
        ),
      )
      .returning();

    if (!updated) {
      throw new TeamServiceError(409, "Invitation was already processed");
    }

    await writeAuditLog(tx, {
      businessId: input.businessId,
      userId: input.actorUserId,
      entity: "invitation",
      entityId: updated.id,
      action: "invitation.revoked",
      details: { email: updated.email, role: updated.role },
    });

    return {
      invitation: {
        id: updated.id,
        email: updated.email,
        role: normalizeOrgRole(updated.role),
        status: "revoked" as const,
        invited_by_user_id: updated.invitedByUserId,
        invited_by_name: null,
        expires_at: updated.expiresAt.toISOString(),
        created_at: updated.createdAt.toISOString(),
      },
    };
  });
}

export async function acceptTeamInvitation(
  database: Database,
  input: {
    token: string;
    actorUserId: string;
    actorEmail: string;
  },
) {
  const tokenHash = hashToken(input.token.trim());
  const normalizedActorEmail = input.actorEmail.trim().toLowerCase();

  return database.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(invitationsTable)
      .where(eq(invitationsTable.tokenHash, tokenHash))
      .limit(1);

    if (!invitation) {
      throw new TeamServiceError(400, "Invalid or expired invitation");
    }

    if (invitation.status === "accepted") {
      throw new TeamServiceError(409, "This invitation has already been accepted");
    }
    if (invitation.status === "revoked") {
      throw new TeamServiceError(400, "This invitation has been revoked");
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new TeamServiceError(400, "This invitation has expired");
    }

    if (invitation.email.trim().toLowerCase() !== normalizedActorEmail) {
      throw new TeamServiceError(
        403,
        "Sign in with the invited email address to accept this invitation",
      );
    }

    const [alreadyMember] = await tx
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, input.actorUserId),
          eq(membershipsTable.businessId, invitation.businessId),
        ),
      )
      .limit(1);

    if (alreadyMember) {
      throw new TeamServiceError(409, "You already belong to this organization");
    }

    const [claimed] = await tx
      .update(invitationsTable)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(
        and(
          eq(invitationsTable.id, invitation.id),
          eq(invitationsTable.status, "pending"),
        ),
      )
      .returning();

    if (!claimed) {
      throw new TeamServiceError(409, "This invitation has already been accepted");
    }

    const role = normalizeOrgRole(invitation.role);
    const [membership] = await tx
      .insert(membershipsTable)
      .values({
        id: makeId("mem"),
        userId: input.actorUserId,
        businessId: invitation.businessId,
        role,
      })
      .returning();

    await writeAuditLog(tx, {
      businessId: invitation.businessId,
      userId: input.actorUserId,
      entity: "invitation",
      entityId: invitation.id,
      action: "invitation.accepted",
      details: { membership_id: membership!.id, role },
    });

    const [business] = await tx
      .select({
        id: businessesTable.id,
        name: businessesTable.name,
        slug: businessesTable.slug,
        vertical: businessesTable.vertical,
      })
      .from(businessesTable)
      .where(eq(businessesTable.id, invitation.businessId))
      .limit(1);

    const organization: OrganizationSummaryDto = {
      id: business!.id,
      name: business!.name,
      slug: business!.slug ?? null,
      vertical: getProfile(business!.vertical).id,
      role,
      is_active: true,
    };

    return {
      accepted: true as const,
      membership: {
        id: membership!.id,
        business_id: membership!.businessId,
        role,
      },
      organization,
    };
  });
}

export async function updateTeamMemberRole(
  database: Database,
  input: {
    businessId: string;
    actorUserId: string;
    actorRole: OrgRole;
    membershipId: string;
    nextRole: OrgRole;
  },
) {
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    throw new TeamServiceError(403, "Insufficient permissions to change member roles");
  }

  return database.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: membershipsTable.id,
        userId: membershipsTable.userId,
        businessId: membershipsTable.businessId,
        role: membershipsTable.role,
        joinedAt: membershipsTable.createdAt,
        name: usersTable.name,
        email: usersTable.email,
        lastLoginAt: usersTable.lastLoginAt,
      })
      .from(membershipsTable)
      .innerJoin(usersTable, eq(membershipsTable.userId, usersTable.id))
      .where(
        and(
          eq(membershipsTable.id, input.membershipId),
          eq(membershipsTable.businessId, input.businessId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new TeamServiceError(404, "Team member not found");
    }

    if (target.userId === input.actorUserId) {
      throw new TeamServiceError(400, "You cannot change your own role");
    }

    const currentRole = normalizeOrgRole(target.role);
    if (!canManageMemberRole(input.actorRole, currentRole, input.nextRole)) {
      throw new TeamServiceError(
        403,
        "You do not have permission to assign or modify this role",
      );
    }

    if (currentRole === "owner" && input.nextRole !== "owner") {
      const owners = await tx
        .select({ id: membershipsTable.id })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.businessId, input.businessId),
            eq(membershipsTable.role, "owner"),
          ),
        );
      if (owners.length <= 1) {
        throw new TeamServiceError(400, "At least one organization owner must remain");
      }
    }

    if (currentRole !== input.nextRole) {
      await tx
        .update(membershipsTable)
        .set({ role: input.nextRole })
        .where(
          and(
            eq(membershipsTable.id, target.id),
            eq(membershipsTable.businessId, input.businessId),
          ),
        );

      await writeAuditLog(tx, {
        businessId: input.businessId,
        userId: input.actorUserId,
        entity: "membership",
        entityId: target.id,
        action: "member.role_updated",
        details: {
          target_user_id: target.userId,
          previous_role: currentRole,
          new_role: input.nextRole,
        },
      });
    }

    return {
      member: {
        membership_id: target.id,
        user_id: target.userId,
        name: target.name,
        email: target.email,
        role: input.nextRole,
        joined_at: target.joinedAt.toISOString(),
        last_login_at: target.lastLoginAt ? target.lastLoginAt.toISOString() : null,
      },
    };
  });
}

export async function removeTeamMember(
  database: Database,
  input: {
    businessId: string;
    actorUserId: string;
    actorRole: OrgRole;
    membershipId: string;
  },
) {
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    throw new TeamServiceError(403, "Insufficient permissions to remove team members");
  }

  return database.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: membershipsTable.id,
        userId: membershipsTable.userId,
        role: membershipsTable.role,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.id, input.membershipId),
          eq(membershipsTable.businessId, input.businessId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new TeamServiceError(404, "Team member not found");
    }

    if (target.userId === input.actorUserId) {
      throw new TeamServiceError(400, "You cannot remove yourself from the organization");
    }

    const targetRole = normalizeOrgRole(target.role);
    if (!canRemoveMember(input.actorRole, targetRole)) {
      throw new TeamServiceError(
        403,
        "You do not have permission to remove this member",
      );
    }

    if (targetRole === "owner") {
      const owners = await tx
        .select({ id: membershipsTable.id })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.businessId, input.businessId),
            eq(membershipsTable.role, "owner"),
          ),
        );
      if (owners.length <= 1) {
        throw new TeamServiceError(400, "At least one organization owner must remain");
      }
    }

    await tx
      .delete(membershipsTable)
      .where(
        and(
          eq(membershipsTable.id, target.id),
          eq(membershipsTable.businessId, input.businessId),
        ),
      );

    await writeAuditLog(tx, {
      businessId: input.businessId,
      userId: input.actorUserId,
      entity: "membership",
      entityId: target.id,
      action: "member.removed",
      details: { target_user_id: target.userId, removed_role: targetRole },
    });

    return { removed_membership_id: target.id };
  });
}

export async function createOrganizationForUser(
  database: Database,
  input: {
    userId: string;
    name: string;
    vertical?: "real_estate" | "home_services";
    market?: "US" | "IN";
    timezone?: string;
  },
) {
  const profile = getProfile(input.vertical);
  const market = input.market ?? "US";
  const timezone =
    input.timezone?.trim() ||
    (market === "IN" ? "Asia/Kolkata" : "America/New_York");
  const businessId = makeId("business");
  const slug = slugifyOrgName(input.name);
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const periodKey = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`;

  return database.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, input.userId))
      .limit(1);

    if (!user) {
      throw new TeamServiceError(403, "User profile is not provisioned");
    }

    const [business] = await tx
      .insert(businessesTable)
      .values({
        id: businessId,
        name: input.name.trim(),
        slug,
        market,
        timezone,
        phoneNumber: "+1 (000) 000-0000",
        transferNumber: "+1 (000) 000-0000",
        projectName: `${input.name.trim()} — Primary campaign`,
        approvedFaq: profile.defaultApprovedFaq,
        qualificationQuestions: profile.defaultQualificationQuestions,
        vertical: profile.id,
      })
      .returning();

    await tx.insert(membershipsTable).values({
      id: makeId("mem"),
      userId: input.userId,
      businessId: business!.id,
      role: "owner",
    });

    await tx
      .insert(usageTable)
      .values({
        id: `usage_${business!.id}_${periodKey}`,
        businessId: business!.id,
        periodStart,
        periodEnd,
        voiceMinutes: "0",
        smsCount: 0,
        bookingCount: 0,
        estimatedCost: "0",
      })
      .onConflictDoNothing();

    await writeAuditLog(tx, {
      businessId: business!.id,
      userId: input.userId,
      entity: "business",
      entityId: business!.id,
      action: "org.created",
      details: { name: business!.name, vertical: profile.id, market },
    });

    const organization: OrganizationSummaryDto = {
      id: business!.id,
      name: business!.name,
      slug: business!.slug ?? null,
      vertical: profile.id,
      role: "owner",
      is_active: true,
    };

    return {
      active_business_id: business!.id,
      active_role: "owner" as const,
      organization,
    };
  });
}

export async function listAuditLogsForBusiness(
  database: Database,
  businessId: string,
  limit = 50,
) {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const rows = await database
    .select({
      id: auditLogsTable.id,
      businessId: auditLogsTable.businessId,
      userId: auditLogsTable.userId,
      actorName: usersTable.name,
      actorEmail: usersTable.email,
      entity: auditLogsTable.entity,
      entityId: auditLogsTable.entityId,
      action: auditLogsTable.action,
      details: auditLogsTable.details,
      createdAt: auditLogsTable.createdAt,
    })
    .from(auditLogsTable)
    .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
    .where(eq(auditLogsTable.businessId, businessId))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(safeLimit);

  return {
    logs: rows.map((row) => ({
      id: row.id,
      business_id: row.businessId ?? null,
      user_id: row.userId ?? null,
      actor_name: row.actorName ?? null,
      actor_email: row.actorEmail ?? null,
      entity: row.entity,
      entity_id: row.entityId ?? null,
      action: row.action,
      details: row.details ?? null,
      created_at: row.createdAt.toISOString(),
    })),
  };
}
