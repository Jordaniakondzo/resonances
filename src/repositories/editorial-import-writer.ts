import { and, eq, inArray, sql } from "drizzle-orm";
import {
  publicationThemes,
  publications,
  reflectionThemes,
  reflections,
} from "../../db/schema.js";
import {
  ImportWriteError,
  type ImportWriter,
} from "../editorial/import-writer.js";
import type {
  ContentType,
  PublicationSnapshot,
  ReflectionSnapshot,
} from "../editorial/snapshots.js";
import type { EditorialDb } from "./editorial-references.js";

// `published_at` goes through SQL text, never through a JavaScript Date: a Date
// keeps milliseconds only, which would silently truncate a stored microsecond
// value. The text is an InstantUs (always UTC, six fractional digits).
function publishedAtValue(instant: string | null) {
  return instant === null ? null : sql`${instant}::timestamptz`;
}

function distinctPairs(
  type: ContentType,
  id: string,
  removeIds: readonly string[],
  addIds: readonly string[],
): void {
  const all = [...removeIds, ...addIds];
  if (new Set(all).size !== all.length)
    throw new ImportWriteError(
      type,
      id,
      "theme delta lists the same theme twice",
    );
}

// Binds the write commands to the caller's connection or transaction. Statements
// are fixed per content type; the only data are bound parameters.
export function importWriter(db: EditorialDb): ImportWriter {
  return {
    async insertPublication(s: PublicationSnapshot) {
      // INSERT INTO publications (id, locale, slug, title, status,
      //   published_at, hook, observation, evocation, reflection,
      //   open_question, media_asset_id) VALUES (...).
      // created_at and updated_at come from their column defaults (now()).
      await db.insert(publications).values({
        id: s.id,
        locale: s.locale,
        slug: s.slug,
        title: s.title,
        status: s.status,
        publishedAt: publishedAtValue(s.publishedAt),
        hook: s.hook,
        observation: s.observation,
        evocation: s.evocation,
        reflection: s.reflection,
        openQuestion: s.openQuestion,
        mediaAssetId: s.mediaAssetId,
      });
    },

    async insertReflection(s: ReflectionSnapshot) {
      await db.insert(reflections).values({
        id: s.id,
        locale: s.locale,
        slug: s.slug,
        title: s.title,
        status: s.status,
        publishedAt: publishedAtValue(s.publishedAt),
        excerpt: s.excerpt,
        content: s.content,
        coverMediaId: s.coverMediaId,
      });
    },

    async updatePublication(s: PublicationSnapshot) {
      // UPDATE publications SET title = $, status = $, published_at = $,
      //   hook = $, ..., updated_at = now()
      // WHERE id = $ AND locale = $ AND slug IS NOT DISTINCT FROM $
      // RETURNING id.
      // The key columns are in the WHERE clause only: they are never assigned,
      // and a row whose key differs matches nothing instead of being changed.
      const rows = await db
        .update(publications)
        .set({
          title: s.title,
          status: s.status,
          publishedAt: publishedAtValue(s.publishedAt),
          hook: s.hook,
          observation: s.observation,
          evocation: s.evocation,
          reflection: s.reflection,
          openQuestion: s.openQuestion,
          mediaAssetId: s.mediaAssetId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(publications.id, s.id),
            eq(publications.locale, s.locale),
            sql`${publications.slug} IS NOT DISTINCT FROM ${s.slug}::text`,
          ),
        )
        .returning({ id: publications.id });
      if (rows.length !== 1)
        throw new ImportWriteError(
          "publication",
          s.id,
          `UPDATE affected ${rows.length} rows instead of 1`,
        );
    },

    async updateReflection(s: ReflectionSnapshot) {
      const rows = await db
        .update(reflections)
        .set({
          title: s.title,
          status: s.status,
          publishedAt: publishedAtValue(s.publishedAt),
          excerpt: s.excerpt,
          content: s.content,
          coverMediaId: s.coverMediaId,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(reflections.id, s.id),
            eq(reflections.locale, s.locale),
            sql`${reflections.slug} IS NOT DISTINCT FROM ${s.slug}::text`,
          ),
        )
        .returning({ id: reflections.id });
      if (rows.length !== 1)
        throw new ImportWriteError(
          "reflection",
          s.id,
          `UPDATE affected ${rows.length} rows instead of 1`,
        );
    },

    async applyThemeDelta(type, id, removeIds, addIds) {
      distinctPairs(type, id, removeIds, addIds);
      if (type === "publication") {
        if (removeIds.length > 0) {
          // DELETE FROM publication_themes
          // WHERE publication_id = $1 AND theme_id IN (...) RETURNING theme_id.
          const removed = await db
            .delete(publicationThemes)
            .where(
              and(
                eq(publicationThemes.publicationId, id),
                inArray(publicationThemes.themeId, [...removeIds]),
              ),
            )
            .returning({ themeId: publicationThemes.themeId });
          // Removing a pair that is not there means the plan was computed on
          // another state than the one being written.
          if (removed.length !== removeIds.length)
            throw new ImportWriteError(
              type,
              id,
              `theme delta removed ${removed.length} of ${removeIds.length} pairs`,
            );
        }
        if (addIds.length > 0)
          await db
            .insert(publicationThemes)
            .values(addIds.map((themeId) => ({ publicationId: id, themeId })));
        return;
      }
      if (removeIds.length > 0) {
        const removed = await db
          .delete(reflectionThemes)
          .where(
            and(
              eq(reflectionThemes.reflectionId, id),
              inArray(reflectionThemes.themeId, [...removeIds]),
            ),
          )
          .returning({ themeId: reflectionThemes.themeId });
        if (removed.length !== removeIds.length)
          throw new ImportWriteError(
            type,
            id,
            `theme delta removed ${removed.length} of ${removeIds.length} pairs`,
          );
      }
      if (addIds.length > 0)
        await db
          .insert(reflectionThemes)
          .values(addIds.map((themeId) => ({ reflectionId: id, themeId })));
    },
  };
}
