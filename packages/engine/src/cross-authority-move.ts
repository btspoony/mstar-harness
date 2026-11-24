/**
 * invariant: cross-authority-move.ts -- the per-record move ledger of one collaboration lane.
 *
 * A move between two authorities is not one transaction: the source lane commits its verdict
 * first and the destination step follows from it, so the source row is both the ledger and the
 * fence. This module owns that row: its closed phase vocabulary, the forward-only transitions
 * between those phases, and the read every source write uses to learn that its record is frozen.
 *
 * The block itself is NOT here: it is enforced by the lane's triggers (collaboration-store.ts
 * v4), so no calling path can write a frozen record by forgetting to ask. This module states the
 * same rule for the caller that has to explain the refusal, and `apply`-side orchestration arrives
 * with the phase engine.
 */
import { StoreError, nowRfc3339, type StoreDb } from "./store-db.js";

/** note: One row's role: the source holds the ledger, the destination holds the staged copy. */
export type IssueMoveRole = "source" | "destination";

export type IssueMovePhase = "staged" | "verified" | "switched" | "published" | "discarded";

/** note: The phases in which the source record is frozen. The lane's triggers carry this set. */
export const BLOCKING_MOVE_PHASES: readonly IssueMovePhase[] = ["staged", "verified", "switched"];

/**
 * invariant: The forward transition set. A move never goes back: `staged -> verified -> switched
 * -> published` is the progress path, and `staged | verified -> discarded` is the only branch,
 * available only before the destination is a member. `published` and `discarded` are terminal.
 */
const MOVE_TRANSITIONS: Readonly<Record<IssueMovePhase, readonly IssueMovePhase[]>> = {
  staged: ["verified", "discarded"],
  verified: ["switched", "discarded"],
  switched: ["published"],
  published: [],
  discarded: [],
};

/** note: The one frozen copy the destination row carries until admission. */
export type IssueMoveRecord = Readonly<{
  operationId: string;
  role: IssueMoveRole;
  requestHash: string;
  issueRef: string;
  sourceIssueId: string | null;
  destinationIssueId: string | null;
  sourceAuthority: string;
  destinationAuthority: string;
  destinationProject: string;
  phase: IssueMovePhase;
  payloadJson: string;
  payloadDigest: string;
  stagedCounts: string;
  sourceStoreId: string;
  sourceEpoch: number;
  removedSyncRows: number;
  createdAt: string;
  updatedAt: string;
}>;

function corruptMove(detail: string): StoreError {
  return new StoreError(
    "store.corrupt",
    `The move ledger is unreadable (${detail}); a move is never resumed or rewritten from a guess. Nothing was modified.`,
  );
}

function moveText(value: unknown, what: string): string {
  if (typeof value !== "string") throw corruptMove(`${what} is not text`);
  return value;
}

function moveNullableText(value: unknown, what: string): string | null {
  if (value === null) return null;
  return moveText(value, what);
}

function moveCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function phaseOf(value: unknown): IssueMovePhase {
  if (
    value === "staged" ||
    value === "verified" ||
    value === "switched" ||
    value === "published" ||
    value === "discarded"
  ) {
    return value;
  }
  throw corruptMove(`phase is ${JSON.stringify(value)}`);
}

function roleOf(value: unknown): IssueMoveRole {
  if (value === "source" || value === "destination") return value;
  throw corruptMove(`role is ${JSON.stringify(value)}`);
}

const MOVE_COLUMNS =
  "operation_id, role, request_hash, issue_ref, source_issue_id, destination_issue_id, source_authority, " +
  "destination_authority, destination_project, phase, payload_json, payload_digest, staged_counts, source_store_id, " +
  "source_epoch, removed_sync_rows, created_at, updated_at";

function rowToRecord(row: Record<string, unknown>): IssueMoveRecord {
  return {
    operationId: moveText(row.operation_id, "operation_id"),
    role: roleOf(row.role),
    requestHash: moveText(row.request_hash, "request_hash"),
    issueRef: moveText(row.issue_ref, "issue_ref"),
    sourceIssueId: moveNullableText(row.source_issue_id, "source_issue_id"),
    destinationIssueId: moveNullableText(row.destination_issue_id, "destination_issue_id"),
    sourceAuthority: moveText(row.source_authority, "source_authority"),
    destinationAuthority: moveText(row.destination_authority, "destination_authority"),
    destinationProject: moveText(row.destination_project, "destination_project"),
    phase: phaseOf(row.phase),
    payloadJson: moveText(row.payload_json, "payload_json"),
    payloadDigest: moveText(row.payload_digest, "payload_digest"),
    stagedCounts: moveText(row.staged_counts, "staged_counts"),
    sourceStoreId: moveText(row.source_store_id, "source_store_id"),
    sourceEpoch: moveCount(row.source_epoch),
    removedSyncRows: moveCount(row.removed_sync_rows),
    createdAt: moveText(row.created_at, "created_at"),
    updatedAt: moveText(row.updated_at, "updated_at"),
  };
}

/** note: Whether `to` is a legal next phase for `from`; the one place the state machine is read. */
export function isForwardMoveTransition(from: IssueMovePhase, to: IssueMovePhase): boolean {
  return MOVE_TRANSITIONS[from].includes(to);
}

/**
 * invariant: A move row advances only along the forward set. The refusal names the phase the row
 * actually holds and the legal destinations from it, so an operator learns which command resumes
 * the move instead of retrying a transition that can never succeed.
 */
export function assertMoveTransition(from: IssueMovePhase, to: IssueMovePhase): void {
  if (isForwardMoveTransition(from, to)) return;
  const allowed = MOVE_TRANSITIONS[from];
  throw new StoreError(
    "collaboration.move-phase-invalid",
    `A move in phase ${from} cannot become ${to}; ` +
      (allowed.length === 0
        ? `phase ${from} is terminal, so the move is finished.`
        : `the only legal next phase${allowed.length === 1 ? " is" : "s are"} ${allowed.join(", ")}.`) +
      ` Nothing was modified.`,
    { from, to, allowed },
  );
}

/** note: The row one lane holds for its role in a move, or `null` before this side committed one. */
export function readIssueMove(db: StoreDb, operationId: string, role: IssueMoveRole): IssueMoveRecord | null {
  const row = db
    .prepare(`select ${MOVE_COLUMNS} from issue_moves where operation_id = ? and role = ?`)
    .get(operationId, role) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToRecord(row);
}

/** note: The source row in a blocking phase for one record: the fence this record's writes meet. */
export function blockingMoveFor(
  db: StoreDb,
  sourceIssueId: string,
): Readonly<{ operationId: string; phase: IssueMovePhase }> | null {
  const row = db
    .prepare(
      "select operation_id, phase from issue_moves where role = 'source' and source_issue_id = ? " +
        "and phase in ('staged','verified','switched')",
    )
    .get(sourceIssueId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return { operationId: moveText(row.operation_id, "operation_id"), phase: phaseOf(row.phase) };
}

/**
 * invariant: The same verdict the lane's triggers raise, stated for the caller that must explain
 * it. A source write meets `issue.move-in-progress` from the trigger; a caller that asks first
 * names the move's operation id and phase, which is what the recovery needs.
 */
export function assertRecordWritable(db: StoreDb, sourceIssueId: string): void {
  const blocked = blockingMoveFor(db, sourceIssueId);
  if (blocked === null) return;
  throw new StoreError(
    "issue.move-in-progress",
    `Issue ${sourceIssueId} is frozen by move ${blocked.operationId} in phase ${blocked.phase}, so it cannot be written ` +
      `until that move publishes or is discarded. Resume the move with the same operation id and payload, or discard it ` +
      `from ${blocked.phase === "switched" ? "published" : "staged or verified"} if its destination step has not made ` +
      `the record a member. Nothing was modified.`,
    { issue_id: sourceIssueId, operation_id: blocked.operationId, phase: blocked.phase },
  );
}

/** note: Record one side's first row. A duplicate `(operation_id, role)` is the caller's replay. */
export function recordIssueMove(db: StoreDb, record: Omit<IssueMoveRecord, "createdAt" | "updatedAt">): IssueMoveRecord {
  const at = nowRfc3339();
  db.prepare(
    `insert into issue_moves(${MOVE_COLUMNS}) values (${MOVE_COLUMNS.split(",").map(() => "?").join(", ")})`,
  ).run(
    record.operationId,
    record.role,
    record.requestHash,
    record.issueRef,
    record.sourceIssueId,
    record.destinationIssueId,
    record.sourceAuthority,
    record.destinationAuthority,
    record.destinationProject,
    record.phase,
    record.payloadJson,
    record.payloadDigest,
    record.stagedCounts,
    record.sourceStoreId,
    record.sourceEpoch,
    record.removedSyncRows,
    at,
    at,
  );
  return { ...record, createdAt: at, updatedAt: at };
}

/**
 * invariant: Advance one row by compare-and-set on the phase it was read at. A row that moved in
 * between (another attempt committed the destination step) is not overwritten: the update touches
 * nothing and the caller learns the current phase. The transition is validated BEFORE the write,
 * so an illegal target never reaches the table.
 */
export function advanceIssueMove(
  db: StoreDb,
  input: Readonly<{
    operationId: string;
    role: IssueMoveRole;
    from: IssueMovePhase;
    to: IssueMovePhase;
    destinationIssueId?: string | null;
  }>,
): IssueMoveRecord {
  assertMoveTransition(input.from, input.to);
  const result = db
    .prepare(
      "update issue_moves set phase = ?, destination_issue_id = coalesce(?, destination_issue_id), updated_at = ? " +
        "where operation_id = ? and role = ? and phase = ?",
    )
    .run(input.to, input.destinationIssueId ?? null, nowRfc3339(), input.operationId, input.role, input.from);
  const changed = typeof result === "object" && result !== null && "changes" in result ? Number(result.changes) : 0;
  const current = readIssueMove(db, input.operationId, input.role);
  if (current === null) {
    throw corruptMove(`no ${input.role} row exists for move ${input.operationId}`);
  }
  if (changed === 0) {
    throw new StoreError(
      "collaboration.move-phase-invalid",
      `Move ${input.operationId} was at phase ${current.phase}, not ${input.from}, so the ${input.from} -> ${input.to} ` +
        `transition was not applied; another attempt already advanced this row. Re-read the move and continue from ` +
        `the phase it now holds. Nothing was modified.`,
      { operation_id: input.operationId, expected: input.from, found: current.phase },
    );
  }
  return current;
}
