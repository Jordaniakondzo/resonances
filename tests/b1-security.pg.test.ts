import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { runDryRun } from "../src/services/editorial-dry-run.js";
import {
  provisionB1Roles,
  withRoleLock,
  migrateWithViewsOwner,
  holdRoleLock,
  ROLE_LOCK_KEY,
} from "./support/b1-roles.js";
import { publicationDoc, ID } from "./support/plan-sources.js";

// ADR-B1 security and locking tests, on a dedicated PostgreSQL instance.
//
// Identities used here (all cluster-wide roles, created idempotently):
//   admin                       : TEST_DATABASE_URL, must be able to create roles
//   resonances_b1_test_migrator : non-superuser; owns the database and tables
//   resonances_b1_owner         : the B1 function owner (provisioned from the
//                                 production provisioning file)
//   resonances_importer         : the private importer identity
//   resonances_b1_test_app      : stand-in for the public application: it has
//                                 been granted nothing
//   resonances_b1_test_nomember : migration identity WITHOUT SET on the owner
//   resonances_b1_test_untrusted: a role that must never get any right on d03_priv
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "TEST_DATABASE_URL is required; use a dedicated PostgreSQL test instance.",
  );
const MIGRATOR = "resonances_b1_test_migrator";
const APP = "resonances_b1_test_app";
const NOMEMBER = "resonances_b1_test_nomember";
// An untrusted role: it must never end up with any right on d03_priv.
const UNTRUSTED = "resonances_b1_test_untrusted";
const OWNER = "resonances_b1_owner";
const IMPORTER = "resonances_importer";
const FUNCTIONS = [
  "d03_priv.lock_theme(uuid)",
  "d03_priv.lock_media_key(uuid)",
  "d03_priv.lock_media_ready(uuid)",
] as const;

const admin = new pg.Client({ connectionString });
const database = "resonances_test_" + randomUUID().replaceAll("-", "");
const passwords = new Map<string, string>();
const opened: pg.Client[] = [];
let created = false;

function urlFor(role: string, db = database): string {
  const url = new URL(connectionString as string);
  url.username = role;
  url.password = passwords.get(role) ?? "";
  url.pathname = "/" + db;
  return url.toString();
}
async function connectAs(role: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: urlFor(role) });
  await client.connect();
  opened.push(client);
  return client;
}
const sqlstate = (error: unknown): string =>
  (error as pg.DatabaseError).code ?? "no-code";

// Resolves to the SQLSTATE of the failure, or "ok" when the statement worked.
async function outcome(
  client: pg.Client,
  text: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await client.query(text, params);
    return "ok";
  } catch (error) {
    return sqlstate(error);
  }
}

let migrator: pg.Client;
let importer: pg.Client;
let app: pg.Client;
let writer: pg.Client; // the controlled Theme/MediaAsset writer circuit
let writer2: pg.Client; // a second writer, for waiting statements
let adminDb: pg.Client; // superuser inside the test database, for SET ROLE probes

before(async () => {
  await admin.connect();
  // Test identities. Passwords are random per run and never stored.
  for (const role of [MIGRATOR, APP, NOMEMBER, IMPORTER]) {
    passwords.set(role, randomBytes(18).toString("hex"));
  }
  await withRoleLock(admin, async () => {
    for (const role of [MIGRATOR, APP, NOMEMBER, UNTRUSTED]) {
      const exists = await admin.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (exists.rowCount === 0) await admin.query(`CREATE ROLE ${role}`);
      await admin.query(`ALTER ROLE ${role} NOSUPERUSER NOCREATEROLE LOGIN`);
    }
  });
  await provisionB1Roles(admin, [MIGRATOR]);
  await withRoleLock(admin, async () => {
    for (const role of [MIGRATOR, APP, NOMEMBER, IMPORTER]) {
      await admin.query(
        `ALTER ROLE ${role} LOGIN PASSWORD '${passwords.get(role)}'`,
      );
    }
  });

  await admin.query(`CREATE DATABASE "${database}" OWNER ${MIGRATOR}`);
  created = true;
  migrator = await connectAs(MIGRATOR);
  await migrateWithViewsOwner(admin, [MIGRATOR], () =>
    migrate(drizzle(migrator), { migrationsFolder: "db/migrations" }),
  );

  // Importer privileges as the writer policy describes them (SQL-WRITER-POLICY
  // §3): reads on every table, writes on the four editorial tables only.
  // This is test provisioning; the production grant circuit is outside B1.
  await migrator.query(`
    GRANT SELECT ON themes, media_assets, publications, reflections,
                    publication_themes, reflection_themes TO ${IMPORTER};
    GRANT INSERT, UPDATE, DELETE ON publications, reflections,
                    publication_themes, reflection_themes TO ${IMPORTER};`);

  importer = await connectAs(IMPORTER);
  app = await connectAs(APP);
  writer = await connectAs(MIGRATOR);
  writer2 = await connectAs(MIGRATOR);
  const adminUrl = new URL(connectionString as string);
  adminUrl.pathname = "/" + database;
  adminDb = new pg.Client({ connectionString: adminUrl.toString() });
  await adminDb.connect();
  opened.push(adminDb);
});

after(async () => {
  for (const client of opened) await client.end().catch(() => undefined);
  if (created) await admin.query(`DROP DATABASE "${database}"`);
  await admin.end();
});

async function insertTheme(): Promise<string> {
  const id = randomUUID();
  const slug = "t-" + id.slice(0, 8);
  await writer.query(
    "INSERT INTO themes (id, locale, name, slug) VALUES ($1, 'fr', $2, $2)",
    [id, slug],
  );
  return id;
}
async function insertMedia(): Promise<string> {
  const id = randomUUID();
  await writer.query(
    `INSERT INTO media_assets (id, original_url, alt_text, source, license, author, width, height)
     VALUES ($1, $2, 'Alt', 'Source', 'CC0', 'Auteur', 10, 20)`,
    [id, "https://example.test/" + id + ".jpg"],
  );
  return id;
}

// Runs one statement on the writer connection with a short lock_timeout, then
// rolls back. "55P03" means it was blocked by a row lock; "ok" means it ran.
async function writerAttempt(text: string, params: unknown[]): Promise<string> {
  await writer.query("BEGIN");
  try {
    await writer.query("SET LOCAL lock_timeout = '250ms'");
    return await outcome(writer, text, params);
  } finally {
    await writer.query("ROLLBACK");
  }
}
const BLOCKED = "55P03";

// ---------------------------------------------------------------------------
// Installation: catalog state after the migration
// ---------------------------------------------------------------------------

test("only the three approved functions exist, once each, owned by the B1 owner", async () => {
  const inSchema = await migrator.query(
    `SELECT p.oid::regprocedure::text AS signature, r.rolname AS owner,
            p.prosecdef, p.proconfig, p.provolatile, p.proisstrict
     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.pronamespace = 'd03_priv'::regnamespace ORDER BY 1`,
  );
  assert.deepEqual(
    inSchema.rows.map((r) => r.signature),
    [...FUNCTIONS].sort(),
  );
  for (const row of inSchema.rows) {
    assert.equal(row.owner, OWNER);
    assert.equal(row.prosecdef, true);
    assert.deepEqual(row.proconfig, ["search_path=pg_catalog, pg_temp"]);
    assert.equal(row.provolatile, "v");
    assert.equal(row.proisstrict, true);
  }
  // No overload or homonym of these names anywhere else in the database.
  const homonyms = await migrator.query(
    `SELECT count(*)::int AS n FROM pg_proc
     WHERE proname IN ('lock_theme', 'lock_media_key', 'lock_media_ready')`,
  );
  assert.equal(homonyms.rows[0].n, 3);
});

test("function bodies are static: no dynamic SQL and only qualified public tables", async () => {
  const { rows } = await migrator.query(
    `SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'd03_priv'::regnamespace`,
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const source = String(row.prosrc);
    assert.doesNotMatch(source, /\bEXECUTE\b/i, row.proname);
    assert.doesNotMatch(source, /\bformat\s*\(/i, row.proname);
    assert.doesNotMatch(source, /\b(COMMIT|ROLLBACK|SAVEPOINT)\b/i);
    const tables = [...source.matchAll(/\bFROM\s+([\w.]+)/gi)].map((m) => m[1]);
    assert.equal(tables.length, 1, row.proname);
    assert.match(String(tables[0]), /^public\.(themes|media_assets)$/);
  }
});

test("EXECUTE: the importer has it, PUBLIC, the application and the migrator do not", async () => {
  for (const fn of FUNCTIONS) {
    const acl = await adminDb.query(
      `SELECT a.grantee, a.privilege_type
       FROM pg_proc p, LATERAL aclexplode(p.proacl) a
       WHERE p.oid = $1::regprocedure`,
      [fn],
    );
    // grantee 0 is PUBLIC. Only the owner and the importer appear.
    assert.ok(
      acl.rows.every((r) => r.grantee !== "0"),
      fn,
    );
    const names = await adminDb.query(
      `SELECT DISTINCT r.rolname FROM pg_proc p,
         LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.oid = $1::regprocedure ORDER BY 1`,
      [fn],
    );
    assert.deepEqual(
      names.rows.map((r) => r.rolname),
      [IMPORTER, OWNER].sort(),
      fn,
    );
    const effective = await adminDb.query(
      `SELECT has_function_privilege($1, $4::regprocedure, 'EXECUTE') AS importer,
              has_function_privilege($2, $4::regprocedure, 'EXECUTE') AS app,
              has_function_privilege($3, $4::regprocedure, 'EXECUTE') AS migrator`,
      [IMPORTER, APP, MIGRATOR, fn],
    );
    assert.deepEqual(effective.rows[0], {
      importer: true,
      app: false,
      migrator: false,
    });
  }
});

test("schema d03_priv: owned by B1 owner, no PUBLIC access, importer USAGE only", async () => {
  const { rows } = await migrator.query(
    `SELECT r.rolname AS owner, n.nspacl::text AS acl
     FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
     WHERE n.nspname = 'd03_priv'`,
  );
  assert.equal(rows[0].owner, OWNER);
  const flags = await migrator.query(
    `SELECT
       has_schema_privilege($1, 'd03_priv', 'USAGE')  AS importer_usage,
       has_schema_privilege($1, 'd03_priv', 'CREATE') AS importer_create,
       has_schema_privilege($2, 'd03_priv', 'USAGE')  AS app_usage,
       has_schema_privilege($2, 'd03_priv', 'CREATE') AS app_create,
       has_schema_privilege($3, 'd03_priv', 'CREATE') AS migrator_create`,
    [IMPORTER, APP, MIGRATOR],
  );
  assert.deepEqual(flags.rows[0], {
    importer_usage: true,
    importer_create: false,
    app_usage: false,
    app_create: false,
    migrator_create: false,
  });
  // No ACL entry with an empty grantee (PUBLIC) on the schema.
  assert.doesNotMatch(String(rows[0].acl), /(^\{|,)=/);
});

test("the B1 owner: NOLOGIN, not superuser, no memberships, owns no table, default EXECUTE revoked", async () => {
  const role = await migrator.query(
    `SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication,
            rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1`,
    [OWNER],
  );
  assert.deepEqual(role.rows[0], {
    rolsuper: false,
    rolcanlogin: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolinherit: false,
  });
  const memberships = await migrator.query(
    `SELECT count(*)::int AS n FROM pg_auth_members WHERE member = $1::regrole`,
    [OWNER],
  );
  assert.equal(memberships.rows[0].n, 0);
  const owned = await migrator.query(
    `SELECT c.relname FROM pg_class c
     WHERE c.relowner = $1::regrole AND c.relnamespace <> 'pg_catalog'::regnamespace`,
    [OWNER],
  );
  assert.deepEqual(owned.rows, []);
  const tableOwners = await migrator.query(
    `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
  );
  assert.deepEqual(
    tableOwners.rows.map((r) => r.tableowner),
    [MIGRATOR],
  );
  // ALTER DEFAULT PRIVILEGES for the owner revokes EXECUTE from PUBLIC.
  const defaults = await migrator.query(
    `SELECT defaclobjtype, defaclacl::text AS acl FROM pg_default_acl
     WHERE defaclrole = $1::regrole`,
    [OWNER],
  );
  assert.equal(defaults.rows.length, 1);
  assert.equal(defaults.rows[0].defaclobjtype, "f");
  assert.doesNotMatch(String(defaults.rows[0].acl), /(^\{|,)=/);
});

test("B1 owner table privileges: SELECT on read columns, UPDATE(updated_at) only, no UPDATE(id)", async () => {
  const privileges = await migrator.query(
    `SELECT c.relname AS tbl, a.attname AS col,
            has_column_privilege($1, c.oid, a.attnum, 'SELECT') AS sel,
            has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AS upd,
            has_column_privilege($1, c.oid, a.attnum, 'INSERT') AS ins
     FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, a.attnum`,
    [OWNER],
  );
  const by = (table: string, key: "sel" | "upd" | "ins") =>
    privileges.rows.filter((r) => r.tbl === table && r[key]).map((r) => r.col);
  assert.deepEqual(by("themes", "sel"), ["id", "locale", "slug"]);
  assert.deepEqual(by("themes", "upd"), ["updated_at"]);
  assert.deepEqual(by("media_assets", "sel"), [
    "id",
    "original_url",
    "alt_text",
    "author",
    "source",
    "license",
    "width",
    "height",
  ]);
  assert.deepEqual(by("media_assets", "upd"), ["updated_at"]);
  for (const table of [
    "publications",
    "reflections",
    "publication_themes",
    "reflection_themes",
  ]) {
    for (const key of ["sel", "upd", "ins"] as const)
      assert.deepEqual(by(table, key), [], table);
  }
  for (const table of ["themes", "media_assets"])
    assert.deepEqual(by(table, "ins"), [], table);
  // Table-level privileges are absent: the grants are column grants only.
  const tableLevel = await migrator.query(
    `SELECT has_table_privilege($1, 'themes', 'UPDATE') AS t,
            has_table_privilege($1, 'media_assets', 'UPDATE') AS m,
            has_table_privilege($1, 'themes', 'DELETE') AS td,
            has_table_privilege($1, 'media_assets', 'DELETE') AS md`,
    [OWNER],
  );
  assert.deepEqual(tableLevel.rows[0], {
    t: false,
    m: false,
    td: false,
    md: false,
  });
});

test("importer: not a member of the owner, cannot inherit or SET ROLE, no write on references", async () => {
  const roles = await migrator.query(
    `SELECT pg_has_role($1, $2, 'MEMBER') AS member,
            pg_has_role($1, $2, 'USAGE')  AS usage,
            pg_has_role($1, $2, 'SET')    AS can_set,
            (SELECT count(*)::int FROM pg_auth_members WHERE member = $1::regrole) AS memberships`,
    [IMPORTER, OWNER],
  );
  assert.deepEqual(roles.rows[0], {
    member: false,
    usage: false,
    can_set: false,
    memberships: 0,
  });
  const attributes = await migrator.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
     FROM pg_roles WHERE rolname = $1`,
    [IMPORTER],
  );
  assert.deepEqual(Object.values(attributes.rows[0]), [
    false,
    false,
    false,
    false,
    false,
  ]);
  const privileges = await migrator.query(
    `SELECT t.tbl,
            has_any_column_privilege($1, t.tbl::regclass, 'UPDATE') AS upd,
            has_table_privilege($1, t.tbl::regclass, 'INSERT') AS ins,
            has_table_privilege($1, t.tbl::regclass, 'DELETE') AS del,
            has_table_privilege($1, t.tbl::regclass, 'TRUNCATE') AS trunc
     FROM (VALUES ('themes'), ('media_assets')) AS t(tbl)`,
    [IMPORTER],
  );
  for (const row of privileges.rows)
    assert.deepEqual(
      [row.upd, row.ins, row.del, row.trunc],
      [false, false, false, false],
      row.tbl,
    );
});

// ---------------------------------------------------------------------------
// Negative permissions, exercised through real sessions
// ---------------------------------------------------------------------------

test("the importer cannot lock reference rows directly (the problem B1 solves)", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  assert.equal(
    await outcome(importer, "SELECT id FROM themes WHERE id = $1 FOR SHARE", [
      themeId,
    ]),
    "42501",
  );
  assert.equal(
    await outcome(
      importer,
      "SELECT id FROM media_assets WHERE id = $1 FOR KEY SHARE",
      [mediaId],
    ),
    "42501",
  );
  // Plain reads remain possible (needed by the dry-run and the planner).
  assert.equal(
    await outcome(importer, "SELECT id FROM themes WHERE id = $1", [themeId]),
    "ok",
  );
});

test("the importer cannot modify, delete or insert reference rows", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  const statements: [string, unknown[]][] = [
    ["UPDATE themes SET description = 'x' WHERE id = $1", [themeId]],
    ["UPDATE themes SET updated_at = now() WHERE id = $1", [themeId]],
    ["UPDATE themes SET id = gen_random_uuid() WHERE id = $1", [themeId]],
    ["DELETE FROM themes WHERE id = $1", [themeId]],
    ["INSERT INTO themes (name, slug) VALUES ('x', 'x-importer')", []],
    ["UPDATE media_assets SET caption = 'x' WHERE id = $1", [mediaId]],
    ["UPDATE media_assets SET updated_at = now() WHERE id = $1", [mediaId]],
    ["DELETE FROM media_assets WHERE id = $1", [mediaId]],
    ["INSERT INTO media_assets (original_url) VALUES ('https://x.test/a')", []],
    ["TRUNCATE themes CASCADE", []],
  ];
  for (const [text, params] of statements)
    assert.equal(await outcome(importer, text, params), "42501", text);
});

test("the importer cannot replace, drop, alter or add functions, or create objects", async () => {
  const replacement = `CREATE OR REPLACE FUNCTION d03_priv.lock_theme(p_id uuid)
    RETURNS TABLE (id uuid, locale text, slug text) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text, NULL::text $$`;
  for (const text of [
    replacement,
    "CREATE FUNCTION d03_priv.lock_theme(p_id uuid, extra int) RETURNS int LANGUAGE sql AS 'SELECT 1'",
    "CREATE FUNCTION d03_priv.extra() RETURNS int LANGUAGE sql AS 'SELECT 1'",
    "DROP FUNCTION d03_priv.lock_theme(uuid)",
    "ALTER FUNCTION d03_priv.lock_theme(uuid) SET search_path = public",
    "ALTER FUNCTION d03_priv.lock_theme(uuid) OWNER TO " + IMPORTER,
    "ALTER SCHEMA d03_priv OWNER TO " + IMPORTER,
    "DROP SCHEMA d03_priv CASCADE",
    // Not an applicable migration identity either.
    "CREATE SCHEMA importer_schema",
    "CREATE TABLE public.importer_table (id int)",
    "CREATE TEMP TABLE ok_temp (id int)", // controlled: temp tables are allowed
  ]) {
    const result = await outcome(importer, text);
    if (text.startsWith("CREATE TEMP")) assert.equal(result, "ok", text);
    else assert.equal(result, "42501", text);
  }
  await importer.query("DROP TABLE IF EXISTS pg_temp.ok_temp");
});

test("the importer cannot become the owner, the migrator or any other role", async () => {
  for (const role of [OWNER, MIGRATOR, APP, "pg_write_all_data"]) {
    assert.equal(await outcome(importer, `SET ROLE ${role}`), "42501", role);
  }
  assert.equal(
    await outcome(importer, `SET SESSION AUTHORIZATION ${OWNER}`),
    "42501",
  );
  assert.equal(
    await outcome(importer, `GRANT ${OWNER} TO ${IMPORTER}`),
    "42501",
  );
  // A GRANT without grant option only warns; check it had no effect.
  await importer
    .query("GRANT UPDATE ON themes TO " + IMPORTER)
    .catch(() => undefined);
  const effective = await migrator.query(
    "SELECT has_any_column_privilege($1, 'themes', 'UPDATE') AS upd",
    [IMPORTER],
  );
  assert.equal(effective.rows[0].upd, false);
  const stillMember = await migrator.query(
    "SELECT pg_has_role($1, $2, 'SET') AS can_set",
    [IMPORTER, OWNER],
  );
  assert.equal(stillMember.rows[0].can_set, false);
});

test("the application role can call no B1 function, with or without schema USAGE", async () => {
  const themeId = await insertTheme();
  assert.equal(
    await outcome(app, "SELECT * FROM d03_priv.lock_theme($1)", [themeId]),
    "42501",
  );
  // Isolate the PUBLIC revocation from the schema ACL: grant USAGE inside a
  // rolled-back transaction and check that EXECUTE alone is still refused.
  await adminDb.query("BEGIN");
  try {
    await adminDb.query(`GRANT USAGE ON SCHEMA d03_priv TO ${APP}`);
    await adminDb.query(`SET LOCAL ROLE ${APP}`);
    for (const fn of ["lock_theme", "lock_media_key", "lock_media_ready"]) {
      await adminDb.query("SAVEPOINT probe");
      const error = await adminDb
        .query(`SELECT * FROM d03_priv.${fn}($1)`, [themeId])
        .then(() => null)
        .catch((e: unknown) => e as pg.DatabaseError);
      assert.equal(error?.code, "42501", fn);
      assert.match(String(error?.message), /permission denied for function/);
      await adminDb.query("ROLLBACK TO probe");
    }
  } finally {
    await adminDb.query("ROLLBACK");
  }
});

test("without UPDATE on a column the owner could not lock: the residual grant is necessary", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  await adminDb.query("BEGIN");
  try {
    await adminDb.query(
      `REVOKE UPDATE (updated_at) ON public.themes FROM ${OWNER}`,
    );
    await adminDb.query(
      `REVOKE UPDATE (updated_at) ON public.media_assets FROM ${OWNER}`,
    );
    await adminDb.query(`SET LOCAL ROLE ${IMPORTER}`);
    for (const [fn, id] of [
      ["lock_theme", themeId],
      ["lock_media_key", mediaId],
      ["lock_media_ready", mediaId],
    ] as const) {
      await adminDb.query("SAVEPOINT probe");
      const error = await adminDb
        .query(`SELECT * FROM d03_priv.${fn}($1)`, [id])
        .then(() => null)
        .catch((e: unknown) => e as pg.DatabaseError);
      assert.equal(error?.code, "42501", fn);
      await adminDb.query("ROLLBACK TO probe");
    }
  } finally {
    await adminDb.query("ROLLBACK");
  }
});

// ---------------------------------------------------------------------------
// Behaviour of the functions
// ---------------------------------------------------------------------------

test("positive: the importer receives exactly the approved fields", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  const theme = await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [
    themeId,
  ]);
  assert.deepEqual(
    theme.fields.map((f) => f.name),
    ["id", "locale", "slug"],
  );
  assert.equal(theme.rows.length, 1);
  assert.equal(theme.rows[0].id, themeId);
  assert.equal(theme.rows[0].locale, "fr");
  assert.equal(theme.rows[0].slug, "t-" + themeId.slice(0, 8));

  const key = await importer.query(
    "SELECT * FROM d03_priv.lock_media_key($1)",
    [mediaId],
  );
  assert.deepEqual(
    key.fields.map((f) => f.name),
    ["id"],
  );
  assert.deepEqual(key.rows, [{ id: mediaId }]);

  const ready = await importer.query(
    "SELECT * FROM d03_priv.lock_media_ready($1)",
    [mediaId],
  );
  assert.deepEqual(
    ready.fields.map((f) => f.name),
    [
      "id",
      "original_url",
      "alt_text",
      "source",
      "license",
      "author",
      "width",
      "height",
    ],
  );
  assert.deepEqual(ready.rows, [
    {
      id: mediaId,
      original_url: "https://example.test/" + mediaId + ".jpg",
      alt_text: "Alt",
      source: "Source",
      license: "CC0",
      author: "Auteur",
      width: 10,
      height: 20,
    },
  ]);
});

test("NULL, nil, absent and arbitrary UUIDs give zero rows; a malformed value is a type error", async () => {
  const inputs: (string | null)[] = [
    null,
    "00000000-0000-0000-0000-000000000000",
    randomUUID(),
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
  ];
  for (const fn of ["lock_theme", "lock_media_key", "lock_media_ready"]) {
    for (const value of inputs) {
      const result = await importer.query(
        `SELECT * FROM d03_priv.${fn}($1::uuid)`,
        [value],
      );
      assert.equal(result.rowCount, 0, fn + " " + value);
    }
    assert.equal(
      await outcome(importer, `SELECT * FROM d03_priv.${fn}('not-a-uuid')`),
      "22P02",
    );
  }
  // An id of the wrong table is simply absent: themes and media are separate.
  const themeId = await insertTheme();
  assert.equal(
    (
      await importer.query("SELECT * FROM d03_priv.lock_media_ready($1)", [
        themeId,
      ])
    ).rowCount,
    0,
  );
});

test("hostile objects cannot divert the functions: pg_temp, decoy schema, search_path", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  const fakeId = randomUUID();
  await adminDb.query(`
    CREATE SCHEMA decoy;
    CREATE TABLE decoy.themes (id uuid, locale text, slug text);
    CREATE TABLE decoy.media_assets (id uuid, original_url text, alt_text text,
      source text, license text, author text, width int, height int);
    GRANT USAGE ON SCHEMA decoy TO ${IMPORTER};`);
  await adminDb.query("INSERT INTO decoy.themes VALUES ($1, 'xx', 'decoy')", [
    fakeId,
  ]);
  await adminDb.query("INSERT INTO decoy.media_assets (id) VALUES ($1)", [
    fakeId,
  ]);
  try {
    await importer.query(
      `CREATE TEMP TABLE themes (id uuid, locale text, slug text)`,
    );
    await importer.query(`CREATE TEMP TABLE media_assets (id uuid, original_url text,
      alt_text text, source text, license text, author text, width int, height int)`);
    await importer.query(
      "INSERT INTO pg_temp.themes VALUES ($1, 'zz', 'temp')",
      [fakeId],
    );
    await importer.query("INSERT INTO pg_temp.media_assets (id) VALUES ($1)", [
      fakeId,
    ]);
    for (const path of [
      "pg_temp, public",
      "decoy, public",
      "pg_temp, decoy, pg_catalog",
      "decoy",
    ]) {
      await importer.query(`SET search_path = ${path}`);
      for (const fn of ["lock_theme", "lock_media_key", "lock_media_ready"]) {
        const decoyRow = await importer.query(
          `SELECT * FROM d03_priv.${fn}($1)`,
          [fakeId],
        );
        assert.equal(
          decoyRow.rowCount,
          0,
          `${fn} sees a decoy row via ${path}`,
        );
      }
      const real = await importer.query(
        "SELECT * FROM d03_priv.lock_theme($1)",
        [themeId],
      );
      assert.equal(real.rows[0].slug, "t-" + themeId.slice(0, 8), path);
      const realMedia = await importer.query(
        "SELECT * FROM d03_priv.lock_media_ready($1)",
        [mediaId],
      );
      assert.equal(realMedia.rows[0].source, "Source", path);
    }
  } finally {
    await importer.query("RESET search_path");
    await importer.query(
      "DROP TABLE IF EXISTS pg_temp.themes, pg_temp.media_assets",
    );
    await adminDb.query("DROP SCHEMA decoy CASCADE");
  }
});

test("functions neither begin nor end the caller's transaction", async () => {
  const themeId = await insertTheme();
  await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
  try {
    const before = await importer.query("SELECT txid_current()::text AS xid");
    await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [themeId]);
    const after = await importer.query(
      "SELECT txid_current()::text AS xid, current_setting('transaction_isolation') AS level",
    );
    assert.equal(after.rows[0].xid, before.rows[0].xid);
    assert.equal(after.rows[0].level, "serializable");
  } finally {
    await importer.query("ROLLBACK");
  }
  // Outside any transaction the call is a single-statement transaction.
  assert.equal(
    (await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [themeId]))
      .rowCount,
    1,
  );
});

// ---------------------------------------------------------------------------
// Locks on two independent connections
// ---------------------------------------------------------------------------

// Takes the lock in an open SERIALIZABLE transaction of the importer and runs
// `body` while it should be active. Always rolls back afterwards.
async function whileLocked(
  fn: string,
  id: string,
  body: () => Promise<void>,
): Promise<void> {
  await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
  try {
    const rows = await importer.query(`SELECT * FROM ${fn}($1)`, [id]);
    assert.equal(rows.rowCount, 1);
    await body();
  } finally {
    await importer.query("ROLLBACK");
  }
}

const MEDIA = {
  rename:
    "UPDATE media_assets SET original_url = original_url || '?v=2' WHERE id = $1",
  altText: "UPDATE media_assets SET alt_text = 'Changed' WHERE id = $1",
  license: "UPDATE media_assets SET license = NULL WHERE id = $1",
  technical: "UPDATE media_assets SET updated_at = now() WHERE id = $1",
  key: "UPDATE media_assets SET id = gen_random_uuid() WHERE id = $1",
  remove: "DELETE FROM media_assets WHERE id = $1",
  share: "SELECT id FROM media_assets WHERE id = $1 FOR SHARE",
  keyShare: "SELECT id FROM media_assets WHERE id = $1 FOR KEY SHARE",
};
const THEME = {
  slug: "UPDATE themes SET slug = slug || '-x' WHERE id = $1",
  locale: "UPDATE themes SET locale = 'en' WHERE id = $1",
  name: "UPDATE themes SET name = name || '!' WHERE id = $1",
  description: "UPDATE themes SET description = 'd' WHERE id = $1",
  remove: "DELETE FROM themes WHERE id = $1",
  share: "SELECT id FROM themes WHERE id = $1 FOR SHARE",
  // A foreign-key check takes FOR KEY SHARE on the parent row.
  link: `WITH r AS (INSERT INTO reflections DEFAULT VALUES RETURNING id)
         INSERT INTO reflection_themes (reflection_id, theme_id) SELECT id, $1 FROM r`,
};

async function observe(
  statements: Record<string, string>,
  id: string,
): Promise<Record<string, string>> {
  const observed: Record<string, string> = {};
  for (const [label, text] of Object.entries(statements))
    observed[label] = await writerAttempt(text, [id]);
  return observed;
}

test("lock_theme (FOR SHARE): blocks rename, delete and every UPDATE; allows shared readers and FK inserts", async () => {
  const id = await insertTheme();
  await whileLocked("d03_priv.lock_theme", id, async () => {
    assert.deepEqual(await observe(THEME, id), {
      slug: BLOCKED,
      locale: BLOCKED,
      name: BLOCKED,
      description: BLOCKED,
      remove: BLOCKED,
      share: "ok",
      link: "ok",
    });
  });
});

test("lock_media_ready (FOR SHARE): blocks metadata changes, key changes and delete", async () => {
  const id = await insertMedia();
  await whileLocked("d03_priv.lock_media_ready", id, async () => {
    assert.deepEqual(await observe(MEDIA, id), {
      rename: BLOCKED,
      altText: BLOCKED,
      license: BLOCKED,
      technical: BLOCKED,
      key: BLOCKED,
      remove: BLOCKED,
      share: "ok",
      keyShare: "ok",
    });
  });
});

test("lock_media_key (FOR KEY SHARE): blocks delete and key change only; non-key metadata changes pass", async () => {
  const id = await insertMedia();
  await whileLocked("d03_priv.lock_media_key", id, async () => {
    assert.deepEqual(await observe(MEDIA, id), {
      rename: "ok",
      altText: "ok",
      license: "ok",
      technical: "ok",
      key: BLOCKED,
      remove: BLOCKED,
      share: "ok",
      keyShare: "ok",
    });
  });
});

test("contrast: plain FOR KEY SHARE on a theme already blocks (locale, slug) but not name", async () => {
  // Why lock_theme uses FOR SHARE: (locale, slug) is a unique constraint that
  // can be a foreign-key target, so PostgreSQL treats it as a key.
  const id = await insertTheme();
  await writer2.query("BEGIN");
  try {
    await writer2.query("SELECT id FROM themes WHERE id = $1 FOR KEY SHARE", [
      id,
    ]);
    assert.deepEqual(
      await observe(
        {
          slug: THEME.slug,
          locale: THEME.locale,
          name: THEME.name,
          description: THEME.description,
        },
        id,
      ),
      { slug: BLOCKED, locale: BLOCKED, name: "ok", description: "ok" },
    );
  } finally {
    await writer2.query("ROLLBACK");
  }
});

test("locks last until the caller's transaction ends, then disappear", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  const calls = [
    ["d03_priv.lock_theme", themeId, THEME.name],
    ["d03_priv.lock_media_ready", mediaId, MEDIA.altText],
  ] as const;
  for (const [fn, id, blockedStatement] of calls) {
    // Still held after other statements ran, and after COMMIT it is gone.
    await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
    await importer.query(`SELECT * FROM ${fn}($1)`, [id]);
    await importer.query("SELECT 1");
    await importer.query("SELECT count(*) FROM themes");
    assert.equal(await writerAttempt(blockedStatement, [id]), BLOCKED, fn);
    await importer.query("COMMIT");
    assert.equal(
      await writerAttempt(blockedStatement, [id]),
      "ok",
      fn + " after COMMIT",
    );

    await importer.query("BEGIN");
    await importer.query(`SELECT * FROM ${fn}($1)`, [id]);
    assert.equal(await writerAttempt(blockedStatement, [id]), BLOCKED, fn);
    await importer.query("ROLLBACK");
    assert.equal(
      await writerAttempt(blockedStatement, [id]),
      "ok",
      fn + " after ROLLBACK",
    );

    // Outside an explicit transaction the lock ends with the statement.
    await importer.query(`SELECT * FROM ${fn}($1)`, [id]);
    assert.equal(
      await writerAttempt(blockedStatement, [id]),
      "ok",
      fn + " autocommit",
    );
  }
});

test("a rollback to a savepoint taken before the call releases the lock; a later savepoint does not", async () => {
  const id = await insertTheme();
  await importer.query("BEGIN");
  try {
    await importer.query("SAVEPOINT before_lock");
    await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [id]);
    assert.equal(await writerAttempt(THEME.name, [id]), BLOCKED);
    await importer.query("ROLLBACK TO before_lock");
    assert.equal(await writerAttempt(THEME.name, [id]), "ok");

    await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [id]);
    await importer.query("SAVEPOINT after_lock");
    await importer.query("ROLLBACK TO after_lock");
    assert.equal(await writerAttempt(THEME.name, [id]), BLOCKED);
  } finally {
    await importer.query("ROLLBACK");
  }
});

async function waitForLockWait(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { rows } = await adminDb.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the writer never reached a lock wait");
}

test("a waiting writer really waits on the importer's transaction, then proceeds after COMMIT", async () => {
  const id = await insertTheme();
  const pid = (await writer2.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
  await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
  await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [id]);
  const pending = writer2.query(
    "UPDATE themes SET slug = 'renamed-' || left(id::text, 8) WHERE id = $1 RETURNING slug",
    [id],
  );
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await waitForLockWait(pid);
  assert.equal(settled, false);
  await importer.query("COMMIT");
  const result = await pending;
  assert.equal(result.rows[0].slug, "renamed-" + id.slice(0, 8));
});

test("a locked theme or media deleted by a writer after our COMMIT is absent for the next call", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  await importer.query("BEGIN");
  await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [themeId]);
  await importer.query("SELECT * FROM d03_priv.lock_media_ready($1)", [
    mediaId,
  ]);
  await importer.query("COMMIT");
  await writer.query("DELETE FROM themes WHERE id = $1", [themeId]);
  await writer.query("DELETE FROM media_assets WHERE id = $1", [mediaId]);
  assert.equal(
    (await importer.query("SELECT * FROM d03_priv.lock_theme($1)", [themeId]))
      .rowCount,
    0,
  );
  assert.equal(
    (
      await importer.query("SELECT * FROM d03_priv.lock_media_ready($1)", [
        mediaId,
      ])
    ).rowCount,
    0,
  );
});

// Observed PostgreSQL behaviour when the row changed AFTER the importer's
// snapshot but BEFORE the lock call, in SERIALIZABLE. D03-06 must rely on
// these outcomes (retry the whole plan); this file does not test the retry.
test("observed: after a concurrent committed change the lock call fails with 40001, except a non-key change under FOR KEY SHARE", async () => {
  const outcomes: Record<string, string> = {};
  const scenarios: [
    string,
    string,
    string,
    (id: string) => Promise<unknown>,
  ][] = [
    [
      "theme renamed",
      "d03_priv.lock_theme",
      "theme",
      (id) =>
        writer.query("UPDATE themes SET slug = slug || '-r' WHERE id = $1", [
          id,
        ]),
    ],
    [
      "theme non-key update",
      "d03_priv.lock_theme",
      "theme",
      (id) =>
        writer.query("UPDATE themes SET description = 'd' WHERE id = $1", [id]),
    ],
    [
      "theme deleted",
      "d03_priv.lock_theme",
      "theme",
      (id) => writer.query("DELETE FROM themes WHERE id = $1", [id]),
    ],
    [
      "media metadata (ready)",
      "d03_priv.lock_media_ready",
      "media",
      (id) =>
        writer.query(
          "UPDATE media_assets SET alt_text = 'Changed' WHERE id = $1",
          [id],
        ),
    ],
    [
      "media deleted (ready)",
      "d03_priv.lock_media_ready",
      "media",
      (id) => writer.query("DELETE FROM media_assets WHERE id = $1", [id]),
    ],
    [
      "media non-key update (key)",
      "d03_priv.lock_media_key",
      "media",
      (id) =>
        writer.query(
          "UPDATE media_assets SET alt_text = 'Changed' WHERE id = $1",
          [id],
        ),
    ],
    [
      "media deleted (key)",
      "d03_priv.lock_media_key",
      "media",
      (id) => writer.query("DELETE FROM media_assets WHERE id = $1", [id]),
    ],
  ];
  for (const [label, fn, kind, change] of scenarios) {
    const id = kind === "theme" ? await insertTheme() : await insertMedia();
    await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
    try {
      await importer.query("SELECT count(*) FROM themes"); // fixes the snapshot
      await change(id);
      outcomes[label] = await outcome(importer, `SELECT * FROM ${fn}($1)`, [
        id,
      ]);
    } finally {
      await importer.query("ROLLBACK");
    }
  }
  assert.deepEqual(outcomes, {
    "theme renamed": "40001",
    "theme non-key update": "40001",
    "theme deleted": "40001",
    "media metadata (ready)": "40001",
    "media deleted (ready)": "40001",
    // Observed on PostgreSQL 18.6: FOR KEY SHARE follows a non-key update to
    // the new row version instead of failing, unlike FOR SHARE.
    "media non-key update (key)": "ok",
    "media deleted (key)": "40001",
  });
});

test("observed: under FOR KEY SHARE a non-key change commits while held, and the importer's snapshot stays stale", async () => {
  const id = await insertMedia();
  await importer.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
  try {
    await importer.query("SELECT * FROM d03_priv.lock_media_key($1)", [id]);
    const first = await importer.query(
      "SELECT alt_text FROM media_assets WHERE id = $1",
      [id],
    );
    assert.equal(first.rows[0].alt_text, "Alt");
    await writer.query("BEGIN");
    try {
      // Fail fast instead of hanging if the importer's lock blocks the writer.
      await writer.query("SET LOCAL lock_timeout = '500ms'");
      await writer.query(
        "UPDATE media_assets SET alt_text = 'Changed' WHERE id = $1",
        [id],
      );
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK");
      throw error;
    }
    const second = await importer.query(
      "SELECT alt_text FROM media_assets WHERE id = $1",
      [id],
    );
    // The lock did not stop the change, and the snapshot hides it: key-share
    // existence is not a revalidation of readiness metadata.
    assert.equal(second.rows[0].alt_text, "Alt");
  } finally {
    await importer.query("ROLLBACK");
  }
});

// ---------------------------------------------------------------------------
// Integration with the Drizzle/pg stack
// ---------------------------------------------------------------------------

test("Drizzle: the three calls run on the same connection and transaction as the import", async () => {
  const themeId = await insertTheme();
  const mediaId = await insertMedia();
  const pool = new pg.Pool({ connectionString: urlFor(IMPORTER), max: 3 });
  try {
    const db = drizzle(pool);
    await db.transaction(
      async (tx) => {
        const start = (
          await tx.execute(
            sql`SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`,
          )
        ).rows[0] as { pid: number; xid: string };
        // Untyped text parameter and explicit cast: both resolve to uuid.
        const theme = await tx.execute(
          sql`SELECT * FROM d03_priv.lock_theme(${themeId})`,
        );
        const key = await tx.execute(
          sql`SELECT * FROM d03_priv.lock_media_key(${mediaId}::uuid)`,
        );
        const ready = await tx.execute(
          sql`SELECT * FROM d03_priv.lock_media_ready(${mediaId}::uuid)`,
        );
        assert.equal(theme.rows.length, 1);
        assert.equal(key.rows.length, 1);
        assert.equal(ready.rows.length, 1);
        const end = (
          await tx.execute(
            sql`SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`,
          )
        ).rows[0] as { pid: number; xid: string };
        assert.deepEqual(end, start);
        // The strongest lock on the media (FOR SHARE) and on the theme holds
        // until this Drizzle transaction ends.
        assert.equal(await writerAttempt(THEME.slug, [themeId]), BLOCKED);
        assert.equal(await writerAttempt(MEDIA.altText, [mediaId]), BLOCKED);
        // Dependent reads in the same transaction still work.
        const themes = await tx.execute(
          sql`SELECT id FROM themes WHERE id = ${themeId}`,
        );
        assert.equal(themes.rows.length, 1);
      },
      { isolationLevel: "serializable", accessMode: "read write" },
    );
    assert.equal(await writerAttempt(THEME.slug, [themeId]), "ok");
    assert.equal(await writerAttempt(MEDIA.altText, [mediaId]), "ok");

    // A rolled-back Drizzle transaction releases them as well.
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT * FROM d03_priv.lock_theme(${themeId})`);
        throw new Error("abort import");
      }),
      /abort import/,
    );
    assert.equal(await writerAttempt(THEME.slug, [themeId]), "ok");
  } finally {
    await pool.end();
  }
});

test("dry-run: no B1 call, no locking read and no modification is issued under the importer identity", async () => {
  const statements: string[] = [];
  const pool = new pg.Pool({ connectionString: urlFor(IMPORTER), max: 1 });
  pool.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0];
      statements.push(
        typeof first === "string"
          ? first
          : String((first as { text?: string }).text),
      );
      return original(...args);
    };
  });
  try {
    const result = await runDryRun(drizzle(pool), {
      sources: [publicationDoc({ id: ID.a })],
      loadErrors: [],
    });
    assert.equal(result.status, "PLANNED");
    assert.ok(statements.length > 0);
    const joined = statements.join("\n");
    assert.doesNotMatch(joined, /d03_priv|lock_theme|lock_media/i);
    assert.doesNotMatch(
      joined,
      /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE|KEY\s+SHARE)\b/i,
    );
    assert.doesNotMatch(
      joined,
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i,
    );
  } finally {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Installation safeguards
// ---------------------------------------------------------------------------

const migrationSql = readFileSync(
  "db/migrations/0001_adr_b1_privileged_locking.sql",
  "utf8",
);
const preflight = migrationSql.split("--> statement-breakpoint")[0] as string;

async function preflightFailure(
  client: pg.Client,
  prepare: string[],
): Promise<string> {
  // These attempts temporarily alter shared roles (always rolled back), among
  // them the pg_authid rows of the owner and the importer that every test
  // file's provisioning re-asserts. The shared role lock is held by `admin`, in
  // the lock database: advisory locks are per database, so the lock formerly
  // taken here, in this file's database, excluded no other file. Taken before
  // the probe transaction starts (deadlock rule 1 in support/b1-roles.ts).
  return holdRoleLock(admin, async () => {
    await client.query("BEGIN");
    try {
      // The preflight describes the state BEFORE the migration. This database is
      // already migrated, so (superuser only) drop what the owner owns in it:
      // schema, functions, default ACLs and grants. Rolled back with the rest.
      if (client === adminDb) await client.query(`DROP OWNED BY ${OWNER}`);
      for (const statement of prepare) await client.query(statement);
      await client.query(preflight);
      return "preflight passed";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

test("preflight refuses a LOGIN owner, a privileged importer, an importer able to reach the owner", async () => {
  assert.equal(await preflightFailure(adminDb, []), "preflight passed");
  assert.match(
    await preflightFailure(adminDb, [`ALTER ROLE ${OWNER} LOGIN`]),
    /must be NOLOGIN/,
  );
  assert.match(
    await preflightFailure(adminDb, [`ALTER ROLE ${OWNER} CREATEROLE`]),
    /must not be superuser, CREATEROLE/,
  );
  assert.match(
    await preflightFailure(adminDb, [`ALTER ROLE ${IMPORTER} SUPERUSER`]),
    /must not be superuser, CREATEROLE/,
  );
  assert.match(
    await preflightFailure(adminDb, [`GRANT ${OWNER} TO ${IMPORTER}`]),
    /importer must not be able to inherit or SET ROLE/,
  );
  assert.match(
    await preflightFailure(adminDb, [
      `GRANT ${OWNER} TO ${IMPORTER} WITH INHERIT FALSE, SET FALSE`,
    ]),
    /importer must not be able to inherit or SET ROLE/,
  );
  assert.match(
    await preflightFailure(adminDb, [`ALTER TABLE themes OWNER TO ${OWNER}`]),
    /must not own the reference tables/,
  );
  assert.match(
    await preflightFailure(adminDb, [`GRANT ${APP} TO ${OWNER}`]),
    /must not be a member of any role/,
  );
});

test("preflight refuses a migration identity that cannot SET ROLE to the owner", async () => {
  const outsider = await connectAs(NOMEMBER);
  assert.match(
    await preflightFailure(outsider, []),
    /migration role must be allowed to SET ROLE/,
  );
});

test("a failing security migration is atomic: nothing from 0000 or 0001 survives", async () => {
  const scratch = "resonances_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${scratch}" OWNER ${NOMEMBER}`);
  const client = new pg.Client({ connectionString: urlFor(NOMEMBER, scratch) });
  await client.connect();
  try {
    await assert.rejects(
      migrate(drizzle(client), { migrationsFolder: "db/migrations" }),
      /SET ROLE/,
    );
    const left = await client.query(
      `SELECT to_regclass('public.themes')::text AS themes,
              to_regnamespace('d03_priv')::text AS schema,
              to_regclass('drizzle.__drizzle_migrations')::text AS journal`,
    );
    assert.deepEqual(left.rows[0], {
      themes: null,
      schema: null,
      journal: "drizzle.__drizzle_migrations",
    });
    // The journal table is created before the migration transaction starts;
    // it must hold no row.
    const recorded = await client.query(
      "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
    );
    assert.equal(recorded.rows[0].n, 0);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE "${scratch}"`);
  }
});

test("re-applying the migrations is a no-op and keeps exactly the same functions", async () => {
  const before = await migrator.query(
    `SELECT p.oid::int AS oid, md5(p.prosrc || p.proacl::text) AS sig
     FROM pg_proc p WHERE pronamespace = 'd03_priv'::regnamespace ORDER BY p.proname`,
  );
  await migrate(drizzle(migrator), { migrationsFolder: "db/migrations" });
  const after = await migrator.query(
    `SELECT p.oid::int AS oid, md5(p.prosrc || p.proacl::text) AS sig
     FROM pg_proc p WHERE pronamespace = 'd03_priv'::regnamespace ORDER BY p.proname`,
  );
  assert.deepEqual(after.rows, before.rows);
  const journal = await migrator.query(
    "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
  );
  assert.equal(journal.rows[0].n, 3);
});

// ---------------------------------------------------------------------------
// ACL model of the private schema (finding: inherited default privileges)
// ---------------------------------------------------------------------------

// Everything after the last statement breakpoint: the post-conditions block.
const postconditions = migrationSql
  .split("--> statement-breakpoint")
  .at(-1) as string;

// Runs `sqlText` after `prepare` inside a transaction that is always rolled
// back. Resolves to the error message, or to "passed".
async function blockFailure(
  client: pg.Client,
  prepare: string[],
  sqlText: string,
): Promise<string> {
  // Some anomalies are cluster-wide role memberships (GRANT <role> TO <role>):
  // same shared role lock as preflightFailure, held by `admin` in the lock
  // database, taken before the probe transaction starts.
  return holdRoleLock(admin, async () => {
    await client.query("BEGIN");
    try {
      for (const statement of prepare) await client.query(statement);
      await client.query(sqlText);
      return "passed";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

test("root cause: a schema created for the owner inherits the owner's default privileges, and REVOKE FROM PUBLIC does not remove them", async () => {
  await adminDb.query("BEGIN");
  try {
    await adminDb.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT CREATE ON SCHEMAS TO ${UNTRUSTED}`,
    );
    await adminDb.query(`CREATE SCHEMA d03_probe AUTHORIZATION ${OWNER}`);
    await adminDb.query(`SET LOCAL ROLE ${OWNER}`);
    await adminDb.query("REVOKE ALL ON SCHEMA d03_probe FROM PUBLIC");
    await adminDb.query("RESET ROLE");
    const { rows } = await adminDb.query(
      `SELECT nspacl::text AS acl,
              has_schema_privilege($1, 'd03_probe', 'CREATE') AS untrusted_create
       FROM pg_namespace WHERE nspname = 'd03_probe'`,
      [UNTRUSTED],
    );
    assert.match(String(rows[0].acl), new RegExp(UNTRUSTED + "=C/"));
    assert.equal(rows[0].untrusted_create, true);
  } finally {
    await adminDb.query("ROLLBACK");
  }
});

test("preflight refuses default privileges of the owner granting anything to another role or PUBLIC", async () => {
  for (const grant of [
    `GRANT CREATE ON SCHEMAS TO ${UNTRUSTED}`,
    `GRANT USAGE ON SCHEMAS TO ${UNTRUSTED}`,
    `GRANT EXECUTE ON FUNCTIONS TO ${UNTRUSTED}`,
    `GRANT SELECT ON TABLES TO ${UNTRUSTED}`,
    `GRANT USAGE ON SCHEMAS TO PUBLIC`,
  ]) {
    assert.match(
      await preflightFailure(adminDb, [
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} ${grant}`,
      ]),
      /default privileges of the B1 owner/,
      grant,
    );
  }
});

test("preflight refuses an owner that already owns objects, or that other roles can reach", async () => {
  assert.match(
    await preflightFailure(adminDb, [
      `CREATE SCHEMA d03_other AUTHORIZATION ${OWNER}`,
    ]),
    /must not own any object/,
  );
  for (const grant of [
    `GRANT ${OWNER} TO ${UNTRUSTED} WITH INHERIT TRUE, SET FALSE`,
    `GRANT ${OWNER} TO ${UNTRUSTED} WITH ADMIN OPTION, INHERIT FALSE, SET TRUE`,
  ]) {
    assert.match(
      await preflightFailure(adminDb, [grant]),
      /only SET-only/,
      grant,
    );
  }
  // A role that is (a member of) the importer must not reach the owner either.
  assert.match(
    await preflightFailure(adminDb, [
      `GRANT ${IMPORTER} TO ${UNTRUSTED}`,
      `GRANT ${OWNER} TO ${UNTRUSTED} WITH INHERIT FALSE, SET TRUE`,
    ]),
    /importer/,
  );
});

test("Case A: a pre-existing owner with dangerous default privileges is rejected and nothing survives", async () => {
  const scratch = "resonances_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE "${scratch}" OWNER ${MIGRATOR}`);
  const scratchUrl = new URL(connectionString as string);
  scratchUrl.pathname = "/" + scratch;
  const scratchAdmin = new pg.Client({
    connectionString: scratchUrl.toString(),
  });
  await scratchAdmin.connect();
  const client = new pg.Client({ connectionString: urlFor(MIGRATOR, scratch) });
  await client.connect();
  try {
    // pg_default_acl is per database: this does not affect any other test.
    await scratchAdmin.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT CREATE ON SCHEMAS TO ${UNTRUSTED}`,
    );
    await assert.rejects(
      migrate(drizzle(client), { migrationsFolder: "db/migrations" }),
      /default privileges of the B1 owner/,
    );
    const left = await client.query(
      `SELECT to_regclass('public.themes')::text AS themes,
              to_regnamespace('d03_priv')::text AS schema,
              (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS journal`,
    );
    assert.deepEqual(left.rows[0], { themes: null, schema: null, journal: 0 });
  } finally {
    await client.end();
    await scratchAdmin.end();
    await admin.query(`DROP DATABASE "${scratch}"`);
  }
});

test("Case B: a legitimate installation leaves exactly the approved ACLs", async () => {
  const schema = await adminDb.query(
    `SELECT r.rolname AS grantee, a.privilege_type AS priv, a.is_grantable
     FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
     LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'd03_priv' ORDER BY 1, 2`,
  );
  assert.deepEqual(
    schema.rows.filter((r) => r.grantee !== OWNER),
    [{ grantee: IMPORTER, priv: "USAGE", is_grantable: false }],
  );
  for (const fn of FUNCTIONS) {
    const acl = await adminDb.query(
      `SELECT r.rolname AS grantee, a.privilege_type AS priv, a.is_grantable
       FROM pg_proc p, LATERAL aclexplode(p.proacl) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.oid = $1::regprocedure ORDER BY 1, 2`,
      [fn],
    );
    assert.deepEqual(
      acl.rows.filter((r) => r.grantee !== OWNER),
      [{ grantee: IMPORTER, priv: "EXECUTE", is_grantable: false }],
      fn,
    );
  }
  // Effective privileges of every non-superuser role other than the owner.
  // Predefined pg_* roles are skipped: pg_read_all_data has USAGE on every
  // schema by design and grants neither CREATE nor EXECUTE.
  const effective = await adminDb.query(
    `SELECT r.rolname,
            has_schema_privilege(r.oid, 'd03_priv', 'CREATE') AS can_create,
            has_schema_privilege(r.oid, 'd03_priv', 'USAGE') AS can_use
     FROM pg_roles r
     WHERE NOT r.rolsuper AND r.rolname <> $1 AND r.rolname !~ '^pg_'
     ORDER BY 1`,
    [OWNER],
  );
  for (const row of effective.rows) {
    assert.equal(row.can_create, false, row.rolname + " must not CREATE");
    assert.equal(
      row.can_use,
      row.rolname === IMPORTER,
      row.rolname + ": USAGE only for the importer",
    );
  }
  assert.equal(
    await outcome(
      app,
      "SELECT * FROM d03_priv.lock_theme('00000000-0000-0000-0000-000000000000')",
    ),
    "42501",
  );
});

test("Case C: post-conditions refuse unexpected EXECUTE or schema rights, direct or through a role", async () => {
  assert.equal(await blockFailure(adminDb, [], postconditions), "passed");
  for (const fn of FUNCTIONS) {
    for (const grant of [
      `GRANT EXECUTE ON FUNCTION ${fn} TO ${UNTRUSTED}`,
      `GRANT EXECUTE ON FUNCTION ${fn} TO ${IMPORTER} WITH GRANT OPTION`,
    ]) {
      assert.match(
        await blockFailure(adminDb, [grant], postconditions),
        /unexpected ACL/,
        grant,
      );
    }
  }
  // Through a role: the application inherits a role that holds EXECUTE.
  assert.match(
    await blockFailure(
      adminDb,
      [
        `GRANT EXECUTE ON FUNCTION ${FUNCTIONS[0]} TO ${UNTRUSTED}`,
        `GRANT ${UNTRUSTED} TO ${APP}`,
      ],
      postconditions,
    ),
    /unexpected ACL/,
  );
  for (const grant of [
    `GRANT CREATE ON SCHEMA d03_priv TO ${UNTRUSTED}`,
    `GRANT USAGE ON SCHEMA d03_priv TO ${UNTRUSTED}`,
    `GRANT CREATE ON SCHEMA d03_priv TO ${IMPORTER}`,
    `GRANT USAGE ON SCHEMA d03_priv TO ${IMPORTER} WITH GRANT OPTION`,
    `GRANT CREATE ON SCHEMA d03_priv TO PUBLIC`,
  ]) {
    assert.match(
      await blockFailure(adminDb, [grant], postconditions),
      /unexpected ACL/,
      grant,
    );
  }
  // A path to the owner by inheritance, administration or SET ROLE.
  for (const grant of [
    `GRANT ${OWNER} TO ${APP} WITH INHERIT TRUE, SET FALSE`,
    `GRANT ${OWNER} TO ${UNTRUSTED} WITH ADMIN OPTION, INHERIT FALSE, SET TRUE`,
    `GRANT ${OWNER} TO ${IMPORTER} WITH INHERIT FALSE, SET TRUE`,
  ]) {
    assert.match(
      await blockFailure(adminDb, [grant], postconditions),
      /path to the B1 owner/,
      grant,
    );
  }
  // Default privileges of the owner granting anything.
  assert.match(
    await blockFailure(
      adminDb,
      [
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} GRANT EXECUTE ON FUNCTIONS TO ${UNTRUSTED}`,
      ],
      postconditions,
    ),
    /default privileges of the B1 owner/,
  );
  // The owner must own exactly the schema and the three functions.
  assert.match(
    await blockFailure(
      adminDb,
      [`CREATE SCHEMA d03_other AUTHORIZATION ${OWNER}`],
      postconditions,
    ),
    /owns unexpected objects/,
  );
});

test("post-conditions refuse a NULL schema ACL and an importer without USAGE, and the injected anomaly is rolled back", async () => {
  const aclBefore = (
    await adminDb.query(
      "SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'd03_priv'",
    )
  ).rows[0].acl;
  assert.match(String(aclBefore), new RegExp(IMPORTER + "=U/"));

  // Each anomaly must be caught by its own control, not by another one.
  assert.match(
    await blockFailure(
      adminDb,
      ["UPDATE pg_namespace SET nspacl = NULL WHERE nspname = 'd03_priv'"],
      postconditions,
    ),
    /schema d03_priv has no ACL/,
  );
  assert.match(
    await blockFailure(
      adminDb,
      [`REVOKE USAGE ON SCHEMA d03_priv FROM ${IMPORTER}`],
      postconditions,
    ),
    /importer lacks USAGE on schema d03_priv/,
  );

  // The anomalies were injected in rolled-back transactions only.
  const aclAfter = (
    await adminDb.query(
      "SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'd03_priv'",
    )
  ).rows[0].acl;
  assert.equal(aclAfter, aclBefore);
  assert.equal(await blockFailure(adminDb, [], postconditions), "passed");
});

// ---------------------------------------------------------------------------
// Shared role lock of the probes (overlap with another file's provisioning)
// ---------------------------------------------------------------------------

test("the role probes wait for a concurrent provisioning instead of racing it on the owner's row", async () => {
  // `provisioner` plays another test file's provisionB1Roles: in the lock
  // database, it holds the shared role lock and re-asserts the owner's
  // attributes exactly as db/provisioning/d03-b1-roles.sql does on every run.
  const provisioner = new pg.Client({ connectionString });
  const observer = new pg.Client({ connectionString });
  await provisioner.connect();
  await observer.connect();
  opened.push(provisioner, observer);
  const pidOf = async (client: pg.Client) =>
    (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
  const provisionerPid = await pidOf(provisioner);
  // Condition polling, never a fixed delay: resolves once `sqlText` is true for `pid`.
  const waitUntil = async (pid: number, sqlText: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((await observer.query(sqlText, [pid])).rows[0].ok) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`session ${pid} never reached: ${sqlText}`);
  };
  const reassertOwner = `ALTER ROLE ${OWNER}
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`;
  const startProvisioning = async () => {
    await provisioner.query("BEGIN");
    await provisioner.query(`SELECT pg_advisory_xact_lock(${ROLE_LOCK_KEY})`);
    await provisioner.query(reassertOwner);
  };

  try {
    // 1. The race itself, OUTSIDE the protocol (the probes' former situation): a
    //    probe updating the owner's row waits for the provisioning, then fails
    //    when the provisioning commits. The provisioner holds the shared lock, so
    //    no other test file is involved; the probe is rolled back.
    await startProvisioning();
    const adminDbPid = await pidOf(adminDb);
    await adminDb.query("BEGIN");
    const racing = adminDb.query(`ALTER ROLE ${OWNER} LOGIN`).then(
      () => "ok",
      (error: Error) => error.message,
    );
    // The probe is blocked by the provisioner's uncommitted row update.
    await waitUntil(
      adminDbPid,
      `SELECT ${provisionerPid} = ANY (pg_blocking_pids($1)) AS ok`,
    );
    await provisioner.query("COMMIT");
    assert.match(await racing, /tuple concurrently updated/);
    await adminDb.query("ROLLBACK");

    // 2. INSIDE the protocol: the probes wait for the lock (held by `admin`, in
    //    the lock database) before their transaction starts, then run on a
    //    stable row and keep their exact diagnostics.
    const adminPid = await pidOf(admin);
    const waitingForRoleLock = `SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE pid = $1 AND NOT granted AND locktype = 'advisory' AND objsubid = 1
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = ((${ROLE_LOCK_KEY}::bigint >> 32) & 4294967295)::oid
          AND objid = (${ROLE_LOCK_KEY}::bigint & 4294967295)::oid) AS ok`;
    for (const [probe, expected] of [
      [
        () => preflightFailure(adminDb, [`ALTER ROLE ${OWNER} LOGIN`]),
        /must be NOLOGIN/,
      ],
      [
        () => preflightFailure(adminDb, [`ALTER ROLE ${IMPORTER} SUPERUSER`]),
        /must not be superuser, CREATEROLE/,
      ],
      [
        () =>
          blockFailure(
            adminDb,
            [`GRANT ${OWNER} TO ${IMPORTER} WITH INHERIT FALSE, SET TRUE`],
            postconditions,
          ),
        /path to the B1 owner/,
      ],
    ] as const) {
      await startProvisioning();
      const pending = probe();
      await waitUntil(adminPid, waitingForRoleLock);
      await provisioner.query("COMMIT");
      assert.match(await pending, expected);
    }
  } finally {
    // Never leave the shared lock held, whatever failed above.
    await provisioner.query("ROLLBACK").catch(() => undefined);
    await adminDb.query("ROLLBACK").catch(() => undefined);
  }

  // Every probe was rolled back: the shared roles are as provisioned.
  const roles = await observer.query(
    `SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
     WHERE rolname IN ($1, $2) ORDER BY rolname`,
    [OWNER, IMPORTER],
  );
  // resonances_b1_owner sorts before resonances_importer. The importer's LOGIN
  // belongs to this file's fixtures and is not asserted here.
  assert.deepEqual(
    roles.rows.map((r) => [r.rolname, r.rolsuper]),
    [
      [OWNER, false],
      [IMPORTER, false],
    ],
  );
  assert.equal(roles.rows[0].rolcanlogin, false);
  const ownerMembers = await observer.query(
    `SELECT count(*)::int AS n FROM pg_auth_members
     WHERE roleid = $1::regrole AND member = $2::regrole`,
    [OWNER, IMPORTER],
  );
  assert.equal(ownerMembers.rows[0].n, 0);
});
