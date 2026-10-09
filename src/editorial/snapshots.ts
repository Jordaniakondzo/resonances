import type { ParsedContent } from "./types.js";
import { instantUsFromDate, type InstantUs } from "./instant-us.js";

export type ContentType = ParsedContent["type"];
export type ContentStatus = ParsedContent["status"];

export interface SnapshotBase {
  id: string;
  locale: string;
  slug: string | null;
  title: string | null;
  status: ContentStatus;
  publishedAt: InstantUs | null;
  themeIds: readonly string[];
}

export interface PublicationSnapshot extends SnapshotBase {
  type: "publication";
  hook: string | null;
  mediaAssetId: string | null;
  observation: string | null;
  evocation: string | null;
  reflection: string | null;
  openQuestion: string | null;
}

export interface ReflectionSnapshot extends SnapshotBase {
  type: "reflection";
  excerpt: string | null;
  coverMediaId: string | null;
  content: string | null;
}

export type EditorialSnapshot = PublicationSnapshot | ReflectionSnapshot;

export function canonicalThemeIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

export function snapshotFromResolved(resolved: {
  content: ParsedContent;
  themeIds: readonly string[];
}): EditorialSnapshot {
  const { content } = resolved;
  const base = {
    id: content.id,
    locale: content.locale,
    slug: content.slug,
    title: content.title,
    status: content.status,
    publishedAt: content.publishedAt
      ? instantUsFromDate(content.publishedAt)
      : null,
    themeIds: canonicalThemeIds(resolved.themeIds),
  };
  if (content.type === "publication") {
    return {
      ...base,
      type: "publication",
      hook: content.hook,
      mediaAssetId: content.mediaAssetId,
      observation: content.observation,
      evocation: content.evocation,
      reflection: content.reflection,
      openQuestion: content.openQuestion,
    };
  }
  return {
    ...base,
    type: "reflection",
    excerpt: content.excerpt,
    coverMediaId: content.coverMediaId,
    content: content.content,
  };
}
