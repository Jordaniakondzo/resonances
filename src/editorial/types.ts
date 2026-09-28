export interface ParsedBase {
  id: string;
  locale: string;
  status: "draft" | "published" | "archived";
  slug: string | null;
  title: string | null;
  publishedAt: Date | null;
  themeSlugs: string[];
}
export interface ParsedPublication extends ParsedBase {
  type: "publication";
  hook: string | null;
  mediaAssetId: string | null;
  observation: string | null;
  evocation: string | null;
  reflection: string | null;
  openQuestion: string | null;
}
export interface ParsedReflection extends ParsedBase {
  type: "reflection";
  excerpt: string | null;
  coverMediaId: string | null;
  content: string | null;
}
export type ParsedContent = ParsedPublication | ParsedReflection;
export class ContentValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly field: string,
    message: string,
  ) {
    super(`${file}: ${field}: ${message}`);
    this.name = "ContentValidationError";
  }
}
