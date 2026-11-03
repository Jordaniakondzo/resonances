import { readFileSync } from "node:fs";
import type pg from "pg";

// Test-only provisioning of the ADR-B1 roles on a dedicated PostgreSQL
// instance. Production uses db/provisioning/d03-b1-roles.sql through a
// separate administration circuit; this helper runs that same file.
const PROVISIONING_SQL = readFileSync(
  "db/provisioning/d03-b1-roles.sql",
  "utf8",
);

// Roles are cluster-wide and test files run in parallel processes. Concurrent
// ALTER ROLE on one role can fail ("tuple concurrently updated"), so every
// role change made by the tests happens in a transaction holding this
// transaction-scoped advisory lock.
export async function withRoleLock(
  admin: pg.Client,
  body: () => Promise<void>,
): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query("SELECT pg_advisory_xact_lock(hashtext('b1-roles'))");
    await body();
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

// `admin` must be allowed to create roles (superuser or CREATEROLE).
export async function provisionB1Roles(
  admin: pg.Client,
  migrationRoles: readonly string[] = [],
): Promise<void> {
  await withRoleLock(admin, async () => {
    await admin.query(PROVISIONING_SQL);
    // The migration identity must be able to SET ROLE to the owner without
    // inheriting its privileges. Defaults to the administrator itself.
    const targets =
      migrationRoles.length > 0
        ? [...migrationRoles]
        : [(await admin.query("SELECT current_user AS u")).rows[0].u as string];
    for (const role of targets) {
      const { rows } = await admin.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
        [role],
      );
      // A superuser may SET ROLE anywhere; granting to it adds nothing.
      if (rows[0]?.rolsuper) continue;
      await admin.query(
        'GRANT resonances_b1_owner TO "' +
          role.replaceAll('"', '""') +
          '" WITH INHERIT FALSE, SET TRUE',
      );
    }
  });
}
