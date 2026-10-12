/**
 * Consume verified `tool-workflow/*` native session events into the Dsh
 * workflow ledger. The consumer combines one cold scan per existing session,
 * the live `session/event` feed, and one backfill for sessions created after
 * apply. It reads only through the session service's `seq` and `eventAt`
 * surface; inherited fork prefixes are excluded.
 *
 * Every row resolves its carrying session's canonical native workflow target.
 * The resolver returns the workflow identity, canonical directory, store id,
 * and epoch together. The event writer receives that exact generation; it
 * does not re-probe at commit. Native SQLite event acceptance atomically
 * appends the display row, accepts the stable `{kind, session, stream, seq}`
 * identity with its digest, and advances that stream's scan bound. The
 * bounded read skips rows already covered by the same incarnation; a rebuilt
 * stream is walked independently. Store CAS and transaction failures retain
 * their actual refusal reasons.
 *
 * `run-start` maps to `workflow-run`, `agent-start` to `workflow-agent`, and
 * `run-end` to `workflow-run-end`; `agent-end` is upstream bookkeeping and is
 * not persisted. A successful first run-start also records the actual
 * approval result only when the current apply had previously asked about that
 * name. Unbound events are excluded via the durable session binding floor;
 * unreadable bindings pause attribution rather than implying no selection.
 *
 * This consumer is observe-only: no event gates workflow execution. Missing
 * session service disables it, and contained logger/cache failures never
 * alter a workflow run.
 *
 * On `agent-start`, the child session's delegation depth is inspected and a
 * depth advisory is emitted once per run; it never refuses an event.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { DshSelectedGeneration } from '@mstar-harness/engine'
import { advanceDshScanBound, readDshScanBound } from '@mstar-harness/engine'
import {
  recordWorkflowEvent,
  truncateLedgerField,
  WORKFLOW_LEDGER_MAX_ID_LENGTH,
  WORKFLOW_LEDGER_MAX_LABEL_LENGTH,
  WORKFLOW_LEDGER_MAX_NAME_LENGTH,
  WORKFLOW_LEDGER_MAX_SEQ,
} from './agent-flow.ts'
import type { AgentFlowWorkflowEvent } from './agent-flow.ts'
// The durable session binding (D4) supplies the exclusion floor here. The
// native target resolver separately selects the workflow and returns its
// original store id/epoch, which each event write preserves unchanged.
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../engine-status-store.ts'
import { asRecord } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'
// The SHARED P-c cache-key normalization : the run-start
// observation MUST key the ask cache through the SAME function the gate
// composes `metaName` with (dispatch.ts `workflowGateInputOf`), or a
// control-char name re-asks forever. Also the display-field control-char
// strip this consumer used to own locally (`sanitizeLedgerDisplay`) — now
// one shared implementation for the run name AND the label/phase fields.
// workflow-policy imports dispatch.ts type-only — no runtime cycle.
import { normalizeWorkflowName } from './workflow-policy.ts'
// Type-only (erased at runtime — no cycle): the P-c per-session ask cache
//  — this consumer
// OBSERVES the run-start and records the allow answer into the apply-scoped
// cache owned by the host adapter.
import type { WorkflowAskCache } from './workflow-policy.ts'

/** Logger label for the workflow-ledger consumer (dsh logger naming: `<scope>/<subject>`). */
export const WORKFLOW_LEDGER_LOGGER = 'mstar/workflow-ledger'

/** The four durable `tool-workflow/*` event types (upstream `tool-workflow/src/types.ts:41-64`). */
const TOOL_WORKFLOW_RUN_START = 'tool-workflow/run-start'
const TOOL_WORKFLOW_AGENT_START = 'tool-workflow/agent-start'
const TOOL_WORKFLOW_AGENT_END = 'tool-workflow/agent-end'
const TOOL_WORKFLOW_RUN_END = 'tool-workflow/run-end'

/** Depth threshold for the observe-time advisory (P-e / N5): warn at >= 2. */
const DEPTH_ADVISORY_THRESHOLD = 2

/** Consumer log levels the module sink understands. */
export type WorkflowLedgerLogLevel = 'debug' | 'warn'

/** Module-level consumer log sink — bound by `apply` to `ctx.logger(WORKFLOW_LEDGER_LOGGER)` (agent-flow ledger precedent). */
export type WorkflowLedgerLogSink = (level: WorkflowLedgerLogLevel, message: string) => void

let workflowLedgerLogSink: WorkflowLedgerLogSink = () => {}

/**
 * Bind the consumer log sink (the entry `apply` binds it to
 * `ctx.logger(WORKFLOW_LEDGER_LOGGER)`). Returns the PRIOR sink so a caller
 * can restore it (test pattern: agent-flow `setAgentFlowLogger`).
 */
export function setWorkflowLedgerLogger(sink: WorkflowLedgerLogSink): WorkflowLedgerLogSink {
  const prior = workflowLedgerLogSink
  workflowLedgerLogSink = sink
  return prior
}

/** Log one consumer message through the bound sink (no-op before bind). */
function log(level: WorkflowLedgerLogLevel, message: string): void {
  try {
    workflowLedgerLogSink(level, message)
  } catch {
    // Never-throws invariant (module log-sink pattern): a throwing log sink
    // must not escape the consumer — the workflow run is never affected.
  }
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Minimal structural view of the `sessions` service the consumer reads
 * (`@deepseek-ai/dsh-session` `SessionStore` contract — the runtime read is
 * `ctx.get('sessions')` without the inject requirement, narrowed onto the
 * ONE consumed surface, same pattern as the persona channel's structural views; the
 * real `get` takes a branded `SessionId` while the events carry a plain
 * string childId, so the structural surface types the read the consumer
 * performs).
 */
interface SessionsView {
  get(id: string): unknown
  list(): readonly unknown[]
}

/**
 * Structural view of one session on the INSTALLED `Session` surface
 * (upstream `core/session`, live-verified: `'events' in session === false`):
 * the identity header (`header.id` is the session id the real Session's `id`
 * getter delegates to; `header.cwd` is the workspace), the `seq` log-length
 * contract (`seq ≡ log.length`, so `seq` is both the next event's sequence
 * and the exclusive end of the walk), `eventAt(seq)` for ONE exact
 * envelope, and `inheritedEventCount` — the DURABLE fork-lineage cut (the
 * leading events a conversation fork copied from its parent). `snapshotEvents()`
 * is deliberately not part of this view — the scan never copies a whole log.
 */
interface SessionView {
  header?: { id?: unknown; cwd?: unknown; delegationDepth?: unknown; createdAt?: unknown }
  seq?: unknown
  inheritedEventCount?: unknown
  eventAt?(seq: number): unknown
}

/** One mapped ledger row: the envelope's session-log seq + the fully-shaped v1 event. */
interface WorkflowLedgerRow {
  /** The envelope's native-session seq, the ordered source position. */
  seq: number
  /** The fully-shaped v1 workflow ledger event. */
  event: AgentFlowWorkflowEvent
  /** The published member's child session id (agent-start only — for the depth advisory). */
  childId?: string
  /**
   * The NORMALIZED (control chars stripped via the SHARED
   * `normalizeWorkflowName` — the gate's own metaName normalization, plan
   *   Task 5 congruence fold-in) but UNCAPPED
   * run display name — run-start rows only: the P-c cache key. The ledger event's `name` is deterministically capped at the
   * read boundary; the cache must key on the FULL name — it matches the
   * gate's `meta.name` (the allowlist/ask identity), which is never
   * truncated.
   */
  runName?: string
}

/** The session's stable id (structural read — the installed `Session`'s `header.id`). */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as SessionView | null | undefined)?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The session's workspace (`header.cwd`) when it is a non-empty string. */
function sessionCwdOf(session: unknown): string | undefined {
  const cwd = (session as SessionView | null | undefined)?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

/**
 * The session's fork-lineage cut — `Session.inheritedEventCount`, the number
 * of leading events the conversation fork copied from its parent (the
 * constructor keeps it 0 for an unseeded session, and requires it for a
 * seeded one). Envelopes below the cut are the PARENT's history: they were
 * appended to the parent's log and are the parent's rows to record, so this
 * session's scans never start below the cut. Validated like `seq`: a safe
 * integer in `[0, WORKFLOW_LEDGER_MAX_SEQ)`; an absent member (a structural
 * session without the field — every pre-fork surface, the test fakes) reads
 * as `0`, which keeps the walk exactly as it was before the cut existed.
 */
function sessionForkCutOf(session: unknown): number {
  const inherited = (session as SessionView | null | undefined)?.inheritedEventCount
  return typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0 && inherited < WORKFLOW_LEDGER_MAX_SEQ
    ? inherited
    : 0
}

/**
 * The session's captured END sequence — its log length (`seq ≡ log.length`).
 * Validated structurally: a safe integer in `[0, WORKFLOW_LEDGER_MAX_SEQ)`.
 * A missing member (or a hostile getter, which throws to the caller's own
 * containment) is not the installed surface, and the session is skipped.
 */
function sessionEndSeqOf(session: unknown): number | undefined {
  const seq = (session as SessionView | null | undefined)?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && seq < WORKFLOW_LEDGER_MAX_SEQ ? seq : undefined
}

/** The session's `eventAt(seq)` reader, bound to the session (`undefined` when the surface is absent). */
function sessionEventAtOf(session: unknown): ((seq: number) => unknown) | undefined {
  const eventAt = (session as SessionView | null | undefined)?.eventAt
  return typeof eventAt === 'function' ? eventAt.bind(session) : undefined
}

/**
 * The VERIFIED native log INCARNATION of one session — read from the durable
 * session header, which the SDK marks as REQUIRED creation metadata.
 *
 * SDK evidence (`@deepseek-ai/dsh-session` `lib/types/types.d.ts`): the real
 * `Session` exposes `header: SessionHeader` with required `version`, `id`,
 * `createdAt` (non-negative safe-integer Unix epoch ms) and `isSeeded`.
 * `createdAt` is immutable storage metadata, so a resumed log replays the same
 * stamp while a rebuilt or reused session id carries a new one. The store epoch
 * is deliberately NOT an input (an epoch change is not a new log) and neither
 * is any file mtime. Pairing the session id with that stamp makes the identity
 * stable for the WHOLE life of the log — including before its first event,
 * which is why a legitimate newly created session's first event is recorded
 * rather than refused, and why the identity is readable without touching the
 * event log at all.
 *
 * Returns `undefined` when the header carries no valid creation stamp (a
 * surface that is not a real session): the caller then REFUSES the
 * identity-bearing association instead of falling back to the bare session id.
 */
function sessionStreamIdOf(session: unknown, sessionId: string): string | undefined {
  const createdAt = (session as SessionView | null | undefined)?.header?.createdAt
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return undefined
  return `s1-${createHash('sha256').update(`${sessionId}\u0000${createdAt}`).digest('hex').slice(0, 32)}`
}

/* ---------------------------------- explicit ledger target ---------------------------------- */

/**
 * One execution target selected by the native workflow/session resolver. The
 * store identity and epoch are a single selection and travel unchanged to
 * every event write.
 */
export type WorkflowLedgerTarget = Readonly<{
  workflowId: string
  workflowDir: string
  sessionId: string
  storeId: string
  epoch: number
}>

/** The resolver returns null when this session has no authorized writer. */
export type ResolveWorkflowLedgerTarget = (sessionId: string, cwd: string) => Promise<WorkflowLedgerTarget | null>

/** A target is usable only when it is internally consistent and names this session. */
function targetRefusal(target: WorkflowLedgerTarget, sessionId: string): string | undefined {
  if (target.sessionId !== sessionId) return `target session ${target.sessionId} does not match the carrying session`
  if (typeof target.workflowDir !== 'string' || target.workflowDir === '') return 'target carries no workflow dir'
  if (typeof target.workflowId !== 'string' || target.workflowId === '') return 'target carries no workflow id'
  if (typeof target.storeId !== 'string' || target.storeId === '') return 'target carries no store identity'
  if (!Number.isInteger(target.epoch) || target.epoch < 1) return 'target carries no valid epoch'
  return undefined
}

/**
 * Per-native-stream ordering. With an awaited resolver supplied, a row's
 * target lookup suspends the consumer, so rows for ONE source stream must be
 * processed strictly in arrival order — a slow lookup for an earlier row can
 * never let a later row advance the same stream's cursor first. The chains
 * are keyed by the carrying session (one native log incarnation per session
 * in DSh) and dropped as soon as a chain drains.
 */
const streamChains = new Map<string, Promise<void>>()
/** In-flight stream tasks (the resolver route) — the test seam's drain set. */
const pendingStreamTasks = new Set<Promise<void>>()

/**
 * The TEST SEAM for the asynchronous (resolver) route: resolves once every
 * queued per-stream task has settled, including tasks queued by earlier ones.
 * Gated exactly like the engine's test-runner knobs (`MSTAR_STORE_TEST_RUNNER=1`)
 * — it has no production consumer, so an ungated call is a refusal rather than a
 * hidden behavioural knob. The synchronous pre-activation route needs no await:
 * its rows are already recorded when the registration/listener call returns.
 */
export async function awaitWorkflowLedgerIdle(): Promise<void> {
  if (process.env.MSTAR_STORE_TEST_RUNNER !== '1') {
    throw new Error(
      'awaitWorkflowLedgerIdle is a test-runner-gated seam (set MSTAR_STORE_TEST_RUNNER=1); production consumers must not await it',
    )
  }
  while (pendingStreamTasks.size > 0) {
    await Promise.all([...pendingStreamTasks])
  }
}

/**
 * Queue one task behind the prior task of the same source stream. The task
 * is fully contained here (a throwing scan/consume logs one warn and never
 * rejects into the chain or a listener).
 */
function enqueueStreamTask(key: string, task: () => Promise<void>): void {
  const prior = streamChains.get(key) ?? Promise.resolve()
  const run = prior
    .then(task)
    .catch((error) => {
      log('warn', `workflow-ledger stream task failed (contained — later rows continue): ${errorMessage(error)}`)
    })
  streamChains.set(key, run)
  pendingStreamTasks.add(run)
  void run.finally(() => {
    pendingStreamTasks.delete(run)
    if (streamChains.get(key) === run) streamChains.delete(key)
  })
}

/* ---------------------------------- mapping ---------------------------------- */

/**
 * Map one `session/event` envelope to its ledger row, when it is one of the
 * four durable `tool-workflow/*` types with a shape-valid payload. Pure
 * structural read — NEVER throws. Anything else returns `undefined`:
 * non-workflow event types, malformed envelopes (missing/non-finite `seq`
 * or `time`, non-record `data`), shape-malformed payloads (missing `runId`,
 * wrong field types, out-of-vocabulary `stopReason` — the upstream
 * `stringId`/vocabulary contract) and the un-mapped
 * `tool-workflow/agent-end` (upstream member bookkeeping — no ledger kind).
 * Skipped events never abort the pass.
 *
 * Sequence + length bounds: the envelope `seq` must be an integer in
 * `[0, 2^31)` (fractional positions corrupt the native scan-bound math); the
 * member `seq` (`data.seq`, 1-based) must be an integer in `[1, 2^31)`.
 * ID-sized fields (`runId`, `childId`) skip oversized rows rather than
 * truncating into collisions; display fields (`name`, `label`, `phase`) are
 * capped and stripped of ASCII controls before persistence or advisory output.
 */
function rowOf(session: unknown, envelope: unknown): WorkflowLedgerRow | undefined {
  const record = asRecord(envelope)
  if (record === undefined) return undefined
  const type = record.type
  if (typeof type !== 'string') return undefined
  const seq = record.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq >= WORKFLOW_LEDGER_MAX_SEQ) return undefined
  const time = record.time
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined
  const data = asRecord(record.data)
  if (data === undefined) return undefined
  const runId = data.runId
  if (typeof runId !== 'string' || runId === '' || runId.length > WORKFLOW_LEDGER_MAX_ID_LENGTH) return undefined

  if (type === TOOL_WORKFLOW_RUN_START) {
    // Control chars are stripped BEFORE the empty check — a display field
    // that is ONLY control characters must not record (the read boundary
    // would drop it as empty, so write and read stay consistent). The strip
    // is the SHARED P-c cache-key normalization (workflow-policy.ts) — the
    // observation must key the ask cache identically to the gate.
    const name = typeof data.name === 'string' ? normalizeWorkflowName(data.name) : data.name
    if (typeof name !== 'string' || name === '') return undefined
    const agent = sessionIdOf(session)
    return {
      seq,
      runName: name,
      event: {
        v: 1,
        ts: time,
        kind: 'workflow-run',
        runId,
        name: truncateLedgerField(name, WORKFLOW_LEDGER_MAX_NAME_LENGTH),
        ...(agent !== undefined ? { agent } : {}),
      },
    }
  }
  if (type === TOOL_WORKFLOW_AGENT_START) {
    // `seq` here is the run-member sequence (data.seq) — distinct from the
    // envelope's session-log `seq` above. 1-based positive integer in
    // [1, 2^31) (upstream `memberSeq`).
    if (typeof data.seq !== 'number' || !Number.isInteger(data.seq) || data.seq < 1 || data.seq >= WORKFLOW_LEDGER_MAX_SEQ) {
      return undefined
    }
    const label = typeof data.label === 'string' ? normalizeWorkflowName(data.label) : data.label
    if (typeof label !== 'string' || label === '') return undefined
    if (typeof data.childId !== 'string' || data.childId === '' || data.childId.length > WORKFLOW_LEDGER_MAX_ID_LENGTH) return undefined
    return {
      seq,
      childId: data.childId,
      event: {
        v: 1,
        ts: time,
        kind: 'workflow-agent',
        runId,
        seq: data.seq,
        label: truncateLedgerField(label, WORKFLOW_LEDGER_MAX_LABEL_LENGTH),
        ...(typeof data.phase === 'string'
          ? { phase: truncateLedgerField(normalizeWorkflowName(data.phase), WORKFLOW_LEDGER_MAX_LABEL_LENGTH) }
          : {}),
        childId: data.childId,
      },
    }
  }
  if (type === TOOL_WORKFLOW_AGENT_END) {
    // Upstream member bookkeeping — the member `outcome` is intentionally
    // NOT persisted (the schema has no
    // kind for it). Filtered, never mapped.
    return undefined
  }
  if (type === TOOL_WORKFLOW_RUN_END) {
    const stopReason = data.stopReason
    if (stopReason !== 'completed' && stopReason !== 'cancelled' && stopReason !== 'error') return undefined
    return {
      seq,
      event: { v: 1, ts: time, kind: 'workflow-run-end', runId, stopReason },
    }
  }
  return undefined
}

/**
 * Warn ONCE per run when the published member's child session carries
 * `header.delegationDepth >= 2` (P-e / N5 — observe-time only, NEVER a
 * refusal path). The child is resolved via `sessions.get(childId)`; an
 * unresolvable child or a below-threshold depth is a silent no-op. The
 * caller contains this (a throwing child read degrades the advisory only —
 * the agent row and the run are unaffected).
 */
function depthAdvisory(sessions: SessionsView, row: WorkflowLedgerRow, warned: Set<string>): void {
  if (row.event.kind !== 'workflow-agent' || row.childId === undefined) return
  if (warned.has(row.event.runId)) return
  const child = sessions.get(row.childId)
  const delegationDepth = (child as SessionView | null | undefined)?.header?.delegationDepth
  if (typeof delegationDepth !== 'number' || !Number.isFinite(delegationDepth) || delegationDepth < DEPTH_ADVISORY_THRESHOLD) {
    return
  }
  warned.add(row.event.runId)
  log(
    'warn',
    `workflow run ${row.event.runId} member '${row.event.label}' (child ${row.childId}) is at delegation depth ${delegationDepth} (>= ${DEPTH_ADVISORY_THRESHOLD}) — advisory only, the run proceeds`,
  )
}

/**
 * Register the workflow-ledger consumer: (1) a `session/created` backfill
 * listener (registered FIRST — — so no apply-time window exists
 * between the snapshot and the attach); (2) a bounded cold scan over
 * `ctx.sessions.list()` walking each session's `seq` + `eventAt(seq)` log for
 * `tool-workflow/*` rows (covers pre-restart runs — constructor-seeded
 * events never hit the firehose, `firstLiveSeq`); (3) a live
 * `ctx.events.on('session/event', …)` listener filtering the four types.
 * The native store keeps one per-workflow/session bound keyed by the verified
 * stream incarnation. `recordWorkflowEvent` atomically accepts identity,
 * appends its display row, and advances that bound; the consumer reads it to
 * skip already-covered positions of the same stream. No cursor or identity
 * sidecar is read or written. Every source operation is contained: failures
 * leave the row eligible and never alter a workflow run. Missing sessions
 * service disables this observe-only consumer.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver
 *   (harnessDir attribution from the carrying session's `header.cwd`).
 * @param workflowAskCache - the apply-scoped P-c ask cache (plan
 *     Task 4 fold-in — the host adapter's
 *   instance; see the module doc "P-c answer observation"). Absent → the
 *   observation hook is disabled (W-B2 tests / compositions without the
 *   workflow gate).
 * @param resolveTarget - the required native execution-target resolver. Every
 *   event uses only the returned selected workflow and original store generation.
 */
export function registerWorkflowLedger(
  ctx: Context,
  resolver: HarnessResolver,
  workflowAskCache: WorkflowAskCache | undefined,
  resolveTarget: ResolveWorkflowLedgerTarget,
): void {
  // The `sessions` service is absent in compositions without dsh-session —
  // skip + one debug log (documented degrade), never crash.
  const sessions = ctx.get('sessions') as SessionsView | undefined
  if (sessions === undefined) {
    log('debug', 'sessions service absent — workflow-ledger consumer disabled (composition without dsh-session)')
    return
  }
  // Depth advisory latch: per runId — ONE bounded warn at depth >= 2. Kept
  // per-apply (reset on re-registration), so it never grows across applies
  // The source-event warnings are scoped to this apply.
  const depthWarned = new Set<string>()
  /** Sessions whose missing verified incarnation was already reported (ONE warn per apply). */
  const identityWarned = new Set<string>()
  /** The last selected store generation per session; diagnostics only. */
  const observedGeneration = new Map<string, DshSelectedGeneration>()

  /** Report (once per session) that a row's identity could not be verified. */
  const noteUnverifiedIdentity = (sid: string): void => {
    if (identityWarned.has(sid)) return
    identityWarned.add(sid)
    log('warn', `workflow-ledger identity unavailable for session ${sid} — the native log head is not readable, so its rows are not recorded (no fabricated log incarnation)`)
  }

  // The exclusion floor is a per-scan durable fact. Batch observations while a
  // cold scan is active, then persist the maximum once for each session.
  const pendingFloors = new Map<string, { harnessDir: string; sessionId: string; cwd: string; floor: number }>()
  let scanDepth = 0

  /** Write one session's exclusion floor (the max a scan queued for it). */
  const persistExclusionFloor = (harnessDir: string, sessionId: string, cwd: string, floor: number): void => {
    const written = updateWorkflowSessionBinding(harnessDir, sessionId, cwd, { excludedBeforeSeq: floor })
    if (written.kind === 'degraded') {
      log('warn', `workflow-ledger exclusion floor not persisted for session ${sessionId} (${written.reason}) — attribution stays paused, the row is re-evaluated at the next scan`)
    }
  }

  /** Flush the scan's queued floors: at most one write per session. */
  const flushExclusionFloors = (): void => {
    for (const pending of pendingFloors.values()) {
      persistExclusionFloor(pending.harnessDir, pending.sessionId, pending.cwd, pending.floor)
    }
    pendingFloors.clear()
  }

  /** One unbound observation: queue it while a scan is running, else persist it (the live firehose sees one row per event). */
  const observeExclusionFloor = (harnessDir: string, sessionId: string, cwd: string, floor: number): void => {
    if (scanDepth === 0) {
      persistExclusionFloor(harnessDir, sessionId, cwd, floor)
      return
    }
    const key = `${harnessDir}\u0000${sessionId}`
    const pending = pendingFloors.get(key)
    if (pending === undefined) pendingFloors.set(key, { harnessDir, sessionId, cwd, floor })
    else if (floor > pending.floor) pending.floor = floor
  }

  
  /**
   * Record one mapped row into an EXPLICITLY resolved workflow dir: the
   * append + cursor critical section (`recordWorkflowEvent`, which owns the
   * durable cursor) followed by the contained observations. The source
   * position is the row's own envelope seq + the session's log incarnation —
   * the record identity a replay can recognize.
   */
  const recordRow = (session: unknown, sid: string, harnessDir: string, row: WorkflowLedgerRow, workflowId: string, workflowDir: string, selectedGeneration: DshSelectedGeneration): void => {
    // The row's identity needs the VERIFIED native log incarnation: without a
    // readable immutable head there is no stable stream, so the association is
    // refused (advisory, one warn per session) instead of fabricating one.
    const streamId = sessionStreamIdOf(session, sid)
    if (streamId === undefined) {
      noteUnverifiedIdentity(sid)
      return
    }
    const cursor = readDshScanBound({ harnessDir }, workflowId, sid)
    if (cursor?.stream === streamId && row.seq < cursor.next) return
    // recordWorkflowEvent owns the transaction that accepts the identity,
    // appends the row and advances the native stream bound.
    if (
      recordWorkflowEvent({
        harnessDir,
        workflowDir,
        event: row.event,
        source: { sessionId: sid, streamId, seq: row.seq },
        selectedGeneration,
      })
    ) {
      // P-c answer observation : a
      // run-start that produced a ledger row means the call RAN — the
      // approval waterfall allowed it (or the allow path let it through).
      // Record `allow` for the run's workflow name so a subsequent
      // same-name call under `ask` mode reuses the decision instead of
      // re-asking. A DENIED answer produces no run → no observation → the
      // next call re-asks (fail-closed — correct). The cache is only ever
      // consulted for non-allowlisted workflow names under `ask`, so
      // allowlisted / ralph entries are no-ops. CONTAINED: a throwing
      // cache record degrades the observation only — the ledger row above
      // is already appended (and the cursor advanced), the run is
      // unaffected. The key is the UNCAPPED run name (`row.runName` —
      // matches the gate's `meta.name`); the ledger display field is
      // capped separately.
      //
      // `allow` is recorded ONLY for names that
      // received an `ask` verdict in THIS apply (`markAsked` at the
      // policy's single ask point — `wasAsked` below). A run observed
      // WITHOUT a prior ask — a P-b advisory under `ask` mode (uncovered
      // InProgress plan preempts P-c), a `warn`/`off`-mode run — is NOT an
      // approval resolution: caching it would pre-authorize the name and
      // silently disable the ask channel for the rest of the apply (the
      // human saw the advisory warns, but the deployment-chosen approval
      // gate must still fire for a never-asked first-seen name).
      if (workflowAskCache !== undefined && row.event.kind === 'workflow-run') {
        try {
          const runName = row.runName ?? row.event.name
          if (workflowAskCache.wasAsked(runName)) {
            workflowAskCache.record(runName, 'allow')
          }
        } catch (error) {
          log('warn', `workflow P-c allow observation degraded (contained — the ledger row stays): ${errorMessage(error)}`)
        }
      }
    }
    // Depth advisory — observe-time only, contained (a throwing child read
    // degrades the advisory, never the row or the run).
    if (row.event.kind === 'workflow-agent') {
      try {
        depthAdvisory(sessions, row, depthWarned)
      } catch (error) {
        log('warn', `workflow depth advisory degraded (contained — the run proceeds): ${errorMessage(error)}`)
      }
    }
  }

  /**
   * The explicit-target half of one row (the resolver route): await the
   * supplied resolver at this event boundary, then record into the target it
   * names. A `null` target means the authority holds no active writer for
   * this session, and an inconsistent target is refused — NEITHER falls back
   * to the file-based active set (that would infer an active writer). The
   * caller runs this on the session's stream chain, so a delayed lookup can
   * never reorder watermarks.
   */
  const consumeWithTarget = async (
    session: unknown,
    sid: string,
    harnessDir: string,
    workspace: string,
    row: WorkflowLedgerRow,
  ): Promise<void> => {
    let target: WorkflowLedgerTarget | null
    try {
      target = await resolveTarget(sid, workspace)
    } catch (error) {
      log('warn', `workflow-ledger target resolution failed for session ${sid} (contained — no ledger write, the row stays eligible): ${errorMessage(error)}`)
      return
    }
    if (target === null) {
      observeExclusionFloor(harnessDir, sid, workspace, row.seq + 1)
      return
    }
    const refusal = targetRefusal(target, sid)
    if (refusal !== undefined) {
      log('warn', `workflow-ledger target refused for session ${sid} — ${refusal} (no ledger write, no file-based fallback)`)
      return
    }
    const selectedGeneration = { storeId: target.storeId, epoch: target.epoch }
    const previousGeneration = observedGeneration.get(sid)
    if (previousGeneration !== undefined &&
      (previousGeneration.storeId !== selectedGeneration.storeId || previousGeneration.epoch !== selectedGeneration.epoch)) {
      log('debug', `workflow-ledger selected generation changed for session ${sid}; each event commits with the generation resolved for that event`)
    }
    observedGeneration.set(sid, selectedGeneration)
    recordRow(session, sid, harnessDir, row, target.workflowId, target.workflowDir, selectedGeneration)
  }

  const advanceSkippedAgentEnd = async (
    session: unknown,
    sid: string,
    harnessDir: string,
    workspace: string,
    seq: number,
  ): Promise<void> => {
    const streamId = sessionStreamIdOf(session, sid)
    if (streamId === undefined) {
      noteUnverifiedIdentity(sid)
      return
    }
    let target: WorkflowLedgerTarget | null
    try {
      target = await resolveTarget(sid, workspace)
    } catch (error) {
      log('warn', `workflow-ledger scan-bound target resolution failed for session ${sid} (contained — the row stays eligible): ${errorMessage(error)}`)
      return
    }
    if (target === null) {
      observeExclusionFloor(harnessDir, sid, workspace, seq + 1)
      return
    }
    const refusal = targetRefusal(target, sid)
    if (refusal !== undefined) {
      log('warn', `workflow-ledger scan-bound target refused for session ${sid} — ${refusal}`)
      return
    }
    const bound = readDshScanBound({ harnessDir }, target.workflowId, sid)
    if (bound?.stream === streamId && seq < bound.next) return
    const selectedGeneration = { storeId: target.storeId, epoch: target.epoch }
    if (!advanceDshScanBound({ harnessDir }, target.workflowId, sid, seq + 1, streamId, selectedGeneration)) {
      log('warn', `workflow-ledger native scan bound not advanced for skipped agent-end event at ${seq}; it remains eligible for replay`)
    }
  }

  const consume = (session: unknown, envelope: unknown): void | Promise<void> => {
    const sid = sessionIdOf(session)
    if (sid === undefined) return
    const row = rowOf(session, envelope)
    const record = asRecord(envelope)
    const data = record === undefined ? undefined : asRecord(record.data)
    const skippedAgentEnd = row === undefined &&
      record?.type === TOOL_WORKFLOW_AGENT_END &&
      typeof record.seq === 'number' && Number.isInteger(record.seq) && record.seq >= 0 && record.seq < WORKFLOW_LEDGER_MAX_SEQ &&
      typeof record.time === 'number' && Number.isFinite(record.time) &&
      data !== undefined &&
      typeof data.runId === 'string' && data.runId !== '' && data.runId.length <= WORKFLOW_LEDGER_MAX_ID_LENGTH &&
      typeof data.seq === 'number' && Number.isInteger(data.seq) && data.seq >= 1 && data.seq < WORKFLOW_LEDGER_MAX_SEQ &&
      (data.outcome === 'completed' || data.outcome === 'failed' || data.outcome === 'cancelled')
    if (row === undefined && !skippedAgentEnd) return
    const sourceSeq = row?.seq ?? (typeof record?.seq === 'number' ? record.seq : -1)
    const workspace = sessionCwdOf(session)
    if (workspace === undefined) return
    const harnessDir = resolver.forWorkspace(workspace)
    if (harnessDir === null) return
    const binding = readWorkflowSessionBinding(harnessDir, sid, workspace)
    if (binding.kind === 'unavailable') {
      log('warn', `workflow-ledger attribution paused for session ${sid} — binding store ${binding.reason} (no ledger write, row stays eligible)`)
      return
    }
    const floor = binding.binding?.excludedBeforeSeq ?? 0
    // The exclusion floor omits events observed while the session was unbound.
    if (sourceSeq < floor) return
    if (row === undefined) return advanceSkippedAgentEnd(session, sid, harnessDir, workspace, sourceSeq)
    return consumeWithTarget(session, sid, harnessDir, workspace, row)
  }

  /**
   * The scan begins after the durable exclusion floor and fork-inherited
   * prefix. The selected workflow is resolved per event, so its native scan
   * bound is read only after that event's exact target is known; matching
   * stream positions are skipped in `recordRow`.
   */
  const scanStartSeq = (session: unknown, sid: string, endSeq: number): number => {
    const cut = sessionForkCutOf(session)
    const workspace = sessionCwdOf(session)
    if (workspace === undefined) return cut
    const harnessDir = resolver.forWorkspace(workspace)
    if (harnessDir === null) return cut
    const binding = readWorkflowSessionBinding(harnessDir, sid, workspace)
    if (binding.kind === 'unavailable') return cut
    const floor = binding.binding?.excludedBeforeSeq ?? 0
    if (floor > endSeq) {
      log('warn', `workflow-ledger session ${sid} exclusion floor ${floor} is past its log end ${endSeq} — identity/log-rebuild drift, scan skipped (the intentional exclusion record is preserved)`)
      return endSeq
    }
    const bounded = Math.max(floor, cut)
    return bounded
  }

  /**
   * Walk one session's captured log in order, SYNCHRONOUSLY on the
   * pre-activation route and across awaits on the explicit-target route
   * (every row is chained behind the previous one, so a suspended lookup can
   * never reorder the stream's records). The walk reads `eventAt(seq)` for
   * the captured `[startSeq, endSeq)` — no whole-log copy.
   */
  const runWalk = (session: unknown, startSeq: number, endSeq: number, eventAt: (seq: number) => unknown): void | Promise<void> => {
    let seq = startSeq
    const next = (): void | Promise<void> => {
      while (seq < endSeq) {
        const outcome = consume(session, eventAt(seq))
        seq += 1
        if (outcome !== undefined) return outcome.then(next)
      }
      return undefined
    }
    return next()
  }

  // One session's snapshot pass — the shared body of the cold scan AND the
  // `session/created` backfill (a session created after apply with a seeded
  // log is scanned exactly once here; the durable cursor keeps it idempotent
  // across registrations). The walk reads the installed Session surface: the
  // bounds are captured ONCE, synchronously (`session.seq` + the effective
  // start), then `eventAt(i)` yields envelopes in order to `i < endSeq` — no
  // whole-log copy, and live events appended after the capture stay the live
  // observer's job. On the explicit route the CAPTURED bounds are queued on
  // the session's stream chain, so the scan keeps the exact snapshot it
  // observed while a suspended target lookup runs, and a live event for the
  // same log waits behind it. The scan depth brackets the pass so the queued
  // exclusion floors flush ONCE, after the last row (see `pendingFloors`);
  // the settle path keeps the counter honest even if a read throws.
  const scanSession = (session: unknown): void | Promise<void> => {
    const sid = sessionIdOf(session)
    if (sid === undefined) return
    const endSeq = sessionEndSeqOf(session)
    if (endSeq === undefined) return
    // The EFFECTIVE START is resolved for every readable log, INCLUDING an
    // empty one (`endSeq === 0`): a durable exclusion floor ahead of the
    // captured end is identity drift on the exclusion record, and
    // `scanStartSeq` owns that report. A zero-length fast return placed
    // before this call would silently swallow it (the intentional exclusion
    // must be reported, never reset). A start AT OR PAST the captured end
    // (an empty log, a fully-inherited fork, a cursor at the end) is exactly
    // "no row to walk", which is what the guard below means.
    const startSeq = scanStartSeq(session, sid, endSeq)
    if (startSeq >= endSeq) return
    const eventAt = sessionEventAtOf(session)
    if (eventAt === undefined) return
    // Without a verified incarnation no row of this session can be recorded —
    // skip the walk (ONE warn, shared with the live path's latch) instead of
    // re-reading a log whose every row would be refused.
    if (sessionStreamIdOf(session, sid) === undefined) {
      noteUnverifiedIdentity(sid)
      return
    }
    scanDepth += 1
    const settle = (): void => {
      scanDepth -= 1
      if (scanDepth === 0) flushExclusionFloors()
    }
    // Every captured window is serialized against the same session's live
    // events; each row resolves its native target before its cursor check.
    enqueueStreamTask(sid, async () => {
      try {
        await runWalk(session, startSeq, endSeq, eventAt)
      } finally {
        settle()
      }
    })
    return
  }

  // SESSION-CREATED BACKFILL — registered BEFORE the cold scan :
  // a session created between the `sessions.list()` snapshot and the listener
  // attach would be covered by neither. A session created AFTER apply with a
  // constructor-seeded log (replay/resume/fork) never publishes its seeds on
  // the firehose (`firstLiveSeq`); `session/created` fires after the seed
  // enters the log (upstream `session/src/index.ts:961-995`), so this
  // listener cold-scans the fresh session's snapshot ONCE. MUST never throw
  // synchronously — upstream vetoes the session publication on a throwing
  // creation listener (the try/catch guarantees containment).
  ctx.events.on('session/created', (session: unknown) => {
    try {
      scanSession(session)
    } catch (error) {
      log('warn', `workflow-ledger session-created backfill failed (contained — the session publication proceeds): ${errorMessage(error)}`)
    }
  })

  // COLD SCAN — bounded per session: each session's log length is captured
  // ONCE and its envelopes are walked through `eventAt(seq)`; a throwing
  // `list()` or read logs one warn and the pass is skipped (the consumer
  // stays live: the firehose and the created backfill above keep recording;
  // the run is never affected).
  let sessionsSnapshot: readonly unknown[]
  try {
    sessionsSnapshot = sessions.list()
  } catch (error) {
    log('warn', `workflow-ledger cold scan could not list sessions (contained — the live firehose and session-created backfill stay active): ${errorMessage(error)}`)
    sessionsSnapshot = []
  }
  for (const session of sessionsSnapshot) {
    // Identity extraction is INSIDE the per-session containment: `sessionIdOf`
    // dereferences `header.id`, and a hostile getter/Proxy in one listed
    // session must never escape `registerWorkflowLedger` (observe-only: a
    // throwing session read is contained, never an apply failure). `sid` stays
    // undefined when the id read itself throws — the warn then falls back to a
    // placeholder rather than re-reading the hostile header — and the session
    // is skipped.
    let sid: string | undefined
    try {
      sid = sessionIdOf(session)
      if (sid === undefined) continue
      scanSession(session)
    } catch (error) {
      log('warn', `workflow-ledger cold scan failed for session ${sid ?? 'unknown'} (contained — other sessions unaffected): ${errorMessage(error)}`)
    }
  }

  // LIVE FIREHOSE — post-commit append feed for ALL sessions (root-context
  // listener; the store's scope carrier admits untagged listeners — Task 1
  // seam notes §2). Per-listener containment on top of the upstream
  // per-listener containment: a throwing consume never surfaces.
  ctx.events.on('session/event', (session: unknown, envelope: unknown) => {
    try {
      const sid = sessionIdOf(session)
      if (sid === undefined) return
      enqueueStreamTask(sid, async () => {
        await consume(session, envelope)
      })
    } catch (error) {
      log('warn', `workflow-ledger live consume failed (contained — the workflow run proceeds): ${errorMessage(error)}`)
    }
  })
}
