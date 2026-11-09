import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import { provisionB1Roles, migrateWithViewsOwner } from "./support/b1-roles.js";
import type {
  ConflictOperation,
  ImportOperation,
} from "../src/editorial/operations.js";
import type { LoadedSources } from "../src/editorial/source-loader.js";
import {
  DryRunTransactionError,
  runDryRun,
  type DryRunResult,
} from "../src/services/editorial-dry-run.js";
import { ID, publicationDoc, reflectionDoc } from "./support/plan-sources.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );
const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
let created = false;
// `seed` writes in autocommit, as a separate connection (also the concurrent
// writer). `pool` has a single connection and is the one the service uses, so
// a leaked connection would make the next call hang.
let seed: pg.Client;
let pool: pg.Pool;
let db: NodePgDatabase;

// Statement spy on the pool's only connection. It records the SQL text that
// Drizzle sends and lets a test run extra statements or replace one.
type Direct = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
type Hook = (
  text: string,
  direct: Direct,
) => Promise<string | void> | string | void;
let recorded: string[] = [];
let hook: Hook | undefined;
let testUrl: string;

// Wraps the query method of every connection the pool creates.
function instrument(target: pg.Pool): pg.Pool {
  target.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = async (
      ...args: unknown[]
    ) => {
      const first = args[0] as string | { text: string };
      const text = typeof first === "string" ? first : first.text;
      recorded.push(text);
      const replacement = hook
        ? await hook(text, (t, v) => original(t, v))
        : undefined;
      return typeof replacement === "string"
        ? original(replacement)
        : original(...args);
    };
  });
  return target;
}

before(async () => {
  await admin.connect();
  await provisionB1Roles(admin);
  await admin.query('CREATE DATABASE "' + database + '"');
  created = true;
  const url = new URL(connectionString);
  url.pathname = "/" + database;
  seed = new pg.Client({ connectionString: url.toString() });
  await seed.connect();
  await migrateWithViewsOwner(admin, [], () =>
    migrate(drizzle(seed), { migrationsFolder: "db/migrations" }),
  );
  testUrl = url.toString();
  // idleTimeoutMillis 0: an idle connection is never evicted, so the
  // `idleCount` assertions do not depend on how fast the run is.
  pool = instrument(
    new pg.Pool({ connectionString: testUrl, max: 1, idleTimeoutMillis: 0 }),
  );
  db = drizzle(pool);
  // A real server error with the SQLSTATE of the caller's choice.
  await seed.query(`CREATE FUNCTION raise_sqlstate(code text) RETURNS int
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected' USING ERRCODE = code;
    END $$`);
});
after(async () => {
  await pool?.end();
  await seed?.end();
  if (created) await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
});

const loaded = (
  sources: LoadedSources["sources"],
  loadErrors: LoadedSources["loadErrors"] = [],
): LoadedSources => ({ sources, loadErrors });

// Every row of the six business tables, with the row version (xmin), so that
// even a rewrite of identical values would be seen as a change.
async function fingerprint() {
  const tables = [
    "themes",
    "media_assets",
    "publications",
    "reflections",
    "publication_themes",
    "reflection_themes",
  ];
  const parts: unknown[] = [];
  for (const table of tables)
    parts.push(
      (await seed.query(`SELECT xmin::text, * FROM ${table} ORDER BY 2`)).rows,
    );
  return JSON.stringify(parts);
}

// Runs the service with a clean spy and checks that no business data changed.
async function observe(
  sources: LoadedSources,
  spy?: Hook,
  // False only for a test whose own hook writes through another connection.
  expectUnchanged = true,
): Promise<{ result: DryRunResult; statements: string[] }> {
  const before = await fingerprint();
  recorded = [];
  hook = spy;
  let result: DryRunResult;
  try {
    result = await runDryRun(db, sources);
  } finally {
    hook = undefined;
  }
  const statements = recorded;
  recorded = [];
  if (expectUnchanged)
    assert.equal(await fingerprint(), before, "business data changed");
  return { result, statements };
}

async function insertTheme(slug: string) {
  const id = randomUUID();
  await seed.query(
    "INSERT INTO themes (id, locale, name, slug) VALUES ($1, 'fr', $2, $2)",
    [id, slug],
  );
  return id;
}
async function insertMedia(id: string) {
  await seed.query(
    `INSERT INTO media_assets (id, original_url, alt_text, source, license)
     VALUES ($1, $2, 'Alt', 'Source', 'CC0')`,
    [id, "https://example.test/" + id + ".jpg"],
  );
}
// A draft publication equal to publicationDoc({id, slug}): its plan is a NOOP.
async function insertDraft(id: string, slug: string, title = "Titre") {
  await seed.query(
    `INSERT INTO publications (id, locale, slug, title, status)
     VALUES ($1, 'fr', $2, $3, 'draft')`,
    [id, slug, title],
  );
}

const planOf = (result: DryRunResult) => {
  assert.equal(result.status, "PLANNED", JSON.stringify(result));
  if (result.status !== "PLANNED") throw new Error("unreachable");
  return result.plan;
};
const outcome = (operations: readonly ImportOperation[], file: string) => {
  const operation = operations.find((o) => o.file === file);
  assert.ok(operation, "no operation for " + file);
  return operation.kind === "CONFLICT"
    ? (operation as ConflictOperation).diagnostics.map((d) => d.code)
    : operation.kind;
};

test("the service runs one root transaction REPEATABLE READ READ ONLY, proven by SQL", async () => {
  const doc = publicationDoc({
    id: randomUUID(),
    slug: "tx-" + randomUUID().slice(0, 8),
  });
  const probes: Record<string, unknown>[] = [];
  const { result, statements } = await observe(
    loaded([doc]),
    async (text, direct) => {
      if (/^select/i.test(text) && /from "publications"/.test(text)) {
        // Run inside the service's own transaction, on its connection.
        probes.push(
          (
            await direct(
              `SELECT current_setting('transaction_isolation') AS isolation,
                      current_setting('transaction_read_only') AS read_only,
                      pg_current_xact_id_if_assigned() AS xid`,
            )
          ).rows[0],
        );
      }
      if (/^commit/i.test(text)) {
        probes.push(
          (
            await direct(
              "SELECT pg_current_xact_id_if_assigned() AS xid, current_setting('transaction_read_only') AS read_only",
            )
          ).rows[0],
        );
      }
    },
  );
  assert.equal(planOf(result).operations.length, 1);

  assert.match(
    statements[0]!,
    /^begin isolation level repeatable read read only/i,
  );
  assert.match(statements[1]!, /current_setting\('transaction_isolation'\)/);
  assert.match(statements.at(-1)!, /^commit/i);
  // Exactly one transaction, and no savepoint or nested transaction.
  assert.equal(statements.filter((s) => /^begin/i.test(s)).length, 1);
  assert.equal(
    statements.filter((s) => /^(savepoint|release|rollback)/i.test(s)).length,
    0,
  );
  // Between BEGIN and COMMIT only plain SELECTs, none with a row-lock clause.
  for (const text of statements.slice(1, -1)) {
    assert.match(text.trimStart(), /^select\b/i, text);
    assert.doesNotMatch(
      text,
      /\bfor\s+(update|share|key\s+share|no\s+key\s+update)\b/i,
    );
    // A SELECT can still take a lock through a function call.
    assert.doesNotMatch(text, /pg_(try_)?advisory/i);
  }
  assert.deepEqual(probes[0], {
    isolation: "repeatable read",
    read_only: "on",
    xid: null,
  });
  // At the end no transaction id was ever assigned: nothing was written.
  assert.deepEqual(probes.at(-1), { xid: null, read_only: "on" });
});

test("the snapshot ignores writes committed by another session during the plan", async () => {
  const unchanged = randomUUID();
  const unchangedSlug = "snap-a-" + randomUUID().slice(0, 8);
  const freeSlug = "snap-b-" + randomUUID().slice(0, 8);
  await insertDraft(unchanged, unchangedSlug);
  const docs = [
    publicationDoc({ id: unchanged, slug: unchangedSlug }),
    publicationDoc({ id: randomUUID(), slug: freeSlug }),
  ];

  let injected = false;
  const first = await observe(
    loaded(docs),
    async (text) => {
      if (injected || !/from "publications"/.test(text)) return;
      injected = true;
      // Committed by another connection after the snapshot was taken: a changed
      // title on a row the plan reads, and a new owner for a slug it checks.
      await seed.query(
        "UPDATE publications SET title = 'Changé' WHERE id = $1",
        [unchanged],
      );
      await insertDraft(randomUUID(), freeSlug);
    },
    false,
  );
  assert.ok(injected);
  const snapshotPlan = planOf(first.result);
  assert.equal(outcome(snapshotPlan.operations, docs[0]!.file), "NOOP");
  assert.equal(outcome(snapshotPlan.operations, docs[1]!.file), "CREATE");
  assert.equal(snapshotPlan.applicable, true);

  // The writes were really committed: a later dry-run sees them.
  const later = planOf((await observe(loaded(docs))).result);
  assert.equal(outcome(later.operations, docs[0]!.file), "UPDATE");
  assert.deepEqual(outcome(later.operations, docs[1]!.file), [
    "SLUG_COLLISION",
  ]);
  assert.equal(later.applicable, false);
});

test("a write attempted inside the service transaction is rejected by PostgreSQL", async () => {
  const doc = publicationDoc({
    id: randomUUID(),
    slug: "ro-" + randomUUID().slice(0, 8),
  });
  const attempts: string[] = [];
  const { result } = await observe(loaded([doc]), async (text, direct) => {
    if (attempts.length > 0 || !/from "publications"/.test(text)) return;
    // The test (not the service) uses a savepoint to survive the rejection.
    await direct("SAVEPOINT write_attempt");
    for (const statement of [
      "INSERT INTO themes (id, locale, name, slug) VALUES (gen_random_uuid(), 'fr', 'x', 'x')",
      "UPDATE publications SET title = 'x'",
      "DELETE FROM publications",
      "CREATE TABLE should_not_exist (a int)",
    ]) {
      try {
        await direct(statement);
        attempts.push("ACCEPTED: " + statement);
      } catch (error) {
        attempts.push((error as pg.DatabaseError).code ?? "no code");
      }
      await direct("ROLLBACK TO SAVEPOINT write_attempt");
    }
  });
  assert.equal(planOf(result).operations.length, 1);
  // 25006 = read_only_sql_transaction
  assert.deepEqual(attempts, ["25006", "25006", "25006", "25006"]);
});

test("the service holds no explicit lock: only ordinary relation locks", async () => {
  const mediaId = randomUUID();
  await insertMedia(mediaId);
  const doc = publicationDoc({
    id: randomUUID(),
    slug: "lock-" + randomUUID().slice(0, 8),
    media: mediaId,
  });
  let modes: string[] = [];
  const { result } = await observe(loaded([doc]), async (text, direct) => {
    if (!/^commit/i.test(text)) return;
    modes = (
      await direct(
        `SELECT DISTINCT mode FROM pg_locks
         WHERE pid = pg_backend_pid() AND granted
           AND locktype IN ('relation', 'page', 'tuple', 'advisory')`,
      )
    ).rows.map((row) => row.mode);
  });
  planOf(result);
  assert.ok(modes.includes("AccessShareLock"), "the probe saw no lock at all");
  // No RowShareLock (FOR SHARE/KEY SHARE/UPDATE), no SIReadLock and, since the
  // probe includes them, no advisory lock.
  assert.deepEqual(modes, ["AccessShareLock"]);
});

test("a PostgreSQL error rolls back, releases the connection and is not retried", async () => {
  const mediaId = randomUUID();
  await insertMedia(mediaId);
  const doc = publicationDoc({
    id: randomUUID(),
    slug: "fail-" + randomUUID().slice(0, 8),
    media: mediaId,
  });
  const { result, statements } = await observe(
    loaded([doc]),
    // A real server error in the middle of the plan.
    (text) =>
      /from "media_assets"/.test(text)
        ? "SELECT raise_sqlstate('40001')"
        : undefined,
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.code, "DATABASE_ERROR");
  assert.match(result.message, /SQLSTATE 40001/);
  for (const secret of [mediaId, "media_assets", "Failed query", "params"])
    assert.ok(!result.message.includes(secret), "leaked: " + secret);

  assert.equal(statements.filter((s) => /^begin/i.test(s)).length, 1);
  assert.equal(statements.filter((s) => /^rollback/i.test(s)).length, 1);
  assert.equal(statements.filter((s) => /^commit/i.test(s)).length, 0);

  // The single pooled connection is back, idle and usable (a leak would hang).
  assert.equal(pool.idleCount, 1);
  assert.equal(pool.waitingCount, 0);
  const alive = await Promise.race([
    db.execute(sql`SELECT 1 AS ok`),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("connection not released")), 5000),
    ),
  ]);
  assert.ok(alive);
  // It is not left inside an aborted transaction either.
  const state = await db.execute<{ in_tx: boolean }>(
    sql`SELECT (now() = statement_timestamp()) AS in_tx`,
  );
  assert.equal(state.rows[0]!.in_tx, true);
});

test("applicable and non applicable plans are PLANNED, with no business change", async () => {
  const themeSlug = "memoire";
  await insertTheme(themeSlug);
  await insertMedia(ID.media);
  const takenSlug = "owned-" + randomUUID().slice(0, 8);
  await insertDraft(randomUUID(), takenSlug);

  const good = [
    publicationDoc({
      id: randomUUID(),
      status: "published",
      slug: "ok-" + randomUUID().slice(0, 8),
    }),
    reflectionDoc({
      id: randomUUID(),
      slug: "ok-r-" + randomUUID().slice(0, 8),
    }),
  ];
  const applicable = planOf((await observe(loaded(good))).result);
  assert.equal(applicable.applicable, true);
  assert.deepEqual(
    good.map((d) => outcome(applicable.operations, d.file)),
    ["CREATE", "CREATE"],
  );

  const colliding = publicationDoc({ id: randomUUID(), slug: takenSlug });
  const conflicting = planOf(
    (await observe(loaded([...good, colliding]))).result,
  );
  assert.equal(conflicting.applicable, false);
  assert.deepEqual(outcome(conflicting.operations, colliding.file), [
    "SLUG_COLLISION",
  ]);
  // The other documents stay informative CREATEs although the batch is blocked.
  assert.equal(outcome(conflicting.operations, good[0]!.file), "CREATE");
});

test("load diagnostics make an otherwise applicable plan non applicable", async () => {
  const doc = reflectionDoc({
    id: randomUUID(),
    slug: "load-" + randomUUID().slice(0, 8),
  });
  const plan = planOf(
    (
      await observe(
        loaded(
          [doc],
          [
            {
              category: "PARSE_ERROR",
              code: "INVALID_DOCUMENT",
              file: "content/reflections/bad.md",
              field: "file",
              message: "Encodage UTF-8 invalide.",
            },
          ],
        ),
      )
    ).result,
  );
  assert.equal(outcome(plan.operations, doc.file), "CREATE");
  assert.equal(plan.parseErrors.length, 1);
  assert.equal(plan.applicable, false);
});

test("a stored date outside the supported range yields a PLANNED conflict, not a failure", async () => {
  const id = randomUUID();
  await seed.query(
    `INSERT INTO publications (id, locale, slug, title, status, published_at)
     VALUES ($1, 'fr', $2, 'Titre', 'draft', 'infinity')`,
    [id, "inf-" + randomUUID().slice(0, 8)],
  );
  const doc = publicationDoc({ id, slug: "inf-new-" + id.slice(0, 8) });
  const plan = planOf((await observe(loaded([doc]))).result);
  assert.ok(
    outcome(plan.operations, doc.file).includes("UNSUPPORTED_STORED_DATE"),
  );
  assert.equal(plan.applicable, false);
});

// A root database object is the valid case (every test above uses one). A
// transaction object, whatever its mode, is refused before any SQL is sent.
for (const [name, config] of [
  ["READ WRITE", undefined],
  [
    "REPEATABLE READ READ ONLY",
    { isolationLevel: "repeatable read", accessMode: "read only" } as const,
  ],
] as const) {
  test(`an external ${name} transaction is refused before any SQL and stays usable`, async () => {
    recorded = [];
    let refusal: unknown;
    let plain: unknown;
    await db.transaction(async (tx) => {
      const before = recorded.length;
      refusal = await runDryRun(
        tx as unknown as NodePgDatabase,
        loaded([publicationDoc({ id: randomUUID() })]),
      ).catch((error: unknown) => error);
      // Nothing was sent by runDryRun: no SAVEPOINT, no SELECT.
      assert.equal(recorded.length, before, recorded.slice(before).join("; "));
      // The refusal left the caller's transaction healthy (not aborted).
      plain = (await tx.execute(sql`SELECT 1 AS ok`)).rows[0];
    }, config);
    assert.ok(refusal instanceof DryRunTransactionError, String(refusal));
    assert.match((refusal as Error).message, /root database object/);
    assert.deepEqual(plain, { ok: 1 });
    assert.ok(!recorded.some((s) => /^savepoint/i.test(s)));
    // The outer transaction ended normally and the connection is reusable.
    assert.equal(pool.idleCount, 1);
    assert.deepEqual((await db.execute(sql`SELECT 1 AS ok`)).rows[0], {
      ok: 1,
    });
  });
}

test("lock_not_available (55P03) from a real lock conflict is FAILED, rolled back and not retried", async () => {
  const slug = "lk-" + randomUUID().slice(0, 8);
  const id = randomUUID();
  await insertDraft(id, slug);
  const doc = publicationDoc({ id, slug });
  // A pool whose sessions give up on a lock after 300 ms.
  const impatient = instrument(
    new pg.Pool({
      connectionString: testUrl,
      max: 1,
      idleTimeoutMillis: 0,
      options: "-c lock_timeout=300",
    }),
  );
  try {
    const blocker = new pg.Client({ connectionString: testUrl });
    await blocker.connect();
    try {
      // A DDL-like exclusive lock held by another session.
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE publications IN ACCESS EXCLUSIVE MODE");
      recorded = [];
      const result = await runDryRun(drizzle(impatient), loaded([doc]));
      const statements = recorded;
      recorded = [];
      assert.deepEqual(result, {
        status: "FAILED",
        code: "DATABASE_ERROR",
        message: "Erreur PostgreSQL ou de connexion (SQLSTATE 55P03).",
      });
      // The original error is the one reported, not a cleanup failure (25P02...).
      assert.equal(statements.filter((s) => /^begin/i.test(s)).length, 1);
      assert.equal(statements.filter((s) => /^rollback/i.test(s)).length, 1);
      assert.equal(statements.filter((s) => /^commit/i.test(s)).length, 0);
      // The blocked read was attempted once: no retry.
      assert.equal(
        statements.filter((s) => /from "publications"/.test(s)).length,
        1,
      );
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    // Released and usable once the lock is gone; the next dry-run succeeds.
    assert.equal(impatient.idleCount, 1);
    const again = planOf(await runDryRun(drizzle(impatient), loaded([doc])));
    assert.equal(outcome(again.operations, doc.file), "NOOP");
  } finally {
    // Always closed, even when an assertion fails, so the run can end.
    await impatient.end();
  }
});

test("other class 55 errors are rethrown, with a clean rollback and a usable connection", async () => {
  for (const code of ["55000", "55006", "55P02", "55P04"]) {
    const mediaId = randomUUID();
    await insertMedia(mediaId);
    const doc = publicationDoc({
      id: randomUUID(),
      slug: "c55-" + randomUUID().slice(0, 8),
      media: mediaId,
    });
    recorded = [];
    hook = (text) =>
      /from "media_assets"/.test(text)
        ? `SELECT raise_sqlstate('${code}')`
        : undefined;
    let thrown: unknown;
    try {
      await runDryRun(db, loaded([doc]));
    } catch (error) {
      thrown = error;
    } finally {
      hook = undefined;
    }
    const statements = recorded;
    recorded = [];
    assert.ok(thrown, code + " was not rethrown");
    // Drizzle wraps the driver error; the SQLSTATE is on its cause.
    const cause = (thrown as { cause?: { code?: string } }).cause;
    assert.equal(cause?.code ?? (thrown as { code?: string }).code, code);
    assert.equal(statements.filter((s) => /^begin/i.test(s)).length, 1);
    assert.equal(statements.filter((s) => /^rollback/i.test(s)).length, 1);
    assert.equal(pool.idleCount, 1);
    assert.deepEqual((await db.execute(sql`SELECT 1 AS ok`)).rows[0], {
      ok: 1,
    });
  }
});
