import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { publications } from "../db/schema.js";
import { importReader } from "../src/repositories/editorial-import-reader.js";
import { UnsupportedPublishedAtError } from "../src/editorial/import-reader.js";
import { resolveReferences } from "../src/editorial/resolve.js";
import type { ParsedPublication } from "../src/editorial/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );
const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
let client: pg.Client;
let databaseUrl: string;
let created = false;

before(async () => {
  await admin.connect();
  await admin.query('CREATE DATABASE "' + database + '"');
  created = true;
  const url = new URL(connectionString);
  url.pathname = "/" + database;
  databaseUrl = url.toString();
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "db/migrations" });
});
after(async () => {
  await client?.end();
  if (created) await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
});

// Every test runs inside BEGIN ... ROLLBACK on the shared connection, and the
// reader is bound to that same connection, like an import transaction would be.
async function transaction(body: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}
const reader = () => importReader(drizzle(client));

type Status = "draft" | "published" | "archived";
interface ContentRow {
  id?: string;
  locale?: string;
  slug?: string | null;
  title?: string | null;
  status?: Status;
  publishedAt?: string | null;
}

async function insertTheme(slug: string, locale = "fr", id = randomUUID()) {
  await client.query(
    "INSERT INTO themes (id, locale, name, slug) VALUES ($1, $2, $3, $4)",
    [id, locale, slug, slug],
  );
  return id;
}
async function insertMedia(
  overrides: Partial<{
    id: string;
    altText: string | null;
    source: string | null;
    license: string | null;
    author: string | null;
    width: number | null;
    height: number | null;
  }> = {},
) {
  const id = overrides.id ?? randomUUID();
  const full = {
    altText: "Alt",
    source: "Source",
    license: "CC0",
    author: "Auteur",
    width: 1600,
    height: 900,
    ...overrides,
  };
  await client.query(
    `INSERT INTO media_assets
       (id, original_url, alt_text, source, license, author, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      "https://example.test/" + id + ".jpg",
      full.altText,
      full.source,
      full.license,
      full.author,
      full.width,
      full.height,
    ],
  );
  return id;
}
async function insertPublication(
  row: ContentRow & {
    hook?: string | null;
    mediaAssetId?: string | null;
    themeIds?: string[];
  } = {},
) {
  const id = row.id ?? randomUUID();
  await client.query(
    `INSERT INTO publications
       (id, locale, slug, title, status, published_at, hook, observation,
        evocation, reflection, open_question, media_asset_id)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 'obs', 'evo', 'ref', 'q', $8)`,
    [
      id,
      row.locale ?? "fr",
      row.slug === undefined ? "slug-" + id : row.slug,
      row.title === undefined ? "Titre" : row.title,
      row.status ?? "draft",
      row.publishedAt ?? null,
      row.hook === undefined ? "Accroche" : row.hook,
      row.mediaAssetId ?? null,
    ],
  );
  for (const themeId of row.themeIds ?? [])
    await client.query(
      "INSERT INTO publication_themes (publication_id, theme_id) VALUES ($1, $2)",
      [id, themeId],
    );
  return id;
}
async function insertReflection(
  row: ContentRow & { coverMediaId?: string | null; themeIds?: string[] } = {},
) {
  const id = row.id ?? randomUUID();
  await client.query(
    `INSERT INTO reflections
       (id, locale, slug, title, status, published_at, excerpt, content,
        cover_media_id)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 'extrait', 'contenu', $7)`,
    [
      id,
      row.locale ?? "fr",
      row.slug === undefined ? "slug-" + id : row.slug,
      row.title === undefined ? "Titre" : row.title,
      row.status ?? "draft",
      row.publishedAt ?? null,
      row.coverMediaId ?? null,
    ],
  );
  for (const themeId of row.themeIds ?? [])
    await client.query(
      "INSERT INTO reflection_themes (reflection_id, theme_id) VALUES ($1, $2)",
      [id, themeId],
    );
  return id;
}

test("publication snapshot carries every field, themes and media", () =>
  transaction(async () => {
    const media = await insertMedia();
    const theme = await insertTheme("memoire");
    const id = await insertPublication({
      slug: "premiere",
      title: "Première",
      status: "published",
      publishedAt: "2026-10-08T12:34:56.123456Z",
      mediaAssetId: media,
      themeIds: [theme],
    });
    const [snapshot, ...rest] = await reader().findPublications([id]);
    assert.equal(rest.length, 0);
    assert.deepEqual(snapshot, {
      type: "publication",
      id,
      locale: "fr",
      slug: "premiere",
      title: "Première",
      status: "published",
      publishedAt: "2026-10-08T12:34:56.123456Z",
      themeIds: [theme],
      hook: "Accroche",
      mediaAssetId: media,
      observation: "obs",
      evocation: "evo",
      reflection: "ref",
      openQuestion: "q",
    });
  }));

test("reflection snapshot carries every field, themes and cover", () =>
  transaction(async () => {
    const media = await insertMedia();
    const theme = await insertTheme("absence");
    const id = await insertReflection({
      slug: "essai",
      title: "Essai",
      status: "published",
      publishedAt: "2026-01-02T03:04:05.000001Z",
      coverMediaId: media,
      themeIds: [theme],
    });
    const [snapshot, ...rest] = await reader().findReflections([id]);
    assert.equal(rest.length, 0);
    assert.deepEqual(snapshot, {
      type: "reflection",
      id,
      locale: "fr",
      slug: "essai",
      title: "Essai",
      status: "published",
      publishedAt: "2026-01-02T03:04:05.000001Z",
      themeIds: [theme],
      excerpt: "extrait",
      coverMediaId: media,
      content: "contenu",
    });
  }));

test("drafts, archived and published rows are all visible to the reader", () =>
  transaction(async () => {
    const draft = await insertPublication({ status: "draft" });
    const archived = await insertPublication({
      status: "archived",
      publishedAt: "2020-01-01T00:00:00Z",
    });
    const published = await insertPublication({
      status: "published",
      // Future-dated: public queries hide it, the import reader must not.
      publishedAt: "2999-01-01T00:00:00Z",
    });
    const rows = await reader().findPublications([draft, archived, published]);
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.id, row.status])),
      { [draft]: "draft", [archived]: "archived", [published]: "published" },
    );
    const reflection = await insertReflection({ status: "archived" });
    assert.equal(
      (await reader().findReflections([reflection]))[0]?.status,
      "archived",
    );
  }));

test("an incomplete draft is read with nulls, not defaults", () =>
  transaction(async () => {
    const id = await insertPublication({
      slug: null,
      title: null,
      hook: null,
      publishedAt: null,
    });
    const [snapshot] = await reader().findPublications([id]);
    assert.equal(snapshot?.slug, null);
    assert.equal(snapshot?.title, null);
    assert.equal(snapshot?.hook, null);
    assert.equal(snapshot?.publishedAt, null);
    assert.equal(snapshot?.mediaAssetId, null);
    assert.deepEqual(snapshot?.themeIds, []);
  }));

test("the same UUID is read independently in both content tables", () =>
  transaction(async () => {
    const shared = randomUUID();
    await insertReflection({ id: shared, slug: "reflexion" });
    // Only in reflections: publications must not see it, and vice versa.
    assert.deepEqual(await reader().findPublications([shared]), []);
    assert.equal(
      (await reader().findReflections([shared]))[0]?.slug,
      "reflexion",
    );
    // Nothing prevents the same UUID from existing in both tables.
    await insertPublication({ id: shared, slug: "publication" });
    assert.equal(
      (await reader().findPublications([shared]))[0]?.slug,
      "publication",
    );
    assert.equal(
      (await reader().findReflections([shared]))[0]?.slug,
      "reflexion",
    );
  }));

test("themes are a canonical set, whatever the insertion order", () =>
  transaction(async () => {
    const themes = [
      await insertTheme("c"),
      await insertTheme("a"),
      await insertTheme("b"),
    ];
    const pubId = await insertPublication({ themeIds: [...themes].reverse() });
    const refId = await insertReflection({ themeIds: themes });
    const expected = [...themes].sort();
    assert.deepEqual(
      (await reader().findPublications([pubId]))[0]?.themeIds,
      expected,
    );
    assert.deepEqual(
      (await reader().findReflections([refId]))[0]?.themeIds,
      expected,
    );
    const bare = await insertPublication();
    assert.deepEqual(
      (await reader().findPublications([bare]))[0]?.themeIds,
      [],
    );
  }));

test("themes of one row never leak into another", () =>
  transaction(async () => {
    const t1 = await insertTheme("un");
    const t2 = await insertTheme("deux");
    const a = await insertPublication({ themeIds: [t1] });
    const b = await insertPublication({ themeIds: [t2] });
    const byId = Object.fromEntries(
      (await reader().findPublications([a, b])).map((r) => [r.id, r.themeIds]),
    );
    assert.deepEqual(byId, { [a]: [t1], [b]: [t2] });
  }));

test("results are ordered by id, independent of input order and duplicates", () =>
  transaction(async () => {
    const ids = [
      await insertPublication(),
      await insertPublication(),
      await insertPublication(),
    ];
    const sorted = [...ids].sort();
    const forward = await reader().findPublications([...ids, ids[0]!]);
    const backward = await reader().findPublications([...ids].reverse());
    assert.deepEqual(
      forward.map((r) => r.id),
      sorted,
    );
    assert.deepEqual(forward, backward);
  }));

test("empty inputs return empty results without touching the database", async () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error("database must not be used for empty input");
      },
    },
  ) as Parameters<typeof importReader>[0];
  // editorialReferences only reads `db` lazily, so construction is safe.
  const empty = importReader(forbidden);
  assert.deepEqual(await empty.findPublications([]), []);
  assert.deepEqual(await empty.findReflections([]), []);
  assert.deepEqual(await empty.findSlugOwners("publication", []), []);
  assert.deepEqual(await empty.findSlugOwners("reflection", []), []);
  assert.deepEqual(await empty.findMedia([]), []);
});

test("absent references yield no rows", () =>
  transaction(async () => {
    const missing = randomUUID();
    assert.deepEqual(await reader().findPublications([missing]), []);
    assert.deepEqual(await reader().findReflections([missing]), []);
    assert.deepEqual(await reader().findMedia([missing]), []);
    assert.deepEqual(
      await reader().findSlugOwners("publication", [
        { locale: "fr", slug: "absent" },
      ]),
      [],
    );
  }));

test("slug owners are scoped to the requested table", () =>
  transaction(async () => {
    const pub = await insertPublication({ slug: "commun" });
    const ref = await insertReflection({ slug: "commun" });
    assert.deepEqual(
      await reader().findSlugOwners("publication", [
        { locale: "fr", slug: "commun" },
      ]),
      [{ id: pub, locale: "fr", slug: "commun" }],
    );
    assert.deepEqual(
      await reader().findSlugOwners("reflection", [
        { locale: "fr", slug: "commun" },
      ]),
      [{ id: ref, locale: "fr", slug: "commun" }],
    );
  }));

test("slug owners match the exact (locale, slug) pair, for any status", () =>
  transaction(async () => {
    const fr = await insertPublication({ slug: "paire", status: "draft" });
    const en = await insertPublication({
      slug: "paire",
      locale: "en",
      status: "archived",
      publishedAt: "2020-01-01T00:00:00Z",
    });
    await insertPublication({
      slug: "autre",
      status: "published",
      publishedAt: "2020-01-01T00:00:00Z",
    });
    await insertPublication({ slug: null });
    const owners = await reader().findSlugOwners("publication", [
      { locale: "fr", slug: "paire" },
      { locale: "en", slug: "paire" },
      { locale: "de", slug: "paire" },
      { locale: "fr", slug: "paire" },
    ]);
    // Ordered by (locale, slug); the duplicated key does not duplicate rows.
    assert.deepEqual(owners, [
      { id: en, locale: "en", slug: "paire" },
      { id: fr, locale: "fr", slug: "paire" },
    ]);
  }));

test("slug keys are bound as parameters, never interpolated", () =>
  transaction(async () => {
    await insertPublication({ slug: "intact" });
    const hostile = "x') OR true OR ('a' = '";
    assert.deepEqual(
      await reader().findSlugOwners("publication", [
        { locale: "fr", slug: hostile },
        { locale: "fr'; DROP TABLE publications; --", slug: "intact" },
      ]),
      [],
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM publications"))
        .rows[0].n,
      1,
    );
  }));

test("media rows keep complete and incomplete metadata exactly", () =>
  transaction(async () => {
    const complete = await insertMedia();
    const incomplete = await insertMedia({
      altText: null,
      source: null,
      license: null,
      author: null,
      width: null,
      height: null,
    });
    const rows = await reader().findMedia([incomplete, complete, complete]);
    assert.deepEqual(
      rows.map((r) => r.id),
      [complete, incomplete].sort(),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual(byId[complete], {
      id: complete,
      originalUrl: "https://example.test/" + complete + ".jpg",
      altText: "Alt",
      source: "Source",
      license: "CC0",
      author: "Auteur",
      width: 1600,
      height: 900,
    });
    assert.deepEqual(byId[incomplete], {
      id: incomplete,
      originalUrl: "https://example.test/" + incomplete + ".jpg",
      altText: null,
      source: null,
      license: null,
      author: null,
      width: null,
      height: null,
    });
  }));

test("existing ReferenceReader capabilities are kept and unchanged", () =>
  transaction(async () => {
    const theme = await insertTheme("liens");
    const media = await insertMedia();
    const r = reader();
    assert.equal(await r.findTheme("fr", "liens"), theme);
    assert.equal(await r.findTheme("fr", "inconnu"), null);
    assert.equal(await r.mediaExists(media), true);
    assert.equal(await r.mediaExists(randomUUID()), false);
    // The unchanged resolver accepts the composed reader as-is.
    const content: ParsedPublication = {
      type: "publication",
      id: randomUUID(),
      locale: "fr",
      status: "draft",
      slug: "x",
      title: "X",
      publishedAt: null,
      themeSlugs: ["liens"],
      hook: null,
      mediaAssetId: media,
      observation: null,
      evocation: null,
      reflection: null,
      openQuestion: null,
    };
    const resolved = await resolveReferences(content, r, "x.md");
    assert.deepEqual(resolved.themeIds, [theme]);
  }));

test("microseconds are preserved: .123456, .123000 and .000001 stay distinct", () =>
  transaction(async () => {
    const values = [
      "2026-10-08T12:34:56.123456Z",
      "2026-10-08T12:34:56.123000Z",
      "2026-10-08T12:34:56.000001Z",
      "2026-10-08T12:34:56.000000Z",
    ];
    const ids: string[] = [];
    for (const value of values)
      ids.push(await insertPublication({ publishedAt: value }));
    const rows = await reader().findPublications(ids);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.publishedAt]));
    assert.deepEqual(
      ids.map((id) => byId[id]),
      values,
    );
    assert.equal(new Set(Object.values(byId)).size, values.length);
    // A JavaScript Date would collapse the first value to .123Z.
    assert.equal(typeof rows[0]?.publishedAt, "string");
  }));

test("published_at is rendered at UTC whatever the stored offset or session zone", () =>
  transaction(async () => {
    const withOffset = await insertPublication({
      publishedAt: "2026-10-08T14:34:56.654321+02:00",
    });
    const reflection = await insertReflection({
      publishedAt: "2026-10-08 06:04:56.654321-06:30",
    });
    for (const zone of [
      "UTC",
      "America/New_York",
      "Asia/Kolkata",
      "Pacific/Auckland",
    ]) {
      await client.query("SET LOCAL TIME ZONE '" + zone + "'");
      assert.equal(
        (await reader().findPublications([withOffset]))[0]?.publishedAt,
        "2026-10-08T12:34:56.654321Z",
        zone,
      );
      assert.equal(
        (await reader().findReflections([reflection]))[0]?.publishedAt,
        "2026-10-08T12:34:56.654321Z",
        zone,
      );
    }
  }));

test("null published_at stays null", () =>
  transaction(async () => {
    const id = await insertReflection({ publishedAt: null });
    assert.equal((await reader().findReflections([id]))[0]?.publishedAt, null);
  }));

test("the supported InstantUs boundaries are accepted", () =>
  transaction(async () => {
    const min = await insertPublication({
      publishedAt: "0001-01-01T00:00:00Z",
    });
    const max = await insertPublication({
      publishedAt: "9999-12-31T23:59:59.999999Z",
    });
    const byId = Object.fromEntries(
      (await reader().findPublications([min, max])).map((r) => [
        r.id,
        r.publishedAt,
      ]),
    );
    assert.equal(byId[min], "0001-01-01T00:00:00.000000Z");
    assert.equal(byId[max], "9999-12-31T23:59:59.999999Z");
  }));

const unsupported: Record<string, string> = {
  "BC date": "0001-06-01 00:00:00 BC",
  "instant just before year 1 UTC": "0001-01-01T00:00:00+05:00",
  "year 10000": "10000-01-01T00:00:00Z",
  "far future": "294276-01-01T00:00:00Z",
  infinity: "infinity",
  "-infinity": "-infinity",
};
for (const [label, value] of Object.entries(unsupported)) {
  test(`out-of-range published_at is refused explicitly: ${label}`, () =>
    transaction(async () => {
      const pub = await insertPublication({ publishedAt: value });
      const ref = await insertReflection({ publishedAt: value });
      await assert.rejects(
        reader().findPublications([pub]),
        (error: unknown) =>
          error instanceof UnsupportedPublishedAtError &&
          error.id === pub &&
          error.contentType === "publication",
      );
      await assert.rejects(
        reader().findReflections([ref]),
        (error: unknown) =>
          error instanceof UnsupportedPublishedAtError &&
          error.id === ref &&
          error.contentType === "reflection",
      );
      // Rows that were not requested are unaffected.
      const fine = await insertPublication({
        publishedAt: "2026-01-01T00:00:00Z",
      });
      assert.equal((await reader().findPublications([fine])).length, 1);
    }));
}

test("a Drizzle transaction object of the caller is accepted as context", async () => {
  const db = drizzle(client);
  const id = randomUUID();
  const outcome = await db
    .transaction(async (tx) => {
      // tx is a PgTransaction, not a NodePgDatabase: this must type-check.
      const inside = importReader(tx);
      await tx.insert(publications).values({ id, slug: "dans-tx" });
      const seen = await inside.findPublications([id]);
      assert.equal(seen[0]?.slug, "dans-tx");
      throw new Error("rollback on purpose");
    })
    .catch((error: Error) => error.message);
  assert.equal(outcome, "rollback on purpose");
  // The reader neither committed nor kept anything: the row is gone.
  assert.deepEqual(await reader().findPublications([id]), []);
});

test("the reader works in a REPEATABLE READ READ ONLY transaction (dry-run shape)", async () => {
  // Seeded in autocommit (no open transaction between tests), removed below.
  const seeded = await insertPublication({ slug: "lecture-seule" });
  try {
    const slug = await drizzle(client).transaction(
      async (tx) =>
        (await importReader(tx).findPublications([seeded]))[0]?.slug,
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    assert.equal(slug, "lecture-seule");
  } finally {
    await client.query("DELETE FROM publications WHERE id = $1", [seeded]);
  }
});

// Lock modes in pg_locks for the current backend, split by meaning:
// - ordinary: AccessShareLock, taken by any plain SELECT;
// - predicate: SIReadLock, SERIALIZABLE's non-blocking conflict tracking
//   (reported with locktype 'relation', 'page' or 'tuple');
// - explicit: anything else on those lock types, e.g. RowShareLock from
//   FOR SHARE / FOR KEY SHARE / FOR UPDATE, which D03-02 forbids.
async function heldLocks(connection: pg.Client) {
  const result = await connection.query(
    `SELECT DISTINCT mode FROM pg_locks
     WHERE pid = pg_backend_pid() AND granted
       AND locktype IN ('relation', 'page', 'tuple')`,
  );
  const modes: string[] = result.rows.map((row) => row.mode);
  return {
    ordinary: modes.filter((mode) => mode === "AccessShareLock"),
    predicate: modes.filter((mode) => mode === "SIReadLock"),
    explicit: modes.filter(
      (mode) => mode !== "AccessShareLock" && mode !== "SIReadLock",
    ),
  };
}

// Seeds committed rows (autocommit) so a second connection can write to them,
// and removes them afterwards even if the scenario fails.
async function withConcurrentWriter(
  body: (seed: {
    writer: pg.Client;
    slug: string;
    readTheme: string;
    spareTheme: string;
    spareSlug: string;
    media: string;
    spareMedia: string;
    pub: string;
    pubSlug: string;
  }) => Promise<void>,
) {
  const suffix = randomUUID().slice(0, 8);
  const slug = "verrou-" + suffix;
  const spareSlug = "libre-" + suffix;
  const readTheme = await insertTheme(slug);
  const spareTheme = await insertTheme(spareSlug);
  const media = await insertMedia();
  const spareMedia = await insertMedia();
  // The publication really owns ("fr", pubSlug): findSlugOwners must find it.
  const pubSlug = "possede-" + suffix;
  const pub = await insertPublication({
    slug: pubSlug,
    themeIds: [readTheme],
    mediaAssetId: media,
  });
  const writer = new pg.Client({ connectionString: databaseUrl });
  await writer.connect();
  try {
    await writer.query("SET lock_timeout = '1s'");
    await body({
      writer,
      slug,
      readTheme,
      spareTheme,
      spareSlug,
      media,
      spareMedia,
      pub,
      pubSlug,
    });
  } finally {
    // Release the reader's transaction first, then clean up; the writer
    // connection is closed even if a cleanup statement fails.
    try {
      await client.query("ROLLBACK").catch(() => undefined);
      await writer.query("DELETE FROM publications WHERE id = $1", [pub]);
      await writer.query("DELETE FROM media_assets WHERE id = ANY($1)", [
        [media, spareMedia],
      ]);
      await writer.query("DELETE FROM themes WHERE id = ANY($1)", [
        [readTheme, spareTheme],
      ]);
    } finally {
      await writer.end();
    }
  }
}

test("reads take no explicit locks: concurrent writers are never blocked", () =>
  withConcurrentWriter(async (seed) => {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const r = reader();
    // Every read capability, including the ReferenceReader ones.
    assert.equal(await r.findTheme("fr", seed.slug), seed.readTheme);
    assert.equal(await r.findTheme("fr", seed.spareSlug), seed.spareTheme);
    assert.equal(await r.mediaExists(seed.spareMedia), true);
    assert.equal((await r.findMedia([seed.media, seed.spareMedia])).length, 2);
    assert.equal((await r.findPublications([seed.pub])).length, 1);
    // An existing (locale, slug) owner is found; an absent slug is not.
    assert.deepEqual(
      await r.findSlugOwners("publication", [
        { locale: "fr", slug: seed.pubSlug },
      ]),
      [{ id: seed.pub, locale: "fr", slug: seed.pubSlug }],
    );
    assert.deepEqual(
      await r.findSlugOwners("publication", [{ locale: "fr", slug: "x" }]),
      [],
    );
    // The reading transaction stays open. A FOR SHARE read would block the
    // non-key UPDATEs below, and a FOR KEY SHARE read would block the key
    // UPDATE and the DELETEs. lock_timeout (1s) turns any wait into an error.
    const { writer } = seed;
    await writer.query("UPDATE themes SET name = 'n' WHERE id = $1", [
      seed.readTheme,
    ]);
    await writer.query("UPDATE themes SET slug = $2 WHERE id = $1", [
      seed.spareTheme,
      seed.spareSlug + "-renomme",
    ]);
    await writer.query("DELETE FROM themes WHERE id = $1", [seed.spareTheme]);
    await writer.query("UPDATE media_assets SET caption = 'c' WHERE id = $1", [
      seed.media,
    ]);
    await writer.query("DELETE FROM media_assets WHERE id = $1", [
      seed.spareMedia,
    ]);
    await writer.query("UPDATE publications SET title = 'm' WHERE id = $1", [
      seed.pub,
    ]);
    // The slug owner row was read through findSlugOwners: changing its
    // editorial key (a unique-index column) and deleting it must not wait.
    await writer.query("UPDATE publications SET slug = $2 WHERE id = $1", [
      seed.pub,
      seed.pubSlug + "-renomme",
    ]);
    await writer.query("DELETE FROM publications WHERE id = $1", [seed.pub]);
    const held = await heldLocks(client);
    assert.deepEqual(held.explicit, []);
    assert.ok(held.ordinary.length > 0, "plain reads hold AccessShareLock");
  }));

test("control: the lock probe does detect explicit locking reads", () =>
  withConcurrentWriter(async (seed) => {
    const { writer } = seed;
    const blocked = (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "55P03";
    await client.query("BEGIN");
    await client.query("SELECT id FROM themes WHERE id = $1 FOR SHARE", [
      seed.readTheme,
    ]);
    await assert.rejects(
      writer.query("UPDATE themes SET name = 'n' WHERE id = $1", [
        seed.readTheme,
      ]),
      blocked,
    );
    assert.ok((await heldLocks(client)).explicit.includes("RowShareLock"));
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    await client.query("SELECT id FROM themes WHERE id = $1 FOR KEY SHARE", [
      seed.spareTheme,
    ]);
    await assert.rejects(
      writer.query("DELETE FROM themes WHERE id = $1", [seed.spareTheme]),
      blocked,
    );
    await client.query("ROLLBACK");

    // Same probe on the slug owner row: a key lock would block a slug change.
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM publications WHERE id = $1 FOR KEY SHARE",
      [seed.pub],
    );
    await assert.rejects(
      writer.query("UPDATE publications SET slug = $2 WHERE id = $1", [
        seed.pub,
        seed.pubSlug + "-bloque",
      ]),
      blocked,
    );
    await client.query("ROLLBACK");
  }));

test("theme sub-selects keep their correlation columns qualified", async () => {
  // Drizzle strips table prefixes from single-table select lists. Without
  // explicit identifiers the correlation would read `"publication_id" = "id"`
  // and depend on the join table never gaining an `id` column.
  const statements: string[] = [];
  const logged = importReader(
    drizzle(client, {
      logger: { logQuery: (query) => statements.push(query) },
    }),
  );
  await logged.findPublications([randomUUID()]);
  await logged.findReflections([randomUUID()]);
  const sqlOf = (table: string) =>
    statements
      .map((statement) => statement.replace(/\s+/g, " "))
      .find((statement) => statement.includes(`FROM "${table}"`));
  assert.match(
    sqlOf("publication_themes") ?? "",
    /"publication_themes"\."publication_id" = "publications"\."id"/,
  );
  assert.match(
    sqlOf("reflection_themes") ?? "",
    /"reflection_themes"\."reflection_id" = "reflections"\."id"/,
  );
});
