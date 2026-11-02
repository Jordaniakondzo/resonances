import { sql } from "drizzle-orm";
import { is } from "drizzle-orm/entity";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgTransaction } from "drizzle-orm/pg-core";
import pg from "pg";
import { compareParseDiagnostics } from "../editorial/batch-validation.js";
import { buildImportPlan } from "../editorial/import-plan.js";
import type { ImportPlan } from "../editorial/operations.js";
import {
  loadSources,
  SourceIoError,
  type LoadedSources,
} from "../editorial/source-loader.js";
import { importReader } from "../repositories/editorial-import-reader.js";

// Terminal states of a dry-run. They are deliberately different from the import
// states of D03-RESULT-01: a dry-run neither applies nor rejects anything.
export type DryRunResult =
  // A plan was produced. It may well have `applicable: false`; it is only a
  // description of one consistent view of PostgreSQL, not a reservation.
  | { status: "PLANNED"; plan: ImportPlan }
  // No reliable plan could be produced. `message` never carries SQL text,
  // bound parameters or absolute paths.
  | {
      status: "FAILED";
      code: "SOURCE_IO_ERROR" | "DATABASE_ERROR";
      message: string;
    };

// The one transaction configuration of the dry-run, exported so tests can use
// exactly what the service uses.
export const DRY_RUN_TRANSACTION = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

// Raised when the transaction is not the root REPEATABLE READ READ ONLY one.
// It is an environment or programming error, not an expected database failure,
// so it is never turned into a FAILED result.
export class DryRunTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DryRunTransactionError";
  }
}

// The first statement of the transaction. Besides taking the snapshot, it proves
// by SQL that the transaction really has the expected mode. This check cannot
// tell a root transaction from a savepoint inside an outer REPEATABLE READ READ
// ONLY one: that case is refused beforehand by `refuseExistingTransaction`.
async function assertSnapshotTransaction(
  tx: Pick<NodePgDatabase, "execute">,
): Promise<void> {
  const result = await tx.execute<{ isolation: string; read_only: string }>(
    sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
  );
  const row = result.rows[0];
  if (row?.isolation !== "repeatable read" || row.read_only !== "on")
    throw new DryRunTransactionError(
      `Dry-run transaction is not REPEATABLE READ READ ONLY (isolation=${row?.isolation}, read_only=${row?.read_only}).`,
    );
}

// Expected operational failures, by SQLSTATE class: 08 connection exception,
// 40 transaction rollback, 53 insufficient resources, 57 operator intervention
// (including statement timeout and shutdown), 58 system error. Every other
// class (42 syntax or missing object, 22 data, 23 integrity, 25 transaction
// state...) means the code or the schema is wrong and is rethrown, never
// reported as an ordinary failure.
const EXPECTED_SQLSTATE_CLASSES = new Set(["08", "40", "53", "57", "58"]);
// Class 55 (object not in the prerequisite state) is not expected as a whole:
// only 55P03 lock_not_available is, because a plain SELECT can legitimately
// hit it when a lock_timeout is configured and a DDL holds an exclusive lock.
// 55000, 55006 (object in use), 55P02, 55P04 are rethrown.
const EXPECTED_SQLSTATES = new Set(["55P03"]);
const CONNECTION_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
// node-postgres and pg-pool raise connection failures as plain Errors without a
// code; these are their exact message openings (pg 8.23 client.js, pg-pool).
// Anchored and case-sensitive, so a message that merely contains the words
// (editorial content echoed by another error) is not taken for a connection loss.
const CONNECTION_MESSAGE =
  /^(?:Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed)/;

// Returns a fixed, content-free label for an expected failure, or undefined.
// Drizzle wraps driver errors in DrizzleQueryError, whose message holds the SQL
// and the bound parameters (editorial content), so only the cause is read. The
// label contains the SQLSTATE or errno only: server and socket messages may echo
// values, role names, hosts or paths.
function expectedFailureLabel(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof DrizzleQueryError) current = current.cause;
  if (!(current instanceof Error)) return undefined;
  const code = (current as { code?: unknown }).code;
  if (current instanceof pg.DatabaseError)
    return typeof code === "string" &&
      (EXPECTED_SQLSTATE_CLASSES.has(code.slice(0, 2)) ||
        EXPECTED_SQLSTATES.has(code))
      ? `SQLSTATE ${code}`
      : undefined;
  if (typeof code === "string" && CONNECTION_ERRNO.has(code)) return code;
  return CONNECTION_MESSAGE.test(current.message)
    ? "connexion interrompue"
    : undefined;
}

// `db.transaction()` on a Drizzle transaction object does not open a root
// transaction: it issues SAVEPOINT and ignores the isolation and access mode.
// A savepoint inside an outer REPEATABLE READ READ ONLY transaction would also
// pass the SQL check, so a Drizzle transaction object is refused by type. `is()`
// is Drizzle's own entity test (prototype chain plus entityKind): it needs
// neither a class name nor a property that both objects happen to have.
function refuseExistingTransaction(db: NodePgDatabase): void {
  if (is(db, PgTransaction))
    throw new DryRunTransactionError(
      "runDryRun needs the root database object, not a transaction: it opens and closes its own transaction.",
    );
}

// Adds the load diagnostics to the plan, sorted like the parse errors of the
// plan. A load error makes the whole batch non applicable.
function mergeLoadErrors(plan: ImportPlan, loaded: LoadedSources): ImportPlan {
  if (loaded.loadErrors.length === 0) return plan;
  return {
    operations: plan.operations,
    parseErrors: [...plan.parseErrors, ...loaded.loadErrors].sort(
      compareParseDiagnostics,
    ),
    applicable: false,
  };
}

// Builds the ImportPlan of already loaded sources inside ONE root transaction
// REPEATABLE READ READ ONLY. Every read of the plan sees the same snapshot, no
// row lock is taken, no writer exists here, and nothing is retried.
//
// `db` must be the root database object (a pool-backed or client-backed
// NodePgDatabase), never a transaction.
//
// The result describes the database as seen by that snapshot. It does not
// reserve slugs, UUIDs or any state: the future import recomputes its own plan.
export async function runDryRun(
  db: NodePgDatabase,
  loaded: LoadedSources,
): Promise<DryRunResult> {
  // Before any SQL: nothing is sent on a connection that belongs to the caller.
  refuseExistingTransaction(db);
  let plan: ImportPlan;
  try {
    plan = await db.transaction(async (tx) => {
      await assertSnapshotTransaction(tx);
      return buildImportPlan(loaded.sources, importReader(tx));
    }, DRY_RUN_TRANSACTION);
  } catch (error) {
    // Only expected operational failures are reported. Anything else (a bug,
    // a wrong query, a DryRunTransactionError) stays visible to the caller.
    const label = expectedFailureLabel(error);
    if (label === undefined) throw error;
    return {
      status: "FAILED",
      code: "DATABASE_ERROR",
      message: `Erreur PostgreSQL ou de connexion (${label}).`,
    };
  }
  return { status: "PLANNED", plan: mergeLoadErrors(plan, loaded) };
}

// Convenience entry point: load the sources (before any transaction), then run
// the dry-run. An I/O failure returns FAILED without ever touching PostgreSQL.
export async function dryRunFromDirectory(
  db: NodePgDatabase,
  rootDir: string,
  files?: readonly string[],
): Promise<DryRunResult> {
  let loaded: LoadedSources;
  try {
    loaded = await loadSources(rootDir, files);
  } catch (error) {
    if (!(error instanceof SourceIoError)) throw error;
    return {
      status: "FAILED",
      code: "SOURCE_IO_ERROR",
      message: error.message,
    };
  }
  return runDryRun(db, loaded);
}
