import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceDocument } from "../src/editorial/batch-validation.js";
import {
  UnsupportedPublishedAtError,
  type ImportReader,
  type MediaReadinessRow,
  type SlugOwner,
} from "../src/editorial/import-reader.js";
import { buildImportPlan } from "../src/editorial/import-plan.js";
import { mediaReadinessProblems } from "../src/editorial/media-readiness.js";
import type {
  ConflictOperation,
  ImportOperation,
} from "../src/editorial/operations.js";
import { parseContent } from "../src/editorial/parse.js";
import {
  snapshotFromResolved,
  type ContentType,
  type EditorialSnapshot,
  type PublicationSnapshot,
  type ReflectionSnapshot,
} from "../src/editorial/snapshots.js";
import { ID, publicationDoc, reflectionDoc } from "./support/plan-sources.js";

const THEME_FR = "99999999-0000-4000-8000-000000000001";
const THEME_FR_2 = "99999999-0000-4000-8000-000000000002";

const readyMedia = (id: string): MediaReadinessRow => ({
  id,
  originalUrl: "https://example.test/" + id + ".jpg",
  altText: "Alt",
  source: "Source",
  license: "CC0",
  author: null,
  width: null,
  height: null,
});

// In-memory ImportReader. It exposes only read methods, so a plan built on it
// cannot mutate anything; `calls` lets tests check what was read.
class MemoryReader implements ImportReader {
  publications: PublicationSnapshot[] = [];
  reflections: ReflectionSnapshot[] = [];
  owners: Record<ContentType, SlugOwner[]> = {
    publication: [],
    reflection: [],
  };
  media = new Map<string, MediaReadinessRow>([
    [ID.media, readyMedia(ID.media)],
    [ID.media2, readyMedia(ID.media2)],
  ]);
  themes = new Map<string, string>([
    ["fr/memoire", THEME_FR],
    ["fr/desir", THEME_FR_2],
  ]);
  unreadablePublications = new Set<string>();
  unreadableReflections = new Set<string>();
  failSlugOwners: Error | null = null;
  calls: string[] = [];

  async findTheme(locale: string, slug: string) {
    this.calls.push("findTheme");
    return this.themes.get(`${locale}/${slug}`) ?? null;
  }
  async mediaExists(id: string) {
    this.calls.push("mediaExists");
    return this.media.has(id);
  }
  async findPublications(ids: readonly string[]) {
    this.calls.push("findPublications");
    for (const id of ids)
      if (this.unreadablePublications.has(id))
        throw new UnsupportedPublishedAtError("publication", id);
    return this.publications.filter((row) => ids.includes(row.id));
  }
  async findReflections(ids: readonly string[]) {
    this.calls.push("findReflections");
    for (const id of ids)
      if (this.unreadableReflections.has(id))
        throw new UnsupportedPublishedAtError("reflection", id);
    return this.reflections.filter((row) => ids.includes(row.id));
  }
  async findSlugOwners(
    type: ContentType,
    keys: readonly { locale: string; slug: string }[],
  ) {
    this.calls.push("findSlugOwners");
    if (this.failSlugOwners) throw this.failSlugOwners;
    return this.owners[type].filter((owner) =>
      keys.some(
        (key) => key.locale === owner.locale && key.slug === owner.slug,
      ),
    );
  }
  async findMedia(ids: readonly string[]) {
    this.calls.push("findMedia");
    return ids.flatMap((id) => this.media.get(id) ?? []);
  }
}

// Snapshot that the source document would produce (what NOOP compares to).
function snapshotOf(doc: SourceDocument, themeIds: string[] = []) {
  return snapshotFromResolved({
    content: parseContent(doc.text, doc.file),
    themeIds,
  });
}
function addExisting(reader: MemoryReader, snapshot: EditorialSnapshot) {
  if (snapshot.type === "publication") reader.publications.push(snapshot);
  else reader.reflections.push(snapshot);
}

function only(operations: readonly ImportOperation[]): ImportOperation {
  assert.equal(operations.length, 1);
  return operations[0]!;
}
function conflictCodes(operation: ImportOperation): string[] {
  assert.equal(operation.kind, "CONFLICT");
  return (operation as ConflictOperation).diagnostics.map((d) => d.code);
}

test("an empty batch is an applicable empty plan", async () => {
  const plan = await buildImportPlan([], new MemoryReader());
  assert.deepEqual(plan, { operations: [], parseErrors: [], applicable: true });
});

test("a clean new batch is all CREATE and applicable", async () => {
  const plan = await buildImportPlan(
    [
      publicationDoc({ id: ID.a, status: "published", themes: ["memoire"] }),
      reflectionDoc({ id: ID.b, status: "draft" }),
    ],
    new MemoryReader(),
  );
  assert.deepEqual(
    plan.operations.map((o) => o.kind),
    ["CREATE", "CREATE"],
  );
  assert.equal(plan.applicable, true);
  const create = plan.operations[0]!;
  assert.equal(create.kind === "CREATE" && create.after.themeIds[0], THEME_FR);
});

test("independent parse errors in several files are all reported, sorted", async () => {
  const plan = await buildImportPlan(
    [
      { file: "content/reflections/z.md", text: "pas de frontmatter" },
      reflectionDoc({ id: ID.a }),
      { file: "content/publications/b.md", text: "---\ntype: nope\n---\n" },
    ],
    new MemoryReader(),
  );
  assert.deepEqual(
    plan.parseErrors.map((e) => [e.file, e.code, e.field]),
    [
      ["content/publications/b.md", "INVALID_DOCUMENT", "type"],
      ["content/reflections/z.md", "INVALID_DOCUMENT", "frontmatter"],
    ],
  );
  // The valid file is still planned for information, but nothing is applicable.
  assert.equal(only(plan.operations).kind, "CREATE");
  assert.equal(plan.applicable, false);
});

test("Windows paths are normalised in every diagnostic and operation", async () => {
  const plan = await buildImportPlan(
    [
      { ...reflectionDoc({ id: ID.a }), file: "content\\reflections\\a.md" },
      { file: "content\\reflections\\bad.md", text: "x" },
    ],
    new MemoryReader(),
  );
  assert.equal(only(plan.operations).file, "content/reflections/a.md");
  assert.equal(plan.parseErrors[0]!.file, "content/reflections/bad.md");
});

test("the same normalised path twice is a parse error and neither copy is planned", async () => {
  const doc = reflectionDoc({ id: ID.a });
  const plan = await buildImportPlan(
    [doc, { ...doc, file: doc.file.replaceAll("/", "\\") }],
    new MemoryReader(),
  );
  assert.equal(plan.operations.length, 0);
  assert.deepEqual(
    plan.parseErrors.map((e) => [e.file, e.field]),
    [[doc.file, "file"]],
  );
  assert.equal(plan.applicable, false);
});

test("a UUID repeated across content types is DUPLICATE_ID on both files", async () => {
  const plan = await buildImportPlan(
    [
      reflectionDoc({ id: ID.a, file: "content/reflections/r.md" }),
      publicationDoc({ id: ID.a, file: "content/publications/p.md" }),
    ],
    new MemoryReader(),
  );
  assert.equal(plan.operations.length, 2);
  for (const operation of plan.operations) {
    assert.equal(operation.kind, "CONFLICT");
    const [diagnostic] = (operation as ConflictOperation).diagnostics;
    assert.equal(diagnostic.code, "DUPLICATE_ID");
    assert.equal(
      diagnostic.relatedFile,
      operation.file === "content/reflections/r.md"
        ? "content/publications/p.md"
        : "content/reflections/r.md",
    );
  }
  assert.equal(plan.applicable, false);
});

test("DUPLICATE_SLUG needs the same type, locale and slug; null slugs never collide", async () => {
  const plan = await buildImportPlan(
    [
      reflectionDoc({ id: ID.a, slug: "meme" }),
      reflectionDoc({ id: ID.b, slug: "meme" }),
      // Same slug in the other table or locale is allowed.
      publicationDoc({ id: ID.c, slug: "meme" }),
      reflectionDoc({ id: ID.d, slug: "meme", locale: "en" }),
    ],
    new MemoryReader(),
  );
  const kinds = Object.fromEntries(
    plan.operations.map((o) => [o.file, o.kind]),
  );
  assert.equal(kinds[`content/reflections/${ID.a}.md`], "CONFLICT");
  assert.equal(kinds[`content/reflections/${ID.b}.md`], "CONFLICT");
  assert.equal(kinds[`content/publications/${ID.c}.md`], "CREATE");
  assert.equal(kinds[`content/reflections/${ID.d}.md`], "CREATE");

  const nulls = await buildImportPlan(
    [
      reflectionDoc({ id: ID.a, slug: null }),
      reflectionDoc({ id: ID.b, slug: null }),
      publicationDoc({ id: ID.c, slug: null }),
    ],
    new MemoryReader(),
  );
  assert.deepEqual(
    nulls.operations.map((o) => o.kind),
    ["CREATE", "CREATE", "CREATE"],
  );
  assert.equal(nulls.applicable, true);
});

test("a document merges every independent diagnostic into one CONFLICT, sorted", async () => {
  const plan = await buildImportPlan(
    [
      reflectionDoc({ id: ID.a, slug: "meme", themes: ["inconnu"] }),
      reflectionDoc({ id: ID.b, slug: "meme" }),
    ],
    new MemoryReader(),
  );
  const first = plan.operations.find((o) => o.file.includes(ID.a))!;
  assert.deepEqual(conflictCodes(first), [
    "DUPLICATE_SLUG",
    "MISSING_REFERENCE",
  ]);
  const diagnostics = (first as ConflictOperation).diagnostics;
  assert.equal(diagnostics[1]!.field, "themes");
  assert.ok(!diagnostics[1]!.message.startsWith("content/"));
});

test("missing media reference is MISSING_REFERENCE on the right field", async () => {
  const reader = new MemoryReader();
  reader.media.clear();
  const plan = await buildImportPlan(
    [
      publicationDoc({ id: ID.a, status: "published" }),
      reflectionDoc({ id: ID.b, media: ID.media }),
    ],
    reader,
  );
  const fields = plan.operations.map((o) => {
    assert.equal(o.kind, "CONFLICT");
    const d = (o as ConflictOperation).diagnostics[0];
    return [d.code, d.field];
  });
  assert.deepEqual(fields, [
    ["MISSING_REFERENCE", "media"],
    ["MISSING_REFERENCE", "cover_media"],
  ]);
});

test("existing UUID with the same key and equal values is NOOP, themes order ignored", async () => {
  const reader = new MemoryReader();
  const doc = publicationDoc({
    id: ID.a,
    status: "published",
    themes: ["memoire", "desir"],
  });
  addExisting(reader, snapshotOf(doc, [THEME_FR_2, THEME_FR]));
  const plan = await buildImportPlan([doc], reader);
  assert.equal(only(plan.operations).kind, "NOOP");
  assert.equal(plan.applicable, true);
});

test("a theme-only difference is an UPDATE whose diff is only themeIds", async () => {
  const reader = new MemoryReader();
  const doc = publicationDoc({
    id: ID.a,
    status: "published",
    themes: ["memoire", "desir"],
  });
  addExisting(reader, snapshotOf(doc, [THEME_FR]));
  const operation = only((await buildImportPlan([doc], reader)).operations);
  assert.equal(operation.kind, "UPDATE");
  if (operation.kind !== "UPDATE") return;
  assert.deepEqual(
    operation.diff.map((d) => d.field),
    ["themeIds"],
  );
});

test("a scalar difference is an UPDATE", async () => {
  const reader = new MemoryReader();
  const doc = reflectionDoc({ id: ID.a, title: "Nouveau" });
  addExisting(reader, snapshotOf(reflectionDoc({ id: ID.a, title: "Ancien" })));
  const operation = only((await buildImportPlan([doc], reader)).operations);
  assert.equal(operation.kind, "UPDATE");
});

test("TYPE_CHANGE when the UUID lives in the other table", async () => {
  const reader = new MemoryReader();
  addExisting(reader, snapshotOf(reflectionDoc({ id: ID.a })));
  const plan = await buildImportPlan([publicationDoc({ id: ID.a })], reader);
  assert.deepEqual(conflictCodes(only(plan.operations)), ["TYPE_CHANGE"]);
});

test("a UUID present in both tables is TYPE_CHANGE and never an arbitrary pick", async () => {
  const reader = new MemoryReader();
  addExisting(reader, snapshotOf(reflectionDoc({ id: ID.a })));
  addExisting(reader, snapshotOf(publicationDoc({ id: ID.a })));
  for (const doc of [
    publicationDoc({ id: ID.a }),
    reflectionDoc({ id: ID.a }),
  ]) {
    const operation = only((await buildImportPlan([doc], reader)).operations);
    assert.deepEqual(conflictCodes(operation), ["TYPE_CHANGE"]);
    assert.match(
      (operation as ConflictOperation).diagnostics[0].message,
      /intertype/,
    );
  }
});

test("IMMUTABLE_EDITORIAL_KEY for slug, locale and null transitions, whatever the status", async () => {
  const cases: [
    string,
    Parameters<typeof reflectionDoc>[0],
    Parameters<typeof reflectionDoc>[0],
  ][] = [
    ["slug", { id: ID.a, slug: "ancien" }, { id: ID.a, slug: "nouveau" }],
    ["locale", { id: ID.a, slug: "x" }, { id: ID.a, slug: "x", locale: "en" }],
    ["null to value", { id: ID.a, slug: null }, { id: ID.a, slug: "x" }],
    ["value to null", { id: ID.a, slug: "x" }, { id: ID.a, slug: null }],
    [
      "archived",
      { id: ID.a, slug: "x", status: "archived" },
      { id: ID.a, slug: "y", status: "archived" },
    ],
  ];
  for (const [label, stored, source] of cases) {
    const reader = new MemoryReader();
    addExisting(reader, snapshotOf(reflectionDoc(stored)));
    const plan = await buildImportPlan([reflectionDoc(source)], reader);
    assert.deepEqual(
      conflictCodes(only(plan.operations)),
      ["IMMUTABLE_EDITORIAL_KEY"],
      label,
    );
  }
});

test("a changed key is reported once, without a derived SLUG_COLLISION", async () => {
  const reader = new MemoryReader();
  addExisting(reader, snapshotOf(reflectionDoc({ id: ID.a, slug: "ancien" })));
  reader.owners.reflection.push({ id: ID.b, locale: "fr", slug: "nouveau" });
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a, slug: "nouveau" })],
    reader,
  );
  assert.deepEqual(conflictCodes(only(plan.operations)), [
    "IMMUTABLE_EDITORIAL_KEY",
  ]);
});

test("identity is still checked when a reference is missing", async () => {
  const reader = new MemoryReader();
  addExisting(reader, snapshotOf(reflectionDoc({ id: ID.a, slug: "ancien" })));
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a, slug: "nouveau", themes: ["inconnu"] })],
    reader,
  );
  assert.deepEqual(conflictCodes(only(plan.operations)), [
    "IMMUTABLE_EDITORIAL_KEY",
    "MISSING_REFERENCE",
  ]);
});

test("SLUG_COLLISION with another row, but never with the row itself", async () => {
  const reader = new MemoryReader();
  reader.owners.reflection.push({ id: ID.c, locale: "fr", slug: "pris" });
  const collision = await buildImportPlan(
    [reflectionDoc({ id: ID.a, slug: "pris" })],
    reader,
  );
  assert.deepEqual(conflictCodes(only(collision.operations)), [
    "SLUG_COLLISION",
  ]);

  const self = new MemoryReader();
  const doc = reflectionDoc({ id: ID.a, slug: "moi" });
  addExisting(self, snapshotOf(doc));
  self.owners.reflection.push({ id: ID.a, locale: "fr", slug: "moi" });
  assert.equal(
    only((await buildImportPlan([doc], self)).operations).kind,
    "NOOP",
  );
});

test("slug ownership is per table", async () => {
  const reader = new MemoryReader();
  reader.owners.publication.push({ id: ID.c, locale: "fr", slug: "pris" });
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a, slug: "pris" })],
    reader,
  );
  assert.equal(only(plan.operations).kind, "CREATE");
});

for (const [label, patch] of [
  ["alt_text", { altText: " " }],
  ["source", { source: null }],
  ["license", { license: "" }],
  ["original_url", { originalUrl: "   " }],
  ["width", { width: 0 }],
  ["height", { height: -1 }],
] as const) {
  test(`published CREATE is MEDIA_NOT_READY when ${label} is unusable`, async () => {
    const reader = new MemoryReader();
    reader.media.set(ID.media, { ...readyMedia(ID.media), ...patch });
    const plan = await buildImportPlan(
      [publicationDoc({ id: ID.a, status: "published" })],
      reader,
    );
    const operation = only(plan.operations);
    assert.deepEqual(conflictCodes(operation), ["MEDIA_NOT_READY"]);
    const diagnostic = (operation as ConflictOperation).diagnostics[0];
    assert.equal(diagnostic.field, "media");
    assert.match(diagnostic.message, new RegExp(label));
    assert.equal(plan.applicable, false);
  });
}

test("media readiness: NULL dimensions and author are accepted, positive ones too", () => {
  assert.deepEqual(mediaReadinessProblems(readyMedia(ID.media)), []);
  assert.deepEqual(
    mediaReadinessProblems({ ...readyMedia(ID.media), width: 1, height: 1 }),
    [],
  );
});

test("a published NOOP whose media became incomplete is CONFLICT, never NOOP", async () => {
  const reader = new MemoryReader();
  const doc = publicationDoc({ id: ID.a, status: "published" });
  addExisting(reader, snapshotOf(doc, [THEME_FR]));
  assert.equal(
    only((await buildImportPlan([doc], reader)).operations).kind,
    "NOOP",
  );
  reader.media.set(ID.media, { ...readyMedia(ID.media), altText: null });
  const plan = await buildImportPlan([doc], reader);
  assert.deepEqual(conflictCodes(only(plan.operations)), ["MEDIA_NOT_READY"]);
  assert.equal(plan.applicable, false);
});

test("a published UPDATE with incomplete media is CONFLICT", async () => {
  const reader = new MemoryReader();
  addExisting(
    reader,
    snapshotOf(
      publicationDoc({ id: ID.a, status: "published", title: "Ancien" }),
      [THEME_FR],
    ),
  );
  reader.media.set(ID.media, { ...readyMedia(ID.media), license: null });
  const plan = await buildImportPlan(
    [publicationDoc({ id: ID.a, status: "published", title: "Nouveau" })],
    reader,
  );
  assert.deepEqual(conflictCodes(only(plan.operations)), ["MEDIA_NOT_READY"]);
});

test("draft and archived targets accept incomplete media; a reflection cover is optional", async () => {
  const reader = new MemoryReader();
  reader.media.set(ID.media, {
    ...readyMedia(ID.media),
    altText: null,
    source: null,
    license: null,
  });
  const plan = await buildImportPlan(
    [
      publicationDoc({ id: ID.a, status: "draft", media: ID.media }),
      reflectionDoc({ id: ID.b, status: "archived", media: ID.media }),
      reflectionDoc({ id: ID.c, status: "published" }),
    ],
    reader,
  );
  assert.deepEqual(
    plan.operations.map((o) => o.kind),
    ["CREATE", "CREATE", "CREATE"],
  );
  assert.equal(plan.applicable, true);
});

test("a published reflection cover must be ready when present", async () => {
  const reader = new MemoryReader();
  reader.media.set(ID.media, { ...readyMedia(ID.media), source: null });
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a, status: "published", media: ID.media })],
    reader,
  );
  const operation = only(plan.operations);
  assert.deepEqual(conflictCodes(operation), ["MEDIA_NOT_READY"]);
  assert.equal(
    (operation as ConflictOperation).diagnostics[0].field,
    "cover_media",
  );
});

test("a source date outside the UTC range is a PARSE_ERROR, not a RangeError", async () => {
  for (const publishedAt of [
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:59:59-05:00",
  ]) {
    const plan = await buildImportPlan(
      [reflectionDoc({ id: ID.a, status: "draft", publishedAt })],
      new MemoryReader(),
    );
    assert.equal(plan.operations.length, 0);
    assert.deepEqual(
      plan.parseErrors.map((e) => [e.code, e.field]),
      [["INVALID_DOCUMENT", "published_at"]],
    );
    assert.equal(plan.applicable, false);
  }
  const edge = await buildImportPlan(
    [reflectionDoc({ id: ID.a, publishedAt: "9999-12-31T23:59:59.999Z" })],
    new MemoryReader(),
  );
  assert.equal(edge.applicable, true);
});

test("an unreadable stored date conflicts only its own documents; the rest is planned", async () => {
  const reader = new MemoryReader();
  reader.unreadablePublications.add(ID.a);
  const healthy = publicationDoc({ id: ID.b, slug: "sain" });
  addExisting(reader, snapshotOf(healthy));
  const plan = await buildImportPlan(
    [publicationDoc({ id: ID.a }), healthy, reflectionDoc({ id: ID.c })],
    reader,
  );
  const byId = new Map(plan.operations.map((o) => [o.file, o]));
  const broken = byId.get(`content/publications/${ID.a}.md`)!;
  assert.deepEqual(conflictCodes(broken), ["UNSUPPORTED_STORED_DATE"]);
  assert.equal(
    (broken as ConflictOperation).diagnostics[0].field,
    "published_at",
  );
  assert.equal(byId.get(`content/publications/${ID.b}.md`)!.kind, "NOOP");
  assert.equal(byId.get(`content/reflections/${ID.c}.md`)!.kind, "CREATE");
  assert.equal(plan.applicable, false);
  // The unreadable UUID was excluded from the retry, not read again forever.
  assert.equal(reader.calls.filter((c) => c === "findPublications").length, 2);
});

test("several unreadable dates are each reported once", async () => {
  const reader = new MemoryReader();
  reader.unreadablePublications.add(ID.a).add(ID.b);
  const plan = await buildImportPlan(
    [publicationDoc({ id: ID.a }), publicationDoc({ id: ID.b })],
    reader,
  );
  for (const operation of plan.operations)
    assert.deepEqual(conflictCodes(operation), ["UNSUPPORTED_STORED_DATE"]);
  assert.equal(reader.calls.filter((c) => c === "findPublications").length, 3);
});

test("unexpected reader errors stay technical errors", async () => {
  const reader = new MemoryReader();
  reader.failSlugOwners = new Error("connection reset");
  await assert.rejects(
    buildImportPlan([reflectionDoc({ id: ID.a, slug: "x" })], reader),
    /connection reset/,
  );
  const failingThemes = new MemoryReader();
  failingThemes.findTheme = async () => {
    throw new Error("boom");
  };
  await assert.rejects(
    buildImportPlan(
      [reflectionDoc({ id: ID.a, themes: ["memoire"] })],
      failingThemes,
    ),
    /boom/,
  );
});

test("the plan is identical whatever the order of the input files", async () => {
  const build = () => {
    const reader = new MemoryReader();
    const same = reflectionDoc({ id: ID.d, slug: "stable" });
    addExisting(reader, snapshotOf(same));
    reader.owners.publication.push({ id: ID.d, locale: "fr", slug: "pris" });
    return {
      reader,
      docs: [
        publicationDoc({ id: ID.c, slug: "pris", themes: ["inconnu"] }),
        reflectionDoc({ id: ID.b }),
        publicationDoc({ id: ID.a, status: "published" }),
        same,
        { file: "content/reflections/zz.md", text: "x" },
        { file: "content/publications/aa.md", text: "y" },
      ],
    };
  };
  const first = build();
  const expected = await buildImportPlan(first.docs, first.reader);
  const reversed = build();
  const second = await buildImportPlan(
    [...reversed.docs].reverse(),
    reversed.reader,
  );
  assert.deepEqual(second, expected);
  // Operations follow (type, id, file): publications first, then reflections.
  assert.deepEqual(
    expected.operations.map((o) => o.file),
    [
      `content/publications/${ID.a}.md`,
      `content/publications/${ID.c}.md`,
      `content/reflections/${ID.b}.md`,
      `content/reflections/${ID.d}.md`,
    ],
  );
  assert.deepEqual(
    expected.parseErrors.map((e) => e.file),
    ["content/publications/aa.md", "content/reflections/zz.md"],
  );
});

test("applicable is true only without parse errors and without conflicts", async () => {
  const reader = new MemoryReader();
  const doc = reflectionDoc({ id: ID.a });
  addExisting(reader, snapshotOf(doc));
  assert.equal((await buildImportPlan([doc], reader)).applicable, true);
  assert.equal(
    (await buildImportPlan([doc, { file: "x.md", text: "" }], reader))
      .applicable,
    false,
  );
  reader.owners.reflection.push({ id: ID.b, locale: "fr", slug: "pris" });
  assert.equal(
    (
      await buildImportPlan(
        [doc, reflectionDoc({ id: ID.c, slug: "pris" })],
        reader,
      )
    ).applicable,
    false,
  );
});

test("an unreadable stored date in the other table still reports TYPE_CHANGE", async () => {
  const reader = new MemoryReader();
  reader.unreadablePublications.add(ID.a);
  const plan = await buildImportPlan([reflectionDoc({ id: ID.a })], reader);
  assert.deepEqual(conflictCodes(only(plan.operations)), [
    "TYPE_CHANGE",
    "UNSUPPORTED_STORED_DATE",
  ]);
});

test("an unreadable stored reflection date is a structured conflict too", async () => {
  const reader = new MemoryReader();
  reader.unreadableReflections.add(ID.a);
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a }), reflectionDoc({ id: ID.b })],
    reader,
  );
  assert.deepEqual(
    plan.operations.map((o) => o.kind),
    ["CONFLICT", "CREATE"],
  );
  assert.deepEqual(conflictCodes(plan.operations[0]!), [
    "UNSUPPORTED_STORED_DATE",
  ]);
});

test("a source date exactly on the lower UTC bound is accepted, with no parse error", async () => {
  // Boundary check only: it does not exercise the propagation of a RangeError
  // raised outside the date conversion, which parseContent cannot produce.
  const plan = await buildImportPlan(
    [reflectionDoc({ id: ID.a, publishedAt: "0001-01-01T00:00:00Z" })],
    new MemoryReader(),
  );
  assert.equal(plan.parseErrors.length, 0);
  assert.equal(plan.applicable, true);
});

test("building a plan neither mutates the documents nor the rows held by the reader", async () => {
  const reader = new MemoryReader();
  const existing = reflectionDoc({ id: ID.b, title: "Ancien" });
  addExisting(reader, snapshotOf(existing));
  const docs = [reflectionDoc({ id: ID.a }), reflectionDoc({ id: ID.b })];
  const docsBefore = structuredClone(docs);
  const rowsBefore = structuredClone(reader.reflections);
  const mediaBefore = structuredClone([...reader.media]);
  await buildImportPlan(docs, reader);
  assert.deepEqual(docs, docsBefore);
  assert.deepEqual(reader.reflections, rowsBefore);
  assert.deepEqual([...reader.media], mediaBefore);
  const allowed = new Set([
    "findTheme",
    "mediaExists",
    "findPublications",
    "findReflections",
    "findSlugOwners",
    "findMedia",
  ]);
  assert.ok(reader.calls.every((call) => allowed.has(call)));
});
