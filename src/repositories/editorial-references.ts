import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { ReferenceReader } from "../editorial/resolve.js";
import { and, eq } from "drizzle-orm";
import { themes, mediaAssets } from "../../db/schema.js";

// A Drizzle context already bound to the caller's connection or transaction.
// Both `NodePgDatabase` and the `tx` given by `db.transaction()` extend
// `PgDatabase`, so readers accept either without opening a transaction.
export type EditorialDb = PgDatabase<NodePgQueryResultHKT>;

export function editorialReferences(db: EditorialDb): ReferenceReader {
  return {
    async findTheme(locale, slug) {
      // SELECT id FROM themes WHERE locale = $1 AND slug = $2 LIMIT 1.
      const rows = await db
        .select({ id: themes.id })
        .from(themes)
        .where(and(eq(themes.locale, locale), eq(themes.slug, slug)))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    async mediaExists(id) {
      // SELECT id FROM media_assets WHERE id = $1 LIMIT 1.
      const rows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, id))
        .limit(1);
      return rows.length === 1;
    },
  };
}
