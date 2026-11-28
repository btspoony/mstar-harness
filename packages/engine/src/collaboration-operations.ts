import { createHash } from "node:crypto";
import { withCollaborationWrite, type CollaborationStamp, type CollaborationStoreHandle } from "./collaboration-store.js";
import { declineUnderFreezeLane, readRemoteIntent, type RemoteIntent, type RemoteIntentRead } from "./collaboration-remote.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
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
import { TERMINAL_DISPOSITIONS, terminalReopenRoute } from "./issue.js";

export type CompositeKind =
  | "residual-add"
  | "residual-close"
  | "execution-register"
  | "execution-import"
  | "issue-move";

const COMPOSITE_KINDS: ReadonlySet<string> = new Set<CompositeKind>([
  "residual-add",
  "residual-close",
  "execution-register",
  "execution-import",
  "issue-move",
]);

function assertCompositeKind(value: string, what: string): CompositeKind {
  if (!COMPOSITE_KINDS.has(value)) throw corrupt(`${what} is ${JSON.stringify(value)}`);
  return value as CompositeKind;
}

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

type DeclineCause = Readonly<{ code: string; message: string; details: Record<string, unknown> | null }>;

type EffectOutcome =
  | { kind: "committed"; receipt: CollaborationEffectReceipt }
  | { kind: "declined"; cause: DeclineCause };

export type CompositeReservation = Readonly<{
  outcome: "reserved" | "resume";
  reservedRevision: number;
  requestHash: string;
}>;

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
  "collaboration.observation-stale": true,
  "remote.unavailable": true,
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

function detailsOf(error: unknown): Record<string, unknown> | null {
  if (error === null || typeof error !== "object" || !("details" in error)) return null;
  return isPlainObject(error.details) ? error.details : null;
}

function isDeterministicRefusal(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && RECOVERABLE_CODES[code] !== true;
}

let compositeDeclineGapForTest: (() => void | Promise<void>) | undefined;
export function setCompositeDeclineGapForTest(callback: (() => void | Promise<void>) | undefined): void {
  compositeDeclineGapForTest = callback;
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

function recordedRefusal(operationId: string, cause: DeclineCause | null): Error {
  const code = cause?.code ?? "collaboration.operation-partial";
  const message = cause?.message ?? `composite operation ${operationId} was declined before any effect`;
  const error = new Error(message) as Error & { code: string; details?: Record<string, unknown> };
  error.name = "RecordedCompositeRefusal";
  error.code = code;
  const recovery =
    typeof cause?.details?.recovery === "string"
      ? cause.details.recovery
      : "issue the corrected request under a new operation id";
  const confirmedComponents = cause?.details?.confirmed_components;
  const durable = Array.isArray(confirmedComponents) && confirmedComponents.length > 0;
  error.details = {
    ...(cause?.details ?? {}),
    operation_id: operationId,
    phase: "declined",
    recovery: durable
      ? `This operation id was declined durably; the confirmed components named here are durable and are never re-sent, ` +
        `while its execution acknowledgement was not applied. ${recovery}`
      : `This operation id was declined durably and its effect was never applied. ${recovery}`,
  };
  return error;
}

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

function assertSameIntent(recorded: StoredIntent, intent: CompositeIntent): void {
  const same =
    recorded.kind === intent.kind &&
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
  const kind = assertCompositeKind(text(row.kind, `${what}.kind`), `${what}.kind`);
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
    const committed = tx.db
      .prepare("select request_hash from execution_operations where epoch = ? and operation_id = ?")
      .get(tx.epoch, intent.key.operationId) as { request_hash?: unknown } | undefined;
    if (committed !== undefined) {
      throw new ExecutionError(
        "execution.operation-conflict",
        `operation id ${JSON.stringify(intent.key.operationId)} already has a committed execution receipt in this store ` +
          `epoch; a composite reserves an unused id before it applies any effect. Nothing was applied.`,
        {
          operation_id: intent.key.operationId,
          recorded_fingerprint: typeof committed.request_hash === "string" ? committed.request_hash : null,
          requested_fingerprint: intent.requestHash,
          recovery: "Use a new operation id for this composite; the committed receipt keeps its own id.",
        },
      );
    }
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
    return { outcome: "reserved", reservedRevision: reservation.revision, requestHash: intent.requestHash };
  }
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
  return { outcome: "resume", reservedRevision: reservation.revision, requestHash: row.requestHash };
}

/** True when this exact operation already holds a live reservation (a resume, not a new admission). */
export function hasPreparedCompositeIntent(tx: ExecutionTransaction, key: CompositeKey): boolean {
  const row = tx.db
    .prepare(
      "select 1 as found from execution_collaboration_intents where execution_store_id = ? and execution_epoch = ? " +
        "and operation_id = ? and phase = 'prepared'",
    )
    .get(key.executionStoreId, key.executionEpoch, key.operationId) as { found?: number } | undefined;
  return row !== undefined;
}

/**
 * The workflow-lifecycle half of the reservation: a terminal transition would
 * invalidate the running witness every admitted composite depends on, so it
 * refuses while ANY composite of this workflow is pending. The pending operation
 * is named with its own resume/decline recovery, so the operator settles it
 * first and then closes the lifecycle.
 */
export function assertNoPendingCompositeForWorkflow(tx: ExecutionTransaction, workflowId: string): void {
  const pending = tx.db
    .prepare(
      "select operation_id, kind, plan_id from execution_collaboration_intents " +
        "where execution_epoch = ? and phase = 'prepared' and workflow_id = ? order by created_at limit 1",
    )
    .get(tx.epoch, workflowId) as { operation_id?: unknown; kind?: unknown; plan_id?: unknown } | undefined;
  if (pending === undefined) return;
  const operationId = text(pending.operation_id, "execution_collaboration_intents.operation_id");
  const kind = text(pending.kind, "execution_collaboration_intents.kind");
  throw new ExecutionError(
    "collaboration.operation-partial",
    `workflow ${workflowId} still has pending composite operation ${JSON.stringify(operationId)} (${kind}); a terminal ` +
      `lifecycle would invalidate the facts it will finalize, so the transition is withheld. Nothing was modified.`,
    {
      operation_id: operationId,
      kind,
      phase: "prepared",
      workflow_id: workflowId,
      ...(typeof pending.plan_id === "string" ? { plan_id: pending.plan_id } : {}),
      recovery:
        `Reissue the pending verb with the same --operation id and payload to resume and finalize it (or let its deterministic ` +
        `refusal be recorded), then retry the lifecycle transition.`,
    },
  );
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

function markDeclinedIn(
  tx: ExecutionTransaction,
  intent: CompositeIntent,
  cause: DeclineCause,
): void {
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
}

async function markDeclined(
  context: StoreContext,
  intent: CompositeIntent,
  cause: DeclineCause,
): Promise<{ settled: true } | { settled: false; error: unknown }> {
  try {
    await withExecutionTransaction(context, (tx) => markDeclinedIn(tx, intent, cause));
    return { settled: true };
  } catch (error) {
    return { settled: false, error };
  }
}

function unsettledDeclineRefusal(intent: CompositeIntent, cause: DeclineCause, settlement: unknown): ExecutionError {
  return new ExecutionError(
    "collaboration.operation-partial",
    `The business refusal ${JSON.stringify(cause.code)} is recorded durably for operation ` +
      `${JSON.stringify(intent.key.operationId)}, but its execution-side settlement did not confirm ` +
      `(${messageOf(settlement)}): the reservation may still be prepared and is never reported as a terminal refusal. ` +
      `Reissue the SAME verb with the SAME --operation id and payload; the recorded decline replays and only the ` +
      `reservation settlement is committed.`,
    {
      operation_id: intent.key.operationId,
      kind: intent.kind,
      phase: "collaboration-confirmed",
      business_cause: { code: cause.code, message: cause.message, details: cause.details },
      settlement_error: messageOf(settlement),
      recovery:
        "Reissue the same verb with the same --operation id and payload (the recorded decline replays and only the " +
        "reservation settlement is committed).",
    },
  );
}

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
 * The outstanding-acknowledgement fact: what could not be confirmed, and whether
 * a replay can repair it. A readable receipt whose acknowledgement write failed
 * is repairable by replay; an absent or malformed receipt is NOT — replay cannot
 * reconstruct the effect, so the operator must reconcile it instead.
 */
export type OutstandingAcknowledgement = Readonly<{ message: string; repairableByReplay: boolean }>;

/**
 * Replay-time acknowledgement repair: reads the committed effect row by its local
 * key and records the acknowledgement if it is still missing. Called from the
 * replay path OUTSIDE any execution transaction, so no write transactions nest.
 *
 * Returns `null` only when the acknowledgement is confirmed. Every other outcome
 * returns the fact the caller must disclose: a missing or unreadable effect row
 * is NOT repairable by replay (`repairableByReplay: false`), while a readable row
 * whose acknowledgement could not be written (including an authority refusal) is.
 */
export async function repairCompositeAcknowledgement(
  context: StoreContext,
  key: CompositeKey,
): Promise<OutstandingAcknowledgement | null> {
  if (resolveCollaborationLocation(context).mode === "remote") return null;
  try {
    return await withCollaborationWrite(context, (handle) => {
      const row = handle.db
        .prepare(
          "select result_json from collaboration_operations where key_space = 'composite' " +
            "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
        )
        .get(key.executionStoreId, key.executionEpoch, key.operationId) as { result_json?: unknown } | undefined;
      if (row === undefined) {
        return { message: "the committed collaboration effect row is missing", repairableByReplay: false };
      }
      if (typeof row.result_json !== "string") {
        return { message: "the collaboration effect row carries no readable result", repairableByReplay: false };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result_json);
      } catch (error) {
        return {
          message: `the collaboration effect row is not readable JSON (${messageOf(error)})`,
          repairableByReplay: false,
        };
      }
      if (!isPlainObject(parsed) || !isPlainObject(parsed.receipt)) {
        return { message: "the collaboration effect row carries no readable receipt", repairableByReplay: false };
      }
      if (typeof parsed.acknowledgedAt === "string") return null;
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
      return null;
    });
  } catch (error) {
    return { message: messageOf(error), repairableByReplay: true };
  }
}

function withAcknowledgementFact<T>(result: T, fact: OutstandingAcknowledgement): T {
  if (result === null || typeof result !== "object") return result;
  const message = fact.repairableByReplay
    ? `collaboration acknowledgement pending: ${fact.message}. Both business effects are committed; replaying this ` +
      `operation with the same id repairs the acknowledgement only.`
    : `collaboration acknowledgement unverifiable: ${fact.message}. The committed effect must be preserved; reconcile the ` +
      `reservation and effect under the admitted authority, or settle the operation through its supported recovery/decline ` +
      `path. Replaying this operation cannot reconstruct the effect or its acknowledgement.`;
  if ("recovery" in result) {
    const recovery = result.recovery;
    if (recovery !== null && typeof recovery === "object" && "warnings" in recovery && Array.isArray(recovery.warnings)) {
      recovery.warnings.push({ code: "collaboration.acknowledgement-pending", message });
      return result;
    }
  }
  if ("warnings" in result && Array.isArray(result.warnings)) {
    result.warnings.push(message);
  }
  return result;
}

/**
 * Disclose an outstanding acknowledgement on a committed business result. The
 * caller passes the cause `repairCompositeAcknowledgement` returned; `null` means
 * the acknowledgement is confirmed and the result is returned untouched.
 */
export function noteOutstandingAcknowledgement<T>(result: T, fact: OutstandingAcknowledgement | null): T {
  return fact === null ? result : withAcknowledgementFact(result, fact);
}

function markReplayed<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("replayed" in value)) return value;
  return { ...value, replayed: true } as T;
}

function partialRefusal(input: {
  intent: CompositeIntent;
  phase: "prepared" | "collaboration-confirmed";
  confirmed: readonly string[];
  frozen?: readonly string[];
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
      ...(input.frozen === undefined ? {} : { frozen_components: [...input.frozen] }),
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

/**
 * note: The refusal of a MULTI-ENTRY composite whose provider preparation stopped part-way. Each
 * earlier entry is already durable, so the refusal names them: reporting "nothing was frozen" would
 * strand them and invite a duplicate identity. Only a confirmation whose receipt is readable counts
 * as provider work, and the durable intents are never described as an unapplied effect.
 */
export function remoteCompositePreparationPartial(
  intent: CompositeIntent,
  frozen: readonly RemoteIntent[],
  cause: unknown,
): ExecutionError {
  const pending = frozen[frozen.length - 1];
  const confirmed = frozen.filter((entry) => entry.state === "confirmed" && entry.confirmed !== null);
  return partialRefusal({
    intent,
    phase: "prepared",
    confirmed: confirmed.map((entry) => `provider:${entry.operationId}`),
    frozen: frozen.map((entry) => entry.operationId),
    cause,
    recovery:
      `The provider intents named in frozen_components are durable provider work, not a local effect: they are reused ` +
      `when this SAME verb is reissued with the SAME --operation id` +
      `${pending === undefined ? "" : `; inspect ${pending.operationId} with \`outbox-show\``}, and the execution ` +
      `acknowledgement was not applied. ` +
      (confirmed.length === 0
        ? `No provider component holds a readable confirmation yet.`
        : `The confirmed components above are never re-sent; recover only the entries that did not freeze.`),
  });
}

export type CollaborationCompositeEffects<T> = Readonly<{
  apply(handle: CollaborationStoreHandle): string;
  finalize(tx: ExecutionTransaction, receipt: CollaborationEffectReceipt): T;
  remote?(context: StoreContext, intent: CompositeIntent): Promise<RemoteIntent | readonly RemoteIntent[] | null>;
  remoteIds?(intent: CompositeIntent): readonly string[];
}>;

/**
 * note: The stable outbox operation id of one composite. An execution operation id is not a
 * provider UUID, so the composite's single provider intent is addressed by a UUID derived from
 * the reservation key: the same reservation always finds the same intent.
 */
export function remoteCompositeOperationId(key: CompositeKey): string {
  return derivedOperationUuid(`remote-composite:${key.executionStoreId}:${String(key.executionEpoch)}:${key.operationId}`);
}

/**
 * note: The outbox operation id of ONE entry of a multi-entry composite (a residual-add freezes one
 * genesis intent per entry). Deterministic from the reservation key and the entry index, so a retry
 * finds that entry's intent instead of minting a second identity.
 */
export function remoteCompositeEntryOperationId(key: CompositeKey, index: number): string {
  return derivedOperationUuid(
    `remote-composite-entry:${key.executionStoreId}:${String(key.executionEpoch)}:${key.operationId}:${String(index)}`,
  );
}

function derivedOperationUuid(material: string): string {
  const bytes = createHash("sha256").update(material, "utf8").digest();
  const hex = Buffer.from(bytes.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type RemoteSettlement =
  | { kind: "confirmed"; repair: RemoteIntentRead; settled: RemoteIntentRead }
  | { kind: "abandoned"; operationId: string; reason: string | null; fork: string | null }
  | { kind: "live"; intent: RemoteIntentRead };

async function remoteSettlementOf(context: StoreContext, operationId: string): Promise<RemoteSettlement | null> {
  const visited = new Set<string>();
  let cursor = operationId;
  let fork: string | null = null;
  let settled: RemoteIntentRead | null = null;
  for (;;) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);
    const read = await readRemoteIntent(context, cursor);
    settled ??= read;
    if (read.state === "confirmed") {
      return { kind: "confirmed", repair: read, settled };
    }
    if (read.state === "abandoned") return { kind: "abandoned", operationId: cursor, reason: read.abandonReason, fork };
    if (read.state !== "conflict") {
      return cursor === operationId ? null : { kind: "live", intent: read };
    }
    if (read.resolvedBy === null) {
      return cursor === operationId ? null : { kind: "live", intent: read };
    }
    fork = cursor;
    cursor = read.resolvedBy;
  }
}

function abandonedRemoteCause(
  abandoned: readonly { operationId: string; reason: string | null }[],
  confirmed: readonly RemoteIntent[] = [],
): DeclineCause {
  const first = abandoned[0]!;
  const named = abandoned
    .map((entry) => `${entry.operationId}${entry.reason === null ? "" : ` (${entry.reason})`}`)
    .join(", ");
  const settled = confirmed
    .map((entry) => `provider:${entry.operationId}${entry.confirmed === null ? "" : ` (issue ${entry.confirmed.identity.issueId})`}`)
    .join(", ");
  const retry =
    settled === ""
      ? "reissue the verb under a new operation id"
      : "issue a new request under a new operation id containing ONLY the entries that did not settle";
  const details = {
    abandoned_components: abandoned.map((entry) => entry.operationId),
    abandon_reason: first.reason,
  };
  if (settled === "") {
    return {
      code: "remote.effect-abandoned",
      message:
        `The provider intent ${named} was abandoned, so it will never confirm and the composite waits on nothing. Its ` +
        `reservation is declined instead of retained: inspect it with \`mstar store collaboration remote outbox-show ` +
        `--harness <abs> --operation ${first.operationId}\`, correct the named cause, then ${retry}. Nothing was applied.`,
      details: {
        ...details,
        recovery:
          `Inspect the abandoned intent with \`mstar store collaboration remote outbox-show --harness <abs> ` +
          `--operation ${first.operationId}\`, then ${retry}.`,
      },
    };
  }
  return {
    code: "remote.effect-abandoned",
    message:
      `The provider intent ${named} was abandoned, so the composite can never complete as admitted \u2014 but the components ` +
      `${settled} ARE confirmed and durably recorded, and are never re-sent. The reservation is declined without an ` +
      `effect-free claim: inspect the abandonment with \`mstar store collaboration remote outbox-show --harness <abs> ` +
      `--operation ${first.operationId}\`, then ${retry}. The confirmed components above are durable; recover ONLY ` +
      `the incomplete work.`,
    details: {
      ...details,
      confirmed_components: confirmed.map((entry) => `provider:${entry.operationId}`),
      recovery: `Recover ONLY the incomplete work: ${retry}; the confirmed components ${settled} are durable and are never re-sent.`,
    },
  };
}

function withdrawnRepairRecovery(withdrawn: { repair: string; reason: string | null; fork: string }): string {
  return (
    `The reviewed replacement ${withdrawn.repair} of ${withdrawn.fork} was abandoned` +
    `${withdrawn.reason === null ? "" : ` (${withdrawn.reason})`}, so no effect can arrive from it, but the fork stays ` +
    `repairable: record a new reviewed replacement with \`mstar store collaboration remote outbox-resolve --harness <abs> ` +
    `--operation ${withdrawn.fork} --input <file|->\`, dispatch it with its fork observation ` +
    `(\`mstar store collaboration remote outbox-dispatch --harness <abs> --operation <uuid> --input <file|->\`), record ` +
    `its result with \`mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->\`, then reissue ` +
    `this SAME verb with the SAME --operation id once it confirms.`
  );
}

function repairedOutcomeMismatch(settlement: Extract<RemoteSettlement, { kind: "confirmed" }>): StoreError | null {
  const repair = settlement.repair;
  const frozen = settlement.settled.event;
  const confirmed = repair.confirmed;
  if (frozen === null || confirmed === null) {
    return new StoreError(
      "collaboration.unreadable",
      `The settlement of operation ${settlement.settled.operationId} is confirmed, but its frozen request and the ` +
        `repair's confirmed event are not both readable under this checkout's current disclosure, so the settled ` +
        `outcome cannot be proved. Nothing was acknowledged.`,
    );
  }
  if (frozen.change.kind === "project-replace" || confirmed.event.change.kind === "project-replace") return null;
  const expected = (frozen.change.mstar.fields as Record<string, unknown>).disposition;
  const actual = (confirmed.event.change.mstar.fields as Record<string, unknown>).disposition;
  if (expected === actual) return null;
  const showId = frozen.change.issueRef;
  const terminal =
    typeof actual === "string" && (TERMINAL_DISPOSITIONS as readonly string[]).includes(actual);
  const recovery = terminal
    ? `Inspect the settled replacement with \`mstar store collaboration remote outbox-show --harness <abs> --operation ` +
      `${repair.operationId}\`. The confirmed terminal decision ${JSON.stringify(actual)} stands: a closure is admitted ` +
      `only from an open issue, so this request is never retried over it. ${terminalReopenRoute(showId)} Then ` +
      `re-observe the project with \`mstar store collaboration remote observe --harness <abs> --input <file|->\` and ` +
      `reissue this SAME verb under a NEW operation id with the reopened issue's revision: the settled replacement is ` +
      `never re-sent.`
    : `Inspect the settled replacement with \`mstar store collaboration remote outbox-show --harness <abs> --operation ` +
      `${repair.operationId}\` and the issue with \`mstar issue show --id ${showId}\` for its current revision, ` +
      `re-observe the project with \`mstar store collaboration remote observe --harness <abs> --input <file|->\`, then ` +
      `reissue this SAME verb under a NEW operation id with that CURRENT revision: the fork is already merged, so the ` +
      `fresh intent freezes against the merged head and publishes the reviewed disposition while the settled ` +
      `replacement is never re-sent.`;
  return new StoreError(
    "remote.effect-mismatch",
    `The confirmed provider effect ${repair.operationId} (record ${confirmed.recordId}) replaced ` +
      `${settlement.settled.operationId} with disposition ${JSON.stringify(actual)}, not the ${JSON.stringify(expected)} ` +
      `the frozen request asked for, so this request's business outcome never landed and no plan effect is acknowledged ` +
      `from it. ${recovery}`,
    {
      settled_operations: [repair.operationId],
      settled_records: [confirmed.recordId],
      confirmed_components: [`provider:${repair.operationId}`],
      requested_disposition: expected,
      confirmed_disposition: actual,
      recovery,
    },
  );
}

function outstandingRecovery(entry: RemoteIntent, leaf: RemoteIntentRead | undefined): string {
  if (entry.state === "confirmed") {
    return (
      `Restore this project's read permission by submitting a verified observation with ` +
      `\`mstar store collaboration remote observe --harness <abs> --input <file|->\`, then reissue this SAME verb with ` +
      `the SAME --operation id: the settled receipt is re-read, never re-sent.`
    );
  }
  if (leaf !== undefined) {
    if (leaf.state === "conflict") {
      return (
        `The conflicted intent ${entry.operationId} is taken over by ${leaf.operationId}, which is itself an unresolved ` +
        `conflict: record a reviewed replacement of THAT fork with \`mstar store collaboration remote outbox-resolve ` +
        `--harness <abs> --operation ${leaf.operationId} --input <file|->\`, dispatch it with its fork observation ` +
        `(\`mstar store collaboration remote outbox-dispatch --harness <abs> --operation <uuid> --input <file|->\`), ` +
        `record its result with \`mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->\`, ` +
        `then reissue this SAME verb with the SAME --operation id once it confirms.`
      );
    }
    return leaf.state === "unconfirmed"
      ? `The conflicted intent ${entry.operationId} is taken over by resolution ${leaf.operationId}, whose send is ` +
          `uncertain: reconcile that attempt with \`mstar store collaboration remote outbox-reconcile --harness <abs> ` +
          `--input <file|->\`, then reissue this SAME verb with the SAME --operation id once it confirms.`
      : `The conflicted intent ${entry.operationId} is taken over by the live resolution ${leaf.operationId}: dispatch ` +
          `THAT intent with its fork observation (\`mstar store collaboration remote outbox-dispatch --harness <abs> ` +
          `--operation ${leaf.operationId} --input <file|->\`), record its result with \`mstar store collaboration ` +
          `remote outbox-receipt --harness <abs> --input <file|->\`, then reissue this SAME verb with the SAME ` +
          `--operation id once it confirms.`;
  }
  if (entry.state === "conflict") {
    return (
      `A conflicted intent is settled only by review: inspect it with \`mstar store collaboration remote outbox-show ` +
      `--harness <abs> --operation ${entry.operationId}\`, then record a reviewed replacement with ` +
      `\`mstar store collaboration remote outbox-resolve --harness <abs> --operation ${entry.operationId} --input ` +
      `<file|->\`, and reissue this SAME verb with the SAME --operation id once the replacement confirms.`
    );
  }
  if (entry.state === "unconfirmed") {
    return (
      `The send of ${entry.operationId} is uncertain: reconcile the attempt with \`mstar store collaboration remote ` +
      `outbox-reconcile --harness <abs> --input <file|->\`, then reissue this SAME verb with the SAME --operation id ` +
      `once it confirms.`
    );
  }
  return (
    `Inspect it with \`mstar store collaboration remote outbox-show --harness <abs> --operation ${entry.operationId}\`, ` +
    `send it with \`mstar store collaboration remote outbox-dispatch --harness <abs> --operation ${entry.operationId}\`, ` +
    `record the result with \`mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->\`, then ` +
    `reissue this SAME verb with the SAME --operation id: only the execution delta is committed, and the confirmed ` +
    `effect is never re-applied.`
  );
}

async function runRemoteComposite<T>(
  context: ExecutionContext | StoreContext,
  intent: CompositeIntent,
  effects: CollaborationCompositeEffects<T>,
): Promise<T> {
  if (effects.remote === undefined) {
    throw partialRefusal({
      intent,
      phase: "prepared",
      confirmed: [],
      cause: new StoreError(
        "remote.effect-pending",
        `${intent.kind} has no admitted remote rewrite: its collaboration half is a local lane artifact`,
      ),
      recovery:
        `Prepare the equivalent remote intent through its own verb, or run this composite against a local/mirror ` +
        `checkout. The reservation is retained; nothing was applied.`,
    });
  }
  let remoteIntents: readonly RemoteIntent[] | null;
  try {
    const outcome = await effects.remote(context, intent);
    remoteIntents = outcome === null ? null : Array.isArray(outcome) ? outcome : [outcome];
  } catch (error) {
    if (codeOf(error) === "collaboration.operation-partial") throw error;
    if (isDeterministicRefusal(error) && detailsOf(error)?.durable_intent !== true) {
      const cause: DeclineCause = {
        code: codeOf(error) as string,
        message:
          `${messageOf(error)} The provider intent was not frozen, so this reservation is declined and released; ` +
          `correct the named cause and reissue the verb under a new operation id.`,
        details: detailsOf(error),
      };
      const decision = await declineUnderFreezeLane(
        context as StoreContext,
        effects.remoteIds?.(intent) ?? [],
        async () => {
          await compositeDeclineGapForTest?.();
          return markDeclined(context, intent, cause);
        },
      );
      if (decision.kind === "durable" || decision.kind === "unproven") {
        throw partialRefusal({
          intent,
          phase: "prepared",
          confirmed: [],
          cause: error,
          recovery:
            decision.kind === "durable"
              ? `This refusal was decided on a sampled provider state, but operation ` +
                `${decision.operationIds.join(", ")} already holds a durable intent under this reservation, so the ` +
                `reservation is retained: reissue the SAME verb with the SAME --operation id and payload; the frozen ` +
                `intent is reused (settled by dispatch, receipt and confirmation), never re-frozen or re-sent.`
              : `The remote-cache lane that holds this composite's durable intents could not be read ` +
                `(${messageOf(decision.error)}), so this refusal proves nothing either way and the reservation is ` +
                `retained: repair the lane, then reissue the SAME verb with the SAME --operation id; any frozen intent ` +
                `is reused, never re-frozen or re-sent.`,
        });
      }
      if (decision.kind === "unsettled") throw unsettledDeclineRefusal(intent, cause, decision.error);
      throw recordedRefusal(intent.key.operationId, cause);
    }
    if (codeOf(error) === "remote.operation-conflict") {
      throw partialRefusal({
        intent,
        phase: "prepared",
        confirmed: [],
        cause: error,
        recovery:
          `A provider intent is already frozen under this operation id, so this attempt proves no pre-freeze ` +
          `failure: the reservation is retained. Reissue the SAME verb with the SAME --operation id and payload: ` +
          `the frozen intent is reused (settled by dispatch, receipt and confirmation), never re-frozen or re-sent.`,
      });
    }
    throw partialRefusal({
      intent,
      phase: "prepared",
      confirmed: [],
      cause: error,
      recovery:
        `The reservation is retained: reissue the same verb with the same --operation id once the named cause is ` +
        `corrected; any provider intent already frozen under this id is reused, never re-frozen or re-sent.`,
    });
  }
  if (remoteIntents === null) {
    const receipt: CollaborationEffectReceipt = {
      key: intent.key,
      requestHash: intent.requestHash,
      collaborationRevision: 0,
      catalogRevision: 0,
      committedAt: nowRfc3339(),
      facts: JSON.stringify({ remote: null }),
    };
    try {
      return await finalizeComposite(context, intent, receipt, effects.finalize);
    } catch (error) {
      if (codeOf(error) === "collaboration.operation-partial") throw error;
      throw partialRefusal({
        intent,
        phase: "prepared",
        confirmed: [],
        cause: error,
        recovery:
          `The reservation is retained: reissue the same verb with the same --operation id once the named execution ` +
          `authority is available; nothing provider-side is re-applied.`,
      });
    }
  }
  const effective: RemoteIntent[] = [];
  const abandoned: Array<{ operationId: string; reason: string | null }> = [];
  const liveLeaves = new Map<string, RemoteIntentRead>();
  const withdrawnRepairs = new Map<string, { repair: string; reason: string | null; fork: string }>();
  let repairedMismatch: StoreError | null = null;
  const unreadSettlements: string[] = [];
  for (const entry of remoteIntents) {
    if (entry.state === "confirmed") {
      effective.push(entry);
      continue;
    }
    if (entry.state === "conflict" || entry.state === "abandoned") {
      let settlement: RemoteSettlement | null;
      try {
        settlement = await remoteSettlementOf(context, entry.operationId);
      } catch (error) {
        unreadSettlements.push(`${entry.operationId}: ${messageOf(error)}`);
        settlement = null;
      }
      if (settlement?.kind === "confirmed") {
        repairedMismatch ??= repairedOutcomeMismatch(settlement);
        effective.push({
          ...entry,
          operationId: settlement.repair.operationId,
          requestHash: settlement.repair.requestHash,
          state: "confirmed",
          confirmed: settlement.repair.confirmed,
          result: settlement.repair.result,
          updatedAt: settlement.repair.updatedAt,
        });
        continue;
      }
      if (settlement?.kind === "abandoned") {
        if (settlement.fork === null) {
          abandoned.push({ operationId: settlement.operationId, reason: settlement.reason });
          effective.push({ ...entry, state: "abandoned" });
          continue;
        }
        withdrawnRepairs.set(entry.operationId, {
          repair: settlement.operationId,
          reason: settlement.reason,
          fork: settlement.fork,
        });
      }
      if (settlement?.kind === "live") {
        liveLeaves.set(entry.operationId, settlement.intent);
      }
    }
    effective.push(entry);
  }
  const proved = (entry: RemoteIntent): boolean => entry.state === "confirmed" && entry.confirmed !== null;
  const confirmedEntries = effective.filter((entry) => proved(entry));
  const outstanding = effective.filter((entry) => !proved(entry));
  const unreadableConfirmed = outstanding.find((entry) => entry.state === "confirmed");
  if (outstanding.length > 0) {
    if (
      abandoned.length > 0 &&
      unreadableConfirmed === undefined &&
      effective.every((entry) => entry.state === "confirmed" || entry.state === "abandoned")
    ) {
      const cause = abandonedRemoteCause(abandoned, confirmedEntries);
      const settlement = await markDeclined(context, intent, cause);
      if (!settlement.settled) throw unsettledDeclineRefusal(intent, cause, settlement.error);
      throw recordedRefusal(intent.key.operationId, cause);
    }
    const named = outstanding.map((entry) => `${entry.operationId} (${entry.state})`).join(", ");
    throw partialRefusal({
      intent,
      phase: "prepared",
      confirmed: confirmedEntries.map((entry) => `provider:${entry.operationId}`),
      frozen: effective.map((entry) => entry.operationId),
      cause:
        unreadableConfirmed !== undefined
          ? new StoreError(
              "collaboration.unreadable",
              `the provider intent ${unreadableConfirmed.operationId} is confirmed but its receipt is not readable under ` +
                `this checkout's current disclosure; state alone is not a receipt`,
            )
          : new StoreError(
              "remote.effect-pending",
              `the provider intents ${named} are not confirmed` +
                (abandoned.length === 0
                  ? ""
                  : `, and ${abandoned.map((entry) => entry.operationId).join(", ")} was abandoned`) +
                (unreadSettlements.length === 0
                  ? ""
                  : `; a settlement could not be read (${unreadSettlements.join("; ")})`),
            ),
      recovery: outstanding
        .map((entry) => {
          const withdrawn = withdrawnRepairs.get(entry.operationId);
          return withdrawn === undefined
            ? outstandingRecovery(entry, liveLeaves.get(entry.operationId))
            : withdrawnRepairRecovery(withdrawn);
        })
        .join(" "),
    });
  }
  if (repairedMismatch !== null) {
    const cause: DeclineCause = {
      code: codeOf(repairedMismatch) as string,
      message: messageOf(repairedMismatch),
      details: detailsOf(repairedMismatch),
    };
    const settlement = await markDeclined(context, intent, cause);
    if (!settlement.settled) throw unsettledDeclineRefusal(intent, cause, settlement.error);
    throw recordedRefusal(intent.key.operationId, cause);
  }
  const receipt: CollaborationEffectReceipt = {
    key: intent.key,
    requestHash: intent.requestHash,
    collaborationRevision: 0,
    catalogRevision: 0,
    committedAt: confirmedEntries.reduce((latest, entry) => (entry.updatedAt > latest ? entry.updatedAt : latest), ""),
    facts: JSON.stringify({
      remote: confirmedEntries.map((entry) => ({
        operationId: entry.operationId,
        requestHash: entry.requestHash,
        issueId: entry.confirmed?.identity.issueId ?? null,
        recordId: entry.confirmed?.recordId ?? null,
        result: entry.result,
        event: entry.confirmed?.event ?? null,
      })),
    }),
  };
  try {
    return await finalizeComposite(context, intent, receipt, effects.finalize);
  } catch (error) {
    if (codeOf(error) === "collaboration.operation-partial") throw error;
    if (codeOf(error) === "remote.effect-mismatch") {
      const cause: DeclineCause = {
        code: codeOf(error) as string,
        message: messageOf(error),
        details: detailsOf(error),
      };
      const settlement = await markDeclined(context, intent, cause);
      if (!settlement.settled) throw unsettledDeclineRefusal(intent, cause, settlement.error);
      throw recordedRefusal(intent.key.operationId, cause);
    }
    throw partialRefusal({
      intent,
      phase: "collaboration-confirmed",
      confirmed: effective.map((entry) => `provider:${entry.operationId}`),
      cause: error,
      recovery:
        `The confirmed provider components named above are recorded and are never re-sent. Reissue this SAME verb ` +
        `with the SAME --operation id once the named execution cause is corrected: only the execution acknowledgement ` +
        `is committed.`,
    });
  }
}

async function finalizeComposite<T>(
  context: StoreContext,
  intent: CompositeIntent,
  receipt: CollaborationEffectReceipt,
  finalize: CollaborationCompositeEffects<T>["finalize"],
): Promise<T> {
  return withExecutionTransaction(context, (tx) => {
    if (intent.kind !== "execution-import") {
      assertActiveExecutionAuthority(
        tx,
        `the execution authority is ${tx.execution.authorityState}; a composite operation requires an active authority. ` +
          `No execution delta was committed.`,
      );
    }
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
  if (resolveCollaborationLocation(context).mode === "remote") return runRemoteComposite(context, intent, effects);
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
      effect = declined;
    } else {
      const settlement = await markDeclined(context, intent, declined.cause);
      if (!settlement.settled) throw unsettledDeclineRefusal(intent, declined.cause, settlement.error);
      throw recordedRefusal(intent.key.operationId, declined.cause);
    }
  }
  if (effect.kind === "declined") {
    const settlement = await markDeclined(context, intent, effect.cause);
    if (!settlement.settled) throw unsettledDeclineRefusal(intent, effect.cause, settlement.error);
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
    return withAcknowledgementFact(result, {
      message: "the collaboration effect row could not be marked acknowledged",
      repairableByReplay: true,
    });
  }
  return result;
}
