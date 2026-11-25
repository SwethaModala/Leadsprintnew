import crypto from "node:crypto";
import type { Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  businessesTable,
  db as defaultDb,
  membershipsTable,
} from "@workspace/db";
import { getProfile } from "./verticals";
import { normalizeOrgRole, type OrgRole } from "../middlewares/rbac";

type Database = typeof defaultDb;

export const ACTIVE_BUSINESS_COOKIE = "ls_active_business";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cookieSecret(): string {
  const configured =
    process.env["SESSION_SECRET"]?.trim() ||
    process.env["CLERK_SECRET_KEY"]?.trim();
  if (configured) return configured;
  if (process.env["NODE_ENV"] !== "production") {
    return "leadsprint_dev_cookie_secret";
  }
  return "";
}

function isSecureRequest(req: Request): boolean {
  return (
    req.secure ||
    req.get("x-forwarded-proto") === "https" ||
    process.env["NODE_ENV"] === "production"
  );
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }
  return cookies;
}

export function signActiveBusinessCookie(businessId: string): string {
  const secret = cookieSecret();
  if (!secret) {
    throw new Error("SESSION_SECRET or CLERK_SECRET_KEY is required to sign organization cookies in production");
  }
  const mac = crypto.createHmac("sha256", secret).update(businessId).digest("base64url");
  return `${businessId}.${mac}`;
}

export function verifyActiveBusinessCookie(rawCookie: string | undefined): string | null {
  if (!rawCookie) return null;
  const dotIdx = rawCookie.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  const businessId = rawCookie.slice(0, dotIdx);
  const providedSig = rawCookie.slice(dotIdx + 1);
  if (!businessId || !providedSig) return null;

  const secret = cookieSecret();
  if (!secret) return null;
  const expectedSig = crypto.createHmac("sha256", secret).update(businessId).digest("base64url");
  const providedBuf = Buffer.from(providedSig, "utf8");
  const expectedBuf = Buffer.from(expectedSig, "utf8");
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;
  return businessId;
}

export function setActiveBusinessCookie(req: Request, res: Response, businessId: string): void {
  const signed = signActiveBusinessCookie(businessId);
  res.cookie(ACTIVE_BUSINESS_COOKIE, signed, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_MS,
    secure: isSecureRequest(req),
  });
}

export function clearActiveBusinessCookie(req: Request, res: Response): void {
  res.clearCookie(ACTIVE_BUSINESS_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureRequest(req),
  });
}

export type ResolveOrgResult =
  | { ok: true; businessId: string; role: OrgRole }
  | { ok: false; status: 403; error: string };

/**
 * Resolves the active organization and membership role for a verified user.
 *
 * Security invariants:
 * - An explicit `X-Business-Id` header MUST belong to a membership of `userId` (else 403).
 * - A forged/tampered `ls_active_business` cookie signature MUST fail closed (403).
 * - A valid-HMAC cookie for a workspace the user no longer belongs to clears the stale cookie
 *   and falls back to another verified membership if one exists (else 403).
 */
export async function resolveActiveOrganization(
  database: Database,
  userId: string,
  fallbackBusinessId: string | null | undefined,
  req: Request,
  res?: Response,
): Promise<ResolveOrgResult> {
  const headerBusinessId = req.get("x-business-id")?.trim();
  if (headerBusinessId) {
    const [membership] = await database
      .select({ businessId: membershipsTable.businessId, role: membershipsTable.role })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.businessId, headerBusinessId),
        ),
      )
      .limit(1);

    if (!membership) {
      return {
        ok: false,
        status: 403,
        error: "You do not have access to the requested organization",
      };
    }

    return {
      ok: true,
      businessId: membership.businessId,
      role: normalizeOrgRole(membership.role),
    };
  }

  const cookies = parseCookies(req.headers.cookie);
  const rawCookie = cookies[ACTIVE_BUSINESS_COOKIE];
  if (rawCookie !== undefined) {
    const cookieBusinessId = verifyActiveBusinessCookie(rawCookie);
    if (!cookieBusinessId) {
      return {
        ok: false,
        status: 403,
        error: "Invalid active organization session token",
      };
    }

    const [cookieMembership] = await database
      .select({ businessId: membershipsTable.businessId, role: membershipsTable.role })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.businessId, cookieBusinessId),
        ),
      )
      .limit(1);

    if (cookieMembership) {
      return {
        ok: true,
        businessId: cookieMembership.businessId,
        role: normalizeOrgRole(cookieMembership.role),
      };
    }

    if (res) {
      clearActiveBusinessCookie(req, res);
    }
  }

  const memberships = await database
    .select({ businessId: membershipsTable.businessId, role: membershipsTable.role })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, userId))
    .orderBy(asc(membershipsTable.createdAt));

  if (memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "No active organization membership found",
    };
  }

  const preferred =
    (fallbackBusinessId
      ? memberships.find((m) => m.businessId === fallbackBusinessId)
      : undefined) ?? memberships[0]!;

  return {
    ok: true,
    businessId: preferred.businessId,
    role: normalizeOrgRole(preferred.role),
  };
}

export interface OrganizationSummaryDto {
  id: string;
  name: string;
  slug: string | null;
  vertical: "real_estate" | "home_services";
  role: OrgRole;
  is_active: boolean;
}

export async function listUserOrganizations(
  database: Database,
  userId: string,
  activeBusinessId: string,
): Promise<OrganizationSummaryDto[]> {
  const rows = await database
    .select({
      id: businessesTable.id,
      name: businessesTable.name,
      slug: businessesTable.slug,
      vertical: businessesTable.vertical,
      role: membershipsTable.role,
    })
    .from(membershipsTable)
    .innerJoin(businessesTable, eq(membershipsTable.businessId, businessesTable.id))
    .where(eq(membershipsTable.userId, userId))
    .orderBy(asc(membershipsTable.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug ?? null,
    vertical: getProfile(row.vertical).id,
    role: normalizeOrgRole(row.role),
    is_active: row.id === activeBusinessId,
  }));
}

