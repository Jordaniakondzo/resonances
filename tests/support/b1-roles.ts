import { readFileSync } from "node:fs";
import type pg from "pg";

// Test-only provisioning of the ADR-B1 roles on a dedicated PostgreSQL
// instance. Production uses db/provisioning/d03-b1-roles.sql through a
// separate administration circuit; this helper runs that same file.
const PROVISIONING_SQL = readFileSync(
  "db/provisioning/d03-b1-roles.sql",
  "utf8",
);

// T2: roles of the public read boundary (migration 0002). Same reasoning as B1.
const PUBLIC_READER_SQL = readFileSync(
  "db/provisioning/app-reader.sql",
  "utf8",
);

// --- One lock for every role operation of the test suites (C7) -----------------
//
// Roles are cluster-wide and the test files run in parallel processes, each with
// its own database but all on the same cluster. Every test operation that READS
// or CHANGES role memberships takes this ONE advisory lock key:
//   - withRoleLock: transaction-scoped (pg_advisory_xact_lock), released by
//     COMMIT or ROLLBACK. Provisioning, ALTER ROLE, cluster-wide reads.
//   - holdRoleLock: session-scoped (pg_advisory_lock) on the SAME key, for work
//     that spans several transactions or runs on another connection: the
//     grant/migrate/revoke cycle, the rolled-back role changes of the negative
//     tests made in a per-file database.
// Advisory locks only exclude operations that take the same key IN THE SAME
// DATABASE: the lock tag includes the database, so the same key taken in two
// databases does not conflict. The lock therefore always lives in the lock
// database (the one of TEST_DATABASE_URL, where each file's `admin` connection
// is); the helpers refuse a connection to any other database. The previous
// version used a second key for migrations, and some callers took the key from
// their per-file database: in both cases the operations could overlap.
// A request is granted at once when the SAME session already holds the key, at
// either level; another session waits.
//
// Deadlock rules:
//   1. Take the key first in a transaction, before any other lock. A session
//      that waits for the key therefore holds nothing anyone else needs.
//   2. While a session holds the key, work done on ANOTHER connection must never
//      wait for the key (the migration body runs on the migrator connection and
//      takes no advisory lock). PostgreSQL could not detect such a cycle (it goes
//      through Node): it would hang, not fail.
//
export const ROLE_LOCK_KEY = "hashtext('b1-roles')";

function lockDatabase(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("role lock: TEST_DATABASE_URL is required");
  const parsed = new URL(url);
  // libpq defaults the database name to the user name.
  return decodeURIComponent(parsed.pathname.slice(1) || parsed.username);
}

async function assertLockDatabase(client: pg.Client): Promise<void> {
  const { rows } = await client.query("SELECT current_database() AS db");
  const expected = lockDatabase();
  if (rows[0].db !== expected)
    throw new Error(
      `role lock: taken on a connection to database "${rows[0].db}" instead of "${expected}"; advisory locks are per database, so it would exclude nothing`,
    );
}

// Holds the role lock at session level while `body` runs, possibly on other
// connections (which must not take the lock themselves: deadlock rule 2).
export async function holdRoleLock<T>(
  lockClient: pg.Client,
  body: () => Promise<T>,
): Promise<T> {
  await assertLockDatabase(lockClient);
  await lockClient.query(`SELECT pg_advisory_lock(${ROLE_LOCK_KEY})`);
  let result: T;
  try {
    result = await body();
  } catch (error) {
    // A lost connection has released the lock already: keep the body's error.
    await lockClient
      .query(`SELECT pg_advisory_unlock(${ROLE_LOCK_KEY})`)
      .catch(() => undefined);
    throw error;
  }
  const { rows } = await lockClient.query(
    `SELECT pg_advisory_unlock(${ROLE_LOCK_KEY}) AS released`,
  );
  if (rows[0].released !== true)
    throw new Error("role lock: released while it was not held");
  return result;
}

export async function withRoleLock(
  admin: pg.Client,
  body: () => Promise<void>,
): Promise<void> {
  await assertLockDatabase(admin);
  await admin.query("BEGIN");
  try {
    await admin.query(`SELECT pg_advisory_xact_lock(${ROLE_LOCK_KEY})`);
    await body();
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

const quoteIdent = (name: string) => '"' + name.replaceAll('"', '""') + '"';

// `admin` must be allowed to create roles (superuser or CREATEROLE).
export async function provisionB1Roles(
  admin: pg.Client,
  migrationRoles: readonly string[] = [],
): Promise<void> {
  await withRoleLock(admin, async () => {
    await admin.query(PROVISIONING_SQL);
    // Reads the members of the views owner: under the shared key, it can never
    // observe the temporary membership of a migration running elsewhere.
    await admin.query(PUBLIC_READER_SQL);
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
        "GRANT resonances_b1_owner TO " +
          quoteIdent(role) +
          " WITH INHERIT FALSE, SET TRUE",
      );
    }
  });
}

// --- Temporary membership of the views owner (C8) -------------------------------
//
// T2 (migration 0002, C4): only the migration identity may ever hold
// resonances_public_views_owner, and the migration refuses any other member. Test
// files migrate with DIFFERENT identities, so a permanent membership would make
// every other file's migration fail. migrateWithViewsOwner therefore follows the
// operations procedure "grant, migrate, revoke" under the shared key:
//   1. inspect the members of the owner BEFORE changing anything; any member is
//      unexpected (its origin is unknown to this run): refuse, change nothing;
//   2. grant SET-only membership to the non-superuser migration roles and record
//      the exact identity of the rows created (C10), committed (the migrator
//      connection only sees committed catalog rows);
//   3. run the migration;
//   4. revoke the recorded rows only if each one is still exactly the same and no
//      other membership exists; otherwise revoke NOTHING and report everything.
// Guarantees against sessions that ignore the advisory lock: steps 1-2 and step 4
// each run in one transaction holding a cluster-wide lock on pg_auth_members, so no
// membership change can slip between a check and the GRANT or REVOKE that follows.
// During step 3 nothing is locked: a change made then is DETECTED at step 4 (row
// identity), not prevented. The advisory lock itself only binds cooperating code.
// A single transaction around the whole cycle is impossible: Drizzle's migrator
// opens and commits its own transaction on the migrator connection, and that
// connection cannot see an uncommitted GRANT made by another session.
// Brutal interruption between steps 2 and 4 (process killed, connection lost):
// the end of the session releases the lock but does NOT undo the committed GRANT.
// The next run then refuses at step 1; recovery is manual and documented in
// docs/operations/PUBLIC-READER-PROVISIONING.md (§5).

const VIEWS_OWNER = "resonances_public_views_owner";

export interface ViewsOwnerMember {
  member: string;
  options: string; // e.g. "SET", "INHERIT SET", "SET ADMIN"
  grantor: string | null;
}

// Direct members of the views owner, as committed in the catalog (plus the
// caller's own uncommitted changes when called inside its transaction).
export async function viewsOwnerMembers(
  client: pg.Client,
): Promise<ViewsOwnerMember[]> {
  const { rows } = await client.query(
    `SELECT r.rolname AS member,
            concat_ws(' ',
              CASE WHEN m.inherit_option THEN 'INHERIT' END,
              CASE WHEN m.set_option THEN 'SET' END,
              CASE WHEN m.admin_option THEN 'ADMIN' END) AS options,
            g.rolname AS grantor
     FROM pg_catalog.pg_auth_members m
     JOIN pg_catalog.pg_roles o ON o.oid = m.roleid
     JOIN pg_catalog.pg_roles r ON r.oid = m.member
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
     WHERE o.rolname = $1
     ORDER BY r.rolname`,
    [VIEWS_OWNER],
  );
  return rows as ViewsOwnerMember[];
}

const RECOVERY_HINT =
  "inspect pg_auth_members, establish where each membership comes from, revoke it deliberately (docs/operations/PUBLIC-READER-PROVISIONING.md §5), then rerun";

// --- Exact identity of a membership row (C10) ----------------------------------
//
// A member NAME does not identify a membership: the same member can lose it and
// receive a new one (REVOKE + GRANT), keep it with other options, or hold a second
// one from another grantor. The helper therefore records the ROW it created and
// later revokes that row only if it is still exactly the same:
//   - oid, roleid, member, grantor: catalog OIDs, so a rename changes nothing,
//     while REVOKE + GRANT produces a new row with a new oid;
//   - admin/inherit/set options;
//   - rowVersion = the row's xmin. Any UPDATE of the row (GRANT changing options,
//     a direct catalog UPDATE of grantor or options) writes a new row version with
//     a new xmin, even if the values are later set back.
// Any difference makes the cleanup refuse WITHOUT revoking anything (fail-safe).

interface MembershipIdentity {
  oid: string;
  roleid: string;
  member: string;
  grantor: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
  rowVersion: string;
  // Display and statement building only; never used to decide identity.
  memberName: string;
  grantorName: string | null;
}

const IDENTITY_FIELDS = [
  "oid",
  "roleid",
  "member",
  "grantor",
  "admin",
  "inherit",
  "set",
  "rowVersion",
] as const;

async function ownerMemberships(
  client: pg.Client,
): Promise<MembershipIdentity[]> {
  const { rows } = await client.query(
    `SELECT m.oid::text AS oid, m.roleid::text AS roleid, m.member::text AS member,
            m.grantor::text AS grantor, m.admin_option AS admin,
            m.inherit_option AS inherit, m.set_option AS set,
            m.xmin::text AS "rowVersion",
            r.rolname AS "memberName", g.rolname AS "grantorName"
     FROM pg_catalog.pg_auth_members m
     JOIN pg_catalog.pg_roles r ON r.oid = m.member
     LEFT JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
     WHERE m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
     ORDER BY m.oid`,
    [VIEWS_OWNER],
  );
  return rows as MembershipIdentity[];
}

const describeIdentity = (m: MembershipIdentity) =>
  `${m.memberName} (${[
    m.inherit && "INHERIT",
    m.set && "SET",
    m.admin && "ADMIN",
  ]
    .filter(Boolean)
    .join(
      " ",
    )}; granted by ${m.grantorName ?? "?"}; oid ${m.oid}; row version ${m.rowVersion})`;

// Serialises the check-then-act steps below against EVERY membership change of
// the cluster, including sessions that ignore the advisory lock: GRANT, REVOKE,
// CREATE/DROP ROLE and direct DML all write pg_auth_members under ROW EXCLUSIVE,
// which conflicts with SHARE ROW EXCLUSIVE. Plain reads (ACCESS SHARE) are not
// blocked. pg_auth_members is a shared catalog: the lock is cluster-wide. Held
// until COMMIT/ROLLBACK; taken right after the advisory lock (deadlock rule 1).
// Requires a superuser `admin` (like the direct catalog probes of the tests).
const LOCK_MEMBERSHIPS =
  "LOCK TABLE pg_catalog.pg_auth_members IN SHARE ROW EXCLUSIVE MODE";

// Steps 1 and 2, in ONE transaction under the catalog lock: nothing can be granted
// between the check and the GRANT. Returns the identity of the rows THIS
// transaction inserted (xmin = its own transaction id), known only after COMMIT.
async function grantForMigration(
  admin: pg.Client,
  migrationRoles: readonly string[],
): Promise<MembershipIdentity[]> {
  let created: MembershipIdentity[] = [];
  await withRoleLock(admin, async () => {
    await admin.query(LOCK_MEMBERSHIPS);
    const found = await ownerMemberships(admin);
    if (found.length > 0)
      throw new Error(
        `migrateWithViewsOwner: unexpected member(s) of ${VIEWS_OWNER} before the migration: ${found.map(describeIdentity).join(", ")}. Nothing was changed: ${RECOVERY_HINT}`,
      );
    const granted: string[] = [];
    for (const role of new Set(migrationRoles)) {
      const { rows } = await admin.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (rows.length === 0)
        throw new Error(
          `migrateWithViewsOwner: unknown migration role ${role}`,
        );
      // A superuser may SET ROLE anywhere: no membership is created for it.
      if (rows[0].rolsuper) continue;
      await admin.query(
        `GRANT ${VIEWS_OWNER} TO ${quoteIdent(role)} WITH INHERIT FALSE, SET TRUE`,
      );
      granted.push(role);
    }
    if (granted.length === 0) return;
    const xid = (
      await admin.query(
        "SELECT pg_catalog.pg_current_xact_id()::xid::text AS xid",
      )
    ).rows[0].xid as string;
    const after = await ownerMemberships(admin);
    // Exactly one row per granted role, each inserted by this transaction, SET-only.
    const unexplained = after.filter(
      (m) =>
        m.rowVersion !== xid ||
        !granted.includes(m.memberName) ||
        m.admin ||
        m.inherit ||
        !m.set,
    );
    if (unexplained.length > 0 || after.length !== granted.length)
      throw new Error(
        `migrateWithViewsOwner: the created membership(s) could not be identified (${after.map(describeIdentity).join(", ")}). Nothing was changed: ${RECOVERY_HINT}`,
      );
    created = after;
  });
  // Reached only after COMMIT: these exact rows exist and are ours.
  return created;
}

// Step 4: revokes exactly the recorded rows, all or nothing, in ONE transaction
// under the catalog lock, so that nothing can change between the comparison and
// the REVOKE. Any disappearance, replacement, change of options, grantor or row
// version, or any other membership of the owner: nothing is revoked, and the
// diagnostic lists what was found.
async function revokeCreated(
  admin: pg.Client,
  created: readonly MembershipIdentity[],
): Promise<void> {
  await withRoleLock(admin, async () => {
    await admin.query(LOCK_MEMBERSHIPS);
    const current = await ownerMemberships(admin);
    const problems: string[] = [];
    for (const mine of created) {
      const now = current.find((m) => m.oid === mine.oid);
      if (now === undefined) {
        const sameMember = current.filter((m) => m.member === mine.member);
        problems.push(
          sameMember.length > 0
            ? `the membership created by this run (${describeIdentity(mine)}) was replaced by ${sameMember.map(describeIdentity).join(", ")}`
            : `the membership created by this run (${describeIdentity(mine)}) disappeared`,
        );
        continue;
      }
      const changed = IDENTITY_FIELDS.filter((f) => now[f] !== mine[f]);
      if (changed.length > 0)
        problems.push(
          `the membership created by this run changed (${changed
            .map((f) => `${f}: ${mine[f]} -> ${now[f]}`)
            .join(", ")})`,
        );
      else if (now.grantorName === null)
        problems.push(
          `the grantor of the membership created by this run (${describeIdentity(mine)}) no longer resolves to a role`,
        );
    }
    const others = current.filter(
      (m) => !created.some((mine) => mine.oid === m.oid),
    );
    if (others.length > 0)
      problems.push(
        `member(s) this run did not create, left in place: ${others.map(describeIdentity).join(", ")}`,
      );
    if (problems.length > 0)
      throw new Error(
        `migrateWithViewsOwner: cleanup refused, nothing was revoked: ${problems.join("; ")}. ${RECOVERY_HINT}`,
      );
    for (const mine of created) {
      // Current names of the OIDs just verified (a rename keeps the OID, not the
      // name). GRANTED BY targets exactly the (role, member, grantor) row, which
      // is unique.
      const now = current.find((m) => m.oid === mine.oid) as MembershipIdentity;
      await admin.query(
        `REVOKE ${VIEWS_OWNER} FROM ${quoteIdent(now.memberName)} GRANTED BY ${quoteIdent(now.grantorName as string)}`,
      );
    }
    // Postcondition in the same transaction: exactly the recorded rows are gone.
    const left = await ownerMemberships(admin);
    if (left.length > 0)
      throw new Error(
        `migrateWithViewsOwner: cleanup rolled back, unexpected state after REVOKE: ${left.map(describeIdentity).join(", ")}. ${RECOVERY_HINT}`,
      );
  });
}

// `admin` must be a superuser connected to the lock database; `run` uses its own
// connection.
export async function migrateWithViewsOwner(
  admin: pg.Client,
  migrationRoles: readonly string[],
  run: () => Promise<void>,
): Promise<void> {
  await holdRoleLock(admin, async () => {
    // Steps 1 and 2: diagnose, then grant, atomically.
    const created = await grantForMigration(admin, migrationRoles);
    let runError: unknown;
    let runFailed = false;
    try {
      await run();
    } catch (error) {
      runFailed = true;
      runError = error;
    }
    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
      await revokeCreated(admin, created);
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    // The migration error stays the primary one; a cleanup problem is never hidden.
    if (runFailed && cleanupFailed)
      throw new AggregateError(
        [runError, cleanupError],
        "migrateWithViewsOwner: the migration failed, and so did the cleanup",
      );
    if (runFailed) throw runError;
    if (cleanupFailed) throw cleanupError;
  });
}
