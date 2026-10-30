import { asc, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  mediaAssets,
  publicationThemes,
  publications,
  reflectionThemes,
  reflections,
} from "../../db/schema.js";
import { parseInstantUs, type InstantUs } from "../editorial/instant-us.js";
import {
  UnsupportedPublishedAtError,
  type ImportReader,
  type MediaReadinessRow,
  type SlugKey,
  type SlugOwner,
} from "../editorial/import-reader.js";
import {
  canonicalThemeIds,
  type ContentType,
  type PublicationSnapshot,
  type ReflectionSnapshot,
} from "../editorial/snapshots.js";
import {
  editorialReferences,
  type EditorialDb,
} from "./editorial-references.js";

// InstantUs only represents years 0001-9999. PostgreSQL accepts far more
// (BC dates, 5+ digit years, +/-infinity), so the range is checked on the
// absolute instant in SQL before any text formatting.
const MIN_INSTANT = "0001-01-01T00:00:00.000000Z";
const MAX_INSTANT = "9999-12-31T23:59:59.999999Z";

// Two computed columns for one `published_at` column:
// - `publishedAtOutOfRange`: true when the stored instant cannot be an InstantUs;
// - `publishedAtUs`: the UTC instant as text with six fractional digits.
// The text is built by PostgreSQL so no JavaScript Date (millisecond precision)
// ever sits between the stored value and the snapshot. Formatting at UTC makes
// the result independent of the session TimeZone. Verified on PostgreSQL 18:
// to_char renders BC dates without a marker and +/-infinity as NULL, which is
// why the out-of-range test comes first and is exposed separately.
function publishedAtProjection(column: PgColumn) {
  const outOfRange = sql`(${column} < ${MIN_INSTANT}::timestamptz OR ${column} > ${MAX_INSTANT}::timestamptz)`;
  return {
    publishedAtOutOfRange: sql<boolean>`COALESCE(${outOfRange}, false)`,
    publishedAtUs: sql<
      string | null
    >`CASE WHEN ${column} IS NULL OR ${outOfRange} THEN NULL ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`,
  };
}

function toInstant(
  type: ContentType,
  id: string,
  row: { publishedAtUs: string | null; publishedAtOutOfRange: boolean },
): InstantUs | null {
  if (row.publishedAtOutOfRange)
    throw new UnsupportedPublishedAtError(type, id);
  // parseInstantUs re-validates the text format and brands the string.
  return row.publishedAtUs === null ? null : parseInstantUs(row.publishedAtUs);
}

// Drizzle drops table prefixes in a single-table select list, which would turn
// the correlation below into `WHERE "publication_id" = "id"`: correct only
// while the join table has no `id` column. Static qualified identifiers keep
// the correlation explicit (no user data is ever interpolated here).
function qualified(table: string, column: string) {
  return sql`${sql.identifier(table)}.${sql.identifier(column)}`;
}

// Distinct inputs keep the IN list small and the result free of duplicates.
function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function importReader(db: EditorialDb): ImportReader {
  return {
    // findTheme and mediaExists stay owned by editorialReferences.
    ...editorialReferences(db),

    async findPublications(ids) {
      const wanted = distinct(ids);
      if (wanted.length === 0) return [];
      // SELECT p.<columns>, <published_at projections>,
      //        ARRAY(SELECT theme_id FROM publication_themes
      //              WHERE publication_id = p.id ORDER BY theme_id)
      // FROM publications p WHERE p.id IN ($1, ...) ORDER BY p.id.
      // The theme sub-select runs in the same statement as the row it describes.
      const rows = await db
        .select({
          id: publications.id,
          locale: publications.locale,
          slug: publications.slug,
          title: publications.title,
          status: publications.status,
          ...publishedAtProjection(publications.publishedAt),
          themeIds: sql<
            string[]
          >`ARRAY(SELECT ${qualified("publication_themes", "theme_id")} FROM ${publicationThemes} WHERE ${qualified("publication_themes", "publication_id")} = ${qualified("publications", "id")} ORDER BY ${qualified("publication_themes", "theme_id")})::text[]`,
          hook: publications.hook,
          mediaAssetId: publications.mediaAssetId,
          observation: publications.observation,
          evocation: publications.evocation,
          reflection: publications.reflection,
          openQuestion: publications.openQuestion,
        })
        .from(publications)
        .where(inArray(publications.id, wanted))
        .orderBy(asc(publications.id));
      return rows.map((row): PublicationSnapshot => ({
        type: "publication",
        id: row.id,
        locale: row.locale,
        slug: row.slug,
        title: row.title,
        status: row.status,
        publishedAt: toInstant("publication", row.id, row),
        themeIds: canonicalThemeIds(row.themeIds),
        hook: row.hook,
        mediaAssetId: row.mediaAssetId,
        observation: row.observation,
        evocation: row.evocation,
        reflection: row.reflection,
        openQuestion: row.openQuestion,
      }));
    },

    async findReflections(ids) {
      const wanted = distinct(ids);
      if (wanted.length === 0) return [];
      // Same shape as findPublications, on reflections and reflection_themes.
      const rows = await db
        .select({
          id: reflections.id,
          locale: reflections.locale,
          slug: reflections.slug,
          title: reflections.title,
          status: reflections.status,
          ...publishedAtProjection(reflections.publishedAt),
          themeIds: sql<
            string[]
          >`ARRAY(SELECT ${qualified("reflection_themes", "theme_id")} FROM ${reflectionThemes} WHERE ${qualified("reflection_themes", "reflection_id")} = ${qualified("reflections", "id")} ORDER BY ${qualified("reflection_themes", "theme_id")})::text[]`,
          excerpt: reflections.excerpt,
          coverMediaId: reflections.coverMediaId,
          content: reflections.content,
        })
        .from(reflections)
        .where(inArray(reflections.id, wanted))
        .orderBy(asc(reflections.id));
      return rows.map((row): ReflectionSnapshot => ({
        type: "reflection",
        id: row.id,
        locale: row.locale,
        slug: row.slug,
        title: row.title,
        status: row.status,
        publishedAt: toInstant("reflection", row.id, row),
        themeIds: canonicalThemeIds(row.themeIds),
        excerpt: row.excerpt,
        coverMediaId: row.coverMediaId,
        content: row.content,
      }));
    },

    async findSlugOwners(type, keys) {
      const wanted = distinctKeys(keys);
      if (wanted.length === 0) return [];
      // SELECT id, locale, slug FROM <publications | reflections>
      // WHERE (locale, slug) IN (($1, $2), ...) ORDER BY locale, slug.
      // The table comes from the ContentType union, never from document data.
      // The row comparison matches the (locale, slug) unique index.
      const table = type === "publication" ? publications : reflections;
      const pairs = sql.join(
        wanted.map((key) => sql`(${key.locale}, ${key.slug})`),
        sql`, `,
      );
      const rows = await db
        .select({ id: table.id, locale: table.locale, slug: table.slug })
        .from(table)
        .where(sql`(${table.locale}, ${table.slug}) IN (${pairs})`)
        .orderBy(asc(table.locale), asc(table.slug));
      return rows.map((row): SlugOwner => {
        // An equality match cannot return a NULL slug; narrow for the type.
        if (row.slug === null) throw new Error("Unexpected NULL slug owner");
        return { id: row.id, locale: row.locale, slug: row.slug };
      });
    },

    async findMedia(ids) {
      const wanted = distinct(ids);
      if (wanted.length === 0) return [];
      // SELECT id, original_url, alt_text, source, license, author, width,
      //        height FROM media_assets WHERE id IN ($1, ...) ORDER BY id.
      const rows = await db
        .select({
          id: mediaAssets.id,
          originalUrl: mediaAssets.originalUrl,
          altText: mediaAssets.altText,
          source: mediaAssets.source,
          license: mediaAssets.license,
          author: mediaAssets.author,
          width: mediaAssets.width,
          height: mediaAssets.height,
        })
        .from(mediaAssets)
        .where(inArray(mediaAssets.id, wanted))
        .orderBy(asc(mediaAssets.id));
      return rows satisfies readonly MediaReadinessRow[];
    },
  };
}

function distinctKeys(keys: readonly SlugKey[]): SlugKey[] {
  const unique = new Map<string, SlugKey>();
  for (const key of keys) {
    unique.set(JSON.stringify([key.locale, key.slug]), key);
  }
  return [...unique.values()];
}
