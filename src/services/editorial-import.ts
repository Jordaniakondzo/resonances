import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { buildImportPlan } from "../editorial/import-plan.js";
import type {
  ImportReader,
  MediaReadinessRow,
} from "../editorial/import-reader.js";
import type { ImportPlan } from "../editorial/operations.js";
import type { LoadedSources } from "../editorial/source-loader.js";
import type { ContentType, EditorialSnapshot } from "../editorial/snapshots.js";
import { importReader } from "../repositories/editorial-import-reader.js";
import { importWriter } from "../repositories/editorial-import-writer.js";
import {
  referenceLocks,
  type LockedTheme,
  type ReferenceLocks,
} from "../repositories/editorial-reference-locks.js";
import {
  CONNECTION_ERRNO,
  CONNECTION_MESSAGE,
  mergeLoadErrors,
} from "./editorial-dry-run.js";

// ---------------------------------------------------------------------------
// Result contract (D03-RESULT-01)
// ---------------------------------------------------------------------------

export type ImportExecutionResult =
  // COMMIT confirmed. The counters describe the plan that was really committed.
  | {
      status: "APPLIED";
      committed: true;
      attempts: number;
      plan: ImportPlan;
      created: number;
      updated: number;
      noop: number;
    }
  // Editorial rejection: nothing was committed.
  | { status: "REJECTED"; committed: false; plan: ImportPlan }
  // Technical failure with a proven absence of commit.
  | {
      status: "FAILED";
      committed: false;
      attempts: number;
      code: "RETRY_EXHAUSTED" | "DATABASE_ERROR";
      message: string;
    }
  // The answer to COMMIT was lost. Neither success nor rollback is assumed.
  | {
      status: "UNKNOWN_COMMIT_OUTCOME";
      committed: "unknown";
      attempts: number;
      message: string;
    };

// The one transaction configuration of the import. Exported so tests use
// exactly what the service uses.
export const IMPORT_BEGIN = "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE";

// Three complete transactional attempts, the first one included.
export const MAX_ATTEMPTS = 3;

// Only these two SQLSTATE codes trigger an automatic new attempt.
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

// A violated constraint is only an editorial conflict if a fresh read proves
// it. These are the constraints a concurrent writer can legitimately trip:
// the editorial key and identity of a content row, and the references of a
// content row. Any other constraint is a technical failure.
const PROVABLE_CONSTRAINTS = new Set([
  // 23505 unique_violation
  "publications_locale_slug_unique",
  "reflections_locale_slug_unique",
  "publications_pkey",
  "reflections_pkey",
  // 23503 foreign_key_violation
  "publications_media_asset_id_media_assets_id_fk",
  "reflections_cover_media_id_media_assets_id_fk",
  "publication_themes_theme_id_themes_id_fk",
  "reflection_themes_theme_id_themes_id_fk",
]);

// ---------------------------------------------------------------------------
// Errors that are defects, not outcomes
// ---------------------------------------------------------------------------

// The connection is not in the transaction the service asked for. An
// environment or programming error: never turned into a FAILED result.
export class ImportTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportTransactionError";
  }
}

// The protected values and the plan disagree in a way the protocol cannot
// produce (for example a reference the plan needs was never protected).
export class ImportProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Pool and options
// ---------------------------------------------------------------------------

// The service needs a dedicated connection for the whole attempt, so it takes
// the pool itself: `db.transaction()` of Drizzle is deliberately not used,
// because it issues ROLLBACK in its own catch block after a failed COMMIT and
// may then report the rollback error instead of the COMMIT error, which makes
// the outcome of COMMIT impossible to tell apart.
export type ImportPool = Pick<pg.Pool, "connect">;

export interface ImportOptions {
  // Waiting time between two attempts; replaceable by tests.
  sleep?: (milliseconds: number) => Promise<void>;
  // Delay before attempt `nextAttempt` (2 or 3), in milliseconds.
  retryDelay?: (nextAttempt: number) => number;
}

// Short and bounded: 20-40 ms before attempt 2, 40-60 ms before attempt 3.
function defaultRetryDelay(nextAttempt: number): number {
  return 20 * (nextAttempt - 1) + 20 * Math.random();
}

// ---------------------------------------------------------------------------
// PostgreSQL error reading
// ---------------------------------------------------------------------------

// Drizzle wraps driver errors; the SQL text and parameters sit in the wrapper
// message (editorial content), so only the cause is ever read.
function driverError(error: unknown): unknown {
  let current = error;
  while (current instanceof DrizzleQueryError) current = current.cause;
  return current;
}

function databaseError(error: unknown): pg.DatabaseError | undefined {
  const cause = driverError(error);
  return cause instanceof pg.DatabaseError ? cause : undefined;
}

// A failure of the connection itself (no answer from the server).
function isConnectionFailure(error: unknown): boolean {
  const cause = driverError(error);
  if (!(cause instanceof Error) || cause instanceof pg.DatabaseError)
    return false;
  const code = (cause as { code?: unknown }).code;
  return (
    (typeof code === "string" && CONNECTION_ERRNO.has(code)) ||
    CONNECTION_MESSAGE.test(cause.message)
  );
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

type AttemptOutcome =
  | {
      kind: "APPLIED";
      plan: ImportPlan;
      created: number;
      updated: number;
      noop: number;
    }
  | { kind: "REJECTED"; plan: ImportPlan }
  | { kind: "RETRY"; sqlstate: string }
  | { kind: "FAILED"; message: string }
  | { kind: "UNKNOWN"; message: string };

type BodyResult =
  | { kind: "REJECTED"; plan: ImportPlan }
  | {
      kind: "READY";
      plan: ImportPlan;
      created: number;
      updated: number;
      noop: number;
    };

// What the plan needs to be protected, from a plan that is applicable.
interface Protections {
  themeIds: string[];
  // Strongest mode needed per media row.
  media: Map<string, "key" | "ready">;
}

function snapshotsOf(plan: ImportPlan): EditorialSnapshot[] {
  return plan.operations.flatMap((operation) =>
    operation.kind === "CREATE" || operation.kind === "UPDATE"
      ? [operation.after]
      : operation.kind === "NOOP"
        ? [operation.snapshot]
        : [],
  );
}

function mediaIdOf(snapshot: EditorialSnapshot): string | null {
  return snapshot.type === "publication"
    ? snapshot.mediaAssetId
    : snapshot.coverMediaId;
}

// Plain ascending order of canonical lowercase UUID text, which is also the
// byte order PostgreSQL uses for uuid values.
const ascending = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function protectionsOf(plan: ImportPlan): Protections {
  const themeIds = new Set<string>();
  const media = new Map<string, "key" | "ready">();
  for (const snapshot of snapshotsOf(plan)) {
    for (const themeId of snapshot.themeIds) themeIds.add(themeId);
    const mediaId = mediaIdOf(snapshot);
    if (mediaId === null) continue;
    // Published content needs the readiness metadata; a row used both ways
    // takes the stronger protection.
    if (snapshot.status === "published") media.set(mediaId, "ready");
    else if (!media.has(mediaId)) media.set(mediaId, "key");
  }
  return { themeIds: [...themeIds].sort(ascending), media };
}

interface LockedReferences {
  themes: Map<string, LockedTheme | null>;
  media: Map<
    string,
    { mode: "key" | "ready"; row: MediaReadinessRow | { id: string } | null }
  >;
}

// ADR-B1 order: themes by ascending UUID, then media by ascending UUID, one
// call per row, all on the connection of the transaction.
async function acquireReferenceLocks(
  locks: ReferenceLocks,
  needed: Protections,
): Promise<LockedReferences> {
  const locked: LockedReferences = { themes: new Map(), media: new Map() };
  for (const id of needed.themeIds)
    locked.themes.set(id, await locks.lockTheme(id));
  for (const id of [...needed.media.keys()].sort(ascending)) {
    const mode = needed.media.get(id)!;
    locked.media.set(id, {
      mode,
      row:
        mode === "ready"
          ? await locks.lockMediaReady(id)
          : await locks.lockMediaKey(id),
    });
  }
  return locked;
}

// A reader that answers reference questions from the protected values. A
// reference whose protection found no row is reported as absent, so the
// ordinary plan builder produces the MISSING_REFERENCE conflict. A reference
// the plan asks about but nobody protected is a protocol defect.
function protectedReader(
  base: ImportReader,
  locked: LockedReferences,
): ImportReader {
  async function findMedia(ids: readonly string[]) {
    const rows = await base.findMedia(ids);
    const result: MediaReadinessRow[] = [];
    for (const row of rows) {
      const entry = locked.media.get(row.id);
      if (!entry)
        throw new ImportProtocolError(
          `media ${row.id} was read but never protected`,
        );
      if (entry.row === null) continue;
      // Protected metadata replaces the unprotected read for published use.
      result.push(
        entry.mode === "ready" ? (entry.row as MediaReadinessRow) : row,
      );
    }
    return result;
  }
  return {
    ...base,
    async findTheme(locale, slug) {
      const id = await base.findTheme(locale, slug);
      if (id === null) return null;
      if (!locked.themes.has(id))
        throw new ImportProtocolError(
          `theme ${id} was resolved but never protected`,
        );
      const row = locked.themes.get(id);
      return row && row.locale === locale && row.slug === slug ? id : null;
    },
    async mediaExists(id) {
      return (await findMedia([id])).length === 1;
    },
    findMedia,
  };
}

// Stable order of the writes and of the content locks: by type, then UUID.
const typeRank: Record<ContentType, number> = { publication: 0, reflection: 1 };
function byTypeThenId(
  a: { type: ContentType; id: string },
  b: { type: ContentType; id: string },
): number {
  return typeRank[a.type] - typeRank[b.type] || ascending(a.id, b.id);
}

// Theme pairs to remove and add, both ascending.
function themeDelta(before: readonly string[], after: readonly string[]) {
  const had = new Set(before);
  const wants = new Set(after);
  return {
    removeIds: before.filter((id) => !wants.has(id)).sort(ascending),
    addIds: after.filter((id) => !had.has(id)).sort(ascending),
  };
}

async function assertImportTransaction(db: NodePgDatabase): Promise<void> {
  const result = await db.execute<{ isolation: string; read_only: string }>(
    sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`,
  );
  const row = result.rows[0];
  if (row?.isolation !== "serializable" || row.read_only !== "off")
    throw new ImportTransactionError(
      `Import transaction is not SERIALIZABLE READ WRITE (isolation=${row?.isolation}, read_only=${row?.read_only}).`,
    );
}

// Everything between BEGIN and COMMIT. Writes nothing unless the rebuilt plan
// is applicable, and returns instead of committing.
async function importBody(
  db: NodePgDatabase,
  loaded: LoadedSources,
): Promise<BodyResult> {
  await assertImportTransaction(db);
  const reader = importReader(db);

  // 1. First reading, only to know which rows must be protected. It is not
  //    used as authority for any write.
  const firstPlan = mergeLoadErrors(
    await buildImportPlan(loaded.sources, reader),
    loaded,
  );
  // A batch that is not applicable writes nothing, so protecting references
  // for it would only create contention.
  if (!firstPlan.applicable) return { kind: "REJECTED", plan: firstPlan };

  // 2. Protections, in the contractual order: themes, then media, then content.
  const locks = referenceLocks(db);
  const locked = await acquireReferenceLocks(locks, protectionsOf(firstPlan));

  // 3. The plan is rebuilt from scratch with the protected values.
  const plan = mergeLoadErrors(
    await buildImportPlan(loaded.sources, protectedReader(reader, locked)),
    loaded,
  );
  if (!plan.applicable) return { kind: "REJECTED", plan };

  // The rebuilt plan may need fewer protections than the first one, never more.
  const covered = protectionsOf(plan);
  for (const id of covered.themeIds)
    if (!locked.themes.has(id))
      throw new ImportProtocolError(`theme ${id} is not protected`);
  for (const [id, mode] of covered.media) {
    const entry = locked.media.get(id);
    if (!entry || (mode === "ready" && entry.mode !== "ready"))
      throw new ImportProtocolError(`media ${id} is not protected enough`);
  }

  // 4. Existing rows about to be updated, by (type, id) ascending.
  const updates = plan.operations
    .flatMap((operation) => (operation.kind === "UPDATE" ? [operation] : []))
    .sort((a, b) => byTypeThenId(a.after, b.after));
  for (const operation of updates)
    if (
      !(await locks.lockContentForUpdate(
        operation.after.type,
        operation.after.id,
      ))
    )
      throw new ImportProtocolError(
        `${operation.after.type} ${operation.after.id} disappeared before its update`,
      );

  // 5. Writes. NOOP issues no command at all.
  const writer = importWriter(db);
  const writes = plan.operations
    .flatMap((operation) =>
      operation.kind === "CREATE" || operation.kind === "UPDATE"
        ? [operation]
        : [],
    )
    .sort((a, b) => byTypeThenId(a.after, b.after));
  let created = 0;
  let updated = 0;
  for (const operation of writes) {
    const after = operation.after;
    if (operation.kind === "CREATE") {
      if (after.type === "publication") await writer.insertPublication(after);
      else await writer.insertReflection(after);
      await writer.applyThemeDelta(after.type, after.id, [], after.themeIds);
      created += 1;
    } else {
      // The parent row is always rewritten, even when only themes changed, so
      // that `updated_at` reflects the change.
      if (after.type === "publication") await writer.updatePublication(after);
      else await writer.updateReflection(after);
      const { removeIds, addIds } = themeDelta(
        operation.before.themeIds,
        after.themeIds,
      );
      if (removeIds.length > 0 || addIds.length > 0)
        await writer.applyThemeDelta(after.type, after.id, removeIds, addIds);
      updated += 1;
    }
  }
  const noop = plan.operations.filter((o) => o.kind === "NOOP").length;
  return { kind: "READY", plan, created, updated, noop };
}

// Returns true when the server confirmed the rollback. A false value means the
// connection can no longer be trusted (it must be destroyed). In both cases no
// COMMIT was ever sent, so nothing of this attempt can be committed.
async function rollback(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

// A fresh read of the plan after a constraint violation, outside the failed
// transaction. It only serves as evidence: no protection, no write.
// The proof transaction is closed under control or the evidence is discarded:
// when its ROLLBACK is not confirmed, the connection state is unknown and
// ProofCloseError is raised, whatever the read itself produced.
class ProofCloseError extends Error {
  constructor() {
    super("The proof transaction could not be closed.");
    this.name = "ProofCloseError";
  }
}

async function provePlan(client: pg.PoolClient, loaded: LoadedSources) {
  let failed = false;
  let failure: unknown;
  let plan: ImportPlan | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    plan = mergeLoadErrors(
      await buildImportPlan(loaded.sources, importReader(drizzle(client))),
      loaded,
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (!(await rollback(client))) throw new ProofCloseError();
  if (failed) throw failure;
  return plan as ImportPlan;
}

// Shared with the caller so it knows whether the connection may be reused.
interface ConnectionHealth {
  // True when the transactional state of the connection is not confirmed.
  uncertain: boolean;
}

// A retryable error whose transaction end is not confirmed: no new attempt.
function unconfirmedMessage(error: pg.DatabaseError): string {
  return `${sqlstateMessage(error)} Fin de transaction non confirmée (ROLLBACK) : connexion détruite, aucune nouvelle tentative.`;
}

function sqlstateMessage(error: pg.DatabaseError): string {
  // The SQLSTATE only: server messages and details may echo content.
  return `Erreur PostgreSQL (SQLSTATE ${error.code ?? "inconnu"}).`;
}

async function attemptImport(
  pool: ImportPool,
  loaded: LoadedSources,
): Promise<AttemptOutcome> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    // No transaction exists yet, so no commit can exist either.
    if (isConnectionFailure(error))
      return { kind: "FAILED", message: "Connexion impossible." };
    const db = databaseError(error);
    if (db && !["28P01", "3D000"].includes(db.code ?? ""))
      return { kind: "FAILED", message: sqlstateMessage(db) };
    throw error;
  }

  // A checked-out client that loses its connection emits 'error'; without a
  // listener that event would be thrown outside any promise chain.
  let connectionLost = false;
  const onError = () => {
    connectionLost = true;
  };
  client.on("error", onError);
  // BEGIN inside a transaction only raises a notice (25001); we need it to fail.
  let nestedBegin = false;
  const onNotice = (notice: { code?: string }) => {
    if (notice.code === "25001") nestedBegin = true;
  };
  client.on("notice", onNotice);

  const health: ConnectionHealth = { uncertain: false };
  try {
    // ---- Phase 1: BEGIN, reads, protections, writes (no COMMIT sent yet) ----
    let body: BodyResult;
    try {
      await client.query(IMPORT_BEGIN);
      if (nestedBegin)
        throw new ImportTransactionError(
          "The connection was already inside a transaction.",
        );
      body = await importBody(drizzle(client), loaded);
    } catch (error) {
      // A new attempt is only allowed once the end of this transaction is
      // confirmed: a failed ROLLBACK or a lost connection leaves it unknown.
      const rolledBack = (await rollback(client)) && !connectionLost;
      health.uncertain = !rolledBack;
      return await classifyBodyError(error, client, loaded, rolledBack, health);
    }

    if (body.kind === "REJECTED") {
      health.uncertain = !(await rollback(client));
      return { kind: "REJECTED", plan: body.plan };
    }

    // ---- Phase 2: the single COMMIT ----
    try {
      const result = await client.query("COMMIT");
      // Committing an already aborted transaction answers "ROLLBACK" without
      // an error: that is a rollback, never a success.
      if (result.command !== "COMMIT")
        return { kind: "FAILED", message: "COMMIT a répondu ROLLBACK." };
      return {
        kind: "APPLIED",
        plan: body.plan,
        created: body.created,
        updated: body.updated,
        noop: body.noop,
      };
    } catch (error) {
      const db = databaseError(error);
      if (db) {
        // The server answered the COMMIT with an error: the transaction ended
        // without being committed (a failed COMMIT rolls back).
        // Ending it again is harmless (a warning at most) and guarantees that
        // the connection goes back to the pool outside any transaction.
        const confirmed = (await rollback(client)) && !connectionLost;
        health.uncertain = !confirmed;
        if (db.code && RETRYABLE_SQLSTATES.has(db.code))
          return confirmed
            ? { kind: "RETRY", sqlstate: db.code }
            : { kind: "FAILED", message: unconfirmedMessage(db) };
        return { kind: "FAILED", message: sqlstateMessage(db) };
      }
      // No server answer: the COMMIT may or may not have been applied.
      health.uncertain = true;
      return {
        kind: "UNKNOWN",
        message:
          "La réponse au COMMIT n'a pas été reçue : vérifier l'état de la base avant toute relance.",
      };
    }
  } finally {
    client.removeListener("error", onError);
    client.removeListener("notice", onNotice);
    // release(true) closes the connection instead of returning it to the pool:
    // a connection whose transactional state is not confirmed is never reused.
    client.release(health.uncertain || connectionLost);
  }
}

// Called after the transaction was rolled back (or its rollback failed, which
// still proves that no COMMIT was sent).
async function classifyBodyError(
  error: unknown,
  client: pg.PoolClient,
  loaded: LoadedSources,
  rolledBack: boolean,
  health: ConnectionHealth,
): Promise<AttemptOutcome> {
  const db = databaseError(error);
  if (db) {
    const code = db.code ?? "";
    if (RETRYABLE_SQLSTATES.has(code))
      return rolledBack
        ? { kind: "RETRY", sqlstate: code }
        : { kind: "FAILED", message: unconfirmedMessage(db) };
    if (
      rolledBack &&
      (code === "23505" || code === "23503") &&
      db.constraint !== undefined &&
      PROVABLE_CONSTRAINTS.has(db.constraint)
    ) {
      // Contextual reading: a concurrent writer may have created the conflict.
      // Only a fresh, complete plan can say so.
      try {
        const evidence = await provePlan(client, loaded);
        if (!evidence.applicable) return { kind: "REJECTED", plan: evidence };
      } catch (proofError) {
        if (proofError instanceof ProofCloseError) {
          // The proof transaction may still be open: no verdict is given.
          health.uncertain = true;
          return {
            kind: "FAILED",
            message: `${sqlstateMessage(db)} Preuve non concluante : fermeture de la transaction de lecture non confirmée, connexion détruite.`,
          };
        }
        const proofDb = databaseError(proofError);
        if (!proofDb && !isConnectionFailure(proofError)) throw proofError;
      }
    }
    return { kind: "FAILED", message: sqlstateMessage(db) };
  }
  if (isConnectionFailure(error))
    return { kind: "FAILED", message: "Connexion interrompue avant COMMIT." };
  // Anything else is a defect in the code or the environment: surface it.
  throw error;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Imports already loaded sources in at most three complete SERIALIZABLE
// READ WRITE transactions. Each attempt re-reads, re-protects and rebuilds the
// plan from scratch; a plan from the dry-run is never an authority.
//
// `pool` must give a fresh connection that is not inside a transaction.
// Nothing is reported as applied before the COMMIT is confirmed, and a COMMIT
// whose answer is lost is never retried.
export async function runImport(
  pool: ImportPool,
  loaded: LoadedSources,
  options: ImportOptions = {},
): Promise<ImportExecutionResult> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryDelay = options.retryDelay ?? defaultRetryDelay;

  let lastSqlstate = "inconnu";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const outcome = await attemptImport(pool, loaded);
    switch (outcome.kind) {
      case "APPLIED":
        return {
          status: "APPLIED",
          committed: true,
          attempts: attempt,
          plan: outcome.plan,
          created: outcome.created,
          updated: outcome.updated,
          noop: outcome.noop,
        };
      case "REJECTED":
        return { status: "REJECTED", committed: false, plan: outcome.plan };
      case "FAILED":
        return {
          status: "FAILED",
          committed: false,
          attempts: attempt,
          code: "DATABASE_ERROR",
          message: outcome.message,
        };
      case "UNKNOWN":
        return {
          status: "UNKNOWN_COMMIT_OUTCOME",
          committed: "unknown",
          attempts: attempt,
          message: outcome.message,
        };
      case "RETRY":
        lastSqlstate = outcome.sqlstate;
        if (attempt < MAX_ATTEMPTS) await sleep(retryDelay(attempt + 1));
    }
  }
  return {
    status: "FAILED",
    committed: false,
    attempts: MAX_ATTEMPTS,
    code: "RETRY_EXHAUSTED",
    message: `${MAX_ATTEMPTS} tentatives épuisées (dernier SQLSTATE ${lastSqlstate}).`,
  };
}
