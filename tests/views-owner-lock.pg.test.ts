import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  holdRoleLock,
  migrateWithViewsOwner,
  provisionB1Roles,
  ROLE_LOCK_KEY,
  viewsOwnerMembers,
  withRoleLock,
  type ViewsOwnerMember,
} from "./support/b1-roles.js";

// C7/C8: the protocol that keeps the temporary membership of the views owner safe
// when test files migrate, provision and run C4 negative tests in parallel.
//
// Concurrency is made deterministic, never timed: a migration is held open with a
// gate, and the competitor is proven to be WAITING for the shared role lock (in
// pg_locks) before the gate opens. Reads made to OBSERVE an in-flight state use the
// `admin` connection without the lock on purpose; they never change anything.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );

const MIG_A = "resonances_t2_lock_migrator_a";
const MIG_B = "resonances_t2_lock_migrator_b";
const STRAY = "resonances_t2_lock_stray";
const VIEWS_OWNER = "resonances_public_views_owner";
const PROVISION_SQL = readFileSync("db/provisioning/app-reader.sql", "utf8");
const VERIFY_SQL = readFileSync(
  "db/provisioning/app-reader-verify.sql",
  "utf8",
);

// pg_locks rows of the shared role lock, as seen from a session of the lock
// database. A bigint advisory key k is shown as classid = high 32 bits,
// objid = low 32 bits, objsubid = 1; the tag also names the database.
const ROLE_LOCK_ROWS = `locktype = 'advisory' AND objsubid = 1
  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND classid = ((${ROLE_LOCK_KEY}::bigint >> 32) & 4294967295)::oid
  AND objid = (${ROLE_LOCK_KEY}::bigint & 4294967295)::oid`;

const admin = new pg.Client({ connectionString }); // fixtures and observation
const passwords = new Map<string, string>();
const databases: string[] = [];
const opened: pg.Client[] = [];
let referenceName = ""; // a database migrated by the first test, for the verification

function urlFor(db: string | null, role?: string): string {
  const url = new URL(connectionString as string);
  if (db !== null) url.pathname = "/" + db;
  if (role !== undefined) {
    url.username = role;
    url.password = passwords.get(role) ?? "";
  }
  return url.toString();
}
async function open(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  // A terminated session must not crash the test process.
  client.on("error", () => undefined);
  await client.connect();
  opened.push(client);
  return client;
}
const adminSession = () => open(urlFor(null));
const pidOf = async (client: pg.Client) =>
  (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;

async function freshDatabase(owner: string) {
  const name = "resonances_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${name}" OWNER ${owner}`);
  databases.push(name);
  return { name, migrator: await open(urlFor(name, owner)) };
}
const runMigrations = (client: pg.Client) =>
  migrate(drizzle(client), { migrationsFolder: "db/migrations" });

const names = (members: readonly ViewsOwnerMember[]) =>
  members.map((m) => `${m.member} (${m.options})`);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}
// Marks a promise as handled now; it is still awaited (and asserted) later.
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

// Condition polling: resolves once `pid` waits for the shared role lock.
async function waitUntilWaitingForRoleLock(pid: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await admin.query(
      `SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND ${ROLE_LOCK_ROWS}`,
      [pid],
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${pid} never waited for the shared role lock`);
}
const roleLockHolders = async () =>
  (
    await admin.query(
      `SELECT pid FROM pg_locks WHERE granted AND ${ROLE_LOCK_ROWS} ORDER BY pid`,
    )
  ).rows.map((r) => r.pid as number);

const migrationFailure = (pattern: RegExp) => (error: unknown) => {
  // Drizzle may wrap the PostgreSQL error: look at the error and its cause.
  const e = error as Error & { cause?: Error };
  return pattern.test(`${e.message} ${e.cause?.message ?? ""}`);
};

const verifyOn = async (client: pg.Client) => {
  try {
    await client.query(VERIFY_SQL);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
};

// Privilege coherence after a scenario, read under the shared lock (held by
// `admin`, in the lock database): no member of the views owner, and the
// operational verification passes on the migrated reference database.
async function assertCoherent() {
  const reference = await open(urlFor(referenceName));
  const [members, verify] = await holdRoleLock(admin, async () => [
    names(await viewsOwnerMembers(admin)),
    await verifyOn(reference),
  ]);
  assert.deepEqual(members, []);
  assert.equal(verify, "ok");
}

before(async () => {
  await admin.connect();
  for (const role of [MIG_A, MIG_B])
    passwords.set(role, randomBytes(18).toString("hex"));
  await withRoleLock(admin, async () => {
    for (const role of [MIG_A, MIG_B]) {
      const exists = await admin.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role}`);
      await admin.query(
        `ALTER ROLE ${role} NOSUPERUSER NOCREATEROLE LOGIN PASSWORD '${passwords.get(role)}'`,
      );
    }
  });
  await provisionB1Roles(admin, [MIG_A, MIG_B]);
});

after(async () => {
  for (const client of opened) await client.end().catch(() => undefined);
  for (const name of databases)
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

test(
  "1. a normal migration holds the membership only while it runs, SET-only, and leaves none",
  { timeout: 60_000 },
  async () => {
    const db = await freshDatabase(MIG_A);
    let during: string[] = [];
    await migrateWithViewsOwner(await adminSession(), [MIG_A], async () => {
      during = names(await viewsOwnerMembers(admin));
      await runMigrations(db.migrator);
    });
    assert.deepEqual(during, [`${MIG_A} (SET)`]);
    const check = await db.migrator.query(
      "SELECT to_regnamespace('public_read')::text AS schema",
    );
    assert.equal(check.rows[0].schema, "public_read");
    referenceName = db.name;
    await assertCoherent();
  },
);

test(
  "1b. advisory locks are per database: the helpers refuse to take the role lock elsewhere",
  { timeout: 60_000 },
  async () => {
    const other = await open(urlFor(referenceName));
    await holdRoleLock(admin, async () => {
      // The pitfall: the "same" key, in another database, is granted at once.
      assert.equal(
        (
          await other.query(
            `SELECT pg_try_advisory_xact_lock(${ROLE_LOCK_KEY}) AS got`,
          )
        ).rows[0].got,
        true,
      );
    });
    // The guard: such a lock would exclude nothing, so the helpers refuse it.
    for (const attempt of [
      () => withRoleLock(other, async () => undefined),
      () => holdRoleLock(other, async () => undefined),
      () => migrateWithViewsOwner(other, [], async () => undefined),
    ]) {
      await assert.rejects(attempt(), /advisory locks are per database/);
    }
  },
);

test(
  "2. two concurrent migrations are serialised: the second waits, then meets no foreign member",
  { timeout: 60_000 },
  async () => {
    const a = await freshDatabase(MIG_A);
    const b = await freshDatabase(MIG_B);
    const adminB = await adminSession();
    const pidB = await pidOf(adminB);
    const entered = gate();
    const release = gate();
    let duringB: string[] = [];
    const first = handled(
      migrateWithViewsOwner(await adminSession(), [MIG_A], async () => {
        entered.open();
        await release.opened;
        await runMigrations(a.migrator);
      }),
    );
    await entered.opened;
    const second = handled(
      migrateWithViewsOwner(adminB, [MIG_B], async () => {
        duringB = names(await viewsOwnerMembers(admin));
        await runMigrations(b.migrator);
      }),
    );
    await waitUntilWaitingForRoleLock(pidB);
    assert.deepEqual(names(await viewsOwnerMembers(admin)), [`${MIG_A} (SET)`]);
    release.open();
    await Promise.all([first, second]);
    // A's membership was revoked before B granted its own.
    assert.deepEqual(duringB, [`${MIG_B} (SET)`]);
    await assertCoherent();
  },
);

test(
  "3. provisioning waits for a running migration instead of failing on its membership",
  { timeout: 60_000 },
  async () => {
    const db = await freshDatabase(MIG_A);
    const provisioner = await adminSession();
    const pidP = await pidOf(provisioner);
    const entered = gate();
    const release = gate();
    const migration = handled(
      migrateWithViewsOwner(await adminSession(), [MIG_A], async () => {
        entered.open();
        await release.opened;
        await runMigrations(db.migrator);
      }),
    );
    await entered.opened;
    // The C7 hazard itself: read OUTSIDE the protocol, the provisioning file meets the
    // migration's temporary membership and refuses it (it changes nothing when it fails).
    await assert.rejects(
      admin.query(PROVISION_SQL),
      new RegExp(
        `unauthorized member\\(s\\) of ${VIEWS_OWNER}: ${MIG_A} \\(SET\\)`,
      ),
    );
    // Inside the protocol, it waits for the migration to finish, then succeeds.
    const provisioning = handled(provisionB1Roles(provisioner));
    await waitUntilWaitingForRoleLock(pidP);
    release.open();
    await Promise.all([migration, provisioning]);
    await assertCoherent();
  },
);

test(
  "4. a rolled-back C4 negative change and a migration never overlap, in either order",
  { timeout: 60_000 },
  async () => {
    const negative = await adminSession();
    const migrationAdmin = await adminSession();

    // Order 1: the negative test holds the lock with an uncommitted foreign member.
    const first = await freshDatabase(MIG_B);
    const pidM = await pidOf(migrationAdmin);
    let migration: Promise<void> | undefined;
    await negative.query("BEGIN");
    try {
      await negative.query(`SELECT pg_advisory_xact_lock(${ROLE_LOCK_KEY})`);
      await negative.query(`CREATE ROLE ${STRAY} NOLOGIN`);
      await negative.query(
        `GRANT ${VIEWS_OWNER} TO ${STRAY} WITH INHERIT FALSE, SET TRUE`,
      );
      migration = handled(
        migrateWithViewsOwner(migrationAdmin, [MIG_B], () =>
          runMigrations(first.migrator),
        ),
      );
      await waitUntilWaitingForRoleLock(pidM);
    } finally {
      await negative.query("ROLLBACK");
    }
    await migration; // its preflight met neither the stray role nor its membership

    // Order 2: the migration holds the membership; the negative test waits.
    const second = await freshDatabase(MIG_A);
    const pidN = await pidOf(negative);
    const entered = gate();
    const release = gate();
    const held = handled(
      migrateWithViewsOwner(migrationAdmin, [MIG_A], async () => {
        entered.open();
        await release.opened;
        await runMigrations(second.migrator);
      }),
    );
    await entered.opened;
    await negative.query("BEGIN");
    try {
      const locked = handled(
        negative.query(`SELECT pg_advisory_xact_lock(${ROLE_LOCK_KEY})`),
      );
      await waitUntilWaitingForRoleLock(pidN);
      release.open();
      await held;
      await locked;
      // The negative test starts from a clean state, then sees only its own change.
      assert.deepEqual(names(await viewsOwnerMembers(negative)), []);
      await negative.query(`CREATE ROLE ${STRAY} NOLOGIN`);
      await negative.query(
        `GRANT ${VIEWS_OWNER} TO ${STRAY} WITH INHERIT FALSE, SET TRUE`,
      );
      assert.deepEqual(names(await viewsOwnerMembers(negative)), [
        `${STRAY} (SET)`,
      ]);
    } finally {
      await negative.query("ROLLBACK");
    }
    await assertCoherent();
  },
);

// Scenarios 5, 6b and 7 COMMIT a foreign membership. They hold the shared lock at
// session level for their whole duration, so no other test file can meet it; the
// helper runs on that same session, where the key is re-entrant.

test(
  "5. an unexpected pre-existing membership is reported, never revoked, and nothing is granted",
  { timeout: 60_000 },
  async () => {
    const db = await freshDatabase(MIG_A);
    const holder = await adminSession();
    await holder.query(`SELECT pg_advisory_lock(${ROLE_LOCK_KEY})`);
    try {
      await withRoleLock(holder, async () => {
        await holder.query(`CREATE ROLE ${STRAY} NOLOGIN`);
        await holder.query(
          `GRANT ${VIEWS_OWNER} TO ${STRAY} WITH INHERIT FALSE, SET TRUE`,
        );
      });
      let ran = false;
      await assert.rejects(
        migrateWithViewsOwner(holder, [MIG_A], async () => {
          ran = true;
          await runMigrations(db.migrator);
        }),
        new RegExp(
          `unexpected member\\(s\\) of ${VIEWS_OWNER} before the migration: ${STRAY} \\(SET; granted by [^)]+\\)\\. Nothing was changed`,
        ),
      );
      assert.equal(ran, false);
      // Kept as found; the migration identity was not granted anything.
      assert.deepEqual(names(await viewsOwnerMembers(holder)), [
        `${STRAY} (SET)`,
      ]);
      // The helper released only its own hold: this session still has the lock.
      assert.deepEqual(await roleLockHolders(), [await pidOf(holder)]);
    } finally {
      // Origin demonstrated (this test created it): this test removes it.
      await withRoleLock(holder, async () => {
        await holder.query(`DROP ROLE IF EXISTS ${STRAY}`);
      });
      await holder.query(`SELECT pg_advisory_unlock(${ROLE_LOCK_KEY})`);
    }
    await assertCoherent();
  },
);

test(
  "6a. a failing migration keeps its own error and revokes the membership it created",
  { timeout: 60_000 },
  async () => {
    const db = await freshDatabase(MIG_A);
    // A real failure of 0002, confined to this database: tables created by the
    // migrator grant SELECT to the views owner by default, which the 0002
    // preflight refuses (C5); the first one it meets may be Drizzle's journal
    // table, also created by the migrator. The migration transaction rolls back.
    const dbAdmin = await open(urlFor(db.name));
    await dbAdmin.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIG_A} GRANT SELECT ON TABLES TO ${VIEWS_OWNER}`,
    );
    let during: string[] = [];
    await assert.rejects(
      migrateWithViewsOwner(await adminSession(), [MIG_A], async () => {
        during = names(await viewsOwnerMembers(admin));
        await runMigrations(db.migrator);
      }),
      migrationFailure(/T2: the views owner has an unauthorized SELECT on /),
    );
    assert.deepEqual(during, [`${MIG_A} (SET)`]);
    const left = await dbAdmin.query(
      `SELECT to_regclass('public.publications')::text AS t,
            to_regnamespace('public_read')::text AS s`,
    );
    assert.deepEqual(left.rows[0], { t: null, s: null });
    await assertCoherent();
  },
);

test(
  "6b. a membership the run did not create blocks the whole cleanup: nothing is revoked, everything is reported",
  { timeout: 60_000 },
  async () => {
    const db = await freshDatabase(MIG_B);
    const holder = await adminSession();
    await holder.query(`SELECT pg_advisory_lock(${ROLE_LOCK_KEY})`);
    try {
      await assert.rejects(
        migrateWithViewsOwner(holder, [MIG_B], async () => {
          await runMigrations(db.migrator);
          // Appears outside the helper's knowledge while it runs.
          await withRoleLock(holder, async () => {
            await holder.query(`CREATE ROLE ${STRAY} NOLOGIN`);
            await holder.query(
              `GRANT ${VIEWS_OWNER} TO ${STRAY} WITH INHERIT FALSE, SET TRUE`,
            );
          });
        }),
        new RegExp(
          `cleanup refused, nothing was revoked: member\\(s\\) this run did not create, left in place: ${STRAY} \\(SET;`,
        ),
      );
      // C10: the state is frozen for a human, the run's own grant included.
      assert.deepEqual(names(await viewsOwnerMembers(holder)), [
        `${MIG_B} (SET)`,
        `${STRAY} (SET)`,
      ]);
    } finally {
      await removeOwnerMemberships(holder);
      await holder.query(`SELECT pg_advisory_unlock(${ROLE_LOCK_KEY})`);
    }
    await assertCoherent();
  },
);

// --- C10: the cleanup revokes the exact row it created, or nothing ---------------
//
// A `rogue` session plays an administrator who IGNORES the advisory lock: it never
// takes it. The holder keeps the shared lock for the whole scenario so that no
// other test file meets the committed changes, runs the helper on that same
// session (re-entrant key) and removes everything afterwards (origin established:
// this test made the changes).

// Test cleanup only: revokes every membership of the views owner, rows granted
// through ADMIN OPTION first, then drops the stray role. Caller holds the lock.
async function removeOwnerMemberships(session: pg.Client) {
  await withRoleLock(session, async () => {
    const { rows } = await session.query(
      `SELECT r.rolname AS member, g.rolname AS grantor
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.grantor
       WHERE m.roleid = $1::regrole ORDER BY m.admin_option, m.oid`,
      [VIEWS_OWNER],
    );
    for (const row of rows)
      await session.query(
        `REVOKE ${VIEWS_OWNER} FROM "${row.member}" GRANTED BY "${row.grantor}" CASCADE`,
      );
    await session.query(`DROP ROLE IF EXISTS ${STRAY}`);
  });
}

async function cleanupRefusedAfter(
  tamper: (rogue: pg.Client) => Promise<void>,
  expected: RegExp,
  membersLeft: string[],
  restore: (rogue: pg.Client) => Promise<void> = async () => undefined,
) {
  const holder = await adminSession();
  const rogue = await adminSession();
  await holdRoleLock(holder, async () => {
    try {
      await assert.rejects(
        migrateWithViewsOwner(holder, [MIG_A], () => tamper(rogue)),
        (error: Error) => {
          assert.match(error.message, /cleanup refused, nothing was revoked/);
          assert.match(error.message, expected);
          return true;
        },
      );
      // Nothing was revoked: what the rogue left is still there.
      assert.deepEqual(names(await viewsOwnerMembers(holder)), membersLeft);
    } finally {
      await restore(rogue);
      await removeOwnerMemberships(holder);
    }
  });
  await assertCoherent();
}

test(
  "8a. C10: a membership replaced by another one with the same member name is not revoked",
  { timeout: 60_000 },
  async () => {
    await cleanupRefusedAfter(
      async (rogue) => {
        // Same member, same options, same grantor: only the row (oid) is new.
        await rogue.query(`REVOKE ${VIEWS_OWNER} FROM ${MIG_A}`);
        await rogue.query(
          `GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT FALSE, SET TRUE`,
        );
      },
      new RegExp(
        `membership created by this run \\(${MIG_A} \\(SET; [^)]*\\)\\) was replaced by ${MIG_A} \\(SET;`,
      ),
      [`${MIG_A} (SET)`],
    );
  },
);

test(
  "8b. C10: a membership whose options changed is not revoked",
  { timeout: 60_000 },
  async () => {
    await cleanupRefusedAfter(
      (rogue) =>
        rogue
          .query(`GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT TRUE`)
          .then(() => undefined),
      /changed \(inherit: false -> true, rowVersion: \d+ -> \d+\)/,
      [`${MIG_A} (INHERIT SET)`],
    );
  },
);

test(
  "8c. C10: options changed then set back still count as a change (row version)",
  { timeout: 60_000 },
  async () => {
    await cleanupRefusedAfter(
      async (rogue) => {
        await rogue.query(`GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT TRUE`);
        await rogue.query(
          `GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT FALSE`,
        );
      },
      /changed \(rowVersion: \d+ -> \d+\)/,
      [`${MIG_A} (SET)`],
    );
  },
);

test(
  "8d. C10: a grantor changed in place (direct catalog UPDATE, superuser only) is detected",
  { timeout: 60_000 },
  async () => {
    // GRANT and REVOKE can never change the grantor of an existing row: a grant
    // from another grantor is ANOTHER row (8e). In place, only a superuser
    // writing the catalog directly can do it.
    let original = "";
    await cleanupRefusedAfter(
      async (rogue) => {
        original = (
          await rogue.query(
            `SELECT grantor::text AS grantor FROM pg_catalog.pg_auth_members
             WHERE roleid = $1::regrole AND member = $2::regrole`,
            [VIEWS_OWNER, MIG_A],
          )
        ).rows[0].grantor as string;
        await rogue.query(
          `UPDATE pg_catalog.pg_auth_members SET grantor = $2::regrole
           WHERE roleid = $1::regrole AND member = $3::regrole`,
          [VIEWS_OWNER, MIG_B, MIG_A],
        );
      },
      /changed \(grantor: \d+ -> \d+, rowVersion: \d+ -> \d+\)/,
      [`${MIG_A} (SET)`],
      // Put the original grantor back before the test's own REVOKE.
      async (rogue) => {
        if (original === "") return;
        await rogue.query(
          `UPDATE pg_catalog.pg_auth_members SET grantor = $2::oid
           WHERE roleid = $1::regrole AND member = $3::regrole`,
          [VIEWS_OWNER, original, MIG_A],
        );
      },
    );
  },
);

test(
  "8e. C10: a second membership of the same member from another grantor blocks the cleanup",
  { timeout: 60_000 },
  async () => {
    await cleanupRefusedAfter(
      async (rogue) => {
        // GRANTED BY requires a grantor holding ADMIN OPTION on the owner.
        await rogue.query(`CREATE ROLE ${STRAY} NOLOGIN`);
        await rogue.query(`GRANT ${VIEWS_OWNER} TO ${STRAY} WITH ADMIN OPTION`);
        await rogue.query(
          `GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT FALSE, SET TRUE GRANTED BY ${STRAY}`,
        );
      },
      new RegExp(
        `did not create, left in place: .*${MIG_A} \\(SET; granted by ${STRAY};`,
      ),
      // One line per row: MIG_A now holds two memberships.
      [`${MIG_A} (SET)`, `${MIG_A} (SET)`, `${STRAY} (INHERIT SET ADMIN)`],
    );
  },
);

test(
  "8f. C10: a membership that disappeared is reported, and nothing else is touched",
  { timeout: 60_000 },
  async () => {
    await cleanupRefusedAfter(
      (rogue) =>
        rogue
          .query(`REVOKE ${VIEWS_OWNER} FROM ${MIG_A}`)
          .then(() => undefined),
      new RegExp(
        `membership created by this run \\(${MIG_A} \\(SET; [^)]*\\)\\) disappeared`,
      ),
      [],
    );
  },
);

test(
  "8g. C10: the cleanup waits for an in-flight non-cooperative change, then judges the committed state",
  { timeout: 60_000 },
  async () => {
    // The rogue opens a transaction that changes the run's membership and keeps it
    // open. The cleanup's catalog lock must wait for it: the comparison can only
    // see the outcome, never a state about to change.
    for (const outcome of ["ROLLBACK", "COMMIT"] as const) {
      const holder = await adminSession();
      const rogue = await adminSession();
      const holderPid = await pidOf(holder);
      const roguePid = await pidOf(rogue);
      await holdRoleLock(holder, async () => {
        try {
          const pending = handled(
            migrateWithViewsOwner(holder, [MIG_A], async () => {
              await rogue.query("BEGIN");
              await rogue.query(
                `GRANT ${VIEWS_OWNER} TO ${MIG_A} WITH INHERIT TRUE`,
              );
            }),
          );
          // The rogue does not know the advisory lock; the catalog lock stops the
          // cleanup until the rogue's transaction ends.
          for (let attempt = 0; ; attempt++) {
            const { rows } = await admin.query(
              "SELECT $2::int = ANY (pg_blocking_pids($1)) AS blocked",
              [holderPid, roguePid],
            );
            if (rows[0].blocked) break;
            if (attempt > 400)
              throw new Error("the cleanup never waited for the rogue");
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await rogue.query(outcome);
          if (outcome === "ROLLBACK") {
            // Unchanged row: the normal cleanup revokes it.
            await pending;
            assert.deepEqual(names(await viewsOwnerMembers(holder)), []);
          } else {
            await assert.rejects(
              pending,
              /cleanup refused, nothing was revoked: the membership created by this run changed \(inherit: false -> true/,
            );
            assert.deepEqual(names(await viewsOwnerMembers(holder)), [
              `${MIG_A} (INHERIT SET)`,
            ]);
          }
        } finally {
          await rogue.query("ROLLBACK").catch(() => undefined);
          await removeOwnerMemberships(holder);
        }
      });
      await assertCoherent();
    }
  },
);

test(
  "8h. C10: the grant step waits for an in-flight non-cooperative grant, then refuses without granting",
  { timeout: 60_000 },
  async () => {
    const holder = await adminSession();
    const rogue = await adminSession();
    const holderPid = await pidOf(holder);
    const roguePid = await pidOf(rogue);
    await holdRoleLock(holder, async () => {
      try {
        await rogue.query("BEGIN");
        await rogue.query(`CREATE ROLE ${STRAY} NOLOGIN`);
        await rogue.query(
          `GRANT ${VIEWS_OWNER} TO ${STRAY} WITH INHERIT FALSE, SET TRUE`,
        );
        let ran = false;
        const pending = handled(
          migrateWithViewsOwner(holder, [MIG_A], async () => {
            ran = true;
          }),
        );
        for (let attempt = 0; ; attempt++) {
          const { rows } = await admin.query(
            "SELECT $2::int = ANY (pg_blocking_pids($1)) AS blocked",
            [holderPid, roguePid],
          );
          if (rows[0].blocked) break;
          if (attempt > 400)
            throw new Error("the grant step never waited for the rogue");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await rogue.query("COMMIT");
        await assert.rejects(
          pending,
          new RegExp(
            `unexpected member\\(s\\) of ${VIEWS_OWNER} before the migration: ${STRAY} \\(SET;.*Nothing was changed`,
          ),
        );
        assert.equal(ran, false);
        assert.deepEqual(names(await viewsOwnerMembers(holder)), [
          `${STRAY} (SET)`,
        ]);
      } finally {
        await rogue.query("ROLLBACK").catch(() => undefined);
        await removeOwnerMemberships(holder);
      }
    });
    await assertCoherent();
  },
);

test(
  "7. brutal interruption: the session's lock is released, its committed grant is not; recovery is manual",
  { timeout: 60_000 },
  async (t) => {
    const victim = await adminSession();
    const victimPid = await pidOf(victim);
    // The holder takes over the lock when the victim dies, so that the leftover
    // membership is never met by another test file. It is in the lock database;
    // the verification runs on the reference database while it holds the lock.
    const holder = await adminSession();
    const holderPid = await pidOf(holder);
    const reference = await open(urlFor(referenceName));
    const entered = gate();
    const resume = gate();
    // The run body stands for a migration process that dies with its session: once
    // resumed it does nothing more, so the helper goes straight to its cleanup.
    const interrupted = handled(
      migrateWithViewsOwner(victim, [MIG_B], async () => {
        entered.open();
        await resume.opened;
      }),
    );
    await entered.opened; // MIG_B is now a committed member
    const holderLock = handled(
      holder.query(`SELECT pg_advisory_lock(${ROLE_LOCK_KEY})`),
    );
    await waitUntilWaitingForRoleLock(holderPid);
    // pg_blocking_pids lists the holder of the lock AND the waiters queued ahead.
    // Kill only if the holder is next in line; otherwise another test file would
    // be granted the lock first and meet the leftover membership.
    const ahead = (
      await admin.query("SELECT pg_blocking_pids($1) AS pids", [holderPid])
    ).rows[0].pids as number[];
    if (ahead.length !== 1 || ahead[0] !== victimPid) {
      resume.open();
      await interrupted;
      await holderLock;
      await holder.query(`SELECT pg_advisory_unlock(${ROLE_LOCK_KEY})`);
      t.skip("another session was queued for the role lock; not interrupted");
      return;
    }

    await admin.query("SELECT pg_terminate_backend($1)", [victimPid]);
    await holderLock; // granted to the holder, first in line
    resume.open();
    // The helper's cleanup cannot run on a dead connection.
    await assert.rejects(interrupted);
    try {
      // The end of the session released the victim's lock...
      assert.deepEqual(await roleLockHolders(), [holderPid]);
      // ...but did not undo its committed GRANT.
      assert.deepEqual(names(await viewsOwnerMembers(holder)), [
        `${MIG_B} (SET)`,
      ]);
      // The next run refuses before changing anything, and the verification fails.
      let ran = false;
      await assert.rejects(
        migrateWithViewsOwner(holder, [MIG_A], async () => {
          ran = true;
        }),
        new RegExp(
          `unexpected member\\(s\\) of ${VIEWS_OWNER}.*${MIG_B} \\(SET;`,
        ),
      );
      assert.equal(ran, false);
      assert.match(
        await verifyOn(reference),
        new RegExp(`unauthorized member\\(s\\) of ${VIEWS_OWNER}: ${MIG_B}`),
      );

      // Manual recovery (docs/operations/PUBLIC-READER-PROVISIONING.md §5):
      // 1. nobody else holds the lock, so no migration is running;
      assert.deepEqual(await roleLockHolders(), [holderPid]);
      // 2. the member is the interrupted run's migration identity, SET-only;
      const found = await viewsOwnerMembers(holder);
      assert.deepEqual(names(found), [`${MIG_B} (SET)`]);
      // 3. revoke that membership deliberately, by name;
      await withRoleLock(holder, async () => {
        await holder.query(`REVOKE ${VIEWS_OWNER} FROM ${MIG_B}`);
      });
      // 4. the verification passes again.
      assert.equal(await verifyOn(reference), "ok");
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${ROLE_LOCK_KEY})`);
    }
    await assertCoherent();
  },
);
