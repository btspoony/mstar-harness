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
 *    freeze the payload/tokens/target and record the reservation here as a
 *    `prepared` intent row in `execution_operations`. That row is the operation's
 *    single ledger entry for the rest of its life: an identical retry resumes it,
 *    a different payload refuses, and a foreign address or actor cannot adopt it.
 * 2. APPLY runs in one collaboration write transaction: verify the frozen target
 *    stamp, execute the whole effect and commit its receipt in the SAME
 *    transaction. That receipt is the durable anchor a crashed finalize resumes
 *    from, so a lost response never applies the effect twice.
 * 3. FINALIZE runs in a second execution transaction: require the reservation,
 *    let the verb revalidate the frozen scope/CAS and commit the execution delta,
 *    then replace the intent row with the committed operation receipt in that
 *    same transaction. Acknowledgement on the collaboration effect row is
 *    metadata only and is repaired by a later replay.
 *
 * Nothing here is public: only the admitted owning verb calls it, and only the
 * package index publishes the contract types (never a generic executor).
 */
import { withCollaborationWrite, type CollaborationStamp, type CollaborationStoreHandle } from "./collaboration-store.js";
import { isPlainObject } from "./coordination-write.js";
import {
  ExecutionError,
  assertActiveExecutionAuthority,
  isPreparedCompositeMarker,
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

/** What the intent row's `result_json` holds while the effect is still pending. */
type PreparedIntent = { composite: { phase: "prepared"; intent: CompositeIntent } };

type IntentState =
  | { phase: "prepared"; intent: CompositeIntent }
  | { phase: "committed"; value: unknown };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function corrupt(detail: string): StoreError {
  return new StoreError("store.corrupt", `${detail}; inspect the composite operation ledger before retrying`);
}

/**
 * The operation's one ledger row. A pending composite is stored as a
 * `prepared` marker instead of an `ExecutionRead`, so every other replay reader
 * must treat it as not-yet-committed (`isPreparedCompositeMarker`).
 */
function readIntentRow(db: StoreDb, key: CompositeKey): { requestHash: string; resultJson: string } | null {
  const row = db
    .prepare("select request_hash, result_json from execution_operations where epoch = ? and operation_id = ?")
    .get(key.executionEpoch, key.operationId) as { request_hash?: unknown; result_json?: unknown } | undefined;
  if (row === undefined) return null;
  if (typeof row.request_hash !== "string" || typeof row.result_json !== "string") {
    throw corrupt(`execution_operations(${key.executionEpoch},${key.operationId}) is malformed`);
  }
  return { requestHash: row.request_hash, resultJson: row.result_json };
}

/** The stored phase of the operation's one ledger row. */
function intentState(resultJson: string): IntentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch (error) {
    throw corrupt(`execution_operations.result_json is not valid JSON (${messageOf(error)})`);
  }
  if (!isPreparedCompositeMarker(resultJson)) return { phase: "committed", value: parsed };
  if (!isPlainObject(parsed) || !isPlainObject(parsed.composite) || !isPlainObject(parsed.composite.intent)) {
    throw corrupt("the prepared composite intent does not carry its frozen intent");
  }
  return { phase: "prepared", intent: parsed.composite.intent as unknown as CompositeIntent };
}

/** The typed refusal of an operation id reused for a different semantic request. */
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

/** The frozen address of this intent must be the generation the transaction opened. */
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

/** A resumed intent must be the one this call froze: payload, actor, scope, target and token. */
function assertSameIntent(recorded: CompositeIntent, presented: CompositeIntent): void {
  const same =
    recorded.requestHash === presented.requestHash &&
    recorded.kind === presented.kind &&
    recorded.actor === presented.actor &&
    recorded.expectedExecution === presented.expectedExecution &&
    recorded.frozenPayload === presented.frozenPayload &&
    recorded.target.repoKey === presented.target.repoKey &&
    recorded.target.mode === presented.target.mode &&
    recorded.target.storeId === presented.target.storeId &&
    recorded.target.epoch === presented.target.epoch &&
    recorded.scope.workflowId === presented.scope.workflowId &&
    recorded.scope.planId === presented.scope.planId;
  if (same) return;
  throw new ExecutionError(
    "execution.operation-conflict",
    `operation id ${JSON.stringify(presented.key.operationId)} is reserved for a different frozen intent. The reservation ` +
      `records what the first attempt admitted (payload, actor, scope, target authority and expected token); retry that exact ` +
      `intent, or use a new operation id. Nothing was applied.`,
    { operation_id: presented.key.operationId, kind: presented.kind },
  );
}

/**
 * Record the reservation of one admitted composite, or resume the identical one.
 * The owning verb calls this INSIDE the execution transaction that authenticated
 * the caller, checked the token and froze the payload, so the marker and the
 * admission facts commit together. The row is keyed by the local effect key, so
 * a second attempt under another operation id cannot adopt it.
 */
export function reserveCompositeIntent(tx: ExecutionTransaction, intent: CompositeIntent): "reserved" | "resume" {
  assertIntentGeneration(tx, intent);
  const row = readIntentRow(tx.db, intent.key);
  if (row !== null) {
    if (row.requestHash !== intent.requestHash) throw intentConflict(intent, row.requestHash);
    const state = intentState(row.resultJson);
    if (state.phase === "prepared") {
      assertSameIntent(state.intent, intent);
      return "resume";
    }
    throw intentConflict(intent, row.requestHash);
  }
  const prepared: PreparedIntent = { composite: { phase: "prepared", intent } };
  tx.db
    .prepare(
      "insert into execution_operations(epoch, operation_id, request_hash, store_id, workflow_id, plan_id, result_json, committed_at) " +
        "values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      tx.epoch,
      intent.key.operationId,
      intent.requestHash,
      tx.storeId,
      // A workflow-level composite (registration/import) records no workflow; the
      // column is NOT NULL and no reader addresses a row by this empty value.
      intent.scope.workflowId ?? "",
      intent.scope.planId,
      JSON.stringify(prepared),
      nowRfc3339(),
    );
  return "reserved";
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

function readCompositeReceipt(
  db: StoreDb,
  key: CompositeKey,
): { requestHash: string; receipt: CollaborationEffectReceipt } | null {
  const row = db
    .prepare(
      "select request_hash, result_json from collaboration_operations where key_space = 'composite' " +
        "and execution_store_id = ? and execution_epoch = ? and operation_id = ?",
    )
    .get(key.executionStoreId, key.executionEpoch, key.operationId) as
    | { request_hash?: unknown; result_json?: unknown }
    | undefined;
  if (row === undefined) return null;
  if (typeof row.request_hash !== "string" || typeof row.result_json !== "string") {
    throw corrupt(`collaboration_operations(${key.operationId}) is malformed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.result_json);
  } catch (error) {
    throw corrupt(`collaboration_operations(${key.operationId}).result_json is not valid JSON (${messageOf(error)})`);
  }
  const envelope = isPlainObject(parsed) && isPlainObject(parsed.receipt) ? parsed.receipt : undefined;
  if (envelope === undefined) throw corrupt(`collaboration_operations(${key.operationId}).result_json carries no effect receipt`);
  return { requestHash: row.request_hash, receipt: envelope as unknown as CollaborationEffectReceipt };
}

/**
 * Phase 2: apply the whole collaboration effect and commit its receipt in one
 * transaction. The frozen target stamp is re-verified under the writer lock, so
 * a different repository/mode/store generation refuses `collaboration.stale-binding`
 * before any effect runs. An effect already committed under this local key is
 * replayed from its receipt instead of applied again.
 */
async function applyCollaborationEffect(
  context: StoreContext,
  intent: CompositeIntent,
  apply: (handle: CollaborationStoreHandle) => string,
): Promise<CollaborationEffectReceipt> {
  return withCollaborationWrite(
    context,
    (handle) => {
      const existing = readCompositeReceipt(handle.db, intent.key);
      if (existing !== null) {
        if (existing.requestHash !== intent.requestHash) throw intentConflict(intent, existing.requestHash);
        return existing.receipt;
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
      return receipt;
    },
    intent.target,
  );
}

/** The acknowledgement is metadata: the business outcome is already committed either way. */
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
 * Release the reservation of an intent whose collaboration effect never
 * committed, preserving the original refusal. The plan-row admission the verb
 * already performed is untouched; a corrected retry (or the same one, after a
 * transient failure) reserves again from scratch instead of inheriting a stale
 * payload.
 */
async function releaseIntent(context: StoreContext, intent: CompositeIntent): Promise<void> {
  try {
    await withExecutionTransaction(context, (tx) => {
      const row = readIntentRow(tx.db, intent.key);
      if (row === null || row.requestHash !== intent.requestHash) return;
      if (!isPreparedCompositeMarker(row.resultJson)) return;
      tx.db
        .prepare("delete from execution_operations where epoch = ? and operation_id = ? and store_id = ?")
        .run(tx.epoch, intent.key.operationId, tx.storeId);
    });
  } catch {
    // The original refusal is the outcome. A reservation that could not be
    // released still resolves deterministically: the same payload resumes it and
    // a different one refuses, so no effect is applied twice.
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
  // The stored value IS the operation receipt this frame committed; only the
  // replay flag differs from what the first call returned.
  return { ...value, replayed: true } as T;
}

export type CollaborationCompositeEffects<T> = Readonly<{
  /** The whole collaboration effect; runs inside one write transaction. */
  apply(handle: CollaborationStoreHandle): string;
  /** The execution delta; runs inside one execution transaction AFTER the effect committed. */
  finalize(tx: ExecutionTransaction, receipt: CollaborationEffectReceipt): T;
}>;

/**
 * Run phases 2 and 3 of one prepared composite. The owning verb has already
 * reserved the intent; this function refuses an unreserved key instead of
 * inventing one, so a finalizer can never bypass the reservation.
 */
export async function runCollaborationComposite<T>(
  context: ExecutionContext | StoreContext,
  intent: CompositeIntent,
  effects: CollaborationCompositeEffects<T>,
): Promise<T> {
  let receipt: CollaborationEffectReceipt;
  try {
    receipt = await applyCollaborationEffect(context, intent, effects.apply);
  } catch (error) {
    await releaseIntent(context, intent);
    throw error;
  }
  const outcome = await withExecutionTransaction(context, (tx) => {
    assertActiveExecutionAuthority(
      tx,
      `the execution authority is ${tx.execution.authorityState}; a composite operation requires an active authority. ` +
        `No execution delta was committed.`,
    );
    assertIntentGeneration(tx, intent);
    const row = readIntentRow(tx.db, intent.key);
    if (row === null) {
      throw new StoreError(
        "store.corrupt",
        `the collaboration effect of operation ${JSON.stringify(intent.key.operationId)} is committed but its execution ` +
          `reservation is missing. Inspect the composite ledgers; the effect is never re-applied from here.`,
        { operation_id: intent.key.operationId },
      );
    }
    if (row.requestHash !== intent.requestHash) throw intentConflict(intent, row.requestHash);
    const state = intentState(row.resultJson);
    if (state.phase === "committed") {
      // A concurrent attempt finalized this operation first: its recorded receipt
      // is the answer, and this call must not commit the execution delta twice.
      return { result: markReplayed(state.value as T), replayed: true };
    }
    assertSameIntent(state.intent, intent);
    const result = effects.finalize(tx, receipt);
    tx.db
      .prepare("update execution_operations set result_json = ?, committed_at = ? where epoch = ? and operation_id = ? and store_id = ?")
      .run(JSON.stringify(result), nowRfc3339(), tx.epoch, intent.key.operationId, tx.storeId);
    return { result, replayed: false };
  });
  const acknowledged = await acknowledgeEffect(context, intent, receipt);
  if (!acknowledged) return withAcknowledgementFact(outcome.result, "the collaboration effect row could not be marked acknowledged");
  return outcome.result;
}
