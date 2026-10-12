/**
 * Durable engine-status store — the edge-safe catalog source a later host
 * endpoint serves, plus the per-session workflow-selection CONTROL record (D4).
 *
 * Every piece of state lives in the control-root `store.db` through the
 * engine's typed synchronous host-state domain operations
 * (`packages/engine/src/host-state-store.ts`): one transaction per operation,
 * SQLite's own `BEGIN IMMEDIATE` serializing concurrent writers. There is no
 * plugin-owned file, no directory lock, and no shared read-modify-write
 * envelope:
 *
 * - an emission is UPSERTed as this session's single newest row
 *   (`dsh_status_emissions`) — the depth every reader ever consumed;
 * - a binding commit UPSERTs this session's row (`dsh_session_bindings`),
 *   merging the exclusion floor by max and preserving an omitted preference.
 *
 * ADDRESSING (HARD): both records are keyed by the durable
 * `session.header.id` AND the authoritative cwd, so a read must be addressed
 * by both. A session id alone cannot address a row — the endpoint therefore
 * passes the cwd it resolved SERVER-side. A read that finds no row for that
 * exact pair reports `no-session-entry` (never another workspace's row).
 *
 * READ RULE (HARD): an absent row, a store this build cannot answer from, or a
 * malformed stored record is never guessed at. A read reports either the
 * stored record or the explicit unavailable state carrying the store's own
 * cause (which names `mstar store init` / `mstar store upgrade` before an
 * ACTIVE authority exists).
 *
 * KEYING (HARD): the stored maps are SQL rows keyed by
 * `(session_id, cwd)`. The session id is caller-chosen on the host's
 * `session.create` (a branded string with no shape validation), but SQLite
 * binds it as an ordinary parameter — an id equal to an `Object.prototype`
 * member is a value, never a lookup of an inherited member.
 *
 * @module @mstar-harness/dsh/engine-status-store
 */

import { existsSync } from 'node:fs'
import {
  readDshSessionBinding,
  readDshStatusEmission,
  recordDshStatusEmission,
  storeDbPath,
  writeDshSessionBinding,
  type DshSelectedGeneration,
  type ExecutionBinding,
} from '@mstar-harness/engine'

/** Per-entry record version carried by every stored entry (`rv`). */
export const ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION = 1

/**
 * One stored emission: the payload the model saw, plus the identity needed to
 * validate a later reader's claim (`cwd` is the session workspace the payload
 * was resolved for).
 */
export interface EngineStatusSnapshotEntry {
  /** Record version — a reader must see {@link ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION}. */
  readonly rv: number
  /** The session workspace the payload was resolved for (validation anchor). */
  readonly cwd: string
  /** ISO timestamp of the emission. */
  readonly at: string
  /** The agent turn the payload was emitted for. */
  readonly turn: number
  /** The exact catalog payload object handed to the step messages. */
  readonly payload: Record<string, unknown>
}

/** Why a snapshot read could not produce the stored entry (every path explicit). */
export type EngineStatusSnapshotUnavailableReason =
  | 'no-harness-dir'
  | 'absent'
  | 'unreadable'
  | 'invalid-json'
  | 'envelope-schema'
  | 'no-session-entry'
  | 'entry-schema'

/** The explicit "no answer" result — never a best-effort parse. */
export interface EngineStatusUnavailable {
  readonly kind: 'unavailable'
  readonly reason: EngineStatusSnapshotUnavailableReason
}

/** Read outcome: the stored entry, or the explicit unavailable state. */
export type EngineStatusSnapshotRead =
  | { readonly kind: 'ok'; readonly entry: EngineStatusSnapshotEntry }
  | EngineStatusUnavailable

/** Write outcome: written, or the degraded reason (never throws for store faults). */
export type EngineStatusSnapshotWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'degraded'; readonly reason: string }

/**
 * One write request — the emission site's payload plus its session identity.
 * The store stamps the emission time itself; no caller-supplied timestamp is
 * accepted (the durable row's time is the store transaction's own).
 */
export interface EngineStatusSnapshotWriteInput {
  /** The session whose catalog row this payload is (`session.header.id`). */
  readonly sessionId: string
  /** The session workspace the payload was resolved for (`session.header.cwd`). */
  readonly cwd: string
  /** The agent turn the row was emitted for. */
  readonly turn: number
  /** The exact payload object handed to the step messages. */
  readonly payload: object
  /** The selected authority generation of the emission's selection, when bound. */
  readonly selectedGeneration?: DshSelectedGeneration
}

/**
 * One session's durable workflow-selection CONTROL record (D4): the active
 * workflow this session picked plus the durable no-backfill floor. It is never
 * part of an emitted payload and is keyed by the durable `session.header.id`.
 */
export interface WorkflowSessionBinding {
  /** The authoritative session cwd the record was written for (exact-match anchor). */
  readonly cwd: string
  /** The session's chosen ACTIVE workflow id; absent = no explicit pick yet. */
  readonly selectedWorkflowId?: string
  readonly executionBinding?: ExecutionBinding | null
  /**
   * Durable exclusion floor: ledger rows at or below this sequence were
   * intentionally skipped while the session was unbound and must never be
   * backfilled. An absent record means floor 0 (no exclusion history).
   */
  readonly excludedBeforeSeq: number
}

/** One binding read outcome. */
export type WorkflowSessionBindingRead =
  | { readonly kind: 'ok'; readonly binding?: WorkflowSessionBinding }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** One binding read-modify-write request (a picker commit or a floor advance). */
export interface WorkflowSessionBindingUpdate {
  /** The chosen active workflow id; omitted preserves the stored preference. */
  readonly selectedWorkflowId?: string
  /** Adopt or clear the current execution authority witness. */
  readonly executionBinding?: ExecutionBinding | null
  /** The exclusion floor to merge (by max) into the stored record. */
  readonly excludedBeforeSeq: number
  /** The selected authority generation of the picker's selection, when bound. */
  readonly selectedGeneration?: DshSelectedGeneration
}

/** Binding write outcome: written, or the degraded reason (never throws for store faults). */
export type WorkflowSessionBindingWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'degraded'; readonly reason: string }

/** The explicit unavailable result (single constructor — one shape everywhere). */
export function engineStatusUnavailable(
  reason: EngineStatusSnapshotUnavailableReason,
): EngineStatusUnavailable {
  return { kind: 'unavailable', reason }
}

/** Structural test for a plain JSON object (never an array, never null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Interpret one durable execution-authority witness. The accepted shape is the
 * engine's own `ExecutionBinding`: version 1, the recording harness root, and a
 * complete coordinator `ExecutionSessionRef` (store id, positive epoch,
 * workflow id, role, session id). Anything else is not a witness this build may
 * persist or serve — the caller refuses rather than carrying a partial record.
 */
function asExecutionBinding(value: unknown): ExecutionBinding | null | undefined {
  if (value === null) return null
  if (!isPlainObject(value) || value.version !== 1) return undefined
  if (typeof value.harnessRoot !== 'string' || value.harnessRoot === '' || !isPlainObject(value.session)) return undefined
  const session = value.session
  if (
    typeof session.storeId !== 'string' || session.storeId === '' ||
    typeof session.workflowId !== 'string' || session.workflowId === '' ||
    typeof session.sessionId !== 'string' || session.sessionId === '' ||
    session.role !== 'coordinator' ||
    typeof session.epoch !== 'number' || !Number.isSafeInteger(session.epoch) || session.epoch <= 0
  ) {
    return undefined
  }
  return value as ExecutionBinding
}

/**
 * Read one session's newest stored emission for the given authoritative cwd.
 *
 * Every failure path is explicit: `{HARNESS_DIR}` unresolved (`no-harness-dir`),
 * no store on disk (`absent`), no row for this exact `(sessionId, cwd)` pair
 * (`no-session-entry`), and a stored payload that is not usable JSON
 * (`invalid-json`) or not an object (`entry-schema`). A row belonging to
 * another workspace is never served — it is not addressable by this pair.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none resolved).
 * @param sessionId - the session whose snapshot is requested.
 * @param cwd - the authoritative session workspace the row was written for.
 * @returns the stored entry, or the explicit unavailable state.
 */
export function readEngineStatusSnapshot(
  harnessDir: string | null,
  sessionId: string,
  cwd: string,
): EngineStatusSnapshotRead {
  if (harnessDir === null || harnessDir === '') return engineStatusUnavailable('no-harness-dir')
  if (sessionId === '' || cwd === '') return engineStatusUnavailable('no-session-entry')
  const emission = readDshStatusEmission({ harnessDir }, sessionId, cwd)
  if (emission === undefined) {
    return engineStatusUnavailable(existsSync(storeDbPath({ harnessDir })) ? 'no-session-entry' : 'absent')
  }
  let payload: unknown
  try {
    payload = JSON.parse(emission.payloadJson)
  } catch {
    return engineStatusUnavailable('invalid-json')
  }
  if (!isPlainObject(payload)) return engineStatusUnavailable('entry-schema')
  return {
    kind: 'ok',
    entry: {
      rv: ENGINE_STATUS_SNAPSHOT_ENTRY_VERSION,
      cwd: emission.cwd,
      at: emission.emittedAt,
      turn: emission.turn,
      payload,
    },
  }
}

/**
 * Persist one emission as this session's single newest row.
 *
 * Contained by design: a store that cannot be written (no ACTIVE authority, a
 * schema drift, a busy store, a changed selected generation) returns the
 * explicit `{kind:'degraded', reason}` the advisory emission path logs — it
 * never aborts the step it observes, and it never fabricates a successful
 * write.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none resolved).
 * @param input - the emission's session identity + payload.
 * @returns written, or the degraded reason.
 */
export function writeEngineStatusSnapshot(
  harnessDir: string | null,
  input: EngineStatusSnapshotWriteInput,
): EngineStatusSnapshotWrite {
  if (harnessDir === null || harnessDir === '') return { kind: 'degraded', reason: 'no-harness-dir' }
  if (input.sessionId === '') return { kind: 'degraded', reason: 'no-session-id' }
  if (input.cwd === '') return { kind: 'degraded', reason: 'no-session-cwd' }
  if (!Number.isFinite(input.turn)) return { kind: 'degraded', reason: 'invalid-turn' }
  if (!isPlainObject(input.payload)) return { kind: 'degraded', reason: 'payload-not-object' }
  const written = recordDshStatusEmission(
    { harnessDir },
    input.sessionId,
    input.cwd,
    input.turn,
    JSON.stringify(input.payload),
    input.selectedGeneration,
  )
  return written.kind === 'written' ? { kind: 'written' } : { kind: 'degraded', reason: written.reason }
}

/**
 * Read one session's durable workflow-selection binding.
 *
 * The answers are deliberately distinct: `{kind:'ok'}` WITHOUT a `binding`
 * means there is nothing recorded for this session — the caller proceeds
 * unbound. `{kind:'unavailable', reason}` means the record cannot be trusted
 * (`cwd-mismatch`, a store refusal carrying its own recovery text) — the caller
 * must NOT treat that as "no pick" and attribute the session anywhere.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param sessionId - the durable `session.header.id` (the picker key).
 * @param cwd - the authoritative session cwd (exact match against the record).
 */
export function readWorkflowSessionBinding(
  harnessDir: string,
  sessionId: string,
  cwd: string,
): WorkflowSessionBindingRead {
  if (harnessDir === '') return { kind: 'unavailable', reason: 'no-harness-dir' }
  if (sessionId === '') return { kind: 'unavailable', reason: 'no-session-id' }
  if (cwd === '') return { kind: 'unavailable', reason: 'no-session-cwd' }
  const read = readDshSessionBinding({ harnessDir }, sessionId, cwd)
  if (read.kind === 'unavailable') return { kind: 'unavailable', reason: read.reason }
  const stored = read.binding
  if (stored === undefined) return { kind: 'ok' }
  let executionBinding: ExecutionBinding | null = null
  if (stored.executionBinding !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(stored.executionBinding)
    } catch {
      return { kind: 'unavailable', reason: 'store-bindings-schema' }
    }
    const witness = asExecutionBinding(parsed)
    if (witness === undefined) return { kind: 'unavailable', reason: 'store-bindings-schema' }
    executionBinding = witness
  }
  return {
    kind: 'ok',
    binding: {
      cwd: stored.cwd,
      ...(stored.selectedWorkflowId === null ? {} : { selectedWorkflowId: stored.selectedWorkflowId }),
      executionBinding,
      excludedBeforeSeq: stored.excludedBeforeSeq,
    },
  }
}

/**
 * Durably record one session's workflow-selection binding (the D4 picker
 * commit / exclusion-floor advance) in ONE store transaction: the stored
 * preference is preserved when the update omits one, the exclusion floor
 * merges by max (an older observation never walks the window back over rows
 * already excluded), and a record whose stored cwd is not this session's cwd
 * refuses `cwd-mismatch`.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param sessionId - the durable `session.header.id`.
 * @param cwd - the authoritative session cwd (must match any stored record).
 * @param update - the preference (optional) and the exclusion floor.
 * @returns written, or the degraded reason (never throws for store faults).
 */
export function updateWorkflowSessionBinding(
  harnessDir: string,
  sessionId: string,
  cwd: string,
  update: WorkflowSessionBindingUpdate,
): WorkflowSessionBindingWrite {
  if (harnessDir === '') return { kind: 'degraded', reason: 'no-harness-dir' }
  if (sessionId === '') return { kind: 'degraded', reason: 'no-session-id' }
  if (cwd === '') return { kind: 'degraded', reason: 'no-session-cwd' }
  if (!Number.isInteger(update.excludedBeforeSeq) || update.excludedBeforeSeq < 0) {
    return { kind: 'degraded', reason: 'invalid-excluded-before-seq' }
  }
  if (update.selectedWorkflowId !== undefined && update.selectedWorkflowId === '') {
    return { kind: 'degraded', reason: 'invalid-selected-workflow-id' }
  }
  let executionBinding: string | null | undefined
  if (update.executionBinding !== undefined) {
    if (update.executionBinding !== null && asExecutionBinding(update.executionBinding) === undefined) {
      return { kind: 'degraded', reason: 'invalid-execution-binding' }
    }
    executionBinding = update.executionBinding === null ? null : JSON.stringify(update.executionBinding)
  }
  const written = writeDshSessionBinding(
    { harnessDir },
    sessionId,
    cwd,
    {
      ...(update.selectedWorkflowId === undefined ? {} : { selectedWorkflowId: update.selectedWorkflowId }),
      ...(executionBinding === undefined ? {} : { executionBinding }),
      excludedBeforeSeq: update.excludedBeforeSeq,
    },
    update.selectedGeneration,
  )
  if (written.kind === 'written') return { kind: 'written' }
  // The engine reports a cwd conflict as its own message; keep that one token
  // stable for the picker/floor callers that branch on it.
  return { kind: 'degraded', reason: /cwd-mismatch/.test(written.reason) ? 'cwd-mismatch' : written.reason }
}
