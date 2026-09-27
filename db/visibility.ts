import { sql, type SQLWrapper } from "drizzle-orm";

// Time-dependent visibility is evaluated on reads, not enforced by a CHECK constraint.
export function publicContentWhere(content: {
  status: SQLWrapper;
  publishedAt: SQLWrapper;
}) {
  return sql`${content.status} = 'published'
    AND ${content.publishedAt} IS NOT NULL
    AND ${content.publishedAt} <= now()`;
}
