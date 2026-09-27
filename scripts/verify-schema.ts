import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Fresh generation without an existing snapshot detects manual SQL changes.
const out = path.join(".local", "schema-check-" + randomUUID());
mkdirSync(out, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "node_modules/drizzle-kit/bin.cjs",
    "generate",
    "--dialect=postgresql",
    "--schema=./db/schema.ts",
    "--out=" + out,
    "--name=editorial_core",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0)
  throw new Error(result.stderr || result.stdout || "Generation failed");
const generated = readdirSync(out).filter((file) => file.endsWith(".sql"));
const committed = readdirSync("db/migrations").filter((file) =>
  file.endsWith(".sql"),
);
assert.equal(generated.length, 1);
assert.equal(
  committed.length,
  1,
  "This verifier covers the initial migration only; adapt it when adding migrations.",
);
const normalize = (file: string) =>
  readFileSync(file, "utf8").replaceAll("\r\n", "\n").trim();
assert.equal(
  normalize(path.join(out, generated[0]!)),
  normalize(path.join("db/migrations", committed[0]!)),
);
console.log(
  "Initial SQL migration matches a fresh generation from the Drizzle schema.",
);
