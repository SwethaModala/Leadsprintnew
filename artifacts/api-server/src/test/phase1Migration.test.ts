import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { expectedTableNames } from "@workspace/db";

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, "../../../../lib/db/drizzle");

function readMigrationStatements(filename: string): string[] {
  const raw = fs.readFileSync(path.join(drizzleDir, filename), "utf8");
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("Phase 1 additive Drizzle migration (0002)", () => {
  it("runs all Drizzle migrations cleanly from scratch on an empty database", async () => {
    const client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: drizzleDir });

    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const actual = new Set(rows.map((r) => r.tablename));
    const expected = expectedTableNames(drizzleDir);
    expect(expected.length).toBeGreaterThanOrEqual(14);
    for (const table of expected) {
      expect(actual.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it("preserves existing users/businesses and backfills owner memberships idempotently", async () => {
    const client = new PGlite();

    for (const stmt of readMigrationStatements("0000_nifty_vivisector.sql")) {
      await client.exec(stmt);
    }
    for (const stmt of readMigrationStatements("0001_home_services_vertical.sql")) {
      await client.exec(stmt);
    }

    await client.exec(`
      INSERT INTO businesses (id, name, phone_number, transfer_number, project_name)
      VALUES
        ('biz_alpha', 'Alpha Realty', '+12125550101', '+12125550102', 'Alpha Project'),
        ('biz_beta', 'Beta Plumbing', '+15125550101', '+15125550102', 'Beta Project');
      INSERT INTO users (id, business_id, name, email, role)
      VALUES
        ('usr_1', 'biz_alpha', 'Alice Owner', 'alice@alpha.example', 'owner'),
        ('usr_2', 'biz_beta', 'Bob Owner', 'bob@beta.example', 'owner');
    `);

    const statements0002 = readMigrationStatements("0002_phase1_multi_org_rbac.sql");
    for (const stmt of statements0002) {
      await client.exec(stmt);
    }

    // Existing businesses and users must remain intact, and users.business_id must remain NOT NULL.
    const usersRes = await client.query<{ id: string; business_id: string; email: string }>(
      `SELECT id, business_id, email FROM users ORDER BY id`,
    );
    expect(usersRes.rows).toEqual([
      { id: "usr_1", business_id: "biz_alpha", email: "alice@alpha.example" },
      { id: "usr_2", business_id: "biz_beta", email: "bob@beta.example" },
    ]);

    const colCheck = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_id'`,
    );
    expect(colCheck.rows[0]?.is_nullable).toBe("NO");

    const membershipsRes = await client.query<{
      user_id: string;
      business_id: string;
      role: string;
    }>(`SELECT user_id, business_id, role FROM memberships ORDER BY user_id`);
    expect(membershipsRes.rows).toEqual([
      { user_id: "usr_1", business_id: "biz_alpha", role: "owner" },
      { user_id: "usr_2", business_id: "biz_beta", role: "owner" },
    ]);

    // Backfill SQL must be safe and idempotent if re-executed.
    const backfillStmt = statements0002[statements0002.length - 1]!;
    await client.exec(backfillStmt);
    const afterReRun = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memberships`,
    );
    expect(afterReRun.rows[0]?.count).toBe("2");
  });
});
