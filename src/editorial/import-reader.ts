import type { ReferenceReader } from "./resolve.js";
import type {
  ContentType,
  PublicationSnapshot,
  ReflectionSnapshot,
} from "./snapshots.js";

export interface SlugKey {
  locale: string;
  slug: string;
}

export interface SlugOwner extends SlugKey {
  id: string;
}

// Media metadata needed to decide whether a referenced asset is ready.
export interface MediaReadinessRow {
  id: string;
  originalUrl: string;
  altText: string | null;
  source: string | null;
  license: string | null;
  author: string | null;
  width: number | null;
  height: number | null;
}

// Read side of the D03 import. Implementations are bound by the caller to a
// connection or transaction, and read rows of every status (draft, published,
// archived): these reads are internal and never apply public visibility rules.
export interface ImportReader extends ReferenceReader {
  findPublications(ids: readonly string[]): Promise<PublicationSnapshot[]>;
  findReflections(ids: readonly string[]): Promise<ReflectionSnapshot[]>;
  findSlugOwners(
    type: ContentType,
    keys: readonly SlugKey[],
  ): Promise<readonly SlugOwner[]>;
  findMedia(ids: readonly string[]): Promise<readonly MediaReadinessRow[]>;
}

// Raised when a stored `published_at` cannot be represented as an InstantUs
// (BC dates, years above 9999, infinity). The row is refused rather than
// converted, so it can never be mistaken for "no date" or for a NOOP.
// Turning this into a structured diagnostic is the job of the D03-03 service.
export class UnsupportedPublishedAtError extends Error {
  constructor(
    public readonly contentType: ContentType,
    public readonly id: string,
  ) {
    super(
      `${contentType} ${id}: published_at is outside the supported InstantUs range (years 0001-9999).`,
    );
    this.name = "UnsupportedPublishedAtError";
  }
}
