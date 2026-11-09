import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  publicPublicationThemesView as themeView,
  publicPublicationsView as pubView,
} from "../../db/public-views.js";
import type { PublicDb } from "./public-database.js";

// Public read repository for Publications. It reads ONLY the public_read views
// (migration 0002), the one thing the reader role may touch. The visibility
// rule (published, dated, not in the future, on the database clock) is applied
// inside those views: this module has no instant parameter and no visibility
// predicate of its own, so it cannot select a different one or forget it.

export interface PublicThemeRow {
  slug: string;
  name: string;
}

export interface PublicImageRow {
  webUrl: string | null;
  thumbnailUrl: string | null;
  altText: string | null;
  caption: string | null;
  author: string | null;
  source: string | null;
  license: string | null;
  width: number | null;
  height: number | null;
}

export interface PublicPublicationRow {
  id: string;
  locale: string;
  slug: string;
  title: string | null;
  hook: string | null;
  publishedAt: Date;
  image: PublicImageRow | null;
}

export interface PublicPublicationDetailRow extends PublicPublicationRow {
  observation: string | null;
  evocation: string | null;
  reflection: string | null;
  openQuestion: string | null;
}

export interface PublicPublicationsRepository {
  listVisible(query: { locale: string; limit: number }): Promise<{
    rows: PublicPublicationRow[];
    themes: Map<string, PublicThemeRow[]>;
  }>;
  findVisibleBySlug(query: { locale: string; slug: string }): Promise<{
    row: PublicPublicationDetailRow;
    themes: PublicThemeRow[];
  } | null>;
}

const listColumns = {
  id: pubView.id,
  locale: pubView.locale,
  slug: pubView.slug,
  title: pubView.title,
  hook: pubView.hook,
  publishedAt: pubView.publishedAt,
  imageWebUrl: pubView.imageWebUrl,
  imageThumbnailUrl: pubView.imageThumbnailUrl,
  imageAltText: pubView.imageAltText,
  imageCaption: pubView.imageCaption,
  imageAuthor: pubView.imageAuthor,
  imageSource: pubView.imageSource,
  imageLicense: pubView.imageLicense,
  imageWidth: pubView.imageWidth,
  imageHeight: pubView.imageHeight,
};

interface ImageColumns {
  imageWebUrl: string | null;
  imageThumbnailUrl: string | null;
  imageAltText: string | null;
  imageCaption: string | null;
  imageAuthor: string | null;
  imageSource: string | null;
  imageLicense: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

// The view yields all-NULL image columns when the publication has no usable Web media.
function toImage(c: ImageColumns): PublicImageRow | null {
  if (c.imageWebUrl === null) return null;
  return {
    webUrl: c.imageWebUrl,
    thumbnailUrl: c.imageThumbnailUrl,
    altText: c.imageAltText,
    caption: c.imageCaption,
    author: c.imageAuthor,
    source: c.imageSource,
    license: c.imageLicense,
    width: c.imageWidth,
    height: c.imageHeight,
  };
}

export function publicPublicationsRepository(
  db: PublicDb,
): PublicPublicationsRepository {
  // SELECT publication_id, theme_slug, theme_name
  // FROM public_read.publication_themes WHERE publication_id IN (...)
  // ORDER BY theme_slug;
  async function themesOf(ids: string[]) {
    const byPublication = new Map<string, PublicThemeRow[]>();
    if (ids.length === 0) return byPublication;
    const rows = await db
      .select({
        publicationId: themeView.publicationId,
        slug: themeView.themeSlug,
        name: themeView.themeName,
      })
      .from(themeView)
      .where(inArray(themeView.publicationId, ids))
      .orderBy(asc(themeView.themeSlug));
    for (const row of rows) {
      const list = byPublication.get(row.publicationId) ?? [];
      list.push({ slug: row.slug, name: row.name });
      byPublication.set(row.publicationId, list);
    }
    return byPublication;
  }

  return {
    async listVisible({ locale, limit }) {
      // SELECT ... FROM public_read.publications WHERE locale = $1
      // ORDER BY published_at DESC, id DESC LIMIT $2;
      const rows = await db
        .select(listColumns)
        .from(pubView)
        .where(eq(pubView.locale, locale))
        .orderBy(desc(pubView.publishedAt), desc(pubView.id))
        .limit(limit);
      const themesById = await themesOf(rows.map((r) => r.id));
      return {
        rows: rows.map((r) => ({
          id: r.id,
          locale: r.locale,
          slug: r.slug,
          title: r.title,
          hook: r.hook,
          publishedAt: r.publishedAt,
          image: toImage(r),
        })),
        themes: themesById,
      };
    },

    async findVisibleBySlug({ locale, slug }) {
      // Same shape as the list, filtered by the unique key (locale, slug).
      const rows = await db
        .select({
          ...listColumns,
          observation: pubView.observation,
          evocation: pubView.evocation,
          reflection: pubView.reflection,
          openQuestion: pubView.openQuestion,
        })
        .from(pubView)
        .where(and(eq(pubView.locale, locale), eq(pubView.slug, slug)))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      const themesById = await themesOf([r.id]);
      return {
        row: {
          id: r.id,
          locale: r.locale,
          slug: r.slug,
          title: r.title,
          hook: r.hook,
          publishedAt: r.publishedAt,
          observation: r.observation,
          evocation: r.evocation,
          reflection: r.reflection,
          openQuestion: r.openQuestion,
          image: toImage(r),
        },
        themes: themesById.get(r.id) ?? [],
      };
    },
  };
}
