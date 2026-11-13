// Cleanup of the PostgreSQL connections a test opens, with visible failures and
// bounded waits.
//
// node-postgres facts these helpers rely on (pg 8.23, pg-pool 3.14):
// - Pool.end() may be called only once: a second call is rejected ("Called end
//   on pool more than once"). It resolves when every client has left the pool,
//   so it keeps waiting while a checked-out client has not been released. It
//   may resolve before the sockets of its idle clients are actually closed.
// - Client.end() never rejects. It destroys the socket at once when a query is
//   still running or the socket is dead; otherwise it sends Terminate and
//   resolves when the server closes the connection, with no time limit.
// - release(true) removes a pooled client from its pool and ends it; a second
//   release of the same client throws.
// - An expired wait cancels nothing: the close keeps running and may still
//   resolve, reject, or never settle.
//
// Hence a close is attempted ONCE and tracked by a `CloseAttempt` until it
// settles. A wait that expires is reported as a failure; the attempt is not
// retried and is not forgotten: it stays in the `unfinished` list, may be
// awaited again (`waitForPendingCloses`), and its late outcome, with the cause
// of a late rejection, is recorded and reported as a process warning.
//
// Every wait here is bounded, so the hooks end in bounded time. That does NOT
// mean the resource was released: a close that never settles may leave a
// socket open, which keeps the test process alive after its last test.

const describe = (reason: unknown): string =>
  reason instanceof Error
    ? `${reason.name}: ${reason.message}`
    : `non-error value: ${String(reason)}`;

type Settled = { done: true; error?: unknown } | { done: false };

// Waits for `promise` at most `timeoutMs`; never rejects.
async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        (): Settled => ({ done: true }),
        (error: unknown): Settled => ({ done: true, error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type CloseOutcome =
  | { state: "pending" }
  | { state: "closed" }
  | { state: "failed"; error: unknown };

// One close attempt, from its start to its real outcome. `outcome` and
// `expiredWaits` are updated by this module only.
export type CloseAttempt = {
  readonly label: string;
  // Resolves once the close has settled, whatever the outcome; never rejects:
  // the rejection of the close is handled here, once, and kept in `outcome`.
  readonly settled: Promise<void>;
  outcome: CloseOutcome;
  // How many bounded waits for this attempt have expired so far.
  expiredWaits: number;
};

// Starts `close` now and tracks it; a synchronous throw becomes a rejection.
// A close that settles after a wait for it has expired emits a process warning
// with its late outcome, so that this outcome is never lost silently, even
// when no wait is in progress any more.
export function startClose(
  label: string,
  close: () => Promise<unknown>,
): CloseAttempt {
  let attempt: CloseAttempt;
  const settled = Promise.resolve()
    .then(close)
    .then(
      () => {
        attempt.outcome = { state: "closed" };
      },
      (error: unknown) => {
        attempt.outcome = { state: "failed", error };
      },
    )
    .then(() => {
      if (attempt.expiredWaits === 0) return;
      const { outcome } = attempt;
      process.emitWarning(
        `${label}: close settled after ${attempt.expiredWaits} expired wait(s): ${
          outcome.state === "failed"
            ? `failed, ${describe(outcome.error)}`
            : "closed"
        }`,
        { code: "RESONANCES_TEST_LATE_CLOSE" },
      );
    });
  attempt = { label, settled, outcome: { state: "pending" }, expiredWaits: 0 };
  return attempt;
}

// Waits for `attempt` at most `timeoutMs`; true once it has settled.
async function waitFor(
  attempt: CloseAttempt,
  timeoutMs: number,
): Promise<boolean> {
  if (attempt.outcome.state !== "pending") return true;
  const { done } = await settleWithin(attempt.settled, timeoutMs);
  if (!done) attempt.expiredWaits += 1;
  return done;
}

// Closes every resource of `resources` once, in parallel. A resource leaves the
// array only after its close has settled or its wait has expired. Returns one
// description per failure (rejection or expired wait); an attempt whose wait
// expired is added to `unfinished`.
export async function closeEachOnce<T>(
  resources: T[],
  close: (resource: T) => Promise<unknown>,
  unfinished: CloseAttempt[],
  timeoutMs: number,
): Promise<string[]> {
  const targets = resources.slice();
  const attempts = targets.map((resource, index) =>
    startClose(`#${index}`, () => close(resource)),
  );
  const done = await Promise.all(attempts.map((a) => waitFor(a, timeoutMs)));
  for (const resource of targets)
    resources.splice(resources.indexOf(resource), 1);
  const failures: string[] = [];
  attempts.forEach((attempt, index) => {
    const { outcome } = attempt;
    if (!done[index]) {
      unfinished.push(attempt);
      failures.push(`${attempt.label}: not closed within ${timeoutMs} ms`);
    } else if (outcome.state === "failed")
      failures.push(`${attempt.label}: ${describe(outcome.error)}`);
  });
  return failures;
}

// Throws one error listing every failure, so that the hook (and the test) fail.
export function reportCleanupFailures(
  what: string,
  failures: readonly string[],
): void {
  if (failures.length > 0)
    throw new Error(`cleanup of ${what} failed: ${failures.join("; ")}`);
}

// Waits (bounded) once more for the attempts whose wait expired earlier; never
// calls a close again. Attempts that have settled leave `unfinished`; those
// still pending STAY in it. Returns one description per attempt that is not
// closed: still pending, or settled late with a rejection (cause included).
export async function waitForPendingCloses(
  unfinished: CloseAttempt[],
  timeoutMs: number,
): Promise<string[]> {
  const waited = unfinished.slice();
  await Promise.all(waited.map((a) => waitFor(a, timeoutMs)));
  const failures: string[] = [];
  for (const attempt of waited) {
    const { outcome } = attempt;
    if (outcome.state === "pending") {
      failures.push(
        `${attempt.label}: still not closed after ${attempt.expiredWaits} expired waits (left running, not retried)`,
      );
      continue;
    }
    unfinished.splice(unfinished.indexOf(attempt), 1);
    if (outcome.state === "failed")
      failures.push(
        `${attempt.label}: closed late with a failure: ${describe(outcome.error)}`,
      );
  }
  return failures;
}

export type CleanupStep = readonly [label: string, run: () => Promise<unknown>];

// Runs the steps of a file's final cleanup in order, each one whatever happened
// to the previous ones, then `last` (the release of the administrative
// connection) from a `finally`. Errors are collected, never replaced: if any
// step failed, one AggregateError is thrown whose `errors` are the original
// error objects in order of occurrence, the first one being the primary error.
export async function runCleanupSteps(
  steps: readonly CleanupStep[],
  last: CleanupStep,
): Promise<void> {
  const errors: unknown[] = [];
  const labels: string[] = [];
  const run = async ([label, step]: CleanupStep) => {
    try {
      await step();
    } catch (error) {
      errors.push(error);
      labels.push(label);
    }
  };
  try {
    for (const step of steps) await run(step);
  } finally {
    await run(last);
  }
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      `final cleanup failed in ${errors.length} step(s): ${labels
        .map((label, i) => `[${label}] ${describe(errors[i])}`)
        .join("; ")}`,
    );
}

// Ends the transaction of a pooled client and ALWAYS gives the client back,
// destroyed (release(true)): after a failed or hung ROLLBACK its state is
// unknown, and destroying it ends the server session, which rolls back.
// - Body succeeded: a ROLLBACK failure (or timeout) is thrown, after release.
// - Body failed: the body's error is the one that matters and must propagate
//   unchanged from the caller's `finally`, so the ROLLBACK failure is only
//   reported as a process warning.
export async function rollbackAndDestroy(
  client: {
    query(text: string): Promise<unknown>;
    release(destroy?: boolean): void;
  },
  bodyFailed: boolean,
  timeoutMs: number,
): Promise<void> {
  let settled: Settled;
  try {
    // A synchronous throw of `query` becomes a rejection like any other.
    const rollback = Promise.resolve().then(() => client.query("ROLLBACK"));
    settled = await settleWithin(rollback, timeoutMs);
  } finally {
    client.release(true);
  }
  const failure = !settled.done
    ? new Error(`ROLLBACK did not finish within ${timeoutMs} ms`)
    : "error" in settled
      ? settled.error
      : undefined;
  if (failure === undefined) return;
  if (!bodyFailed) throw failure;
  process.emitWarning(
    `ROLLBACK failed after a test failure (the test's own error is kept): ${describe(failure)}`,
    { code: "RESONANCES_TEST_ROLLBACK" },
  );
}
