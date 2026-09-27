CREATE TYPE "public"."content_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"original_filename" text,
	"original_url" text NOT NULL,
	"web_url" text,
	"thumbnail_url" text,
	"alt_text" text,
	"caption" text,
	"author" text,
	"source" text,
	"license" text,
	"width" integer,
	"height" integer,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_original_url_nonempty" CHECK (length(btrim("media_assets"."original_url")) > 0),
	CONSTRAINT "media_assets_width_positive" CHECK ("media_assets"."width" > 0),
	CONSTRAINT "media_assets_height_positive" CHECK ("media_assets"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "publication_themes" (
	"publication_id" uuid NOT NULL,
	"theme_id" uuid NOT NULL,
	CONSTRAINT "publication_themes_publication_id_theme_id_pk" PRIMARY KEY("publication_id","theme_id")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locale" text DEFAULT 'fr' NOT NULL,
	"slug" text,
	"title" text,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hook" text,
	"observation" text,
	"evocation" text,
	"reflection" text,
	"open_question" text,
	"media_asset_id" uuid,
	CONSTRAINT "publications_locale_slug_unique" UNIQUE("locale","slug"),
	CONSTRAINT "publications_locale_valid" CHECK (length(btrim("publications"."locale")) > 0 AND "publications"."locale" = btrim("publications"."locale")),
	CONSTRAINT "publications_slug_valid" CHECK ("publications"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "publications_published_date_required" CHECK ("publications"."status" <> 'published' OR "publications"."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reflection_themes" (
	"reflection_id" uuid NOT NULL,
	"theme_id" uuid NOT NULL,
	CONSTRAINT "reflection_themes_reflection_id_theme_id_pk" PRIMARY KEY("reflection_id","theme_id")
);
--> statement-breakpoint
CREATE TABLE "reflections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locale" text DEFAULT 'fr' NOT NULL,
	"slug" text,
	"title" text,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"excerpt" text,
	"content" text,
	"cover_media_id" uuid,
	CONSTRAINT "reflections_locale_slug_unique" UNIQUE("locale","slug"),
	CONSTRAINT "reflections_locale_valid" CHECK (length(btrim("reflections"."locale")) > 0 AND "reflections"."locale" = btrim("reflections"."locale")),
	CONSTRAINT "reflections_slug_valid" CHECK ("reflections"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "reflections_published_date_required" CHECK ("reflections"."status" <> 'published' OR "reflections"."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locale" text DEFAULT 'fr' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_locale_slug_unique" UNIQUE("locale","slug"),
	CONSTRAINT "themes_locale_valid" CHECK (length(btrim("themes"."locale")) > 0 AND "themes"."locale" = btrim("themes"."locale")),
	CONSTRAINT "themes_name_nonempty" CHECK (length(btrim("themes"."name")) > 0),
	CONSTRAINT "themes_slug_valid" CHECK ("themes"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "publication_themes" ADD CONSTRAINT "publication_themes_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_themes" ADD CONSTRAINT "publication_themes_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_themes" ADD CONSTRAINT "reflection_themes_reflection_id_reflections_id_fk" FOREIGN KEY ("reflection_id") REFERENCES "public"."reflections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflection_themes" ADD CONSTRAINT "reflection_themes_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reflections" ADD CONSTRAINT "reflections_cover_media_id_media_assets_id_fk" FOREIGN KEY ("cover_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_themes_theme_idx" ON "publication_themes" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "publications_media_idx" ON "publications" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX "publications_public_listing_idx" ON "publications" USING btree ("locale","published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "publications"."status" = 'published' AND "publications"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reflection_themes_theme_idx" ON "reflection_themes" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "reflections_media_idx" ON "reflections" USING btree ("cover_media_id");--> statement-breakpoint
CREATE INDEX "reflections_public_listing_idx" ON "reflections" USING btree ("locale","published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "reflections"."status" = 'published' AND "reflections"."published_at" IS NOT NULL;