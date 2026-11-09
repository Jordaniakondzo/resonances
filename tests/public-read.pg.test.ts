import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { publicContentWhere } from "../db/visibility.js";
import { publications } from "../db/schema.js";
import { publicPublicationsRepository } from "../src/repositories/public-publications.js";
import { createPublicDatabase } from "../src/repositories/public-database.js";
import { createPublicPublicationsService } from "../src/services/public-publications.js";
import {
  provisionB1Roles,
  withRoleLock,
  migrateWithViewsOwner,
  holdRoleLock,
} from "./support/b1-roles.js";

// Public read boundary against a real, dedicated PostgreSQL instance.
// Identities: admin (TEST_DATABASE_URL, superuser, owns the fixtures) and
// resonances_app_reader, provisioned from the production files in
// db/provisioning and used through createPublicDatabase.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );

const READER = "resonances_app_reader";
const VIEWS_OWNER = "resonances_public_views_owner";
const PROVISION_SQL = readFileSync("db/provisioning/app-reader.sql", "utf8");
const VERIFY_SQL = readFileSync(
  "db/provisioning/app-reader-verify.sql",
  "utf8",
);
const SELFCHECK_SQL = readFileSync(
  "db/provisioning/app-reader-selfcheck.sql",
  "utf8",
);
const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
const readerPassword = randomBytes(18).toString("hex");
let created = false;
let dbAdmin: pg.Client; // superuser inside the test database: fixtures and catalog probes
let rawReader: pg.Client; // plain connection as the reader: what the role itself can do
let publicDb: ReturnType<typeof createPublicDatabase>;
let service: ReturnType<typeof createPublicPublicationsService>;
const notices: string[] = [];
const adminNotices: string[] = [];

function urlFor(user: string | null, password: string | null): string {
  const url = new URL(connectionString as string);
  url.pathname = "/" + database;
  if (user !== null && password !== null) {
    url.username = user;
    url.password = password;
  }
  return url.toString();
}

before(async () => {
  await admin.connect();
  await provisionB1Roles(admin);
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  dbAdmin = new pg.Client({ connectionString: urlFor(null, null) });
  dbAdmin.on("notice", (n) => adminNotices.push(n.message ?? ""));
  await dbAdmin.connect();
  await migrateWithViewsOwner(admin, [], () =>
    migrate(drizzle(dbAdmin), { migrationsFolder: "db/migrations" }),
  );
  // Enabling LOGIN is the operator's step; the roles are cluster-wide, so
  // serialise with the other test files (lock and change on `admin`, in the lock
  // database: advisory locks are per database).
  await withRoleLock(admin, async () => {
    await admin.query(
      `ALTER ROLE ${READER} LOGIN PASSWORD '${readerPassword}'`,
    );
  });
  const readerUrl = urlFor(READER, readerPassword);
  rawReader = new pg.Client({ connectionString: readerUrl });
  rawReader.on("notice", (n) => notices.push(n.message ?? ""));
  await rawReader.connect();
  publicDb = createPublicDatabase(readerUrl);
  service = createPublicPublicationsService(() =>
    publicPublicationsRepository(publicDb.db),
  );
});

after(async () => {
  await rawReader?.end();
  await publicDb?.close();
  await dbAdmin?.end();
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

// --- fixtures ---------------------------------------------------------------

const ORIGINAL_URL = "https://private.example.test/original-SECRET.tif";

async function insertMedia(webUrl: string | null = "https://cdn.test/w.webp") {
  const id = randomUUID();
  await dbAdmin.query(
    `INSERT INTO media_assets (id, original_filename, original_url, web_url, thumbnail_url,
       alt_text, caption, author, source, license, width, height)
     VALUES ($1, 'orig-SECRET.tif', $2, $3, 'https://cdn.test/t.webp', 'Alt', 'Cap', 'Auteur', 'Source', 'CC0', 800, 600)`,
    [id, ORIGINAL_URL, webUrl],
  );
  return id;
}

async function insertTheme(slug: string, name: string) {
  const id = randomUUID();
  await dbAdmin.query(
    "INSERT INTO themes (id, locale, name, slug, description) VALUES ($1, 'fr', $2, $3, 'PRIVATE-DESCRIPTION')",
    [id, name, slug],
  );
  return id;
}

interface Pub {
  slug?: string | null;
  title?: string;
  status?: "draft" | "published" | "archived";
  // A SQL expression evaluated by PostgreSQL (so the test never depends on the JS clock).
  publishedAt?: string | null;
  locale?: string;
  media?: string | null;
  themeIds?: string[];
}
const PAST = "now() - interval '1 day'";
const FUTURE = "now() + interval '30 days'";
async function insertPublication(p: Pub = {}) {
  const id = randomUUID();
  const slug = p.slug === undefined ? "p-" + id.slice(0, 8) : p.slug;
  const publishedAt =
    p.publishedAt === undefined ? PAST : (p.publishedAt ?? "NULL");
  await dbAdmin.query(
    `INSERT INTO publications (id, locale, slug, title, status, published_at, hook,
       observation, evocation, reflection, open_question, media_asset_id)
     VALUES ($1, $2, $3, $4, $5, ${publishedAt}, 'Accroche',
       'Obs', 'Evo', 'Refl', 'Question ?', $6)`,
    [
      id,
      p.locale ?? "fr",
      slug,
      p.title ?? "Titre " + slug,
      p.status ?? "published",
      p.media ?? null,
    ],
  );
  for (const themeId of p.themeIds ?? []) {
    await dbAdmin.query(
      "INSERT INTO publication_themes (publication_id, theme_id) VALUES ($1, $2)",
      [id, themeId],
    );
  }
  return { id, slug: slug as string };
}

const slugsOf = async (limit = 100) =>
  (await service.listPublications({ limit })).map((p) => p.slug);

// Runs a body inside a transaction that is always rolled back.
async function rolledBack(client: pg.Client, body: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}

// Role changes are cluster-wide: hold the shared role lock (the one the
// provisioning and migration helpers take, C7) and always roll back. The changes
// run on dbAdmin, in this file's database; the lock is held by `admin`, in the
// lock database, because advisory locks are per database. A failing statement
// aborts the transaction, so a body that expects a failure must use a savepoint.
async function withTemporaryRoleChange(
  statements: string[],
  body: () => Promise<void>,
) {
  await holdRoleLock(admin, async () => {
    await dbAdmin.query("BEGIN");
    try {
      for (const statement of statements) await dbAdmin.query(statement);
      await body();
    } finally {
      await dbAdmin.query("ROLLBACK");
    }
  });
}

const failureOf = async (client: pg.ClientBase, text: string) => {
  try {
    await client.query(text);
    return "ok";
  } catch (error) {
    return (error as pg.DatabaseError).code ?? String(error);
  }
};
const DENIED = "42501";

// --- visibility, through the service ------------------------------------------

test("listPublications returns only public publications, newest first", async () => {
  const visibleOld = await insertPublication({
    publishedAt: "now() - interval '40 days'",
  });
  const visibleNew = await insertPublication();
  const draft = await insertPublication({ status: "draft", publishedAt: null });
  const draftDated = await insertPublication({ status: "draft" });
  const scheduled = await insertPublication({ publishedAt: FUTURE });
  const archived = await insertPublication({ status: "archived" });
  const noSlug = await insertPublication({
    slug: null,
    status: "draft",
    publishedAt: null,
  });
  const otherLocale = await insertPublication({ locale: "en" });

  const slugs = await slugsOf();
  for (const hidden of [
    draft,
    draftDated,
    scheduled,
    archived,
    noSlug,
    otherLocale,
  ]) {
    assert.ok(!slugs.includes(hidden.slug ?? ""), `leaked ${hidden.slug}`);
  }
  assert.ok(slugs.includes(visibleOld.slug) && slugs.includes(visibleNew.slug));
  assert.ok(slugs.indexOf(visibleNew.slug) < slugs.indexOf(visibleOld.slug));
});

test("getPublicationBySlug finds a visible publication with its themes and image", async () => {
  const media = await insertMedia();
  const t1 = await insertTheme("zeta-" + randomUUID().slice(0, 6), "Zeta");
  const t2 = await insertTheme("alpha-" + randomUUID().slice(0, 6), "Alpha");
  const pub = await insertPublication({ media, themeIds: [t1, t2] });

  const found = await service.getPublicationBySlug(pub.slug);
  assert.ok(found);
  assert.equal(found.slug, pub.slug);
  assert.equal(found.observation, "Obs");
  assert.equal(found.openQuestion, "Question ?");
  assert.deepEqual(
    found.themes.map((t) => t.name),
    ["Alpha", "Zeta"],
  );
  assert.equal(found.image?.url, "https://cdn.test/w.webp");
  assert.equal(found.image?.alt, "Alt");
});

test("non public slugs and unknown slugs all resolve to null", async () => {
  const draft = await insertPublication({ status: "draft", publishedAt: null });
  const scheduled = await insertPublication({ publishedAt: FUTURE });
  const archived = await insertPublication({ status: "archived" });
  const otherLocale = await insertPublication({ locale: "en" });
  for (const slug of [
    draft.slug,
    scheduled.slug,
    archived.slug,
    otherLocale.slug,
    "inexistant-xyz",
  ]) {
    assert.equal(await service.getPublicationBySlug(slug), null, slug);
  }
});

test("withdrawing a published publication removes it from list and detail", async () => {
  const theme = await insertTheme("w-" + randomUUID().slice(0, 6), "W");
  const pub = await insertPublication({ themeIds: [theme] });
  assert.ok(await service.getPublicationBySlug(pub.slug));
  for (const status of ["archived", "draft"]) {
    await dbAdmin.query("UPDATE publications SET status = $2 WHERE id = $1", [
      pub.id,
      status,
    ]);
    assert.equal(await service.getPublicationBySlug(pub.slug), null, status);
    assert.ok(!(await slugsOf()).includes(pub.slug), status);
    await dbAdmin.query(
      "UPDATE publications SET status = 'published' WHERE id = $1",
      [pub.id],
    );
    assert.ok(await service.getPublicationBySlug(pub.slug));
  }
});

test("the database clock decides and a caller cannot inject an instant", async () => {
  const future = await insertPublication({ publishedAt: FUTURE });
  // The public API has no instant parameter: extra options are ignored.
  const forged = { at: new Date("2999-01-01T00:00:00Z") };
  assert.equal(
    // @ts-expect-error `at` is not part of the public options
    await service.getPublicationBySlug(future.slug, forged),
    null,
  );
  // @ts-expect-error `at` is not part of the public options
  const listed = await service.listPublications(forged);
  assert.ok(!listed.some((p) => p.slug === future.slug));
});

// --- visibility, direct SQL as the reader (the security boundary itself) ------------

test("direct SQL: a draft exposes no private data, not even to a leaky function", async () => {
  const marker = "HIDDEN-" + randomUUID().slice(0, 8);
  const visible = await insertPublication({ title: "Visible " + marker });
  const draft = await insertPublication({
    status: "draft",
    title: "Draft " + marker,
    publishedAt: null,
  });
  const archived = await insertPublication({
    status: "archived",
    title: "Archived " + marker,
  });
  // A caller-supplied function with a tiny COST would run first on an ordinary
  // view and could raise a NOTICE for every row it sees. security_barrier forbids it.
  await dbAdmin.query(
    `CREATE OR REPLACE FUNCTION public.t2_leak(text) RETURNS boolean
     LANGUAGE plpgsql COST 0.0000001 AS $$ BEGIN RAISE NOTICE 'LEAK:%', $1; RETURN true; END $$`,
  );
  await dbAdmin.query(
    "GRANT EXECUTE ON FUNCTION public.t2_leak(text) TO PUBLIC",
  );
  try {
    notices.length = 0;
    const result = await rawReader.query(
      "SELECT slug FROM public_read.publications WHERE t2_leak(title) AND title LIKE $1",
      ["%" + marker],
    );
    assert.deepEqual(
      result.rows.map((r) => r.slug),
      [visible.slug],
    );
    const leaked = notices.filter((n) => n.includes(marker));
    assert.deepEqual(
      leaked,
      ["LEAK:Visible " + marker],
      "only a visible row reached the function",
    );
    assert.ok(
      ![draft, archived].some((p) =>
        result.rows.some((r) => r.slug === p.slug),
      ),
    );

    // Control: the same attack on an ordinary (non-barrier) view DOES leak the
    // hidden rows to the function, which proves the check above is not vacuous.
    await dbAdmin.query(
      `CREATE VIEW public.t2_control AS SELECT title, status FROM publications WHERE status = 'published'`,
    );
    await dbAdmin.query("GRANT SELECT ON public.t2_control TO " + READER);
    notices.length = 0;
    await rawReader.query(
      "SELECT title FROM public.t2_control WHERE t2_leak(title) AND title LIKE $1",
      ["%" + marker],
    );
    assert.ok(
      notices.includes("LEAK:Archived " + marker),
      "control view should leak hidden rows to the function",
    );
  } finally {
    await dbAdmin.query("DROP VIEW IF EXISTS public.t2_control");
    await dbAdmin.query("DROP FUNCTION IF EXISTS public.t2_leak(text)");
  }
});

test("direct SQL: a scheduled publication stays hidden until its due time, then appears", async () => {
  const pub = await insertPublication({
    publishedAt: "clock_timestamp() + interval '1500 milliseconds'",
  });
  const readCount = async () =>
    (
      await rawReader.query(
        "SELECT slug FROM public_read.publications WHERE slug = $1",
        [pub.slug],
      )
    ).rows.length;
  assert.equal(await readCount(), 0, "before the due time");
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(await readCount(), 1, "after the due time");
});

test("direct SQL: the due instant is inclusive, exact to the microsecond, and agrees with publicContentWhere", async () => {
  await rolledBack(dbAdmin, async () => {
    // now() is fixed inside the transaction: the rows sit exactly on, just after
    // and just before the boundary that the views evaluate.
    const equal = await insertPublication({ publishedAt: "now()" });
    const after = await insertPublication({
      publishedAt: "now() + interval '1 microsecond'",
    });
    const before = await insertPublication({
      publishedAt: "now() - interval '1 microsecond'",
    });
    const draftNow = await insertPublication({
      status: "draft",
      publishedAt: "now()",
    });
    const archivedNow = await insertPublication({
      status: "archived",
      publishedAt: "now()",
    });
    const all = [equal, after, before, draftNow, archivedNow];
    // Same rows, same transaction, read AS the reader through the views.
    await dbAdmin.query(`SET LOCAL ROLE ${READER}`);
    const viaViews = (
      await dbAdmin.query(
        "SELECT slug FROM public_read.publications WHERE slug = ANY($1)",
        [all.map((p) => p.slug)],
      )
    ).rows
      .map((r) => r.slug as string)
      .sort();
    await dbAdmin.query("RESET ROLE");
    assert.deepEqual(viaViews, [equal.slug, before.slug].sort());

    // Parity with the table-level contract (db/visibility.ts).
    const viaTables = (
      await drizzle(dbAdmin)
        .select({ slug: publications.slug })
        .from(publications)
        .where(publicContentWhere(publications))
    )
      .map((r) => r.slug as string)
      .filter((s) => all.some((p) => p.slug === s))
      .sort();
    assert.deepEqual(viaViews, viaTables);
  });
});

test("direct SQL: archive and withdrawal expose nothing, themes included", async () => {
  const theme = await insertTheme("arch-" + randomUUID().slice(0, 6), "Arch");
  const pub = await insertPublication({ themeIds: [theme] });
  const count = async (relation: string, column: string, value: string) =>
    (
      await rawReader.query(
        `SELECT count(*)::int AS n FROM public_read.${relation} WHERE ${column} = $1`,
        [value],
      )
    ).rows[0].n as number;
  assert.equal(await count("publications", "slug", pub.slug), 1);
  assert.equal(await count("publication_themes", "publication_id", pub.id), 1);
  await dbAdmin.query(
    "UPDATE publications SET status = 'archived' WHERE id = $1",
    [pub.id],
  );
  assert.equal(await count("publications", "slug", pub.slug), 0);
  assert.equal(await count("publication_themes", "publication_id", pub.id), 0);
});

// --- columns, media and output hygiene -------------------------------------------

test("the views expose exactly the public columns, and only public rows", async () => {
  const media = await insertMedia();
  const pub = await insertPublication({ media });
  const hidden = await insertPublication({
    status: "draft",
    publishedAt: null,
  });
  const rows = await rawReader.query(
    "SELECT * FROM public_read.publications WHERE slug = ANY($1)",
    [[pub.slug, hidden.slug]],
  );
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(Object.keys(rows.rows[0]).sort(), [
    "evocation",
    "hook",
    "id",
    "image_alt_text",
    "image_author",
    "image_caption",
    "image_height",
    "image_license",
    "image_source",
    "image_thumbnail_url",
    "image_web_url",
    "image_width",
    "locale",
    "observation",
    "open_question",
    "published_at",
    "reflection",
    "slug",
    "title",
  ]);
  const themes = await rawReader.query(
    "SELECT * FROM public_read.publication_themes LIMIT 1",
  );
  assert.deepEqual(themes.fields.map((f) => f.name).sort(), [
    "publication_id",
    "theme_name",
    "theme_slug",
  ]);
  const serialized = JSON.stringify(rows.rows);
  for (const secret of ["SECRET", ORIGINAL_URL, "PRIVATE-DESCRIPTION"]) {
    assert.ok(!serialized.includes(secret), `view output contains ${secret}`);
  }
});

test("media: only Web variants are exposed, never originals, never private metadata", async () => {
  const noWeb = await insertPublication({ media: await insertMedia(null) });
  const blankWeb = await insertPublication({ media: await insertMedia("   ") });
  const withWeb = await insertPublication({ media: await insertMedia() });
  const row = async (slug: string) =>
    (
      await rawReader.query(
        "SELECT image_web_url, image_thumbnail_url, image_alt_text, image_width FROM public_read.publications WHERE slug = $1",
        [slug],
      )
    ).rows[0];
  for (const pub of [noWeb, blankWeb]) {
    assert.deepEqual(await row(pub.slug), {
      image_web_url: null,
      image_thumbnail_url: null,
      image_alt_text: null,
      image_width: null,
    });
    assert.equal((await service.getPublicationBySlug(pub.slug))?.image, null);
  }
  assert.equal(
    (await row(withWeb.slug)).image_web_url,
    "https://cdn.test/w.webp",
  );
  for (const column of ["original_url", "original_filename", "created_at"]) {
    assert.equal(
      await failureOf(rawReader, `SELECT ${column} FROM public.media_assets`),
      DENIED,
      column,
    );
  }
});

test("service results contain no private field", async () => {
  const media = await insertMedia();
  const pub = await insertPublication({ media });
  const detail = await service.getPublicationBySlug(pub.slug);
  const listed = (await service.listPublications({ limit: 100 })).find(
    (p) => p.slug === pub.slug,
  );
  assert.ok(detail && listed);
  assert.deepEqual(Object.keys(listed).sort(), [
    "hook",
    "image",
    "publishedAt",
    "slug",
    "themes",
    "title",
  ]);
  assert.deepEqual(Object.keys(detail).sort(), [
    "evocation",
    "hook",
    "image",
    "locale",
    "observation",
    "openQuestion",
    "publishedAt",
    "reflection",
    "slug",
    "themes",
    "title",
  ]);
  for (const value of [JSON.stringify(detail), JSON.stringify(listed)]) {
    for (const secret of [
      "SECRET",
      ORIGINAL_URL,
      pub.id,
      media,
      "status",
      "created_at",
      "updatedAt",
    ]) {
      assert.ok(!value.includes(secret), `output contains ${secret}`);
    }
  }
});

test("a database failure surfaces as a generic error without SQL", async () => {
  const broken = createPublicDatabase(urlFor(READER, "wrong-password"));
  const failing = createPublicPublicationsService(() =>
    publicPublicationsRepository(broken.db),
  );
  try {
    await assert.rejects(failing.listPublications(), (error: Error) => {
      assert.equal(error.name, "PublicReadError");
      assert.ok(!/select|publications|password|postgres/i.test(error.message));
      return true;
    });
  } finally {
    await broken.close();
  }
});

// --- read-only path and least privilege -----------------------------------------

test("the public pool connects as the reader role in a read-only session", async () => {
  const res = await publicDb.pool.query(
    `SELECT current_user AS u, current_setting('default_transaction_read_only') AS ro,
            (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls
               FROM pg_roles WHERE rolname = current_user) AS powerful`,
  );
  assert.deepEqual(res.rows[0], { u: READER, ro: "on", powerful: false });
});

test("the source tables are closed to the reader, every column included", async () => {
  for (const table of [
    "publications",
    "publication_themes",
    "themes",
    "media_assets",
    "reflections",
    "reflection_themes",
  ]) {
    assert.equal(
      await failureOf(rawReader, `SELECT * FROM public.${table}`),
      DENIED,
      table,
    );
    assert.equal(
      await failureOf(rawReader, `SELECT count(*) FROM public.${table}`),
      DENIED,
      table,
    );
  }
  for (const statement of [
    "SELECT id, slug FROM public.publications",
    "SELECT created_at FROM public.publications",
    "SELECT name FROM public.themes",
    "SELECT web_url FROM public.media_assets",
    "SELECT d03_priv.lock_theme(gen_random_uuid())",
  ]) {
    assert.equal(await failureOf(rawReader, statement), DENIED, statement);
  }
  // The views remain readable.
  assert.equal(
    await failureOf(
      rawReader,
      "SELECT slug FROM public_read.publications LIMIT 1",
    ),
    "ok",
  );
});

test("the reader cannot write, even without the read-only session flag", async () => {
  for (const statement of [
    "INSERT INTO public.publications (slug, status) VALUES ('x-hack', 'draft')",
    "UPDATE public.publications SET status = 'published'",
    "DELETE FROM public.publications",
    "TRUNCATE public.publications",
    "INSERT INTO public.themes (name, slug) VALUES ('x', 'x')",
    "UPDATE public.media_assets SET alt_text = 'x'",
    "CREATE TABLE public.reader_made_this (id int)",
    "CREATE VIEW public_read.reader_made_this AS SELECT 1",
    "CREATE SCHEMA reader_schema",
    "DROP VIEW public_read.publications",
    "ALTER VIEW public_read.publications OWNER TO " + READER,
  ]) {
    assert.equal(await failureOf(rawReader, statement), DENIED, statement);
  }
  // Data changes through the views: refused (privilege, or "not updatable"),
  // and never executed.
  for (const statement of [
    "INSERT INTO public_read.publications (slug) VALUES ('x-hack')",
    "UPDATE public_read.publications SET title = 'x'",
    "DELETE FROM public_read.publications",
    "INSERT INTO public_read.publication_themes (theme_slug) VALUES ('x')",
    "TRUNCATE public_read.publications",
  ]) {
    assert.notEqual(await failureOf(rawReader, statement), "ok", statement);
  }
  // Through the pool the session flag is a second barrier.
  await assert.rejects(
    publicDb.pool.query("DELETE FROM public_read.publications"),
    (e: pg.DatabaseError) => e.code !== undefined,
  );
});

test("the reader cannot switch to another role", async () => {
  for (const role of [
    VIEWS_OWNER,
    "resonances_b1_owner",
    "resonances_importer",
  ]) {
    assert.equal(await failureOf(rawReader, `SET ROLE ${role}`), DENIED, role);
  }
});

test("the views are owned by the dedicated owner, with security_barrier, and the reader holds SELECT on them only", async () => {
  const res = await dbAdmin.query(
    `SELECT c.relname, r.rolname AS owner, c.reloptions
     FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.relnamespace = 'public_read'::regnamespace ORDER BY 1`,
  );
  assert.deepEqual(
    res.rows.map((r) => [r.relname, r.owner, r.reloptions]),
    [
      ["publication_themes", VIEWS_OWNER, ["security_barrier=true"]],
      ["publications", VIEWS_OWNER, ["security_barrier=true"]],
    ],
  );
  const grants = await dbAdmin.query(
    `SELECT table_name, privilege_type FROM information_schema.table_privileges
     WHERE grantee = $1 AND table_schema IN ('public', 'public_read') ORDER BY 1, 2`,
    [READER],
  );
  assert.deepEqual(
    grants.rows.map((r) => [r.table_name, r.privilege_type]),
    [
      ["publication_themes", "SELECT"],
      ["publications", "SELECT"],
    ],
  );
  const columns = await dbAdmin.query(
    `SELECT count(*)::int AS n FROM information_schema.column_privileges
     WHERE grantee = $1 AND table_schema = 'public'`,
    [READER],
  );
  assert.equal(
    columns.rows[0].n,
    0,
    "no column privilege on the source tables",
  );
});

// --- provisioning hardening -------------------------------------------------------

// Caller must hold the shared role lock (inside withTemporaryRoleChange).
const verifyOutcome = async () => {
  try {
    await dbAdmin.query(VERIFY_SQL);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
};

// C7: the verification reads the members of the views owner, which another test
// file's migration holds for a moment. Outside a role transaction, read them
// under the shared role lock (held by `admin`, in the lock database) so such a
// membership can never be observed.
const lockedVerifyOutcome = () => holdRoleLock(admin, verifyOutcome);

test("operational verification passes on the activated reader (LOGIN enabled)", async () => {
  assert.equal(
    (
      await dbAdmin.query(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
        [READER],
      )
    ).rows[0].rolcanlogin,
    true,
  );
  assert.equal(await lockedVerifyOutcome(), "ok");
});

test("the self-check run as the reader passes, and refuses any other identity", async () => {
  await rawReader.query(SELFCHECK_SQL);
  await assert.rejects(dbAdmin.query(SELFCHECK_SQL), /selfcheck: connected as/);
});

test("a reader with an unauthorized membership fails the verification and the provisioning", async () => {
  // INHERIT membership.
  await withTemporaryRoleChange(
    [
      "CREATE ROLE resonances_t2_test_extra NOLOGIN",
      `GRANT resonances_t2_test_extra TO ${READER} WITH INHERIT TRUE, SET TRUE`,
    ],
    async () => {
      assert.match(await verifyOutcome(), /is a member of another role/);
    },
  );
  // SET-only membership is refused as well: it is a SET ROLE path.
  await withTemporaryRoleChange(
    [
      "CREATE ROLE resonances_t2_test_extra NOLOGIN",
      `GRANT resonances_t2_test_extra TO ${READER} WITH INHERIT FALSE, SET TRUE`,
    ],
    async () => {
      await dbAdmin.query("SAVEPOINT s");
      await assert.rejects(
        dbAdmin.query(PROVISION_SQL),
        /member of another role/,
      );
      await dbAdmin.query("ROLLBACK TO s");
    },
  );
  // Another role holding the reader would inherit the reader's rights.
  await withTemporaryRoleChange(
    [
      "CREATE ROLE resonances_t2_test_extra NOLOGIN",
      `GRANT ${READER} TO resonances_t2_test_extra`,
    ],
    async () => {
      assert.match(
        await verifyOutcome(),
        /another role is a member of the reader/,
      );
    },
  );
});

test("the migration preflight refuses a reader with an unauthorized membership", async () => {
  await withTemporaryRoleChange(
    [
      "CREATE ROLE resonances_t2_test_extra NOLOGIN",
      `GRANT resonances_t2_test_extra TO ${READER}`,
    ],
    async () => {
      const sql = readFileSync(
        "db/migrations/0002_public_read_views.sql",
        "utf8",
      );
      const preflight = sql.split("--> statement-breakpoint")[0] as string;
      await dbAdmin.query("SAVEPOINT s");
      await assert.rejects(
        dbAdmin.query(preflight),
        /must not be members of any role/,
      );
      await dbAdmin.query("ROLLBACK TO s");
    },
  );
});

test("the verification detects drifted privileges and definitions", async () => {
  const cases: Array<[string[], RegExp]> = [
    [
      ["GRANT SELECT ON public.themes TO " + READER],
      /reader has a privilege on public\.themes/,
    ],
    [
      ["GRANT SELECT (name) ON public.themes TO " + READER],
      /reader has a privilege on public\.themes/,
    ],
    [
      ["GRANT INSERT ON public_read.publications TO " + READER],
      /unexpected privileges of the reader on view/,
    ],
    [
      ["GRANT USAGE ON SCHEMA d03_priv TO " + READER],
      /USAGE on schema d03_priv/,
    ],
    [
      ["GRANT CREATE ON SCHEMA public_read TO " + READER],
      /can CREATE in schema public_read/,
    ],
    [
      ["GRANT UPDATE ON public.publications TO " + VIEWS_OWNER],
      /views owner has a write-type privilege/,
    ],
    [
      ["GRANT SELECT (original_url) ON public.media_assets TO " + VIEWS_OWNER],
      /unauthorized SELECT on public\.media_assets\.original_url/,
    ],
    [["ALTER ROLE " + VIEWS_OWNER + " LOGIN"], /views owner can log in/],
    [
      ["ALTER VIEW public_read.publications SET (security_barrier = false)"],
      /unexpected definition of view/,
    ],
    [
      ["ALTER VIEW public_read.publications SET (security_invoker = true)"],
      /unexpected definition of view/,
    ],
    [
      ["CREATE VIEW public_read.extra AS SELECT 1"],
      /exactly the two public views/,
    ],
  ];
  for (const [statements, pattern] of cases) {
    await withTemporaryRoleChange(statements, async () => {
      assert.match(await verifyOutcome(), pattern, statements.join("; "));
    });
  }
});

test("provisioning is stable when repeated on a conforming state", async () => {
  const snapshot = async () =>
    JSON.stringify(
      (
        await dbAdmin.query(
          `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
                  rolcanlogin, rolinherit, oid::int AS oid,
                  (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships
           FROM pg_roles r WHERE rolname IN ($1, $2) ORDER BY rolname`,
          [READER, VIEWS_OWNER],
        )
      ).rows,
    ) +
    JSON.stringify(
      (
        await dbAdmin.query(
          `SELECT c.relname, c.relacl::text FROM pg_class c
           WHERE c.relnamespace = 'public_read'::regnamespace ORDER BY 1`,
        )
      ).rows,
    );
  const before = await snapshot();
  // Cluster-wide script: run on `admin`, in the lock database (C7).
  await withRoleLock(admin, async () => {
    await admin.query(PROVISION_SQL);
    await admin.query(PROVISION_SQL);
  });
  assert.equal(await snapshot(), before);
  assert.equal(await lockedVerifyOutcome(), "ok");
});

test("provisioning never silently repairs a role found in an unexpected state", async () => {
  await withTemporaryRoleChange(
    ["ALTER ROLE " + READER + " CREATEDB"],
    async () => {
      await dbAdmin.query("SAVEPOINT s");
      await assert.rejects(
        dbAdmin.query(PROVISION_SQL),
        /privileged attributes/,
      );
      await dbAdmin.query("ROLLBACK TO s");
      // The attribute is left exactly as found: nothing was altered.
      assert.equal(
        (
          await dbAdmin.query(
            "SELECT rolcreatedb FROM pg_roles WHERE rolname = $1",
            [READER],
          )
        ).rows[0].rolcreatedb,
        true,
      );
    },
  );
  await withTemporaryRoleChange(
    ["ALTER ROLE " + VIEWS_OWNER + " LOGIN"],
    async () => {
      await dbAdmin.query("SAVEPOINT s");
      await assert.rejects(dbAdmin.query(PROVISION_SQL), /must be NOLOGIN/);
      await dbAdmin.query("ROLLBACK TO s");
    },
  );
});

// --- C4: membership of the views owner -----------------------------------------------

const EXTRA = "resonances_t2_test_extra";
const EXTRA2 = "resonances_t2_test_extra2";
const MIGRATION_SQL = readFileSync(
  "db/migrations/0002_public_read_views.sql",
  "utf8",
);
const PREFLIGHT_SQL = MIGRATION_SQL.split(
  "--> statement-breakpoint",
)[0] as string;

// Names the authorized migration identity for the scripts that read it. Valid
// inside the transaction opened by withTemporaryRoleChange.
const nameMigrator = (role: string) =>
  dbAdmin.query("SELECT set_config('resonances.migration_role', $1, true)", [
    role,
  ]);

// Runs a script that is expected to fail, inside a savepoint so the surrounding
// transaction survives, and returns the failure message.
async function failureMessage(text: string): Promise<string> {
  await dbAdmin.query("SAVEPOINT expected_failure");
  try {
    await dbAdmin.query(text);
    return "ok";
  } catch (error) {
    return (error as Error).message;
  } finally {
    await dbAdmin.query("ROLLBACK TO expected_failure");
  }
}

// Caller must hold the shared role lock (inside withTemporaryRoleChange).
const membersOfOwner = async () =>
  (
    await dbAdmin.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
       WHERE m.roleid = '${VIEWS_OWNER}'::regrole ORDER BY 1`,
    )
  ).rows.map((r) => r.rolname as string);

// C7: same reading outside a role transaction, under the shared role lock.
const lockedMembersOfOwner = () => holdRoleLock(admin, membersOfOwner);

test("C4: a SET-only member that is not the authorized migrator is refused everywhere, and never revoked", async () => {
  await withTemporaryRoleChange(
    [
      `CREATE ROLE ${EXTRA} NOLOGIN`,
      `GRANT ${VIEWS_OWNER} TO ${EXTRA} WITH INHERIT FALSE, SET TRUE`,
    ],
    async () => {
      for (const [label, text] of [
        ["verify", VERIFY_SQL],
        ["provisioning", PROVISION_SQL],
        ["migration preflight", PREFLIGHT_SQL],
      ] as const) {
        const message = await failureMessage(text);
        assert.match(
          message,
          new RegExp(
            `unauthorized member\\(s\\) of resonances_public_views_owner: ${EXTRA} \\(SET\\)`,
          ),
          label,
        );
      }
      // Diagnostics only: the membership was found, reported and left in place.
      assert.deepEqual(await membersOfOwner(), [EXTRA]);
    },
  );
  assert.deepEqual(await lockedMembersOfOwner(), []);
});

test("C4: the authorized migrator must be named, and must be SET-only", async () => {
  await withTemporaryRoleChange(
    [
      `CREATE ROLE ${EXTRA} NOLOGIN`,
      `GRANT ${VIEWS_OWNER} TO ${EXTRA} WITH INHERIT FALSE, SET TRUE`,
    ],
    async () => {
      // Not named: refused, with a diagnostic that says so.
      assert.match(
        await failureMessage(VERIFY_SQL),
        /authorized migration role: none/,
      );
      // Named: accepted by the verification and the provisioning.
      await nameMigrator(EXTRA);
      assert.equal(await failureMessage(VERIFY_SQL), "ok");
      assert.equal(await failureMessage(PROVISION_SQL), "ok");
      // A name that is no role is refused rather than ignored.
      await nameMigrator("no_such_role_xyz");
      assert.match(await failureMessage(VERIFY_SQL), /names no existing role/);
      assert.match(
        await failureMessage(PROVISION_SQL),
        /names no existing role/,
      );
      await nameMigrator(EXTRA);
      // INHERIT or ADMIN on the authorized member is refused as well.
      await dbAdmin.query(
        `GRANT ${VIEWS_OWNER} TO ${EXTRA} WITH INHERIT TRUE, SET TRUE`,
      );
      assert.match(await failureMessage(VERIFY_SQL), /inherit or administer/);
      assert.match(await failureMessage(PROVISION_SQL), /SET-only/);
    },
  );
});

test("C4: an indirect chain of roles to the owner is refused, even through the authorized migrator", async () => {
  await withTemporaryRoleChange(
    [
      `CREATE ROLE ${EXTRA} NOLOGIN`,
      `CREATE ROLE ${EXTRA2} NOLOGIN`,
      `GRANT ${VIEWS_OWNER} TO ${EXTRA} WITH INHERIT FALSE, SET TRUE`,
      // EXTRA2 -> EXTRA -> owner
      `GRANT ${EXTRA} TO ${EXTRA2}`,
    ],
    async () => {
      await nameMigrator(EXTRA);
      const chain = new RegExp(
        `role ${EXTRA2} can reach resonances_public_views_owner through a membership chain`,
      );
      assert.match(await failureMessage(VERIFY_SQL), chain);
      assert.match(await failureMessage(PROVISION_SQL), chain);
      // The preflight runs as the migration identity (current_user = EXTRA).
      await dbAdmin.query("SAVEPOINT as_migrator");
      await dbAdmin.query(`SET LOCAL ROLE ${EXTRA}`);
      assert.match(await failureMessage(PREFLIGHT_SQL), chain);
      await dbAdmin.query("ROLLBACK TO as_migrator");
    },
  );
});

test("C4: NOLOGIN does not make the owner unreachable, and a superuser migrator needs no membership", async () => {
  // The owner is NOLOGIN, yet a SET-only member reaches it by SET ROLE: that is
  // exactly why membership is checked rather than assumed harmless.
  await withTemporaryRoleChange(
    [
      `CREATE ROLE ${EXTRA} LOGIN`,
      `GRANT ${VIEWS_OWNER} TO ${EXTRA} WITH INHERIT FALSE, SET TRUE`,
    ],
    async () => {
      await dbAdmin.query(`SET LOCAL ROLE ${EXTRA}`);
      await dbAdmin.query(`SET LOCAL ROLE ${VIEWS_OWNER}`);
      assert.equal(
        (await dbAdmin.query("SELECT current_user AS u")).rows[0].u,
        VIEWS_OWNER,
      );
      await dbAdmin.query("RESET ROLE");
      assert.match(await failureMessage(VERIFY_SQL), /unauthorized member/);
    },
  );
  assert.deepEqual(await lockedMembersOfOwner(), []);
});

// --- C5: effective privileges of the views owner ---------------------------------------

const ownerCan = async (sql: string) =>
  (await dbAdmin.query(sql)).rows[0].allowed as boolean;

test("C5: an extra SELECT of the owner on an unauthorized relation is detected, and left as found", async () => {
  await withTemporaryRoleChange(
    [`GRANT SELECT ON public.reflections TO ${VIEWS_OWNER}`],
    async () => {
      assert.match(
        await failureMessage(VERIFY_SQL),
        /views owner has an unauthorized SELECT on public\.reflections\./,
      );
      assert.match(
        await failureMessage(PREFLIGHT_SQL),
        /views owner has an unauthorized SELECT on public\.reflections\..*nothing was changed/,
      );
      // Nothing was repaired behind our back.
      assert.equal(
        await ownerCan(
          `SELECT has_table_privilege('${VIEWS_OWNER}', 'public.reflections', 'SELECT') AS allowed`,
        ),
        true,
      );
    },
  );
});

test("C5: whole-table SELECT, a column outside the list and a PUBLIC grant are all effective privileges", async () => {
  const cases: Array<[string, RegExp]> = [
    // Table-level SELECT covers created_at, which is not in the allowed list.
    [
      `GRANT SELECT ON public.publications TO ${VIEWS_OWNER}`,
      /unauthorized SELECT on public\.publications\.created_at/,
    ],
    [
      `GRANT SELECT (description) ON public.themes TO ${VIEWS_OWNER}`,
      /unauthorized SELECT on public\.themes\.description/,
    ],
    [
      `GRANT SELECT (original_filename) ON public.media_assets TO ${VIEWS_OWNER}`,
      /unauthorized SELECT on public\.media_assets\.original_filename/,
    ],
    [
      `GRANT SELECT ON public.reflection_themes TO ${VIEWS_OWNER}`,
      /unauthorized SELECT on public\.reflection_themes\./,
    ],
    // Through PUBLIC: nobody was granted to the owner by name.
    [
      "GRANT SELECT ON public.reflections TO PUBLIC",
      /(views owner has an unauthorized SELECT on public\.reflections|the reader has a privilege on public\.reflections)/,
    ],
  ];
  for (const [statement, pattern] of cases) {
    await withTemporaryRoleChange([statement], async () => {
      assert.match(await failureMessage(VERIFY_SQL), pattern, statement);
    });
  }
  // The preflight reports the PUBLIC case on the owner, before any grant of the migration.
  await withTemporaryRoleChange(
    ["GRANT SELECT ON public.reflections TO PUBLIC"],
    async () => {
      assert.match(
        await failureMessage(PREFLIGHT_SQL),
        /views owner has an unauthorized SELECT on public\.reflections\./,
      );
    },
  );
});

test("C5: an inherited privilege through a role membership is detected", async () => {
  await withTemporaryRoleChange(
    [`GRANT pg_read_all_data TO ${VIEWS_OWNER}`],
    async () => {
      // Membership of another role is refused at the first check it meets...
      assert.match(
        await failureMessage(VERIFY_SQL),
        /is a member of another role/,
      );
      // ...and the preflight does not rely on that check: the privilege itself is effective.
      assert.match(
        await failureMessage(PREFLIGHT_SQL),
        /views owner has (an unauthorized SELECT on|a privilege on sequence) /,
      );
    },
  );
});

test("C5: the privileges the views need are required, and write privileges are refused", async () => {
  await withTemporaryRoleChange(
    [`REVOKE SELECT (web_url) ON public.media_assets FROM ${VIEWS_OWNER}`],
    async () => {
      assert.match(
        await failureMessage(VERIFY_SQL),
        /views owner lacks SELECT on public\.media_assets\.web_url/,
      );
    },
  );
  await withTemporaryRoleChange(
    [`GRANT UPDATE (title) ON public.publications TO ${VIEWS_OWNER}`],
    async () => {
      assert.match(
        await failureMessage(VERIFY_SQL),
        /write-type privilege on public\.publications/,
      );
      assert.match(
        await failureMessage(PREFLIGHT_SQL),
        /write-type privilege on public\.publications/,
      );
    },
  );
});

test("C5: the conforming state is exactly the allowed column list", async () => {
  const granted = (
    await dbAdmin.query(
      `SELECT c.relname || '.' || a.attname AS col
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND has_column_privilege('${VIEWS_OWNER}', c.oid, a.attnum, 'SELECT')
       ORDER BY 1`,
    )
  ).rows.map((r) => r.col as string);
  assert.deepEqual(
    granted,
    [
      "media_assets.alt_text",
      "media_assets.author",
      "media_assets.caption",
      "media_assets.id",
      "media_assets.license",
      "media_assets.source",
      "media_assets.thumbnail_url",
      "media_assets.web_url",
      "media_assets.height",
      "media_assets.width",
      "publication_themes.publication_id",
      "publication_themes.theme_id",
      "publications.evocation",
      "publications.hook",
      "publications.id",
      "publications.locale",
      "publications.media_asset_id",
      "publications.observation",
      "publications.open_question",
      "publications.published_at",
      "publications.reflection",
      "publications.slug",
      "publications.status",
      "publications.title",
      "themes.id",
      "themes.name",
      "themes.slug",
    ].sort(),
  );
});

// --- C6: TEMPORARY ---------------------------------------------------------------------

test("C6: TEMPORARY is reported, not revoked; temporary objects are possible, permanent ones and sources are not", async () => {
  // Effective permission, as the catalog says and as the reader experiences it.
  const effective = (
    await dbAdmin.query(
      "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS allowed",
      [READER],
    )
  ).rows[0].allowed as boolean;
  assert.equal(
    effective,
    true,
    "default PUBLIC TEMPORARY is kept: T2 does not change database-wide privileges",
  );

  adminNotices.length = 0;
  assert.equal(await lockedVerifyOutcome(), "ok");
  assert.ok(
    adminNotices.some((n) =>
      /effective TEMPORARY on this database: true, via PUBLIC: true/.test(n),
    ),
    adminNotices.join(" | "),
  );

  // The reader can create a session-local temporary table...
  assert.equal(
    await failureOf(rawReader, "CREATE TEMPORARY TABLE t2_tmp (id int)"),
    "ok",
  );
  assert.equal(await failureOf(rawReader, "DROP TABLE pg_temp.t2_tmp"), "ok");
  // ...but not a permanent object, and a temporary table opens no source table.
  assert.equal(
    await failureOf(rawReader, "CREATE TABLE public.t2_perm (id int)"),
    DENIED,
  );
  assert.equal(
    await failureOf(rawReader, "CREATE TABLE public_read.t2_perm (id int)"),
    DENIED,
  );
  assert.equal(
    await failureOf(
      rawReader,
      "CREATE TEMPORARY TABLE t2_copy AS SELECT * FROM public.publications",
    ),
    DENIED,
  );

  // The self-check ties the catalog to the behaviour and states the value.
  notices.length = 0;
  await rawReader.query(SELFCHECK_SQL);
  assert.ok(
    notices.some((n) => n.includes("effective TEMPORARY: true")),
    notices.join(" | "),
  );
});

test("C6: the verification follows the effective permission when PUBLIC TEMPORARY is revoked (rolled back)", async () => {
  // Database privilege, not a role change, but the verification also reads the
  // members of the views owner: same shared lock (C7), always rolled back.
  await withTemporaryRoleChange(
    [`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`],
    async () => {
      adminNotices.length = 0;
      assert.equal(await verifyOutcome(), "ok");
      assert.ok(
        adminNotices.some((n) =>
          /effective TEMPORARY on this database: false, via PUBLIC: false/.test(
            n,
          ),
        ),
        adminNotices.join(" | "),
      );
    },
  );
  // Untouched afterwards.
  assert.equal(
    (
      await dbAdmin.query(
        "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS a",
        [READER],
      )
    ).rows[0].a,
    true,
  );
});

// --- C9: TEMPORARY right versus read-only transaction ----------------------------

// Runs the self-check on a connection of the application pool itself, so with the
// application's session settings (default_transaction_read_only=on). Returns its notices.
async function selfcheckThroughPool(): Promise<string[]> {
  const client = await publicDb.pool.connect();
  const seen: string[] = [];
  const listener = (n: { message?: string }) => seen.push(n.message ?? "");
  client.on("notice", listener);
  try {
    await client.query(SELFCHECK_SQL);
  } finally {
    client.removeListener("notice", listener);
    client.release();
  }
  return seen;
}

const hasNotice = (seen: string[], expected: string) =>
  assert.ok(
    seen.some((n) => n.includes(expected)),
    `expected "${expected}" in: ${seen.join(" | ")}`,
  );

test("C9: the self-check tells the TEMPORARY right apart from a read-only transaction", async () => {
  // The application's session: the right is granted, yet the transaction refuses
  // every CREATE, temporary tables included (25006, not 42501).
  const pooled = await publicDb.pool.connect();
  try {
    const state = await pooled.query(
      `SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS granted,
              current_setting('transaction_read_only') AS ro`,
    );
    assert.deepEqual(state.rows[0], { granted: true, ro: "on" });
    assert.equal(
      await failureOf(pooled, "CREATE TEMPORARY TABLE t2_c9 (id int)"),
      "25006",
    );
  } finally {
    pooled.release();
  }
  // Previously reported as an anomaly; now an expected, explained outcome.
  hasNotice(
    await selfcheckThroughPool(),
    "effective TEMPORARY: true; read-only transaction: true; temporary table: refused by the read-only transaction",
  );
  // A read-write session of the same role really uses the right.
  notices.length = 0;
  await rawReader.query(SELFCHECK_SQL);
  hasNotice(
    notices,
    "effective TEMPORARY: true; read-only transaction: false; temporary table: created and dropped",
  );
});

test("C9: with TEMPORARY revoked, read-only and read-write sessions both agree with the catalog (restored)", async () => {
  // A reader session cannot see an uncommitted change, so the revocation is
  // committed, on this file's own test database only, and restored in `finally`.
  // Both a new session and rawReader (whose temporary schema already exists,
  // C6/C9 tests) are checked: the revocation reaches both at once.
  const fresh = new pg.Client({
    connectionString: urlFor(READER, readerPassword),
  });
  const freshNotices: string[] = [];
  fresh.on("notice", (n) => freshNotices.push(n.message ?? ""));
  await fresh.connect();
  await dbAdmin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`);
  try {
    hasNotice(
      await selfcheckThroughPool(),
      "effective TEMPORARY: false; read-only transaction: true; temporary table: refused by the read-only transaction",
    );
    await fresh.query(SELFCHECK_SQL);
    hasNotice(
      freshNotices,
      "effective TEMPORARY: false; read-only transaction: false; temporary table: refused for lack of TEMPORARY",
    );
    // Observed on PostgreSQL 18: an existing temporary schema does not keep the
    // right alive ("permission denied for schema pg_temp_N", same SQLSTATE).
    assert.equal(
      await failureOf(rawReader, "CREATE TEMPORARY TABLE t2_after (id int)"),
      DENIED,
    );
    notices.length = 0;
    await rawReader.query(SELFCHECK_SQL);
    hasNotice(
      notices,
      "effective TEMPORARY: false; read-only transaction: false; temporary table: refused for lack of TEMPORARY",
    );
  } finally {
    await dbAdmin.query(`GRANT TEMPORARY ON DATABASE "${database}" TO PUBLIC`);
    await fresh.end();
  }
  assert.equal(
    (
      await dbAdmin.query(
        "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS a",
        [READER],
      )
    ).rows[0].a,
    true,
  );
});
