/**
 * issue-sync.ts — the sync ledger state machine over migration 15's tables
 * (spec: sync-ledger-contract). No network, no provider dependency: P2 writes
 * `project_bindings`, P3 drives the item transitions, and nothing here mutates
 * on the read path.
 *
 * TRANSACTION OWNERSHIP: every exported mutation (`planItem`, `replanItem`,
 * `markApplied`, `markFailed`, `markSkipped`, `markUnconfirmed`, `writeCursor`)
 * owns exactly one `begin immediate` … `commit` transaction (house pattern:
 * `issue.ts` `withWrite`). The row mutation and its `store_operations` receipt
 * commit together or not at all, so an interruption cannot leave an advanced row
 * without a receipt — the one-way door this ledger exists to prevent.
 * Consequently a verb must NOT be called inside a caller-owned transaction:
 * SQLite refuses to nest, and this surface has no composed route yet. Callers
 * that need a wider unit of work call the verbs sequentially and rely on the
 * per-verb receipt for idempotency.
 */
import { createHash } from "node:crypto";
import type { StoreDb } from "./store-db.js";

export type SyncDirection = "import" | "push";
export type SyncItemState = "unbound" | "pending" | "applied" | "failed" | "skipped";

/**
 * The `sync.*` codes are this module's own; the `linear.*` entries are the
 * provider-side vocabulary the contract documents for cross-reference (§4) and
 * that the P3 adapter and ingest emit — one name per condition, no synonyms.
 */
export type SyncErrorCode =
  | "sync.not-found"
  | "sync.illegal-transition"
  | "sync.revision-conflict"
  | "sync.operation-conflict"
  | "sync.invalid-input"
  | "sync.local-issue-missing"
  | "sync.identity-conflict"
  | "sync.operator-conflict"
  | "sync.run-held"
  | "sync.run-taken"
  | "linear.query-failed"
  | "linear.identity-collision"
  | "linear.list-unimplemented"
  | "linear.host-unavailable"
  | "linear.access-denied"
  | "linear.write-refused"
  | "linear.write-ambiguous"
  | "linear.label-unresolved"
  | "linear.state-unresolved"
  | "linear.scope-insufficient";

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
  /** The open cycle's target revision, or null when no cycle is open. */
  pendingTarget: string | null;
  lastError: string | null;
  lastSkipReason: string | null;
  /** The normalized payload hash of the last confirmed push write (migration 17). */
  lastRequestHash: string | null;
  /**
   * The kind labels this tool may have written for the row: the replace rule's
   * ownership fact. More than one after an ambiguous update, because that
   * receipt proves neither that the old label was removed nor that the new one
   * was added, so both must stay removable.
   */
  lastKindLabels: string[];
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
  /** The run lease this write belongs to; see `requireRunLease`. */
  runId?: string;
};
export type MarkItemInput = {
  /**
   * The remote revision whose fields were copied just before this call. It is
   * recorded in the SAME commit as the state change, which is what makes
   * "applied" mean "applied AND captured" rather than "we saw it once".
   */
  remoteUpdatedAt?: string | null;
  /**
   * The push skip rule's fact: the normalized payload hash of the write this
   * `markApplied` CONFIRMS. Absent on import, and absent when a push recorded
   * no confirmed write - never set from intent.
   */
  requestHash?: string | null;
  /**
   * The kind label this push actually wrote, recorded as the ownership fact a
   * later kind change replaces. Absent when the payload carried no label. A
   * CONFIRMED write makes it the whole ownership; it is exactly the label the
   * remote now carries.
   */
  kindLabel?: string | null;
  /**
   * Drop the payload proof and the label ownership instead of carrying them
   * forward. Only an identity CHANGE sets this: the recorded hash proves what the
   * PREVIOUS remote issue says and the recorded labels say what it carries, so
   * neither survives a different id (`--adopt`). An omitted `requestHash` still
   * means "carry forward", so this is the only way to say "no proof".
   */
  clearProof?: true;
  /**
   * The remote identity a CONFIRMED write established (push) or a re-plan
   * learned. Absent means "keep what the row already holds" — never "clear it",
   * because an ambiguous write must not erase an id the last run proved.
   */
  externalId?: string | null;
  /**
   * The run lease this write belongs to. When present, the write is refused
   * (`sync.run-taken`) unless the store still names this run for the direction;
   * see `requireRunLease`. Absent for a caller with no lease (import).
   */
  runId?: string;
  bindingId: string; direction: SyncDirection; localId: string; operationId: string };
export type MarkFailedInput = MarkItemInput & { error: string };
export type MarkSkippedInput = MarkItemInput & { reason: string };
/**
 * An unconfirmed write: the row keeps the identity an earlier write proved and
 * loses the payload proof that write established.
 */
export type MarkUnconfirmedInput = {
  bindingId: string;
  direction: SyncDirection;
  localId: string;
  operationId: string;
  /**
   * The label the unconfirmed write may have written. It JOINS the recorded
   * ownership instead of replacing it: the receipt proves neither that the old
   * label was removed nor that the new one was added, so both stay removable.
   */
  kindLabel?: string | null;
  /** The run lease this write belongs to; see `requireRunLease`. */
  runId?: string;
};
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

/**
 * One transaction per public verb: the ledger row and the receipt that makes
 * the operation replayable are one commit, never two.
 */
function withSyncTransaction<T>(db: StoreDb, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // nothing was committed
    }
    throw error;
  }
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

/**
 * Upsert, not insert: a claim's key is stable per residue, so the retry that
 * opens the next cycle necessarily reuses it. Every other verb returns on its
 * replay before reaching here, so this only ever rewrites that one receipt.
 */
function recordOperation(db: StoreDb, operationId: string, hash: string, receipt: unknown, at: string): void {
  db.prepare(
    "insert into store_operations(operation_id, request_hash, result_json, committed_at) values (?, ?, ?, ?)" +
      " on conflict(operation_id) do update set request_hash = excluded.request_hash, result_json = excluded.result_json, committed_at = excluded.committed_at",
  ).run(
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
  /** The open cycle's target revision; null when no cycle is open. */
  pending_target: string | null;
  last_error: string | null;
  last_skip_reason: string | null;
  last_request_hash: string | null;
  last_kind_label: string | null;
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
    pendingTarget: row.pending_target,
    lastError: row.last_error,
    lastSkipReason: row.last_skip_reason,
    lastRequestHash: row.last_request_hash,
    lastKindLabels: parseKindLabels(row.last_kind_label),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/**
 * The ownership column holds the CANDIDATE labels as a JSON array, because an
 * ambiguous update proves neither that the old label was removed nor that the
 * new one was added: both may be on the remote, and a single value cannot say
 * so. One nullable `text` column expresses that set, so no schema change was
 * needed. A bare value is one candidate: this column was first written as a
 * single label, and such a row must stay readable.
 */
function parseKindLabels(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  if (!value.startsWith("[")) return [value];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SyncError("sync.invalid-input", `the ledger's label ownership ${JSON.stringify(value)} is not a label list`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new SyncError("sync.invalid-input", `the ledger's label ownership ${JSON.stringify(value)} is not a label list`);
  }
  return [...new Set(parsed as string[])];
}

/** The column form of an ownership set: empty owns nothing. */
function encodeKindLabels(labels: readonly string[]): string | null {
  const unique = [...new Set(labels)];
  return unique.length === 0 ? null : JSON.stringify(unique);
}

function requireItem(row: SyncRow | undefined): SyncRow {
  if (row === undefined) {
    throw new SyncError("sync.not-found", "no ledger row for the addressed key");
  }
  return row;
}

function refuseTransition(from: string, verb: string): never {
  throw new SyncError(
    "sync.illegal-transition",
    `transition ${verb} from '${from}' is not in the contract; re-read the item state and use a legal verb`,
  );
}

/**
 * CAS the row forward: the update only lands when the revision read a moment
 * ago still holds; a zero-changes result means a concurrent writer won.
 */
function casUpdate(
  db: StoreDb,
  key: { bindingId: string; direction: string; localId: string },
  revision: number,
  patch: {
    item_state: string;
    external_id: string | null;
    last_remote_updated_at: string | null;
    pending_target: string | null;
    last_error: string | null;
    last_skip_reason: string | null;
    last_request_hash: string | null;
    last_kind_label: string | null;
  },
  now: string,
): void {
  const result = db.prepare(
    "update issue_sync_state set item_state = ?, external_id = ?, last_remote_updated_at = ?, pending_target = ?, last_error = ?, last_skip_reason = ?," +
      " last_request_hash = ?, last_kind_label = ?," +
      " revision = revision + 1, updated_at = ? where binding_id = ? and direction = ? and local_id = ? and revision = ?",
  ).run(
    patch.item_state,
    patch.external_id,
    patch.last_remote_updated_at,
    patch.pending_target,
    patch.last_error,
    patch.last_skip_reason,
    patch.last_request_hash,
    patch.last_kind_label,
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

/** The local issue must exist before a ledger row can reference it. */
function requireLocalIssue(db: StoreDb, localId: string): void {
  const row = db.prepare("select id from issues where id = ?").get(localId) as { id: string } | undefined;
  if (row === undefined) {
    throw new SyncError(
      "sync.local-issue-missing",
      `localId '${localId}' is not an issue in this store; capture or import it before planning a sync`,
    );
  }
}

/**
 * Record intent as `pending` (unbound → pending, or failed → pending retry).
 *
 * `unbound` is a conceptual pre-state, never a row value: absence of a row IS
 * the unbound representation, so the summary counts it as 0 by construction.
 * A retry keeps any remote identity already recorded — a caller omitting
 * `externalId`/`remoteUpdatedAt` must not erase what the last attempt learned
 * — and clears the failure/skip text of the previous cycle.
 */
export function planItem(db: StoreDb, input: PlanItemInput): SyncItem {
  return writePlan(db, input, "replay").item;
}

/**
 * The SEND RIGHT for one create, not merely the intent to send one.
 *
 * `planItem` is idempotent by replay: every caller that derives the same
 * operationId receives the same receipt, so a replay cannot be told apart from
 * a resume. This verb answers the other question: `claimed` is true only for the
 * caller that actually opened the cycle. A recorded receipt answers "no" only
 * while the cycle it opened is still open — a `pending` row — and the row is
 * reported as it now stands, so a caller that did not open it sends nothing.
 *
 * Concurrency between RUNNING runs is not this verb's job: the run lease below
 * keeps a second run out of the direction, and `runId` makes a taken-over run's
 * own write refuse itself. What the claim still does is record the intent BEFORE
 * the write, so an ambiguous create leaves a durable residue that reconciliation
 * finds instead of a second create nobody can adopt.
 */
export function claimItem(db: StoreDb, input: PlanItemInput): { claimed: boolean; item: SyncItem } {
  return writePlan(db, input, "claim");
}

// ---------------------------------------------------------------------------
// The run lease: ONE push run per binding, arbitrated by this store's writes
// ---------------------------------------------------------------------------
//
// `mstar issue-sync push` is an operator command, not a concurrent service, so
// the direction is serialized instead of being made safe under concurrency.
// Every attempt to harden a per-item claim against a second run failed for one
// structural reason: the claim key can only describe a candidate (content), and
// any bypass or recovery mints a different key, so the keys could not be made to
// collide. One row per (binding, direction) can: an insert that finds a row
// means somebody already holds the direction, and no key derivation is involved.
//
// What the lease arbitrates is ACQUISITION, not the whole run, and the two
// bounds are stated here once:
// - The run token is carried into every ledger write (`requireRunLease`), so a
//   run that `--take-run` replaced has its LATER writes refused (`sync.run-taken`)
//   instead of applied. The successor is unaffected (its id is the one the row
//   holds) and a caller with no lease is unaffected (import).
// - A request the predecessor had ALREADY sent when the takeover landed cannot be
//   recalled. It may still reach the provider, which is why the reconcile-by-marker
//   scan remains the first recovery and why a takeover of a LIVE holder is unsafe:
//   `--take-run` is for a holder the operator confirmed is dead.

export type RunLease = {
  bindingId: string;
  direction: SyncDirection;
  /** This run's own token: what a release names, so a taken-over run cannot release its successor. */
  runId: string;
  holderPid: number;
  holderHost: string;
  startedAt: string;
  /** Why this run holds the direction; a takeover records itself here. */
  reason: string;
};

export type AcquireRunInput = {
  bindingId: string;
  direction: SyncDirection;
  /** The holder facts a refusal reports, so an operator can judge liveness. */
  holderPid: number;
  holderHost: string;
  /** What this run is for (`push` names the binding's push here). */
  reason: string;
  /**
   * Explicit operator intent (`--take-run`): replace the held run. Never a
   * timer — a staleness window would reproduce exactly the race this removes.
   */
  takeRun?: boolean;
};

type RunRow = {
  binding_id: string;
  direction: string;
  run_id: string;
  holder_pid: number;
  holder_host: string;
  started_at: string;
  reason: string;
};

function toLease(row: RunRow): RunLease {
  return {
    bindingId: row.binding_id,
    direction: row.direction as SyncDirection,
    runId: row.run_id,
    holderPid: row.holder_pid,
    holderHost: row.holder_host,
    startedAt: row.started_at,
    reason: row.reason,
  };
}

export function readRun(db: StoreDb, input: CursorInput): RunLease | null {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const row = db.prepare("select * from sync_runs where binding_id = ? and direction = ?").get(bindingId, direction) as
    | RunRow
    | undefined;
  return row === undefined ? null : toLease(row);
}

/**
 * Take the direction's run right, or refuse naming its holder and BOTH exits.
 *
 * The claim is one statement: `insert … on conflict do nothing` reports zero
 * changes exactly when another run holds the row, and the row it collides with
 * is read back for the refusal inside the same transaction. `takeRun` turns the
 * same statement into a replacement, so the previous holder's row is GONE
 * rather than coexisting — a leftover row would let two runs each believe they
 * hold the direction.
 *
 * A takeover proves nothing about the previous holder's liveness and cannot stop
 * a request it already sent. What it does do is make the predecessor's LATER
 * ledger writes refuse themselves against this new row (`requireRunLease`), so
 * the replacement is not two runs writing the same rows.
 */
export function acquireRun(db: StoreDb, input: AcquireRunInput): RunLease {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const holderHost = requireNonblank("holderHost", input.holderHost);
  const reason = requireNonblank("reason", input.reason);
  if (!Number.isSafeInteger(input.holderPid) || input.holderPid <= 0) {
    throw new SyncError("sync.invalid-input", "holderPid must be a positive process id");
  }
  return withSyncTransaction(db, () => {
    const now = new Date().toISOString();
    // The run token names THIS acquisition, which is what a release checks: a
    // taken-over run's `finally` then matches nothing and cannot delete its
    // successor's row.
    const runId = createHash("sha256")
      .update(`${bindingId}\u0000${direction}\u0000${input.holderPid}\u0000${holderHost}\u0000${now}`)
      .digest("hex")
      .slice(0, 32);
    const result = db
      .prepare(
        "insert into sync_runs(binding_id, direction, run_id, holder_pid, holder_host, started_at, reason) values (?, ?, ?, ?, ?, ?, ?)" +
          (input.takeRun === true
            ? " on conflict(binding_id, direction) do update set run_id = excluded.run_id, holder_pid = excluded.holder_pid," +
              " holder_host = excluded.holder_host, started_at = excluded.started_at, reason = excluded.reason"
            : " on conflict(binding_id, direction) do nothing"),
      )
      .run(bindingId, direction, runId, input.holderPid, holderHost, now, reason) as { changes: number };
    if (result.changes === 0) {
      const held = readRun(db, { bindingId, direction })!;
      throw new SyncError(
        "sync.run-held",
        `another ${direction} run holds ${bindingId}: run ${held.runId} started at ${held.startedAt} as pid ` +
          `${held.holderPid} on host ${JSON.stringify(held.holderHost)}. Nothing was written by this run. Wait for it to finish, then ` +
          `run \`mstar issue-sync push --project <project-id>\` again; or, after confirming that holder is dead, take the run over with ` +
          `\`mstar issue-sync push --project <project-id> --take-run\`.`,
      );
    }
    return readRun(db, { bindingId, direction })!;
  });
}

/**
 * Refuse a ledger write whose run no longer holds the direction.
 *
 * The lease arbitrates at ACQUISITION only. `--take-run` replaces the holder's
 * row while the predecessor may still be inside a provider call, so a write the
 * predecessor makes afterwards would land on a row its successor now owns. A
 * write that names its run therefore re-reads the row inside the SAME
 * transaction, which turns a taken-over run's late write into a refusal instead
 * of an apply. A caller that names no run (import) is unaffected, and the
 * successor needs no exemption: its own id is the one the row holds.
 *
 * Liveness-independent by construction: it never asks whether a holder is alive,
 * only whether this write's run is still the run the store names.
 *
 * Called by both sides of a provider call: once before the request leaves (so a
 * run already replaced sends nothing) and once more inside each ledger write (so
 * a takeover that lands while the request is in flight cannot be recorded as
 * this run's apply).
 */
export function requireRunLease(db: StoreDb, input: { bindingId: string; direction: string; runId: string | undefined }): void {
  if (input.runId === undefined) return;
  const row = db.prepare("select run_id from sync_runs where binding_id = ? and direction = ?").get(input.bindingId, input.direction) as
    | { run_id: string }
    | undefined;
  if (row?.run_id === input.runId) return;
  throw new SyncError(
    "sync.run-taken",
    `run ${input.runId} no longer holds ${input.direction} of ${input.bindingId}` +
      (row === undefined ? ": its run row is gone" : `: ${row.run_id} holds it now`) +
      "; this write is refused instead of applied, because a taken-over run never writes",
  );
}

/**
 * Release the direction IF this run still holds it. Naming the `runId` is what
 * keeps a taken-over run's `finally` from deleting its successor's row: the
 * delete simply matches nothing.
 */
export function releaseRun(db: StoreDb, input: CursorInput & { runId: string }): boolean {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const runId = requireNonblank("runId", input.runId);
  return withSyncTransaction(db, () => {
    const result = db
      .prepare("delete from sync_runs where binding_id = ? and direction = ? and run_id = ?")
      .run(bindingId, direction, runId) as { changes: number };
    return result.changes > 0;
  });
}

function writePlan(
  db: StoreDb,
  input: PlanItemInput,
  mode: "replay" | "claim",
): { claimed: boolean; item: SyncItem } {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const externalId = input.externalId == null ? null : requireNonblank("externalId", input.externalId);
  const remoteUpdatedAt = input.remoteUpdatedAt == null ? null : requireNonblank("remoteUpdatedAt", input.remoteUpdatedAt);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("planItem", { bindingId, direction, localId, externalId, remoteUpdatedAt });
  return withSyncTransaction(db, () => {
    requireRunLease(db, { bindingId, direction, runId: input.runId });
    const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
    if (replayed !== undefined) {
      // A replay answers "what did that call do", so it reports its receipt. A
      // claim answers "may I send", so a receipt already on record means
      // somebody else did — the CURRENT row is what that caller must act on.
      if (mode === "replay") return { claimed: false, item: replayed };
      const current = selectRow(db, bindingId, direction, localId);
      // The claim key is stable per residue, not per attempt, so a recorded claim
      // outlives the cycle that recorded it. It is an answer only while that
      // cycle is still open: a `failed` row means the attempt ended (a refused
      // write, a pre-send refusal), and the retry opens a new cycle under the
      // SAME key. Only a `pending` row holds the send right.
      if (current !== undefined && current.item_state === "pending") return { claimed: false, item: toItem(current) };
    }
    requireLocalIssue(db, localId);
    const now = new Date().toISOString();
    const row = selectRow(db, bindingId, direction, localId);
    if (row === undefined) {
      db.prepare(
        "insert into issue_sync_state(binding_id, direction, local_id, external_id, item_state, last_remote_updated_at, pending_target, last_error, last_skip_reason, revision, updated_at)" +
          // A brand-new row has copied nothing, so `last_remote_updated_at`
          // starts null and the revision it was opened for sits in the target.
          " values (?, ?, ?, ?, 'pending', null, ?, null, null, 1, ?)",
      ).run(bindingId, direction, localId, externalId, remoteUpdatedAt, now);
    } else if (row.item_state === "failed" || row.item_state === "unbound") {
      casUpdate(db, { bindingId, direction, localId }, row.revision, {
        item_state: "pending",
        external_id: externalId ?? row.external_id,
        // Opening a cycle records its TARGET only. The copied watermark stays
        // where it is until an apply actually writes those fields, so a crash
        // cannot leave a row claiming content it never took.
        last_remote_updated_at: row.last_remote_updated_at,
        pending_target: remoteUpdatedAt ?? row.pending_target,
        last_error: null,
        last_skip_reason: null,
        // Opening a cycle changes no confirmed fact: both push columns carry
        // forward, so a retry never forgets the hash or the ownership it holds.
        last_request_hash: row.last_request_hash,
        last_kind_label: row.last_kind_label,
      }, now);
    } else {
      refuseTransition(row.item_state, "planItem");
    }
    const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
    recordOperation(db, operationId, hash, item, now);
    return { claimed: true, item };
  });
}

/**
 * The ONE freshness rule (contract §2): a remote revision is "newer" only when
 * its INSTANT is later than the recorded one. ISO-8601 strings are not ordered
 * lexicographically — `…T00:00:00.500Z` sorts below `…T00:00:00Z` — so a string
 * comparison silently skips genuine changes. An unparseable instant is refused
 * rather than guessed.
 */
/**
 * The strict complement of `isNewerInstant`, used where EQUALITY must mirror
 * rather than skip: a `pending` row can be the residue of an interrupted write,
 * so an unchanged timestamp still has to be copied. Only a genuinely older
 * revision is stale.
 */
export function isOlderInstant(candidate: string, recorded: string | null): boolean {
  const next = Date.parse(candidate);
  if (Number.isNaN(next)) {
    throw new SyncError("sync.invalid-input", `remoteUpdatedAt ${JSON.stringify(candidate)} is not an ISO-8601 instant`);
  }
  if (recorded === null) return false;
  const prior = Date.parse(recorded);
  return Number.isNaN(prior) ? false : next < prior;
}

export function isNewerInstant(candidate: string, recorded: string | null): boolean {
  const next = Date.parse(candidate);
  if (Number.isNaN(next)) {
    throw new SyncError("sync.invalid-input", `remoteUpdatedAt ${JSON.stringify(candidate)} is not an ISO-8601 instant`);
  }
  if (recorded === null) return true;
  const prior = Date.parse(recorded);
  return Number.isNaN(prior) ? true : next > prior;
}

/**
 * Re-plan an already-`applied` item whose remote revision moved on (§2, added
 * for M0): the ONLY legal source state, everything else refuses
 * `sync.illegal-transition`. The new watermark is the remote revision this
 * re-plan is for, and the recorded `external_id` / `last_remote_updated_at`
 * survive an omission exactly as they do on `planItem`'s retry.
 *
 * The transition is `applied → pending`; the caller still owes the `markApplied`
 * of the cycle it opened, so a crash between the two leaves a `pending` row the
 * next run resumes instead of a silent overwrite. Same transaction ownership and
 * replay rules as every other mutation here.
 */
export function replanItem(db: StoreDb, input: PlanItemInput): SyncItem {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const externalId = input.externalId == null ? null : requireNonblank("externalId", input.externalId);
  const remoteUpdatedAt = input.remoteUpdatedAt == null ? null : requireNonblank("remoteUpdatedAt", input.remoteUpdatedAt);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("replanItem", { bindingId, direction, localId, externalId, remoteUpdatedAt });
  return withSyncTransaction(db, () => {
    requireRunLease(db, { bindingId, direction, runId: input.runId });
    const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
    if (replayed !== undefined) return replayed;
    const now = new Date().toISOString();
    const row = requireItem(selectRow(db, bindingId, direction, localId));
    if (row.item_state !== "applied") refuseTransition(row.item_state, "replanItem");
    // The other half of the contract: a re-plan is for a NEWER remote revision.
    // An equal or older one would rewind the watermark, so it is refused as an
    // out-of-contract call rather than accepted as a no-op.
    const next = remoteUpdatedAt ?? row.last_remote_updated_at;
    if (next !== null && row.last_remote_updated_at !== null && !isNewerInstant(next, row.last_remote_updated_at)) {
      throw new SyncError(
        "sync.illegal-transition",
        `replanItem requires a newer remote revision: received ${JSON.stringify(next)}, recorded ${JSON.stringify(row.last_remote_updated_at)}`,
      );
    }
    casUpdate(db, { bindingId, direction, localId }, row.revision, {
      item_state: "pending",
      external_id: externalId ?? row.external_id,
      // The cycle TARGET, in its own column: the stale guard compares a
      // replayed page against it, while `last_remote_updated_at` keeps meaning
      // "what was actually copied".
      last_remote_updated_at: row.last_remote_updated_at,
      pending_target: remoteUpdatedAt ?? row.pending_target,
      last_error: null,
      last_skip_reason: null,
      last_request_hash: row.last_request_hash,
      last_kind_label: row.last_kind_label,
    }, now);
    const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
    recordOperation(db, operationId, hash, item, now);
    return item;
  });
}

export function markApplied(db: StoreDb, input: MarkItemInput): SyncItem {
  return markItem(db, input, "applied", undefined);
}

export function markFailed(db: StoreDb, input: MarkFailedInput): SyncItem {
  return markItem(db, input, "failed", requireNonblank("error", input.error));
}

/**
 * Record a refusal that PROVABLY SENT NOTHING without moving the row's state.
 *
 * `markFailed` is the retry edge, and it is right for a row that owns no
 * ambiguity: a refused write was never delivered, so the next run may retry.
 * It is wrong for a `pending` row with no id, because that row IS an
 * unattributed remote issue — `reconcilePendingCreate` scans exactly that
 * shape. Downgrading it to `failed` would hide it from reconciliation, let the
 * next run create a second remote issue, and leave the first one permanently
 * unadoptable once its marker matches twice.
 *
 * So this verb writes the error text and nothing else: state, identity,
 * watermark, cycle target, payload proof and label ownership all survive.
 */
export function recordRefusal(db: StoreDb, input: MarkFailedInput): SyncItem {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const operationId = requireNonblank("operationId", input.operationId);
  const error = requireNonblank("error", input.error);
  const hash = syncRequestHash("recordRefusal", { bindingId, direction, localId, error });
  return withSyncTransaction(db, () => {
    requireRunLease(db, { bindingId, direction, runId: input.runId });
    const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
    if (replayed !== undefined) return replayed;
    const now = new Date().toISOString();
    const row = requireItem(selectRow(db, bindingId, direction, localId));
    casUpdate(db, { bindingId, direction, localId }, row.revision, {
      item_state: row.item_state,
      external_id: row.external_id,
      last_remote_updated_at: row.last_remote_updated_at,
      pending_target: row.pending_target,
      last_error: error,
      last_skip_reason: row.last_skip_reason,
      last_request_hash: row.last_request_hash,
      last_kind_label: row.last_kind_label,
    }, now);
    const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
    recordOperation(db, operationId, hash, item, now);
    return item;
  });
}

/**
 * The skip reason is its OWN column: a skip is a deliberate decision, not a
 * failure, so it must not surface as the ledger's last error.
 */
export function markSkipped(db: StoreDb, input: MarkSkippedInput): SyncItem {
  return markItem(db, input, "skipped", requireNonblank("reason", input.reason));
}

/**
 * Record a write that was SENT and never confirmed, on the row whose identity an
 * earlier confirmed write proved.
 *
 * The state is preserved — `applied` and `failed` both carry the external
 * identity and watermark an earlier confirmed write established — but the
 * payload hash goes: it no longer proves the remote equals that payload, because
 * the unconfirmed write may have changed it. With no hash the skip rule cannot
 * match, so the next pass converges the desired fields instead of reporting a
 * `skipped` the receipt never earned.
 *
 * The label the unconfirmed write may have written JOINS the recorded
 * ownership rather than replacing it: the receipt proves neither that the old
 * label was removed nor that the new one was added, so the corrective update
 * must remove whichever of them is actually on the remote (removing an absent
 * label is a no-op). Refused for a `pending` row: an ambiguous CREATE has no
 * identity and is its own residue, which reconciliation (or an explicit
 * adoption) owns.
 */
export function markUnconfirmed(db: StoreDb, input: MarkUnconfirmedInput): SyncItem {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const localId = requireNonblank("localId", input.localId);
  const operationId = requireNonblank("operationId", input.operationId);
  const kindLabel = input.kindLabel == null ? null : requireNonblank("kindLabel", input.kindLabel);
  const hash = syncRequestHash("markUnconfirmed", { bindingId, direction, localId, kindLabel });
  return withSyncTransaction(db, () => {
    requireRunLease(db, { bindingId, direction, runId: input.runId });
    const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
    if (replayed !== undefined) return replayed;
    const now = new Date().toISOString();
    const row = requireItem(selectRow(db, bindingId, direction, localId));
    // The discriminating fact is IDENTITY, not state: an update always addresses a
    // row an earlier confirmed write gave an id. `pending` without one is the
    // ambiguous CREATE residue, which reconciliation (or an explicit adoption)
    // owns; it has no payload proof to invalidate, so this verb refuses it.
    if (row.external_id === null) refuseTransition(row.item_state, "markUnconfirmed");
    casUpdate(db, { bindingId, direction, localId }, row.revision, {
      item_state: row.item_state,
      external_id: row.external_id,
      last_remote_updated_at: row.last_remote_updated_at,
      pending_target: row.pending_target,
      last_error: row.last_error,
      last_skip_reason: row.last_skip_reason,
      last_request_hash: null,
      last_kind_label: encodeKindLabels([...parseKindLabels(row.last_kind_label), ...(kindLabel === null ? [] : [kindLabel])]),
    }, now);
    const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
    recordOperation(db, operationId, hash, item, now);
    return item;
  });
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
  // Everything that changes what this call MEANS belongs in the hash: the same
  // operationId with a different error/reason, or with a different timestamp to
  // record, is a conflicting request — not a replay of the first one. The push
  // facts join only when the caller supplies them, so an import receipt written
  // by an earlier build still replays instead of conflicting.
  const hash = syncRequestHash(target, {
    bindingId,
    direction,
    localId,
    text,
    remoteUpdatedAt: input.remoteUpdatedAt ?? null,
    ...(input.externalId == null ? {} : { externalId: input.externalId }),
    ...(input.requestHash == null ? {} : { requestHash: input.requestHash }),
    ...(input.kindLabel == null ? {} : { kindLabel: input.kindLabel }),
    ...(input.clearProof === true ? { clearProof: true } : {}),
  });
  return withSyncTransaction(db, () => {
    requireRunLease(db, { bindingId, direction, runId: input.runId });
    const replayed = replayOrRefuse<SyncItem>(db, operationId, hash);
    if (replayed !== undefined) return replayed;
    const now = new Date().toISOString();
    const row = requireItem(selectRow(db, bindingId, direction, localId));
    // Push has no intermediate observable state: a confirmed update is applied
    // OVER applied, and the write itself is not resumable through the ledger
    // (the payload hash decides the next run). Import keeps its strict edges.
    const pushReapply = target === "applied" && row.item_state === "applied" && direction === "push";
    if (row.item_state !== "pending" && !pushReapply && !(target === "skipped" && row.item_state === "failed")) {
      refuseTransition(row.item_state, `markItem -> ${target}`);
    }
    // Only a successful apply has copied fields, so only it may advance the
    // copied watermark; a failure or a stale skip leaves the cycle open and the
    // watermark where it was. The caller's own revision wins over the planned
    // target: a resumed cycle can copy a NEWER revision than it planned for, and
    // recording the older one would let a page between the two overwrite it.
    const applied = target === "applied";
    const proposed = input.remoteUpdatedAt ?? row.pending_target ?? null;
    // A replayed page can be applied precisely BECAUSE it is not the oldest
    // candidate: recording a revision older than the one already copied would
    // make that page look fresh again on the next run. The watermark never
    // moves backwards.
    const copiedTarget =
      proposed !== null && isOlderInstant(proposed, row.last_remote_updated_at) ? row.last_remote_updated_at : proposed;
    casUpdate(db, { bindingId, direction, localId }, row.revision, {
      item_state: target,
      // A CONFIRMED identity from the caller is the only way a push records
      // `external_id`; an omission keeps what the row holds, so an ambiguous
      // write can never erase an identity a previous run proved.
      external_id: applied ? (input.externalId ?? row.external_id) : row.external_id,
      last_remote_updated_at: applied ? (copiedTarget ?? row.last_remote_updated_at) : row.last_remote_updated_at,
      pending_target: applied ? null : row.pending_target,
      last_error: target === "failed" ? (text ?? null) : null,
      last_skip_reason: target === "skipped" ? (text ?? null) : null,
      // The skip-rule hash and the label ownership follow the SAME rule: a
      // confirmed apply updates them, anything else carries them forward. A
      // confirmed update carries exactly the label it wrote, so ownership
      // narrows to that one label; the removal it sent already took the rest.
      // `clearProof` is the identity-CHANGE case: both facts described the
      // previous remote issue, so neither may survive the new id.
      last_request_hash: applied ? (input.clearProof === true ? null : (input.requestHash ?? row.last_request_hash)) : row.last_request_hash,
      last_kind_label: applied
        ? input.clearProof === true
          ? null
          : input.kindLabel == null
            ? row.last_kind_label
            : encodeKindLabels([input.kindLabel])
        : row.last_kind_label,
    }, now);
    const item = toItem(requireItem(selectRow(db, bindingId, direction, localId)));
    recordOperation(db, operationId, hash, item, now);
    return item;
  });
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

/**
 * Advance the resumable position. Writing the cursor already recorded is a
 * NO-OP — no row update, no receipt, unchanged `updated_at` — so a re-run over
 * an unchanged page reports zero written rows. (A no-op records no receipt, so
 * replaying its operationId is likewise a no-op rather than a conflict.)
 */
export function writeCursor(db: StoreDb, input: WriteCursorInput): void {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const cursor = requireNonblank("cursor", input.cursor);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("writeCursor", { bindingId, direction, cursor });
  withSyncTransaction(db, () => {
    if (replayOrRefuse<unknown>(db, operationId, hash) !== undefined) return;
    if (readCursor(db, { bindingId, direction }) === cursor) return;
    const now = new Date().toISOString();
    db.prepare(
      "insert into sync_cursor(binding_id, direction, cursor, updated_at) values (?, ?, ?, ?)" +
        " on conflict(binding_id, direction) do update set cursor = excluded.cursor, updated_at = excluded.updated_at",
    ).run(bindingId, direction, cursor, now);
    recordOperation(db, operationId, hash, { cursor }, now);
  });
}

/**
 * Clear the resumable cursor for a binding+direction.
 *
 * Only a COMPLETED scan may rewind. The cursor is a page pointer, not a
 * watermark, so leaving it on the last page means every earlier page is never
 * requested again and an item edited there stays invisible forever. A scan that
 * STOPPED (a stranded item, the page bound, a thrown page) must keep its
 * pointer: rewinding there would re-request the same failing page from the top
 * on every run and lose the position that made progress possible.
 */
export function resetCursor(db: StoreDb, input: CursorInput & { operationId: string }): void {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const operationId = requireNonblank("operationId", input.operationId);
  const hash = syncRequestHash("resetCursor", { bindingId, direction });
  withSyncTransaction(db, () => {
    if (replayOrRefuse<unknown>(db, operationId, hash) !== undefined) return;
    const now = new Date().toISOString();
    db.prepare("delete from sync_cursor where binding_id = ? and direction = ?").run(bindingId, direction);
    recordOperation(db, operationId, hash, { cursor: null }, now);
  });
}

export type LedgerSummary = {
  counts: Record<SyncItemState, number>;
  lastCursor: string | null;
  lastError: string | null;
};

/**
 * Read-only observability for the CLI/dashboard: per-binding counts by item
 * state, the resumable cursor and the most recent FAILURE. A skip reason is
 * not an error and is reported on the item (`SyncItem.lastSkipReason`), not
 * here. No write statement exists on this path.
 */
export function readLedgerSummary(db: StoreDb, input: CursorInput): LedgerSummary {
  const bindingId = requireNonblank("bindingId", input.bindingId);
  const direction = requireDirection(input.direction);
  const counts: Record<SyncItemState, number> = { unbound: 0, pending: 0, applied: 0, failed: 0, skipped: 0 };
  for (const row of db
    .prepare("select item_state, count(*) as n from issue_sync_state where binding_id = ? and direction = ? group by item_state")
    .all(bindingId, direction) as Array<{ item_state: string; n: number }>) {
    if (Object.hasOwn(counts, row.item_state)) counts[row.item_state as SyncItemState] = row.n;
  }
  const lastCursorRow = db.prepare("select cursor from sync_cursor where binding_id = ? and direction = ?").get(bindingId, direction) as
    | { cursor: string }
    | undefined;
  const lastErrorRow = db
    .prepare(
      "select last_error from issue_sync_state where binding_id = ? and direction = ? and last_error is not null" +
        " order by updated_at desc, revision desc limit 1",
    )
    .get(bindingId, direction) as { last_error: string } | undefined;
  return {
    counts,
    lastCursor: lastCursorRow === undefined ? null : lastCursorRow.cursor,
    lastError: lastErrorRow === undefined ? null : lastErrorRow.last_error,
  };
}
