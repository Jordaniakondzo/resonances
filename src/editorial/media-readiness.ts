import type { MediaReadinessRow } from "./import-reader.js";

const isBlank = (value: string | null): boolean =>
  value === null || value.trim() === "";

// Names of the columns that make a media asset unfit for a `published` target.
// This checks presence and minimal shape only (D03-MEDIA-01): it certifies
// neither rights, nor provenance, nor the quality of the alt text, nor the
// existence of the remote file. `author` is deliberately not required, and
// `width`/`height` may stay NULL; they only have to be positive when set.
export function mediaReadinessProblems(
  row: MediaReadinessRow,
): readonly string[] {
  const problems: string[] = [];
  if (isBlank(row.originalUrl)) problems.push("original_url");
  if (isBlank(row.altText)) problems.push("alt_text");
  if (isBlank(row.source)) problems.push("source");
  if (isBlank(row.license)) problems.push("license");
  if (row.width !== null && !(row.width > 0)) problems.push("width");
  if (row.height !== null && !(row.height > 0)) problems.push("height");
  return problems;
}
