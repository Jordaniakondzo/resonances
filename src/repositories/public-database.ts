import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

// Server-only PostgreSQL client for the public read path.
//
// It reads APP_DATABASE_URL, the connection string of the read-only role
// described in db/provisioning/app-reader.sql. It must never be given the
// importer, migration or administrator credentials, and it must never be
// imported from a client component.
export type PublicDb = NodePgDatabase;

export interface PublicDatabase {
  db: PublicDb;
  // Raw pool, exposed so tests can probe the session; application code uses `db`.
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createPublicDatabase(connectionString: string): PublicDatabase {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    // Defence in depth on top of the role's privileges: every session of this
    // pool is read-only and bounded in time.
    options: "-c default_transaction_read_only=on",
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 10000,
  });
  // An idle connection error must not crash the server process.
  pool.on("error", () => undefined);
  return { db: drizzle(pool), pool, close: () => pool.end() };
}

let shared: PublicDatabase | undefined;

// Lazily opened so that importing this module never needs the variable (build time).
export function getPublicDb(): PublicDb {
  if (!shared) {
    const url = process.env.APP_DATABASE_URL;
    // The message names the variable, never its value.
    if (!url) throw new Error("APP_DATABASE_URL is not configured.");
    shared = createPublicDatabase(url);
  }
  return shared.db;
}
