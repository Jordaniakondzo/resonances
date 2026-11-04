import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Post-build guard: the browser-facing output (.next/static) must not contain
// privileged module names, connection strings or database environment variables.
// Run after `npm run build:web`.

const staticDir = path.join(process.cwd(), ".next", "static");

const FORBIDDEN_MARKERS = [
  "APP_DATABASE_URL",
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "postgres://",
  "postgresql://",
  "drizzle-orm",
  "import-writer",
  "editorial-import",
  "runImport",
];

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

if (!existsSync(staticDir)) {
  console.error("No .next/static directory: run `npm run build:web` first.");
  process.exit(2);
}

const textExtensions = new Set([
  ".js",
  ".css",
  ".json",
  ".txt",
  ".html",
  ".map",
]);
const files = listFiles(staticDir).filter((file) =>
  textExtensions.has(path.extname(file)),
);
const hits: string[] = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const marker of FORBIDDEN_MARKERS) {
    if (content.includes(marker)) {
      hits.push(`${path.relative(process.cwd(), file)}: contains "${marker}"`);
    }
  }
}

console.log(`Scanned ${files.length} client files under .next/static.`);
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("No forbidden marker found in the client bundle.");
