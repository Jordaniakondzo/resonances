import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ReferenceReader } from "../editorial/resolve.js";
import { and, eq } from "drizzle-orm";
import { themes, mediaAssets } from "../../db/schema.js";
export function editorialReferences(db: NodePgDatabase): ReferenceReader {
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
