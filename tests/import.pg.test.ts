import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { provisionB1Roles, withRoleLock } from "./support/b1-roles.js";
import type { ImportWriter } from "../src/editorial/import-writer.js";
import type { ConflictOperation } from "../src/editorial/operations.js";
import type { LoadedSources } from "../src/editorial/source-loader.js";
import type { PublicationSnapshot } from "../src/editorial/snapshots.js";
import { parseInstantUs } from "../src/editorial/instant-us.js";
import { importWriter } from "../src/repositories/editorial-import-writer.js";
import {
  ImportTransactionError,
  runImport,
  type ImportExecutionResult,
} from "../src/services/editorial-import.js";
import { publicationDoc, reflectionDoc } from "./support/plan-sources.js";

// Real PostgreSQL, a throw-away database, several independent connections.
// Roles: `resonances_importer` and `resonances_b1_owner` come from the ADR-B1
// provisioning file. The service connects as its own LOGIN role, which gets the
// importer's privileges by direct grants in THIS database only. It is neither
// a member of the importer (memberships are cluster-wide and would show up in
// the ACL audits of the B1 tests running in parallel) nor does this file ever
// change the importer's password (the B1 tests own that).
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );
const MIGRATOR = "resonances_d06_test_migrator";
const LOGIN = "resonances_d06_test_import_login";
const IMPORTER = "resonances_importer";

const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
const passwords = new Map<string, string>();
const opened: pg.Client[] = [];
const pools: pg.Pool[] = [];
let created = false;

function urlFor(role: string): string {
  const url = new URL(connectionString as string);
  url.username = role;
  url.password = passwords.get(role) ?? "";
  url.pathname = "/" + database;
  return url.toString();
}
async function connectAs(role: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: urlFor(role) });
  await client.connect();
  opened.push(client);
  return client;
}

let seed: pg.Client; // autocommit writer of fixtures (owner of the tables)
let external: pg.Client; // a second independent writer
let superDb: pg.Client; // superuser inside the test database
let loginUrl: string;

before(async () => {
  await admin.connect();
  for (const role of [MIGRATOR, LOGIN])
    passwords.set(role, randomBytes(18).toString("hex"));
  await withRoleLock(admin, async () => {
    for (const role of [MIGRATOR, LOGIN]) {
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
  await provisionB1Roles(admin, [MIGRATOR]);
  await admin.query(`CREATE DATABASE "${database}" OWNER ${MIGRATOR}`);
  created = true;
  seed = await connectAs(MIGRATOR);
  await migrate(drizzle(seed), { migrationsFolder: "db/migrations" });
  // Importer privileges as the writer policy describes them: reads on every
  // table, writes on the four editorial tables only.
  await seed.query(`
    GRANT SELECT ON themes, media_assets, publications, reflections,
                    publication_themes, reflection_themes TO ${IMPORTER};
    GRANT INSERT, UPDATE, DELETE ON publications, reflections,
                    publication_themes, reflection_themes TO ${IMPORTER};`);
  // Same privileges as the importer role: schema USAGE, EXECUTE on the three
  // B1 functions, and no UPDATE on themes or media_assets.
  await seed.query(`
    GRANT SELECT ON themes, media_assets, publications, reflections,
                    publication_themes, reflection_themes TO ${LOGIN};
    GRANT INSERT, UPDATE, DELETE ON publications, reflections,
                    publication_themes, reflection_themes TO ${LOGIN};`);
  // A real server error with the SQLSTATE of the caller's choice.
  await seed.query(`CREATE FUNCTION raise_sqlstate(code text) RETURNS int
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected' USING ERRCODE = code;
    END $$`);
  // A real unique_violation naming the constraint of the caller's choice.
  await seed.query(`CREATE FUNCTION raise_unique(name text) RETURNS int
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected' USING ERRCODE = '23505', CONSTRAINT = name;
    END $$`);
  external = await connectAs(MIGRATOR);
  const superUrl = new URL(connectionString as string);
  superUrl.pathname = "/" + database;
  superDb = new pg.Client({ connectionString: superUrl.toString() });
  await superDb.connect();
  opened.push(superDb);
  // The schema and the functions belong to the B1 owner: grant as superuser.
  await superDb.query(`
    GRANT USAGE ON SCHEMA d03_priv TO ${LOGIN};
    GRANT EXECUTE ON FUNCTION d03_priv.lock_theme(uuid),
      d03_priv.lock_media_key(uuid), d03_priv.lock_media_ready(uuid) TO ${LOGIN};`);
  loginUrl = urlFor(LOGIN);
  await seed.query(
    `INSERT INTO themes (id, locale, name, slug) VALUES ($1, 'fr', 'Mémoire', 'memoire')`,
    [randomUUID()],
  );
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  for (const client of opened) await client.end().catch(() => undefined);
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

// ---------------------------------------------------------------------------
// Instrumented pool: statement log, error log and an optional hook per
// statement. Each import under test gets its own pool, so concurrent imports
// have separate logs.
// ---------------------------------------------------------------------------

interface Statement {
  text: string;
  values: unknown[];
}
type Direct = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
// Returns a replacement statement, throws to inject a failure, or does nothing.
type Hook = (
  text: string,
  direct: Direct,
) => Promise<string | void> | string | void;

interface Probe {
  pool: pg.Pool;
  log: Statement[];
  // SQLSTATE (or message) of every statement that failed.
  errors: string[];
  hook: Hook | undefined;
  // Connections the pool dropped for good (release(true) or a pool eviction).
  removed: number;
}

function probePool(): Probe {
  const probe: Probe = {
    pool: new pg.Pool({
      connectionString: loginUrl,
      max: 2,
      idleTimeoutMillis: 0,
    }),
    log: [],
    errors: [],
    hook: undefined,
    removed: 0,
  };
  pools.push(probe.pool);
  probe.pool.on("remove", () => {
    probe.removed += 1;
  });
  probe.pool.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = async (
      ...args: unknown[]
    ) => {
      const first = args[0] as string | { text: string; values?: unknown[] };
      const text = typeof first === "string" ? first : first.text;
      // node-postgres takes the values as 2nd argument or inside the config.
      const values =
        (args[1] as unknown[] | undefined) ??
        (typeof first === "string" ? [] : (first.values ?? []));
      probe.log.push({ text, values });
      try {
        const replacement = probe.hook
          ? await probe.hook(text, (t, v) => original(t, v))
          : undefined;
        return typeof replacement === "string"
          ? await original(replacement)
          : await original(...args);
      } catch (error) {
        probe.errors.push(
          (error as pg.DatabaseError).code ?? (error as Error).message,
        );
        throw error;
      }
    };
  });
  return probe;
}

const loaded = (
  sources: LoadedSources["sources"],
  loadErrors: LoadedSources["loadErrors"] = [],
): LoadedSources => ({ sources, loadErrors });

const noSleep = async () => undefined;

async function importWith(
  probe: Probe,
  sources: LoadedSources,
  sleeps: number[] = [],
): Promise<ImportExecutionResult> {
  return runImport(probe.pool, sources, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryDelay: () => 0,
  });
}

const isMutation = (s: Statement) =>
  /^\s*(insert|update|delete)\b/i.test(s.text);
const isB1Lock = (s: Statement) => /d03_priv\.lock_/.test(s.text);
const isContentLock = (s: Statement) => /for update/i.test(s.text);

// Every row of the six business tables with its row version (xmin): even a
// rewrite of identical values changes it.
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

async function insertTheme(slug: string, id: string = randomUUID()) {
  await seed.query(
    "INSERT INTO themes (id, locale, name, slug) VALUES ($1, 'fr', $2, $2)",
    [id, slug],
  );
  return id;
}
async function insertMedia(
  id: string = randomUUID(),
  alt: string | null = "Alt",
) {
  await seed.query(
    `INSERT INTO media_assets (id, original_url, alt_text, source, license)
     VALUES ($1, $2, $3, 'Source', 'CC0')`,
    [id, "https://example.test/" + id + ".jpg", alt],
  );
  return id;
}
const uid = () => randomUUID().slice(0, 8);

async function row(table: string, id: string) {
  const { rows } = await seed.query(
    `SELECT *, to_char(published_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at_us,
       xmin::text AS version FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0] as Record<string, any> | undefined;
}
async function themePairs(table: string, column: string, id: string) {
  const { rows } = await seed.query(
    `SELECT theme_id, xmin::text AS version FROM ${table}
     WHERE ${column} = $1 ORDER BY theme_id`,
    [id],
  );
  return rows as { theme_id: string; version: string }[];
}

function applied(result: ImportExecutionResult) {
  assert.equal(result.status, "APPLIED", JSON.stringify(result, null, 1));
  if (result.status !== "APPLIED") throw new Error("unreachable");
  return result;
}
function rejected(result: ImportExecutionResult) {
  assert.equal(result.status, "REJECTED", JSON.stringify(result, null, 1));
  if (result.status !== "REJECTED") throw new Error("unreachable");
  return result;
}
function conflictCodes(result: ImportExecutionResult): string[] {
  const plan = rejected(result).plan;
  return plan.operations
    .filter((o): o is ConflictOperation => o.kind === "CONFLICT")
    .flatMap((o) => o.diagnostics.map((d) => d.code));
}

// Resolves when `predicate` holds on pg_stat_activity (bounded wait).
async function waitForBlockedBackend(queryFragment: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    // `admin` is outside any transaction (a transaction caches its own
    // view of pg_stat_activity) and is a superuser (it can read other roles' queries).
    const { rowCount } = await admin.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = $2 AND wait_event_type = 'Lock' AND query ILIKE $1`,
      ["%" + queryFragment + "%", database],
    );
    if (rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no backend blocked on " + queryFragment);
}

// ---------------------------------------------------------------------------
// Writes: CREATE, NOOP, UPDATE, theme deltas
// ---------------------------------------------------------------------------

test("CREATE of a publication and a reflection keeps the source UUIDs and themes", async () => {
  const pubId = randomUUID();
  const refId = randomUUID();
  const t1 = await insertTheme("create-a-" + uid());
  const slugs = (
    await seed.query("SELECT slug FROM themes WHERE id = $1", [t1])
  ).rows[0].slug as string;
  const probe = probePool();
  const result = applied(
    await importWith(
      probe,
      loaded([
        publicationDoc({ id: pubId, slug: "p-" + uid(), themes: [slugs] }),
        reflectionDoc({ id: refId, slug: "r-" + uid(), themes: [slugs] }),
      ]),
    ),
  );
  assert.deepEqual(
    [result.created, result.updated, result.noop, result.attempts],
    [2, 0, 0, 1],
  );
  assert.equal((await row("publications", pubId))?.id, pubId);
  assert.equal((await row("reflections", refId))?.id, refId);
  assert.deepEqual(
    (await themePairs("publication_themes", "publication_id", pubId)).map(
      (p) => p.theme_id,
    ),
    [t1],
  );
  assert.deepEqual(
    (await themePairs("reflection_themes", "reflection_id", refId)).map(
      (p) => p.theme_id,
    ),
    [t1],
  );
  // The transaction really was the expected one, and the COMMIT was sent once.
  assert.equal(
    probe.log.filter(
      (s) => s.text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
    ).length,
    1,
  );
  assert.equal(probe.log.filter((s) => s.text === "COMMIT").length, 1);
});

test("an identical re-import is a strict NOOP: no mutation, no new row version", async () => {
  const id = randomUUID();
  const theme = "noop-" + uid();
  await insertTheme(theme);
  const sources = loaded([
    publicationDoc({ id, slug: "p-" + uid(), themes: [theme] }),
  ]);
  applied(await importWith(probePool(), sources));
  const before = await fingerprint();
  const probe = probePool();
  const second = applied(await importWith(probe, sources));
  assert.deepEqual([second.created, second.updated, second.noop], [0, 0, 1]);
  assert.equal(probe.log.filter(isMutation).length, 0, "no mutation command");
  assert.equal(await fingerprint(), before, "no row version changed");
  // The COMMIT is still required before APPLIED, even for a NOOP-only batch.
  assert.equal(probe.log.filter((s) => s.text === "COMMIT").length, 1);
});

test("UPDATE of scalar fields keeps id, locale, slug, created_at and the theme rows", async () => {
  const id = randomUUID();
  const theme = "upd-" + uid();
  await insertTheme(theme);
  const slug = "p-" + uid();
  applied(
    await importWith(
      probePool(),
      loaded([publicationDoc({ id, slug, title: "Avant", themes: [theme] })]),
    ),
  );
  const before = (await row("publications", id))!;
  const pairsBefore = await themePairs(
    "publication_themes",
    "publication_id",
    id,
  );
  const result = applied(
    await importWith(
      probePool(),
      loaded([publicationDoc({ id, slug, title: "Après", themes: [theme] })]),
    ),
  );
  assert.deepEqual([result.created, result.updated, result.noop], [0, 1, 0]);
  const after = (await row("publications", id))!;
  assert.equal(after.title, "Après");
  assert.equal(after.slug, slug);
  assert.equal(after.locale, "fr");
  assert.deepEqual(after.created_at, before.created_at);
  assert.ok(after.updated_at > before.updated_at, "updated_at moved forward");
  assert.deepEqual(
    await themePairs("publication_themes", "publication_id", id),
    pairsBefore,
    "theme rows were not rewritten",
  );
});

test("UPDATE of themes only: parent updated_at moves, only the useful pairs change", async () => {
  const id = randomUUID();
  const keep = "keep-" + uid();
  const drop = "drop-" + uid();
  const add = "add-" + uid();
  const [keepId, , addId] = [
    await insertTheme(keep),
    await insertTheme(drop),
    await insertTheme(add),
  ];
  const slug = "p-" + uid();
  applied(
    await importWith(
      probePool(),
      loaded([publicationDoc({ id, slug, themes: [keep, drop] })]),
    ),
  );
  const before = (await row("publications", id))!;
  const keptBefore = (
    await themePairs("publication_themes", "publication_id", id)
  ).find((p) => p.theme_id === keepId)!;

  const probe = probePool();
  const result = applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id, slug, themes: [keep, add] })]),
    ),
  );
  assert.deepEqual([result.created, result.updated, result.noop], [0, 1, 0]);
  const after = (await row("publications", id))!;
  assert.equal(after.title, before.title);
  assert.ok(after.updated_at > before.updated_at);
  assert.deepEqual(after.created_at, before.created_at);
  const pairs = await themePairs("publication_themes", "publication_id", id);
  assert.deepEqual(pairs.map((p) => p.theme_id).sort(), [keepId, addId].sort());
  assert.equal(
    pairs.find((p) => p.theme_id === keepId)!.version,
    keptBefore.version,
    "the unchanged pair was never rewritten",
  );
  // Exactly one delete and one insert on the join table: no global rewrite.
  const joinWrites = probe.log.filter(
    (s) => isMutation(s) && /publication_themes/.test(s.text),
  );
  assert.deepEqual(
    joinWrites.map((s) => s.text.trim().split(/\s+/)[0]!.toLowerCase()).sort(),
    ["delete", "insert"],
  );
});

test("published_at keeps its microseconds: UPDATE then NOOP, and a direct writer round trip", async () => {
  const id = randomUUID();
  const slug = "p-" + uid();
  const media = await insertMedia();
  await seed.query(
    `INSERT INTO publications (id, locale, slug, title, status, published_at,
       hook, observation, evocation, reflection, open_question, media_asset_id)
     VALUES ($1, 'fr', $2, 'Titre', 'published', '2026-01-01T10:00:00.123456Z',
       'Accroche', 'Ce qui est visible.', 'Ce qui est suggéré.',
       'Ce qui est pensé.', 'Et vous ?', $3)`,
    [id, slug, media],
  );
  const memoire = (
    await seed.query("SELECT id FROM themes WHERE slug = 'memoire'")
  ).rows[0].id as string;
  await seed.query(
    "INSERT INTO publication_themes (publication_id, theme_id) VALUES ($1, $2)",
    [id, memoire],
  );
  const sources = loaded([
    publicationDoc({
      id,
      slug,
      status: "published",
      publishedAt: "2026-01-01T10:00:00.123Z",
      media,
    }),
  ]);
  const first = applied(await importWith(probePool(), sources));
  assert.deepEqual([first.created, first.updated, first.noop], [0, 1, 0]);
  assert.equal(
    (await row("publications", id))!.published_at_us,
    "2026-01-01T10:00:00.123000Z",
  );
  const second = applied(await importWith(probePool(), sources));
  assert.deepEqual([second.created, second.updated, second.noop], [0, 0, 1]);

  // The writer itself must not truncate to milliseconds.
  const writerPool = new pg.Pool({ connectionString: loginUrl, max: 1 });
  pools.push(writerPool);
  const client = await writerPool.connect();
  try {
    await client.query("BEGIN");
    const writer: ImportWriter = importWriter(drizzle(client));
    const snapshot: PublicationSnapshot = {
      type: "publication",
      id: randomUUID(),
      locale: "fr",
      slug: "w-" + uid(),
      title: "Writer",
      status: "published",
      publishedAt: parseInstantUs("2026-03-04T05:06:07.654321Z"),
      themeIds: [],
      hook: null,
      mediaAssetId: media,
      observation: null,
      evocation: null,
      reflection: null,
      openQuestion: null,
    };
    await writer.insertPublication(snapshot);
    const { rows } = await client.query(
      `SELECT to_char(published_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v FROM publications WHERE id = $1`,
      [snapshot.id],
    );
    assert.equal(rows[0].v, "2026-03-04T05:06:07.654321Z");
  } finally {
    await client.query("ROLLBACK");
    client.release(true);
  }
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

test("a batch with an invalid document is REJECTED before any lock or write", async () => {
  const before = await fingerprint();
  const probe = probePool();
  const result = rejected(
    await importWith(
      probe,
      loaded([
        publicationDoc({ id: randomUUID(), slug: "p-" + uid() }),
        { file: "content/publications/bad.md", text: "not a document" },
      ]),
    ),
  );
  assert.equal(result.plan.applicable, false);
  assert.equal(result.plan.parseErrors.length, 1);
  assert.equal(result.committed, false);
  assert.equal(probe.log.filter(isMutation).length, 0);
  assert.equal(probe.log.filter(isB1Lock).length, 0);
  assert.equal(probe.log.filter((s) => s.text === "COMMIT").length, 0);
  assert.equal(await fingerprint(), before);
});

test("an editorial conflict found before writing REJECTS the whole batch", async () => {
  const slug = "taken-" + uid();
  await seed.query(
    `INSERT INTO publications (id, locale, slug, title, status)
     VALUES ($1, 'fr', $2, 'Existant', 'draft')`,
    [randomUUID(), slug],
  );
  const before = await fingerprint();
  const probe = probePool();
  const result = await importWith(
    probe,
    loaded([
      publicationDoc({ id: randomUUID(), slug: "ok-" + uid() }),
      publicationDoc({ id: randomUUID(), slug }),
    ]),
  );
  assert.deepEqual(conflictCodes(result), ["SLUG_COLLISION"]);
  assert.equal(probe.log.filter(isMutation).length, 0);
  assert.equal(
    await fingerprint(),
    before,
    "the valid document was not written",
  );
});

test("an SQL failure after a first mutation rolls everything back (FAILED)", async () => {
  const before = await fingerprint();
  const probe = probePool();
  probe.hook = (text) =>
    /^insert into "reflections"/i.test(text)
      ? "SELECT raise_sqlstate('XX000')"
      : undefined;
  const result = await importWith(
    probe,
    loaded([
      publicationDoc({ id: randomUUID(), slug: "p-" + uid() }),
      reflectionDoc({ id: randomUUID(), slug: "r-" + uid() }),
    ]),
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.committed, false);
  assert.equal(result.code, "DATABASE_ERROR");
  assert.equal(result.attempts, 1);
  assert.match(result.message, /XX000/);
  // The publication insert really ran before the failure...
  assert.ok(probe.log.some((s) => /^insert into "publications"/i.test(s.text)));
  assert.ok(probe.log.some((s) => s.text === "ROLLBACK"));
  assert.equal(probe.log.filter((s) => s.text === "COMMIT").length, 0);
  // ...and left nothing behind.
  assert.equal(await fingerprint(), before);
});

test("the connection pool is usable after every outcome (no leaked connection)", async () => {
  const probe = probePool();
  for (let i = 0; i < 4; i += 1)
    applied(
      await importWith(
        probe,
        loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
      ),
    );
  assert.ok(probe.pool.totalCount <= 2);
  assert.equal(probe.pool.waitingCount, 0);
  assert.equal(probe.pool.idleCount, probe.pool.totalCount);
});

// ---------------------------------------------------------------------------
// Retries and terminal states
// ---------------------------------------------------------------------------

for (const code of ["40001", "40P01"]) {
  test(`${code} on the first attempt is retried with a complete new plan`, async () => {
    const id = randomUUID();
    const probe = probePool();
    let failed = false;
    probe.hook = (text) => {
      if (!failed && /^insert into "publications"/i.test(text)) {
        failed = true;
        return `SELECT raise_sqlstate('${code}')`;
      }
    };
    const sleeps: number[] = [];
    const result = applied(
      await importWith(
        probe,
        loaded([publicationDoc({ id, slug: "p-" + uid() })]),
        sleeps,
      ),
    );
    assert.equal(result.attempts, 2);
    assert.equal(result.created, 1);
    assert.deepEqual(probe.errors, [code]);
    assert.equal(sleeps.length, 1, "one wait between the two attempts");
    // Complete replay: the second attempt re-read the rows and re-built the plan.
    assert.equal(
      probe.log.filter(
        (s) => s.text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
      ).length,
      2,
    );
    assert.equal(
      (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
        .rowCount,
      1,
    );
  });
}

test("three retryable failures end in FAILED / RETRY_EXHAUSTED, with nothing committed", async () => {
  const before = await fingerprint();
  const probe = probePool();
  probe.hook = (text) =>
    /^insert into "publications"/i.test(text)
      ? "SELECT raise_sqlstate('40001')"
      : undefined;
  const sleeps: number[] = [];
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
    sleeps,
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.code, "RETRY_EXHAUSTED");
  assert.equal(result.attempts, 3);
  assert.equal(result.committed, false);
  assert.equal(sleeps.length, 2, "no wait after the last attempt");
  assert.equal(probe.log.filter((s) => s.text === "COMMIT").length, 0);
  assert.equal(probe.log.filter((s) => s.text === "ROLLBACK").length, 3);
  assert.equal(await fingerprint(), before);
});

test("a non-retryable error is never retried", async () => {
  const probe = probePool();
  probe.hook = (text) =>
    /^insert into "publications"/i.test(text)
      ? "SELECT raise_sqlstate('XX000')"
      : undefined;
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.attempts, 1);
  assert.equal(result.code, "DATABASE_ERROR");
  assert.equal(
    probe.log.filter(
      (s) => s.text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
    ).length,
    1,
  );
});

// SIMULATED: this does NOT reproduce a native PostgreSQL failure of COMMIT. The
// test replaces the COMMIT call of the driver with a statement that fails with
// a real server error inside the open transaction. It verifies how the service
// classifies a server error answered at the COMMIT boundary (confirmed end of
// transaction, then retry), not what PostgreSQL itself answers to COMMIT.
test("SIMULATED: a server error substituted for COMMIT is classified as a confirmed rollback and retried", async () => {
  const id = randomUUID();
  const probe = probePool();
  let failed = false;
  probe.hook = (text) => {
    if (!failed && text === "COMMIT") {
      failed = true;
      // The statement fails inside the open transaction; the service must end
      // that transaction itself before reusing the connection.
      return "SELECT raise_sqlstate('40001')";
    }
  };
  const result = applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id, slug: "p-" + uid() })]),
    ),
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.created, 1);
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
      .rowCount,
    1,
  );
});

// SIMULATED: a real network cut between "COMMIT sent" and "answer received" is
// not reproducible reliably. The test replaces the COMMIT call of the driver:
// in one case the COMMIT really reaches PostgreSQL and its answer is "lost"
// (an Error without SQLSTATE), in the other it never reaches PostgreSQL. What
// is verified on real PostgreSQL is the state of the database after each case,
// which proves why neither success nor failure may be inferred.
for (const reachesServer of [true, false]) {
  test(`lost COMMIT answer (COMMIT ${reachesServer ? "applied" : "not applied"} by the server) is UNKNOWN_COMMIT_OUTCOME and never retried`, async () => {
    const id = randomUUID();
    const probe = probePool();
    probe.hook = async (text, direct) => {
      if (text !== "COMMIT") return;
      if (reachesServer) await direct("COMMIT");
      throw new Error("Connection terminated unexpectedly");
    };
    const sleeps: number[] = [];
    const result = await importWith(
      probe,
      loaded([publicationDoc({ id, slug: "p-" + uid() })]),
      sleeps,
    );
    assert.equal(result.status, "UNKNOWN_COMMIT_OUTCOME");
    if (result.status !== "UNKNOWN_COMMIT_OUTCOME") return;
    assert.equal(result.committed, "unknown");
    assert.equal(result.attempts, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(
      probe.log.filter(
        (s) => s.text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
      ).length,
      1,
      "no automatic replay",
    );
    assert.equal(
      (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
        .rowCount,
      reachesServer ? 1 : 0,
    );
  });
}

// ---------------------------------------------------------------------------
// Transaction end not confirmed (review D03-06): the driver is spied on to make
// a ROLLBACK fail, while every other statement runs on real PostgreSQL. The
// failing ROLLBACK is never sent to the server, so the transaction stays open
// there until the service destroys the connection.
// ---------------------------------------------------------------------------

const SERIALIZABLE_BEGIN = "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE";
const PROOF_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
// The pool emits "remove" once the destroyed socket is closed, a little after
// release(true) returned: wait (bounded) until the expected count is reached.
async function destroyedConnections(probe: Probe, expected: number) {
  for (let i = 0; i < 100 && probe.removed < expected; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return probe.removed;
}
const countOf = (probe: Probe, text: string) =>
  probe.log.filter((s) => s.text === text).length;

for (const code of ["40001", "40P01"]) {
  test(`${code} with a ROLLBACK that fails: no new attempt, connection destroyed, FAILED without a claimed rollback`, async () => {
    const id = randomUUID();
    const before = await fingerprint();
    const probe = probePool();
    probe.hook = (text) => {
      if (/^insert into "publications"/i.test(text))
        return `SELECT raise_sqlstate('${code}')`;
      if (text === "ROLLBACK") throw new Error("rollback lost");
    };
    const sleeps: number[] = [];
    const result = await importWith(
      probe,
      loaded([publicationDoc({ id, slug: "p-" + uid() })]),
      sleeps,
    );
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.committed, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.code, "DATABASE_ERROR", "not RETRY_EXHAUSTED");
    assert.match(result.message, new RegExp(code));
    assert.match(result.message, /non confirmée/);
    assert.doesNotMatch(result.message, /rollback confirmé/i);
    // No second transaction was opened and no wait took place.
    assert.equal(countOf(probe, SERIALIZABLE_BEGIN), 1);
    assert.equal(sleeps.length, 0);
    assert.equal(countOf(probe, "COMMIT"), 0);
    // The uncertain connection was destroyed, never handed back to the pool.
    assert.equal(await destroyedConnections(probe, 1), 1);
    assert.equal(probe.pool.totalCount, 0);
    assert.equal(await fingerprint(), before);
    // Destroying the connection ended the open server transaction: the pool
    // works again on a fresh connection.
    probe.hook = undefined;
    applied(
      await importWith(
        probe,
        loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
      ),
    );
  });
}

test("a retryable error answered to COMMIT with a ROLLBACK that fails is not retried", async () => {
  const before = await fingerprint();
  const probe = probePool();
  probe.hook = (text) => {
    if (text === "COMMIT") return "SELECT raise_sqlstate('40001')";
    if (text === "ROLLBACK") throw new Error("rollback lost");
  };
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.attempts, 1);
  assert.match(result.message, /non confirmée/);
  assert.equal(countOf(probe, SERIALIZABLE_BEGIN), 1);
  assert.equal(await destroyedConnections(probe, 1), 1);
  assert.equal(await fingerprint(), before);
});

// A constraint violation that a concurrent writer could have caused. The
// violation is injected as a real server error naming the constraint; the
// conflicting row is really committed by another connection, so the fresh
// proof read finds a true editorial conflict.
async function provableViolation(probe: Probe, slug: string) {
  let injected = false;
  probe.hook = async (text) => {
    if (!injected && /^insert into "publications"/i.test(text)) {
      injected = true;
      await seed.query(
        `INSERT INTO publications (id, locale, slug, title, status)
         VALUES ($1, 'fr', $2, 'Concurrent', 'draft')`,
        [randomUUID(), slug],
      );
      return `SELECT raise_unique('publications_locale_slug_unique')`;
    }
  };
}

test("23505 with a proof transaction that cannot be closed: no REJECTED, connection destroyed", async () => {
  const slug = "race-" + uid();
  const id = randomUUID();
  const probe = probePool();
  await provableViolation(probe, slug);
  const innerHook = probe.hook!;
  let inProof = false;
  probe.hook = async (text, direct) => {
    if (text === PROOF_BEGIN) inProof = true;
    if (inProof && text === "ROLLBACK") throw new Error("rollback lost");
    return innerHook(text, direct);
  };
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id, slug })]),
  );
  // The proof itself would have shown a conflict, but it was not closed under
  // control, so no proven verdict is given.
  assert.equal(countOf(probe, PROOF_BEGIN), 1, "the proof really ran");
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.committed, false);
  assert.equal(result.attempts, 1);
  assert.match(result.message, /23505/);
  assert.match(result.message, /Preuve non concluante/);
  assert.equal(countOf(probe, SERIALIZABLE_BEGIN), 1);
  assert.equal(
    await destroyedConnections(probe, 1),
    1,
    "the connection was destroyed",
  );
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
      .rowCount,
    0,
  );
  // No uncertain connection is reused: the next import gets a fresh one.
  probe.hook = undefined;
  applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
    ),
  );
});

test("23505 proven by a fresh read and closed under control is REJECTED, connection kept", async () => {
  const slug = "race-" + uid();
  const id = randomUUID();
  const probe = probePool();
  await provableViolation(probe, slug);
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id, slug })]),
  );
  assert.deepEqual(conflictCodes(result), ["SLUG_COLLISION"]);
  // Proof transaction opened, then ended by a ROLLBACK that succeeded.
  const proofAt = probe.log.findIndex((s) => s.text === PROOF_BEGIN);
  assert.ok(proofAt >= 0);
  assert.ok(probe.log.slice(proofAt).some((s) => s.text === "ROLLBACK"));
  assert.equal(countOf(probe, "COMMIT"), 0);
  assert.equal(probe.removed, 0, "a healthy connection goes back to the pool");
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
      .rowCount,
    0,
    "no partial write",
  );
});

test("23505 that the fresh read does not confirm stays FAILED (not an editorial conflict)", async () => {
  const probe = probePool();
  let injected = false;
  probe.hook = (text) => {
    if (!injected && /^insert into "publications"/i.test(text)) {
      injected = true;
      return `SELECT raise_unique('publications_locale_slug_unique')`;
    }
  };
  const result = await importWith(
    probe,
    loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.match(result.message, /23505/);
  assert.equal(result.attempts, 1);
  assert.equal(probe.removed, 0);
});

test("a transaction that is not SERIALIZABLE READ WRITE is refused as a defect, not a result", async () => {
  const probe = probePool();
  probe.hook = (text) =>
    text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE"
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
      : undefined;
  await assert.rejects(
    importWith(
      probe,
      loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
    ),
    ImportTransactionError,
  );
  // The failed attempt was rolled back and its connection is reusable.
  probe.hook = undefined;
  applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id: randomUUID(), slug: "p-" + uid() })]),
    ),
  );
});

// ---------------------------------------------------------------------------
// ADR-B1 protocol
// ---------------------------------------------------------------------------

test("B1 locks: themes then media by ascending UUID, strongest media mode, all before the first write", async () => {
  const tLo = await insertTheme(
    "zeta-" + uid(),
    "00000000-0000-4000-8000-0000000000a1",
  );
  const tHi = await insertTheme(
    "alpha-" + uid(),
    "ffffffff-ffff-4fff-8fff-fffffffffff1",
  );
  const slugOf = async (id: string) =>
    (await seed.query("SELECT slug FROM themes WHERE id = $1", [id])).rows[0]
      .slug as string;
  const mShared = await insertMedia("00000000-0000-4000-8000-0000000000b1");
  const mDraft = await insertMedia("ffffffff-ffff-4fff-8fff-fffffffffff2");
  const probe = probePool();
  applied(
    await importWith(
      probe,
      loaded([
        publicationDoc({
          id: randomUUID(),
          slug: "p-" + uid(),
          status: "published",
          themes: [await slugOf(tHi), await slugOf(tLo)],
          media: mShared,
        }),
        // Same media used by a draft: the strong mode must win for it.
        publicationDoc({
          id: randomUUID(),
          slug: "p-" + uid(),
          media: mShared,
        }),
        publicationDoc({ id: randomUUID(), slug: "p-" + uid(), media: mDraft }),
      ]),
    ),
  );
  const locks = probe.log.filter(isB1Lock);
  assert.deepEqual(
    locks.map((s) => [/lock_(\w+)\(/.exec(s.text)![1], s.values[0]]),
    [
      ["theme", tLo],
      ["theme", tHi],
      ["media_ready", mShared],
      ["media_key", mDraft],
    ],
  );
  const lastLock = probe.log.reduce(
    (last, s, index) => (isB1Lock(s) ? index : last),
    -1,
  );
  const firstWrite = probe.log.findIndex(isMutation);
  assert.ok(lastLock >= 0 && firstWrite > lastLock, "locks precede writes");
  assert.ok(probe.log.findIndex((s) => s.text === "COMMIT") > firstWrite);
});

test("updated rows are locked FOR UPDATE by (type, id) ascending, after the reference locks", async () => {
  const pubs = [randomUUID(), randomUUID()].sort();
  const refId = randomUUID();
  const slugs = pubs.map(() => "p-" + uid());
  const refSlug = "r-" + uid();
  const initial = [
    publicationDoc({ id: pubs[0]!, slug: slugs[0]!, title: "A1" }),
    publicationDoc({ id: pubs[1]!, slug: slugs[1]!, title: "B1" }),
    reflectionDoc({ id: refId, slug: refSlug, title: "R1" }),
  ];
  applied(await importWith(probePool(), loaded(initial)));
  const probe = probePool();
  applied(
    await importWith(
      probe,
      loaded([
        reflectionDoc({ id: refId, slug: refSlug, title: "R2" }),
        publicationDoc({ id: pubs[1]!, slug: slugs[1]!, title: "B2" }),
        publicationDoc({ id: pubs[0]!, slug: slugs[0]!, title: "A2" }),
      ]),
    ),
  );
  const contentLocks = probe.log.filter(isContentLock);
  assert.deepEqual(
    contentLocks.map((s) => [/from "(\w+)"/.exec(s.text)![1], s.values[0]]),
    [
      ["publications", pubs[0]],
      ["publications", pubs[1]],
      ["reflections", refId],
    ],
  );
  const writes = probe.log.filter(isMutation);
  assert.deepEqual(
    writes.map((s) => /"(publications|reflections)"/.exec(s.text)![1]),
    ["publications", "publications", "reflections"],
  );
});

test("the importer role and the test login: EXECUTE on the three B1 functions, no UPDATE on themes or media", async () => {
  const privilege = async (role: string, sqlText: string) =>
    (await superDb.query(sqlText, [role])).rows[0].allowed as boolean;
  for (const role of [IMPORTER, LOGIN]) {
    for (const fn of ["lock_theme", "lock_media_key", "lock_media_ready"])
      assert.equal(
        await privilege(
          role,
          `SELECT has_function_privilege($1, 'd03_priv.${fn}(uuid)', 'EXECUTE') AS allowed`,
        ),
        true,
        `${role} ${fn}`,
      );
    for (const table of ["themes", "media_assets"]) {
      assert.equal(
        await privilege(
          role,
          `SELECT has_table_privilege($1, '${table}', 'UPDATE') AS allowed`,
        ),
        false,
        `${role} ${table} UPDATE`,
      );
      assert.equal(
        await privilege(
          role,
          `SELECT has_any_column_privilege($1, '${table}', 'UPDATE') AS allowed`,
        ),
        false,
        `${role} ${table} column UPDATE`,
      );
    }
  }
  // The identity the service really uses cannot take a row lock directly.
  const direct = new pg.Client({ connectionString: loginUrl });
  await direct.connect();
  try {
    await assert.rejects(
      direct.query("SELECT id FROM themes FOR SHARE"),
      (error: pg.DatabaseError) => error.code === "42501",
    );
  } finally {
    await direct.end();
  }
});

// ---------------------------------------------------------------------------
// Concurrency: independent connections interleaved at a precise statement
// ---------------------------------------------------------------------------

// Runs `action` once, the first time `matches` is seen in the probe's log.
function onFirst(
  probe: Probe,
  matches: (text: string) => boolean,
  action: () => Promise<void>,
) {
  let done = false;
  probe.hook = async (text) => {
    if (!done && matches(text)) {
      done = true;
      await action();
    }
  };
}

test("a Theme renamed after the snapshot is a serialization failure; the new attempt REJECTS the missing reference", async () => {
  const slug = "ren-" + uid();
  const themeId = await insertTheme(slug);
  const before = await fingerprint();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /lock_theme/.test(t),
    async () => {
      await seed.query("UPDATE themes SET slug = $2 WHERE id = $1", [
        themeId,
        slug + "-renamed",
      ]);
    },
  );
  const result = await importWith(
    probe,
    loaded([
      publicationDoc({ id: randomUUID(), slug: "p-" + uid(), themes: [slug] }),
    ]),
  );
  assert.deepEqual(probe.errors, ["40001"]);
  assert.deepEqual(conflictCodes(result), ["MISSING_REFERENCE"]);
  assert.equal(probe.log.filter(isMutation).length, 0);
  // Only the concurrent rename changed anything: the publication was not written.
  assert.equal(
    (await seed.query("SELECT slug FROM themes WHERE id = $1", [themeId]))
      .rows[0].slug,
    slug + "-renamed",
  );
  void before;
});

test("a Theme (locale, slug) cannot change while the import holds its lock, until the transaction ends", async () => {
  const slug = "held-" + uid();
  const themeId = await insertTheme(slug);
  const probe = probePool();
  let blockedWith = "";
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      await external.query("BEGIN");
      await external.query("SET LOCAL lock_timeout = '250ms'");
      try {
        await external.query("UPDATE themes SET slug = $2 WHERE id = $1", [
          themeId,
          slug + "-x",
        ]);
      } catch (error) {
        blockedWith = (error as pg.DatabaseError).code ?? "";
      }
      await external.query("ROLLBACK");
    },
  );
  applied(
    await importWith(
      probe,
      loaded([
        publicationDoc({
          id: randomUUID(),
          slug: "p-" + uid(),
          themes: [slug],
        }),
      ]),
    ),
  );
  assert.equal(blockedWith, "55P03", "FOR SHARE held until the end");
  // After COMMIT the lock is gone.
  await external.query("UPDATE themes SET slug = $2 WHERE id = $1", [
    themeId,
    slug + "-y",
  ]);
});

test("a media deleted after the snapshot: serialization failure, then REJECTED; while locked, DELETE is blocked", async () => {
  const gone = await insertMedia();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /lock_media_key/.test(t),
    async () => {
      await seed.query("DELETE FROM media_assets WHERE id = $1", [gone]);
    },
  );
  const result = await importWith(
    probe,
    loaded([
      publicationDoc({ id: randomUUID(), slug: "p-" + uid(), media: gone }),
    ]),
  );
  assert.deepEqual(probe.errors, ["40001"]);
  assert.deepEqual(conflictCodes(result), ["MISSING_REFERENCE"]);

  const kept = await insertMedia();
  const second = probePool();
  let code = "";
  onFirst(
    second,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      await external.query("BEGIN");
      await external.query("SET LOCAL lock_timeout = '250ms'");
      try {
        await external.query("DELETE FROM media_assets WHERE id = $1", [kept]);
      } catch (error) {
        code = (error as pg.DatabaseError).code ?? "";
      }
      await external.query("ROLLBACK");
    },
  );
  applied(
    await importWith(
      second,
      loaded([
        publicationDoc({ id: randomUUID(), slug: "p-" + uid(), media: kept }),
      ]),
    ),
  );
  assert.equal(code, "55P03");
});

test("published media metadata changed after the snapshot: 40001, then MEDIA_NOT_READY", async () => {
  const media = await insertMedia();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /lock_media_ready/.test(t),
    async () => {
      await seed.query("UPDATE media_assets SET alt_text = '' WHERE id = $1", [
        media,
      ]);
    },
  );
  const result = await importWith(
    probe,
    loaded([
      publicationDoc({
        id: randomUUID(),
        slug: "p-" + uid(),
        status: "published",
        media,
      }),
    ]),
  );
  assert.deepEqual(probe.errors, ["40001"]);
  assert.deepEqual(conflictCodes(result), ["MEDIA_NOT_READY"]);
});

test("FOR SHARE vs FOR KEY SHARE: published media metadata is frozen, a draft's media is not", async () => {
  const publishedMedia = await insertMedia();
  const draftMedia = await insertMedia();
  const probe = probePool();
  const outcomes: Record<string, string> = {};
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      for (const [name, id] of [
        ["published", publishedMedia],
        ["draft", draftMedia],
      ] as const) {
        await external.query("BEGIN");
        await external.query("SET LOCAL lock_timeout = '250ms'");
        try {
          await external.query(
            "UPDATE media_assets SET alt_text = 'Changed' WHERE id = $1",
            [id],
          );
          outcomes[name] = "ok";
        } catch (error) {
          outcomes[name] = (error as pg.DatabaseError).code ?? "";
        }
        await external.query("ROLLBACK");
      }
    },
  );
  applied(
    await importWith(
      probe,
      loaded([
        publicationDoc({
          id: randomUUID(),
          slug: "p-" + uid(),
          status: "published",
          media: publishedMedia,
        }),
        publicationDoc({
          id: randomUUID(),
          slug: "p-" + uid(),
          media: draftMedia,
        }),
      ]),
    ),
  );
  assert.deepEqual(outcomes, { published: "55P03", draft: "ok" });
});

test("a published NOOP is revalidated: incomplete media gives a rejection, not a NOOP", async () => {
  const media = await insertMedia();
  const id = randomUUID();
  const sources = loaded([
    publicationDoc({
      id,
      slug: "p-" + uid(),
      status: "published",
      media,
    }),
  ]);
  applied(await importWith(probePool(), sources));
  assert.equal(
    applied(await importWith(probePool(), sources)).noop,
    1,
    "still a NOOP while the media is complete",
  );
  await seed.query("UPDATE media_assets SET license = '' WHERE id = $1", [
    media,
  ]);
  const before = await fingerprint();
  const probe = probePool();
  const result = await importWith(probe, sources);
  assert.deepEqual(conflictCodes(result), ["MEDIA_NOT_READY"]);
  assert.equal(probe.log.filter(isMutation).length, 0);
  assert.equal(await fingerprint(), before);
});

test("two imports of the same new UUID: the loser replays and the counters describe the committed plan", async () => {
  const id = randomUUID();
  const sources = loaded([publicationDoc({ id, slug: "p-" + uid() })]);
  const other = probePool();
  const probe = probePool();
  let winner: ImportExecutionResult | undefined;
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      winner = await importWith(other, sources);
    },
  );
  const result = applied(await importWith(probe, sources));
  assert.equal(applied(winner!).created, 1);
  // Whatever PostgreSQL raised for the loser, it was retried as a whole and its
  // committed plan is a NOOP: the first attempt's CREATE is not counted.
  assert.equal(result.attempts, 2, JSON.stringify(probe.errors));
  assert.deepEqual([result.created, result.updated, result.noop], [0, 0, 1]);
  assert.deepEqual(probe.errors, ["40001"]);
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
      .rowCount,
    1,
  );
});

test("two imports with the same slug and different UUIDs: no duplicate, the loser is REJECTED", async () => {
  const slug = "same-" + uid();
  const a = publicationDoc({ id: randomUUID(), slug });
  const b = publicationDoc({ id: randomUUID(), slug });
  const other = probePool();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      applied(await importWith(other, loaded([b])));
    },
  );
  const result = await importWith(probe, loaded([a]));
  assert.deepEqual(conflictCodes(result), ["SLUG_COLLISION"]);
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE slug = $1", [slug]))
      .rowCount,
    1,
  );
});

test("a UUID that appears in the other content type between snapshot and write is refused by serialization", async () => {
  const id = randomUUID();
  const pub = loaded([publicationDoc({ id, slug: "p-" + uid() })]);
  const ref = loaded([reflectionDoc({ id, slug: "r-" + uid() })]);
  const other = probePool();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      applied(await importWith(other, ref));
    },
  );
  const result = await importWith(probe, pub);
  assert.deepEqual(conflictCodes(result), ["TYPE_CHANGE"]);
  assert.equal(
    (await seed.query("SELECT 1 FROM publications WHERE id = $1", [id]))
      .rowCount,
    0,
  );
  assert.equal(
    (await seed.query("SELECT 1 FROM reflections WHERE id = $1", [id]))
      .rowCount,
    1,
  );
});

test("LIMIT: an external READ COMMITTED writer can still put one UUID in both tables", async () => {
  // No physical constraint spans the two tables, and an external writer that
  // never reads takes no part in the serializable protocol (D03 §11, SQL writer
  // policy §4). This documents the limit; it is not a guarantee.
  const id = randomUUID();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /^insert into "publications"/i.test(t),
    async () => {
      await external.query(
        "INSERT INTO reflections (id, locale, slug, status) VALUES ($1, 'fr', $2, 'draft')",
        [id, "ext-" + uid()],
      );
    },
  );
  applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id, slug: "p-" + uid() })]),
    ),
  );
  const both = await seed.query(
    `SELECT (SELECT count(*) FROM publications WHERE id = $1)::int AS p,
            (SELECT count(*) FROM reflections WHERE id = $1)::int AS r`,
    [id],
  );
  assert.deepEqual(both.rows[0], { p: 1, r: 1 });
});

test("a concurrent update of the same row: 40001, replayed on the committed version", async () => {
  const id = randomUUID();
  const slug = "p-" + uid();
  applied(
    await importWith(
      probePool(),
      loaded([publicationDoc({ id, slug, title: "V0" })]),
    ),
  );
  const other = probePool();
  const probe = probePool();
  onFirst(
    probe,
    (t) => /for update/i.test(t),
    async () => {
      applied(
        await importWith(
          other,
          loaded([publicationDoc({ id, slug, title: "V1" })]),
        ),
      );
    },
  );
  const result = applied(
    await importWith(
      probe,
      loaded([publicationDoc({ id, slug, title: "V2" })]),
    ),
  );
  assert.deepEqual(probe.errors, ["40001"]);
  assert.equal(result.attempts, 2);
  assert.deepEqual([result.created, result.updated, result.noop], [0, 1, 0]);
  assert.equal((await row("publications", id))!.title, "V2");
});

test("a deadlock with an external writer that locks in the opposite order is retried", async () => {
  const lo = await insertTheme(
    "dl-lo-" + uid(),
    "00000000-0000-4000-8000-0000000000c1",
  );
  const hi = await insertTheme(
    "dl-hi-" + uid(),
    "00000000-0000-4000-8000-0000000000c2",
  );
  const slugs = (
    await seed.query("SELECT slug FROM themes WHERE id = ANY($1) ORDER BY id", [
      [lo, hi],
    ])
  ).rows.map((r) => r.slug as string);
  // The external writer waits much longer before it runs its own deadlock
  // check, so PostgreSQL deterministically aborts the import (the older waiter).
  await superDb.query("BEGIN");
  await superDb.query("SET LOCAL deadlock_timeout = '10s'");
  await superDb.query("UPDATE themes SET updated_at = now() WHERE id = $1", [
    hi,
  ]);
  const probe = probePool();
  const importing = importWith(
    probe,
    loaded([
      publicationDoc({ id: randomUUID(), slug: "p-" + uid(), themes: slugs }),
    ]),
  );
  await waitForBlockedBackend("lock_theme");
  // Closes the cycle: the import holds `lo` FOR SHARE and waits for `hi`.
  const closing = superDb
    .query("UPDATE themes SET updated_at = now() WHERE id = $1", [lo])
    .then(
      () => "done",
      (error: pg.DatabaseError) => error.code,
    );
  const closed = await closing;
  await superDb.query("COMMIT");
  const result = applied(await importing);
  assert.equal(closed, "done");
  assert.ok(probe.errors.includes("40P01"), JSON.stringify(probe.errors));
  assert.ok(result.attempts >= 2 && result.attempts <= 3);
  assert.equal(result.created, 1);
});
