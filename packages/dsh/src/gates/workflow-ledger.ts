/**
 * Workflow-ledger session-event consumer (plan `20260815-dsh-workflow-ledger`
 * Task 3 — the W-B2 producer half).
 *
 * Source of record: the durable `tool-workflow/*` session events appended
 * into the CALLING PARENT session's log (top-level runs only — nested
 * transport calls record nothing upstream; Task 1 seam notes §4). The
 * consumer has THREE halves (the architect-verified seam):
 *  1. COLD SCAN at apply — iterate `ctx.get('sessions').list()`, read each
 *     session's `events` snapshot, and record any `tool-workflow/*` rows
 *     already present. Constructor-seeded events (replay/resume/fork) NEVER
 *     publish on the `session/event` firehose (`firstLiveSeq`), so without
 *     the cold scan pre-restart runs would be invisible.
 *  2. LIVE FIREHOSE — `ctx.events.on('session/event', …)`: the post-commit
 *     append feed, delivered to ALL sessions for a root-context listener
 *     (scope-null event, untagged listeners admitted).
 *  3. SESSION-CREATED BACKFILL — `ctx.events.on('session/created', …)`: a
 *     session created AFTER apply with a constructor-seeded log (resumed /
 *     forked conversation — `session/created` fires after the seed enters
 *     the log, upstream `session/src/index.ts:961-995`) gets its snapshot
 *     cold-scanned ONCE on the creation announcement, closing the
 *     late-seeded-session gap (qc3 S-304 / qc2 W-1a).
 *
 * DEDUPE (qc2 W-1 / qc3 F-301 fix-wave): ONE DURABLE per-session watermark —
 * the next expected envelope `seq` (session-log position) — persisted to
 * `{HARNESS_DIR}/workflows/<id>/workflow-ledger-cursors.json` (a small
 * bounded sidecar next to the workflow-dir `agent-flow.jsonl`, written
 * atomically temp-file + rename through the same containment discipline; the
 * root cursor file is NOT read after migration — no read fallback). The
 * watermark is consulted AND advanced by every scan (cold /
 * created-backfill / live): envelopes with `seq` below it were already
 * recorded — across cold+live overlap AND across plugin re-applies (a
 * re-registration no longer re-records the same live sessions). The
 * watermark advances only AFTER the ledger row appended successfully (qc3
 * R-401 — a failing append leaves the cursor behind, so the row is
 * re-attempted at the next scan, never permanently lost). The in-memory
 * Map is the durable file's mirror (module-level cache keyed by WORKFLOW
 * DIR, bounded by the session cap AND by a workflow-dir count cap — qc3
 * S-4 — so a long-lived process across many workflow ids never grows the
 * cache unbounded); any watermark read/write failure degrades to
 * in-memory-only with one warn — a ledger row is never lost and the
 * workflow run is never affected.
 *
 * INTER-PROCESS SERIALIZATION (qc3 W-1 fix-wave): the watermark
 * read-modify-write (load fresh → mutate → whole-map save) runs inside the
 * per-workflow write lock shared with the ledger append
 * (`withWorkflowDirLock` from agent-flow.ts — the same lockdir pattern as
 * the engine's `withStatusWriteLock`). Steady state is ONE writer per
 * workflow dir; under multi-session shared lifecycle (compass ruling 3)
 * the lock makes the cursor save read-modify-write atomic across
 * processes — a whole-map save can no longer silently clobber another
 * process's just-advanced cursor (the duplicate-row regression mode). The
 * lock is held only around the bounded cursor update, never across scans.
 *
 * Mapping (Task 2 schema): `tool-workflow/run-start` → `workflow-run`
 * (`agent` = the carrying parent session id), `tool-workflow/agent-start` →
 * `workflow-agent` (`childId` preserved), `tool-workflow/run-end` →
 * `workflow-run-end`. `tool-workflow/agent-end` is upstream MEMBER
 * bookkeeping with no ledger kind (Task 2 handoff + plan Interfaces — the
 * member `outcome` is intentionally not persisted) and is filtered out.
 * `ts` takes the envelope's `time`.
 *
 * P-c answer observation (plan `20260815-dsh-workflow-gate` Task 4 fold-in —
 * the Task-2 Important handoff): the workflow GATE cannot observe the ask
 * outcome — the tool registry's `serviceAsk` consumes the approval result
 * internally, and the gate invents no answerer. The run-start observation
 * IS the answer seam: when the approval waterfall ALLOWS a workflow call,
 * the call executes and the durable `tool-workflow/run-start` session event
 * (name carried) lands in the parent session log — the consumer maps it to
 * the `workflow-run` row AND records `allow` for the run name into the
 * apply-scoped {@link WorkflowAskCache} (`registerWorkflowLedger`'s third
 * parameter — the host adapter's instance). W-1 (qc2 fix-wave): the record
 * fires ONLY for names the policy marked asked in this apply
 * (`WorkflowAskCache.markAsked` on every ask verdict; the observation
 * promotes via `wasAsked`) — a run observed without a prior ask (P-b
 * advisory under `ask` mode, `warn`/`off`-mode runs) is not an approval
 * resolution and never pre-authorizes the name. A DENIED answer produces no
 * run → no observation → the next same-name call under `ask` re-asks
 * (fail-closed — no grant evidence, never an invented allow). The hook is
 * bounded and contained: it fires only on the FIRST successful recording of
 * a run-start (the watermark gate above), keyed on the UNCAPPED run name
 * (`row.runName` — it must match the gate's `meta.name`, which is never
 * truncated AND is normalized through the SAME `normalizeWorkflowName` the
 * gate composes with — the Task 5 congruence fold-in), and a throwing cache
 * record degrades the observation with one warn — the ledger row is already
 * appended, the run is never affected.
 *
 * Observe-only (plan Global Constraints: W3 / N5): ZERO gating — every read
 * and append is try/catch-contained; a throwing session read logs one warn
 * and the run is unaffected; all appends go through `recordWorkflowEvent`
 * (itself fully contained — a failing ledger write never crashes or alters
 * a workflow run). The `sessions` service is read STRUCTURALLY via
 * `ctx.get('sessions')` — an absent service (composition without
 * dsh-session) → one debug log + consumer disabled. No runtime dependency
 * on `@deepseek-ai/dsh-session` (same pattern as the agents/loader seams).
 * The `session/created` listener NEVER throws synchronously — upstream
 * vetoes a session publication on a throwing creation listener.
 *
 * Depth advisory (P-e / N5): on `agent-start`, resolve the child session
 * via `sessions.get(childId)` and warn when its `header.delegationDepth`
 * is >= 2 — ONCE per run (bounded by a per-runId latch). Observe-time only,
 * NEVER a refusal path.
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recordWorkflowEvent,
  resolveAgentFlowWriteDir,
  truncateLedgerField,
  withWorkflowDirLock,
  WORKFLOW_LEDGER_MAX_ID_LENGTH,
  WORKFLOW_LEDGER_MAX_LABEL_LENGTH,
  WORKFLOW_LEDGER_MAX_NAME_LENGTH,
  WORKFLOW_LEDGER_MAX_SEQ,
} from './agent-flow.ts'
import type { AgentFlowWorkflowEvent } from './agent-flow.ts'
import { asRecord } from './_shared.ts'
import type { HarnessResolver } from './_shared.ts'
// The SHARED P-c cache-key normalization (plan `20260815-dsh-workflow-gate`
// Task 5 fold-in — the Task-4 Important congruence fix): the run-start
// observation MUST key the ask cache through the SAME function the gate
// composes `metaName` with (dispatch.ts `workflowGateInputOf`), or a
// control-char name re-asks forever. Also the display-field control-char
// strip this consumer used to own locally (`sanitizeLedgerDisplay`) — now
// one shared implementation for the run name AND the label/phase fields.
// workflow-policy imports dispatch.ts type-only — no runtime cycle.
import { normalizeWorkflowName } from './workflow-policy.ts'
// Type-only (erased at runtime — no cycle): the P-c per-session ask cache
// (plan `20260815-dsh-workflow-gate` Task 4 fold-in) — this consumer
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

/**
 * The durable watermark file name under the WORKFLOW dir (qc2 W-1 / qc3
 * F-301 fix-wave): `{ "v": 1, "cursors": { "<sessionId>": <nextSeq> } }` —
 * the next expected envelope seq per session id. Written atomically
 * (temp-file + rename) after every recorded workflow row; read lazily per
 * workflow dir (module-level cache). v3 layout: the sidecar lives in the
 * ACTIVE workflow dir (`workflows/<id>/workflow-ledger-cursors.json`) next
 * to the ledger — the root cursor file is NOT read after migration (no read
 * fallback). Absent on first run (silent); a present-but-corrupt file
 * degrades to in-memory-only with one warn.
 */
export const WORKFLOW_LEDGER_WATERMARK_FILE = 'workflow-ledger-cursors.json'
/**
 * Session-count cap for ONE watermark file (bounds the sidecar). Eviction
 * prefers sessions that are no longer live; when every entry is live the
 * oldest entry is dropped (documented residual — a later restore of an
 * evicted session re-records its rows; bounded by the cap).
 */
export const WORKFLOW_LEDGER_WATERMARK_MAX_SESSIONS = 256
/**
 * Workflow-dir count cap for the module-level watermark cache (qc3 S-4
 * fix-wave): a long-lived process can touch many workflow ids over its
 * lifetime (each iteration lifecycle creates a new workflow dir) — the
 * cache evicts the OLDEST cached dir when it exceeds this cap. The file is
 * the durable store; the cache is only a mirror, so an evicted dir is
 * re-read (and re-cached) on its next visit — no correctness impact.
 */
export const WORKFLOW_LEDGER_WATERMARK_MAX_DIRS = 64

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
  /** The envelope's session-log seq — the durable-watermark position (dedupe key member). */
  seq: number
  /** The fully-shaped v1 workflow ledger event. */
  event: AgentFlowWorkflowEvent
  /** The published member's child session id (agent-start only — for the depth advisory). */
  childId?: string
  /**
   * The NORMALIZED (control chars stripped via the SHARED
   * `normalizeWorkflowName` — the gate's own metaName normalization, plan
   * `20260815-dsh-workflow-gate` Task 5 congruence fold-in) but UNCAPPED
   * run display name — run-start rows only: the P-c cache key (Task 4
   * fold-in). The ledger event's `name` is deterministically capped at the
   * read boundary; the cache must key on the FULL name — it matches the
   * gate's `meta.name` (the allowlist/ask identity), which is never
   * truncated.
   */
  runName?: string
}

/** The session's stable id (structural read; branded `SessionId` is a string). */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as SessionView | null | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/* ---------------------------------- durable watermark ---------------------------------- */

/** One loaded watermark: session id → next expected envelope seq (per workflow dir). */
type Watermark = Map<string, number>

/**
 * Module-level watermark cache — the durable file's in-memory mirror, keyed
 * by WORKFLOW DIR (the file's actual location — a new active workflow id
 * means a different sidecar, so the cache must not leak the previous
 * workflow's cursors). Persists across registrations IN one process (a
 * re-apply sees the same advanced Map); the file provides the cross-restart
 * durability. Bounded: the per-dir Map is capped at
 * `WORKFLOW_LEDGER_WATERMARK_MAX_SESSIONS`; the number of dirs is bounded
 * by the resolver's per-workspace cache (a process serves a handful of
 * workspaces — same bound as the ledger's own resolver).
 */
const watermarkCache = new Map<string, Watermark>()

/**
 * Cache one workflow dir's watermark with a bounded cache (qc3 S-4
 * fix-wave): when the cache exceeds {@link WORKFLOW_LEDGER_WATERMARK_MAX_DIRS}
 * the OLDEST cached dir (Map insertion order) is evicted. The file is the
 * durable store — an evicted dir is re-read on its next visit, so eviction
 * never loses a cursor.
 */
function cacheWatermark(workflowDir: string, watermark: Watermark): void {
  watermarkCache.set(workflowDir, watermark)
  while (watermarkCache.size > WORKFLOW_LEDGER_WATERMARK_MAX_DIRS) {
    const oldest = watermarkCache.keys().next().value
    if (oldest === undefined) break
    watermarkCache.delete(oldest)
  }
}

/** The number of workflow dirs currently mirrored in the module-level watermark cache (qc3 S-4 observability). */
export function workflowLedgerWatermarkCacheSize(): number {
  return watermarkCache.size
}

/**
 * Load (or return the cached) watermark for one workflow dir. A missing file
 * is the normal first run — silent, empty map. A present-but-corrupt file
 * warns once and degrades to in-memory-only (contained — never throws):
 * in-process re-applies stay deduped, a restart re-records (the file was
 * never durable). Persisted values are validated (integer `nextSeq` in
 * [1, 2^31)) and invalid entries dropped.
 *
 * `fresh` (qc3 W-1 fix-wave): re-read the FILE and replace the in-memory
 * map — used ONLY under the per-workflow write lock in `advanceWatermark`,
 * so the read-modify-write starts from the other process's last save, not
 * from a stale in-memory view (a whole-map save can no longer clobber a
 * concurrently advanced cursor). A fresh read that cannot reach the file
 * (missing/corrupt) falls back to the in-memory map — the process's own
 * view is never discarded by a degraded read.
 */
function loadWatermark(workflowDir: string, fresh = false): Watermark {
  const cached = watermarkCache.get(workflowDir)
  if (cached !== undefined && !fresh) return cached
  const watermark: Watermark = new Map()
  try {
    const raw = readFileSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), 'utf8')
    const record = asRecord(JSON.parse(raw))
    const cursors = asRecord(record?.cursors)
    if (cursors !== undefined) {
      for (const [sid, next] of Object.entries(cursors)) {
        // An entry is only written after the first recorded row, so a stored
        // next-seq below 1 is malformed (drop). 2^31 is the sequence bound.
        if (
          typeof next === 'number' &&
          Number.isInteger(next) &&
          next >= 1 &&
          next < WORKFLOW_LEDGER_MAX_SEQ &&
          sid !== ''
        ) {
          watermark.set(sid, next)
        }
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code !== 'ENOENT') {
      log('warn', `workflow-ledger watermark unreadable for ${workflowDir} — degrading to in-memory-only (restart re-records): ${errorMessage(error)}`)
    }
    if (fresh && cached !== undefined) return cached
  }
  cacheWatermark(workflowDir, watermark)
  return watermark
}

/**
 * Persist one watermark atomically (write `*.json.tmp` → rename — the same
 * pattern as the ledger's truncating replace, so concurrent readers never
 * observe a torn file). ALWAYS called under the per-workflow write lock
 * (`advanceWatermark` holds it across the fresh load → mutate → save
 * sequence — qc3 W-1: the whole-map save is serialized against other
 * processes sharing the lifecycle). A failing write degrades to
 * in-memory-only with one warn: the ledger rows are already appended (never
 * lost); only cross-restart dedupe is lost. Contained — never throws.
 */
function saveWatermark(workflowDir: string, watermark: Watermark): void {
  try {
    const file = join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, cursors: Object.fromEntries(watermark) }))
    renameSync(tmp, file)
  } catch (error) {
    log('warn', `workflow-ledger watermark write failed for ${workflowDir} — in-memory only (restart re-records): ${errorMessage(error)}`)
  }
}

/**
 * Advance one session's watermark entry to `nextSeq` and persist. Runs the
 * whole read-modify-write under the per-workflow inter-process lock
 * (qc3 W-1 fix-wave — same lock as the ledger append): the fresh load
 * starts from the latest durable cursors, so two processes sharing one
 * lifecycle never clobber each other's advances; the session entry is
 * monotonic (`Math.max` — a stale concurrent advance never regresses an
 * already-higher cursor). When a NEW session would push the map past the
 * cap, evict first: prefer an entry whose session is no longer live
 * (`isEvictable` — a live session's cursor must never be dropped, or the
 * next re-apply would re-record its rows); fall back to the oldest entry
 * when every entry is live. The residual of eviction (a later restore of an
 * evicted session re-records) is bounded by the cap and documented in the
 * README. A lock timeout (another writer stuck for the full timeout) or a
 * throwing critical section degrades to in-memory-only with one warn — the
 * ledger row above is already appended; only the durable cursor is delayed
 * (a later re-apply re-records the row — the R-401 retry discipline).
 * @param isEvictable - `true` for a candidate session that is safe to evict
 *   (not live in the sessions store).
 */
function advanceWatermark(workflowDir: string, sid: string, nextSeq: number, isEvictable: (candidate: string) => boolean): void {
  try {
    withWorkflowDirLock(workflowDir, () => {
      const watermark = loadWatermark(workflowDir, true)
      if (!watermark.has(sid) && watermark.size >= WORKFLOW_LEDGER_WATERMARK_MAX_SESSIONS) {
        let victim: string | undefined
        for (const key of watermark.keys()) {
          if (isEvictable(key)) {
            victim = key
            break
          }
        }
        victim ??= watermark.keys().next().value as string | undefined
        if (victim !== undefined) {
          watermark.delete(victim)
          log('warn', `workflow-ledger watermark capped at ${WORKFLOW_LEDGER_WATERMARK_MAX_SESSIONS} sessions — evicted ${victim} (a restored evicted session re-records; bounded by the cap)`)
        }
      }
      // Monotonic advance: a concurrent process that already pushed this
      // session's cursor past `nextSeq` must never be regressed (qc3 W-1).
      watermark.set(sid, Math.max(watermark.get(sid) ?? 0, nextSeq))
      saveWatermark(workflowDir, watermark)
    })
  } catch (error) {
    log('warn', `workflow-ledger watermark advance failed for ${workflowDir} — in-memory only (restart re-records): ${errorMessage(error)}`)
  }
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
 * Sequence + length bounds (qc2 W-2 / W-3 fix-wave): the envelope `seq`
 * must be an integer in [0, 2^31) (a fractional seq would corrupt the
 * durable watermark's cursor math and silently drop later integer
 * envelopes); the member `seq` (`data.seq`, 1-based) must be an integer in
 * [1, 2^31) (upstream `memberSeq` positive safe integer). ID-sized fields
 * (`runId`, `childId`) SKIP the row when oversized — truncating them could
 * forge collisions; display fields (`name`, `label`, `phase`) are capped
 * deterministically with a suffix marker AND stripped of ASCII control
 * characters (qc2 S-1 — a newline/tab/CR in a model-controlled display field
 * must never reach the depth-advisory warn or a JSONL line).
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
 * Register the workflow-ledger consumer: (1) a `session/created` backfill
 * listener (registered FIRST — qc3 S-305 — so no apply-time window exists
 * between the snapshot and the attach); (2) a bounded cold scan over
 * `ctx.sessions.list()` reading each session's `events` snapshot for
 * `tool-workflow/*` rows (covers pre-restart runs — constructor-seeded
 * events never hit the firehose, `firstLiveSeq`); (3) a live
 * `ctx.events.on('session/event', …)` listener filtering the four types.
 * One DURABLE watermark per session id (session-log `seq` position,
 * persisted to `{HARNESS_DIR}/workflows/<id>/workflow-ledger-cursors.json` —
 * the ACTIVE workflow dir, never the root) — re-applies
 * never duplicate; no other cache. The watermark advances only AFTER a
 * successful ledger append (qc3 R-401 — a failing append leaves the cursor
 * behind so the row is re-attempted at the next scan, never lost). Every
 * read/append is try/catch-contained — including `sessions.list()` itself
 * (qc2 S-7: one warn, the cold scan skipped, the consumer stays live); the
 * `sessions` service absent → one debug log + consumer disabled (composition
 * without dsh-session). All appends go through `recordWorkflowEvent` (itself
 * fully contained — a failing ledger write never crashes or alters a
 * workflow run).
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param resolver - the shared per-workspace `{HARNESS_DIR}` resolver
 *   (harnessDir attribution from the carrying session's `header.cwd`).
 * @param workflowAskCache - the apply-scoped P-c ask cache (plan
 *   `20260815-dsh-workflow-gate` Task 4 fold-in — the host adapter's
 *   instance; see the module doc "P-c answer observation"). Absent → the
 *   observation hook is disabled (W-B2 tests / compositions without the
 *   workflow gate).
 */
export function registerWorkflowLedger(ctx: Context, resolver: HarnessResolver, workflowAskCache?: WorkflowAskCache): void {
  // The `sessions` service is absent in compositions without dsh-session —
  // skip + one debug log (documented degrade), never crash.
  const sessions = ctx.get('sessions') as SessionsView | undefined
  if (sessions === undefined) {
    log('debug', 'sessions service absent — workflow-ledger consumer disabled (composition without dsh-session)')
    return
  }
  // Depth advisory latch: per runId — ONE bounded warn at depth >= 2. Kept
  // per-apply (reset on re-registration), so it never grows across applies
  // (qc3 S-301).
  const depthWarned = new Set<string>()

  const consume = (session: unknown, envelope: unknown): void => {
    const sid = sessionIdOf(session)
    if (sid === undefined) return
    const row = rowOf(session, envelope)
    if (row === undefined) return
    // harnessDir attribution: the carrying (parent) session's workspace
    // (`header.cwd` structural read). Unresolved workspace (no explicit
    // config, no session cwd) → no row (consistent with the gates' silent
    // no-op for unresolvable harness) and the watermark is NOT advanced —
    // the row is re-evaluated at the next scan, so it records once a
    // workspace resolves (strictly better than a permanently-lost row).
    const cwd = (session as SessionView | null | undefined)?.header?.cwd
    const harnessDir = resolver.forWorkspace(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined)
    if (harnessDir === null) return
    // v3 write path: the ledger rows AND the durable watermark live in the
    // ACTIVE workflow dir (`workflows/<id>/` — the shared active-set
    // resolver; never the root file, never a terminal snapshot dir). No
    // active lifecycle → the row is SKIPPED (one-time warn) and the
    // watermark is NOT advanced — a later re-apply re-attempts it (R-401
    // discipline: advance only after a successful append).
    const workflowDir = resolveAgentFlowWriteDir(harnessDir)
    if (workflowDir === null) return
    // Durable watermark: consult + advance (the in-memory Map is the
    // persisted file's mirror — re-applies and restarts stay deduped).
    const watermark = loadWatermark(workflowDir)
    let next = watermark.get(sid) ?? 0
    // Log-rebuild guard: a snapshot SHORTER than the recorded watermark can
    // only be a re-created session with a fresh log (id reuse after
    // disposal) — restart the cursor so the new log's rows are not all
    // skipped. Live logs only grow, so this never misfires on a healthy
    // session.
    const events = (session as SessionView).events
    if (Array.isArray(events) && events.length < next) next = 0
    if (row.seq < next) return // earlier-scan coverage — already recorded
    // Record-then-advance (qc3 R-401): the ledger row is appended FIRST and
    // the durable watermark advances ONLY on success — a failing append
    // leaves the cursor behind, so the row is re-attempted at the next scan
    // (re-apply / restart), never permanently lost. The only residual is one
    // bounded, visible duplicate row if the process dies between the two fs
    // calls — the duplicate mode the design already accepts and documents.
    if (recordWorkflowEvent({ harnessDir, workflowDir, event: row.event })) {
      advanceWatermark(workflowDir, sid, row.seq + 1, (candidate) => sessions.get(candidate) === undefined)
      // P-c answer observation (plan `20260815-dsh-workflow-gate` Task 4
      // fold-in — the Task-2 Important handoff; see the module doc): a
      // run-start that produced a ledger row means the call RAN — the
      // approval waterfall allowed it (or the allow path let it through).
      // Record `allow` for the run's workflow name so a subsequent
      // same-name call under `ask` mode reuses the decision instead of
      // re-asking. A DENIED answer produces no run → no observation → the
      // next call re-asks (fail-closed — correct). The cache is only ever
      // consulted for non-allowlisted workflow names under `ask`, so
      // allowlisted / ralph entries are no-ops. CONTAINED: a throwing
      // cache record degrades the observation only — the ledger row above
      // is already appended (and the watermark advanced), the run is
      // unaffected. The key is the UNCAPPED run name (`row.runName` —
      // matches the gate's `meta.name`); the ledger display field is
      // capped separately.
      //
      // W-1 (qc2 fix-wave): `allow` is recorded ONLY for names that
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

  // One session's snapshot pass — the shared body of the cold scan AND the
  // `session/created` backfill (a session created after apply with a seeded
  // log is scanned exactly once here; the durable watermark keeps it
  // idempotent across registrations).
  const scanSession = (session: unknown): void => {
    const sid = sessionIdOf(session)
    if (sid === undefined) return
    const events = (session as SessionView).events
    if (!Array.isArray(events)) return
    for (const envelope of events) consume(session, envelope)
  }

  // SESSION-CREATED BACKFILL — registered BEFORE the cold scan (qc3 S-305):
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

  // COLD SCAN — bounded per session: each session's events snapshot is read
  // ONCE; a throwing `list()` or read logs one warn and the pass is skipped
  // (qc2 S-7 — the consumer stays live: the firehose and the created
  // backfill above keep recording; the run is never affected).
  let sessionsSnapshot: readonly unknown[]
  try {
    sessionsSnapshot = sessions.list()
  } catch (error) {
    log('warn', `workflow-ledger cold scan could not list sessions (contained — the live firehose and session-created backfill stay active): ${errorMessage(error)}`)
    sessionsSnapshot = []
  }
  for (const session of sessionsSnapshot) {
    const sid = sessionIdOf(session)
    if (sid === undefined) continue
    try {
      scanSession(session)
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
