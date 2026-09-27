import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "db/migrations" });
} finally {
  await client.end();
}
