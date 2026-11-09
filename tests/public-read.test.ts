import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createPublicPublicationsService,
  MAX_LIST_LIMIT,
  PublicReadError,
} from "../src/services/public-publications.js";
import type {
  PublicPublicationDetailRow,
  PublicPublicationsRepository,
} from "../src/repositories/public-publications.js";

// Tests that need no PostgreSQL: input handling, output shape, error hygiene
// and the static boundaries of the public read layer.

const detail: PublicPublicationDetailRow = {
  id: "11111111-1111-4111-8111-111111111111",
  locale: "fr",
  slug: "un-titre",
  title: "Un titre",
  hook: "Accroche",
  publishedAt: new Date("2026-01-01T10:00:00Z"),
  observation: "O",
  evocation: "E",
  reflection: "R",
  openQuestion: "Q",
  image: null,
};

function fakeRepository(
  calls: { list: unknown[]; find: unknown[] },
  overrides: Partial<PublicPublicationsRepository> = {},
): PublicPublicationsRepository {
  return {
    async listVisible(query) {
      calls.list.push(query);
      return { rows: [], themes: new Map() };
    },
    async findVisibleBySlug(query) {
      calls.find.push(query);
      return { row: detail, themes: [] };
    },
    ...overrides,
  };
}

test("a malformed slug resolves to null without touching the database", async () => {
  const calls = { list: [], find: [] };
  const service = createPublicPublicationsService(() => fakeRepository(calls));
  for (const slug of [
    "",
    "Un-Titre",
    "a b",
    "a--b",
    "-a",
    "a'; DROP TABLE x;--",
    "../x",
  ]) {
    assert.equal(await service.getPublicationBySlug(slug), null, slug);
  }
  assert.equal(calls.find.length, 0);
});

test("the list limit is clamped and the locale defaults to fr", async () => {
  const calls: {
    list: Array<{ limit: number; locale: string }>;
    find: unknown[];
  } = {
    list: [],
    find: [],
  };
  const service = createPublicPublicationsService(() => fakeRepository(calls));
  await service.listPublications();
  await service.listPublications({ limit: 10_000 });
  await service.listPublications({ limit: -5 });
  await service.listPublications({ limit: Number.NaN });
  assert.deepEqual(
    calls.list.map((q) => q.limit),
    [24, MAX_LIST_LIMIT, 1, 24],
  );
  assert.ok(calls.list.every((q) => q.locale === "fr"));
});

test("the public API has no instant parameter and never forwards one", async () => {
  const seen: unknown[] = [];
  const service = createPublicPublicationsService(() =>
    fakeRepository(
      { list: [], find: [] },
      {
        async listVisible(query) {
          seen.push(query);
          return { rows: [], themes: new Map() };
        },
        async findVisibleBySlug(query) {
          seen.push(query);
          return null;
        },
      },
    ),
  );
  const future = new Date("2999-01-01T00:00:00Z");
  // @ts-expect-error `at` is not part of the public options
  await service.listPublications({ at: future });
  // @ts-expect-error `at` is not part of the public options
  await service.getPublicationBySlug("un-titre", { at: future });
  assert.equal(seen.length, 2);
  for (const query of seen) {
    assert.deepEqual(
      Object.keys(query as object)
        .sort()
        .filter((k) => k === "at"),
      [],
    );
  }
});

test("an image without a web variant is not delivered and the original is never used", async () => {
  const calls = { list: [], find: [] };
  const service = createPublicPublicationsService(() =>
    fakeRepository(calls, {
      async findVisibleBySlug() {
        return {
          row: {
            ...detail,
            image: {
              webUrl: null,
              thumbnailUrl: "https://cdn.test/t.webp",
              altText: "Alt",
              caption: null,
              author: null,
              source: "S",
              license: "L",
              width: 1,
              height: 1,
            },
          },
          themes: [],
        };
      },
    }),
  );
  assert.equal((await service.getPublicationBySlug("un-titre"))?.image, null);
});

test("a database failure becomes a generic PublicReadError", async () => {
  const secret = "select * from publications where password = 'hunter2'";
  const calls = { list: [], find: [] };
  const service = createPublicPublicationsService(() =>
    fakeRepository(calls, {
      async listVisible() {
        throw new Error(secret);
      },
      async findVisibleBySlug() {
        throw new Error(secret);
      },
    }),
  );
  for (const attempt of [
    () => service.listPublications(),
    () => service.getPublicationBySlug("un-titre"),
  ]) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof PublicReadError);
      assert.ok(!error.message.includes("hunter2"));
      assert.ok(!error.message.toLowerCase().includes("select"));
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// Static boundaries of the public read layer
// ---------------------------------------------------------------------------

const root = process.cwd();
const PUBLIC_FILES = [
  "src/services/public-publications.ts",
  "src/repositories/public-publications.ts",
  "src/repositories/public-database.ts",
  "db/public-views.ts",
];
// Private D03 circuit: the public layer must never reach it.
const FORBIDDEN_IMPORTS = [
  "import-writer",
  "editorial-import",
  "editorial-reference-locks",
  "editorial-dry-run",
  "scripts/",
  "migrations",
  "drizzle-kit",
];
const FORBIDDEN_ENV = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "IMPORT_DATABASE_URL",
  "ADMIN_DATABASE_URL",
  "NEXT_PUBLIC_",
];

// Strips comments so that documentation may name forbidden things.
const code = (file: string) =>
  readFileSync(path.join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the public read layer imports nothing from the private import circuit", () => {
  for (const file of PUBLIC_FILES) {
    const specifiers = [...code(file).matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );
    for (const specifier of specifiers) {
      assert.ok(
        !FORBIDDEN_IMPORTS.some((bad) => specifier.includes(bad)),
        `${file} imports ${specifier}`,
      );
    }
  }
});

test("the public read layer reads only APP_DATABASE_URL and never writes", () => {
  for (const file of PUBLIC_FILES) {
    const source = code(file);
    for (const name of FORBIDDEN_ENV) {
      assert.ok(
        !new RegExp(`(?<![A-Z_])${name}`).test(source),
        `${file} references ${name}`,
      );
    }
    assert.ok(
      !/\.(insert|update|delete|execute|transaction)\(/.test(source),
      `${file} calls a write-capable Drizzle method`,
    );
  }
  assert.ok(
    code("src/repositories/public-database.ts").includes("APP_DATABASE_URL"),
  );
});

test("no source file anywhere exposes the database URL through NEXT_PUBLIC_", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|js|mjs)$/.test(full) &&
        !full.endsWith("public-read.test.ts")
      ) {
        if (/NEXT_PUBLIC_\w*DATABASE/.test(readFileSync(full, "utf8")))
          found.push(full);
      }
    }
  };
  for (const dir of ["src", "db", "scripts"]) {
    if (existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(found, []);
});
