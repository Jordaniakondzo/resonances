import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Drizzle mapping of the public read views created by migration
// 0002_public_read_views. They are declared `.existing()`: Drizzle never
// generates or alters them (they are not part of db/schema.ts, so drizzle-kit
// ignores this file). The visibility rule is applied inside the views, on the
// database clock; this mapping only describes their columns for typed SELECTs.
const publicRead = pgSchema("public_read");

export const publicPublicationsView = publicRead
  .view("publications", {
    id: uuid("id").notNull(),
    locale: text("locale").notNull(),
    slug: text("slug").notNull(),
    title: text("title"),
    hook: text("hook"),
    observation: text("observation"),
    evocation: text("evocation"),
    reflection: text("reflection"),
    openQuestion: text("open_question"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    imageWebUrl: text("image_web_url"),
    imageThumbnailUrl: text("image_thumbnail_url"),
    imageAltText: text("image_alt_text"),
    imageCaption: text("image_caption"),
    imageAuthor: text("image_author"),
    imageSource: text("image_source"),
    imageLicense: text("image_license"),
    imageWidth: integer("image_width"),
    imageHeight: integer("image_height"),
  })
  .existing();

export const publicPublicationThemesView = publicRead
  .view("publication_themes", {
    publicationId: uuid("publication_id").notNull(),
    themeSlug: text("theme_slug").notNull(),
    themeName: text("theme_name").notNull(),
  })
  .existing();
