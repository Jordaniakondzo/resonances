import { eq, sql } from "drizzle-orm";
import { publications, reflections } from "../../db/schema.js";
import type { MediaReadinessRow } from "../editorial/import-reader.js";
import type { ContentType } from "../editorial/snapshots.js";
import type { EditorialDb } from "./editorial-references.js";

export type LockedTheme = {
  id: string;
  locale: string;
  slug: string;
};

// Protections of the D03 import (ADR-B1), bound to the caller's transaction.
// Each method protects ONE row and returns the values read under that
// protection, or null when the row does not exist. A null is never a
// validation: the service turns it into a missing reference.
//
// The reference tables are only reachable through the three fixed SECURITY
// DEFINER functions of schema d03_priv. The importer has no UPDATE privilege on
// themes or media_assets, so no direct `SELECT ... FOR SHARE` is possible here.
export interface ReferenceLocks {
  // d03_priv.lock_theme: FOR SHARE, protects the resolved (locale, slug) pair.
  lockTheme(id: string): Promise<LockedTheme | null>;
  // d03_priv.lock_media_key: FOR KEY SHARE, existence for draft/archive use.
  lockMediaKey(id: string): Promise<{ id: string } | null>;
  // d03_priv.lock_media_ready: FOR SHARE, readiness metadata for published use.
  lockMediaReady(id: string): Promise<MediaReadinessRow | null>;
  // SELECT id FROM <table> WHERE id = $1 FOR UPDATE, for a row about to be
  // updated. Allowed by the importer's own UPDATE privilege on the content table.
  lockContentForUpdate(type: ContentType, id: string): Promise<boolean>;
}

type ReadyRow = {
  id: string;
  original_url: string;
  alt_text: string | null;
  source: string | null;
  license: string | null;
  author: string | null;
  width: number | null;
  height: number | null;
};

export function referenceLocks(db: EditorialDb): ReferenceLocks {
  return {
    async lockTheme(id) {
      // SELECT id, locale, slug FROM d03_priv.lock_theme($1::uuid).
      const result = await db.execute<LockedTheme>(
        sql`SELECT id, locale, slug FROM d03_priv.lock_theme(${id}::uuid)`,
      );
      return result.rows[0] ?? null;
    },

    async lockMediaKey(id) {
      const result = await db.execute<{ id: string }>(
        sql`SELECT id FROM d03_priv.lock_media_key(${id}::uuid)`,
      );
      return result.rows[0] ?? null;
    },

    async lockMediaReady(id) {
      const result = await db.execute<ReadyRow>(
        sql`SELECT id, original_url, alt_text, source, license, author, width, height FROM d03_priv.lock_media_ready(${id}::uuid)`,
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        originalUrl: row.original_url,
        altText: row.alt_text,
        source: row.source,
        license: row.license,
        author: row.author,
        width: row.width,
        height: row.height,
      };
    },

    async lockContentForUpdate(type, id) {
      const table = type === "publication" ? publications : reflections;
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, id))
        .for("update");
      return rows.length === 1;
    },
  };
}
