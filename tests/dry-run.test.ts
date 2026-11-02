import assert from "node:assert/strict";
import { test } from "node:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { ParseDiagnostic } from "../src/editorial/operations.js";
import type { LoadedSources } from "../src/editorial/source-loader.js";
import {
  DRY_RUN_TRANSACTION,
  DryRunTransactionError,
  dryRunFromDirectory,
  runDryRun,
} from "../src/services/editorial-dry-run.js";

// These tests use a stand-in for the database object: they cover how the
// service classifies failures and merges diagnostics, not what PostgreSQL does
// (that is dry-run.pg.test.ts).
type Callback = (tx: unknown) => Promise<unknown>;
const fakeDb = (transaction: (cb: Callback, config: unknown) => unknown) =>
  ({ transaction }) as unknown as NodePgDatabase;
const goodTx = {
  execute: async () => ({
    rows: [{ isolation: "repeatable read", read_only: "on" }],
  }),
};
const empty: LoadedSources = { sources: [], loadErrors: [] };

function databaseError(code: string, message: string) {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}

test("the transaction options are REPEATABLE READ READ ONLY", async () => {
  let seen: unknown;
  const result = await runDryRun(
    fakeDb((cb, config) => {
      seen = config;
      return cb(goodTx);
    }),
    empty,
  );
  assert.equal(result.status, "PLANNED");
  assert.deepEqual(seen, DRY_RUN_TRANSACTION);
  assert.deepEqual(DRY_RUN_TRANSACTION, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
});

test("a transaction that is not the expected one is refused before any plan work", async () => {
  let executed = 0;
  const tx = {
    execute: async () => {
      executed++;
      return { rows: [{ isolation: "read committed", read_only: "off" }] };
    },
  };
  await assert.rejects(
    runDryRun(
      fakeDb((cb) => cb(tx)),
      empty,
    ),
    DryRunTransactionError,
  );
  assert.equal(executed, 1);
});

test("a PostgreSQL error becomes FAILED with its SQLSTATE", async () => {
  const result = await runDryRun(
    fakeDb(async () => {
      throw databaseError("40001", "could not serialize access");
    }),
    empty,
  );
  assert.deepEqual(result, {
    status: "FAILED",
    code: "DATABASE_ERROR",
    message: "Erreur PostgreSQL ou de connexion (SQLSTATE 40001).",
  });
});

test("a FAILED message never leaks SQL, parameters or server-echoed values", async () => {
  const secretSql = 'select * from "publications" where id = $1';
  const secretParam = "contenu-éditorial-confidentiel";
  const echoing = databaseError(
    "57014",
    `canceling statement near "${secretParam}" for role bob at 10.1.2.3`,
  );
  for (const thrown of [
    new DrizzleQueryError(secretSql, [secretParam], echoing),
    echoing,
    Object.assign(new Error(`connect ECONNREFUSED 10.1.2.3:5432`), {
      code: "ECONNREFUSED",
    }),
  ]) {
    const result = await runDryRun(
      fakeDb(async () => {
        throw thrown;
      }),
      empty,
    );
    assert.equal(result.status, "FAILED");
    const serialized = JSON.stringify(result);
    for (const secret of [
      secretParam,
      "publications",
      "Failed query",
      "bob",
      "10.1.2.3",
    ])
      assert.ok(!serialized.includes(secret), "leaked: " + secret);
  }
});

test("a transaction object is refused before any query goes through its session", async () => {
  // A real Drizzle transaction object, built on the library's own classes.
  const { PgDialect, PgTransaction } = await import("drizzle-orm/pg-core");
  const { NodePgTransaction } =
    await import("drizzle-orm/node-postgres/session");
  // Drizzle never calls `session.execute`: every statement, including the
  // SAVEPOINT of a nested transaction, goes through `prepareQuery(...).execute()`.
  // The stand-in session records the SQL text at that point.
  const sent: string[] = [];
  const session = {
    prepareQuery: (query: { sql: string }) => ({
      execute: async () => {
        sent.push(query.sql);
        return { rows: [] };
      },
    }),
  };
  const tx = new NodePgTransaction(
    new PgDialect(),
    session as never,
    undefined,
  );
  assert.ok(tx instanceof PgTransaction);

  // Control: the stand-in does observe what Drizzle sends on this path, so an
  // empty `sent` below cannot come from a blind probe.
  await tx.transaction(async () => undefined);
  assert.deepEqual(sent, ["savepoint sp1", "release savepoint sp1"]);

  sent.length = 0;
  await assert.rejects(
    runDryRun(tx as unknown as NodePgDatabase, empty),
    DryRunTransactionError,
  );
  assert.deepEqual(sent, []);
});

test("a message that only contains connection wording is not a connection loss", async () => {
  const bug = new Error("note: Connection terminated is documented here");
  await assert.rejects(
    runDryRun(
      fakeDb(async () => {
        throw bug;
      }),
      empty,
    ),
    (error) => error === bug,
  );
});

test("SQLSTATE classes that signal a bug or a wrong schema are rethrown, not reported", async () => {
  for (const code of [
    "42601",
    "42P01",
    "42703",
    "22012",
    "23505",
    "25006",
    "55000",
    "55006",
    "55P02",
    "55P04",
  ]) {
    const error = databaseError(code, "server message");
    await assert.rejects(
      runDryRun(
        fakeDb(async () => {
          throw new DrizzleQueryError("select 1", [], error);
        }),
        empty,
      ),
      (thrown) => thrown instanceof DrizzleQueryError,
      code,
    );
  }
  for (const code of [
    "08006",
    "40001",
    "40P01",
    "53300",
    "57014",
    "57P01",
    "58030",
  ]) {
    const result = await runDryRun(
      fakeDb(async () => {
        throw databaseError(code, "server message");
      }),
      empty,
    );
    assert.equal(result.status, "FAILED", code);
  }
});

test("a DrizzleQueryError wrapping an allowed SQLSTATE is reported by that SQLSTATE", async () => {
  for (const code of ["40001", "55P03", "57014", "08006"]) {
    const wrapped = new DrizzleQueryError(
      "select secret from t where a = $1",
      ["valeur-privée"],
      databaseError(code, "server text with valeur-privée"),
    );
    const result = await runDryRun(
      fakeDb(async () => {
        throw wrapped;
      }),
      empty,
    );
    assert.deepEqual(result, {
      status: "FAILED",
      code: "DATABASE_ERROR",
      message: `Erreur PostgreSQL ou de connexion (SQLSTATE ${code}).`,
    });
  }
});

test("connection failures are FAILED, without any retry", async () => {
  for (const make of [
    () => Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
    () => new Error("Connection terminated unexpectedly"),
  ]) {
    let attempts = 0;
    const result = await runDryRun(
      fakeDb(async () => {
        attempts++;
        throw make();
      }),
      empty,
    );
    assert.equal(result.status, "FAILED");
    assert.equal(attempts, 1);
  }
});

test("unexpected errors are not masked", async () => {
  const bug = new TypeError("programming error");
  await assert.rejects(
    runDryRun(
      fakeDb(async () => {
        throw bug;
      }),
      empty,
    ),
    (error) => error === bug,
  );
  // Editorial content that looks like a connection message is not one either.
  await assert.rejects(
    runDryRun(
      fakeDb(async () => {
        throw new DrizzleQueryError("select 1", ["Connection terminated"], bug);
      }),
      empty,
    ),
    (error) => error instanceof DrizzleQueryError,
  );
});

test("load diagnostics are merged with plan parse errors, sorted, and make the plan non applicable", async () => {
  const brokenDoc = {
    file: "content/publications/m.md",
    text: "pas de frontmatter",
  };
  const loadErrors: ParseDiagnostic[] = [
    {
      category: "PARSE_ERROR",
      code: "INVALID_DOCUMENT",
      file: "content/publications/z.md",
      field: "file",
      message: "Encodage UTF-8 invalide.",
    },
    {
      category: "PARSE_ERROR",
      code: "INVALID_DOCUMENT",
      file: "content/publications/a.md",
      field: "file",
      message: "Lien symbolique refusé.",
    },
  ];
  const result = await runDryRun(
    fakeDb((cb) => cb(goodTx)),
    { sources: [brokenDoc], loadErrors },
  );
  assert.equal(result.status, "PLANNED");
  if (result.status !== "PLANNED") return;
  assert.deepEqual(
    result.plan.parseErrors.map((e) => e.file),
    [
      "content/publications/a.md",
      "content/publications/m.md",
      "content/publications/z.md",
    ],
  );
  assert.equal(result.plan.applicable, false);
});

test("load diagnostics alone make the plan non applicable; none leaves it applicable", async () => {
  const error: ParseDiagnostic = {
    category: "PARSE_ERROR",
    code: "INVALID_DOCUMENT",
    file: "content/publications/a.md",
    field: "file",
    message: "Encodage UTF-8 invalide.",
  };
  const clean = await runDryRun(
    fakeDb((cb) => cb(goodTx)),
    empty,
  );
  assert.deepEqual(clean, {
    status: "PLANNED",
    plan: { operations: [], parseErrors: [], applicable: true },
  });
  const blocked = await runDryRun(
    fakeDb((cb) => cb(goodTx)),
    { sources: [], loadErrors: [error] },
  );
  assert.deepEqual(blocked, {
    status: "PLANNED",
    plan: { operations: [], parseErrors: [error], applicable: false },
  });
});

test("a source I/O failure returns FAILED and never opens a transaction", async () => {
  let opened = 0;
  const db = fakeDb(async () => {
    opened++;
    throw new Error("must not be called");
  });
  const result = await dryRunFromDirectory(
    db,
    "Z:\\definitely\\missing\\root-for-dry-run-test",
  );
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.code, "SOURCE_IO_ERROR");
  assert.ok(!result.message.includes("definitely"), "absolute path leaked");
  assert.equal(opened, 0);
});
