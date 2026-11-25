import type { RequestHandler } from "express";

export const ORG_ROLES = ["owner", "admin", "manager", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * Normalizes legacy user roles (such as "operator") onto the canonical
 * Phase 1 RBAC role set when evaluating permissions.
 */
export function normalizeOrgRole(value: string | null | undefined): OrgRole {
  if (isOrgRole(value)) return value;
  if (value === "operator") return "member";
  return "member";
}

export const READ_ROLES: readonly OrgRole[] = ["owner", "admin", "manager", "member"];
export const OPERATIONS_ROLES: readonly OrgRole[] = ["owner", "admin", "manager"];
export const ADMIN_ROLES: readonly OrgRole[] = ["owner", "admin"];

/**
 * Enforces role-based access control on authenticated operator routes.
 * Fails closed (403) when no verified membership role is attached to the request.
 */
export function requireRole(...allowed: OrgRole[]): RequestHandler {
  return (req, res, next) => {
    const role = req.leadSprintRole;
    if (!role || !allowed.includes(role)) {
      res.status(403).json({
        error: "Insufficient permissions for this action",
      });
      return;
    }
    next();
  };
}

