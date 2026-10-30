import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { SourceDocument } from "../src/editorial/batch-validation.js";
import { buildImportPlan } from "../src/editorial/import-plan.js";
import type {
  ConflictOperation,
  ImportOperation,
} from "../src/editorial/operations.js";
import { parseContent } from "../src/editorial/parse.js";
import { importReader } from "../src/repositories/editorial-import-reader.js";
import { ID, publicationDoc, reflectionDoc } from "./support/plan-sources.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );
const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
let client: pg.Client;
let created = false;

before(async () => {
  await admin.connect();
  await admin.query('CREATE DATABASE "' + database + '"');
  created = true;
  const url = new URL(connectionString);
  url.pathname = "/" + database;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "db/migrations" });
});
after(async () => {
  await client?.end();
  if (created) await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
});

// Each test runs inside BEGIN ... ROLLBACK on the shared connection, and the
// plan is built with a reader bound to that same connection.
async function transaction(body: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}
const plan = (docs: SourceDocument[]) =>
  buildImportPlan(docs, importReader(drizzle(client)));

async function insertTheme(slug: string, locale = "fr") {
  const id = randomUUID();
  await client.query(
    "INSERT INTO themes (id, locale, name, slug) VALUES ($1, $2, $3, $3)",
    [id, locale, slug],
  );
  return id;
}
async function insertMedia(id: string, altText: string | null = "Alt") {
  await client.query(
    `INSERT INTO media_assets (id, original_url, alt_text, source, license)
     VALUES ($1, $2, $3, 'Source', 'CC0')`,
    [id, "https://example.test/" + id + ".jpg", altText],
  );
}

// Stores the row an earlier import of this exact document would have left,
// so that planning the same document again can be a true NOOP.
async function seedFromDoc(doc: SourceDocument, themeIds: string[] = []) {
  const c = parseContent(doc.text, doc.file);
  const published = c.publishedAt?.toISOString() ?? null;
  if (c.type === "publication") {
    await client.query(
      `INSERT INTO publications
         (id, locale, slug, title, status, published_at, hook, observation,
          evocation, reflection, open_question, media_asset_id)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12)`,
      [
        c.id,
        c.locale,
        c.slug,
        c.title,
        c.status,
        published,
        c.hook,
        c.observation,
        c.evocation,
        c.reflection,
        c.openQuestion,
        c.mediaAssetId,
      ],
    );
    for (const themeId of themeIds)
      await client.query(
        "INSERT INTO publication_themes (publication_id, theme_id) VALUES ($1, $2)",
        [c.id, themeId],
      );
  } else {
    await client.query(
      `INSERT INTO reflections
         (id, locale, slug, title, status, published_at, excerpt, content,
          cover_media_id)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9)`,
      [
        c.id,
        c.locale,
        c.slug,
        c.title,
        c.status,
        published,
        c.excerpt,
        c.content,
        c.coverMediaId,
      ],
    );
    for (const themeId of themeIds)
      await client.query(
        "INSERT INTO reflection_themes (reflection_id, theme_id) VALUES ($1, $2)",
        [c.id, themeId],
      );
  }
}

const only = (operations: readonly ImportOperation[]) => {
  assert.equal(operations.length, 1);
  return operations[0]!;
};
const codes = (operation: ImportOperation) => {
  assert.equal(operation.kind, "CONFLICT");
  return (operation as ConflictOperation).diagnostics.map((d) => d.code);
};

test("new documents with real themes and media are CREATE", () =>
  transaction(async () => {
    const theme = await insertTheme("memoire");
    await insertMedia(ID.media);
    const result = await plan([
      publicationDoc({ id: ID.a, status: "published" }),
      reflectionDoc({ id: ID.b, status: "draft" }),
    ]);
    assert.deepEqual(
      result.operations.map((o) => o.kind),
      ["CREATE", "CREATE"],
    );
    const first = result.operations[0]!;
    assert.deepEqual(first.kind === "CREATE" && first.after.themeIds, [theme]);
    assert.equal(result.applicable, true);
  }));

test("a document stored by a previous import is NOOP, and a theme change alone is an UPDATE", () =>
  transaction(async () => {
    const memoire = await insertTheme("memoire");
    const desir = await insertTheme("desir");
    await insertMedia(ID.media);
    const doc = publicationDoc({
      id: ID.a,
      status: "published",
      themes: ["memoire", "desir"],
    });
    await seedFromDoc(doc, [desir, memoire]);
    assert.equal(only((await plan([doc])).operations).kind, "NOOP");

    await client.query(
      "DELETE FROM publication_themes WHERE publication_id = $1 AND theme_id = $2",
      [ID.a, desir],
    );
    const operation = only((await plan([doc])).operations);
    assert.equal(operation.kind, "UPDATE");
    assert.deepEqual(
      operation.kind === "UPDATE" && operation.diff.map((d) => d.field),
      ["themeIds"],
    );
  }));

test("microseconds stored in PostgreSQL are compared without loss", () =>
  transaction(async () => {
    const theme = await insertTheme("memoire");
    await insertMedia(ID.media);
    const doc = publicationDoc({
      id: ID.a,
      status: "published",
      publishedAt: "2026-01-01T10:00:00.123Z",
    });
    await seedFromDoc(doc, [theme]);
    await client.query(
      "UPDATE publications SET published_at = '2026-01-01T10:00:00.123456Z' WHERE id = $1",
      [ID.a],
    );
    const update = only((await plan([doc])).operations);
    assert.equal(update.kind, "UPDATE");
    if (update.kind !== "UPDATE") return;
    assert.deepEqual(
      update.diff.map((d) => [d.field, d.before, d.after]),
      [
        [
          "publishedAt",
          "2026-01-01T10:00:00.123456Z",
          "2026-01-01T10:00:00.123000Z",
        ],
      ],
    );
    await client.query(
      "UPDATE publications SET published_at = '2026-01-01T10:00:00.123Z' WHERE id = $1",
      [ID.a],
    );
    assert.equal(only((await plan([doc])).operations).kind, "NOOP");
  }));

test("slug owners include drafts and archives, per table", () =>
  transaction(async () => {
    await seedFromDoc(publicationDoc({ id: ID.c, slug: "brouillon-pris" }));
    await seedFromDoc(
      reflectionDoc({ id: ID.d, slug: "archive-prise", status: "archived" }),
    );
    const result = await plan([
      publicationDoc({ id: ID.a, slug: "brouillon-pris" }),
      reflectionDoc({ id: ID.b, slug: "archive-prise" }),
      // Same slugs in the other table are free.
      reflectionDoc({ id: ID.media, slug: "brouillon-pris" }),
      publicationDoc({ id: ID.media2, slug: "archive-prise" }),
    ]);
    const kinds = Object.fromEntries(result.operations.map((o) => [o.file, o]));
    assert.deepEqual(codes(kinds[`content/publications/${ID.a}.md`]!), [
      "SLUG_COLLISION",
    ]);
    assert.deepEqual(codes(kinds[`content/reflections/${ID.b}.md`]!), [
      "SLUG_COLLISION",
    ]);
    assert.equal(kinds[`content/reflections/${ID.media}.md`]!.kind, "CREATE");
    assert.equal(kinds[`content/publications/${ID.media2}.md`]!.kind, "CREATE");
    assert.equal(result.applicable, false);
  }));

test("several null-slug drafts are accepted even when null-slug rows exist", () =>
  transaction(async () => {
    await seedFromDoc(publicationDoc({ id: ID.c, slug: null }));
    const result = await plan([
      publicationDoc({ id: ID.a, slug: null }),
      publicationDoc({ id: ID.b, slug: null }),
    ]);
    assert.deepEqual(
      result.operations.map((o) => o.kind),
      ["CREATE", "CREATE"],
    );
    assert.equal(result.applicable, true);
  }));

test("the key of an existing UUID is immutable, and it is not a slug collision", () =>
  transaction(async () => {
    await seedFromDoc(publicationDoc({ id: ID.a, slug: "ancien" }));
    await seedFromDoc(publicationDoc({ id: ID.b, slug: null }));
    await seedFromDoc(publicationDoc({ id: ID.c, slug: "autre" }));
    const result = await plan([
      // Takes the key of another row: reported on the key change only.
      publicationDoc({ id: ID.a, slug: "autre" }),
      publicationDoc({ id: ID.b, slug: "gagne-un-slug" }),
    ]);
    assert.deepEqual(
      result.operations.map((o) => codes(o)),
      [["IMMUTABLE_EDITORIAL_KEY"], ["IMMUTABLE_EDITORIAL_KEY"]],
    );
  }));

test("a UUID stored in the other table, or in both, is TYPE_CHANGE", () =>
  transaction(async () => {
    await seedFromDoc(reflectionDoc({ id: ID.a }));
    // Nothing in the schema stops the same UUID from existing in both tables.
    await seedFromDoc(reflectionDoc({ id: ID.b }));
    await seedFromDoc(publicationDoc({ id: ID.b }));
    const result = await plan([
      publicationDoc({ id: ID.a }),
      reflectionDoc({ id: ID.b }),
    ]);
    for (const operation of result.operations)
      assert.deepEqual(codes(operation), ["TYPE_CHANGE"]);
  }));

test("missing theme and missing media are MISSING_REFERENCE", () =>
  transaction(async () => {
    const result = await plan([
      reflectionDoc({ id: ID.a, themes: ["inconnu"] }),
      publicationDoc({ id: ID.b, media: ID.media }),
    ]);
    assert.deepEqual(
      result.operations.map((o) => codes(o)),
      [["MISSING_REFERENCE"], ["MISSING_REFERENCE"]],
    );
    assert.equal(result.applicable, false);
  }));

test("a published NOOP whose media later lost its alt text becomes CONFLICT", () =>
  transaction(async () => {
    const theme = await insertTheme("memoire");
    await insertMedia(ID.media);
    const doc = publicationDoc({ id: ID.a, status: "published" });
    await seedFromDoc(doc, [theme]);
    assert.equal(only((await plan([doc])).operations).kind, "NOOP");
    await client.query(
      "UPDATE media_assets SET alt_text = NULL WHERE id = $1",
      [ID.media],
    );
    const result = await plan([doc]);
    assert.deepEqual(codes(only(result.operations)), ["MEDIA_NOT_READY"]);
    assert.equal(result.applicable, false);
  }));

test("draft and archived rows may reference incomplete media; dimensions may be NULL", () =>
  transaction(async () => {
    await insertMedia(ID.media, null);
    const result = await plan([
      publicationDoc({ id: ID.a, status: "draft", media: ID.media }),
      reflectionDoc({ id: ID.b, status: "archived", media: ID.media }),
    ]);
    assert.equal(result.applicable, true);
  }));

const unsupported: Record<string, string> = {
  "BC date": "0001-06-01 00:00:00 BC",
  "year 10000": "10000-01-01T00:00:00Z",
  infinity: "infinity",
  "-infinity": "-infinity",
};
for (const [label, value] of Object.entries(unsupported)) {
  test(`a stored date out of range (${label}) is a structured conflict; other files stay planned`, () =>
    transaction(async () => {
      await client.query(
        `INSERT INTO publications (id, locale, slug, status, published_at)
         VALUES ($1, 'fr', 'date-folle', 'draft', $2::timestamptz)`,
        [ID.a, value],
      );
      await client.query(
        `INSERT INTO reflections (id, locale, slug, status, published_at)
         VALUES ($1, 'fr', 'date-folle-r', 'draft', $2::timestamptz)`,
        [ID.b, value],
      );
      const result = await plan([
        publicationDoc({ id: ID.a, slug: "date-folle" }),
        reflectionDoc({ id: ID.b, slug: "date-folle-r" }),
        reflectionDoc({ id: ID.c }),
      ]);
      assert.deepEqual(
        result.operations.map((o) =>
          o.kind === "CONFLICT" ? codes(o) : o.kind,
        ),
        [["UNSUPPORTED_STORED_DATE"], ["UNSUPPORTED_STORED_DATE"], "CREATE"],
      );
      assert.equal(result.applicable, false);
    }));
}

test("a plan built in a REPEATABLE READ READ ONLY transaction issues only plain SELECTs and equals the plain plan", async () => {
  // Committed seeds (autocommit) so the read-only transaction sees them.
  const suffix = randomUUID().slice(0, 8);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const mediaId = randomUUID();
  const themeSlug = "ro-" + suffix;
  const themeId = await insertTheme(themeSlug);
  await insertMedia(mediaId);
  const pub = publicationDoc({
    id: ids[0]!,
    status: "published",
    slug: "ro-pub-" + suffix,
    themes: [themeSlug],
    media: mediaId,
  });
  const docs = [
    pub,
    reflectionDoc({ id: ids[1]!, slug: "ro-new-" + suffix }),
    publicationDoc({ id: ids[2]!, slug: "ro-owned-" + suffix }),
  ];
  await seedFromDoc(pub, [themeId]);
  // Another row owns this slug: the third document collides with it.
  await seedFromDoc(
    publicationDoc({ id: ids[3]!, slug: "ro-owned-" + suffix }),
  );
  const cleanup = async () => {
    await client.query("DELETE FROM publications WHERE id = ANY($1)", [ids]);
    await client.query("DELETE FROM media_assets WHERE id = $1", [mediaId]);
    await client.query("DELETE FROM themes WHERE id = $1", [themeId]);
  };
  const snapshotTables = async () =>
    JSON.stringify(
      (
        await client.query(
          `SELECT 'p' AS t, id, updated_at::text, xmin::text FROM publications
           UNION ALL SELECT 'r', id, updated_at::text, xmin::text FROM reflections
           UNION ALL SELECT 'pt', publication_id, theme_id::text, xmin::text FROM publication_themes
           ORDER BY 1, 2`,
        )
      ).rows,
    );
  const tablesBefore = await snapshotTables();

  const statements: string[] = [];
  const original = client.query;
  (client as unknown as { query: unknown }).query = function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const first = args[0] as string | { text: string };
    statements.push(typeof first === "string" ? first : first.text);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
  let readOnlyPlan;
  try {
    readOnlyPlan = await drizzle(client).transaction(
      (tx) => buildImportPlan(docs, importReader(tx)),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    (client as unknown as { query: unknown }).query = original;
  }

  try {
    assert.ok(statements.length > 0);
    for (const sql of statements) {
      assert.match(
        sql.trimStart(),
        /^(select|begin|commit|rollback)\b/i,
        "unexpected statement: " + sql,
      );
      assert.doesNotMatch(
        sql,
        /\bfor\s+(update|share|key\s+share|no\s+key\s+update)\b/i,
        "explicit row lock: " + sql,
      );
    }
    assert.ok(
      statements.some((sql) =>
        /^begin isolation level repeatable read read only/i.test(sql.trim()),
      ),
    );
    // Random UUIDs make positions vary: check each file, then the sort order.
    const outcome = (file: string) => {
      const o = readOnlyPlan.operations.find((x) => x.file === file)!;
      return o.kind === "CONFLICT" ? codes(o) : o.kind;
    };
    assert.equal(outcome(pub.file), "NOOP");
    assert.equal(outcome(docs[1]!.file), "CREATE");
    assert.deepEqual(outcome(docs[2]!.file), ["SLUG_COLLISION"]);
    assert.deepEqual(
      readOnlyPlan.operations.map((o) => o.file),
      [pub.file, docs[2]!.file].sort().concat(docs[1]!.file),
    );
    assert.equal(readOnlyPlan.applicable, false);
    // Same inputs, no transaction: same plan.
    assert.deepEqual(
      await buildImportPlan(docs, importReader(drizzle(client))),
      readOnlyPlan,
    );
    assert.equal(await snapshotTables(), tablesBefore);
  } finally {
    await cleanup();
  }
});
