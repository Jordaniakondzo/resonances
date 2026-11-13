import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeEachOnce,
  reportCleanupFailures,
  rollbackAndDestroy,
  runCleanupSteps,
  startClose,
  waitForPendingCloses,
  type CleanupStep,
  type CloseAttempt,
} from "./support/connection-cleanup.js";

// Control flow of the test-connection cleanup helpers, with fake resources.
// What PostgreSQL and node-postgres do is checked separately against the real
// test instance; here only the helpers' own decisions are under test.

const never = () => new Promise<never>(() => undefined);

function fakeClient(rollback: () => Promise<unknown>) {
  const releases: (boolean | undefined)[] = [];
  return {
    releases,
    query: (text: string) => {
      assert.equal(text, "ROLLBACK");
      return rollback();
    },
    release(destroy?: boolean) {
      releases.push(destroy);
    },
  };
}

async function captureWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const listener = (warning: Error) => warnings.push(warning.message);
  process.on("warning", listener);
  try {
    const result = await run();
    // Warnings are emitted on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    return { result, warnings };
  } finally {
    process.off("warning", listener);
  }
}

// --- rollbackAndDestroy ------------------------------------------------------

test("rollbackAndDestroy: ROLLBACK succeeds, the client is destroyed once", async () => {
  const client = fakeClient(async () => undefined);
  await rollbackAndDestroy(client, false, 1000);
  assert.deepEqual(client.releases, [true]);
});

test("rollbackAndDestroy: a failed ROLLBACK after a passing body is thrown, after the release", async () => {
  const failure = new Error("connection terminated");
  const client = fakeClient(() => Promise.reject(failure));
  await assert.rejects(rollbackAndDestroy(client, false, 1000), (error) => {
    assert.equal(error, failure);
    assert.deepEqual(client.releases, [true]);
    return true;
  });
});

test("rollbackAndDestroy: after a failing body, the body's error is kept and the ROLLBACK failure is a warning", async () => {
  const bodyError = new Error("assertion of the test body");
  const client = fakeClient(() =>
    Promise.reject(new Error("connection terminated")),
  );
  const body = async () => {
    throw bodyError;
  };
  const { warnings } = await captureWarnings(async () => {
    await assert.rejects(
      (async () => {
        let bodyFailed = true;
        try {
          await body();
          bodyFailed = false;
        } finally {
          await rollbackAndDestroy(client, bodyFailed, 1000);
        }
      })(),
      (error) => error === bodyError,
    );
  });
  assert.deepEqual(client.releases, [true]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /ROLLBACK failed after a test failure/);
  assert.match(warnings[0]!, /connection terminated/);
});

test("rollbackAndDestroy: a hung ROLLBACK does not block: the client is destroyed and the timeout reported", async () => {
  const client = fakeClient(never);
  await assert.rejects(
    rollbackAndDestroy(client, false, 30),
    /ROLLBACK did not finish within 30 ms/,
  );
  assert.deepEqual(client.releases, [true]);
});

test("rollbackAndDestroy: a synchronous throw of query is handled like a rejection", async () => {
  const failure = new Error("not queryable");
  const client = fakeClient(() => {
    throw failure;
  });
  await assert.rejects(
    rollbackAndDestroy(client, false, 1000),
    (e) => e === failure,
  );
  assert.deepEqual(client.releases, [true]);
});

// --- closeEachOnce / waitForPendingCloses ----------------------------------------

test("closeEachOnce: closes every resource once and empties the collection", async () => {
  const resources = ["a", "b", "c"];
  const calls: string[] = [];
  const pending: CloseAttempt[] = [];
  const failures = await closeEachOnce(
    resources,
    async (r) => {
      calls.push(r);
    },
    pending,
    1000,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(calls.sort(), ["a", "b", "c"]);
  assert.deepEqual(resources, []);
  assert.equal(pending.length, 0);
});

test("closeEachOnce: a resource stays in the collection until its close has settled", async () => {
  const resources = ["a", "b"];
  const seenDuringClose: string[][] = [];
  await closeEachOnce(
    resources,
    async () => {
      seenDuringClose.push(resources.slice());
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    [],
    1000,
  );
  assert.deepEqual(seenDuringClose, [
    ["a", "b"],
    ["a", "b"],
  ]);
  assert.deepEqual(resources, []);
});

test("closeEachOnce: rejections and synchronous throws are reported, the others still closed", async () => {
  const resources = ["ok", "rejects", "throws"];
  const closed: string[] = [];
  const failures = await closeEachOnce(
    resources,
    (r) => {
      if (r === "throws") throw new Error("sync failure");
      if (r === "rejects") return Promise.reject(new Error("async failure"));
      closed.push(r);
      return Promise.resolve();
    },
    [],
    1000,
  );
  assert.deepEqual(closed, ["ok"]);
  assert.deepEqual(failures, [
    "#1: Error: async failure",
    "#2: Error: sync failure",
  ]);
  assert.deepEqual(resources, []);
});

test("closeEachOnce: a close that never settles times out, is not retried, and stays pending", async () => {
  let calls = 0;
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const resources = ["slow"];
  const pending: CloseAttempt[] = [];
  const started = Date.now();
  const failures = await closeEachOnce(
    resources,
    () => {
      calls += 1;
      return slow;
    },
    pending,
    30,
  );
  assert.ok(Date.now() - started < 1000, "bounded by the timeout");
  assert.deepEqual(failures, ["#0: not closed within 30 ms"]);
  assert.deepEqual(resources, []);
  assert.equal(pending.length, 1);
  // Later recovery = waiting for the same close, never calling it again.
  finish();
  assert.deepEqual(await waitForPendingCloses(pending, 1000), []);
  assert.equal(calls, 1);
  assert.equal(pending.length, 0);
});

test("waitForPendingCloses: a close still unfinished is counted, without blocking", async () => {
  const pending: CloseAttempt[] = [startClose("#0", never)];
  assert.equal((await waitForPendingCloses(pending, 30)).length, 1);
  // Round 2 asserted 0 here: the list was emptied although the close was still
  // running, which lost track of it. It now stays tracked.
  assert.equal(pending.length, 1);
});

// --- Closes that never finish, late outcomes ---------------------------------

// Records the warnings and unhandled rejections raised while `run` executes
// and during `settleMs` afterwards.
async function observe<T>(
  run: () => Promise<T>,
  settleMs = 20,
): Promise<{ result: T; warnings: string[]; unhandled: unknown[] }> {
  const warnings: string[] = [];
  const unhandled: unknown[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("warning", onWarning);
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    return { result, warnings, unhandled };
  } finally {
    process.off("warning", onWarning);
    process.off("unhandledRejection", onUnhandled);
  }
}

test("a close that never finishes: two expired waits, both reported, bounded, never retried, still tracked", async () => {
  let calls = 0;
  const resources = ["stuck"];
  const unfinished: CloseAttempt[] = [];
  const started = Date.now();
  const first = await closeEachOnce(
    resources,
    () => {
      calls += 1;
      return never();
    },
    unfinished,
    30,
  );
  const second = await waitForPendingCloses(unfinished, 30);
  assert.ok(Date.now() - started < 1000, "both waits are bounded");
  assert.deepEqual(first, ["#0: not closed within 30 ms"]);
  assert.deepEqual(second, [
    "#0: still not closed after 2 expired waits (left running, not retried)",
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(resources, []);
  assert.equal(unfinished.length, 1);
  assert.deepEqual(unfinished[0]!.outcome, { state: "pending" });
  assert.equal(unfinished[0]!.expiredWaits, 2);
});

test("a close rejected after its first wait expired: the second wait reports it as a failure, with its cause", async () => {
  let fail!: (error: Error) => void;
  const cause = new Error("Called end on pool more than once");
  const unfinished: CloseAttempt[] = [];
  const { result, warnings, unhandled } = await observe(async () => {
    const first = await closeEachOnce(
      ["late"],
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      unfinished,
      30,
    );
    const attempt = unfinished[0]!;
    fail(cause);
    const second = await waitForPendingCloses(unfinished, 1000);
    return { first, second, attempt };
  });
  assert.deepEqual(result.first, ["#0: not closed within 30 ms"]);
  assert.deepEqual(result.second, [
    "#0: closed late with a failure: Error: Called end on pool more than once",
  ]);
  // The original error object is kept: neither a success nor a copy.
  assert.deepEqual(result.attempt.outcome, { state: "failed", error: cause });
  assert.equal((result.attempt.outcome as { error: unknown }).error, cause);
  assert.equal(unfinished.length, 0, "a settled attempt leaves the list");
  assert.deepEqual(unhandled, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /#0: close settled after 1 expired wait\(s\)/);
  assert.match(
    warnings[0]!,
    /failed, Error: Called end on pool more than once/,
  );
});

test("a close rejected after its last wait expired: no unhandled rejection, the cause is recorded and warned", async () => {
  let fail!: (error: Error) => void;
  const cause = new Error("socket hang up");
  const unfinished: CloseAttempt[] = [];
  const { warnings, unhandled } = await observe(async () => {
    await closeEachOnce(
      ["late"],
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
      unfinished,
      30,
    );
    await waitForPendingCloses(unfinished, 30);
    // Nobody waits any more: the rejection happens now.
    fail(cause);
  });
  assert.deepEqual(unhandled, []);
  assert.equal(unfinished.length, 1, "still listed: no wait saw it settle");
  assert.equal((unfinished[0]!.outcome as { error: unknown }).error, cause);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /after 2 expired wait\(s\): failed, Error: socket hang up/,
  );
});

test("a close that succeeds late is not a failure for the second wait, and is warned", async () => {
  let finish!: () => void;
  const unfinished: CloseAttempt[] = [];
  const { result, warnings } = await observe(async () => {
    await closeEachOnce(
      ["late"],
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      unfinished,
      30,
    );
    finish();
    return waitForPendingCloses(unfinished, 1000);
  });
  assert.deepEqual(result, []);
  assert.equal(unfinished.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /after 1 expired wait\(s\): closed$/);
});

// --- runCleanupSteps -----------------------------------------------------------

test("runCleanupSteps: runs every step in order and the last one, silent without failure", async () => {
  const ran: string[] = [];
  const step = (name: string): CleanupStep => [
    name,
    async () => {
      ran.push(name);
    },
  ];
  await runCleanupSteps([step("a"), step("b")], step("admin"));
  assert.deepEqual(ran, ["a", "b", "admin"]);
});

test("runCleanupSteps: a failed DROP DATABASE prevents neither the next steps nor the release of admin", async () => {
  const ran: string[] = [];
  const dropFailure = Object.assign(
    new Error('database "resonances_test_x" is being accessed by other users'),
    { code: "55006" },
  );
  await assert.rejects(
    runCleanupSteps(
      [
        ["sessions", async () => ran.push("sessions")],
        [
          "test database",
          async () => {
            ran.push("drop");
            throw dropFailure;
          },
        ],
        ["other database", async () => ran.push("drop other")],
      ],
      ["admin session", async () => ran.push("admin closed")],
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [dropFailure]);
      assert.equal(error.errors[0], dropFailure);
      assert.match(
        error.message,
        /\[test database\] Error: database .* other users/,
      );
      return true;
    },
  );
  assert.deepEqual(ran, ["sessions", "drop", "drop other", "admin closed"]);
});

test("runCleanupSteps: admin is released even when every step fails, synchronously or not", async () => {
  let adminClosed = false;
  await assert.rejects(
    runCleanupSteps(
      [
        [
          "throws synchronously",
          () => {
            throw new Error("sync");
          },
        ],
        ["rejects", () => Promise.reject(new Error("async"))],
      ],
      [
        "admin session",
        async () => {
          adminClosed = true;
        },
      ],
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((e: Error) => e.message),
        ["sync", "async"],
      );
      return true;
    },
  );
  assert.equal(adminClosed, true);
});

test("runCleanupSteps: the primary error stays first and unchanged when later steps, admin included, also fail", async () => {
  const primary = new Error("2 test pool(s) still not closed");
  const drop = new Error("DROP DATABASE failed");
  const adminFailure = new Error("cleanup of the admin session failed");
  await assert.rejects(
    runCleanupSteps(
      [
        ["closes whose wait expired", () => Promise.reject(primary)],
        ["test database", () => Promise.reject(drop)],
      ],
      ["admin session", () => Promise.reject(adminFailure)],
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], primary);
      assert.deepEqual(error.errors, [primary, drop, adminFailure]);
      assert.match(
        error.message,
        /^final cleanup failed in 3 step\(s\): \[closes whose wait expired\] Error: 2 test pool\(s\) still not closed; \[test database\] /,
      );
      return true;
    },
  );
});

test("reportCleanupFailures: silent without failure, one error listing every failure otherwise", () => {
  reportCleanupFailures("sessions", []);
  assert.throws(
    () => reportCleanupFailures("sessions", ["#0: x", "#2: y"]),
    /cleanup of sessions failed: #0: x; #2: y/,
  );
});
