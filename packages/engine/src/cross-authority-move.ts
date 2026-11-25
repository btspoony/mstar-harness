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
 * same rule for the caller that has to explain the refusal.
 *
 * The phase engine below owns the one-checkout topology (local to local): the source lane commits
 * its verdict first, then the destination step follows from the persisted row, so a crash between
 * the two is resumed by reissuing the same command rather than by a kept handle.
 */
import { createHash } from "node:crypto";
import {
  collaborationLocationOfRepoKey,
  resolveCollaborationLocation,
  type CollaborationLocation,
} from "./collaboration-identity.js";
import {
  openCollaborationStore,
  readCollaborationAuthority,
  readCollaborationStage,
  readLaneMode,
  withCollaborationWrite,
  writeCollaborationStage,
  type CollaborationStoreHandle,
} from "./collaboration-store.js";
import type { CompositeIntent } from "./collaboration-operations.js";
import { IssueError, computeIdentityKey } from "./issue.js";
import { StoreError, nowRfc3339, type StoreContext, type StoreDb } from "./store-db.js";

/** note: One row's role: the source holds the ledger, the destination holds the staged copy. */
export type IssueMoveRole = "source" | "destination";

export type IssueMovePhase = "staged" | "verified" | "switched" | "published" | "discarded";

/** note: The phases in which the source record is frozen. The lane's triggers carry this set. */
export const BLOCKING_MOVE_PHASES: readonly IssueMovePhase[] = ["staged", "verified", "switched"];

/**
 * invariant: The forward transition set. A move never goes back: `staged -> verified -> switched
 * -> published` is the progress path. `discarded` is reachable from any phase in which the
 * destination holds no member of this move, which the discarding path itself proves: before the
 * switch the record is not there yet, and after a switch that never admitted, it still is not.
 * `published` is terminal.
 */
const MOVE_TRANSITIONS: Readonly<Record<IssueMovePhase, readonly IssueMovePhase[]>> = {
  staged: ["verified", "discarded"],
  verified: ["switched", "discarded"],
  switched: ["published", "discarded"],
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
  /** note: The request's remaining immutable fields, recorded once: a replay must match them. */
  actor: string;
  reason: string;
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

function moveCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw corruptMove(`${what} is not a non-negative safe integer`);
  }
  return value;
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
  "destination_authority, destination_project, actor, reason, phase, payload_json, payload_digest, staged_counts, " +
  "source_store_id, source_epoch, removed_sync_rows, created_at, updated_at";

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
    actor: moveText(row.actor, "actor"),
    reason: moveText(row.reason, "reason"),
    phase: phaseOf(row.phase),
    payloadJson: moveText(row.payload_json, "payload_json"),
    payloadDigest: moveText(row.payload_digest, "payload_digest"),
    stagedCounts: moveText(row.staged_counts, "staged_counts"),
    sourceStoreId: moveText(row.source_store_id, "source_store_id"),
    sourceEpoch: moveCount(row.source_epoch, "source_epoch"),
    removedSyncRows: moveCount(row.removed_sync_rows, "removed_sync_rows"),
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
      `from ${blocked.phase} (a discard is admitted from staged, verified or switched) while its destination step has not ` +
      `made the record a member. Nothing was modified.`,
    { issue_id: sourceIssueId, operation_id: blocked.operationId, phase: blocked.phase },
  );
}

/**
 * note: The same fence addressed the way a remote lane can: by the record's stable reference. A
 * `remote` source has no `issues` row, so its ledger row is the only place its display id would be,
 * and there is none; the reference is the address it keeps.
 */
export function blockingMoveForRef(
  db: StoreDb,
  issueRef: string,
): Readonly<{ operationId: string; phase: IssueMovePhase }> | null {
  const row = db
    .prepare(
      "select operation_id, phase from issue_moves where role = 'source' and issue_ref = ? " +
        "and phase in ('staged','verified','switched')",
    )
    .get(issueRef) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return { operationId: moveText(row.operation_id, "operation_id"), phase: phaseOf(row.phase) };
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
    record.actor,
    record.reason,
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
  // invariant: A corrupt row is never advanced one more phase before the reader names it: the read
  // that validates every column runs before the compare-and-set, which stays the atomic replay guard.
  readIssueMove(db, input.operationId, input.role);
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


// ---------------------------------------------------------------------------
// note: The phase engine: the one-checkout topology, where both sides are local/mirror lanes.
// ---------------------------------------------------------------------------

/**
 * note: The interleaving seam. A regression runs another committed operation at the exact boundary
 * between a phase's preflight read and the write that depends on it, so the check that must live
 * inside that write is the one under test. Unset in every shipped path.
 */
let moveGapForTest: ((point: "stage" | "switch" | "discard") => void | Promise<void>) | undefined;
export function setMoveGapForTest(
  callback: ((point: "stage" | "switch" | "discard") => void | Promise<void>) | undefined,
): void {
  moveGapForTest = callback;
}

/** note: The move a caller asked for. `operationId` is the whole move's key: every phase derives its own composite id from it. */
export type MoveRequest = Readonly<{
  operationId: string;
  actor: string;
  sourceIssueId: string;
  /** note: The destination lane's canonical `repoKey`; a key never carries a mode, so the lane's own record decides it. */
  destinationAuthority: string;
  destinationProject: string;
  reason: string;
  /**
   * note: The two revisions the caller read. They are the base the first stage freezes on and are
   * compared ONLY by the run that stages: a replay continues the persisted operation, so it never
   * re-applies a base that stage already consumed.
   */
  expectedRevision?: number;
  expectedStoreRevision?: number;
}>;

/** note: The five carried row counts, plus the incoming edges that stay behind and are rewritten at publish. */
export type MoveCounts = Readonly<{
  occurrences: number;
  issueTransitions: number;
  provenance: number;
  relations: number;
  issueProjectMoves: number;
  relationsLeftBehind: number;
}>;

/** note: What one run left behind, read back from the two persisted rows rather than remembered. */
export type MoveReceipt = Readonly<{
  operationId: string;
  phase: IssueMovePhase;
  issueRef: string;
  sourceIssueId: string;
  destinationIssueId: string | null;
  destinationAuthority: string;
  destinationProject: string;
  /** note: The phase the source row already held when this run started; `null` on the run that staged it. */
  resumedFrom: IssueMovePhase | null;
}>;

/** note: The frozen copy: every row the record owns, carrying no local id of the source lane. */
type MoveCopy = Readonly<{
  issue: Record<string, unknown>;
  occurrences: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
  projectMoves: Array<Record<string, unknown>>;
  /** note: Outgoing edges only, each as its target's `issue_ref`: the destination holds no other row of this lane. */
  relations: Array<{ relation: string; toRef: string }>;
}>;

/** note: The canonical digest of one frozen payload: the value `payload_digest` and `stagedMismatch` compare. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * invariant: Verification's one verdict. The destination staging must carry the source's `issue_ref`,
 * its frozen payload digest and its carried counts, and the payload must still hash to that digest:
 * a copy whose rows were REPLACED rather than added or removed passes a count-only check.
 */
export function stagedMismatch(source: IssueMoveRecord, staged: IssueMoveRecord): string | null {
  if (source.issueRef !== staged.issueRef) {
    return `the staged copy carries reference ${staged.issueRef}, not ${source.issueRef}`;
  }
  // invariant: The digest is the reviewed integrity evidence of a staged move. It is kept because a
  // count-only check passes when a copy's rows were replaced, not added or removed.
  if (
    // why: this comparison is the reviewed integrity gate the spec's ablation keeps; the marker below
    // records the integrity fact it establishes.
    // hash-gate: authorized — The staged copy must carry the digest frozen with its source row.
    source.payloadDigest !== staged.payloadDigest
  ) {
    return `the staged copy carries digest ${staged.payloadDigest}, not ${source.payloadDigest}`;
  }
  if (
    // why: the staged payload must still hash to the digest recorded with it, so a rewritten copy fails.
    // hash-gate: authorized — A staged payload that no longer hashes to its recorded digest was rewritten after the freeze.
    digestOf(staged.payloadJson) !== staged.payloadDigest
  ) {
    return "the staged copy's payload no longer hashes to its recorded digest, so it was rewritten after it was frozen";
  }
  return source.stagedCounts === staged.stagedCounts
    ? null
    : `the staged copy counts ${staged.stagedCounts}, not ${source.stagedCounts}`;
}

/** note: An operation id this lane records no move under: a fresh command, not a damaged ledger. */
function noSuchMove(operationId: string, step: string): StoreError {
  // invariant: A discard abandons a move, so "start the move" is no recovery here: it would publish a
  // record under a fresh id and still leave nothing to discard. The recorded operation id and the
  // checkout that staged it are the whole runnable recovery; every other step keeps the start.
  const recovery =
    step === "discard"
      ? `Reissue this --discard from the checkout that ran the move, passing the same ` +
        `--operation-id you used.`
      : `Start the move with \`mstar issue move --id <issue-id> --to-authority <repo-key> --payload ` +
        `'{"projectId":"<target-project>","reason":"<text>"}' --expect <issue-revision> --expect-store <store-revision> ` +
        `--actor project-manager --operation-id ${operationId}\`, then reissue that same command to resume it.`;
  return new StoreError(
    "collaboration.move-phase-invalid",
    `No cross-authority move is recorded in this authority under operation id ${JSON.stringify(operationId)}, so there is ` +
      `nothing to ${step}. A move is never resumed, discarded or published from a guess. Nothing was modified.`,
    { operation_id: operationId, recovery },
  );
}

/** note: The lane's display-id allocator, exactly as every issue-producing path uses it. */
function allocateIssueId(db: StoreDb): string {
  const counter = db.prepare("select next_value as nextValue from issue_counter where id = 1").get() as {
    nextValue: number;
  };
  db.prepare("update issue_counter set next_value = next_value + 1 where id = 1").run();
  return `I-${String(counter.nextValue).padStart(6, "0")}`;
}

function countOf(db: StoreDb, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined;
  return typeof row?.n === "number" ? row.n : 0;
}

/**
 * note: The columns an admitted record must carry unchanged. The destination owns its display id,
 * revision, identity key, updated_at and milestone, so those are deliberately absent.
 */
const CARRIED_ISSUE_COLUMNS = [
  "project_id",
  "title",
  "kind",
  "severity",
  "disposition",
  "impact",
  "acceptance",
  "owner",
  "registered_at",
  "closed_at",
  "closure_note",
  "created_at",
  "issue_ref",
] as const;

/**
 * note: One record's carried image as the destination must hold it. The freeze and the adoption
 * check read the child rows through these SAME statements, so "identical to the frozen copy" means
 * one thing instead of two hand-matched column lists.
 */
function carriedRowsOf(db: StoreDb, issueId: string): MoveCopy {
  const rows = (sql: string): Array<Record<string, unknown>> =>
    db.prepare(sql).all(issueId) as Array<Record<string, unknown>>;
  const issue = db.prepare(`select ${CARRIED_ISSUE_COLUMNS.join(", ")} from issues where id = ?`).get(issueId) as
    | Record<string, unknown>
    | undefined;
  if (issue === undefined) throw corruptMove(`${issueId} disappeared while its carried rows were read`);
  return {
    issue,
    occurrences: rows(
      "select occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, " +
        "evidence_json, discovered_at, recorded_at, imported from occurrences where issue_id = ? order by id asc",
    ),
    transitions: rows(
      "select from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, evidence_json, imported, " +
        "issue_revision from issue_transitions where issue_id = ? order by id asc",
    ),
    provenance: rows(
      "select kind, target, source_hash, legacy_project, legacy_bucket, legacy_entry_id, legacy_json, imported_at, origin " +
        "from provenance where issue_id = ? order by id asc",
    ),
    projectMoves: rows(
      "select from_project_id, to_project_id, actor, reason, occurred_at, recorded_at, issue_revision " +
        "from issue_project_moves where issue_id = ? order by id asc",
    ),
    // note: Outgoing edges only, each by its target's stable reference: that is exactly what the
    // freeze records and what admission inserts, so an adopted record compares edge for edge.
    relations: db
      .prepare(
        "select relation, coalesce(to_ref, (select i.issue_ref from issues i where i.id = to_issue)) as toRef " +
          "from relations where from_issue = ? order by relation asc, toRef asc",
      )
      .all(issueId) as Array<{ relation: string; toRef: string }>,
  };
}

/**
 * invariant: The freeze reads the record and every row it owns in ONE snapshot, and stores no local
 * id: `from_issue` and `issue_id` belong to the source lane and are re-allocated at admission. A
 * relation target outside the carried set becomes its `issue_ref`, which is what the destination can
 * still address.
 */
function freezeMoveCopy(db: StoreDb, issueId: string): { copy: MoveCopy; counts: MoveCounts } {
  const issue = db
    .prepare(
      "select project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, closed_at, " +
        "closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key, issue_ref, milestone_id " +
        "from issues where id = ?",
    )
    .get(issueId) as Record<string, unknown> | undefined;
  if (issue === undefined) throw corruptMove(`${issueId} disappeared while its move was being frozen`);
  const { occurrences, transitions, provenance, projectMoves, relations } = carriedRowsOf(db, issueId);
  const outgoing = db
    .prepare(
      "select relation, coalesce(to_ref, (select i.issue_ref from issues i where i.id = to_issue)) as toRef " +
        "from relations where from_issue = ? order by relation asc, toRef asc",
    )
    .all(issueId) as Array<{ relation: string; toRef: string }>;
  return {
    copy: {
      issue,
      occurrences: occurrences as Array<Record<string, unknown>>,
      transitions: transitions as Array<Record<string, unknown>>,
      provenance: provenance as Array<Record<string, unknown>>,
      projectMoves: projectMoves as Array<Record<string, unknown>>,
      relations: outgoing,
    },
    counts: {
      occurrences: occurrences.length,
      issueTransitions: transitions.length,
      provenance: provenance.length,
      relations: outgoing.length,
      issueProjectMoves: projectMoves.length,
      relationsLeftBehind: countOf(db, "select count(*) as n from relations where to_issue = ?", issueId),
    },
  };
}

/** note: The destination lane of one `repoKey`. Absence is a named refusal, not a silent no-op. */
async function destinationLaneOf(repoKey: string): Promise<CollaborationLocation> {
  let refusal: unknown = null;
  for (const mode of ["local", "mirror"] as const) {
    const location = collaborationLocationOfRepoKey(repoKey, mode);
    try {
      await readCollaborationStage(location, () => undefined);
      return location;
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
      if (code === "collaboration.not-initialized") {
        throw new StoreError(
          "collaboration.not-initialized",
          `No collaboration authority exists at ${location.dbPath} for ${repoKey}. A cross-authority move writes only an ` +
            `existing active destination lane, so nothing was staged.`,
          {
            repoKey,
            recovery:
              `Create that authority first: run \`mstar store init\` in a checkout of ${repoKey} (or publish it with the ` +
              `reviewed collaboration apply/activate sequence), then reissue this move with the same --operation-id.`,
          },
        );
      }
      // note: The other admitted mode is the lane's own recorded mode; anything else is the real refusal.
      if (code !== "collaboration.stale-binding") throw error;
      refusal = error;
    }
  }
  throw refusal;
}

async function moveRowIn(context: StoreContext, operationId: string, role: IssueMoveRole): Promise<IssueMoveRecord | null> {
  const handle = await openCollaborationStore(context, "read");
  try {
    return readIssueMove(handle.db, operationId, role);
  } finally {
    handle.close();
  }
}

function destinationRowIn(location: CollaborationLocation, operationId: string): Promise<IssueMoveRecord | null> {
  return readCollaborationStage(location, ({ db }) => readIssueMove(db, operationId, "destination"));
}

/**
 * note: Advance a row to `target` along the progress path, one legal step at a time, so a row that
 * stopped earlier (an interrupted destination step) is brought up to date instead of refusing a
 * transition whose FROM phase this attempt never observed.
 */
function advanceRowTo(db: StoreDb, operationId: string, role: IssueMoveRole, target: IssueMovePhase): IssueMovePhase {
  const path: readonly IssueMovePhase[] = ["staged", "verified", "switched", "published"];
  const limit = path.indexOf(target);
  for (;;) {
    const row = readIssueMove(db, operationId, role);
    if (row === null) throw corruptMove(`move ${operationId} lost its ${role} row`);
    if (row.phase === target) return row.phase;
    const at = path.indexOf(row.phase);
    // invariant: `discarded` is the branch, not a step on the progress path, so it is the target itself
    // or the state machine's own refusal.
    if (limit < 0 || at < 0) {
      advanceIssueMove(db, { operationId, role, from: row.phase, to: target });
      return target;
    }
    // invariant: A row already past the requested step keeps its phase: the destination copy outran the
    // source's step, and re-deriving it must not walk backwards.
    if (at > limit) return row.phase;
    advanceIssueMove(db, { operationId, role, from: row.phase, to: path[at + 1]! });
  }
}

/**
 * invariant: One phase transition is one `issue-move` composite, under an id derived from the move and
 * the target phase, so a replay after an apply-then-finalize crash replays that receipt instead of
 * repeating the effect. A transition whose reservation is already `confirmed` is not reserved again:
 * the recorded effect is the answer. The destination step is the caller's and runs AFTER this commit.
 */
async function runMoveTransition(
  context: StoreContext,
  request: MoveRequest,
  phase: IssueMovePhase,
  effect: (handle: CollaborationStoreHandle) => void,
): Promise<void> {
  const { advanceCollaborationRevision, reserveCompositeIntent, runCollaborationComposite } = await import(
    "./collaboration-operations.js"
  );
  const { executionRootTokenOf, withExecutionTransaction } = await import("./execution-store.js");
  const source = await readCollaborationAuthority(context);
  const frozenPayload = JSON.stringify({
    move: request.operationId,
    phase,
    issue: request.sourceIssueId,
    destination: request.destinationAuthority,
    project: request.destinationProject,
  });
  const operationId = `${request.operationId}:move-${phase}`;
  const prepared = await withExecutionTransaction<
    { done: true } | { done: false; intent: CompositeIntent }
  >(context, (tx) => {
    const recorded = tx.db
      .prepare(
        "select phase from execution_collaboration_intents where execution_store_id = ? and execution_epoch = ? and operation_id = ?",
      )
      .get(tx.storeId, tx.epoch, operationId) as { phase?: unknown } | undefined;
    if (recorded?.phase === "confirmed") return { done: true as const };
    const intent: CompositeIntent = {
      key: { executionStoreId: tx.storeId, executionEpoch: tx.epoch, operationId },
      kind: "issue-move",
      requestHash: digestOf(frozenPayload),
      target: { repoKey: source.repoKey, mode: source.mode, storeId: source.storeId, epoch: source.epoch },
      // note: a move addresses one record, never a plan row, so it reserves no plan and excludes no other writer.
      scope: { workflowId: null, planId: null },
      actor: request.actor,
      expectedExecution: executionRootTokenOf(tx),
      frozenPayload,
    };
    const reservation = reserveCompositeIntent(tx, intent, { revision: tx.execution.revision });
    return { done: false as const, intent: { ...intent, requestHash: reservation.requestHash } };
  });
  if (prepared.done) return;
  await runCollaborationComposite<IssueMovePhase>(context, prepared.intent, {
    apply: (handle) => {
      effect(handle);
      // note: one collaboration revision advance for the whole effect transaction.
      advanceCollaborationRevision(handle);
      return phase;
    },
    finalize: () => phase,
  });
}

/** note: The outbox step that actually works in one live state, shared by every pending-intent refusal. */
function pendingIntentRecovery(operation: string, state: string): string {
  const outbox = "mstar store collaboration remote";
  return state === "unconfirmed"
    ? `Settle the outbox route first: \`${outbox} outbox-receipt --harness <abs> --input <file|->\` records the provider's ` +
        `answer for the attempt ${operation}, or \`${outbox} outbox-reconcile --harness <abs> --input <file|->\` reconciles ` +
        `it under its original binding; reissue this move with the same --operation-id once it is settled.`
    : state === "conflict"
      ? `Settle the outbox route first: \`${outbox} outbox-resolve --harness <abs> --operation ${operation} --input <file>\` ` +
        `records the reviewed resolution of the conflicted fork; reissue this move with the same --operation-id once it ` +
        `is settled.`
      : `Settle the outbox route first: \`${outbox} outbox-abandon --harness <abs> --operation ${operation} --reason ` +
        `<text>\` when nothing was sent, otherwise \`${outbox} outbox-dispatch --harness <abs> --operation ${operation}\` ` +
        `and then \`${outbox} outbox-receipt --harness <abs> --input <file|->\`; reissue this move with the same ` +
        `--operation-id once it is settled.`;
}
/**
 * note: A provider intent frozen for this record is an admitted mirror write the host may already
 * have sent; staging a move would publish the record out from under it. `confirmed` and `abandoned`
 * are settled, so only the three live states refuse. One helper states it for both stage paths.
 *
 * invariant: The recovery names the step that actually works in the reported state — an `enqueued`
 * intent is abandoned or dispatched, an `unconfirmed` one already dispatched and needs its receipt or
 * a reconciliation, and a `conflict` needs the reviewed resolution.
 */
function assertNoPendingIntent(db: StoreDb, issueRef: string): void {
  const pending = db
    .prepare(
      "select operation_id, state from remote_outbox where state in ('enqueued','unconfirmed','conflict') " +
        "and json_extract(request_json, '$.event.change.issueRef') = ? order by created_at, operation_id",
    )
    .all(issueRef) as Array<{ operation_id?: unknown; state?: unknown }>;
  if (pending.length === 0) return;
  const first = pending[0] ?? {};
  const operation = typeof first.operation_id === "string" ? first.operation_id : "?";
  const state = typeof first.state === "string" ? first.state : "?";
  const recovery = pendingIntentRecovery(operation, state);
  throw new StoreError(
    "remote.effect-pending",
    `${issueRef} holds ${String(pending.length)} pending provider intent(s) (oldest ${operation} is ${state}); staging this ` +
      `move would publish the record while the provider may already hold that write. Nothing was staged.`,
    {
      issue_ref: issueRef,
      pending_intents: pending.length,
      operationId: operation,
      state,
      recovery,
    },
  );
}

/** note: The pending-mirror, pending-intent and freeze preconditions of `stage`, stated once, inside the effect's transaction. */
function assertStageable(db: StoreDb, request: MoveRequest): void {
  const issue = db.prepare("select id, project_id, issue_ref from issues where id = ?").get(request.sourceIssueId) as
    | { id: string; project_id: string; issue_ref: string }
    | undefined;
  if (issue === undefined) {
    throw new IssueError("issue.not-found", `Issue ${request.sourceIssueId} does not exist in this authority`);
  }
  // note: A record another move already froze names that move instead of the trigger's bare abort.
  assertRecordWritable(db, request.sourceIssueId);
  const pending = countOf(
    db,
    "select count(*) as n from issue_sync_state where local_id = ? and item_state = 'pending'",
    request.sourceIssueId,
  );
  if (pending > 0) {
    throw new StoreError(
      "collaboration.cutover-not-quiescent",
      `Issue ${request.sourceIssueId} holds ${String(pending)} pending mirror row(s); publishing this move would delete them ` +
        `with the record and strand a delivery the provider may already hold. Nothing was staged.`,
      {
        issue_id: request.sourceIssueId,
        pending_rows: pending,
        recovery:
          `Settle the mirror first: run \`mstar issue-sync pending --project ${issue.project_id}\` and record the outcome with ` +
          `\`mstar issue-sync apply --project ${issue.project_id} --results <file|->\`, then reissue this move with the same ` +
          `--operation-id.`,
      },
    );
  }
  assertNoPendingIntent(db, issue.issue_ref);
}

/**
 * note: A typed issue refusal with structured facts; `IssueError` carries its details as a field, so
 * one helper keeps the call sites honest instead of assigning after construction.
 */
function issueRefusal(code: ConstructorParameters<typeof IssueError>[0], message: string, details: Record<string, unknown>): IssueError {
  const error = new IssueError(code, message);
  error.details = details;
  return error;
}

/**
 * note: One command argument as the POSIX shell reads it back byte for byte: wrapped in single quotes,
 * with each embedded quote closed, escaped and reopened. A recovery is only usable if a value
 * carrying a quote, an apostrophe or a backslash still reaches the verb unchanged.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** note: The one command that resumes a recorded move, built from its row and the revisions the lane holds. */
function moveResumeCommand(db: StoreDb, row: IssueMoveRecord): string {
  const issue = db.prepare("select revision from issues where id = ?").get(row.sourceIssueId) as { revision?: unknown } | undefined;
  const store = db.prepare("select revision from collaboration_meta where id = 1").get() as { revision?: unknown } | undefined;
  // note: A switched source is presented by neither side, so its revision is read from whatever the
  // lane still holds; a resume never compares it, and these are the values that make the copy run.
  const issueRevision = typeof issue?.revision === "number" ? issue.revision : 0;
  const storeRevision = typeof store?.revision === "number" ? store.revision : 0;
  // invariant: The resume replays the RECORDED request, reason and actor included, because a
  // replayed move is bound to the request it was staged under.
  const payload = JSON.stringify({ projectId: row.destinationProject, reason: row.reason });
  return [
    "mstar issue move",
    "--id",
    shellQuote(row.sourceIssueId ?? "<issue-id>"),
    "--to-authority",
    shellQuote(row.destinationAuthority),
    "--payload",
    shellQuote(payload),
    "--expect",
    String(issueRevision),
    "--expect-store",
    String(storeRevision),
    "--actor",
    shellQuote(row.actor),
    "--operation-id",
    shellQuote(row.operationId),
  ].join(" ");
}

/**
 * invariant: A discard abandons the RECORDED move, so it carries every flag the resume carries
 * except `--expect-store`: the CLI refuses that flag on `--discard` because the move's own phase
 * commits already advanced the lane revision the discard never compares. Reusing the resume string
 * would print a command that always fails with `issue.invalid-payload`.
 */
function moveDiscardCommand(db: StoreDb, row: IssueMoveRecord): string {
  const issue = db.prepare("select revision from issues where id = ?").get(row.sourceIssueId) as { revision?: unknown } | undefined;
  const issueRevision = typeof issue?.revision === "number" ? issue.revision : 0;
  const payload = JSON.stringify({ projectId: row.destinationProject, reason: row.reason });
  return [
    "mstar issue move",
    "--id",
    shellQuote(row.sourceIssueId ?? "<issue-id>"),
    "--to-authority",
    shellQuote(row.destinationAuthority),
    "--payload",
    shellQuote(payload),
    "--expect",
    String(issueRevision),
    "--actor",
    shellQuote(row.actor),
    "--operation-id",
    shellQuote(row.operationId),
    "--discard",
  ].join(" ");
}

/**
 * invariant: An operation id is an idempotency key, not a reusable slot. Every phase compares the
 * COMPLETE immutable request — record, both authorities, destination project, actor and reason — with
 * the recorded row BEFORE any destination or terminal action, so a resume under the same id can never
 * carry another record into a lane the original request did not choose, and the membership admission
 * records is the one the request was staged with rather than the one a later attempt supplied.
 */
function assertBoundRequest(db: StoreDb, row: IssueMoveRecord, request: MoveRequest): void {
  const recorded = {
    // note: A remote source has no display id, so its record is addressed by the reference it keeps;
    // the binding compares the address the operator must pass either way.
    sourceIssueId: row.sourceIssueId ?? row.issueRef,
    destinationAuthority: row.destinationAuthority,
    destinationProject: row.destinationProject,
    actor: row.actor,
    reason: row.reason,
  };
  const requested = {
    sourceIssueId: request.sourceIssueId,
    destinationAuthority: request.destinationAuthority,
    destinationProject: request.destinationProject,
    actor: request.actor,
    reason: request.reason,
  };
  const differing = (Object.keys(recorded) as Array<keyof typeof recorded>).filter(
    (field) => recorded[field] !== requested[field],
  );
  if (differing.length === 0) return;
  throw issueRefusal(
    "store.operation-conflict",
    `Operation id ${JSON.stringify(row.operationId)} already records a move of ${String(row.sourceIssueId)} (${row.issueRef}) ` +
      `to ${row.destinationAuthority}/${row.destinationProject}; this request differs in ${differing.join(", ")}. A move is never ` +
      `resumed from a different request, and its recorded result is never reported as another one's. Nothing was modified.`,
    {
      operation_id: row.operationId,
      differing_fields: differing,
      recorded,
      requested,
      recovery:
        `Reissue the recorded request: \`${moveResumeCommand(db, row)}\`. To move ${request.sourceIssueId} to ` +
        `${request.destinationAuthority}/${request.destinationProject}, run it under a fresh --operation-id.`,
    },
  );
}

/**
 * note: The source row of this request, bound to the request before any caller acts on it. A row that
 * names another record, authority or project refuses here, so no phase ever carries a replay forward
 * under a request the operation was not admitted for.
 */
async function boundSourceRow(context: StoreContext, request: MoveRequest): Promise<IssueMoveRecord | null> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const row = readIssueMove(handle.db, request.operationId, "source");
    if (row !== null) assertBoundRequest(handle.db, row, request);
    return row;
  } finally {
    handle.close();
  }
}

/** note: The same read for a phase that cannot run without a ledger row. */
async function requireSourceRow(
  context: StoreContext,
  request: MoveRequest,
  step: string,
): Promise<{ row: IssueMoveRecord; resume: string }> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const row = readIssueMove(handle.db, request.operationId, "source");
    if (row === null) throw noSuchMove(request.operationId, step);
    assertBoundRequest(handle.db, row, request);
    return { row, resume: moveResumeCommand(handle.db, row) };
  } finally {
    handle.close();
  }
}

/**
 * invariant: The base the caller read is compared in the SAME transaction that freezes the record and
 * advances the lane revision, and only by the run that stages: a replay continues the persisted
 * operation, so re-applying a base the first run already consumed would refuse every resume.
 *
 * note: The two codes are the ones the local project move already raises for the same two checks
 * (`moveIssueOn`), so a caller reads one vocabulary whichever route it took.
 */
function assertMoveBase(db: StoreDb, request: MoveRequest): void {
  const store = db.prepare("select revision from collaboration_meta where id = 1").get() as { revision?: unknown } | undefined;
  const issue = db.prepare("select revision from issues where id = ?").get(request.sourceIssueId) as
    | { revision?: unknown }
    | undefined;
  const storeRevision = typeof store?.revision === "number" ? store.revision : null;
  const issueRevision = typeof issue?.revision === "number" ? issue.revision : null;
  const reread = `Read the record with \`mstar issue show --id ${request.sourceIssueId}\` and the store with \`mstar issue list\`, `;
  if (request.expectedStoreRevision !== undefined && request.expectedStoreRevision !== storeRevision) {
    throw issueRefusal(
      "milestone.revision-conflict",
      `expectedStoreRevision ${String(request.expectedStoreRevision)} does not match the source store revision ` +
        `${String(storeRevision)}; nothing was staged.`,
      {
        operation_id: request.operationId,
        expectedStoreRevision: request.expectedStoreRevision,
        actualStoreRevision: storeRevision,
        recovery:
          `${reread}then reissue the SAME command with the current --expect-store and the same --operation-id.`,
      },
    );
  }
  if (request.expectedRevision !== undefined && request.expectedRevision !== issueRevision) {
    throw issueRefusal(
      "issue.revision-conflict",
      `expectedRevision ${String(request.expectedRevision)} does not match issue revision ${String(issueRevision)}; nothing ` +
        `was staged.`,
      {
        operation_id: request.operationId,
        expectedRevision: request.expectedRevision,
        actualRevision: issueRevision,
        recovery: `${reread}then reissue the SAME command with the current --expect and the same --operation-id.`,
      },
    );
  }
}

/**
 * invariant: The record's carried columns as the destination must hold them; its project is the destination's own fact.
 */
function carriedIssueImage(issue: Record<string, unknown>, destinationProject: string): Record<string, unknown> {
  const image: Record<string, unknown> = {};
  for (const column of CARRIED_ISSUE_COLUMNS) image[column] = issue[column] ?? null;
  image.project_id = destinationProject;
  return image;
}

/**
 * note: Why an existing destination record is NOT the frozen copy. An empty list is the adoption case;
 * every other answer names the part that differs, so the refusal is actionable.
 *
 * invariant: The membership project-move is a DESTINATION fact, exactly like the display id: admission
 * appends it when the record enters that project. So an accepted record holds the frozen history
 * followed by exactly that one row, and nothing else may differ.
 */
function carriedDifferences(actual: MoveCopy, frozen: MoveCopy, destinationProject: string): string[] {
  // why: the frozen copy is the reviewed evidence a move may be adopted from, so comparing its carried
  // rows as canonical text is the integrity gate itself, not a convenience equality.
  // hash-gate: authorized — The destination adopts a move only when every carried row still matches the frozen record.
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  const differing: string[] = [];
  const actualIssue = carriedIssueImage(actual.issue, destinationProject);
  const frozenIssue = carriedIssueImage(frozen.issue, destinationProject);
  for (const column of CARRIED_ISSUE_COLUMNS) {
    if (!same(actualIssue[column], frozenIssue[column])) differing.push(column);
  }
  const [membership, ...extraMoves] = actual.projectMoves.slice(frozen.projectMoves.length);
  // note: The membership row records the project the record LEFT, so it names the FROZEN source
  // project, which the payload kept exactly because the destination owns the other side of the move.
  const membershipLanded =
    extraMoves.length === 0 &&
    membership !== undefined &&
    same(membership.from_project_id, frozen.issue.project_id) &&
    same(membership.to_project_id, destinationProject);
  if (!membershipLanded || !same(actual.projectMoves.slice(0, frozen.projectMoves.length), frozen.projectMoves)) {
    differing.push("project moves");
  }
  if (!same(actual.occurrences, frozen.occurrences)) differing.push("occurrences");
  if (!same(actual.transitions, frozen.transitions)) differing.push("transitions");
  if (!same(actual.provenance, frozen.provenance)) differing.push("provenance");
  if (!same(actual.relations, frozen.relations)) differing.push("relations");
  return differing;
}

/**
 * invariant: Every prerequisite the destination admission needs is proved BEFORE the irreversible
 * source switch. A switched source is presented by neither authority and its writes are fenced, so a
 * collision or a missing identity discovered only at admission would strand the only copy; here it is a
 * refusal with the record still authoritative in this lane.
 */
function assertAdmissible(db: StoreDb, request: MoveRequest, copy: MoveCopy, counts: MoveCounts): void {
  if (counts.relations !== copy.relations.length) {
    throw corruptMove(
      `move ${request.operationId} recorded ${String(counts.relations)} relations but froze ${String(copy.relations.length)}`,
    );
  }
  const issueRef = String(copy.issue.issue_ref);
  const existing = db.prepare("select id from issues where issue_ref = ?").get(issueRef) as { id: string } | undefined;
  if (existing !== undefined) {
    // invariant: Publication deletes the source, so an existing record under this reference is adopted
    // only when it already holds EXACTLY the frozen image; older or edited content would lose history.
    const differing = carriedDifferences(carriedRowsOf(db, existing.id), copy, request.destinationProject);
    if (differing.length === 0) return;
    throw new StoreError(
      "collaboration.move-destination-occupied",
      `${request.destinationAuthority} already holds issue ${existing.id} under reference ${issueRef}, and it differs from the ` +
        `frozen copy in ${differing.join(", ")}. Adopting it would publish this move over content it never carried, so nothing ` +
        `was switched.`,
      {
        operation_id: request.operationId,
        destination_authority: request.destinationAuthority,
        occupied_issue_id: existing.id,
        issue_ref: issueRef,
        differing_sections: differing,
        recovery:
          `Read the occupant from a checkout bound to ${request.destinationAuthority}: \`mstar issue show --id ${existing.id}\`. ` +
          `Then discard this move and start it under a fresh --operation-id once the destination no longer holds ${issueRef}.`,
      },
    );
  }
  const first = copy.occurrences[0];
  if (first === undefined) {
    throw issueRefusal(
      "issue.ambiguous-identity",
      `Issue ${issueRef} carries no recorded occurrence identity, so its project-scoped identity cannot be recomputed for ` +
        `${request.destinationProject}; nothing was switched.`,
      {
        operation_id: request.operationId,
        issue_ref: issueRef,
        recovery:
          `Capture the finding in ${request.destinationProject} with \`mstar issue add\` instead of moving a record that has no ` +
          `identity triple, then discard this move with the same --operation-id.`,
      },
    );
  }
  const identityKey = computeIdentityKey(
    request.destinationProject,
    String(first.source_identity),
    String(first.root_cause_key),
    String(first.acceptance_key),
  );
  const collision = db.prepare("select id from issues where identity_key = ?").get(identityKey) as { id: string } | undefined;
  if (collision === undefined) return;
  throw issueRefusal(
    "issue.ambiguous-identity",
    `Admitting ${issueRef} into ${request.destinationProject} would reuse the identity held by issue ${collision.id}; nothing ` +
      `was switched.`,
    {
      operation_id: request.operationId,
      collidingIssueId: collision.id,
      recovery:
        `Read the surviving issue with \`mstar issue show --id ${collision.id}\`; retire the moved record in its favour with ` +
        `\`mstar issue supersede\` instead of moving it here, then discard this move with the same --operation-id.`,
    },
  );
}

/** note: The destination row's own deletion, shared by discard and by a terminal replay finishing it. */
async function deleteDestinationStaging(destination: CollaborationLocation, operationId: string): Promise<void> {
  await writeCollaborationStage(destination, ({ db }) => {
    db.prepare("delete from issue_moves where operation_id = ? and role = 'destination'").run(operationId);
  });
}

/** note: The refusal for a discard whose destination already admitted the record: a member is never abandoned. */
function admittedDiscardRefusal(before: IssueMoveRecord, resume: string, destinationIssueId: string): StoreError {
  return new StoreError(
    "collaboration.move-phase-invalid",
    `Move ${before.operationId} is already the member of ${before.destinationAuthority} (issue ${destinationIssueId}), so it ` +
      `cannot be discarded: only a move whose record the destination never admitted can. Reissue the move to publish it ` +
      `instead. Nothing was modified.`,
    {
      operation_id: before.operationId,
      phase: before.phase,
      destination_issue_id: destinationIssueId,
      allowed: ["published"],
      recovery: `Reissue the move to publish it: \`${resume}\`.`,
    },
  );
}

/** note: The destination lane's preconditions: an active lane of that key that holds the target project. */
function assertDestinationReady(authority: { state: string; repoKey: string }, db: StoreDb, request: MoveRequest): void {
  if (authority.state !== "active") {
    throw new StoreError(
      "collaboration.not-active",
      `The destination authority ${request.destinationAuthority} is ${authority.state}; a move admits a record only into an ` +
        `active lane. Nothing was staged there.`,
      {
        repoKey: request.destinationAuthority,
        recovery: "Publish that destination lane, then reissue this move with the same --operation-id.",
      },
    );
  }
  if (db.prepare("select 1 as ok from catalog_entities where kind = 'project' and id = ?").get(request.destinationProject)) return;
  throw issueRefusal(
    "issue.not-found",
    `Project ${request.destinationProject} is not a registered catalog project of ${request.destinationAuthority}, so the staged ` +
      `copy has nowhere to land. Nothing was staged there.`,
    {
      projectId: request.destinationProject,
      recovery:
        `Register it in a checkout bound to ${request.destinationAuthority} with \`mstar catalog register --kind project ` +
        `--id <project-id> --title <title> --root-kind projects --path projects/<project-id> --actor project-manager ` +
        `--operation-id <operation-id>\`, then reissue this move with the same --operation-id.`,
    },
  );
}

/**
 * invariant: `stage` freezes the source record and writes the source row in ONE transaction, so the
 * lane's trigger freezes the record at the same commit; then it copies the frozen payload to the
 * destination lane. Its preconditions run FIRST, outside any reservation: a refusal here must leave no
 * durable decline against the operation id, because settling the cause is the documented recovery.
 *
 * invariant: The caller's base revisions are compared INSIDE that freeze transaction and only when this
 * run is the one that stages, so a resume of an already-recorded operation continues it instead of
 * re-applying a base the first run consumed.
 */
export async function stageMove(context: StoreContext, request: MoveRequest): Promise<void> {
  const destination = await destinationLaneOf(request.destinationAuthority);
  const staged = (await boundSourceRow(context, request)) !== null;
  if (!staged) {
    const handle = await openCollaborationStore(context, "read");
    try {
      assertStageable(handle.db, request);
      if (handle.authority.repoKey === request.destinationAuthority) {
        throw issueRefusal(
          "issue.scope-refused",
          `${request.destinationAuthority} is this record's own authority, so there is nothing to carry across one; a move needs ` +
            `a different authority. Nothing was moved.`,
          {
            recovery:
              `A project change inside one authority is \`mstar issue move --id ${request.sourceIssueId} --payload ` +
              `'{"projectId":"<target>","reason":"<text>"}' --expect <issue-revision> --expect-store <store-revision>\`.`,
          },
        );
      }
    } finally {
      handle.close();
    }
  }
  await readCollaborationStage(destination, ({ db, authority }) => assertDestinationReady(authority, db, request));
  // note: The preflight/write boundary: a regression runs another committed operation HERE, where a
  // check that lives only in the preflight can no longer see its effect.
  await moveGapForTest?.("stage");
  // invariant: Only the first run freezes and records the source row; a later run re-derives the
  // destination copy from the row that already exists, which is how a lost staging is recovered.
  if (!staged) {
    // invariant: The caller's base, the record's frozen bytes, the source row and the lane revision
    // advance are ONE writer transaction, so no write can slip between the revision the caller read
    // and the freeze, and a crash cannot leave a frozen record whose revision never advanced. It runs
    // BEFORE any composite reservation on purpose: settling a stale base is the documented recovery,
    // and a refusal recorded as a durable decline against the operation id would refuse that recovery
    // forever.
    await withCollaborationWrite(context, (handle) => {
      // invariant: Under the writer lock, a row that appeared after the preflight is THIS id's
      // request or another one: it is bound to the complete request before anything is staged.
      const existing = readIssueMove(handle.db, request.operationId, "source");
      if (existing !== null) {
        assertBoundRequest(handle.db, existing, request);
        return;
      }
      assertMoveBase(handle.db, request);
      // invariant: re-checked under the writer lock: a move that started between the preflight and
      // here must not be overwritten, and the frozen copy must be the record's current bytes.
      assertStageable(handle.db, request);
      const frozen = freezeMoveCopy(handle.db, request.sourceIssueId);
      const payloadJson = JSON.stringify(frozen.copy);
      recordIssueMove(handle.db, {
        operationId: request.operationId,
        role: "source",
        requestHash: digestOf(`${request.operationId}\n${request.sourceIssueId}\n${request.destinationAuthority}`),
        issueRef: String(frozen.copy.issue.issue_ref),
        sourceIssueId: request.sourceIssueId,
        destinationIssueId: null,
        sourceAuthority: handle.authority.repoKey,
        destinationAuthority: request.destinationAuthority,
        destinationProject: request.destinationProject,
        actor: request.actor,
        reason: request.reason,
        phase: "staged",
        payloadJson,
        payloadDigest: digestOf(payloadJson),
        stagedCounts: JSON.stringify(frozen.counts),
        sourceStoreId: handle.authority.storeId,
        sourceEpoch: handle.authority.epoch,
        removedSyncRows: 0,
      });
      // invariant: The freeze commits WITH the revision it advanced, as one transaction. A crash
      // cannot leave the row staged while the lane still reports the revision the caller read.
      handle.db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
    });
  }
  const row = await moveRowIn(context, request.operationId, "source");
  if (row === null) throw corruptMove(`move ${request.operationId} staged no source row`);
  // note: The destination copy follows the source commit; re-running this is the replay. It is copied
  // from the RECORDED row, so a resume carries the frozen payload the move was admitted on.
  await writeCollaborationStage(destination, ({ db, authority }) => {
    assertDestinationReady(authority, db, request);
    if (readIssueMove(db, request.operationId, "destination") !== null) return;
    recordIssueMove(db, {
      operationId: request.operationId,
      role: "destination",
      requestHash: row.requestHash,
      issueRef: row.issueRef,
      sourceIssueId: row.sourceIssueId,
      destinationIssueId: null,
      sourceAuthority: row.sourceAuthority,
      destinationAuthority: row.destinationAuthority,
      destinationProject: row.destinationProject,
      actor: row.actor,
      reason: row.reason,
      phase: "staged",
      payloadJson: row.payloadJson,
      payloadDigest: row.payloadDigest,
      stagedCounts: row.stagedCounts,
      sourceStoreId: row.sourceStoreId,
      sourceEpoch: row.sourceEpoch,
      removedSyncRows: 0,
    });
  });
}

/**
 * invariant: Verification compares the destination staging with the source row and never advances past
 * a mismatch: the move discards first, so the source record is byte-identical and the destination row
 * is gone. Discarding here is the whole recovery of a refused verification.
 */
export async function verifyMove(context: StoreContext, request: MoveRequest): Promise<void> {
  const { row: source } = await requireSourceRow(context, request, "verify");
  const destination = await destinationLaneOf(request.destinationAuthority);
  const staged = await destinationRowIn(destination, request.operationId);
  // invariant: Only a staged source is verified. A source already past `staged` was verified against
  // this same payload, so the step it left undone is the destination copy's own advance.
  if (source.phase === "staged") {
    const mismatch =
      staged === null
        ? `the destination authority ${request.destinationAuthority} holds no staged copy of ${source.issueRef}`
        : stagedMismatch(source, staged);
    if (mismatch !== null) {
      await discardMove(context, request);
      throw new StoreError(
        "collaboration.operation-partial",
        `Move ${request.operationId} failed verification: ${mismatch}. It is discarded: the source record ` +
          `${String(source.sourceIssueId)} is untouched and the destination staging is deleted.`,
        {
          operation_id: request.operationId,
          issue_ref: source.issueRef,
          phase: "discarded",
          mismatch,
          recovery:
            "Reissue the move under a new --operation-id once the destination authority holds what the source carries; the " +
            "source record was never modified.",
        },
      );
    }
    await runMoveTransition(context, request, "verified", (handle) => {
      advanceRowTo(handle.db, request.operationId, "source", "verified");
    });
  }
  await writeCollaborationStage(destination, ({ db }) => {
    advanceRowTo(db, request.operationId, "destination", "verified");
  });
}

/**
 * invariant: The membership switch commits the SOURCE row first, then admits into the destination. A
 * source row at `switched` whose admission did not land is the window the topology accepts: a read
 * names it (`collaboration.operation-partial`) and the same command closes it.
 *
 * invariant: The admission prerequisites are proved BEFORE that commit AND again inside the
 * destination write transaction. A refused admission after the switch leaves the record presented by
 * neither lane, so a collision or a missing identity is a refusal while this lane is still the
 * member; and because another destination writer can insert a record under the same reference
 * between the preflight and the admission, the transaction that adopts or inserts re-runs the whole
 * predicate and adopts only the image the move froze.
 */
export async function switchMove(context: StoreContext, request: MoveRequest): Promise<void> {
  const { row: source, resume } = await requireSourceRow(context, request, "switch");
  const destination = await destinationLaneOf(request.destinationAuthority);
  const admitted = await destinationRowIn(destination, request.operationId);
  if (source.phase === "switched" && admitted?.destinationIssueId != null) return;
  // invariant: A destination that claimed the discard is the winner of the discard/switch race: the
  // record is no longer admissible there, and the same command's --discard branch finishes it.
  if (admitted?.phase === "discarded") {
    throw new StoreError(
      "collaboration.operation-partial",
      `Move ${request.operationId} was discarded in ${request.destinationAuthority}, so its record can no longer be ` +
        `admitted there. Nothing was modified.`,
      {
        operation_id: request.operationId,
        phase: source.phase,
        recovery: `Finish the discard instead of admitting: \`${resume} --discard\`.`,
      },
    );
  }
  if (source.phase !== "verified" && source.phase !== "switched") {
    throw new StoreError(
      "collaboration.operation-partial",
      `Move ${request.operationId} is at phase ${source.phase}, so it cannot switch: only a verified move becomes the ` +
        `destination's member. Nothing was modified.`,
      {
        operation_id: request.operationId,
        phase: source.phase,
        recovery: `Reissue the same move to resume from that phase: \`${resume}\`.`,
      },
    );
  }
  const copy = JSON.parse(source.payloadJson) as MoveCopy;
  const counts = JSON.parse(source.stagedCounts) as MoveCounts;
  // note: The RECORDED request is what admission writes. A replay's values are equal to it — the
  // binding refuses any difference — and this states that the membership row carries the request the
  // move was staged under rather than whatever a later attempt passed.
  const bound: MoveRequest = { ...request, actor: source.actor, reason: source.reason };
  // note: The preflight owns its own destination read: it must see the same lane state the admission
  // will, and a refusal must leave the source row where it is.
  await readCollaborationStage(destination, ({ db, authority }) => {
    assertDestinationReady(authority, db, request);
    assertAdmissible(db, bound, copy, counts);
  });
  // note: The preflight/write boundary: a destination writer that commits HERE is invisible to the
  // preflight, so only the admission transaction's own re-check can refuse it.
  await moveGapForTest?.("switch");
  await runMoveTransition(context, request, "switched", (handle) => {
    advanceRowTo(handle.db, request.operationId, "source", "switched");
  });
  await writeCollaborationStage(destination, ({ db, authority }) => {
    if (authority.state !== "active") {
      throw new StoreError(
        "collaboration.not-active",
        `The destination authority ${request.destinationAuthority} is ${authority.state}; it cannot admit a record now. ` +
          `Nothing was admitted, and the same command closes the move once that lane is active.`,
        {
          repoKey: request.destinationAuthority,
          recovery: `Publish that destination lane, then reissue the same move: \`${resume}\`.`,
        },
      );
    }
    const row = readIssueMove(db, request.operationId, "destination");
    if (row === null) throw corruptMove(`move ${request.operationId} lost its destination row before admission`);
    if (row.destinationIssueId !== null) return;
    // invariant: The whole admission predicate runs in THIS transaction. The occupant read here is
    // the one the adoption or the insert depends on, so a record inserted after the preflight is
    // compared with the frozen copy instead of being adopted by reference.
    assertAdmissible(db, bound, copy, counts);
    admitMoveCopy(db, bound, copy, counts);
  });
}

/**
 * invariant: The destination admission is one transaction: a display id from the destination's own
 * counter, an identity recomputed for the destination project, then the record and every carried row
 * in foreign-key order, then the destination row's `switched` phase with the id it allocated. Both
 * sides of an outgoing relation are stored in the shape the destination can address: a local target
 * when the destination already holds it, a `to_ref` otherwise.
 *
 * note: The caller re-proves this transaction's admission predicate immediately before this call, so
 * the collision and identity refusals are stated once there; the count check IS repeated because a
 * payload that disagrees with its own counts is a damaged ledger, not a request outcome.
 */
function admitMoveCopy(db: StoreDb, request: MoveRequest, copy: MoveCopy, counts: MoveCounts): void {
  if (counts.relations !== copy.relations.length) {
    throw corruptMove(
      `move ${request.operationId} recorded ${String(counts.relations)} relations but froze ${String(copy.relations.length)}`,
    );
  }
  const at = nowRfc3339();
  const issue = copy.issue;
  const issueRef = String(issue.issue_ref);
  const existing = db.prepare("select id from issues where issue_ref = ?").get(issueRef) as { id: string } | undefined;
  let issueId = existing?.id ?? null;
  if (issueId === null) {
    // note: The preflight admitted this payload, so its first occurrence exists; the assertion keeps a
    // corrupted ledger from reaching the identity computation below.
    const first = copy.occurrences[0]!;
    const identityKey = computeIdentityKey(
      request.destinationProject,
      String(first.source_identity),
      String(first.root_cause_key),
      String(first.acceptance_key),
    );
    issueId = allocateIssueId(db);
    const revision = Number(issue.revision) + 1;
    db.prepare(
      "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, owner, registered_at, " +
        "closed_at, closure_note, created_at, updated_at, revision, provider, external_id, url, identity_key, milestone_id, issue_ref) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', null, null, ?, null, ?)",
    ).run(
      issueId,
      request.destinationProject,
      issue.title,
      issue.kind,
      issue.severity,
      issue.disposition,
      issue.impact,
      issue.acceptance,
      issue.owner,
      issue.registered_at,
      issue.closed_at,
      issue.closure_note,
      issue.created_at,
      at,
      revision,
      identityKey,
      issueRef,
    );
    for (const row of copy.occurrences) {
      db.prepare(
        "insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, " +
          "location, observed_behavior, evidence_json, discovered_at, recorded_at, imported) " +
          "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(issueId, row.occurrence_key, row.source_kind, row.source_identity, row.root_cause_key, row.acceptance_key,
        row.location, row.observed_behavior, row.evidence_json, row.discovered_at, row.recorded_at, row.imported);
    }
    for (const row of copy.provenance) {
      db.prepare(
        "insert into provenance(issue_id, kind, target, source_hash, legacy_project, legacy_bucket, legacy_entry_id, " +
          "legacy_json, imported_at, origin) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(issueId, row.kind, row.target, row.source_hash, row.legacy_project, row.legacy_bucket, row.legacy_entry_id,
        row.legacy_json, row.imported_at, row.origin);
    }
    for (const row of copy.transitions) {
      db.prepare(
        "insert into issue_transitions(issue_id, from_disposition, to_disposition, actor, occurred_at, recorded_at, reason, " +
          "evidence_json, imported, issue_revision) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(issueId, row.from_disposition, row.to_disposition, row.actor, row.occurred_at, row.recorded_at, row.reason,
        row.evidence_json, row.imported, row.issue_revision);
    }
    for (const row of copy.projectMoves) {
      db.prepare(
        "insert into issue_project_moves(issue_id, from_project_id, to_project_id, actor, reason, occurred_at, recorded_at, " +
          "issue_revision) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(issueId, row.from_project_id, row.to_project_id, row.actor, row.reason, row.occurred_at, row.recorded_at,
        row.issue_revision);
    }
    for (const edge of copy.relations) {
      const target = db.prepare("select id from issues where issue_ref = ?").get(edge.toRef) as { id: string } | undefined;
      if (target === undefined) {
        db.prepare("insert into relations(from_issue, relation, to_ref) values (?, ?, ?)").run(issueId, edge.relation, edge.toRef);
      } else if (edge.relation === "related" && issueId > target.id) {
        db.prepare("insert into relations(from_issue, relation, to_issue) values (?, ?, ?)").run(target.id, edge.relation, issueId);
      } else {
        db.prepare("insert into relations(from_issue, relation, to_issue) values (?, ?, ?)").run(issueId, edge.relation, target.id);
      }
    }
    // note: The membership itself is one project-move row: the record's history says which project it
    // entered, exactly as a local project move records one.
    db.prepare(
      "insert into issue_project_moves(issue_id, from_project_id, to_project_id, actor, reason, occurred_at, recorded_at, " +
        "issue_revision) values (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(issueId, String(issue.project_id), request.destinationProject, request.actor, request.reason, at, at, revision);
  }
  // invariant: Resolution on arrival is part of this same transaction: every unresolved edge the
  // lane already holds to this reference localises to the admitted display id, keeping the exact
  // shape a writer would have produced (canonical order for 'related').
  for (const edge of db
    .prepare("select from_issue as fromIssue, relation from relations where to_ref = ?")
    .all(issueRef) as Array<{ fromIssue: string; relation: string }>) {
    db.prepare("delete from relations where from_issue = ? and relation = ? and to_ref = ?").run(
      edge.fromIssue,
      edge.relation,
      issueRef,
    );
    if (edge.relation === "related" && edge.fromIssue > issueId) {
      db.prepare("insert into relations(from_issue, relation, to_issue) values (?, ?, ?)").run(issueId, edge.relation, edge.fromIssue);
    } else {
      db.prepare("insert into relations(from_issue, relation, to_issue) values (?, ?, ?)").run(edge.fromIssue, edge.relation, issueId);
    }
  }
  advanceRowTo(db, request.operationId, "destination", "verified");
  advanceIssueMove(db, {
    operationId: request.operationId,
    role: "destination",
    from: "verified",
    to: "switched",
    destinationIssueId: issueId,
  });
}

/**
 * invariant: Publication happens once per operation id and is the one destructive step. The source row
 * leaves the blocking set FIRST in the same transaction (or the lane's own trigger refuses the
 * publication it exists to allow), then the record's incoming edges become `to_ref` edges so nothing in
 * this lane still names a record that is leaving, then its children and the record are deleted. The
 * count of rewritten edges is verified against the staged count: a relation that landed mid-flight
 * rolls the whole publication back.
 */
export async function publishMove(context: StoreContext, request: MoveRequest): Promise<void> {
  const { row: source, resume } = await requireSourceRow(context, request, "publish");
  if (source.phase === "published") return;
  if (source.phase !== "switched") {
    throw new StoreError(
      "collaboration.operation-partial",
      `Move ${request.operationId} is at phase ${source.phase}, so it cannot publish: only a switched move deletes its source ` +
        `record. Nothing was modified.`,
      {
        operation_id: request.operationId,
        phase: source.phase,
        recovery: `Reissue the same move to resume from that phase: \`${resume}\`.`,
      },
    );
  }
  // invariant: Publication deletes the only source copy, so it never runs while the destination has
  // not admitted the record: that would lose it. A refused admission leaves the source switched and
  // read-only, and the same command resumes the switch instead.
  const destination = await destinationLaneOf(source.destinationAuthority);
  const admitted = await destinationRowIn(destination, request.operationId);
  if (admitted?.destinationIssueId == null) {
    throw new StoreError(
      "collaboration.operation-partial",
      `Move ${request.operationId} has not been admitted by ${source.destinationAuthority} yet, so publishing would delete ` +
        `the only copy of the record. Nothing was modified.`,
      {
        operation_id: request.operationId,
        phase: "switched",
        recovery:
          `Reissue the same move: it resumes at the destination admission and publishes once that has landed; nothing is lost. ` +
          `\`${resume}\``,
      },
    );
  }
  const counts = JSON.parse(source.stagedCounts) as MoveCounts;
  await runMoveTransition(context, request, "published", (handle) => {
    const { db } = handle;
    const row = readIssueMove(db, request.operationId, "source");
    if (row === null) throw corruptMove(`move ${request.operationId} lost its source row before publication`);
    if (row.phase === "published") return;
    advanceIssueMove(db, { operationId: request.operationId, role: "source", from: row.phase, to: "published" });
    removeSourceRecord(db, row, counts);
  });
}

/**
 * invariant: The one destructive body: the record's incoming edges become `to_ref` edges, then its
 * children and the record are deleted. The rewritten count is verified against the staged count, so
 * a relation that landed mid-flight rolls the whole publication back. Shared by every publication
 * route, which differ only in how they proved the destination.
 */
function removeSourceRecord(db: StoreDb, row: IssueMoveRecord, counts: MoveCounts): void {
  const issueId = row.sourceIssueId;
  // note: An incoming edge cannot keep a local target that is leaving; it becomes the moved
  // record's stable reference, which is the unresolved shape both local readers already render.
  // invariant: The staged incoming count is a ceiling, not a target: an edge whose OWNER already
  // published went away with that record's own delete, so the live set may hold fewer rows than
  // the freeze recorded — but never more, because the lane's triggers refuse every insert, update
  // and delete an in-flight record touches. The rewrite therefore rewrites the edges still anchored
  // to a record this lane holds and refuses when it passes the frozen count: a relation that landed
  // mid-flight rolls the whole publication back.
  const rewritten = db
    .prepare("update relations set to_issue = null, to_ref = ? where to_issue = ? and from_issue in (select id from issues)")
    .run(row.issueRef, issueId) as { changes?: number };
  const rewrittenCount = Number(rewritten?.changes ?? 0);
  if (rewrittenCount > counts.relationsLeftBehind) {
    throw new StoreError(
      "collaboration.operation-partial",
      `Move ${row.operationId} counted ${String(counts.relationsLeftBehind)} incoming relation(s) when it was staged, but ` +
        `this publication rewrote ${String(rewrittenCount)}: a relation landed while the move was in flight. The publication ` +
        `rolled back and the record is unchanged.`,
      {
        operation_id: row.operationId,
        issue_id: issueId,
        expected: counts.relationsLeftBehind,
        rewritten: rewrittenCount,
        recovery:
          "Reissue the same move once no writer holds this record; the staged payload and the source record are unchanged.",
      },
    );
  }
  db.prepare("delete from relations where from_issue = ?").run(issueId);
  const removedSyncRows = countOf(db, "select count(*) as n from issue_sync_state where local_id = ?", issueId);
  db.prepare("delete from issue_sync_state where local_id = ?").run(issueId);
  db.prepare("delete from occurrences where issue_id = ?").run(issueId);
  db.prepare("delete from issue_transitions where issue_id = ?").run(issueId);
  db.prepare("delete from provenance where issue_id = ?").run(issueId);
  db.prepare("delete from issue_project_moves where issue_id = ?").run(issueId);
  db.prepare("delete from issues where id = ?").run(issueId);
  db.prepare("update issue_moves set removed_sync_rows = ?, updated_at = ? where operation_id = ? and role = 'source'").run(
    removedSyncRows,
    nowRfc3339(),
    row.operationId,
  );
}

/**
 * invariant: Discard never touches the record: the source row leaves the blocking set and becomes
 * `discarded`, which restores every source write, and the destination staging is then deleted so a
 * half-written copy never outlives its move.
 *
 * invariant: A switch that never admitted its record is discardable, because the destination then holds
 * no member of it. The no-admission decision and the admission itself are the SAME destination write
 * transaction: discard CLAIMS the destination row as `discarded` there, and admission refuses a claimed
 * row. Whichever commits first therefore wins, so the record is never both restored here and a member
 * there. A destination row that does not exist yet is claimed too, because a staging re-created after
 * this decision must not be admitted.
 */
export async function discardMove(context: StoreContext, request: MoveRequest): Promise<MoveReceipt> {
  const { row: before, resume } = await requireSourceRow(context, request, "discard");
  if (before.phase === "published") {
    throw new StoreError(
      "collaboration.move-phase-invalid",
      `Move ${request.operationId} already published, so its destination copy is the record and there is nothing to discard. ` +
        `Nothing was modified.`,
      { operation_id: request.operationId, phase: before.phase, allowed: [] },
    );
  }
  // invariant: Discard un-freezes the record, so the base it honours is the RECORD's revision, the
  // same CAS every route that reads a local record carries. The store revision is deliberately not
  // compared: a move's own phase commits advance it, so the value a caller read before staging is
  // already stale here, and the run that finishes an interrupted discard would refuse itself. Only a
  // row already `discarded` skips the check — that run performs no transition, so it replays a base
  // the first run already consumed.
  if (before.phase !== "discarded") {
    const lane = await openCollaborationStore(context, "read");
    try {
      assertMoveBase(lane.db, { ...request, expectedStoreRevision: undefined });
    } finally {
      lane.close();
    }
  }
  const destination = await destinationLaneOf(before.destinationAuthority);
  const staged = await destinationRowIn(destination, request.operationId);
  if (staged?.destinationIssueId != null) throw admittedDiscardRefusal(before, resume, staged.destinationIssueId);
  // note: The read/write boundary: an admission that commits HERE is invisible to the read above, so
  // only the claim transaction's own re-check can refuse it.
  await moveGapForTest?.("discard");
  await writeCollaborationStage(destination, ({ db }) => {
    const row = readIssueMove(db, request.operationId, "destination");
    if (row === null) {
      // invariant: Claiming an absent staging row is what stops a later re-stage from being admitted
      // under a move this lane already decided to abandon.
      recordIssueMove(db, { ...before, role: "destination", destinationIssueId: null, phase: "discarded" });
      return;
    }
    if (row.destinationIssueId !== null) throw admittedDiscardRefusal(before, resume, row.destinationIssueId);
    if (row.phase !== "discarded") advanceRowTo(db, request.operationId, "destination", "discarded");
  });
  if (before.phase !== "discarded") {
    await runMoveTransition(context, request, "discarded", (handle) => {
      advanceRowTo(handle.db, request.operationId, "source", "discarded");
    });
  }
  await deleteDestinationStaging(destination, request.operationId);
  return {
    operationId: request.operationId,
    phase: "discarded",
    issueRef: before.issueRef,
    sourceIssueId: before.sourceIssueId ?? request.sourceIssueId,
    destinationIssueId: null,
    destinationAuthority: before.destinationAuthority,
    destinationProject: before.destinationProject,
    resumedFrom: before.phase,
  };
}

/**
 * invariant: `--discard` on a cross-authority move. A one-checkout move keeps BOTH ledger halves in
 * lanes this checkout can open, so one run releases both and the source record is writable again as
 * soon as its source row leaves the blocking set. Before the switch neither side holds the member,
 * which is exactly the window in which abandoning is lossless. Anything else refuses: a source
 * checkout that cannot read the peer lane holds only the source half, and a destination
 * checkout never holds the source half — releasing one half alone would leave a move no command
 * here can finish.
 */
export async function discardAcrossAuthorities(context: StoreContext, request: MoveRequest): Promise<MoveReceipt> {
  const own = resolveCollaborationLocation(context);
  const role: IssueMoveRole = own.repoKey === request.destinationAuthority ? "destination" : "source";
  const destinationMode = await readLaneMode(collaborationLocationOfRepoKey(request.destinationAuthority, "local"));
  // invariant: A move this lane never recorded refuses by name before any topology question — "no
  // such move here" is the cause the operator can act on. A remote checkout skips the probe: it has
  // no local lane to read (the open would refuse with a bind recovery a discard cannot use), and the
  // topology refusal below is its honest cause.
  if (role === "source" && own.mode !== "remote" && (await boundSourceRow(context, request)) === null) {
    throw noSuchMove(request.operationId, "discard");
  }
  // invariant: Only the SOURCE checkout of a one-checkout move holds both halves reachably.
  if (role === "source" && own.mode !== "remote" && destinationMode !== null && destinationMode !== "remote") {
    return discardMove(context, request);
  }
  if (role === "destination") {
    let sourceAuthority: string | null = null;
    try {
      const lane = await openCollaborationStore(context, "read");
      try {
        sourceAuthority = readIssueMove(lane.db, request.operationId, "destination")?.sourceAuthority ?? null;
      } finally {
        lane.close();
      }
    } catch {
      // note: A destination lane that does not open names no source authority; the recovery still
      // names the one checkout that can release both halves.
      sourceAuthority = null;
    }
    const peer = sourceAuthority === null ? "the move's source checkout" : `the source checkout of ${sourceAuthority}`;
    throw new StoreError(
      "collaboration.mode-unavailable",
      `Move ${request.operationId} keeps its source ledger row in the peer authority, which this destination checkout ` +
        `cannot open, and a discard releases both halves in one run \u2014 only a move between two lanes this checkout can ` +
        `open admits that. Nothing was modified.`,
      {
        operation_id: request.operationId,
        role,
        ...(sourceAuthority === null ? {} : { source_authority: sourceAuthority }),
        recovery: `Run this --discard from ${peer}, which holds both ledger halves.`,
      },
    );
  }
  const cause =
    own.mode === "remote"
      ? `this checkout's own lane is a remote cache for ${own.repoKey}, so the source half of a move is a ` +
        `ledger half it never held`
      : destinationMode === null
        ? `this checkout holds no readable lane for ${request.destinationAuthority} \u2014 absent or unclassifiable ` +
          `\u2014 so it holds only the source half`
        : `the lane ${request.destinationAuthority} records is ${String(destinationMode)}, which spans a \`local\`/\`remote\` ` +
          `boundary, so it holds only the source half`;
  const recovery =
    own.mode === "remote"
      ? `Run this --discard from the source checkout that staged the move: the local ledger half it holds is ` +
        `what a discard releases.`
      : `The two-checkout exchange that releases each half in its own checkout is not part of this layer; the move's ` +
        `record stays frozen by its source row.`;
  throw new StoreError(
    "collaboration.mode-unavailable",
    `Move ${request.operationId} cannot be discarded here: ${cause}. A discard releases both halves in one run, which ` +
      `only a move between two lanes this checkout can open admits. Nothing was modified.`,
    { operation_id: request.operationId, role, recovery },
  );
}

/**
 * invariant: The one staged route. It resumes from whatever phase the source row already holds and
 * stops at the phase the caller asked for, so the same command completes a move interrupted at any
 * boundary. Every step is idempotent by the move's operation id.
 *
 * invariant: A terminal `discarded` row is finished, not merely reported: discard commits the source
 * first and deletes the destination staging after, so an interruption between those two commits leaves
 * work this replay alone can see. `published` needs nothing, because publication already deleted both
 * sides.
 */
export async function moveAcrossAuthorities(
  context: StoreContext,
  request: MoveRequest,
  target: "staged" | "verified" | "switched" | "published" = "published",
): Promise<MoveReceipt> {
  const before = await boundSourceRow(context, request);
  if (before !== null && before.phase === "discarded") {
    await deleteDestinationStaging(await destinationLaneOf(before.destinationAuthority), request.operationId);
    return receiptOf(context, request, before.phase);
  }
  // invariant: A `published` row is the move's answer, never a step to repeat: publication already
  // deleted the source record, so it reports the phase it holds.
  if (before !== null && before.phase === "published") return receiptOf(context, request, before.phase);
  // invariant: A destination row that already claimed the discard is the winner of the discard/switch
  // race, so the same command finishes that discard instead of staging over the decision.
  if (before !== null) {
    const claimed = await destinationRowIn(await destinationLaneOf(before.destinationAuthority), request.operationId);
    if (claimed?.phase === "discarded") return discardMove(context, request);
  }
  // note: Always re-derive the staging step: it records the source row once and re-creates a lost
  // destination copy, so the same command closes a window either side of the switch.
  await stageMove(context, request);
  if (target !== "staged") {
    await verifyMove(context, request);
    if (target !== "verified") {
      await switchMove(context, request);
      if (target === "published") await publishMove(context, request);
    }
  }
  return receiptOf(context, request, before?.phase ?? null);
}

/** note: The receipt read back from the two persisted rows; nothing here is remembered across a call. */
async function receiptOf(
  context: StoreContext,
  request: MoveRequest,
  resumedFrom: IssueMovePhase | null,
): Promise<MoveReceipt> {
  const { row: source } = await requireSourceRow(context, request, "read");
  const destination = await destinationLaneOf(source.destinationAuthority);
  const destinationRow = await destinationRowIn(destination, request.operationId);
  return {
    operationId: request.operationId,
    phase: source.phase,
    issueRef: source.issueRef,
    sourceIssueId: source.sourceIssueId ?? request.sourceIssueId,
    destinationIssueId: destinationRow?.destinationIssueId ?? null,
    destinationAuthority: source.destinationAuthority,
    destinationProject: source.destinationProject,
    resumedFrom,
  };
}

/**
 * note: The refusal an issue write meets when the lane's own trigger froze its record. The trigger is
 * the fence, so this reads the blocking rows it fired for and reports the abort as
 * `collaboration.operation-partial` naming the move -- the operator then resumes or discards it
 * instead of retrying a write that can never land.
 */
export function frozenMoveRefusal(db: StoreDb, cause: unknown, recordId?: string): StoreError | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!message.includes("issue.move-in-progress")) return null;
  const rows = db
    .prepare(`select ${MOVE_COLUMNS} from issue_moves where role = 'source' and phase in ('staged','verified','switched') order by created_at`)
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const records = rows.map(rowToRecord);
  const blocking = records.map((row) => ({
    operation_id: row.operationId,
    issue_ref: row.issueRef,
    source_issue_id: row.sourceIssueId,
    phase: row.phase,
  }));
  // invariant: The record this write addressed names its own blocking move even while OTHER moves are
  // in flight beside it; only a write that names no record falls back to the lane-wide count.
  const own = recordId === undefined ? null : records.find((row) => row.sourceIssueId === recordId);
  const named = own ?? (records.length === 1 ? records[0]! : null);
  return new StoreError(
    "collaboration.operation-partial",
    `This write met \`issue.move-in-progress\`: ` +
      (named === null
        ? `${String(records.length)} cross-authority moves are in flight in this authority.`
        : `issue ${String(named.sourceIssueId)} is frozen by move ${named.operationId} in phase ${named.phase}.`) +
      ` A frozen record is read-only until its move publishes or is discarded, so the write was rolled back. Nothing was modified.`,
    {
      cause: "issue.move-in-progress",
      blocking_moves: blocking,
      recovery:
        named === null
          ? `Reissue each move named in blocking_moves (or discard it with its own --operation-id) and retry this write.`
          : `Reissue the move to finish it: \`${moveResumeCommand(db, named)}\`. To abandon it instead, ` +
            `run \`${moveDiscardCommand(db, named)}\` before the destination admits the record; then retry this write.`,
    },
  );
}

/** note: Whether `id` names a record this lane stopped presenting: a `switched` source row before its publication. */
export function switchedMoveFor(db: StoreDb, issueId: string): { operationId: string } | null {
  const blocked = blockingMoveFor(db, issueId);
  return blocked !== null && blocked.phase === "switched" ? { operationId: blocked.operationId } : null;
}

/**
 * invariant: A switched record has left this authority and its destination copy is the member; the
 * source stops presenting it until publication deletes it. A read names that gap instead of serving
 * a record two authorities could both claim, and it names the command that closes it: the same move,
 * with the recorded destination, both required revisions and the actor.
 */
export function assertPresented(db: StoreDb, issueId: string): void {
  const switched = switchedMoveFor(db, issueId);
  if (switched === null) return;
  const row = readIssueMove(db, switched.operationId, "source");
  if (row === null) throw corruptMove(`move ${switched.operationId} is blocking with no source row`);
  throw new StoreError(
    "collaboration.operation-partial",
    `Issue ${issueId} already belongs to the destination authority of move ${row.operationId}; this authority keeps it ` +
      `only until that move publishes, so it is not presented here. Reissue the move to publish it and release the display id.`,
    {
      issue_id: issueId,
      operation_id: row.operationId,
      phase: "switched",
      destination_authority: row.destinationAuthority,
      recovery:
        `Reissue \`${moveResumeCommand(db, row)}\` to publish the move, then read the record from ${row.destinationAuthority}.`,
    },
  );
}

/**
 * invariant: The predicate every LIST and COUNT adds. A `switched` source record has left this
 * authority — its destination copy is the member — so it is neither listed nor counted here until
 * publication removes it; a detail read refuses the same record by name (`assertPresented`).
 */
export const SWITCHED_NOT_PRESENTED_SQL =
  "not exists (select 1 from issue_moves m where m.role = 'source' and m.phase = 'switched' and m.source_issue_id = issues.id)";
