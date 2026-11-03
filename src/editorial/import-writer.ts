import type {
  ContentType,
  PublicationSnapshot,
  ReflectionSnapshot,
} from "./snapshots.js";

// Write side of the D03 import (contract §3). An implementation is bound by
// the caller to ONE connection and ONE open transaction; it never opens,
// commits or rolls back anything. Every method is typed by content: no table
// name or column ever comes from a document.
//
// The service calls these methods only for CREATE and UPDATE operations of an
// applicable plan. A NOOP never reaches the writer.
export interface ImportWriter {
  // Inserts the row with the UUID of the source and every editorial column of
  // the snapshot. It does NOT insert theme associations: see applyThemeDelta.
  insertPublication(snapshot: PublicationSnapshot): Promise<void>;
  insertReflection(snapshot: ReflectionSnapshot): Promise<void>;

  // Rewrites the modifiable columns of the existing row and sets `updated_at`
  // explicitly. `id`, `locale`, `slug` and `created_at` are never written, and
  // the statement refuses to touch a row whose key differs from the snapshot.
  updatePublication(snapshot: PublicationSnapshot): Promise<void>;
  updateReflection(snapshot: ReflectionSnapshot): Promise<void>;

  // Deletes exactly the `removeIds` pairs and inserts exactly the `addIds`
  // pairs. Pairs that are not listed are never touched.
  applyThemeDelta(
    type: ContentType,
    id: string,
    removeIds: readonly string[],
    addIds: readonly string[],
  ): Promise<void>;
}

// Raised when a write does not have the exact effect the plan promised (for
// example an UPDATE that matches no row). Inside the serializable protocol this
// means a programming error or an external writer, never an editorial conflict:
// the service turns it into a rollback, not into a REJECTED result.
export class ImportWriteError extends Error {
  constructor(
    public readonly contentType: ContentType,
    public readonly id: string,
    detail: string,
  ) {
    super(`${contentType} ${id}: ${detail}`);
    this.name = "ImportWriteError";
  }
}
