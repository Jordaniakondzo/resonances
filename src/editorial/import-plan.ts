import {
  compareConflictDiagnostics,
  findBatchDuplicates,
  parseBatch,
  type SourceDocument,
} from "./batch-validation.js";
import {
  UnsupportedPublishedAtError,
  type ImportReader,
  type SlugOwner,
} from "./import-reader.js";
import { mediaReadinessProblems } from "./media-readiness.js";
import {
  classifySnapshot,
  type ConflictCode,
  type ConflictDiagnostic,
  type ImportOperation,
  type ImportPlan,
} from "./operations.js";
import { resolveReferences, type ReferenceReader } from "./resolve.js";
import {
  snapshotFromResolved,
  type ContentType,
  type EditorialSnapshot,
} from "./snapshots.js";
import { ContentValidationError } from "./types.js";

interface ExistingRows<S> {
  rows: Map<string, S>;
  // UUIDs whose stored published_at cannot be represented as an InstantUs.
  unreadable: Set<string>;
}

// The reader refuses a whole call when one stored row has an unsupported date.
// That error is expected data, not a failure: remember the offending UUID,
// leave it out and read the rest. Each loop removes one UUID, so it ends. The
// error is raised in JavaScript after the rows were fetched, so it does not
// abort the caller's PostgreSQL transaction. Any other error is rethrown.
async function readExisting<S extends { id: string }>(
  type: ContentType,
  ids: readonly string[],
  read: (ids: readonly string[]) => Promise<S[]>,
): Promise<ExistingRows<S>> {
  const unreadable = new Set<string>();
  let remaining = [...ids];
  for (;;) {
    try {
      const rows = await read(remaining);
      return { rows: new Map(rows.map((row) => [row.id, row])), unreadable };
    } catch (error) {
      if (
        !(error instanceof UnsupportedPublishedAtError) ||
        error.contentType !== type ||
        !remaining.includes(error.id)
      )
        throw error;
      unreadable.add(error.id);
      remaining = remaining.filter((id) => id !== error.id);
    }
  }
}

const slugKey = (locale: string, slug: string) =>
  JSON.stringify([locale, slug]);

// Builds the ImportPlan from documents already loaded in memory. It only
// reads through `reader` and never opens or closes a transaction, so the
// caller decides the isolation (dry-run: REPEATABLE READ READ ONLY) and a
// later ADR-B1 reader can be substituted. Nothing here writes or locks.
export async function buildImportPlan(
  sources: readonly SourceDocument[],
  reader: ImportReader,
): Promise<ImportPlan> {
  const { documents, parseErrors } = parseBatch(sources);
  const duplicates = findBatchDuplicates(documents);

  // Existing rows in BOTH tables: a UUID is global, and an id found in the
  // other table must be seen to report TYPE_CHANGE.
  const ids = [...new Set(documents.map((d) => d.content.id))];
  const publications = await readExisting("publication", ids, (wanted) =>
    reader.findPublications(wanted),
  );
  const reflections = await readExisting("reflection", ids, (wanted) =>
    reader.findReflections(wanted),
  );

  // One read of the media rows serves both the existence check and the
  // readiness check, so they describe the same state.
  const mediaIdOf = (d: (typeof documents)[number]) =>
    d.content.type === "publication"
      ? d.content.mediaAssetId
      : d.content.coverMediaId;
  const mediaRows = await reader.findMedia(
    documents.flatMap((d) => mediaIdOf(d) ?? []),
  );
  const media = new Map(mediaRows.map((row) => [row.id, row]));
  const themeCache = new Map<string, Promise<string | null>>();
  const references: ReferenceReader = {
    findTheme(locale, slug) {
      const key = slugKey(locale, slug);
      let found = themeCache.get(key);
      if (!found) {
        found = reader.findTheme(locale, slug);
        themeCache.set(key, found);
      }
      return found;
    },
    async mediaExists(id) {
      return media.has(id);
    },
  };

  // Final (locale, slug) owners per table, for keys that are not null.
  const owners = new Map<ContentType, Map<string, SlugOwner[]>>();
  for (const type of ["publication", "reflection"] as const) {
    const keys = documents.flatMap((d) =>
      d.content.type === type && d.content.slug !== null
        ? [{ locale: d.content.locale, slug: d.content.slug }]
        : [],
    );
    const byKey = new Map<string, SlugOwner[]>();
    for (const owner of await reader.findSlugOwners(type, keys)) {
      const key = slugKey(owner.locale, owner.slug);
      byKey.set(key, [...(byKey.get(key) ?? []), owner]);
    }
    owners.set(type, byKey);
  }

  const operations: ImportOperation[] = [];
  for (const { file, content } of documents) {
    const diagnostics: ConflictDiagnostic[] = [...(duplicates.get(file) ?? [])];
    const add = (code: ConflictCode, message: string, field?: string) => {
      diagnostics.push({
        category: "CONFLICT",
        code,
        file,
        ...(field === undefined ? {} : { field }),
        message,
      });
    };

    const inPublications = publications.rows.get(content.id);
    const inReflections = reflections.rows.get(content.id);
    if (
      publications.unreadable.has(content.id) ||
      reflections.unreadable.has(content.id)
    )
      add(
        "UNSUPPORTED_STORED_DATE",
        "La date de publication stockée est hors de la plage prise en charge (années 0001 à 9999).",
        "published_at",
      );

    let identityConflict = false;
    // An unreadable row in the table that is not the document’s own still
    // proves the UUID lives in the other table: report TYPE_CHANGE too.
    const otherTableUnreadable =
      content.type === "publication"
        ? reflections.unreadable.has(content.id)
        : publications.unreadable.has(content.id);
    if (otherTableUnreadable) {
      identityConflict = true;
      add(
        "TYPE_CHANGE",
        "Cet UUID existe déjà dans l’autre table de contenu (sa date de publication stockée n’est pas lisible).",
        "type",
      );
    }
    const before: EditorialSnapshot | undefined =
      inPublications && inReflections
        ? undefined
        : (inPublications ?? inReflections);
    if (inPublications && inReflections) {
      // Never pick one of the two rows: PostgreSQL itself is inconsistent.
      identityConflict = true;
      add(
        "TYPE_CHANGE",
        "Incohérence intertype dans PostgreSQL : cet UUID existe à la fois dans publications et dans reflections.",
        "type",
      );
    }

    let resolved: Awaited<ReturnType<typeof resolveReferences>> | null = null;
    try {
      resolved = await resolveReferences(content, references, file);
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      const prefix = `${file}: ${error.field}: `;
      add(
        "MISSING_REFERENCE",
        error.message.startsWith(prefix)
          ? error.message.slice(prefix.length)
          : error.message,
        error.field,
      );
    }

    // Identity only needs type, id, locale and slug, so it is still checked
    // when a reference is missing (themes then stay empty and are unused).
    let operation: ImportOperation | undefined;
    if (!identityConflict) {
      const candidate = classifySnapshot(
        file,
        snapshotFromResolved(resolved ?? { content, themeIds: [] }),
        before,
      );
      if (candidate.kind === "CONFLICT") {
        identityConflict = true;
        diagnostics.push(...candidate.diagnostics);
      } else operation = candidate;
    }

    // Readiness is checked for every published target, NOOP included.
    const mediaId = mediaIdOf({ file, content });
    const mediaRow = mediaId ? media.get(mediaId) : undefined;
    if (content.status === "published" && mediaRow) {
      const problems = mediaReadinessProblems(mediaRow);
      if (problems.length > 0)
        add(
          "MEDIA_NOT_READY",
          `Le média ${mediaRow.id} n'est pas prêt pour la publication : ${problems.join(", ")}.`,
          content.type === "publication" ? "media" : "cover_media",
        );
    }

    // An existing UUID whose key differs is reported as such only; the new
    // key's owner is a consequence, not a second cause.
    if (!identityConflict && content.slug !== null) {
      const taken = (
        owners.get(content.type)?.get(slugKey(content.locale, content.slug)) ??
        []
      ).filter((owner) => owner.id !== content.id);
      if (taken.length > 0)
        add(
          "SLUG_COLLISION",
          `Le slug ${content.locale}/${content.slug} appartient déjà à un autre contenu dans PostgreSQL.`,
          "slug",
        );
    }

    const [first, ...rest] = diagnostics.sort(compareConflictDiagnostics);
    if (first) {
      operations.push({
        kind: "CONFLICT",
        file,
        id: content.id,
        diagnostics: [first, ...rest],
      });
    } else if (operation) {
      operations.push(operation);
    } else {
      throw new Error("Unreachable: no operation and no diagnostic");
    }
  }

  return {
    operations,
    parseErrors,
    applicable:
      parseErrors.length === 0 &&
      operations.every((operation) => operation.kind !== "CONFLICT"),
  };
}
