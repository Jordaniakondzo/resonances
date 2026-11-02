import { constants } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  compareParseDiagnostics,
  compareText,
  type SourceDocument,
} from "./batch-validation.js";
import type { ParseDiagnostic } from "./operations.js";

// parseContent rejects documents longer than this many UTF-16 code units.
export const MAX_SOURCE_CHARACTERS = 1_000_000;
// One UTF-16 code unit never takes more than 3 UTF-8 bytes (a BMP character is
// 3 bytes for 1 unit, an astral one 4 bytes for 2 units), so every document the
// parser could accept fits in this many bytes. Larger files are refused before
// decoding without ever turning away an admissible document. The exact
// character limit stays enforced by parseContent.
export const MAX_SOURCE_BYTES = MAX_SOURCE_CHARACTERS * 3;

const CONTENT_DIRECTORIES = ["content/publications", "content/reflections"];
// Operating-system or repository housekeeping files tolerated next to the
// documents. The list is closed on purpose: any other non-Markdown entry is
// reported, so a misnamed document (".markdown", ".txt") is never skipped
// silently.
const IGNORED_SERVICE_FILES = new Set([
  ".gitkeep",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);
const DOCUMENT_PATH = /^content\/(?:publications|reflections)\/[^/]+\.md$/;

export interface LoadedSources {
  // `file` is a relative POSIX path, the same string the plan will report.
  sources: readonly SourceDocument[];
  // Entries that cannot be turned into a document, as INVALID_DOCUMENT.
  loadErrors: readonly ParseDiagnostic[];
}

// A genuine I/O failure (permissions, a file where a directory is expected...).
// It carries only a relative path and the errno code, never an absolute path.
export class SourceIoError extends Error {
  constructor(
    public readonly path: string,
    public readonly errno: string,
  ) {
    super(`Lecture impossible : ${path} (${errno}).`);
    this.name = "SourceIoError";
  }
}

function invalid(file: string, message: string): ParseDiagnostic {
  return {
    category: "PARSE_ERROR",
    code: "INVALID_DOCUMENT",
    file,
    field: "file",
    message,
  };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

// ENOENT/ENOTDIR mean "this path does not exist" (a requested file is gone, or
// was never there). Other errno values are real I/O failures; an error without
// an errno is a bug and is rethrown untouched.
function isMissing(error: unknown): boolean {
  const errno = errnoOf(error);
  return errno === "ENOENT" || errno === "ENOTDIR";
}
function toIoError(file: string, error: unknown): never {
  const errno = errnoOf(error);
  if (errno === undefined) throw error;
  throw new SourceIoError(file, errno);
}

interface RequestedPath {
  // Safe to show in diagnostics (never absolute, never escaping the root).
  display: string;
  // Present when the path names an admissible document location.
  valid: boolean;
  reason: string;
}

// Classifies a path given by the caller. The input is untrusted: it may be
// absolute, contain "..", use Windows separators or point deeper than allowed.
function checkRequestedPath(entry: string, ordinal: number): RequestedPath {
  const normalized = entry.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const escapes =
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    // Control characters (log injection) and ":" (Windows alternate data
    // streams such as "a.md:stream") are never part of a document path.
    /[\u0000-\u001f\u007f:]/.test(normalized) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    );
  if (escapes)
    return {
      display: `(chemin refusé n°${ordinal})`,
      valid: false,
      reason:
        "Chemin hors du périmètre : un chemin relatif direct sous content/publications ou content/reflections est requis.",
    };
  if (DOCUMENT_PATH.test(normalized))
    return { display: normalized, valid: true, reason: "" };
  const underContent = /^content\/(?:publications|reflections)\//.test(
    normalized,
  );
  return {
    display: normalized,
    valid: false,
    reason: !underContent
      ? "Chemin hors du périmètre : seuls content/publications et content/reflections sont chargés."
      : segments.length > 3
        ? "Sous-répertoire inattendu : les documents doivent être directement sous leur répertoire."
        : "Extension .md attendue.",
  };
}

// A symbolic link (or Windows junction) anywhere between the root and the
// document could lead outside the allowed perimeter: refuse it. The root itself
// is chosen by the caller and may be a link.
async function symlinkIn(
  rootDir: string,
  relative: string,
): Promise<"link" | "missing" | "ok"> {
  const segments = relative.split("/");
  for (let depth = 1; depth <= segments.length; depth++) {
    const current = segments.slice(0, depth).join("/");
    try {
      const info = await lstat(path.join(rootDir, current));
      if (info.isSymbolicLink()) return "link";
    } catch (error) {
      // ENOTDIR on an ancestor means a file stands where a directory should
      // be: a broken tree, not an absent document.
      if (errnoOf(error) === "ENOENT") return "missing";
      toIoError(current, error);
    }
  }
  return "ok";
}

type ReadOutcome = { text: string } | { problem: string };

// Strict UTF-8 (a malformed byte sequence is an error, never U+FFFD) and no BOM
// stripping, so that the decoded length is exactly what parseContent measures.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Reads the bytes once. The read is bounded by the buffer, not by a size taken
// beforehand, so a file growing during the read cannot cause an unbounded read.
async function readDocument(
  rootDir: string,
  relative: string,
  buffer: Buffer,
): Promise<ReadOutcome> {
  const link = await symlinkIn(rootDir, relative);
  if (link === "link") return { problem: "Lien symbolique refusé." };
  if (link === "missing") return { problem: "Fichier introuvable." };
  try {
    const info = await lstat(path.join(rootDir, relative));
    if (!info.isFile())
      return { problem: "Entrée non régulière : fichier attendu." };
  } catch (error) {
    if (isMissing(error)) return { problem: "Fichier introuvable." };
    toIoError(relative, error);
  }

  let total = 0;
  let handle;
  try {
    // O_NOFOLLOW (POSIX) refuses a link swapped in after the lstat checks and
    // O_NONBLOCK keeps a swapped-in FIFO from blocking the open. Both are
    // undefined on Windows, where the fstat check below is the remaining guard.
    handle = await open(
      path.join(rootDir, relative),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    if (!(await handle.stat()).isFile())
      return { problem: "Entrée non régulière : fichier attendu." };
    // buffer is one byte larger than the limit: filling it means "too big".
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
  } catch (error) {
    if (isMissing(error)) return { problem: "Fichier introuvable." };
    toIoError(relative, error);
  } finally {
    await handle?.close();
  }
  if (total > MAX_SOURCE_BYTES)
    return {
      problem: `Fichier trop volumineux (maximum ${MAX_SOURCE_BYTES} octets lus avant décodage).`,
    };
  try {
    return { text: decoder.decode(buffer.subarray(0, total)) };
  } catch (error) {
    // The decoder signals malformed input with a TypeError; nothing else.
    if (!(error instanceof TypeError)) throw error;
    return { problem: "Encodage UTF-8 invalide." };
  }
}

// Lists the entries directly under the two content directories.
async function discover(
  rootDir: string,
  errors: ParseDiagnostic[],
): Promise<string[]> {
  const found: string[] = [];
  for (const directory of CONTENT_DIRECTORIES) {
    const link = await symlinkIn(rootDir, directory);
    if (link === "missing") continue; // an absent directory is simply empty
    if (link === "link") {
      errors.push(invalid(directory, "Lien symbolique refusé."));
      continue;
    }
    let entries;
    try {
      entries = await readdir(path.join(rootDir, directory), {
        withFileTypes: true,
      });
    } catch (error) {
      // ENOTDIR here means a file stands where the directory should be.
      return toIoError(directory, error);
    }
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink())
        errors.push(invalid(file, "Lien symbolique refusé."));
      else if (entry.isDirectory())
        errors.push(
          invalid(
            file,
            "Sous-répertoire inattendu : les documents doivent être directement sous leur répertoire.",
          ),
        );
      else if (!entry.isFile())
        errors.push(invalid(file, "Entrée non régulière : fichier attendu."));
      else if (entry.name.endsWith(".md")) found.push(file);
      else if (!IGNORED_SERVICE_FILES.has(entry.name))
        errors.push(invalid(file, "Extension .md attendue."));
    }
  }
  return found;
}

// Loads the editorial sources once, before any database transaction.
// - `files` omitted: every `.md` directly under content/publications and
//   content/reflections;
// - `files` given: exactly those files, and nothing else is looked at.
// Invalid entries become INVALID_DOCUMENT diagnostics; a real I/O failure
// throws SourceIoError. Output paths are relative and use "/" on every platform.
export async function loadSources(
  rootDir: string,
  files?: readonly string[],
): Promise<LoadedSources> {
  try {
    if (!(await stat(rootDir)).isDirectory())
      throw new SourceIoError(".", "ENOTDIR");
  } catch (error) {
    if (error instanceof SourceIoError) throw error;
    toIoError(".", error);
  }

  const loadErrors: ParseDiagnostic[] = [];
  const candidates: string[] = [];
  if (files === undefined) {
    candidates.push(...(await discover(rootDir, loadErrors)));
  } else {
    const seen = new Set<string>();
    files.forEach((entry, index) => {
      const checked = checkRequestedPath(entry, index + 1);
      if (!checked.valid) {
        loadErrors.push(invalid(checked.display, checked.reason));
      } else if (seen.has(checked.display)) {
        loadErrors.push(
          invalid(checked.display, "Chemin dupliqué dans la liste demandée."),
        );
      } else {
        seen.add(checked.display);
        candidates.push(checked.display);
      }
    });
  }

  const sources: SourceDocument[] = [];
  const buffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
  for (const file of candidates.sort(compareText)) {
    const outcome = await readDocument(rootDir, file, buffer);
    if ("text" in outcome) sources.push({ file, text: outcome.text });
    else loadErrors.push(invalid(file, outcome.problem));
  }
  return {
    sources,
    loadErrors: loadErrors.sort(compareParseDiagnostics),
  };
}
