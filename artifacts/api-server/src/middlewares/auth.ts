import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, businessesTable, membershipsTable, usersTable, usageTable } from "@workspace/db";
import { resolveActiveOrganization } from "../lib/orgContext";
import type { OrgRole } from "./rbac";

type Database = typeof defaultDb;
let db: Database = defaultDb;

/** Test seam for swapping the database in auth middleware tests. */
export function __setAuthDb(next: Database): void {
  db = next;
}

export function __resetAuthDb(): void {
  db = defaultDb;
}

declare global {
  namespace Express {
    interface Request {
      leadSprintUserId?: string;
      leadSprintBusinessId?: string;
      leadSprintRole?: OrgRole;
    }
  }
}

function claimString(
  claims: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = claims?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId =
    auth?.userId ??
    claimString(auth?.sessionClaims ?? undefined, "userId");
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const claims = auth.sessionClaims as Record<string, unknown> | undefined;
  const email =
    claimString(claims, "email") ??
    claimString(claims, "email_address") ??
    `${userId}@clerk.local`;
  const name =
    claimString(claims, "name") ??
    claimString(claims, "given_name") ??
    email.split("@")[0] ??
    "Operator";

  let [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    const businessId = `business_${userId}`;
    const [business] = await db
      .insert(businessesTable)
      .values({
        id: businessId,
        name: "New LeadSprint workspace",
        market: "US",
        timezone: "America/New_York",
        phoneNumber: "",
        transferNumber: "",
        projectName: "Configure your first campaign",
        approvedFaq: "",
        qualificationQuestions: [],
        escalationRules:
          "Transfer questions outside approved business information to a human.",
      })
      .onConflictDoNothing()
      .returning();

    if (!business) {
      [user] = await db
        .select()
        .from(usersTable)
        .where(and(eq(usersTable.id, userId), eq(usersTable.businessId, businessId)))
        .limit(1);
    } else {
      [user] = await db
        .insert(usersTable)
        .values({
          id: userId,
          businessId,
          name,
          email,
          role: "owner",
          lastLoginAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      await db
        .insert(membershipsTable)
        .values({
          id: `mem_${userId}_${businessId}`,
          userId,
          businessId,
          role: "owner",
        })
        .onConflictDoNothing();
      const now = new Date();
      const usageRowId = `usage_${businessId}_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      await db
        .insert(usageTable)
        .values({
          id: usageRowId,
          businessId,
          periodStart: new Date(now.getFullYear(), now.getMonth(), 1),
          periodEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
        })
        .onConflictDoNothing();
    }
  } else {
    [user] = await db
      .update(usersTable)
      .set({ lastLoginAt: new Date(), name, email })
      .where(eq(usersTable.id, userId))
      .returning();
  }

  if (!user) {
    res.status(503).json({ error: "Operator workspace is not ready" });
    return;
  }

  if (user.businessId) {
    const existingMemberships = await db
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, user.id))
      .limit(1);

    if (existingMemberships.length === 0) {
      // User has zero organization memberships.
      // Verify business exists and independent ownership before self-healing.
      const [business] = await db
        .select({ id: businessesTable.id })
        .from(businessesTable)
        .where(eq(businessesTable.id, user.businessId))
        .limit(1);

      if (!business) {
        res.status(403).json({
          error: "Organization does not exist. Please contact support or your organization administrator.",
        });
        return;
      }

      // Check whether user's legacy role is owner
      if (user.role !== "owner") {
        res.status(403).json({
          error: "Organization membership could not be verified. An organization administrator must invite you to this workspace.",
        });
        return;
      }

      // Verify no other owner already exists for this business (prevent cross-tenant hijacking)
      const [existingOwner] = await db
        .select({ userId: membershipsTable.userId })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.businessId, user.businessId),
            eq(membershipsTable.role, "owner"),
          ),
        )
        .limit(1);

      const isDedicatedUserBusiness = user.businessId === `business_${user.id}`;
      const isSoleLegacyOwner = !existingOwner || existingOwner.userId === user.id;

      if (!isDedicatedUserBusiness && !isSoleLegacyOwner) {
        res.status(403).json({
          error: "Organization membership could not be verified. An organization administrator must invite you to this workspace.",
        });
        return;
      }

      // Independently verified: safe to create owner membership
      await db
        .insert(membershipsTable)
        .values({
          id: `mem_${user.id}_${user.businessId}`,
          userId: user.id,
          businessId: user.businessId,
          role: "owner",
        })
        .onConflictDoNothing();
    }
  }

  const resolvedOrg = await resolveActiveOrganization(
    db,
    user.id,
    user.businessId,
    req,
    res,
  );
  if (!resolvedOrg.ok) {
    res.status(resolvedOrg.status).json({ error: resolvedOrg.error });
    return;
  }

  req.leadSprintUserId = user.id;
  req.leadSprintBusinessId = resolvedOrg.businessId;
  req.leadSprintRole = resolvedOrg.role;
  next();
}