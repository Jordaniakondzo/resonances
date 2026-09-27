import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

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
  if (existsSync("db/migrations/meta/_journal.json")) {
    await migrate(drizzle(client), { migrationsFolder: "db/migrations" });
  }
});
after(async () => {
  await client?.end();
  if (created) await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
});

test("the initial migration installs only the six requested tables", async () => {
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  assert.deepEqual(
    result.rows.map((row) => row.tablename),
    [
      "media_assets",
      "publication_themes",
      "publications",
      "reflection_themes",
      "reflections",
      "themes",
    ],
  );
});

async function transaction(body: () => Promise<void>) {
  await client.query("BEGIN");
  try {
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}
async function rejectsSql(sql: string, code: string, params: unknown[] = []) {
  await client.query("SAVEPOINT invalid_input");
  try {
    await assert.rejects(client.query(sql, params), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, code);
      return true;
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT invalid_input");
    await client.query("RELEASE SAVEPOINT invalid_input");
  }
}

for (const table of ["publications", "reflections"]) {
  test(
    table + ": incomplete drafts have UUID, French locale and timestamps",
    () =>
      transaction(async () => {
        const {
          rows: [row],
        } = await client.query(
          "INSERT INTO " + table + " DEFAULT VALUES RETURNING *",
        );
        assert.match(row.id, /^[0-9a-f-]{36}$/);
        assert.equal(row.status, "draft");
        assert.equal(row.locale, "fr");
        assert.equal(row.title, null);
        assert.equal(row.slug, null);
        assert.equal(row.published_at, null);
        assert.ok(row.created_at instanceof Date);
        assert.ok(row.updated_at instanceof Date);
        await client.query("INSERT INTO " + table + " DEFAULT VALUES");
        await rejectsSql(
          "INSERT INTO " + table + " (id) VALUES ($1)",
          "23505",
          [row.id],
        );
        await rejectsSql(
          "INSERT INTO " + table + " (locale) VALUES (NULL)",
          "23502",
        );
        await rejectsSql(
          "INSERT INTO " + table + " (locale) VALUES (' ')",
          "23514",
        );
        await rejectsSql(
          "INSERT INTO " + table + " (status) VALUES ('pending')",
          "22P02",
        );
      }),
  );
  test(table + ": slug uniqueness is scoped to locale and content type", () =>
    transaction(async () => {
      await client.query(
        "INSERT INTO " + table + " (slug) VALUES ('meme-slug')",
      );
      await rejectsSql(
        "INSERT INTO " + table + " (slug) VALUES ('meme-slug')",
        "23505",
      );
      await client.query(
        "INSERT INTO " + table + " (slug, locale) VALUES ('meme-slug', 'en')",
      );
      const other = table === "publications" ? "reflections" : "publications";
      await client.query(
        "INSERT INTO " + other + " (slug) VALUES ('meme-slug')",
      );
      await rejectsSql(
        "INSERT INTO " + table + " (slug) VALUES ('Invalid Slug')",
        "23514",
      );
    }),
  );
  test(
    table + ": publication requires a date but scheduling remains allowed",
    () =>
      transaction(async () => {
        await rejectsSql(
          "INSERT INTO " + table + " (status) VALUES ('published')",
          "23514",
        );
        await client.query(
          "INSERT INTO " +
            table +
            " (status, published_at) VALUES ('published', now() + interval '1 day')",
        );
        await client.query(
          "INSERT INTO " + table + " (status) VALUES ('archived')",
        );
      }),
  );
  const mediaColumn =
    table === "publications" ? "media_asset_id" : "cover_media_id";
  test(table + ": referenced media cannot be deleted", () =>
    transaction(async () => {
      const {
        rows: [media],
      } = await client.query(
        "INSERT INTO media_assets (original_url) VALUES ('original/photo.jpg') RETURNING id",
      );
      await client.query(
        "INSERT INTO " + table + " (" + mediaColumn + ") VALUES ($1)",
        [media.id],
      );
      await rejectsSql("DELETE FROM media_assets WHERE id = $1", "23001", [
        media.id,
      ]);
      await rejectsSql(
        "INSERT INTO " + table + " (" + mediaColumn + ") VALUES ($1)",
        "23503",
        [randomUUID()],
      );
    }),
  );
  const join =
    table === "publications" ? "publication_themes" : "reflection_themes";
  const key = table === "publications" ? "publication_id" : "reflection_id";
  test(
    join +
      ": unique pairs, valid references, content cascade and theme restrict",
    () =>
      transaction(async () => {
        const {
          rows: [content],
        } = await client.query(
          "INSERT INTO " + table + " DEFAULT VALUES RETURNING id",
        );
        const {
          rows: [theme],
        } = await client.query(
          "INSERT INTO themes (name, slug) VALUES ('Confiance', 'confiance') RETURNING id",
        );
        const insert =
          "INSERT INTO " + join + " (" + key + ", theme_id) VALUES ($1, $2)";
        await client.query(insert, [content.id, theme.id]);
        await rejectsSql(insert, "23505", [content.id, theme.id]);
        await rejectsSql(insert, "23503", [randomUUID(), theme.id]);
        await rejectsSql(insert, "23503", [content.id, randomUUID()]);
        await rejectsSql("DELETE FROM themes WHERE id = $1", "23001", [
          theme.id,
        ]);
        await client.query("DELETE FROM " + table + " WHERE id = $1", [
          content.id,
        ]);
        assert.equal(
          (await client.query("SELECT count(*)::int AS n FROM " + join)).rows[0]
            .n,
          0,
        );
        assert.equal(
          (await client.query("SELECT count(*)::int AS n FROM themes")).rows[0]
            .n,
          1,
        );
      }),
  );
}
test("media dimensions must be positive, originals referenced, metadata may be incomplete", () =>
  transaction(async () => {
    await client.query(
      "INSERT INTO media_assets (original_url) VALUES ('original/draft.jpg')",
    );
    await rejectsSql("INSERT INTO media_assets DEFAULT VALUES", "23502");
    await rejectsSql(
      "INSERT INTO media_assets (original_url) VALUES (' ')",
      "23514",
    );
    await rejectsSql(
      "INSERT INTO media_assets (original_url,width) VALUES ('a',0)",
      "23514",
    );
    await rejectsSql(
      "INSERT INTO media_assets (original_url,height) VALUES ('a',-1)",
      "23514",
    );
    await client.query(
      "INSERT INTO media_assets (original_url,width,height) VALUES ('a',1200,800)",
    );
  }));
test("themes have unique localized slugs and nonempty names", () =>
  transaction(async () => {
    await client.query(
      "INSERT INTO themes (name,slug) VALUES ('Présence','presence')",
    );
    await rejectsSql(
      "INSERT INTO themes (name,slug) VALUES ('Présence','presence')",
      "23505",
    );
    await client.query(
      "INSERT INTO themes (name,slug,locale) VALUES ('Presence','presence','en')",
    );
    await rejectsSql(
      "INSERT INTO themes (name,slug) VALUES (' ','vide')",
      "23514",
    );
  }));
test("a failed transaction leaves no partial writes", async () => {
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO themes (name,slug) VALUES ('Rollback','rollback')",
    );
    await assert.rejects(
      client.query("INSERT INTO publications (status) VALUES ('invalid')"),
    );
  } finally {
    await client.query("ROLLBACK");
  }
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM themes WHERE slug='rollback'",
      )
    ).rows[0].n,
    0,
  );
});
test("timestamps preserve instants independently of the session timezone", () =>
  transaction(async () => {
    await client.query("SET LOCAL TIME ZONE 'Europe/Moscow'");
    const {
      rows: [row],
    } = await client.query(
      "INSERT INTO publications (published_at) VALUES ('2026-09-27 12:00:00+03') RETURNING published_at",
    );
    assert.equal(row.published_at.toISOString(), "2026-09-27T09:00:00.000Z");
  }));

for (const tableName of ["publications", "reflections"] as const) {
  test(
    tableName + ": SQL and Drizzle public filters agree at the time boundary",
    () =>
      transaction(async () => {
        const { publications, reflections } = await import("../db/schema.js");
        const { publicContentWhere } = await import("../db/visibility.js");
        const table = tableName === "publications" ? publications : reflections;
        await client.query(
          "INSERT INTO " +
            tableName +
            " (slug,status,published_at) VALUES ('draft', 'draft', now()-interval '1 day'), ('archived','archived',now()-interval '1 day'), ('future','published',now()+interval '1 day'), ('past','published',now()-interval '1 day'), ('boundary','published',now()), ('undated','draft',NULL)",
        );
        const raw = await client.query(
          "SELECT slug FROM " +
            tableName +
            " WHERE status='published' AND published_at IS NOT NULL AND published_at <= now() ORDER BY slug",
        );
        assert.deepEqual(
          raw.rows.map((row) => row.slug),
          ["boundary", "past"],
        );
        const rows = await drizzle(client)
          .select({ slug: table.slug })
          .from(table)
          .where(publicContentWhere(table))
          .orderBy(table.slug);
        assert.deepEqual(
          rows.map((row) => row.slug),
          ["boundary", "past"],
        );
      }),
  );
}
test("applying the migration twice preserves existing data", async () => {
  const {
    rows: [row],
  } = await client.query("INSERT INTO reflections DEFAULT VALUES RETURNING id");
  try {
    await migrate(drizzle(client), { migrationsFolder: "db/migrations" });
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM reflections WHERE id=$1",
          [row.id],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await client.query("DELETE FROM reflections WHERE id=$1", [row.id]);
  }
});
