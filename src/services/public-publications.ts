import { getPublicDb } from "../repositories/public-database.js";
import {
  publicPublicationsRepository,
  type PublicImageRow,
  type PublicPublicationsRepository,
  type PublicThemeRow,
} from "../repositories/public-publications.js";

// Public read service for Publications (T2).
//
// Visibility contract (docs: specification 6.2, data core): a publication is
// public when status = 'published' AND published_at IS NOT NULL AND
// published_at <= now(). That rule is applied by the public_read views in
// PostgreSQL, on the database clock: nothing in this module, and no caller, can
// pick another instant. Drafts, archived (withdrawn) content and future dates
// never reach the callers. There is no separate "withdrawn" status in V1:
// withdrawal is `archived` (or any move away from `published`).

export const DEFAULT_LOCALE = "fr";
export const DEFAULT_LIST_LIMIT = 24;
export const MAX_LIST_LIMIT = 100;

// Same shape as the SQL CHECK and the editorial validator.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface PublicTheme {
  slug: string;
  name: string;
}

// Delivery image: only the web variants. The original file is never exposed.
export interface PublicImage {
  url: string;
  thumbnailUrl: string | null;
  alt: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  credit: {
    author: string | null;
    source: string | null;
    license: string | null;
  };
}

export interface PublicPublicationSummary {
  slug: string;
  title: string | null;
  hook: string | null;
  publishedAt: Date;
  image: PublicImage | null;
  themes: PublicTheme[];
}

export interface PublicPublication extends PublicPublicationSummary {
  locale: string;
  observation: string | null;
  evocation: string | null;
  reflection: string | null;
  openQuestion: string | null;
}

export interface PublicReadOptions {
  locale?: string;
}

export interface ListPublicationsOptions extends PublicReadOptions {
  limit?: number;
}

// The only error a caller can see. It never carries SQL, parameters or the
// connection string; the original error stays in `cause` for server logs.
export class PublicReadError extends Error {
  constructor(cause: unknown) {
    super("Public content is temporarily unavailable.", { cause });
    this.name = "PublicReadError";
  }
}

function toImage(row: PublicImageRow | null): PublicImage | null {
  // No web variant: no image. We never fall back to the original file.
  if (row === null || row.webUrl === null) return null;
  return {
    url: row.webUrl,
    thumbnailUrl: row.thumbnailUrl,
    alt: row.altText,
    caption: row.caption,
    width: row.width,
    height: row.height,
    credit: { author: row.author, source: row.source, license: row.license },
  };
}

function toThemes(rows: PublicThemeRow[] | undefined): PublicTheme[] {
  return (rows ?? []).map((t) => ({ slug: t.slug, name: t.name }));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
}

// The factory takes the repository so tests can substitute it; the exported
// functions below bind it to the read-only database.
export function createPublicPublicationsService(
  repository: () => PublicPublicationsRepository,
) {
  return {
    async listPublications(
      options: ListPublicationsOptions = {},
    ): Promise<PublicPublicationSummary[]> {
      try {
        const { rows, themes } = await repository().listVisible({
          locale: options.locale ?? DEFAULT_LOCALE,
          limit: clampLimit(options.limit),
        });
        return rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          hook: row.hook,
          publishedAt: row.publishedAt,
          image: toImage(row.image),
          themes: toThemes(themes.get(row.id)),
        }));
      } catch (error) {
        throw new PublicReadError(error);
      }
    },

    // Resolves to null for every case a visitor must not distinguish: unknown
    // slug, malformed slug, draft, scheduled, archived. The caller renders a 404.
    async getPublicationBySlug(
      slug: string,
      options: PublicReadOptions = {},
    ): Promise<PublicPublication | null> {
      if (!SLUG_PATTERN.test(slug)) return null;
      try {
        const found = await repository().findVisibleBySlug({
          locale: options.locale ?? DEFAULT_LOCALE,
          slug,
        });
        if (!found) return null;
        const { row } = found;
        return {
          slug: row.slug,
          locale: row.locale,
          title: row.title,
          hook: row.hook,
          publishedAt: row.publishedAt,
          image: toImage(row.image),
          themes: toThemes(found.themes),
          observation: row.observation,
          evocation: row.evocation,
          reflection: row.reflection,
          openQuestion: row.openQuestion,
        };
      } catch (error) {
        throw new PublicReadError(error);
      }
    },
  };
}

const service = createPublicPublicationsService(() =>
  publicPublicationsRepository(getPublicDb()),
);

export const listPublications = service.listPublications;
export const getPublicationBySlug = service.getPublicationBySlug;
