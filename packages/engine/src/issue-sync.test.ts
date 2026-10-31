/**
 * issue-sync.test.ts — transitions, replay, transaction atomicity and read-path
 * proof for the sync ledger state machine.
 * Run with `bun test packages/engine/src/issue-sync.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { initializeStore, type StoreContext, type StoreDb } from "./store-db.js";
import {
  markApplied,
  markFailed,
  markSkipped,
  planItem,
  readCursor,
  readItem,
  readLedgerSummary,
  SyncError,
  writeCursor,
} from "./issue-sync.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-sync-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function context(name: string): StoreContext {
  return { harnessDir: mkdtempSync(join(ROOT, name)) };
}

async function openedStore(name: string): Promise<{ db: StoreDb; close: () => void }> {
  const handle = await initializeStore(context(name));
  const db = handle.db;
  db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', 'p-t', 'T', 'projects', 'p-t/roadmap.md', 'now', 'now')",
  ).run();
  const insertIssue = db.prepare(
    "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
      " values (?, 'p-t', 'Issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', ?)",
  );
  for (const id of ["I-000301", "I-000302", "I-000303"]) insertIssue.run(id, `sync-issue-${id}`);
  return { db, close: () => handle.close() };
}

const KEY = { bindingId: "linear:p-t", direction: "import" as const, localId: "I-000301" };
const PLAN = { ...KEY, externalId: "EXT-1", remoteUpdatedAt: "2026-10-31T00:00:00Z", operationId: "op-plan-1" };

/** Run fn, return the SyncError code it throws (fail the test if it does not). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SyncError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw a SyncError");
}

/** Run fn, return the error it throws (fail the test if it does not throw). */
function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

function rowOf(db: StoreDb): { item_state: string; revision: number; updated_at: string } | undefined {
  return db
    .prepare("select item_state, revision, updated_at from issue_sync_state where binding_id=? and direction=? and local_id=?")
    .get(KEY.bindingId, KEY.direction, KEY.localId) as { item_state: string; revision: number; updated_at: string } | undefined;
}

function receiptCount(db: StoreDb): number {
  return (db.prepare("select count(*) as n from store_operations").get() as { n: number }).n;
}

/**
 * A db whose FIRST ledger row read reports a stale revision: it bumps the real
 * row after the select returns, so the mutation's `where revision = ?` misses —
 * the CAS conflict a concurrent writer produces, deterministically.
 */
function conflictingDb(db: StoreDb): StoreDb {
  let armed = true;
  const real = db;
  return {
    exec: (sql: string) => real.exec(sql),
    close: () => real.close(),
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      if (armed && sql.trim().startsWith("select") && sql.includes("issue_sync_state")) {
        return {
          get: (...args: unknown[]) => {
            const row = stmt.get(...(args as never[])) as
              | { binding_id: string; direction: string; local_id: string }
              | undefined;
            if (row) {
              armed = false;
              real.prepare("update issue_sync_state set revision = revision + 1 where binding_id=? and direction=? and local_id=?")
                .run(row.binding_id, row.direction, row.local_id);
            }
            return row;
          },
        };
      }
      return stmt;
    },
  } as unknown as StoreDb;
}

/**
 * A db whose receipt insert fails — the window a crash lands in. If the verb is
 * one transaction, the ledger mutation rolls back with it.
 */
function failingReceipts(db: StoreDb): StoreDb {
  return {
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
    prepare: (sql: string) => {
      if (sql.trim().startsWith("insert into store_operations")) {
        return {
          run: () => {
            throw new Error("simulated crash before the receipt committed");
          },
          get: () => undefined,
          all: () => [],
        };
      }
      return db.prepare(sql);
    },
  } as unknown as StoreDb;
}

/** Count the transaction statements a verb issues through this handle. */
function transactionLog(db: StoreDb): { db: StoreDb; log: string[] } {
  const log: string[] = [];
  return {
    log,
    db: {
      exec: (sql: string) => {
        const verb = sql.trim().toLowerCase();
        if (verb.startsWith("begin") || verb === "commit" || verb === "rollback") log.push(verb);
        db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
    } as unknown as StoreDb,
  };
}

describe("sync state machine transitions", () => {
  test("legal path unbound -> pending -> applied", async () => {
    const { db, close } = await openedStore("legal-applied");
    const item = planItem(db, PLAN);
    expect(item.itemState).toBe("pending");
    expect(item.externalId).toBe("EXT-1");
    expect(item.revision).toBe(1);
    const applied = markApplied(db, { ...KEY, operationId: "op-apply-1" });
    expect(applied.itemState).toBe("applied");
    // applied is terminal: a NEW planItem cycle is refused here, not mutated.
    expect(codeOf(() => planItem(db, { ...PLAN, operationId: "op-plan-again" }))).toBe("sync.illegal-transition");
    expect(rowOf(db)?.item_state).toBe("applied");
    close();
  });

  test("pending -> failed, retry from failed, failed -> skipped", async () => {
    const { db, close } = await openedStore("failed-retry");
    planItem(db, PLAN);
    const failed = markFailed(db, { ...KEY, operationId: "op-fail-1", error: "remote 500" });
    expect(failed.itemState).toBe("failed");
    expect(failed.lastError).toBe("remote 500");
    const retried = planItem(db, { ...PLAN, operationId: "op-plan-2" });
    expect(retried.itemState).toBe("pending");
    expect(retried.lastError).toBeNull();
    markFailed(db, { ...KEY, operationId: "op-fail-2", error: "again" });
    const skipped = markSkipped(db, { ...KEY, operationId: "op-skip-1", reason: "gone remote" });
    expect(skipped.itemState).toBe("skipped");
    close();
  });

  test("pending -> skipped", async () => {
    const { db, close } = await openedStore("pending-skip");
    planItem(db, PLAN);
    expect(markSkipped(db, { ...KEY, operationId: "op-skip-2", reason: "filtered" }).itemState).toBe("skipped");
    close();
  });

  test("illegal transitions and missing rows are refused with a named cause", async () => {
    const { db, close } = await openedStore("illegal");
    expect(codeOf(() => markApplied(db, { ...KEY, operationId: "op-x" }))).toBe("sync.not-found");
    expect(codeOf(() => markFailed(db, { ...KEY, operationId: "op-x", error: "e" }))).toBe("sync.not-found");
    expect(codeOf(() => markSkipped(db, { ...KEY, operationId: "op-x", reason: "r" }))).toBe("sync.not-found");
    planItem(db, PLAN);
    markApplied(db, { ...KEY, operationId: "op-ok" });
    // applied -> applied through a DIFFERENT operationId is illegal, not a replay.
    expect(codeOf(() => markApplied(db, { ...KEY, operationId: "op-other" }))).toBe("sync.illegal-transition");
    // skipped -> applied is likewise outside the contract.
    expect(codeOf(() => markSkipped(db, { ...KEY, operationId: "op-skip-x", reason: "r" }))).toBe("sync.illegal-transition");
    close();
  });

  test("a localId absent from issues is refused sync.local-issue-missing", async () => {
    const { db, close } = await openedStore("missing-local");
    const ghost = { ...PLAN, localId: "I-999999" };
    expect(codeOf(() => planItem(db, ghost))).toBe("sync.local-issue-missing");
    // Nothing was written: the refusal is total, not a half-row.
    expect(db.prepare("select count(*) as n from issue_sync_state").get()).toEqual({ n: 0 });
    expect(receiptCount(db)).toBe(0);
    close();
  });
});

describe("transaction ownership (one transaction per verb)", () => {
  test("each mutating verb opens exactly one begin and commits exactly once", async () => {
    const { db, close } = await openedStore("tx-log");
    const { db: logged, log } = transactionLog(db);
    planItem(logged, PLAN);
    expect(log).toEqual(["begin immediate", "commit"]);
    log.length = 0;
    markApplied(logged, { ...KEY, operationId: "op-tx-apply" });
    expect(log).toEqual(["begin immediate", "commit"]);
    log.length = 0;
    writeCursor(logged, { ...KEY, cursor: "cur-tx", operationId: "op-tx-cur" });
    expect(log).toEqual(["begin immediate", "commit"]);
    close();
  });

  test("a failing receipt rolls the ledger row back, so the retry is not a one-way door", async () => {
    const { db, close } = await openedStore("tx-rollback");
    expect(() => planItem(failingReceipts(db), PLAN)).toThrow(/simulated crash/);
    // The row did not advance, and no receipt exists.
    expect(rowOf(db)).toBeUndefined();
    expect(receiptCount(db)).toBe(0);
    // The retry with the SAME operationId succeeds instead of being refused.
    expect(planItem(db, PLAN).itemState).toBe("pending");
    expect(receiptCount(db)).toBe(1);

    expect(() => markApplied(failingReceipts(db), { ...KEY, operationId: "op-tx-applied" })).toThrow(/simulated crash/);
    expect(rowOf(db)?.item_state).toBe("pending");
    expect(rowOf(db)?.revision).toBe(1);
    // The same operationId now lands, because no orphan receipt blocks it.
    expect(markApplied(db, { ...KEY, operationId: "op-tx-applied" }).itemState).toBe("applied");
    expect(rowOf(db)?.item_state).toBe("applied");
    close();
  });
});

describe("sync replay semantics", () => {
  test("same operationId + same request replays the receipt and mutates nothing", async () => {
    const { db, close } = await openedStore("replay-same");
    const first = planItem(db, PLAN);
    const second = planItem(db, PLAN);
    expect(second).toEqual(first);
    expect(rowOf(db)?.revision).toBe(1);
    // Replay wins even where the transition would now be illegal, and reports
    // the ORIGINAL receipt unchanged.
    markApplied(db, { ...KEY, operationId: "op-apply-r" });
    expect(planItem(db, PLAN).itemState).toBe("pending");
    close();
  });

  test("same operationId + different request is sync.operation-conflict", async () => {
    const { db, close } = await openedStore("replay-conflict");
    planItem(db, PLAN);
    expect(codeOf(() => planItem(db, { ...PLAN, externalId: "EXT-OTHER" }))).toBe("sync.operation-conflict");
    expect(codeOf(() => markApplied(db, { ...KEY, operationId: PLAN.operationId }))).toBe("sync.operation-conflict");
    close();
  });

  test("the failure text is part of the request, not just the key", async () => {
    const { db, close } = await openedStore("replay-text");
    planItem(db, PLAN);
    markFailed(db, { ...KEY, operationId: "op-fail-text", error: "timeout" });
    expect(codeOf(() => markFailed(db, { ...KEY, operationId: "op-fail-text", error: "rate limited" }))).toBe(
      "sync.operation-conflict",
    );
    planItem(db, { ...PLAN, operationId: "op-plan-text" });
    markSkipped(db, { ...KEY, operationId: "op-skip-text", reason: "archived remotely" });
    expect(codeOf(() => markSkipped(db, { ...KEY, operationId: "op-skip-text", reason: "other reason" }))).toBe(
      "sync.operation-conflict",
    );
    close();
  });
});

describe("retry preserves recorded remote identity", () => {
  test("a retry that omits externalId / remoteUpdatedAt keeps the recorded values", async () => {
    const { db, close } = await openedStore("retry-identity");
    planItem(db, PLAN);
    markFailed(db, { ...KEY, operationId: "op-retry-fail", error: "boom" });
    const retried = planItem(db, { ...KEY, operationId: "op-retry-plan" });
    expect(retried.externalId).toBe("EXT-1");
    expect(retried.lastRemoteUpdatedAt).toBe("2026-10-31T00:00:00Z");
    expect(retried.lastError).toBeNull();
    close();
  });
});

describe("sync revision guard", () => {
  test("a concurrent writer winning the CAS refuses with sync.revision-conflict", async () => {
    const { db, close } = await openedStore("cas-conflict");
    planItem(db, PLAN);
    expect(codeOf(() => markApplied(conflictingDb(db), { ...KEY, operationId: "op-cas" }))).toBe("sync.revision-conflict");
    expect(rowOf(db)?.item_state).toBe("pending");
    close();
  });
});

describe("sync input validation", () => {
  test("blank keys, unknown direction and blank payload are sync.invalid-input", async () => {
    const { db, close } = await openedStore("invalid-input");
    expect(codeOf(() => planItem(db, { ...PLAN, bindingId: " " }))).toBe("sync.invalid-input");
    expect(codeOf(() => planItem(db, { ...PLAN, direction: "sideways" as never }))).toBe("sync.invalid-input");
    expect(codeOf(() => planItem(db, { ...PLAN, localId: "" }))).toBe("sync.invalid-input");
    expect(codeOf(() => planItem(db, { ...PLAN, operationId: " " }))).toBe("sync.invalid-input");
    expect(codeOf(() => planItem(db, { ...PLAN, externalId: " " }))).toBe("sync.invalid-input");
    expect(codeOf(() => markFailed(db, { ...KEY, operationId: "op-e", error: "" }))).toBe("sync.invalid-input");
    expect(codeOf(() => markSkipped(db, { ...KEY, operationId: "op-s", reason: "" }))).toBe("sync.invalid-input");
    expect(codeOf(() => writeCursor(db, { bindingId: "linear:p-t", direction: "import", cursor: " ", operationId: "op-c" })))
      .toBe("sync.invalid-input");
    close();
  });
});

describe("cursor and read helpers", () => {
  test("readCursor/readItem return null when absent, values when present", async () => {
    const { db, close } = await openedStore("cursor-read");
    expect(readCursor(db, KEY)).toBeNull();
    expect(readItem(db, KEY)).toBeNull();
    planItem(db, PLAN);
    expect(readItem(db, KEY)?.itemState).toBe("pending");
    writeCursor(db, { ...KEY, cursor: "cur-1", operationId: "op-cur-1" });
    expect(readCursor(db, KEY)).toBe("cur-1");
    writeCursor(db, { ...KEY, cursor: "cur-2", operationId: "op-cur-2" });
    expect(readCursor(db, KEY)).toBe("cur-2");
    // Replaying the first operationId returns its receipt without moving back.
    writeCursor(db, { ...KEY, cursor: "cur-1", operationId: "op-cur-1" });
    expect(readCursor(db, KEY)).toBe("cur-2");
    close();
  });

  test("writing the cursor already recorded is a no-op: no update, no receipt", async () => {
    const { db, close } = await openedStore("cursor-noop");
    writeCursor(db, { ...KEY, cursor: "cur-x", operationId: "op-noop-1" });
    const before = db.prepare("select cursor, updated_at from sync_cursor").all();
    const receiptsBefore = receiptCount(db);
    writeCursor(db, { ...KEY, cursor: "cur-x", operationId: "op-noop-2" });
    expect(db.prepare("select cursor, updated_at from sync_cursor").all()).toEqual(before);
    expect(receiptCount(db)).toBe(receiptsBefore);
    close();
  });
});

describe("ledger read path (task 3)", () => {
  test("a mixed-state ledger renders counts, last cursor and the last FAILURE only", async () => {
    const { db, close } = await openedStore("ledger-summary");
    const second = { ...KEY, localId: "I-000302" };
    const third = { ...KEY, localId: "I-000303" };
    planItem(db, PLAN);
    markApplied(db, { ...KEY, operationId: "op-sum-a" });
    planItem(db, { ...PLAN, localId: second.localId, externalId: "EXT-2", operationId: "op-sum-p" });
    markFailed(db, { ...second, operationId: "op-sum-f", error: "boom last" });
    planItem(db, { ...PLAN, localId: third.localId, externalId: "EXT-3", operationId: "op-sum-s" });
    markSkipped(db, { ...third, operationId: "op-sum-x", reason: "gone" });
    writeCursor(db, { ...KEY, cursor: "cur-9", operationId: "op-sum-cur" });

    const summary = readLedgerSummary(db, KEY);
    expect(summary.counts).toEqual({ unbound: 0, pending: 0, applied: 1, failed: 1, skipped: 1 });
    expect(summary.lastCursor).toBe("cur-9");
    // The skip reason is not an error: the failure is still the reported one.
    expect(summary.lastError).toBe("boom last");
    const skipped = readItem(db, third);
    expect(skipped?.lastSkipReason).toBe("gone");
    expect(skipped?.lastError).toBeNull();
    const failed = readItem(db, second);
    expect(failed?.lastError).toBe("boom last");
    expect(failed?.lastSkipReason).toBeNull();
    // Unrelated bindings contribute nothing.
    expect(readLedgerSummary(db, { bindingId: "linear:other", direction: "import" }).counts).toEqual({
      unbound: 0, pending: 0, applied: 0, failed: 0, skipped: 0,
    });
    close();
  });

  test("unbound is represented by absence, never by a row", async () => {
    const { db, close } = await openedStore("ledger-unbound");
    expect(readItem(db, KEY)).toBeNull();
    expect(readLedgerSummary(db, KEY).counts.unbound).toBe(0);
    expect(db.prepare("select count(*) as n from issue_sync_state where item_state = 'unbound'").get()).toEqual({ n: 0 });
    planItem(db, PLAN);
    expect(readLedgerSummary(db, KEY).counts).toEqual({ unbound: 0, pending: 1, applied: 0, failed: 0, skipped: 0 });
    close();
  });

  test("the read path mutates nothing", async () => {
    const { db, close } = await openedStore("ledger-readonly");
    planItem(db, PLAN);
    markFailed(db, { ...KEY, operationId: "op-ro-f", error: "err" });
    writeCursor(db, { ...KEY, cursor: "cur-ro", operationId: "op-ro-c" });
    const snapshot = () => [
      db.prepare("select * from issue_sync_state order by local_id").all(),
      db.prepare("select * from sync_cursor").all(),
      receiptCount(db),
    ];
    const before = snapshot();
    readLedgerSummary(db, KEY);
    readItem(db, KEY);
    readCursor(db, KEY);
    expect(snapshot()).toEqual(before);
    close();
  });
});

describe("sync error shape", () => {
  test("a refusal raised by a verb carries [code] prefix, .code and .name", async () => {
    const { db, close } = await openedStore("error-shape");
    const error = errorOf(() => markApplied(db, { ...KEY, operationId: "op-shape" }));
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("sync.not-found");
    expect(error.name).toBe("SyncError");
    expect(error.message.startsWith("[sync.not-found] ")).toBe(true);
    close();
  });
});
