import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instantUsFromDate,
  parseInstantUs,
} from "../src/editorial/instant-us.js";
import {
  classifySnapshot,
  parseDiagnostic,
  type DiffField,
} from "../src/editorial/operations.js";
import {
  canonicalThemeIds,
  snapshotFromResolved,
  type PublicationSnapshot,
  type ReflectionSnapshot,
} from "../src/editorial/snapshots.js";
import {
  ContentValidationError,
  type ParsedPublication,
  type ParsedReflection,
} from "../src/editorial/types.js";

const id = "8e8e0be8-49a4-4dbc-9a39-35d475f06a82";
const otherId = "683b7c85-bf50-4cb6-909f-ce96ef39d79d";
const file = "content/publications/example.md";

function publication(
  overrides: Partial<PublicationSnapshot> = {},
): PublicationSnapshot {
  return {
    type: "publication",
    id,
    locale: "fr",
    slug: "example",
    title: "Exemple",
    status: "draft",
    publishedAt: parseInstantUs("2026-10-08T12:34:56.123000Z"),
    themeIds: ["b", "a"],
    hook: "Accroche",
    mediaAssetId: null,
    observation: null,
    evocation: null,
    reflection: null,
    openQuestion: null,
    ...overrides,
  };
}

function reflection(
  overrides: Partial<ReflectionSnapshot> = {},
): ReflectionSnapshot {
  return {
    type: "reflection",
    id,
    locale: "fr",
    slug: "example",
    title: "Exemple",
    status: "draft",
    publishedAt: null,
    themeIds: [],
    excerpt: null,
    coverMediaId: null,
    content: null,
    ...overrides,
  };
}

test("source Date becomes UTC with six fractional digits", () => {
  assert.equal(
    instantUsFromDate(new Date("2026-10-08T15:34:56.123+03:00")),
    "2026-10-08T12:34:56.123000Z",
  );
  assert.equal(
    instantUsFromDate(new Date("2026-10-08T12:34:56Z")),
    "2026-10-08T12:34:56.000000Z",
  );
  assert.throws(() => instantUsFromDate(new Date("invalid")), RangeError);
  assert.throws(
    () => instantUsFromDate(new Date("+010000-01-01T00:00:00Z")),
    RangeError,
  );
  assert.throws(
    () => instantUsFromDate(new Date("0000-12-31T23:59:59.999Z")),
    RangeError,
  );
  assert.throws(
    () => instantUsFromDate(new Date("0001-01-01T00:30:00+01:00")),
    RangeError,
  );
  assert.equal(
    instantUsFromDate(new Date("0001-01-01T00:00:00.000Z")),
    "0001-01-01T00:00:00.000000Z",
  );
  assert.equal(
    instantUsFromDate(new Date("9999-12-31T23:59:59.999Z")),
    "9999-12-31T23:59:59.999000Z",
  );
});

test("database microseconds are preserved and malformed instants rejected", () => {
  assert.equal(
    parseInstantUs("2026-10-08T12:34:56.123456Z"),
    "2026-10-08T12:34:56.123456Z",
  );
  assert.equal(
    parseInstantUs("0001-01-01T00:00:00.000001Z"),
    "0001-01-01T00:00:00.000001Z",
  );
  assert.equal(
    parseInstantUs("9999-12-31T23:59:59.999999Z"),
    "9999-12-31T23:59:59.999999Z",
  );
  for (const value of [
    "0000-12-31T23:59:59.999999Z",
    "2026-10-08T12:34:56.123Z",
    "2026-10-08T12:34:56.123456+00:00",
    "2026-02-30T12:34:56.123456Z",
    "2026-10-08T24:34:56.123456Z",
    "10000-01-01T00:00:00.000000Z",
  ]) {
    assert.throws(() => parseInstantUs(value), RangeError, value);
  }
});

test("resolved source preserves every publication field and canonicalizes themes and time", () => {
  const content: ParsedPublication = {
    type: "publication",
    id,
    locale: "fr",
    status: "draft",
    slug: "example",
    title: "Exemple",
    publishedAt: new Date("2026-10-08T12:34:56.123Z"),
    themeSlugs: ["theme-b", "theme-a"],
    hook: "Accroche",
    mediaAssetId: otherId,
    observation: "Visible",
    evocation: "Possible",
    reflection: "Analyse",
    openQuestion: "Pourquoi ?",
  };
  assert.deepEqual(
    snapshotFromResolved({ content, themeIds: ["b", "a", "b"] }),
    publication({
      themeIds: ["a", "b"],
      mediaAssetId: otherId,
      observation: "Visible",
      evocation: "Possible",
      reflection: "Analyse",
      openQuestion: "Pourquoi ?",
    }),
  );
  assert.deepEqual(canonicalThemeIds(["b", "a", "b"]), ["a", "b"]);
});

test("resolved source preserves reflection excerpt, content, optional cover and time", () => {
  const content: ParsedReflection = {
    type: "reflection",
    id,
    locale: "fr",
    status: "published",
    slug: "example",
    title: "Exemple",
    publishedAt: new Date("2026-10-08T15:34:56.123+03:00"),
    themeSlugs: ["theme-b", "theme-a"],
    excerpt: "Résumé",
    coverMediaId: otherId,
    content: "# Corps\n\nTexte.",
  };
  assert.deepEqual(
    snapshotFromResolved({ content, themeIds: ["b", "a", "b"] }),
    reflection({
      status: "published",
      publishedAt: parseInstantUs("2026-10-08T12:34:56.123000Z"),
      themeIds: ["a", "b"],
      excerpt: "Résumé",
      coverMediaId: otherId,
      content: "# Corps\n\nTexte.",
    }),
  );
});

test("new snapshots produce typed CREATE operations with canonical themes", () => {
  const source = publication();
  const result = classifySnapshot(file, source);
  assert.equal(result.kind, "CREATE");
  if (result.kind !== "CREATE") return;
  assert.equal(result.after.type, "publication");
  assert.deepEqual(result.after.themeIds, ["a", "b"]);
  assert.deepEqual(source.themeIds, ["b", "a"]);
});

test("CREATE accepts a reflection and removes duplicate themes", () => {
  const source = reflection({
    themeIds: ["b", "a", "b"],
    coverMediaId: otherId,
  });
  const result = classifySnapshot(file, source);
  assert.equal(result.kind, "CREATE");
  if (result.kind !== "CREATE") return;
  assert.equal(result.after.type, "reflection");
  assert.deepEqual(result.after.themeIds, ["a", "b"]);
  assert.equal(result.after.coverMediaId, otherId);
  assert.deepEqual(source.themeIds, ["b", "a", "b"]);
});

test("equal business values are NOOP despite theme order and duplicates", () => {
  const before = publication({ themeIds: ["a", "b", "a"] });
  const after = publication({ themeIds: ["b", "a"] });
  const result = classifySnapshot("renamed.md", after, before);
  assert.equal(result.kind, "NOOP");
  if (result.kind === "NOOP")
    assert.deepEqual(result.snapshot.themeIds, ["a", "b"]);
  assert.deepEqual(before.themeIds, ["a", "b", "a"]);
});

test("business changes produce an ordered nonempty diff with exact null semantics", () => {
  const before = publication({ themeIds: ["b", "a"] });
  const after = publication({
    title: null,
    publishedAt: parseInstantUs("2026-10-08T12:34:56.123456Z"),
    themeIds: ["c", "a"],
    hook: "Nouveau",
  });
  const result = classifySnapshot(file, after, before);
  assert.equal(result.kind, "UPDATE");
  if (result.kind !== "UPDATE") return;
  assert.deepEqual(
    result.diff.map(({ field }) => field),
    ["title", "publishedAt", "themeIds", "hook"],
  );
  assert.deepEqual(result.diff[0], {
    field: "title",
    before: "Exemple",
    after: null,
  });
  assert.deepEqual(result.diff[2], {
    field: "themeIds",
    before: ["a", "b"],
    after: ["a", "c"],
  });
  assert.equal(result.diff[1]?.after, "2026-10-08T12:34:56.123456Z");
});

test("reflection fields are compared independently of publication fields", () => {
  const result = classifySnapshot(
    file,
    reflection({ content: "Après" }),
    reflection({ content: "Avant" }),
  );
  assert.equal(result.kind, "UPDATE");
  if (result.kind === "UPDATE")
    assert.deepEqual(
      result.diff.map(({ field }) => field),
      ["content"],
    );
});

const publicationChanges = {
  title: null,
  status: "published",
  publishedAt: parseInstantUs("2026-10-08T12:34:56.123456Z"),
  themeIds: ["c"],
  hook: null,
  mediaAssetId: otherId,
  observation: "Visible",
  evocation: "Possible",
  reflection: "Analyse",
  openQuestion: "Pourquoi ?",
} satisfies { [K in DiffField<PublicationSnapshot>]: PublicationSnapshot[K] };

const reflectionChanges = {
  title: null,
  status: "published",
  publishedAt: parseInstantUs("2026-10-08T12:34:56.123456Z"),
  themeIds: ["c"],
  excerpt: "Résumé",
  coverMediaId: otherId,
  content: "Texte",
} satisfies { [K in DiffField<ReflectionSnapshot>]: ReflectionSnapshot[K] };

for (const field of Object.keys(
  publicationChanges,
) as (keyof typeof publicationChanges)[]) {
  test(`publication change to ${field} produces one UPDATE diff`, () => {
    const result = classifySnapshot(
      file,
      publication({ [field]: publicationChanges[field] }),
      publication(),
    );
    assert.equal(result.kind, "UPDATE");
    if (result.kind === "UPDATE")
      assert.deepEqual(
        result.diff.map((entry) => entry.field),
        [field],
      );
  });
}

for (const field of Object.keys(
  reflectionChanges,
) as (keyof typeof reflectionChanges)[]) {
  test(`reflection change to ${field} produces one UPDATE diff`, () => {
    const result = classifySnapshot(
      file,
      reflection({ [field]: reflectionChanges[field] }),
      reflection(),
    );
    assert.equal(result.kind, "UPDATE");
    if (result.kind === "UPDATE")
      assert.deepEqual(
        result.diff.map((entry) => entry.field),
        [field],
      );
  });
}

test("theme addition and removal alone each produce an UPDATE", () => {
  for (const [beforeIds, afterIds] of [
    [["a"], ["a", "b"]],
    [["a", "b"], ["a"]],
  ] as const) {
    const result = classifySnapshot(
      file,
      publication({ themeIds: afterIds }),
      publication({ themeIds: beforeIds }),
    );
    assert.equal(result.kind, "UPDATE");
    if (result.kind === "UPDATE") {
      assert.deepEqual(
        result.diff.map((entry) => entry.field),
        ["themeIds"],
      );
      assert.deepEqual(result.after.themeIds, afterIds);
    }
  }
});

test("equivalent timezone representations classify as NOOP", () => {
  const instant = instantUsFromDate(new Date("2026-10-08T15:34:56.123+03:00"));
  const result = classifySnapshot(
    file,
    publication({ publishedAt: instant }),
    publication(),
  );
  assert.equal(result.kind, "NOOP");
});

test("technical timestamps are ignored and omitted from all operation snapshots", () => {
  const before = Object.assign(publication(), {
    createdAt: "old",
    updatedAt: "old",
    sourcePath: "old.md",
    unexpected: "old",
  });
  const after = Object.assign(publication(), {
    createdAt: "new",
    updatedAt: "new",
    sourcePath: "new.md",
    unexpected: "new",
  });
  const noop = classifySnapshot(file, after, before);
  assert.equal(noop.kind, "NOOP");
  if (noop.kind === "NOOP") {
    assert.equal("createdAt" in noop.snapshot, false);
    assert.equal("updatedAt" in noop.snapshot, false);
    assert.equal("sourcePath" in noop.snapshot, false);
    assert.equal("unexpected" in noop.snapshot, false);
  }
  const created = classifySnapshot(file, after);
  if (created.kind === "CREATE") {
    assert.equal("createdAt" in created.after, false);
    assert.equal("sourcePath" in created.after, false);
    assert.equal("unexpected" in created.after, false);
  }
  const updated = classifySnapshot(
    file,
    Object.assign(publication({ title: "Autre" }), {
      createdAt: "new",
      sourcePath: "new.md",
      unexpected: "new",
    }),
    before,
  );
  assert.equal(updated.kind, "UPDATE");
  if (updated.kind === "UPDATE") {
    assert.equal("createdAt" in updated.before, false);
    assert.equal("createdAt" in updated.after, false);
    assert.equal("sourcePath" in updated.before, false);
    assert.equal("sourcePath" in updated.after, false);
    assert.equal("unexpected" in updated.before, false);
    assert.equal("unexpected" in updated.after, false);
  }
  assert.equal(after.createdAt, "new");
  assert.equal(before.updatedAt, "old");
});

test("classification does not mutate frozen snapshots or theme arrays", () => {
  const before = Object.freeze(
    publication({ themeIds: Object.freeze(["b", "a"]) }),
  );
  const after = Object.freeze(
    publication({ themeIds: Object.freeze(["c", "a"]) }),
  );
  const result = classifySnapshot(file, after, before);
  assert.equal(result.kind, "UPDATE");
  assert.deepEqual(before.themeIds, ["b", "a"]);
  assert.deepEqual(after.themeIds, ["c", "a"]);
  if (result.kind === "UPDATE") {
    assert.deepEqual(result.before.themeIds, ["a", "b"]);
    assert.deepEqual(result.after.themeIds, ["a", "c"]);
  }
});

test("existing editorial key is immutable for every status and null transition", () => {
  for (const status of ["draft", "published", "archived"] as const) {
    for (const [beforeSlug, afterSlug] of [
      ["example", "changed"],
      [null, "example"],
      ["example", null],
    ] as const) {
      const result = classifySnapshot(
        file,
        publication({ status, slug: afterSlug }),
        publication({ status, slug: beforeSlug }),
      );
      assert.equal(result.kind, "CONFLICT");
      if (result.kind === "CONFLICT")
        assert.equal(result.diagnostics[0].code, "IMMUTABLE_EDITORIAL_KEY");
    }
    const localeChange = classifySnapshot(
      file,
      publication({ status, locale: "fr-CA" }),
      publication({ status }),
    );
    assert.equal(localeChange.kind, "CONFLICT");
    if (localeChange.kind === "CONFLICT")
      assert.equal(localeChange.diagnostics[0].field, "locale");
  }
});

test("type change is a conflict and mismatched identities are rejected", () => {
  const result = classifySnapshot(file, reflection(), publication());
  assert.equal(result.kind, "CONFLICT");
  if (result.kind === "CONFLICT") {
    assert.equal(result.id, id);
    assert.equal(result.diagnostics[0].code, "TYPE_CHANGE");
  }
  assert.throws(
    () => classifySnapshot(file, publication(), publication({ id: otherId })),
    RangeError,
  );
});

test("TYPE_CHANGE precedes immutable key checks", () => {
  const result = classifySnapshot(
    file,
    reflection({ locale: "fr-CA", slug: "new" }),
    publication(),
  );
  assert.equal(result.kind, "CONFLICT");
  if (result.kind === "CONFLICT") {
    assert.equal(result.id, id);
    assert.equal(result.diagnostics[0].code, "TYPE_CHANGE");
  }
});

test("simultaneous locale and slug change remains one immutable-key conflict", () => {
  const result = classifySnapshot(
    file,
    publication({ locale: "fr-CA", slug: "new" }),
    publication(),
  );
  assert.equal(result.kind, "CONFLICT");
  if (result.kind === "CONFLICT") {
    assert.equal(result.diagnostics[0].code, "IMMUTABLE_EDITORIAL_KEY");
    assert.equal(result.diagnostics[0].field, "locale");
  }
});

test("parse errors remain separate from business conflicts", () => {
  const result = parseDiagnostic(
    new ContentValidationError(file, "title", "Missing title"),
  );
  assert.deepEqual(
    {
      category: result.category,
      code: result.code,
      file: result.file,
      field: result.field,
    },
    {
      category: "PARSE_ERROR",
      code: "INVALID_DOCUMENT",
      file,
      field: "title",
    },
  );
});
