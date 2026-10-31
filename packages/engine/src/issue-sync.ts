/**
 * issue-sync.ts — the sync ledger state machine over migration 15's tables
 * (spec: sync-ledger-contract). Every mutation is revision-guarded and
 * replayable by operationId through the existing `store_operations` ledger.
 * No network, no provider dependency: P2 writes `project_bindings`, P3 drives
 * the item transitions, and nothing here mutates on the read path.
 */
import { createHash } from "node:crypto";
import type { StoreDb } from "./store-db.js";

export type SyncDirection = "import" | "push";
export type SyncItemState = "unbound" | "pending" | "applied" | "failed" | "skipped";

export type SyncErrorCode =
  | "sync.not-found"
  | "sync.illegal-transition"
  | "sync.revision-conflict"
  | "sync.operation-conflict"
  | "sync.invalid-input";

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SyncError";
    this.code = code;
  }
}

export type SyncItem = {
  bindingId: string;
  direction: SyncDirection;
  localId: string;
  externalId: string | null;
  itemState: SyncItemState;
  lastRemoteUpdatedAt: string | null;
  lastError: string | null;
  revision: number;
  updatedAt: string;
};

export type PlanItemInput = {
  bindingId: string;
  direction: SyncDirection;
  localId: string;
  externalId?: string | null;
  remoteUpdatedAt?: string | null;
  operationId: string;
};
export type MarkItemInput = { bindingId: string; direction: SyncDirection; localId: string; operationId: string };
export type MarkFailedInput = MarkItemInput & { error: string };
export type MarkSkippedInput = MarkItemInput & { reason: string };
export type ReadItemInput = { bindingId: string; direction: SyncDirection; localId: string };
export type CursorInput = { bindingId: string; direction: SyncDirection };
export type WriteCursorInput = CursorInput & { cursor: string; operationId: string };

const DIRECTIONS: Record<SyncDirection, true> = { import: true, push: true };

function requireNonblank(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncError("sync.invalid-input", `${name} must be a non-empty string`);
  }
  return value;
}

function requireDirection(value: unknown): SyncDirection {
  if (typeof value !== "string" || !Object.hasOwn(DIRECTIONS, value)) {
    throw new SyncError("sync.invalid-input", "direction must be 'import' or 'push'");
  }
  return value as SyncDirection;
}

/** Stable hash over the operation kind and its normalized request payload. */
function syncRequestHash(kind: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([kind, payload])).digest("hex");
}

function replayOrRefuse<T>(db: StoreDb, operationId: string, hash: string): T | undefined {
  const existing = db.prepare("select request_hash, result_json from store_operations where operation_id = ?").get(operationId) as
    | { request_hash: string; result_json: string }
    | undefined;
  if (existing === undefined) return undefined;
  if (existing.request_hash !== hash) {
    throw new SyncError(
      "sync.operation-conflict",
      "The same operationId was reused with a different request; the original receipt is retained.",
    );
  }
  return JSON.parse(existing.result_json) as T;
}

function recordOperation(db: StoreDb, operationId: string, hash: string, receipt: unknown, at: string): void {
  db.prepare("insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)").run(
    operationId,
    hash,
    JSON.stringify(receipt),
    at,
  );
}

type SyncRow = {
  binding_id: string;
  direction: string;
  local_id: string;
  external_id: string | null;
  item_state: string;
  last_remote_updated_at: string | null;
  last_error: string | null;
  revision: number;
  updated_at: string;
};

function selectRow(db: StoreDb, bindingId: string, direction: string, localId: string): SyncRow | undefined {
  return db
    .prepare("select * from issue_sync_state where binding_id = ? and direction = ? and local_id = ?")
    .get(bindingId, direction, localId) as SyncRow | undefined;
}

function toItem(row: SyncRow): SyncItem {
  return {
    bindingId: row.binding_id,
    direction: row.direction as SyncDirection,
    localId: row.local_id,
    externalId: row.external_id,
    itemState: row.item_state as SyncItemState,
    lastRemoteUpdatedAt: row.last_remote_updated_at,
    lastError: row.last_error,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function requireItem(row: SyncRow | undefined): SyncRow {
  if (row === undefined) {
    throw new SyncError("sync.not-found", "no ledger row for the addressed key");
  }
  return row;
}

function refuseTransition(from: string, verb: string): never {
  throw new SyncError("sync.illegal-transition", `transition ${verb} from '${from}' is not in the contract`);
}

/**
 * CAS the row forward: the update only lands when the revision read a moment
 * ago still holds; a zero-changes result means a concurrent writer won (or the
 * row vanished, which cannot happen here — no delete verb exists).
 */
function casUpdate(
  db: StoreDb,
  key: { bindingId: string; direction: string; localId: string },
  revision: number,
  patch: { item_state: string; external_id?: string | null; last_remote_updated_at?: string | null; last_error?: string | null },
  now: string,
): void {
  const result = db.prepare(
    "update issue_sync_state set item_state = ?, external_id = ?, last_remote_updated_at = ?, last_error = ?, revision = revision + 1, updated_at = ?" +
      " where binding_id = ? and direction = ? and local_id = ? and revision = ?",
  ).run(
    patch.item_state,
    patch.external_id ?? null,
    patch.last_remote_updated_at ?? null,
    patch.last_error ?? null,
    now,
    key.bindingId,
    key.direction,
    key.localId,
    revision,
  ) as { changes: number };
  if (result.changes === 0) {
    throw new SyncError("sync.revision-conflict", "a concurrent writer advanced the ledger row; re-read and retry");
  }
}

/**
 * Record intent as `pending` (unbound → pending, or failed → pending retry).
 * `last_error` is cleared: a fresh cycle must not inherit the previous one's
 * failure text.
 */
export function planItem(db: StoreDb, input: PlanItemInput): SyncItem {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const externalId = input.externalId == null ? null : requireNonblank("externalId", input.externalId);
  const remoteUpdatedAt = input.remoteUpdatedAt == null ? null : requireNonblank("remoteUpdatedAt", input.remoteUpdatedAt);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("planItem", { bindingId, direction, localId, externalId, remoteUpdatedAt });
  const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
  if (replayed !== undefined) return replayed;
  const now = new Date().toISOString();
  const row = selectRow(db, bindingId, direction, localId);
  if (row === undefined || row.item_state === "unbound" || row.item_state === "failed") {
    if (row === undefined) {
      db.prepare(
        "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, last_remote_updated_at, last_error, revision, updated_at)" +
          " values (?, ?, ?, ?, 'pending', ?, null, 1, ?)",
      ).run(bindingId, direction, localId, externalId, remoteUpdatedAt, now);
    } else {
      casUpdate(db, { bindingId, direction, localId }, row.revision, {
        item_state: "pending", external_id: externalId, last_remote_updated_at: remoteUpdatedAt, last_error: null,
      }, now);
    }
  } else {
    refuseTransition(row.item_state, "planItem");
  }
  const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
  recordOperation(db, operationId, hash, item, now);
  return item;
}

export function markApplied(db: StoreDb, input: MarkItemInput): SyncItem {
  return markItem(db, input, "applied", undefined);
}

export function markFailed(db: StoreDb, input: MarkFailedInput): SyncItem {
  return markItem(db, input, "failed", requireNonblank("error", input.error));
}

/**
 * Skipped carries its reason in `last_error`, the table's only free-text
 * column — it records why the item was left, not a failure of the item.
 */
export function markSkipped(db: StoreDb, input: MarkSkippedInput): SyncItem {
  return markItem(db, input, "skipped", requireNonblank("reason", input.reason));
}

function markItem(
  db: StoreDb,
  input: MarkItemInput,
  target: "applied" | "failed" | "skipped",
  text: string | undefined,
): SyncItem {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash(target, { bindingId, direction, localId });
  const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
  if (replayed !== undefined) return replayed;
  const now = new Date().toISOString();
  const row = requireItem(selectRow(db, bindingId, direction, localId));
  if (row.item_state !== "pending" && !(target === "skipped" && row.item_state === "failed")) {
    refuseTransition(row.item_state, `markItem -> ${target}`);
  }
  casUpdate(db, { bindingId, direction, localId }, row.revision, {
    item_state: target,
    external_id: row.external_id,
    last_remote_updated_at: row.last_remote_updated_at,
    last_error: text ?? null,
  }, now);
  const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
  recordOperation(db, operationId, hash, item, now);
  return item;
}

export function readItem(db: StoreDb, input: ReadItemInput): SyncItem | null {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const row = selectRow(db, bindingId, direction, localId);
  return row === undefined ? null : toItem(row);
}

export function readCursor(db: StoreDb, input: CursorInput): string | null {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const row = db.prepare("select cursor from sync_cursor where binding_id = ? and direction = ?").get(bindingId, direction) as
    | { cursor: string }
    | undefined;
  return row === undefined ? null : row.cursor;
}

export function writeCursor(db: StoreDb, input: WriteCursorInput): void {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const cursor = requireNonblank("cursor", input.cursor);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("writeCursor", { bindingId, direction, cursor });
  if (replayOrRefuse<unknown>(db, operationId, hash) !== undefined) return;
  const now = new Date().toISOString();
  db.prepare(
    "insert into sync_cursor(binding_id, direction, cursor, updated_at) values (?, ?, ?, ?)" +
      " on conflict(binding_id, direction) do update set cursor = excluded.cursor, updated_at = excluded.updated_at",
  ).run(bindingId, direction, cursor, now);
  recordOperation(db, operationId, hash, { cursor }, now);
}

export type LedgerSummary = {
  counts: Record<SyncItemState, number>;
  lastCursor: string | null;
  lastError: string | null;
};

/**
 * Read-only observability for the CLI/dashboard: per-binding counts by item
 * state, the resumable cursor and the most recent error. No write statement
 * exists on this path.
 */
export function readLedgerSummary(db: StoreDb, input: CursorInput): LedgerSummary {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const counts: Record<SyncItemState, number> = { unbound: 0, pending: 0, applied: 0, failed: 0, skipped: 0 };
  for (const row of db
    .prepare("select item_state, count(*) as n from issue_sync_state where binding_id = ? group by item_state")
    .all(bindingId) as Array<{ item_state: string; n: number }>) {
    if (Object.hasOwn(counts, row.item_state)) counts[row.item_state as SyncItemState] = row.n;
  }
  const lastCursorRow = db.prepare("select cursor from sync_cursor where binding_id = ?").get(bindingId) as
    | { cursor: string }
    | undefined;
  const lastErrorRow = db
    .prepare("select last_error from issue_sync_state where binding_id = ? and last_error is not null order by updated_at desc, revision desc limit 1")
    .get(bindingId) as { last_error: string } | undefined;
  return { counts, lastCursor: lastCursorRow === undefined ? null : lastCursorRow.cursor, lastError: lastErrorRow === undefined ? null : lastErrorRow.last_error };
}
