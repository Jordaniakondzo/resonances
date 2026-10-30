import type { SourceDocument } from "../../src/editorial/batch-validation.js";

export const ID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
  d: "44444444-4444-4444-8444-444444444444",
  media: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  media2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

interface DocOptions {
  id: string;
  file?: string;
  locale?: string;
  status?: "draft" | "published" | "archived";
  // `undefined` means "derive a slug from the id"; `null` means no slug.
  slug?: string | null;
  title?: string;
  publishedAt?: string;
  themes?: readonly string[];
  media?: string | null;
}

function frontmatter(type: string, o: DocOptions, extra: string[]) {
  const status = o.status ?? "draft";
  const slug = o.slug === undefined ? "slug-" + o.id.slice(0, 8) : o.slug;
  const lines = [
    "---",
    `type: ${type}`,
    `id: ${o.id}`,
    `locale: ${o.locale ?? "fr"}`,
    `status: ${status}`,
    `slug: ${slug === null ? "null" : slug}`,
    `title: ${o.title ?? "Titre"}`,
  ];
  if (status === "published" || o.publishedAt)
    lines.push(`published_at: ${o.publishedAt ?? "2026-01-01T10:00:00Z"}`);
  // A published document needs at least one theme; default to a known one.
  const themes = o.themes ?? (status === "published" ? ["memoire"] : []);
  if (themes.length)
    lines.push("themes:", ...themes.map((slug) => `  - ${slug}`));
  lines.push(...extra, "---");
  return lines;
}

export function publicationDoc(o: DocOptions): SourceDocument {
  const published = (o.status ?? "draft") === "published";
  const extra: string[] = [];
  if (published || o.media) extra.push("hook: Accroche");
  const media = o.media === undefined && published ? ID.media : o.media;
  if (media) extra.push("media:", `  id: ${media}`);
  const body = published
    ? [
        "## Observation",
        "Ce qui est visible.",
        "## Évocation",
        "Ce qui est suggéré.",
        "## Réflexion",
        "Ce qui est pensé.",
        "## Question ouverte",
        "Et vous ?",
      ]
    : [];
  return {
    file: o.file ?? `content/publications/${o.id}.md`,
    text: [...frontmatter("publication", o, extra), ...body, ""].join("\n"),
  };
}

export function reflectionDoc(o: DocOptions): SourceDocument {
  const published = (o.status ?? "draft") === "published";
  const extra: string[] = [];
  if (published) extra.push("excerpt: Extrait");
  if (o.media) extra.push("cover_media:", `  id: ${o.media}`);
  const body = published ? ["Un corps de réflexion."] : [];
  return {
    file: o.file ?? `content/reflections/${o.id}.md`,
    text: [...frontmatter("reflection", o, extra), ...body, ""].join("\n"),
  };
}
