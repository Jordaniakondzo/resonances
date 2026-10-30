import { instantUsFromDate } from "./instant-us.js";
import {
  parseDiagnostic,
  type ConflictDiagnostic,
  type ParseDiagnostic,
} from "./operations.js";
import { parseContent } from "./parse.js";
import { ContentValidationError, type ParsedContent } from "./types.js";

// A source document already loaded in memory. Reading files and decoding bytes
// is the caller's job, so SQL retries can reuse exactly the same batch.
export interface SourceDocument {
  file: string;
  text: string;
}

export interface ValidDocument {
  file: string;
  content: ParsedContent;
}

export interface ParsedBatch {
  // Sorted by (type, id, file), the order of the plan operations.
  documents: readonly ValidDocument[];
  // Sorted by (file, code, field).
  parseErrors: readonly ParseDiagnostic[];
}

// Plain UTF-16 code unit comparison: unlike localeCompare it does not depend
// on the host locale or ICU data, so plans are identical on every machine.
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Diagnostics use forward slashes whatever the platform of the caller.
export function normalizeFile(file: string): string {
  return file.replaceAll("\\", "/");
}

export function compareParseDiagnostics(
  a: ParseDiagnostic,
  b: ParseDiagnostic,
): number {
  return (
    compareText(a.file, b.file) ||
    compareText(a.code, b.code) ||
    compareText(a.field, b.field)
  );
}

export function compareConflictDiagnostics(
  a: ConflictDiagnostic,
  b: ConflictDiagnostic,
): number {
  return (
    compareText(a.file, b.file) ||
    compareText(a.code, b.code) ||
    compareText(a.field ?? "", b.field ?? "") ||
    compareText(a.relatedFile ?? "", b.relatedFile ?? "")
  );
}

function compareDocuments(a: ValidDocument, b: ValidDocument): number {
  return (
    compareText(a.content.type, b.content.type) ||
    compareText(a.content.id, b.content.id) ||
    compareText(a.file, b.file)
  );
}

// Parses every document and keeps going after a failure: each file reports its
// first structured error, and the errors of the other files are not lost.
// Only the expected ContentValidationError is converted; anything else is a
// bug or an environment failure and must stay visible.
export function parseBatch(sources: readonly SourceDocument[]): ParsedBatch {
  const files = sources.map((source) => ({
    file: normalizeFile(source.file),
    text: source.text,
  }));
  const occurrences = new Map<string, number>();
  for (const { file } of files)
    occurrences.set(file, (occurrences.get(file) ?? 0) + 1);

  const documents: ValidDocument[] = [];
  const parseErrors: ParseDiagnostic[] = [];
  const reportedPaths = new Set<string>();
  for (const { file, text } of files) {
    if ((occurrences.get(file) ?? 0) > 1) {
      // Which copy is meant cannot be known: none of them enters the plan.
      if (!reportedPaths.has(file)) {
        reportedPaths.add(file);
        parseErrors.push({
          category: "PARSE_ERROR",
          code: "INVALID_DOCUMENT",
          file,
          field: "file",
          message: "Chemin dupliqué dans le lot.",
        });
      }
      continue;
    }
    let content: ParsedContent;
    try {
      content = parseContent(text, file);
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      parseErrors.push(parseDiagnostic(error));
      continue;
    }
    // The parser accepts years 0001-9999 before the offset is applied, so a
    // valid-looking local date can fall outside the UTC range InstantUs
    // supports. Only this conversion is allowed to fail with a RangeError.
    try {
      if (content.publishedAt) instantUsFromDate(content.publishedAt);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      parseErrors.push({
        category: "PARSE_ERROR",
        code: "INVALID_DOCUMENT",
        file,
        field: "published_at",
        message:
          "Date hors de la plage UTC prise en charge (années 0001 à 9999).",
      });
      continue;
    }
    documents.push({ file, content });
  }
  documents.sort(compareDocuments);
  parseErrors.sort(compareParseDiagnostics);
  return { documents, parseErrors };
}

function groupBy(
  documents: readonly ValidDocument[],
  keyOf: (document: ValidDocument) => string | null,
): ValidDocument[][] {
  const groups = new Map<string, ValidDocument[]>();
  for (const document of documents) {
    const key = keyOf(document);
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(document);
    else groups.set(key, [document]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

// Source-only duplicates. Every member of a group is in conflict with every
// other one, so the diagnostics do not depend on which file is read first.
// A UUID is global across both content types; a slug is only unique per
// (type, locale), and a null slug is never a duplicate.
export function findBatchDuplicates(
  documents: readonly ValidDocument[],
): Map<string, ConflictDiagnostic[]> {
  const result = new Map<string, ConflictDiagnostic[]>();
  const report = (
    group: readonly ValidDocument[],
    code: "DUPLICATE_ID" | "DUPLICATE_SLUG",
    field: string,
    describe: (document: ValidDocument) => string,
  ) => {
    for (const member of group) {
      for (const other of group) {
        if (other === member) continue;
        const list = result.get(member.file) ?? [];
        list.push({
          category: "CONFLICT",
          code,
          file: member.file,
          field,
          relatedFile: other.file,
          message: describe(member),
        });
        result.set(member.file, list);
      }
    }
  };
  for (const group of groupBy(documents, (d) => d.content.id))
    report(
      group,
      "DUPLICATE_ID",
      "id",
      (d) => `UUID ${d.content.id} déjà utilisé par un autre document du lot.`,
    );
  for (const group of groupBy(documents, (d) =>
    d.content.slug === null
      ? null
      : JSON.stringify([d.content.type, d.content.locale, d.content.slug]),
  ))
    report(
      group,
      "DUPLICATE_SLUG",
      "slug",
      (d) =>
        `Slug ${d.content.locale}/${d.content.slug} déjà proposé par un autre document du lot.`,
    );
  return result;
}
