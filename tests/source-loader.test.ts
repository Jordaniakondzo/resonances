import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildImportPlan } from "../src/editorial/import-plan.js";
import type { ImportReader } from "../src/editorial/import-reader.js";
import { parseBatch } from "../src/editorial/batch-validation.js";
import {
  loadSources,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_CHARACTERS,
  SourceIoError,
} from "../src/editorial/source-loader.js";
import { ID, publicationDoc, reflectionDoc } from "./support/plan-sources.js";

let base: string;
before(async () => {
  base = await mkdtemp(path.join(tmpdir(), "resonances-loader-"));
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

// A fresh content tree per test, so cases never see each other's files.
let counter = 0;
async function tree(
  files: Record<string, string | Buffer> = {},
): Promise<string> {
  const root = path.join(base, String(++counter));
  await mkdir(path.join(root, "content", "publications"), { recursive: true });
  await mkdir(path.join(root, "content", "reflections"), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
  }
  return root;
}
const messages = (errors: readonly { file: string; message: string }[]) =>
  errors.map((e) => `${e.file}: ${e.message}`);

const validDoc = publicationDoc({ id: ID.a }).text;

test("discovery loads direct .md files of both directories, sorted by path", async () => {
  const root = await tree({
    "content/reflections/b.md": "b",
    "content/publications/z.md": "z",
    "content/publications/a.md": "a",
  });
  const loaded = await loadSources(root);
  assert.deepEqual(
    loaded.sources.map((s) => s.file),
    [
      "content/publications/a.md",
      "content/publications/z.md",
      "content/reflections/b.md",
    ],
  );
  assert.deepEqual(loaded.loadErrors, []);
  // The bytes read are the text of the document, byte for byte.
  assert.equal(loaded.sources[0]!.text, "a");
});

test("discovery tolerates missing content directories", async () => {
  const root = path.join(base, "empty-" + ++counter);
  await mkdir(root);
  assert.deepEqual(await loadSources(root), { sources: [], loadErrors: [] });
});

test("discovery diagnoses non-conforming entries and ignores only listed service files", async () => {
  const root = await tree({
    "content/publications/ok.md": "ok",
    "content/publications/.gitkeep": "",
    "content/publications/.DS_Store": "",
    "content/publications/Thumbs.db": "",
    "content/publications/desktop.ini": "",
    "content/publications/notes.txt": "x",
    "content/publications/draft.markdown": "x",
    "content/publications/UPPER.MD": "x",
    "content/publications/.hidden": "x",
    "content/reflections/sub/nested.md": "x",
  });
  const loaded = await loadSources(root);
  assert.deepEqual(
    loaded.sources.map((s) => s.file),
    ["content/publications/ok.md"],
  );
  assert.deepEqual(messages(loaded.loadErrors), [
    "content/publications/.hidden: Extension .md attendue.",
    "content/publications/UPPER.MD: Extension .md attendue.",
    "content/publications/draft.markdown: Extension .md attendue.",
    "content/publications/notes.txt: Extension .md attendue.",
    "content/reflections/sub: Sous-répertoire inattendu : les documents doivent être directement sous leur répertoire.",
  ]);
  for (const error of loaded.loadErrors) {
    assert.equal(error.category, "PARSE_ERROR");
    assert.equal(error.code, "INVALID_DOCUMENT");
    assert.equal(error.field, "file");
  }
});

test("an explicit list is the only candidate set: other files are not even read", async () => {
  const root = await tree({
    "content/publications/chosen.md": "chosen",
    "content/publications/other.md": "other",
    "content/reflections/bad.txt": "x",
  });
  const loaded = await loadSources(root, ["content/publications/chosen.md"]);
  assert.deepEqual(loaded.sources, [
    { file: "content/publications/chosen.md", text: "chosen" },
  ]);
  // The unselected non-.md file produces no diagnostic.
  assert.deepEqual(loaded.loadErrors, []);
  assert.deepEqual(await loadSources(root, []), {
    sources: [],
    loadErrors: [],
  });
});

test("explicit paths: Windows separators are normalized, duplicates diagnosed once", async () => {
  const root = await tree({ "content/publications/a.md": "a" });
  const loaded = await loadSources(root, [
    "content\\publications\\a.md",
    "content/publications/a.md",
  ]);
  assert.deepEqual(
    loaded.sources.map((s) => s.file),
    ["content/publications/a.md"],
  );
  assert.deepEqual(messages(loaded.loadErrors), [
    "content/publications/a.md: Chemin dupliqué dans la liste demandée.",
  ]);
});

test("explicit paths outside the perimeter are refused without echoing them", async () => {
  const root = await tree({ "content/publications/a.md": "a" });
  const absolute = path.join(root, "content", "publications", "a.md");
  const loaded = await loadSources(root, [
    absolute,
    "../secret.md",
    "content/../../secret.md",
    "C:\\Windows\\win.md",
    "/etc/passwd",
    "content/publications/./a.md",
    "content//publications/a.md",
    "content/publications/sub/a.md",
    "content/other/a.md",
    "content/publications/a.txt",
    "content/publications/ab\0.md",
    "content/publications/a\n.md",
    "content/publications/a.md:stream",
    "Content/Publications/a.md",
  ]);
  assert.deepEqual(loaded.sources, []);
  assert.equal(loaded.loadErrors.length, 14);
  const serialized = JSON.stringify(loaded);
  // JSON doubles backslashes: look for the root as written and as escaped.
  for (const form of [root, JSON.stringify(root).slice(1, -1)])
    assert.ok(!serialized.includes(form), "absolute root leaked");
  assert.ok(!serialized.includes("secret"), "escaping path echoed");
  assert.ok(!serialized.includes("passwd"), "absolute path echoed");
  assert.ok(!serialized.includes("Windows"), "drive path echoed");
  assert.ok(
    loaded.loadErrors.some((e) =>
      e.message.startsWith("Sous-répertoire inattendu"),
    ),
  );
});

test("a missing requested file is a diagnostic, not an I/O failure", async () => {
  const root = await tree();
  const loaded = await loadSources(root, ["content/reflections/gone.md"]);
  assert.deepEqual(messages(loaded.loadErrors), [
    "content/reflections/gone.md: Fichier introuvable.",
  ]);
});

test("UTF-8: valid accents, astral characters and BOM are kept byte-faithfully", async () => {
  const text = "Évocation — 𝄞 ✓\r\nligne";
  const root = await tree({
    "content/publications/plain.md": text,
    "content/publications/bom.md": Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(text),
    ]),
  });
  const loaded = await loadSources(root);
  const byFile = new Map(loaded.sources.map((s) => [s.file, s.text]));
  assert.equal(byFile.get("content/publications/plain.md"), text);
  // The BOM is preserved for parseContent, which strips and accepts it.
  assert.equal(byFile.get("content/publications/bom.md"), "\uFEFF" + text);
  assert.deepEqual(loaded.loadErrors, []);
});

test("a BOM and CRLF document is accepted by the whole parsing chain", async () => {
  const crlf = validDoc.replaceAll("\n", "\r\n");
  const root = await tree({
    "content/publications/bom-crlf.md": Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(crlf),
    ]),
  });
  const { sources, loadErrors } = await loadSources(root);
  assert.deepEqual(loadErrors, []);
  assert.deepEqual(parseBatch(sources).parseErrors, []);
  assert.equal(parseBatch(sources).documents.length, 1);
});

test("invalid UTF-8 is INVALID_DOCUMENT, never replaced by U+FFFD", async () => {
  const cases: Record<string, number[]> = {
    lone: [0x61, 0xff, 0x62],
    "truncated-2-bytes": [0x61, 0xc3],
    "truncated-3-bytes": [0x61, 0xe2, 0x82],
    "truncated-4-bytes": [0xf0, 0x9d, 0x84],
    overlong: [0xc0, 0xaf],
    surrogate: [0xed, 0xa0, 0x80],
    "above-max": [0xf4, 0x90, 0x80, 0x80],
    "bare-continuation": [0x80],
  };
  const files: Record<string, Buffer> = {};
  for (const [name, bytes] of Object.entries(cases))
    files[`content/publications/${name}.md`] = Buffer.from(bytes);
  const loaded = await loadSources(await tree(files));
  assert.deepEqual(loaded.sources, []);
  assert.equal(loaded.loadErrors.length, Object.keys(cases).length);
  for (const error of loaded.loadErrors)
    assert.equal(error.message, "Encodage UTF-8 invalide.");
});

test("size limits: byte guard never rejects an admissible file", async () => {
  // MAX_SOURCE_CHARACTERS 3-byte characters = exactly MAX_SOURCE_BYTES.
  const widest = "€".repeat(MAX_SOURCE_CHARACTERS);
  // MAX_SOURCE_CHARACTERS / 2 astral characters (2 units, 4 bytes each).
  const astral = "𝄞".repeat(MAX_SOURCE_CHARACTERS / 2);
  const root = await tree({
    "content/publications/widest.md": widest,
    "content/publications/astral.md": astral,
  });
  const loaded = await loadSources(root);
  assert.deepEqual(loaded.loadErrors, []);
  const lengths = new Map(loaded.sources.map((s) => [s.file, s.text.length]));
  assert.equal(lengths.get("content/publications/widest.md"), 1_000_000);
  assert.equal(lengths.get("content/publications/astral.md"), 1_000_000);
  assert.equal(Buffer.byteLength(widest), MAX_SOURCE_BYTES);
});

test("the exact character limit is the parser's: 1 000 000 passes, 1 000 001 is reported", async () => {
  const head = reflectionDoc({ id: ID.b }).text;
  const exact = head + "a".repeat(MAX_SOURCE_CHARACTERS - head.length);
  const over = exact + "a";
  const root = await tree({
    "content/reflections/exact.md": exact,
    "content/reflections/over.md": over,
  });
  const { sources, loadErrors } = await loadSources(root);
  assert.deepEqual(loadErrors, []);
  const batch = parseBatch(sources);
  assert.deepEqual(
    batch.documents.map((d) => d.file),
    ["content/reflections/exact.md"],
  );
  assert.deepEqual(
    batch.parseErrors.map((e) => e.file),
    ["content/reflections/over.md"],
  );
  assert.match(batch.parseErrors[0]!.message, /Document trop volumineux/);
});

test("a file beyond the byte limit is refused with a bounded read", async () => {
  const root = await tree({
    "content/publications/huge.md": Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61),
    "content/publications/small.md": "small",
  });
  const loaded = await loadSources(root);
  assert.deepEqual(
    loaded.sources.map((s) => s.file),
    ["content/publications/small.md"],
  );
  assert.equal(loaded.loadErrors.length, 1);
  assert.match(loaded.loadErrors[0]!.message, /trop volumineux/);
});

// Symbolic links need privileges on Windows. When the platform refuses to
// create one the test is skipped and the skip is visible in the test report.
async function trySymlink(
  target: string,
  link: string,
  type: "file" | "dir" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

test("symbolic links are refused (file link)", async (t) => {
  const root = await tree({ "content/publications/real.md": "real" });
  const outside = path.join(base, "outside-" + ++counter + ".md");
  await writeFile(outside, "outside");
  const link = path.join(root, "content", "publications", "link.md");
  if (!(await trySymlink(outside, link, "file")))
    return t.skip("file symlinks not permitted on this platform");
  const discovered = await loadSources(root);
  assert.deepEqual(
    discovered.sources.map((s) => s.file),
    ["content/publications/real.md"],
  );
  assert.deepEqual(messages(discovered.loadErrors), [
    "content/publications/link.md: Lien symbolique refusé.",
  ]);
  const explicit = await loadSources(root, ["content/publications/link.md"]);
  assert.deepEqual(explicit.sources, []);
  assert.deepEqual(messages(explicit.loadErrors), [
    "content/publications/link.md: Lien symbolique refusé.",
  ]);
});

test("symbolic links are refused (directory link or junction)", async (t) => {
  const outside = path.join(base, "outside-dir-" + ++counter);
  await mkdir(outside);
  await writeFile(path.join(outside, "a.md"), "outside");
  const root = path.join(base, String(++counter));
  await mkdir(path.join(root, "content"), { recursive: true });
  const link = path.join(root, "content", "publications");
  const kind = process.platform === "win32" ? "junction" : "dir";
  if (!(await trySymlink(outside, link, kind)))
    return t.skip("directory links not permitted on this platform");
  const discovered = await loadSources(root);
  assert.deepEqual(discovered.sources, []);
  assert.deepEqual(messages(discovered.loadErrors), [
    "content/publications: Lien symbolique refusé.",
  ]);
  const explicit = await loadSources(root, ["content/publications/a.md"]);
  assert.deepEqual(explicit.sources, []);
  assert.deepEqual(messages(explicit.loadErrors), [
    "content/publications/a.md: Lien symbolique refusé.",
  ]);
});

test("real I/O failures throw SourceIoError with relative paths only", async () => {
  // The root does not exist.
  const missingRoot = path.join(base, "no-such-root-" + ++counter);
  const rootError = await loadSources(missingRoot).catch((e: unknown) => e);
  assert.ok(rootError instanceof SourceIoError);
  assert.equal(rootError.errno, "ENOENT");
  assert.ok(!rootError.message.includes(base), "absolute path leaked");

  // A file stands where the publications directory should be.
  const root = path.join(base, String(++counter));
  await mkdir(path.join(root, "content"), { recursive: true });
  await writeFile(path.join(root, "content", "publications"), "not a dir");
  const dirError = await loadSources(root).catch((e: unknown) => e);
  assert.ok(dirError instanceof SourceIoError);
  assert.equal(dirError.path, "content/publications");
  assert.ok(!dirError.message.includes(base), "absolute path leaked");
});

test("loaded paths reproduce what the plan reports (path to data match)", async () => {
  const root = await tree({
    "content/publications/a.md": publicationDoc({ id: ID.a }).text,
    "content/reflections/b.md": reflectionDoc({ id: ID.b }).text,
  });
  const loaded = await loadSources(root);
  // A reader with no stored rows: both documents are CREATE operations.
  const empty: ImportReader = {
    findTheme: async () => null,
    mediaExists: async () => false,
    findPublications: async () => [],
    findReflections: async () => [],
    findSlugOwners: async () => [],
    findMedia: async () => [],
  };
  const plan = await buildImportPlan(loaded.sources, empty);
  assert.deepEqual(
    plan.operations.map((o) => o.file).sort(),
    loaded.sources.map((s) => s.file).sort(),
  );
});
