import { ContentValidationError } from "./types.js";
import {
  canonicalThemeIds,
  type EditorialSnapshot,
  type PublicationSnapshot,
  type ReflectionSnapshot,
  type SnapshotBase,
} from "./snapshots.js";

export type DiffField<S extends EditorialSnapshot> = Exclude<
  keyof S,
  "type" | "id" | "locale" | "slug"
>;

export type SnapshotDiff<S extends EditorialSnapshot> = {
  [K in DiffField<S>]: { field: K; before: S[K]; after: S[K] };
}[DiffField<S>];

export interface CreateOperation<S extends EditorialSnapshot> {
  kind: "CREATE";
  file: string;
  after: S;
}

export interface UpdateOperation<S extends EditorialSnapshot> {
  kind: "UPDATE";
  file: string;
  before: S;
  after: S;
  diff: readonly [SnapshotDiff<S>, ...SnapshotDiff<S>[]];
}

export interface NoopOperation<S extends EditorialSnapshot> {
  kind: "NOOP";
  file: string;
  snapshot: S;
}

export type ConflictCode =
  | "DUPLICATE_ID"
  | "DUPLICATE_SLUG"
  | "TYPE_CHANGE"
  | "IMMUTABLE_EDITORIAL_KEY"
  | "SLUG_COLLISION"
  | "MISSING_REFERENCE"
  | "MEDIA_NOT_READY";

export interface ConflictDiagnostic {
  category: "CONFLICT";
  code: ConflictCode;
  file: string;
  field?: string;
  relatedFile?: string;
  message: string;
}

export interface ParseDiagnostic {
  category: "PARSE_ERROR";
  code: "INVALID_DOCUMENT";
  file: string;
  field: string;
  message: string;
}

export interface ConflictOperation {
  kind: "CONFLICT";
  file: string;
  id?: string;
  diagnostics: readonly [ConflictDiagnostic, ...ConflictDiagnostic[]];
}

export type ImportOperation =
  | CreateOperation<PublicationSnapshot>
  | CreateOperation<ReflectionSnapshot>
  | UpdateOperation<PublicationSnapshot>
  | UpdateOperation<ReflectionSnapshot>
  | NoopOperation<PublicationSnapshot>
  | NoopOperation<ReflectionSnapshot>
  | ConflictOperation;

export interface ImportPlan {
  operations: readonly ImportOperation[];
  parseErrors: readonly ParseDiagnostic[];
  applicable: boolean;
}

export function parseDiagnostic(
  error: ContentValidationError,
): ParseDiagnostic {
  return {
    category: "PARSE_ERROR",
    code: "INVALID_DOCUMENT",
    file: error.file,
    field: error.field,
    message: error.message,
  };
}

const baseFields = ["title", "status", "publishedAt", "themeIds"] as const;
const publicationFields = [
  ...baseFields,
  "hook",
  "mediaAssetId",
  "observation",
  "evocation",
  "reflection",
  "openQuestion",
] as const satisfies readonly DiffField<PublicationSnapshot>[];
const reflectionFields = [
  ...baseFields,
  "excerpt",
  "coverMediaId",
  "content",
] as const satisfies readonly DiffField<ReflectionSnapshot>[];

type AssertNever<T extends never> = T;
type PublicationFieldsComplete = AssertNever<
  Exclude<DiffField<PublicationSnapshot>, (typeof publicationFields)[number]>
>;
type ReflectionFieldsComplete = AssertNever<
  Exclude<DiffField<ReflectionSnapshot>, (typeof reflectionFields)[number]>
>;

function canonicalSnapshot(snapshot: PublicationSnapshot): PublicationSnapshot;
function canonicalSnapshot(snapshot: ReflectionSnapshot): ReflectionSnapshot;
function canonicalSnapshot(snapshot: EditorialSnapshot): EditorialSnapshot {
  const base: SnapshotBase = {
    id: snapshot.id,
    locale: snapshot.locale,
    slug: snapshot.slug,
    title: snapshot.title,
    status: snapshot.status,
    publishedAt: snapshot.publishedAt,
    themeIds: canonicalThemeIds(snapshot.themeIds),
  };
  if (snapshot.type === "publication") {
    return {
      ...base,
      type: "publication",
      hook: snapshot.hook,
      mediaAssetId: snapshot.mediaAssetId,
      observation: snapshot.observation,
      evocation: snapshot.evocation,
      reflection: snapshot.reflection,
      openQuestion: snapshot.openQuestion,
    };
  }
  return {
    ...base,
    type: "reflection",
    excerpt: snapshot.excerpt,
    coverMediaId: snapshot.coverMediaId,
    content: snapshot.content,
  };
}

function differences<S extends EditorialSnapshot>(
  before: S,
  after: S,
  fields: readonly DiffField<S>[],
): SnapshotDiff<S>[] {
  const result: SnapshotDiff<S>[] = [];
  for (const field of fields) {
    const oldValue = before[field];
    const newValue = after[field];
    const changed =
      field === "themeIds"
        ? (oldValue as readonly string[]).length !==
            (newValue as readonly string[]).length ||
          (oldValue as readonly string[]).some(
            (id, index) => id !== (newValue as readonly string[])[index],
          )
        : oldValue !== newValue;
    if (changed) {
      result.push({
        field,
        before: oldValue,
        after: newValue,
      } as SnapshotDiff<S>);
    }
  }
  return result;
}

function conflict(
  file: string,
  id: string,
  code: ConflictCode,
  message: string,
  field?: string,
): ConflictOperation {
  return {
    kind: "CONFLICT",
    file,
    id,
    diagnostics: [{ category: "CONFLICT", code, file, field, message }],
  };
}

function classifySameType<S extends EditorialSnapshot>(
  file: string,
  before: S,
  after: S,
  fields: readonly DiffField<S>[],
): UpdateOperation<S> | NoopOperation<S> | ConflictOperation {
  if (before.locale !== after.locale || before.slug !== after.slug) {
    return conflict(
      file,
      after.id,
      "IMMUTABLE_EDITORIAL_KEY",
      "The locale and slug of an existing content ID cannot change.",
      before.locale !== after.locale ? "locale" : "slug",
    );
  }
  const diff = differences(before, after, fields);
  if (diff.length === 0) return { kind: "NOOP", file, snapshot: after };
  return {
    kind: "UPDATE",
    file,
    before,
    after,
    diff: diff as [SnapshotDiff<S>, ...SnapshotDiff<S>[]],
  };
}

export function classifySnapshot(
  file: string,
  after: EditorialSnapshot,
  before?: EditorialSnapshot,
): ImportOperation {
  if (!before) {
    if (after.type === "publication") {
      return { kind: "CREATE", file, after: canonicalSnapshot(after) };
    }
    return { kind: "CREATE", file, after: canonicalSnapshot(after) };
  }
  if (before.id !== after.id) {
    throw new RangeError("Snapshots must have the same content ID");
  }
  if (before.type !== after.type) {
    return conflict(
      file,
      after.id,
      "TYPE_CHANGE",
      "Content type cannot change.",
      "type",
    );
  }
  if (before.type === "publication" && after.type === "publication") {
    return classifySameType(
      file,
      canonicalSnapshot(before),
      canonicalSnapshot(after),
      publicationFields,
    );
  }
  if (before.type === "reflection" && after.type === "reflection") {
    return classifySameType(
      file,
      canonicalSnapshot(before),
      canonicalSnapshot(after),
      reflectionFields,
    );
  }
  throw new Error("Unreachable content type");
}
