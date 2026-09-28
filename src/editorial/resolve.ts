import { ContentValidationError, type ParsedContent } from "./types.js";
export interface ReferenceReader {
  findTheme(locale: string, slug: string): Promise<string | null>;
  mediaExists(id: string): Promise<boolean>;
}
export async function resolveReferences(
  content: ParsedContent,
  reader: ReferenceReader,
  file: string,
) {
  const themeIds: string[] = [];
  for (const slug of content.themeSlugs) {
    const id = await reader.findTheme(content.locale, slug);
    if (!id)
      throw new ContentValidationError(
        file,
        "themes",
        `Thème inexistant pour ${content.locale} : ${slug}.`,
      );
    themeIds.push(id);
  }
  const mediaId =
    content.type === "publication"
      ? content.mediaAssetId
      : content.coverMediaId;
  if (mediaId && !(await reader.mediaExists(mediaId))) {
    throw new ContentValidationError(
      file,
      content.type === "publication" ? "media" : "cover_media",
      "Média inexistant.",
    );
  }
  return { content, themeIds: [...new Set(themeIds)].sort() };
}
