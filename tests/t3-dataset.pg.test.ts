import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { reflections } from "../db/schema.js";
import { publicContentWhere } from "../db/visibility.js";
import { parseContent } from "../src/editorial/parse.js";
import { mediaReadinessProblems } from "../src/editorial/media-readiness.js";
import type { ImportPlan } from "../src/editorial/operations.js";
import {
  loadSources,
  type LoadedSources,
} from "../src/editorial/source-loader.js";
import { publicPublicationsRepository } from "../src/repositories/public-publications.js";
import { runDryRun } from "../src/services/editorial-dry-run.js";
import {
  runImport,
  type ImportExecutionResult,
} from "../src/services/editorial-import.js";
import { createPublicPublicationsService } from "../src/services/public-publications.js";
import {
  migrateWithViewsOwner,
  provisionB1Roles,
  withRoleLock,
} from "./support/b1-roles.js";

// T3: the controlled synthetic dataset, end to end, on a throw-away database
// of the dedicated PostgreSQL test instance:
//   reference bootstrap -> Markdown sources -> D03 dry-run -> D03 import
//   -> PostgreSQL -> existing public read layer.
// The tests of this file are ordered steps of ONE scenario and share its state:
// each step relies on the previous ones (node:test runs them in file order).
// Generic D03 properties are proven elsewhere (import, dry-run, B1 and public
// read test files); this file proves them for THIS dataset only.
//
// Identities:
// - admin / superDb: superuser of the test instance; migrates and runs the
//   reference bootstrap (the separate Theme/MediaAsset circuit), never writes
//   editorial content.
// - LOGIN: a test login with the importer privileges of the writer policy
//   (reads, writes on the four editorial tables, EXECUTE on the three B1
//   functions, no UPDATE on themes or media_assets), granted in THIS database.
// - the public reader: resonances_app_reader, the role of the T2 views.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );

const DATASET_ROOT = "tests/fixtures/t3-dataset";
const REFERENCES_SQL = readFileSync(`${DATASET_ROOT}/references.sql`, "utf8");
const LOGIN = "resonances_t3_test_import_login";
const READER = "resonances_app_reader";

// --- The dataset, as the fixtures declare it ---------------------------------

const THEME = {
  confiance: "73a00000-0000-4000-8000-000000000001",
  presence: "73a00000-0000-4000-8000-000000000002",
  distance: "73a00000-0000-4000-8000-000000000003",
} as const;
const MEDIA = {
  ready: "73b00000-0000-4000-8000-000000000001",
  nonPublic: "73b00000-0000-4000-8000-000000000002",
} as const;

interface Expected {
  file: string;
  type: "publication" | "reflection";
  id: string;
  slug: string;
  status: "draft" | "published" | "archived";
  publishedAt: string | null;
  media: string | null;
  themes: readonly string[]; // theme UUIDs, sorted
  publiclyVisible: boolean;
}

const sorted = (ids: readonly string[]) => [...ids].sort();

const P_PUBLISHED: Expected = {
  file: "content/publications/deux-tasses-a-la-fenetre.md",
  type: "publication",
  id: "73c00000-0000-4000-8000-000000000001",
  slug: "deux-tasses-a-la-fenetre",
  status: "published",
  publishedAt: "2026-03-14T09:30:00.000000Z",
  media: MEDIA.ready,
  themes: sorted([THEME.confiance, THEME.presence]),
  publiclyVisible: true,
};
const P_DRAFT: Expected = {
  file: "content/publications/le-quai-avant-le-depart.md",
  type: "publication",
  id: "73c00000-0000-4000-8000-000000000002",
  slug: "le-quai-avant-le-depart",
  status: "draft",
  publishedAt: null,
  media: MEDIA.nonPublic,
  themes: [THEME.distance],
  publiclyVisible: false,
};
const P_FUTURE: Expected = {
  file: "content/publications/la-tasse-encore-pleine.md",
  type: "publication",
  id: "73c00000-0000-4000-8000-000000000003",
  slug: "la-tasse-encore-pleine",
  status: "published",
  publishedAt: "2099-01-01T08:00:00.000000Z",
  media: MEDIA.ready,
  themes: [THEME.presence],
  publiclyVisible: false,
};
const P_ARCHIVED: Expected = {
  file: "content/publications/une-valise-pres-du-banc.md",
  type: "publication",
  id: "73c00000-0000-4000-8000-000000000004",
  slug: "une-valise-pres-du-banc",
  status: "archived",
  publishedAt: "2026-02-01T10:00:00.000000Z",
  media: MEDIA.nonPublic,
  themes: sorted([THEME.distance, THEME.confiance]),
  publiclyVisible: false,
};
const R_PUBLISHED: Expected = {
  file: "content/reflections/etre-la-sans-tout-dire.md",
  type: "reflection",
  id: "73d00000-0000-4000-8000-000000000001",
  slug: "etre-la-sans-tout-dire",
  status: "published",
  publishedAt: "2026-04-02T18:15:00.000000Z",
  media: MEDIA.ready,
  themes: sorted([THEME.presence, THEME.distance]),
  publiclyVisible: true,
};
const R_DRAFT: Expected = {
  file: "content/reflections/la-distance-qui-protege.md",
  type: "reflection",
  id: "73d00000-0000-4000-8000-000000000002",
  slug: "la-distance-qui-protege",
  status: "draft",
  publishedAt: null,
  media: MEDIA.nonPublic,
  themes: [THEME.confiance],
  publiclyVisible: false,
};

const PUBLICATIONS = [P_PUBLISHED, P_DRAFT, P_FUTURE, P_ARCHIVED];
const REFLECTIONS = [R_PUBLISHED, R_DRAFT];
const ALL = [...PUBLICATIONS, ...REFLECTIONS];
// Plan order of D03 (contract §6): valid documents sorted by (type, id, file).
const byTypeAndId = (a: Expected, b: Expected) =>
  a.type === b.type ? (a.id < b.id ? -1 : 1) : a.type < b.type ? -1 : 1;

// --- Connections ---------------------------------------------------------------

const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
const loginPassword = randomBytes(18).toString("hex");
let created = false;
let superDb: pg.Client;
let importPool: pg.Pool;
let readerPool: pg.Pool;
let publicService: ReturnType<typeof createPublicPublicationsService>;

function urlFor(user?: string, password?: string): string {
  const url = new URL(connectionString as string);
  url.pathname = "/" + database;
  if (user !== undefined) {
    url.username = user;
    url.password = password ?? "";
  }
  return url.toString();
}

// Statement log of the importer pool: every SQL text and its bound values.
interface Statement {
  text: string;
  values: unknown[];
}
let statements: Statement[] = [];

function instrument(target: pg.Pool): pg.Pool {
  target.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text: string; values?: unknown[] };
      const text = typeof first === "string" ? first : first.text;
      const values =
        (args[1] as unknown[] | undefined) ??
        (typeof first === "string" ? [] : (first.values ?? []));
      statements.push({ text, values });
      return original(...args);
    };
  });
  return target;
}

const isMutation = (s: Statement) =>
  /^\s*(insert|update|delete|truncate|merge)\b/i.test(s.text);
const isB1Call = (s: Statement) => /d03_priv\./i.test(s.text);

before(async () => {
  await admin.connect();
  await provisionB1Roles(admin);
  // A login of this file only: no other test file changes its password, and it
  // is a member of no role (memberships are cluster-wide and audited elsewhere).
  await withRoleLock(admin, async () => {
    const exists = await admin.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [LOGIN],
    );
    if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${LOGIN}`);
    await admin.query(
      `ALTER ROLE ${LOGIN} NOSUPERUSER NOCREATEROLE NOCREATEDB LOGIN PASSWORD '${loginPassword}'`,
    );
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  superDb = new pg.Client({ connectionString: urlFor() });
  await superDb.connect();
  await migrateWithViewsOwner(admin, [], () =>
    migrate(drizzle(superDb), { migrationsFolder: "db/migrations" }),
  );
  // Importer privileges of docs/operations/SQL-WRITER-POLICY.md, in this
  // database only (same grants as tests/import.pg.test.ts).
  await superDb.query(`
    GRANT SELECT ON themes, media_assets, publications, reflections,
                    publication_themes, reflection_themes TO ${LOGIN};
    GRANT INSERT, UPDATE, DELETE ON publications, reflections,
                    publication_themes, reflection_themes TO ${LOGIN};
    GRANT USAGE ON SCHEMA d03_priv TO ${LOGIN};
    GRANT EXECUTE ON FUNCTION d03_priv.lock_theme(uuid),
      d03_priv.lock_media_key(uuid), d03_priv.lock_media_ready(uuid) TO ${LOGIN};`);
  importPool = instrument(
    new pg.Pool({
      connectionString: urlFor(LOGIN, loginPassword),
      max: 2,
      idleTimeoutMillis: 0,
    }),
  );
  // Public reader sessions. The reader's password belongs to
  // tests/public-read.pg.test.ts (which may run in parallel), so this file does
  // not log in as the reader: it opens superuser sessions that switch to the
  // reader role at startup. Every privilege check then uses the reader role
  // (asserted below), with the same read-only session as createPublicDatabase.
  readerPool = new pg.Pool({
    connectionString: urlFor(),
    max: 2,
    options: `-c role=${READER} -c default_transaction_read_only=on`,
  });
  publicService = createPublicPublicationsService(() =>
    publicPublicationsRepository(drizzle(readerPool)),
  );
});

after(async () => {
  await importPool?.end().catch(() => undefined);
  await readerPool?.end().catch(() => undefined);
  await superDb?.end().catch(() => undefined);
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

// --- Helpers ---------------------------------------------------------------------

const EDITORIAL_TABLES = [
  "publications",
  "reflections",
  "publication_themes",
  "reflection_themes",
] as const;
const ALL_TABLES = ["themes", "media_assets", ...EDITORIAL_TABLES] as const;

// Every row of the six business tables with its row version (xmin): any
// rewrite, even of identical values, changes it.
async function fingerprint(): Promise<string> {
  const parts: unknown[] = [];
  for (const table of ALL_TABLES)
    parts.push(
      (await superDb.query(`SELECT xmin::text, * FROM ${table} ORDER BY 2, 3`))
        .rows,
    );
  return JSON.stringify(parts);
}

async function count(table: string): Promise<number> {
  const { rows } = await superDb.query(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0].n;
}

async function load(): Promise<LoadedSources> {
  return loadSources(DATASET_ROOT);
}

function applied(result: ImportExecutionResult) {
  assert.equal(result.status, "APPLIED", JSON.stringify(result, null, 1));
  if (result.status !== "APPLIED") throw new Error("unreachable");
  return result;
}

const operationSummary = (plan: ImportPlan) =>
  plan.operations.map((o) => {
    if (o.kind === "CREATE") return [o.kind, o.file, o.after.id];
    if (o.kind === "NOOP") return [o.kind, o.file, o.snapshot.id];
    if (o.kind === "UPDATE") return [o.kind, o.file, o.after.id];
    return [o.kind, o.file, o.id ?? null];
  });

let dryRunPlan: ImportPlan;
let afterFirstImport: string;

// --- 1. Sources --------------------------------------------------------------------

test("T3 sources: exactly six documents, all with their final locale and slug", async () => {
  const loaded = await load();
  assert.deepEqual(loaded.loadErrors, []);
  assert.deepEqual(
    loaded.sources.map((s) => s.file),
    ALL.map((e) => e.file).sort(),
  );
  for (const source of loaded.sources) {
    const expected = ALL.find((e) => e.file === source.file) as Expected;
    const parsed = parseContent(source.text, source.file);
    assert.equal(parsed.type, expected.type, source.file);
    assert.equal(parsed.id, expected.id, source.file);
    assert.equal(parsed.status, expected.status, source.file);
    // D03-SLUG-01: the key is final from the first import, drafts included.
    assert.equal(parsed.locale, "fr", source.file);
    assert.equal(parsed.slug, expected.slug, source.file);
  }
});

// --- 2. Reference bootstrap ---------------------------------------------------------

test("T3 reference bootstrap: three themes, two media, and no editorial row", async () => {
  // Static guard: the bootstrap never writes the four editorial tables.
  assert.doesNotMatch(
    REFERENCES_SQL,
    /\b(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?(publications|reflections|publication_themes|reflection_themes)\b/i,
  );
  for (const table of ALL_TABLES) assert.equal(await count(table), 0, table);

  await superDb.query(REFERENCES_SQL);

  const themes = await superDb.query(
    "SELECT id, locale, slug, name FROM themes ORDER BY slug",
  );
  assert.deepEqual(themes.rows, [
    { id: THEME.confiance, locale: "fr", slug: "confiance", name: "Confiance" },
    { id: THEME.distance, locale: "fr", slug: "distance", name: "Distance" },
    { id: THEME.presence, locale: "fr", slug: "presence", name: "Présence" },
  ]);

  const media = await superDb.query(
    `SELECT id, original_url AS "originalUrl", web_url AS "webUrl",
            alt_text AS "altText", source, license, author, width, height
     FROM media_assets ORDER BY id`,
  );
  assert.deepEqual(
    media.rows.map((m) => m.id),
    [MEDIA.ready, MEDIA.nonPublic],
  );
  const [ready, nonPublic] = media.rows;
  // The automatic D03 readiness check (D03-MEDIA-01), as the importer applies it.
  assert.deepEqual(mediaReadinessProblems(ready), []);
  assert.ok(ready.webUrl, "the ready media has a web variant");
  assert.deepEqual(mediaReadinessProblems(nonPublic), [
    "alt_text",
    "source",
    "license",
  ]);
  assert.equal(nonPublic.webUrl, null);

  for (const table of EDITORIAL_TABLES)
    assert.equal(await count(table), 0, table);
});

// --- 3. Dry-run -------------------------------------------------------------------

test("T3 dry-run: applicable plan of six CREATE, and nothing written", async () => {
  const before = await fingerprint();
  statements = [];
  const result = await runDryRun(drizzle(importPool), await load());
  assert.equal(result.status, "PLANNED", JSON.stringify(result, null, 1));
  if (result.status !== "PLANNED") throw new Error("unreachable");
  const { plan } = result;
  assert.equal(plan.applicable, true);
  assert.deepEqual(plan.parseErrors, []);
  assert.deepEqual(
    operationSummary(plan),
    [...ALL].sort(byTypeAndId).map((e) => ["CREATE", e.file, e.id]),
  );
  // Zero write: no mutation command, no B1 function, no changed row version.
  assert.equal(statements.filter(isMutation).length, 0);
  assert.equal(statements.filter(isB1Call).length, 0);
  assert.equal(await fingerprint(), before);
  for (const table of EDITORIAL_TABLES)
    assert.equal(await count(table), 0, table);
  dryRunPlan = plan;
});

// --- 4. Import ----------------------------------------------------------------------

test("T3 import: APPLIED at the first attempt, six CREATE committed, same plan as the dry-run", async () => {
  statements = [];
  const result = applied(await runImport(importPool, await load()));
  assert.equal(result.committed, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual([result.created, result.updated, result.noop], [6, 0, 0]);
  assert.equal(result.plan.applicable, true);
  // No drift between the dry-run and the committed plan for this dataset.
  assert.deepEqual(result.plan, dryRunPlan);

  // References were protected through the three B1 functions, in the mode the
  // D03 contract assigns: the ready media serves published content (FOR SHARE),
  // the incomplete one only draft/archived content (FOR KEY SHARE).
  const b1 = statements
    .filter(isB1Call)
    .map((s) => [
      /lock_(theme|media_key|media_ready)/.exec(s.text)?.[1],
      s.values[0],
    ]);
  assert.deepEqual(b1, [
    ["theme", THEME.confiance],
    ["theme", THEME.presence],
    ["theme", THEME.distance],
    ["media_ready", MEDIA.ready],
    ["media_key", MEDIA.nonPublic],
  ]);

  // Positive control for the NOOP step: the mutation detector does see the
  // writes of this import, and D03 wrote only the four editorial tables.
  const written = new Set(
    statements
      .filter(isMutation)
      .map((s) => /^\s*insert\s+into\s+"?(\w+)"?/i.exec(s.text)?.[1] ?? s.text),
  );
  assert.deepEqual([...written].sort(), [...EDITORIAL_TABLES].sort());
  afterFirstImport = await fingerprint();
});

// --- 5. PostgreSQL rows and associations ---------------------------------------------

async function contentRows(table: "publications" | "reflections") {
  const media = table === "publications" ? "media_asset_id" : "cover_media_id";
  const { rows } = await superDb.query(
    `SELECT id, locale, slug, status, ${media} AS media,
            to_char(published_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at_us,
            created_at = updated_at AS untouched
     FROM ${table} ORDER BY id`,
  );
  return rows;
}

async function themePairs(
  table: "publication_themes" | "reflection_themes",
  column: "publication_id" | "reflection_id",
) {
  const { rows } = await superDb.query(
    `SELECT ${column} AS id, theme_id FROM ${table} ORDER BY 1, 2`,
  );
  return rows;
}

const expectedRow = (e: Expected) => ({
  id: e.id,
  locale: "fr",
  slug: e.slug,
  status: e.status,
  media: e.media,
  published_at_us: e.publishedAt,
  untouched: true,
});
const expectedPairs = (list: readonly Expected[]) =>
  list
    .flatMap((e) => e.themes.map((theme_id) => ({ id: e.id, theme_id })))
    .sort((a, b) =>
      a.id === b.id ? (a.theme_id < b.theme_id ? -1 : 1) : a.id < b.id ? -1 : 1,
    );

test("T3 PostgreSQL: rows, media references and theme associations match the dataset", async () => {
  assert.deepEqual(
    await contentRows("publications"),
    PUBLICATIONS.map(expectedRow).sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  assert.deepEqual(
    await contentRows("reflections"),
    REFLECTIONS.map(expectedRow).sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  assert.deepEqual(
    await themePairs("publication_themes", "publication_id"),
    expectedPairs(PUBLICATIONS),
  );
  assert.deepEqual(
    await themePairs("reflection_themes", "reflection_id"),
    expectedPairs(REFLECTIONS),
  );
  // Required dataset properties: a theme shared by a Publication and a
  // Reflection, and content carrying several themes.
  assert.ok(P_PUBLISHED.themes.includes(THEME.presence));
  assert.ok(R_PUBLISHED.themes.includes(THEME.presence));
  assert.ok(ALL.some((e) => e.themes.length > 1));
});

test("T3 no D03 bypass: every editorial row comes from the single import COMMIT", async () => {
  const versions = new Set<string>();
  for (const table of EDITORIAL_TABLES) {
    const { rows } = await superDb.query(
      `SELECT xmin::text AS v FROM ${table}`,
    );
    for (const row of rows) versions.add(row.v);
  }
  // One transaction wrote all 6 contents and their 9 associations...
  assert.equal(versions.size, 1);
  // ...and it is not the reference bootstrap transaction.
  const bootstrap = await superDb.query(
    "SELECT DISTINCT xmin::text AS v FROM themes UNION SELECT DISTINCT xmin::text FROM media_assets",
  );
  assert.equal(bootstrap.rows.length, 1);
  assert.notEqual(bootstrap.rows[0].v, [...versions][0]);
  const total =
    (await count("publication_themes")) + (await count("reflection_themes"));
  assert.equal(total, 9);
});

// --- 6. Strict NOOP on re-import ---------------------------------------------------

test("T3 re-import of exactly the same sources: strict NOOP, no row, timestamp or association touched", async () => {
  assert.equal(await fingerprint(), afterFirstImport);
  statements = [];
  const result = applied(await runImport(importPool, await load()));
  assert.equal(result.attempts, 1);
  assert.deepEqual([result.created, result.updated, result.noop], [0, 0, 6]);
  assert.deepEqual(
    operationSummary(result.plan),
    [...ALL].sort(byTypeAndId).map((e) => ["NOOP", e.file, e.id]),
  );
  // No mutation command was even sent, and no row version changed
  // (updated_at, created_at and the 9 associations included).
  assert.deepEqual(statements.filter(isMutation), []);
  assert.equal(await fingerprint(), afterFirstImport);
  // The media readiness was still revalidated under B1 before the NOOP.
  assert.ok(
    statements.some(
      (s) => /lock_media_ready/.test(s.text) && s.values[0] === MEDIA.ready,
    ),
  );
});

// --- 7. Existing public read layer (T2, Publications) --------------------------------

test("T3 public read (T2 views): only the past published Publication is visible", async () => {
  const session = await readerPool.query(
    "SELECT current_user AS u, current_setting('transaction_read_only') AS ro",
  );
  assert.deepEqual(session.rows[0], { u: READER, ro: "on" });

  const list = await publicService.listPublications({ limit: 100 });
  assert.deepEqual(
    list.map((p) => p.slug),
    [P_PUBLISHED.slug],
  );
  for (const e of PUBLICATIONS) {
    const found = await publicService.getPublicationBySlug(e.slug);
    assert.equal(found !== null, e.publiclyVisible, e.slug);
  }

  const visible = await publicService.getPublicationBySlug(P_PUBLISHED.slug);
  assert.ok(visible);
  assert.equal(visible.title, "Deux tasses à la fenêtre");
  assert.equal(visible.hook, "Une présence qui ne réclame rien.");
  assert.equal(visible.publishedAt.toISOString(), "2026-03-14T09:30:00.000Z");
  for (const section of [
    visible.observation,
    visible.evocation,
    visible.reflection,
    visible.openQuestion,
  ])
    assert.ok(section && section.trim().length > 0);
  assert.deepEqual(visible.themes, [
    { slug: "confiance", name: "Confiance" },
    { slug: "presence", name: "Présence" },
  ]);
  assert.ok(visible.image);
  assert.equal(
    visible.image.url,
    "https://media.example.test/t3/web/deux-tasses-1600.webp",
  );
  assert.match(visible.image.alt ?? "", /^Deux tasses posées/);
  assert.deepEqual([visible.image.width, visible.image.height], [1600, 1067]);
  // The original file is never exposed.
  assert.doesNotMatch(JSON.stringify(visible), /originals/);

  // Theme associations of non-public Publications are hidden as well.
  const themeRows = await readerPool.query(
    "SELECT DISTINCT publication_id::text AS id FROM public_read.publication_themes",
  );
  assert.deepEqual(themeRows.rows, [{ id: P_PUBLISHED.id }]);
});

// --- 8. Reflections: visibility rule only, no public boundary yet --------------------

test("T3 Reflections: the visibility rule keeps only the past published Reflection; no public read boundary exists for them", async () => {
  // The existing, shared visibility rule (db/visibility.ts), evaluated by
  // PostgreSQL on the tables. It is NOT a public read boundary.
  const visible = await drizzle(superDb)
    .select({ id: reflections.id })
    .from(reflections)
    .where(publicContentWhere(reflections))
    .orderBy(asc(reflections.id));
  assert.deepEqual(
    visible.map((r) => r.id),
    REFLECTIONS.filter((e) => e.publiclyVisible).map((e) => e.id),
  );

  // Fact recorded for the next slices: T2 exposes Publications only. The public
  // reader has no view and no privilege for Reflections.
  const views = await superDb.query(
    `SELECT c.relname FROM pg_class c
     WHERE c.relnamespace = 'public_read'::regnamespace ORDER BY 1`,
  );
  assert.deepEqual(
    views.rows.map((r) => r.relname),
    ["publication_themes", "publications"],
  );
  await assert.rejects(
    readerPool.query("SELECT id FROM public.reflections"),
    (error: { code?: string }) => error.code === "42501",
  );
});
