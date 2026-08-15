/**
 * Workflow-ledger session-event consumer (plan `20260815-dsh-workflow-ledger`
 * Task 3 — the W-B2 producer half).
 *
 * Source of record: the durable `tool-workflow/*` session events appended
 * into the CALLING PARENT session's log (top-level runs only — nested
 * transport calls record nothing upstream; Task 1 seam notes §4). The
 * consumer has TWO halves (the architect-verified seam):
 *  1. COLD SCAN at apply — iterate `ctx.get('sessions').list()`, read each
 *     session's `events` snapshot, and record any `tool-workflow/*` rows
 *     already present. Constructor-seeded events (replay/resume/fork) NEVER
 *     publish on the `session/event` firehose (`firstLiveSeq`), so without
 *     the cold scan pre-restart runs would be invisible.
 *  2. LIVE FIREHOSE — `ctx.events.on('session/event', …)`: the post-commit
 *     append feed, delivered to ALL sessions for a root-context listener
 *     (scope-null event, untagged listeners admitted).
 *
 * Delta: ONE cursor per session id — the session-log `seq` position (next
 * expected envelope). The cold scan advances it to the snapshot length; the
 * live listener processes only envelopes with `seq >= cursor` (a lower seq
 * was already covered). This is the dedupe mechanism: one row per
 * `(runId, kind, envelopeSeq)` across cold+live overlap. No other cache.
 *
 * Mapping (Task 2 schema): `tool-workflow/run-start` → `workflow-run`
 * (`agent` = the carrying parent session id), `tool-workflow/agent-start` →
 * `workflow-agent` (`childId` preserved), `tool-workflow/run-end` →
 * `workflow-run-end`. `tool-workflow/agent-end` is upstream MEMBER
 * bookkeeping with no ledger kind (Task 2 handoff + plan Interfaces — the
 * member `outcome` is intentionally not persisted) and is filtered out.
 * `ts` takes the envelope's `time`.
 *
 * Observe-only (plan Global Constraints: W3 / N5): ZERO gating — every read
 * and append is try/catch-contained; a throwing session read logs one warn
 * and the run is unaffected; all appends go through `recordWorkflowEvent`
 * (itself fully contained — a failing ledger write never crashes or alters
 * a workflow run). The `sessions` service is read STRUCTURALLY via
 * `ctx.get('sessions')` — an absent service (composition without
 * dsh-session) → one debug log + consumer disabled. No runtime dependency
 * on `@deepseek-ai/dsh-session` (same pattern as the agents/loader seams).
 *
 * Depth advisory (P-e / N5): on `agent-start`, resolve the child session
 * via `sessions.get(childId)` and warn when its `header.delegationDepth`
 * is >= 2 — ONCE per run (bounded by a per-runId latch). Observe-time only,
 * NEVER a refusal path.
 */
import type { Context } from '@deepseek-ai/cordis'
import { recordWorkflowEvent } from './agent-flow.ts'
import type { AgentFlowWorkflowEvent } from './agent-flow.ts'
import { asRecord } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'

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
    // Never-throws invariant (decoration `log` pattern): a throwing log sink
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
 * ONE consumed surface, same pattern as the decoration's `agents` view; the
 * real `get` takes a branded `SessionId` while the events carry a plain
 * string childId, so the structural surface types the read the consumer
 * performs).
 */
interface SessionsView {
  get(id: string): unknown
  list(): readonly unknown[]
}

/** Structural view of one session (`id` + immutable `events` snapshot + `header`). */
interface SessionView {
  id: unknown
  events?: readonly unknown[]
  header?: { cwd?: unknown; delegationDepth?: unknown }
}

/** One mapped ledger row: the envelope's session-log seq + the fully-shaped v1 event. */
interface WorkflowLedgerRow {
  /** The envelope's session-log seq — the delta cursor position (dedupe key member). */
  seq: number
  /** The fully-shaped v1 workflow ledger event. */
  event: AgentFlowWorkflowEvent
  /** The published member's child session id (agent-start only — for the depth advisory). */
  childId?: string
}

/** The session's stable id (structural read; branded `SessionId` is a string). */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as SessionView | null | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

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
 */
function rowOf(session: unknown, envelope: unknown): WorkflowLedgerRow | undefined {
  const record = asRecord(envelope)
  if (record === undefined) return undefined
  const type = record.type
  if (typeof type !== 'string') return undefined
  const seq = record.seq
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return undefined
  const time = record.time
  if (typeof time !== 'number' || !Number.isFinite(time)) return undefined
  const data = asRecord(record.data)
  if (data === undefined) return undefined
  const runId = data.runId
  if (typeof runId !== 'string' || runId === '') return undefined

  if (type === TOOL_WORKFLOW_RUN_START) {
    if (typeof data.name !== 'string' || data.name === '') return undefined
    const agent = sessionIdOf(session)
    return {
      seq,
      event: {
        v: 1,
        ts: time,
        kind: 'workflow-run',
        runId,
        name: data.name,
        ...(agent !== undefined ? { agent } : {}),
      },
    }
  }
  if (type === TOOL_WORKFLOW_AGENT_START) {
    // `seq` here is the run-member sequence (data.seq) — distinct from the
    // envelope's session-log `seq` above.
    if (typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return undefined
    if (typeof data.label !== 'string' || data.label === '') return undefined
    if (typeof data.childId !== 'string' || data.childId === '') return undefined
    return {
      seq,
      childId: data.childId,
      event: {
        v: 1,
        ts: time,
        kind: 'workflow-agent',
        runId,
        seq: data.seq,
        label: data.label,
        ...(typeof data.phase === 'string' ? { phase: data.phase } : {}),
        childId: data.childId,
      },
    }
  }
  if (type === TOOL_WORKFLOW_AGENT_END) {
    // Upstream member bookkeeping — the member `outcome` is intentionally
    // NOT persisted (Task 2 handoff + plan Interfaces: the schema has no
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
 * Register the workflow-ledger consumer: (1) a bounded cold scan over
 * `ctx.sessions.list()` reading each session's `events` snapshot for
 * `tool-workflow/*` rows (covers pre-restart runs — constructor-seeded
 * events never hit the firehose, `firstLiveSeq`); (2) a live
 * `ctx.events.on('session/event', …)` listener filtering the four types.
 * One delta cursor per session id (session-log `seq` position); no other
 * cache. Every read/append is try/catch-contained; the `sessions` service
 * absent → one debug log + consumer disabled (composition without
 * dsh-session). All appends go through `recordWorkflowEvent` (itself fully
 * contained — a failing ledger write never crashes or alters a workflow
 * run).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver
 *   (harnessDir attribution from the carrying session's `header.cwd`).
 */
export function registerWorkflowLedger(ctx: Context, resolver: HarnessResolver): void {
  // The `sessions` service is absent in compositions without dsh-session —
  // skip + one debug log (documented degrade), never crash.
  const sessions = ctx.get('sessions') as SessionsView | undefined
  if (sessions === undefined) {
    log('debug', 'sessions service absent — workflow-ledger consumer disabled (composition without dsh-session)')
    return
  }
  // Delta cursors: per session id, the next envelope seq to process. The
  // cold scan advances it to the snapshot length; live envelopes below it
  // were already covered (idempotence — one row per (runId, kind, seq)).
  const cursors = new Map<string, number>()
  // Depth advisory latch: per runId — ONE bounded warn at depth >= 2.
  const depthWarned = new Set<string>()

  const consume = (session: unknown, envelope: unknown): void => {
    const sid = sessionIdOf(session)
    if (sid === undefined) return
    const row = rowOf(session, envelope)
    if (row === undefined) return
    const cursor = cursors.get(sid) ?? 0
    if (row.seq < cursor) return // cold-scan / earlier-live coverage — already recorded
    cursors.set(sid, row.seq + 1)
    // harnessDir attribution: the carrying (parent) session's workspace
    // (`header.cwd` structural read). Unresolved workspace (no explicit
    // config, no session cwd) → no row (consistent with the gates' silent
    // no-op for unresolvable harness).
    const cwd = (session as SessionView | null | undefined)?.header?.cwd
    const harnessDir = resolver.forWorkspace(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined)
    if (harnessDir === null) return
    recordWorkflowEvent({ harnessDir, event: row.event })
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

  // COLD SCAN — bounded per session: each session's events snapshot is read
  // ONCE; a throwing read logs one warn and the pass continues with the next
  // session (the run is never affected).
  for (const session of sessions.list()) {
    const sid = sessionIdOf(session)
    if (sid === undefined) continue
    try {
      const events = (session as SessionView).events
      if (!Array.isArray(events)) continue
      for (const envelope of events) consume(session, envelope)
    } catch (error) {
      log('warn', `workflow-ledger cold scan failed for session ${sid} (contained — other sessions unaffected): ${errorMessage(error)}`)
    }
  }

  // LIVE FIREHOSE — post-commit append feed for ALL sessions (root-context
  // listener; the store's scope carrier admits untagged listeners — Task 1
  // seam notes §2). Per-listener containment on top of the upstream
  // per-listener containment: a throwing consume never surfaces.
  ctx.events.on('session/event', (session: unknown, envelope: unknown) => {
    try {
      consume(session, envelope)
    } catch (error) {
      log('warn', `workflow-ledger live consume failed (contained — the workflow run proceeds): ${errorMessage(error)}`)
    }
  })
}
