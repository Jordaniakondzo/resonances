import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  check,
  unique,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

export const contentStatus = pgEnum("content_status", [
  "draft",
  "published",
  "archived",
]);
const dates = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
const contentColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  locale: text("locale").notNull().default("fr"),
  slug: text("slug"),
  title: text("title"),
  status: contentStatus("status").notNull().default("draft"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...dates(),
});

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    originalFilename: text("original_filename"),
    originalUrl: text("original_url").notNull(),
    webUrl: text("web_url"),
    thumbnailUrl: text("thumbnail_url"),
    altText: text("alt_text"),
    caption: text("caption"),
    author: text("author"),
    source: text("source"),
    license: text("license"),
    width: integer("width"),
    height: integer("height"),
    mimeType: text("mime_type"),
    ...dates(),
  },
  (t) => [
    check(
      "media_assets_original_url_nonempty",
      sql`length(btrim(${t.originalUrl})) > 0`,
    ),
    check("media_assets_width_positive", sql`${t.width} > 0`),
    check("media_assets_height_positive", sql`${t.height} > 0`),
  ],
);

export const themes = pgTable(
  "themes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locale: text("locale").notNull().default("fr"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    ...dates(),
  },
  (t) => [
    unique("themes_locale_slug_unique").on(t.locale, t.slug),
    check(
      "themes_locale_valid",
      sql`length(btrim(${t.locale})) > 0 AND ${t.locale} = btrim(${t.locale})`,
    ),
    check("themes_name_nonempty", sql`length(btrim(${t.name})) > 0`),
    check("themes_slug_valid", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const publications = pgTable(
  "publications",
  {
    ...contentColumns(),
    hook: text("hook"),
    observation: text("observation"),
    evocation: text("evocation"),
    reflection: text("reflection"),
    openQuestion: text("open_question"),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    unique("publications_locale_slug_unique").on(t.locale, t.slug),
    check(
      "publications_locale_valid",
      sql`length(btrim(${t.locale})) > 0 AND ${t.locale} = btrim(${t.locale})`,
    ),
    check(
      "publications_slug_valid",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "publications_published_date_required",
      sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`,
    ),
    index("publications_media_idx").on(t.mediaAssetId),
    index("publications_public_listing_idx")
      .on(t.locale, t.publishedAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'published' AND ${t.publishedAt} IS NOT NULL`),
  ],
);

export const reflections = pgTable(
  "reflections",
  {
    ...contentColumns(),
    excerpt: text("excerpt"),
    content: text("content"),
    coverMediaId: uuid("cover_media_id").references(() => mediaAssets.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    unique("reflections_locale_slug_unique").on(t.locale, t.slug),
    check(
      "reflections_locale_valid",
      sql`length(btrim(${t.locale})) > 0 AND ${t.locale} = btrim(${t.locale})`,
    ),
    check(
      "reflections_slug_valid",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      "reflections_published_date_required",
      sql`${t.status} <> 'published' OR ${t.publishedAt} IS NOT NULL`,
    ),
    index("reflections_media_idx").on(t.coverMediaId),
    index("reflections_public_listing_idx")
      .on(t.locale, t.publishedAt.desc(), t.id.desc())
      .where(sql`${t.status} = 'published' AND ${t.publishedAt} IS NOT NULL`),
  ],
);

export const publicationThemes = pgTable(
  "publication_themes",
  {
    publicationId: uuid("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.publicationId, t.themeId] }),
    index("publication_themes_theme_idx").on(t.themeId),
  ],
);

export const reflectionThemes = pgTable(
  "reflection_themes",
  {
    reflectionId: uuid("reflection_id")
      .notNull()
      .references(() => reflections.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.reflectionId, t.themeId] }),
    index("reflection_themes_theme_idx").on(t.themeId),
  ],
);
