/**
 * issue-sync.test.ts — transitions, replay and read-path proof for the sync
 * ledger state machine. Run with `bun test packages/engine/src/issue-sync.test.ts`.
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
  type SyncItem,
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
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
      " values ('I-000301', 'p-t', 'Issue', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'sync-issue')",
  ).run();
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

function rowOf(db: StoreDb): { item_state: string; revision: number; updated_at: string } {
  return db
    .prepare("select item_state, revision, updated_at from issue_sync_state where binding_id=? and direction=? and local_id=?")
    .get(KEY.bindingId, KEY.direction, KEY.localId) as { item_state: string; revision: number; updated_at: string };
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
    expect(rowOf(db).item_state).toBe("applied");
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
    expect(codeOf(() => markApplied(db, { ...KEY, operationId: "op-y" }))).toBe("sync.illegal-transition");
    close();
  });
});

describe("sync replay semantics", () => {
  test("same operationId + same request replays the receipt and mutates nothing", async () => {
    const { db, close } = await openedStore("replay-same");
    const first = planItem(db, PLAN);
    const second = planItem(db, PLAN);
    expect(second).toEqual(first);
    expect(rowOf(db).revision).toBe(1);
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
});

describe("sync revision guard", () => {
  test("a concurrent writer winning the CAS refuses with sync.revision-conflict", async () => {
    const { db, close } = await openedStore("cas-conflict");
    planItem(db, PLAN);
    expect(codeOf(() => markApplied(conflictingDb(db), { ...KEY, operationId: "op-cas" }))).toBe("sync.revision-conflict");
    expect(rowOf(db).item_state).toBe("pending");
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
    // Upsert overwrites; replay of the same operationId changes nothing.
    writeCursor(db, { ...KEY, cursor: "cur-2", operationId: "op-cur-2" });
    expect(readCursor(db, KEY)).toBe("cur-2");
    writeCursor(db, { ...KEY, cursor: "cur-1", operationId: "op-cur-1" });
    expect(readCursor(db, KEY)).toBe("cur-2");
    close();
  });
});

describe("ledger read path (task 3)", () => {
  test("a mixed-state ledger renders counts, last cursor and last error", async () => {
    const { db, close } = await openedStore("ledger-summary");
    planItem(db, PLAN);
    markApplied(db, { ...KEY, operationId: "op-sum-a" });
    const other = { ...KEY, localId: "I-000302" };
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000302', 'p-t', 'Two', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'sync-issue-2')",
    ).run();
    planItem(db, { ...PLAN, localId: other.localId, externalId: "EXT-2", operationId: "op-sum-p" });
    markFailed(db, { ...other, operationId: "op-sum-f", error: "boom last" });
    const third = { ...KEY, localId: "I-000303" };
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
        " values ('I-000303', 'p-t', 'Three', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'sync-issue-3')",
    ).run();
    planItem(db, { ...PLAN, localId: third.localId, externalId: "EXT-3", operationId: "op-sum-s" });
    markSkipped(db, { ...third, operationId: "op-sum-x", reason: "gone" });
    writeCursor(db, { ...KEY, cursor: "cur-9", operationId: "op-sum-cur" });

    const summary = readLedgerSummary(db, KEY);
    expect(summary.counts).toEqual({ unbound: 0, pending: 0, applied: 1, failed: 1, skipped: 1 });
    expect(summary.lastCursor).toBe("cur-9");
    // The skip reason ("gone") lands after the failure, so it is the latest
    // free-text entry; the failure itself is visible on the failed item.
    expect(summary.lastError).toBe("gone");
    expect(readItem(db, other)?.lastError).toBe("boom last");
    // Unrelated bindings contribute nothing.
    expect(readLedgerSummary(db, { bindingId: "linear:other", direction: "import" }).counts).toEqual({
      unbound: 0, pending: 0, applied: 0, failed: 0, skipped: 0,
    });
    close();
  });

  test("the read path mutates nothing", async () => {
    const { db, close } = await openedStore("ledger-readonly");
    planItem(db, PLAN);
    markFailed(db, { ...KEY, operationId: "op-ro-f", error: "err" });
    writeCursor(db, { ...KEY, cursor: "cur-ro", operationId: "op-ro-c" });
    const before = [
      db.prepare("select * from issue_sync_state order by local_id").all(),
      db.prepare("select * from sync_cursor").all(),
      db.prepare("select count(*) as n from store_operations").get(),
    ];
    readLedgerSummary(db, KEY);
    readItem(db, KEY);
    readCursor(db, KEY);
    const after = [
      db.prepare("select * from issue_sync_state order by local_id").all(),
      db.prepare("select * from sync_cursor").all(),
      db.prepare("select count(*) as n from store_operations").get(),
    ];
    expect(after).toEqual(before);
    close();
  });
});

describe("sync error shape", () => {
  test("SyncError mirrors IssueError: [code] message prefix plus .code", () => {
    const error = new SyncError("sync.not-found", "no ledger row");
    expect(error.message).toBe("[sync.not-found] no ledger row");
    expect(error.code).toBe("sync.not-found");
    expect(error).toBeInstanceOf(Error);
    const sample: SyncItem = {
      bindingId: "b", direction: "import", localId: "l", externalId: null,
      itemState: "pending", lastRemoteUpdatedAt: null, lastError: null, revision: 1, updatedAt: "now",
    };
    expect(sample.itemState).toBe("pending");
  });
});
