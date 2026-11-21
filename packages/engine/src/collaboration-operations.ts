/**
 * collaboration-operations.ts -- the internal composite frame of the four
 * admitted cross-domain operations (residual add, residual close, execution
 * registration, minimal import).
 *
 * The two authorities are separate SQLite stores, so one business action can no
 * longer be one transaction (the retired combined store handed `tx.db` to both
 * halves). It becomes three sequential phases instead, and every phase leaves
 * durable evidence:
 *
 * 1. PREPARE runs in the owning verb, in one execution transaction: authenticate,
 *    freeze the payload/tokens/target and record the reservation here in
 *    `execution_collaboration_intents`. That row IS the reservation: while it is
 *    `prepared`, every conflicting execution writer for the addressed plan row
 *    refuses (`assertNoForeignCompositeReservation`), so the facts the operation
 *    admitted cannot move underneath it. The same row makes an identical retry a
 *    resume (`resumeCompositeIntent`), a different payload a conflict, and a
 *    deterministic refusal a durable decline.
 * 2. APPLY runs in one collaboration write transaction: verify the frozen target
 *    stamp, execute the whole effect and commit its receipt in the SAME
 *    transaction. The receipt is the durable anchor a crashed finalize resumes
 *    from, so a lost response never applies the effect twice.
 * 3. FINALIZE runs in a second execution transaction: require the reservation,
 *    let the verb revalidate the frozen facts and commit the execution delta and
 *    its receipt, then mark the intent `confirmed` in that same transaction.
 *    Acknowledgement on the collaboration effect row is metadata only; a replay
 *    repairs it without repeating either business effect.
 *
 * A deterministic business refusal is recorded in the collaboration transaction
 * BEFORE the reservation is released (`declined`), so it can never apply later
 * under the same operation id. A transient/uncertain failure keeps the prepared
 * reservation and reports `collaboration.operation-partial`; nothing is deleted
 * on behalf of another attempt.
 *
 * Nothing here is public: only the admitted owning verb calls it, and only the
 * package index publishes the contract types (never a generic executor).
 */
import { withCollaborationWrite, type CollaborationStamp, type CollaborationStoreHandle } from "./collaboration-store.js";
import { isPlainObject } from "./coordination-write.js";
import {
  ExecutionError,
  assertActiveExecutionAuthority,
  withExecutionTransaction,
  type ExecutionContext,
  type ExecutionToken,
  type ExecutionTransaction,
} from "./execution-store.js";
import { StoreError, nowRfc3339, type StoreContext, type StoreDb } from "./store-db.js";

export type CompositeKind = "residual-add" | "residual-close" | "execution-register" | "execution-import";

/**
 * The local effect key: this execution authority generation plus the caller's
 * operation id. It is deliberately distinct from the caller-owned collaboration
 * idempotency namespace, so a composite receipt can never collide with a
 * standalone collaboration operation.
 */
export type CompositeKey = Readonly<{ executionStoreId: string; executionEpoch: number; operationId: string }>;

export type CompositeIntent = Readonly<{
  key: CompositeKey;
  kind: CompositeKind;
  requestHash: string;
  target: CollaborationStamp;
  scope: { workflowId: string | null; planId: string | null };
  actor: string;
  expectedExecution: ExecutionToken;
  frozenPayload: string;
}>;

export type CollaborationEffectReceipt = Readonly<{
  key: CompositeKey;
  requestHash: string;
  collaborationRevision: number;
  catalogRevision: number;
  committedAt: string;
  facts: string;
}>;

/** The recorded reservation, as the addressed plan row's exclusion and replay anchor. */
type StoredIntent = Readonly<{
  key: CompositeKey;
  kind: CompositeKind;
  requestHash: string;
  workflowId: string | null;
  planId: string | null;
  actor: string;
  expectedToken: string;
  reservedRevision: number;
  target: CollaborationStamp;
  frozenPayload: string;
  phase: "prepared" | "declined" | "confirmed";
  receiptJson: string | null;
  cause: DeclineCause | null;
}>;

/** The deterministic cause a declined composite carries into every replay. */
type DeclineCause = Readonly<{ code: string; message: string; details: Record<string, unknown> | null }>;

/** The durable collaboration half: one committed effect receipt or one recorded decline. */
type EffectOutcome =
  | { kind: "committed"; receipt: CollaborationEffectReceipt }
  | { kind: "declined"; cause: DeclineCause };

export type CompositeReservation = Readonly<{ outcome: "reserved" | "resume"; reservedRevision: number }>;

/**
 * Refusal codes that describe an unavailable or uncertain ENVIRONMENT rather
 * than a decision about this request. Everything else carrying a stable code is
 * a domain refusal and is declined durably.
 */
const RECOVERABLE_CODES: Readonly<Record<string, true>> = {
  "store.busy": true,
  "store.corrupt": true,
  "store.runtime-unsupported": true,
  "store.schema-unsupported": true,
  "store.not-active": true,
  "store.stale-epoch": true,
  "collaboration.not-initialized": true,
  "collaboration.not-active": true,
  "collaboration.unreadable": true,
  "collaboration.stale-binding": true,
  "execution.not-active": true,
  "execution.reentrant": true,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" && error.code !== "" ? error.code : null;
}

/** A coded domain refusal is deterministic; silence, a crash or an environment code is not. */
function isDeterministicRefusal(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && RECOVERABLE_CODES[code] !== true;
}

function corrupt(detail: string): StoreError {
  return new StoreError("store.corrupt", `${detail}; inspect the composite reservation ledger before retrying`);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw corrupt(`${what} is not a string`);
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(value: string, what: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw corrupt(`${what} is not valid JSON (${messageOf(error)})`);
  }
}

/**
 * The typed refusal recorded for an operation id reused with a different
 * semantic request. It is the one refusal that survives both stores: the
 * fingerprint is the idempotency key, not a re-usable slot.
 */
function intentConflict(intent: CompositeIntent, recordedHash: string | null): ExecutionError {
  return new ExecutionError(
    "execution.operation-conflict",
    `operation id ${JSON.stringify(intent.key.operationId)} is already recorded on this execution store epoch for a different ` +
      `semantic request. An operation id is an idempotency key, not a reusable slot: retry the admitted request unchanged, ` +
      `or use a new id for the new effect. Nothing was applied.`,
    {
      operation_id: intent.key.operationId,
      kind: intent.kind,
      recorded_fingerprint: recordedHash,
      requested_fingerprint: intent.requestHash,
      recovery:
        "Reissue the same domain verb with the operation id and semantic payload already admitted; a new payload needs a new operation id.",
    },
  );
}

/**
 * §3.1 the refusal of an operation on a plan row another composite currently
 * reserves. It names the pending operation and its supported completion, so the
 * caller never invents a second authority for the same row.
 */
function pendingReservationRefusal(input: {
  operationId: string;
  pendingOperationId: string;
  pendingKind: string;
  workflowId: string;
  planId: string;
}): ExecutionError {
  return new ExecutionError(
    "collaboration.operation-partial",
    `plan ${input.planId} of workflow ${input.workflowId} is reserved by pending composite operation ` +
      `${JSON.stringify(input.pendingOperationId)} (${input.pendingKind}); ${input.operationId === input.pendingOperationId ? "this operation" : `operation ${JSON.stringify(input.operationId)}`} cannot change the facts it will finalize. Finish or retry that operation first; nothing was modified.`,
    {
      operation_id: input.pendingOperationId,
      phase: "prepared",
      workflow_id: input.workflowId,
      plan_id: input.planId,
      blocked_operation_id: input.operationId,
      recovery:
        `Reissue the pending verb with the same --operation id and payload to resume and finalize it, or let its deterministic ` +
        `refusal be recorded; then retry this operation. The reservation is never abandoned automatically.`,
    },
  );
}

/** A recorded deterministic decline, re-raised with its original code and cause. */
function recordedRefusal(operationId: string, cause: DeclineCause | null): Error {
  const code = cause?.code ?? "collaboration.operation-partial";
  const message = cause?.message ?? `composite operation ${operationId} was declined before any effect`;
  const error = new Error(message) as Error & { code: string; details?: Record<string, unknown> };
  error.name = "RecordedCompositeRefusal";
  error.code = code;
  // The original refusal's machine facts survive the decline, so a replayed
  // refusal still names the entry/path/field the first attempt reported.
  error.details = {
    ...(cause?.details ?? {}),
    operation_id: operationId,
    phase: "declined",
    recovery:
      "This operation id was declined durably and its effect was never applied; issue the corrected request under a new operation id.",
  };
  return error;
}

/** §3.1 the frozen address of this intent must be the generation the transaction opened. */
function assertIntentGeneration(tx: ExecutionTransaction, intent: CompositeIntent): void {
  if (intent.key.executionStoreId === tx.storeId && intent.key.executionEpoch === tx.epoch) return;
  throw new StoreError(
    "collaboration.stale-binding",
    `The recorded intent belongs to execution store ${intent.key.executionStoreId} epoch ${intent.key.executionEpoch}, but ` +
      `this transaction addresses store ${tx.storeId} epoch ${tx.epoch}. A composite resumes only under the admitted authority; ` +
      `re-read the plan and reissue the verb, or inspect the collaboration cutover receipts.`,
    {
      recorded_store_id: intent.key.executionStoreId,
      recorded_epoch: intent.key.executionEpoch,
      current_store_id: tx.storeId,
      current_epoch: tx.epoch,
    },
  );
}

/**
 * A resumed intent must be the one this call froze. Transport freshness (the CAS
 * token the caller re-read) is deliberately excluded: an admitted reservation
 * whose plan row later moved is refreshed by re-admission, not treated as a
 * different business intent.
 */
function assertSameIntent(recorded: StoredIntent, intent: CompositeIntent): void {
  const same =
    recorded.kind === intent.kind &&
    recorded.requestHash === intent.requestHash &&
    recorded.actor === intent.actor &&
    recorded.workflowId === intent.scope.workflowId &&
    recorded.planId === intent.scope.planId &&
    recorded.frozenPayload === intent.frozenPayload &&
    recorded.target.repoKey === intent.target.repoKey &&
    recorded.target.mode === intent.target.mode &&
    recorded.target.storeId === intent.target.storeId &&
    recorded.target.epoch === intent.target.epoch;
  if (same) return;
  throw new ExecutionError(
    "execution.operation-conflict",
    `operation id ${JSON.stringify(intent.key.operationId)} is reserved for a different frozen intent. The reservation ` +
      `records what the first attempt admitted (payload, actor, scope and target authority); retry that exact intent, or use a ` +
      `new operation id. Nothing was applied.`,
    { operation_id: intent.key.operationId, kind: intent.kind },
  );
}

function readIntent(db: StoreDb, key: CompositeKey): StoredIntent | null {
  const row = db
    .prepare(
      "select kind, request_hash, workflow_id, plan_id, actor, expected_token, reserved_revision, target_json, " +
        "frozen_payload, phase, receipt_json, cause_code, cause_message, cause_details_json from execution_collaboration_intents " +
        "where execution_store_id = ? and execution_epoch = ? and operation_id = ?",
    )
    .get(key.executionStoreId, key.executionEpoch, key.operationId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const what = `execution_collaboration_intents(${key.executionEpoch},${key.operationId})`;
  const target = parseJson(text(row.target_json, `${what}.target_json`), `${what}.target_json`);
  if (!isPlainObject(target)) throw corrupt(`${what}.target_json carries no collaboration stamp`);
  const phase = text(row.phase, `${what}.phase`);
  if (phase !== "prepared" && phase !== "declined" && phase !== "confirmed") {
    throw corrupt(`${what}.phase is ${JSON.stringify(phase)}`);
  }
  const kind = text(row.kind, `${what}.kind`);
  if (kind !== "residual-add" && kind !== "residual-close" && kind !== "execution-register" && kind !== "execution-import") {
    throw corrupt(`${what}.kind is ${JSON.stringify(kind)}`);
  }
  if (typeof row.reserved_revision !== "number" || !Number.isSafeInteger(row.reserved_revision)) {
    throw corrupt(`${what}.reserved_revision is not a safe integer`);
  }
  const causeCode = nullableText(row.cause_code);
  const causeDetailsJson = nullableText(row.cause_details_json);
  return {
    key,
    kind,
    requestHash: text(row.request_hash, `${what}.request_hash`),
    workflowId: nullableText(row.workflow_id),
    planId: nullableText(row.plan_id),
    actor: text(row.actor, `${what}.actor`),
    expectedToken: text(row.expected_token, `${what}.expected_token`),
    reservedRevision: row.reserved_revision,
    target: {
      repoKey: text(target.repoKey, `${what}.target_json.repoKey`),
      mode: text(target.mode, `${what}.target_json.mode`) as CollaborationStamp["mode"],
      storeId: text(target.storeId, `${what}.target_json.storeId`),
      epoch: typeof target.epoch === "number" ? target.epoch : 0,
    },
    frozenPayload: text(row.frozen_payload, `${what}.frozen_payload`),
    phase,
    receiptJson: nullableText(row.receipt_json),
    cause:
      causeCode === null
        ? null
        : {
            code: causeCode,
            message: nullableText(row.cause_message) ?? "",
            details:
              causeDetailsJson === null
                ? null
                : ((parseJson(causeDetailsJson, `${what}.cause_details_json`) as Record<string, unknown> | null) ?? null),
          },
  };
}

/**
 * The exclusion half of the reservation: any OTHER pending composite on the same
 * addressed plan row. Every conflicting execution writer calls this before it
 * changes that row (`withExecutionPlanOperation`), and a second composite calls
 * it before it reserves, so the facts an operation admitted cannot move
 * underneath it while it is in flight.
 */
export function assertNoForeignCompositeReservation(
  tx: ExecutionTransaction,
  address: { workflowId: string; planId: string; operationId: string },
): void {
  const pending = tx.db
    .prepare(
      "select operation_id, kind from execution_collaboration_intents where execution_epoch = ? and phase = 'prepared' " +
        "and plan_id is not null and workflow_id = ? and plan_id = ? and operation_id != ?",
    )
    .get(tx.epoch, address.workflowId, address.planId, address.operationId) as
    | { operation_id?: unknown; kind?: unknown }
    | undefined;
  if (pending === undefined) return;
  throw pendingReservationRefusal({
    operationId: address.operationId,
    pendingOperationId: text(pending.operation_id, "execution_collaboration_intents.operation_id"),
    pendingKind: text(pending.kind, "execution_collaboration_intents.kind"),
    workflowId: address.workflowId,
    planId: address.planId,
  });
}

/** The same exclusion for a DIFFERENT owning verb: any pending reservation on this row blocks it. */
export function assertNoPendingCompositeReservation(
  tx: ExecutionTransaction,
  address: { workflowId: string; planId: string; operationId: string },
): void {
  const pending = tx.db
    .prepare(
      "select operation_id, kind from execution_collaboration_intents where execution_epoch = ? and phase = 'prepared' " +
        "and plan_id is not null and workflow_id = ? and plan_id = ?",
    )
    .get(tx.epoch, address.workflowId, address.planId) as { operation_id?: unknown; kind?: unknown } | undefined;
  if (pending === undefined) return;
  throw pendingReservationRefusal({
    operationId: address.operationId,
    pendingOperationId: text(pending.operation_id, "execution_collaboration_intents.operation_id"),
    pendingKind: text(pending.kind, "execution_collaboration_intents.kind"),
    workflowId: address.workflowId,
    planId: address.planId,
  });
}

/**
 * Record the reservation of one admitted composite, or resume the identical one.
 * The owning verb calls this INSIDE the execution transaction that authenticated
 * the caller, fenced the token and froze the payload, so the reservation and the
 * admission facts commit together.
 *
 * `revision` is the addressed row's revision at admission. A matching prepared
 * row keeps it; a row that moved while the reservation existed (a writer outside
 * the composite frame, or a re-opened lifecycle) is REFRESHED here, which is the
 * supported re-admission path: the frozen payload is never re-interpreted.
 */
export function reserveCompositeIntent(
  tx: ExecutionTransaction,
  intent: CompositeIntent,
  reservation: { revision: number },
): CompositeReservation {
  assertIntentGeneration(tx, intent);
  const row = readIntent(tx.db, intent.key);
  const now = nowRfc3339();
  if (row === null) {
    if (intent.scope.planId !== null && intent.scope.workflowId !== null) {
      assertNoForeignCompositeReservation(tx, {
        workflowId: intent.scope.workflowId,
        planId: intent.scope.planId,
        operationId: intent.key.operationId,
      });
    }
    tx.db
      .prepare(
        "insert into execution_collaboration_intents(execution_store_id, execution_epoch, operation_id, kind, request_hash, " +
          "workflow_id, plan_id, actor, expected_token, reserved_revision, target_json, frozen_payload, phase, created_at, updated_at) " +
          "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
      )
      .run(
        intent.key.executionStoreId,
        intent.key.executionEpoch,
        intent.key.operationId,
        intent.kind,
        intent.requestHash,
        intent.scope.workflowId,
        intent.scope.planId,
        intent.actor,
        intent.expectedExecution,
        reservation.revision,
        JSON.stringify(intent.target),
        intent.frozenPayload,
        now,
        now,
      );
    return { outcome: "reserved", reservedRevision: reservation.revision };
  }
  if (row.requestHash !== intent.requestHash) throw intentConflict(intent, row.requestHash);
  assertSameIntent(row, intent);
  if (row.phase === "declined") throw recordedRefusal(intent.key.operationId, row.cause);
  if (row.phase === "confirmed") throw intentConflict(intent, row.requestHash);
  if (row.reservedRevision !== reservation.revision) {
    tx.db
      .prepare(
        "update execution_collaboration_intents set reserved_revision = ?, updated_at = ? " +
          "where execution_store_id = ? and execution_epoch = ? and operation_id = ? and phase = 'prepared'",
      )
      .run(reservation.revision, now, intent.key.executionStoreId, intent.key.executionEpoch, intent.key.operationId);
  }
  return { outcome: "resume", reservedRevision: reservation.revision };
}

/**
 * The single collaboration revision advance of one accepted effect transaction.
 * The composed domain bodies join it through `ComposedTransactionRevision`
 * instead of advancing the shared counter for themselves, exactly as the
 * combined store's frame advanced it once before composing them. This is the
 * same statement `issue.ts` keeps private for its own public verbs.
 */
export function advanceCollaborationRevision(handle: CollaborationStoreHandle): number {
  handle.db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
  const row = handle.db
    .prepare("select revision from collaboration_meta where id = 1")
    .get() as { revision?: unknown } | undefined;
  if (typeof row?.revision !== "number") {
    throw corrupt("collaboration_meta.revision is unreadable after the advance");
  }
  return row.revision;
}

/** One durable collaboration row: a committed effect receipt or a recorded decline. */
function readEffect(db: StoreDb, key: CompositeKey): { requestHash: string; outcome: EffectOutcome } | null {
  const row = db
    .prepare(
      "select request_hash, result_json from collaboration_operations where key_space = 'composite' " +
        "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
    )
    .get(key.executionStoreId, key.executionEpoch, key.operationId) as
    | { request_hash?: unknown; result_json?: unknown }
    | undefined;
  if (row === undefined) return null;
  const what = `collaboration_operations(${key.operationId})`;
  const requestHash = text(row.request_hash, `${what}.request_hash`);
  const parsed = parseJson(text(row.result_json, `${what}.result_json`), `${what}.result_json`);
  if (!isPlainObject(parsed)) throw corrupt(`${what}.result_json carries no effect envelope`);
  if (isPlainObject(parsed.declined)) {
    return {
      requestHash,
      outcome: {
        kind: "declined",
        cause: {
          code: text(parsed.declined.code, `${what}.result_json.declined.code`),
          message: text(parsed.declined.message, `${what}.result_json.declined.message`),
          details: isPlainObject(parsed.declined.details) ? parsed.declined.details : null,
        },
      },
    };
  }
  if (!isPlainObject(parsed.receipt)) throw corrupt(`${what}.result_json carries neither a receipt nor a decline`);
  return { requestHash, outcome: { kind: "committed", receipt: parsed.receipt as unknown as CollaborationEffectReceipt } };
}

/**
 * Phase 2: apply the whole collaboration effect and commit its receipt in one
 * transaction. The frozen target stamp is re-verified under the writer lock, so
 * a different repository/mode/store generation refuses `collaboration.stale-binding`
 * before any effect runs. A row already recorded under this local key is
 * replayed (effect receipt) or re-raised (decline) instead of applied again.
 */
async function applyCollaborationEffect(
  context: StoreContext,
  intent: CompositeIntent,
  apply: (handle: CollaborationStoreHandle) => string,
): Promise<EffectOutcome> {
  return withCollaborationWrite(
    context,
    (handle) => {
      const existing = readEffect(handle.db, intent.key);
      if (existing !== null) {
        if (existing.requestHash !== intent.requestHash) throw intentConflict(intent, existing.requestHash);
        return existing.outcome;
      }
      const facts = apply(handle);
      const meta = handle.db
        .prepare("select revision, catalog_revision from collaboration_meta where id = 1")
        .get() as { revision?: unknown; catalog_revision?: unknown } | undefined;
      if (typeof meta?.revision !== "number" || typeof meta.catalog_revision !== "number") {
        throw corrupt("collaboration_meta revisions are unreadable after the effect");
      }
      const receipt: CollaborationEffectReceipt = {
        key: intent.key,
        requestHash: intent.requestHash,
        collaborationRevision: meta.revision,
        catalogRevision: meta.catalog_revision,
        committedAt: nowRfc3339(),
        facts,
      };
      handle.db
        .prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) values ('composite', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          intent.key.operationId,
          intent.key.executionStoreId,
          intent.key.executionEpoch,
          intent.requestHash,
          JSON.stringify({ receipt, acknowledgedAt: null }),
          receipt.collaborationRevision,
          receipt.catalogRevision,
          receipt.committedAt,
        );
      return { kind: "committed", receipt };
    },
    intent.target,
  );
}

/**
 * Record a deterministic refusal under this effect key, in its own collaboration
 * transaction and WITHOUT business effects or a revision advance. The write is
 * coordinated with a concurrent same-id attempt: if that attempt committed the
 * effect first, its receipt is returned (this attempt then finalizes it); if a
 * decline already exists, that cause is returned. Only when nothing exists does
 * this attempt record the decline, so no attempt deletes another's evidence.
 */
async function declineEffect(context: StoreContext, intent: CompositeIntent, error: unknown): Promise<EffectOutcome> {
  const details =
    error !== null && typeof error === "object" && "details" in error && isPlainObject(error.details) ? error.details : null;
  const cause: DeclineCause = {
    code: codeOf(error) ?? "collaboration.operation-partial",
    message: messageOf(error),
    details,
  };
  return withCollaborationWrite(
    context,
    (handle) => {
      const existing = readEffect(handle.db, intent.key);
      if (existing !== null) {
        if (existing.requestHash !== intent.requestHash) throw intentConflict(intent, existing.requestHash);
        return existing.outcome;
      }
      const meta = handle.db
        .prepare("select revision, catalog_revision from collaboration_meta where id = 1")
        .get() as { revision?: unknown; catalog_revision?: unknown } | undefined;
      if (typeof meta?.revision !== "number" || typeof meta.catalog_revision !== "number") {
        throw corrupt("collaboration_meta revisions are unreadable while recording a decline");
      }
      handle.db
        .prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) values ('composite', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          intent.key.operationId,
          intent.key.executionStoreId,
          intent.key.executionEpoch,
          intent.requestHash,
          JSON.stringify({ declined: { ...cause, at: nowRfc3339() } }),
          meta.revision,
          meta.catalog_revision,
          nowRfc3339(),
        );
      return { kind: "declined", cause };
    },
    intent.target,
  );
}

/** Mark the execution reservation declined AFTER its collaboration decline is durable. */
async function markDeclined(context: StoreContext, intent: CompositeIntent, cause: DeclineCause): Promise<void> {
  try {
    await withExecutionTransaction(context, (tx) => {
      assertIntentGeneration(tx, intent);
      const row = readIntent(tx.db, intent.key);
      if (row === null || row.phase !== "prepared") return;
      tx.db
        .prepare(
          "update execution_collaboration_intents set phase = 'declined', cause_code = ?, cause_message = ?, " +
            "cause_details_json = ?, updated_at = ? " +
            "where execution_store_id = ? and execution_epoch = ? and operation_id = ? and phase = 'prepared'",
        )
        .run(
          cause.code,
          cause.message,
          cause.details === null ? null : JSON.stringify(cause.details),
          nowRfc3339(),
          intent.key.executionStoreId,
          intent.key.executionEpoch,
          intent.key.operationId,
        );
    });
  } catch {
    // The collaboration decline is durable and is replayed by the next attempt,
    // which records this phase then; nothing is applied either way.
  }
}

/** Repair a missing acknowledgement on an already committed effect row. Metadata only. */
async function acknowledgeEffect(context: StoreContext, intent: CompositeIntent, receipt: CollaborationEffectReceipt): Promise<boolean> {
  try {
    await withCollaborationWrite(
      context,
      (handle) => {
        handle.db
          .prepare(
            "update collaboration_operations set result_json = ? where key_space = 'composite' " +
              "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
          )
          .run(
            JSON.stringify({ receipt, acknowledgedAt: nowRfc3339() }),
            receipt.key.executionStoreId,
            receipt.key.executionEpoch,
            receipt.key.operationId,
          );
      },
      intent.target,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Replay-time acknowledgement repair: reads the committed effect row by its local
 * key and records the acknowledgement if it is still missing. Called from the
 * replay path OUTSIDE any execution transaction, so no write transactions nest.
 */
export async function repairCompositeAcknowledgement(context: StoreContext, key: CompositeKey): Promise<void> {
  try {
    await withCollaborationWrite(context, (handle) => {
      const row = handle.db
        .prepare(
          "select result_json from collaboration_operations where key_space = 'composite' " +
            "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
        )
        .get(key.executionStoreId, key.executionEpoch, key.operationId) as { result_json?: unknown } | undefined;
      if (row === undefined || typeof row.result_json !== "string") return;
      const parsed = parseJson(row.result_json, "collaboration_operations.result_json");
      if (!isPlainObject(parsed) || !isPlainObject(parsed.receipt) || typeof parsed.acknowledgedAt === "string") return;
      handle.db
        .prepare(
          "update collaboration_operations set result_json = ? where key_space = 'composite' " +
            "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
        )
        .run(
          JSON.stringify({ receipt: parsed.receipt, acknowledgedAt: nowRfc3339() }),
          key.executionStoreId,
          key.executionEpoch,
          key.operationId,
        );
    });
  } catch {
    // Metadata only: a later replay repairs it, and the business outcome stands.
  }
}

/** Carry a pending acknowledgement as a warning instead of a false partial business outcome. */
function withAcknowledgementFact<T>(result: T, cause: unknown): T {
  if (result === null || typeof result !== "object" || !("recovery" in result)) return result;
  const recovery = result.recovery;
  if (recovery === null || typeof recovery !== "object" || !("warnings" in recovery)) return result;
  const warnings = recovery.warnings;
  if (!Array.isArray(warnings)) return result;
  warnings.push(
    `collaboration acknowledgement pending: ${messageOf(cause)}. Both business effects are committed; replaying this ` +
      `operation with the same id repairs the acknowledgement only.`,
  );
  return result;
}

/** A recorded result replays with its own envelope, marked as a replay. */
function markReplayed<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("replayed" in value)) return value;
  // The stored value IS the result this frame committed; only the replay flag
  // differs from what the first call returned.
  return { ...value, replayed: true } as T;
}

/**
 * The composite outcome refusal: an accepted operation whose work is outstanding.
 * It is never success, and it always names the durable phase, the confirmed
 * components and the same-id completion path.
 */
function partialRefusal(input: {
  intent: CompositeIntent;
  phase: "prepared" | "collaboration-confirmed";
  confirmed: readonly string[];
  cause: unknown;
  receipt?: CollaborationEffectReceipt;
  recovery: string;
}): ExecutionError {
  const causeCode = codeOf(input.cause);
  return new ExecutionError(
    "collaboration.operation-partial",
    `composite operation ${JSON.stringify(input.intent.key.operationId)} (${input.intent.kind}) is ${input.phase}: ` +
      `${messageOf(input.cause)}. Its confirmed components are recorded; nothing was undone. ${input.recovery}`,
    {
      operation_id: input.intent.key.operationId,
      kind: input.intent.kind,
      phase: input.phase,
      confirmed_components: [...input.confirmed],
      ...(causeCode === null ? {} : { cause_code: causeCode }),
      cause: messageOf(input.cause),
      ...(input.receipt === undefined
        ? {}
        : {
            collaboration_revision: input.receipt.collaborationRevision,
            catalog_revision: input.receipt.catalogRevision,
          }),
      recovery: input.recovery,
    },
  );
}

export type CollaborationCompositeEffects<T> = Readonly<{
  /** The whole collaboration effect; runs inside one write transaction. */
  apply(handle: CollaborationStoreHandle): string;
  /** The execution delta; runs inside one execution transaction AFTER the effect committed. */
  finalize(tx: ExecutionTransaction, receipt: CollaborationEffectReceipt): T;
}>;

/**
 * Phase 3: commit the execution delta and its receipt, then mark the reservation
 * confirmed, in ONE execution transaction. A concurrent attempt that finalized
 * first serves its recorded result instead of committing the delta twice.
 */
async function finalizeComposite<T>(
  context: StoreContext,
  intent: CompositeIntent,
  receipt: CollaborationEffectReceipt,
  finalize: CollaborationCompositeEffects<T>["finalize"],
): Promise<T> {
  return withExecutionTransaction(context, (tx) => {
    assertActiveExecutionAuthority(
      tx,
      `the execution authority is ${tx.execution.authorityState}; a composite operation requires an active authority. ` +
        `No execution delta was committed.`,
    );
    assertIntentGeneration(tx, intent);
    const row = readIntent(tx.db, intent.key);
    if (row === null) {
      throw new StoreError(
        "store.corrupt",
        `the collaboration effect of operation ${JSON.stringify(intent.key.operationId)} is committed but its execution ` +
          `reservation is missing. Inspect the composite ledgers; the effect is never re-applied from here.`,
        { operation_id: intent.key.operationId },
      );
    }
    if (row.requestHash !== intent.requestHash) throw intentConflict(intent, row.requestHash);
    if (row.phase === "declined") throw recordedRefusal(intent.key.operationId, row.cause);
    if (row.phase === "confirmed") {
      if (row.receiptJson === null) {
        throw new StoreError("store.corrupt", `operation ${JSON.stringify(intent.key.operationId)} is confirmed without its receipt`);
      }
      return markReplayed(parseJson(row.receiptJson, "execution_collaboration_intents.receipt_json") as T);
    }
    assertSameIntent(row, intent);
    const result = finalize(tx, receipt);
    tx.db
      .prepare(
        "update execution_collaboration_intents set phase = 'confirmed', receipt_json = ?, updated_at = ? " +
          "where execution_store_id = ? and execution_epoch = ? and operation_id = ? and phase = 'prepared'",
      )
      .run(
        JSON.stringify(result),
        nowRfc3339(),
        intent.key.executionStoreId,
        intent.key.executionEpoch,
        intent.key.operationId,
      );
    return result;
  });
}

/**
 * Run phases 2 and 3 of one prepared composite. The owning verb has already
 * recorded the reservation and frozen the payload; this function refuses an
 * unreserved key, so a finalizer can never bypass the reservation.
 */
export async function runCollaborationComposite<T>(
  context: ExecutionContext | StoreContext,
  intent: CompositeIntent,
  effects: CollaborationCompositeEffects<T>,
): Promise<T> {
  let effect: EffectOutcome;
  try {
    effect = await applyCollaborationEffect(context, intent, effects.apply);
  } catch (error) {
    if (!isDeterministicRefusal(error)) {
      throw partialRefusal({
        intent,
        phase: "prepared",
        confirmed: [],
        cause: error,
        recovery:
          `The reservation is retained: reissue the same verb with the same --operation id and payload once the named ` +
          `authority is available; the admitted effect then applies exactly once.`,
      });
    }
    let declined: EffectOutcome;
    try {
      declined = await declineEffect(context, intent, error);
    } catch (declineError) {
      throw partialRefusal({
        intent,
        phase: "prepared",
        confirmed: [],
        cause: error,
        recovery:
          `The deterministic refusal could not be recorded durably (${messageOf(declineError)}); the reservation is retained, ` +
          `so reissuing the same verb resumes it and records the decline.`,
      });
    }
    if (declined.kind === "committed") {
      // A concurrent same-id attempt committed the effect first: finalize THAT
      // effect instead of declining it.
      effect = declined;
    } else {
      await markDeclined(context, intent, declined.cause);
      throw recordedRefusal(intent.key.operationId, declined.cause);
    }
  }
  if (effect.kind === "declined") {
    await markDeclined(context, intent, effect.cause);
    throw recordedRefusal(intent.key.operationId, effect.cause);
  }
  let result: T;
  try {
    result = await finalizeComposite(context, intent, effect.receipt, effects.finalize);
  } catch (error) {
    if (codeOf(error) === "collaboration.operation-partial") throw error;
    throw partialRefusal({
      intent,
      phase: "collaboration-confirmed",
      confirmed: [`collaboration:${intent.kind}`, `collaboration_revision:${effect.receipt.collaborationRevision}`],
      cause: error,
      receipt: effect.receipt,
      recovery:
        `The collaboration effect is committed and is never re-applied. Re-read the addressed state and reissue the SAME verb ` +
        `with the SAME --operation id and payload: the recorded effect replays and only the execution delta is committed.`,
    });
  }
  const acknowledged = await acknowledgeEffect(context, intent, effect.receipt);
  if (!acknowledged) {
    return withAcknowledgementFact(result, "the collaboration effect row could not be marked acknowledged");
  }
  return result;
}
