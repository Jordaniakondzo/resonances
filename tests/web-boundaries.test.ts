import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Static guard for the Web application boundary (T1).
// Everything reachable from src/app/ through relative imports must stay free of
// privileged modules: import writer, B1 administration, migrations, PostgreSQL drivers.
// This is a source-level check; the built client bundle is scanned by
// scripts/check-client-bundle.ts after `npm run build:web`.

const root = process.cwd();
const appDir = path.join(root, "src", "app");

// Repository paths (relative to the root, with "/" separators) that the Web app must never reach.
const FORBIDDEN_PATH_PREFIXES = [
  "src/editorial/import-writer",
  "src/repositories/editorial-import-writer",
  "src/repositories/editorial-reference-locks",
  "src/services/editorial-import",
  "scripts/",
  "db/migrations",
  "drizzle/",
  "drizzle.config",
];

// Bare package specifiers that open database connections or run migrations.
const FORBIDDEN_PACKAGES = ["pg", "drizzle-orm", "drizzle-kit", "postgres"];

// Environment variables that must never be read from application pages in T1.
const FORBIDDEN_ENV_NAMES = [
  "DATABASE_URL",
  "APP_DATABASE_URL",
  "TEST_DATABASE_URL",
  "IMPORT_DATABASE_URL",
  "ADMIN_DATABASE_URL",
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (SOURCE_EXTENSIONS.includes(path.extname(full))) files.push(full);
  }
  return files;
}

function extractSpecifiers(source: string): string[] {
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"()]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

function resolveRelative(
  fromFile: string,
  specifier: string,
): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  // NodeNext-style code may import "./x.js" for "./x.ts".
  const withoutJs = base.replace(/\.(m?js)$/, "");
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => withoutJs + ext),
    ...SOURCE_EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

function toRepoPath(absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

interface Violation {
  file: string;
  detail: string;
}

function collectViolations(entryFiles: string[]): Violation[] {
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    const repoPath = toRepoPath(file);

    for (const name of FORBIDDEN_ENV_NAMES) {
      // Word boundaries: "DATABASE_URL" must not also match inside "APP_DATABASE_URL".
      if (new RegExp(`\\b${name}\\b`).test(source)) {
        violations.push({
          file: repoPath,
          detail: `reads forbidden env name ${name}`,
        });
      }
    }

    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        // Non-source assets (e.g. CSS) are not traversed.
        if (!resolved) {
          const guess = toRepoPath(path.resolve(path.dirname(file), specifier));
          if (
            FORBIDDEN_PATH_PREFIXES.some((prefix) => guess.startsWith(prefix))
          ) {
            violations.push({
              file: repoPath,
              detail: `imports forbidden path ${guess}`,
            });
          }
          continue;
        }
        const resolvedPath = toRepoPath(resolved);
        if (
          FORBIDDEN_PATH_PREFIXES.some((prefix) =>
            resolvedPath.startsWith(prefix),
          )
        ) {
          violations.push({
            file: repoPath,
            detail: `imports forbidden module ${resolvedPath}`,
          });
          continue;
        }
        queue.push(resolved);
      } else {
        const packageName = specifier.startsWith("node:")
          ? specifier
          : specifier.split("/")[0];
        if (packageName && FORBIDDEN_PACKAGES.includes(packageName)) {
          violations.push({
            file: repoPath,
            detail: `imports forbidden package ${specifier}`,
          });
        }
      }
    }
  }

  return violations;
}

test("src/app only reaches non-privileged modules", () => {
  const entries = listSourceFiles(appDir);
  assert.ok(entries.length > 0, "expected source files under src/app");
  assert.deepEqual(collectViolations(entries), []);
});

test("the boundary scanner detects forbidden imports (self-check)", async () => {
  // Proves the guard is not vacuous: a synthetic file importing a privileged module is flagged.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(path.join(tmpdir(), "boundary-"));
  try {
    mkdirSync(path.join(tmp, "src", "editorial"), { recursive: true });
    const offending = path.join(tmp, "page.tsx");
    writeFileSync(
      offending,
      'import { x } from "pg";\nconst u = process.env.APP_DATABASE_URL;\n',
    );
    const violations = collectViolations([offending]);
    assert.equal(violations.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pages under src/app are server components unless they declare a client directive", () => {
  // T1 has no interactive island: no file should opt into the client yet.
  const clientFiles = listSourceFiles(appDir).filter((file) =>
    /^\s*["']use client["']/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(clientFiles.map(toRepoPath), []);
});
