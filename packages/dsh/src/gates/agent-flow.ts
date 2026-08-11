/**
 * Agent-flow ledger — the server-side record of ACTUAL subagent dispatch and
 * settle events — real completion, exact pairing (plan
 * `20260810-agent-flow-catalog-graph`, spec §2.1 定稿). The context catalog's
 * `state.agentFlow` evidence reads this ledger, so the panel can render what
 * actually happened (vs the client-side expected role flow).
 *
 * Recording point (spec §2.1.1): the shared `DshHostAdapter.dispatchGate`
 * core — the ONE validation path behind the `tools/pre-execute` listener
 * (exec-bound) and the host `beforeDispatch` hook (exec-less). Every
 * Assignment-shaped dispatch that reaches the gate records, INCLUDING hard
 * denies (verdict derivation below). The shape guard (spec §2.1.1) now lives
 * at the shared core itself, so non-Assignment text stays silent on BOTH
 * surfaces (the listener's own guard plus the core's guard for the exec-less
 * host-hook path) — no phantom records. Known tradeoff (qc1 F-005, accepted):
 * the SAME logical dispatch that crosses BOTH surfaces (a host that calls
 * `beforeDispatch` and then runs the identical text through an in-loop
 * `subagent` tool call) records TWO dispatch events — the surfaces are
 * designed mutually exclusive; the double record is documented, not
 * deduplicated. Recording is advisory: every record path is try/catch-
 * contained and logs only (`mstar/agent-flow`) — a failing ledger never
 * blocks a dispatch (documented degrade).
 *
 * File / bounds (spec §2.1.3): `{HARNESS_DIR}/agent-flow.jsonl` (JSON Lines;
 * harness dirs are gitignored by convention). One event per line. SINGLE
 * WRITER ASSUMPTION (qc2 F-1 / qc3 F-001 — documented, advisory): each
 * harness dir is written by ONE dsh process (a single plugin instance /
 * app). Concurrent writers (e.g. two dsh sessions on the same repo) can lose
 * events: `appendFileSync` is a near-atomic O_APPEND write, but the
 * size-gated truncation below is a read-modify-write. The loss is bounded to
 * the panel under-reporting actual flow — NEVER a gate impact (recording is
 * advisory). After every append the file is truncated to the most recent
 * `AGENT_FLOW_MAX_EVENTS` (500) lines; to keep the common small-file path
 * append-only, truncation is gated by a SIZE threshold (≈500 lines' typical
 * size, `AGENT_FLOW_SIZE_GATE_BYTES`) and the truncating overwrite is an
 * ATOMIC temp-file + `renameSync` replace (narrows the read-modify-write
 * window to the single append step).
 * `readAgentFlow` returns the latest-first view (default limit 50) with a
 * role × outcome summary. Semantics (fix-wave qc1 F-001): a MISSING ledger
 * file → empty view `{ events: [], summary: [] }` (recording hasn't started
 * — the panel shows the "no actual dispatches yet" empty state, per the plan
 * promise); only an UNREADABLE file → null (evidence-missing degrade).
 * Malformed lines are skipped, never fatal.
 *
 * Settle (plan `20260811-panel-f4-timeliness` Task 1 — real completion
 * signals, paired to the dispatch record): `tools/post-execute` IS part of
 * the verified dsh-tools registry surface (`runPostExecute` dispatches the
 * waterfall for every tool call — verified against the upstream source and
 * pinned by the real-call probe in `tests/agent-flow.spec.ts`), and
 * `ctx.tasks.onTaskDone` reports background-task terminal snapshots. Settles
 * are recorded ONLY for dispatches that can be paired to a real completion:
 * - `registerSettleListener` (the `tools/post-execute` listener) matches the
 *   dispatch TOOLS (Config `dispatchTools`, default `['subagent']` — the
 *   shared `DEFAULT_DISPATCH_TOOLS` from `dispatch.ts`), looks up the exec's
 *   agent-namespaced call key (`${sessionId}\u0000${callId}` — a raw `callId`
 *   alone is not globally unique across sessions in one process, qc1 F-101
 *   fix-wave) in the apply-scoped pairing store, and branches on the
 *   verified result shapes: `{ kind: 'background', taskId }` (valid taskId)
 *   → stores `taskId → dispatchRef` (the settle arrives later via
 *   `onTaskDone`); `{ kind: 'background' }` without a valid taskId → nothing
 *   mappable (no settle); `{ kind: 'continuable', subagentId }` → no terminal
 *   signal this round → no settle (documented limit); any other successful
 *   value (foreground `{ kind: 'foreground', … }` included) → immediate
 *   settle with the paired identity. A failed result (`isError` or an
 *   `error` payload — fabrication guard, qc2 F-001 / qc3 F-003a fix-wave)
 *   settles `error`.
 * - `recordTaskSettle` (wired through `ctx.inject(['tasks'])` in the entry)
 *   maps a terminal snapshot (`completed → ok / killed → denied / failed →
 *   error`, `durationMs = finishedAt − startedAt` when available) onto the
 *   stored `taskId → dispatchRef` and prunes the consumed task entry.
 * Both pairing maps hold only IN-FLIGHT calls: the `dispatchByCallId` entry
 * is deleted once the post-execute branch resolves the call (each callId
 * pairs exactly once), and `recordTaskSettle` deletes the consumed
 * `dispatchByTaskId` entry (qc1 F-102 / qc2 F-002 / qc3 F-002 fix-wave).
 * Pairing is apply-scoped (D1): the in-memory maps live in the entry's
 * `apply`, so an HMR restart resets them — a post-execute/task-done outside
 * the window stays unpaired and records NOTHING (honest degrade, never
 * fabricated settlement). Non-dispatch tool calls and unpaired payloads
 * record nothing either.
 *
 * Module boundary: no barrel — the entry and the adapter import by explicit
 * relative path; the public exports (`recordDispatch` / `recordSettle` /
 * `readAgentFlow` + constants + types) are re-exported verbatim by the entry.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Context } from 'cordis'
import { assignmentHeaderRegion, parseAssignmentFields } from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AgentFlowEventView, AgentFlowSummaryRow, AgentFlowView } from '../types.ts'
import { asRecord } from './_shared.ts'
import type { Config } from './_shared.ts'
import { isNaValue, planIdOf, sessionIdOf, DEFAULT_DISPATCH_TOOLS } from './dispatch.ts'

/** The agent-flow ledger file name under `{HARNESS_DIR}`. */
export const AGENT_FLOW_FILE = 'agent-flow.jsonl'
/** Truncation bound: the ledger keeps only the most recent events. */
export const AGENT_FLOW_MAX_EVENTS = 500
/** Default read limit (the catalog passes 50 per spec §2.2). */
export const AGENT_FLOW_DEFAULT_LIMIT = 50
/**
 * The append size gate (qc2 F-1 / qc3 F-001/003 — fix-wave): the truncation
 * read-modify-write runs only when the file exceeds ~500 lines' typical
 * size (conservative ≈ 500 × 128 B average line); smaller files stay
 * append-only. The bound is therefore approximate ("~500 events") — a file
 * of unusually tiny events can grow past 500 lines under the gate until its
 * BYTES cross the threshold (documented tradeoff; the gate keeps the common
 * small-file append path free of a full read per dispatch).
 */
export const AGENT_FLOW_SIZE_GATE_BYTES = 64 * 1024
/** Logger label for the agent-flow ledger (dsh logger naming: `<scope>/<subject>`). */
export const AGENT_FLOW_LOGGER = 'mstar/agent-flow'
/**
 * The settle seam name — the dsh-tools registry's `tools/post-execute`
 * waterfall. VERIFIED to be dispatched by the real registry for every tool
 * call (`runPostExecute` → `postExecute`, upstream source; pinned by the
 * real-call probe in `tests/agent-flow.spec.ts`), so settles are no longer
 * host-emission-dependent (plan `20260811-panel-f4-timeliness` Task 1 — the
 * old "not part of the verified surface" assumption is obsolete).
 */
export const SETTLE_SEAM = 'tools/post-execute'
/**
 * The once-per-apply settle-pairing trace (plan `20260811-panel-f4-timeliness`
 * Task 1). Historical name `SETTLE_SEAM_UNAVAILABLE_NOTE` (qc1 F-105 / qc2
 * N-002 fix-wave): the old name claimed the seam was UNAVAILABLE, which the
 * message itself refutes — the seam IS a verified part of the registry
 * surface, so the constant was renamed to the accurate `PAIRING` name. The
 * message states the VERIFIED pairing facts: the seam is emitted by the
 * registry; foreground dispatch calls settle via it, background subagents
 * settle via `ctx.tasks.onTaskDone` pairing; only unpaired payloads stay
 * dispatch-only (never fabricated settlement). Logged ONCE per logger binding
 * (≈ once per apply — the same module-level flag, qc1 F-006) when the pairing
 * listener is registered.
 */
export const SETTLE_SEAM_PAIRING_NOTE =
  `settle seam "${SETTLE_SEAM}" IS part of the verified dsh-tools registry surface (runPostExecute dispatches it for every tool call) — foreground dispatch calls settle here, background subagents settle via ctx.tasks.onTaskDone pairing; only UNPAIRED payloads (non-dispatch tools, calls outside the apply-scoped pairing window) stay dispatch-only — never a fabricated settle`

/** Dispatch verdict vocabulary (spec §2.1.3). */
export type DispatchVerdict = 'ok' | 'advisory' | 'denied'
/** Settle outcome vocabulary (spec §2.1.3). */
export type SettleOutcome = 'ok' | 'error' | 'denied'

/**
 * One v1 ledger event (spec §2.1.3 schema — the JSONL line). Optional fields
 * are OMITTED from the serialized line when absent (Session.append's lossless
 * JSON discipline starts at the record boundary).
 */
export type AgentFlowEvent =
  | {
      v: 1
      ts: number
      kind: 'dispatch'
      /** The dispatching session's stable id (exec.agent.id; host-hook path has no exec → absent). */
      agent?: string
      /** Assignment `Execute as` ('' when missing). */
      role: string
      /** planIdOf(header): `Plan Path` / `SDD dir` / `plan_id` basename. */
      planId?: string
      /** Body `Task N` best-effort extraction (taskIdOf). */
      taskId?: string
      /** Assignment `Task category`. */
      taskCategory?: string
      /** Gate verdict derivation: no violations → ok; hard + violations → denied; else advisory. */
      verdict: DispatchVerdict
      /** resolveDispatchHard result (recorded unconditionally, incl. hard denies). */
      hard: boolean
    }
  | {
      v: 1
      ts: number
      kind: 'settle'
      /** The settled session's stable id (the paired dispatch's agent). */
      agent?: string
      outcome: SettleOutcome
      durationMs?: number
      /**
       * The PAIRED dispatch's identity (plan `20260811-panel-f4-timeliness`
       * Task 1) — same field names + semantics as the dispatch event:
       * `role` is the Assignment `Execute as` ('' when missing), `planId` /
       * `taskId` the plan + `Task N` tags. Written for every paired settle;
       * ABSENT on unpaired (legacy) settles — the client pairs on identity
       * presence. The registry background-task id is deliberately NOT
       * written here (`taskRef` is reserved as the distinct field name if a
       * future audit needs it — it never collides with `taskId`).
       */
      role?: string
      planId?: string
      taskId?: string
    }

/**
 * The identity of one recorded dispatch, carried by the pairing store so a
 * later completion (post-execute settle / onTaskDone terminal) can record a
 * settle carrying the SAME identity fields as its dispatch event.
 */
export interface AgentFlowDispatchRef {
  /** The resolved `{HARNESS_DIR}` the dispatch recorded into (settles record into the same ledger). */
  harnessDir: string
  /** The dispatching session's stable id ('' when the exec carried none). */
  agent?: string
  /** Assignment `Execute as` ('' when missing — the dispatch event's grammar). */
  role: string
  /** `planIdOf(header)` — the dispatch event's grammar. */
  planId?: string
  /** `taskIdOf(prompt)` — the Assignment `Task N` tag, NOT a registry task id. */
  taskId?: string
}

/**
 * The apply-scoped pairing store (plan `20260811-panel-f4-timeliness` Task 1,
 * decision D1 — created in the entry `apply`, same lifetime as the catalog
 * cache; an HMR restart resets it, and completions outside the window stay
 * unpaired → no settle, the documented honest degrade). Maps are keyed by
 * the TWO verified pairing keys: the tool-call `callId` (pre → post-execute)
 * and the registry background-task id (post-execute background shape →
 * `onTaskDone` terminal).
 */
export interface AgentFlowPairing {
  /**
   * The agent-namespaced call key → the dispatch it recorded (populated by
   * `recordDispatch` when an exec is present). Key = `${sessionId}\u0000${callId}`
   * (qc1 F-101 fix-wave): a raw `ToolExecution.callId` is NOT globally unique
   * in one process — dsh runs many sessions concurrently and upstream mints
   * per-message ids (`call-${index}`), so the dispatching session id must
   * namespace the key or session B's same-id call could overwrite session A's
   * pairing and mis-pair A's settle into B's dispatchRef. Consumed (deleted)
   * by the post-execute branch — the map holds only in-flight calls.
   */
  dispatchByCallId: Map<string, AgentFlowDispatchRef>
  /** Registry background-task id (`TaskSnapshot.id`) → the dispatch that started it (populated by the post-execute background branch; consumed by `recordTaskSettle`). */
  dispatchByTaskId: Map<string, AgentFlowDispatchRef>
}

/** Module-scoped log sink (bound to `mstar/agent-flow` by the entry at apply). */
type AgentFlowLogSink = (level: 'info' | 'warn' | 'error', message: string) => void
let logSink: AgentFlowLogSink | undefined
/**
 * Whether the settle-unavailable trace has been logged for the CURRENT sink
 * binding (qc1 F-006: the ~300-char note is emitted at most once per apply,
 * not on every registration).
 */
let settleNoteLogged = false
/**
 * Module-scoped catalog-invalidation hook (plan `20260811-panel-f4-timeliness`
 * Task 1 — the `invalidateCatalog` 挂钩 that Task 2 consumes): called with
 * the affected `{HARNESS_DIR}` after every SUCCESSFUL ledger record
 * (`recordDispatch` / `recordSettle`). The entry binds the real invalidation
 * closure at apply (Task 2 shipped the apply-scoped harnessDir → cache-key
 * reverse-map closure in `index.ts` — see `createCatalogInvalidation`);
 * unbound → no-op. Never throws into the record path.
 */
type AgentFlowInvalidator = (harnessDir: string) => void
let invalidator: AgentFlowInvalidator | undefined

/**
 * Bind the module's catalog-invalidation hook (plan
 * `20260811-panel-f4-timeliness` Task 1 — same pattern as
 * {@link setAgentFlowLogger}; the entry binds at apply; Task 2 shipped the
 * real binding — the apply-scoped harnessDir → cache-key reverse-map
 * closure in `index.ts`).
 * @param invalidate - the hook (`undefined` clears the binding).
 * @returns the PREVIOUS hook (tests restore it in a `finally`).
 */
export function setAgentFlowInvalidator(invalidate: AgentFlowInvalidator | undefined): AgentFlowInvalidator | undefined {
  const prior = invalidator
  invalidator = invalidate
  return prior
}

/**
 * Bind the module's log sink (called once at apply; tests may rebind to
 * capture ledger logs). Rebinding RESETS the once-per-apply settle trace
 * flag — each binding is a fresh "apply" (production binds once; tests bind
 * per case for deterministic capture).
 * @param sink - the sink (entry binds `ctx.logger('mstar/agent-flow')`);
 * `undefined` clears the binding (restores the pre-bind no-op state).
 * @returns the PREVIOUS sink (tests restore it in a `finally`).
 */
export function setAgentFlowLogger(sink: AgentFlowLogSink | undefined): AgentFlowLogSink | undefined {
  const prior = logSink
  logSink = sink
  settleNoteLogged = false
  return prior
}

/** Log one ledger message through the bound sink (no-op before bind). */
function log(level: 'info' | 'warn' | 'error', message: string): void {
  logSink?.(level, message)
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort extraction of the targeted `Task N` from the Assignment BODY
 * (spec §2.1.1 — `taskIdOf`). The engine `assignmentHeaderRegion` boundary is
 * reused: only text AFTER the header region is scanned, so a `## Task N`
 * example quoted in the header never resolves a task id. Only a LEVEL-2
 * heading (`^## Task N`) matches (qc2 F-8: an example or sub-heading at
 * another depth before the real task must not resolve — lower false-hit
 * surface); normalized to `T<n>` (matches the panel render `planId#taskId`,
 * e.g. `20260810-x#T2`).
 * @param prompt - the full Assignment text.
 */
export function taskIdOf(prompt: string): string | undefined {
  const header = assignmentHeaderRegion(prompt)
  const body = prompt.slice(header.length)
  const match = body.match(/^##[ \t]+Task[ \t]+(\d+)\b[^\n]*$/m)
  if (match === null) return undefined
  return `T${match[1]!}`
}

/** Derive the ledger event's optional `agent` from the exec (structural read). */
function agentOfExec(exec: unknown): string | undefined {
  if (exec === undefined) return undefined
  return sessionIdOf(exec as ToolExecution)
}

/** Derive the gate verdict (spec §2.1.3): no violations → ok; hard + violations → denied; else advisory. */
function verdictOf(violations: readonly unknown[], hard: boolean): DispatchVerdict {
  if (violations.length === 0) return 'ok'
  return hard ? 'denied' : 'advisory'
}

/** The tool-call pairing key of an exec, when the seam exposes one (structural read). */
function callIdOf(exec: unknown): string | undefined {
  const rec = asRecord(exec)
  const callId = rec?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

/**
 * The AGENT-NAMESPACED pairing key of one exec (qc1 F-101 fix-wave):
 * `${sessionIdOf(exec) ?? ''}\u0000${callId}`. A raw `callId` alone is NOT
 * globally unique in one process — dsh runs many sessions concurrently and
 * upstream mints per-message ids (`call-${index}`; model-supplied
 * `toolCallId`s are commonly `call_0`-style per message too) — so the key
 * must carry the dispatching session id, or session B's same-id call could
 * overwrite session A's pairing and A's settle would pair into B's dispatchRef
 * (wrong harnessDir + wrong identity — exactly the defect class this plan
 * prevents). Both `recordDispatch` (registration) and `registerSettleListener`
 * (lookup + consumption) derive the key identically from the SAME exec, so an
 * agent-less exec (`sessionIdOf` → '') still pairs to its own registration.
 * @param exec - the tool-execution record (structural read).
 * @returns the namespaced key, or undefined when the exec carries no callId.
 */
function callPairingKey(exec: unknown): string | undefined {
  const callId = callIdOf(exec)
  if (callId === undefined) return undefined
  return `${sessionIdOf(exec as ToolExecution) ?? ''}\u0000${callId}`
}

/**
 * Append one event to `{HARNESS_DIR}/agent-flow.jsonl` and keep the file
 * bounded (spec §2.1.3 — fix-wave qc2 F-1 / qc3 F-001/003). Common path is
 * append-ONLY: after the single `appendFileSync` (a near-atomic O_APPEND
 * write), the file is `stat`-gated — below `AGENT_FLOW_SIZE_GATE_BYTES`
 * (≈500 lines' typical size) the file is NOT re-read (no read-modify-write
 * per dispatch). Only when the size crosses the gate is the file read and,
 * if it holds more than `AGENT_FLOW_MAX_EVENTS` lines, truncated — and the
 * truncating overwrite is an ATOMIC temp-file + `renameSync` replace (write
 * `agent-flow.jsonl.tmp` → rename), so concurrent readers never observe a
 * torn file and the cross-process loss window is narrowed to the single
 * append step (see the module doc single-writer note). May throw (fs) —
 * callers contain.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param event - the v1 event to record.
 */
function appendEvent(harnessDir: string, event: AgentFlowEvent): void {
  const file = join(harnessDir, AGENT_FLOW_FILE)
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  if (statSync(file).size <= AGENT_FLOW_SIZE_GATE_BYTES) return
  // Truncate: keep only the most recent MAX lines (JSON Lines; a trailing
  // newline produces one empty tail element that must not count as a line).
  const content = readFileSync(file, 'utf8')
  const lines = content.replace(/\n$/, '').split('\n')
  if (lines.length > AGENT_FLOW_MAX_EVENTS) {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${lines.slice(-AGENT_FLOW_MAX_EVENTS).join('\n')}\n`)
    renameSync(tmp, file)
  }
}

/**
 * Record one dispatch event (spec §2.1.3). Fully try/catch-contained — NEVER
 * throws into the gate; a failing record logs only (`mstar/agent-flow`).
 * Verdict derivation (ok/advisory/denied, incl. hard denies) and the header
 * identity derivation (role / planId / taskId / taskCategory) reuse the gate's
 * own parsers — one grammar.
 *
 * Pairing (plan `20260811-panel-f4-timeliness` Task 1): when the input
 * carries an `exec` AND the apply-scoped `pairing` store, the successful
 * record registers the agent-namespaced key `${sessionId}\u0000${callId}` →
 * dispatchRef (the full dispatch identity), so a later
 * `tools/post-execute` for the same call can settle with the SAME identity
 * (qc1 F-101 fix-wave: the session id namespaces the key — a raw callId is
 * not globally unique across sessions in one process). The pairing registers
 * only after the ledger append SUCCEEDED — a failed record never pairs to a
 * phantom dispatch. An exec-less record (host-hook path) has no callId → no
 * pairing. The pairing sub-path has its OWN catch scope (qc1 F-106 / qc2
 * N-001 / qc3 F-006 fix-wave): a `Map.set` throw must not log "record
 * failed" after the dispatch was already appended.
 * @param input - harness dir + exec (agent id) + Assignment text + the gate's
 * violations + the hard-enforcement resolution + the apply-scoped pairing
 * store (the adapter passes its own; direct callers may omit it).
 */
export function recordDispatch(input: {
  harnessDir: string
  exec?: unknown
  prompt: string
  violations: readonly unknown[]
  hard: boolean
  pairing?: AgentFlowPairing
}): void {
  try {
    const header = assignmentHeaderRegion(input.prompt)
    const fields = parseAssignmentFields(header)
    const planId = planIdOf(header)
    const taskId = taskIdOf(input.prompt)
    const taskCategory = fields.taskCategory
    const agent = input.exec !== undefined ? agentOfExec(input.exec) : undefined
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'dispatch',
      ...(agent !== undefined ? { agent } : {}),
      role: fields.executeAs ?? '',
      ...(planId !== undefined && !isNaValue(planId) ? { planId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(taskCategory !== undefined && taskCategory.trim() !== '' ? { taskCategory } : {}),
      verdict: verdictOf(input.violations, input.hard),
      hard: input.hard,
    }
    appendEvent(input.harnessDir, event)
    try {
      invalidator?.(input.harnessDir)
    } catch (error) {
      log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
    }
    // callId pairing — only for exec-bound records after a SUCCESSFUL append.
    // Registered whenever the call id is present (the dispatchRef may carry no
    // agent for agent-less calls — the settle then records what it knows and
    // the client pairing honestly stays unpaired without an agent). Keyed by
    // the agent-namespaced call key (qc1 F-101 fix-wave).
    try {
      if (input.pairing !== undefined && input.exec !== undefined) {
        const key = callPairingKey(input.exec)
        if (key !== undefined) {
          input.pairing.dispatchByCallId.set(key, {
            harnessDir: input.harnessDir,
            ...(agent !== undefined ? { agent } : {}),
            role: fields.executeAs ?? '',
            ...(planId !== undefined && !isNaValue(planId) ? { planId } : {}),
            ...(taskId !== undefined ? { taskId } : {}),
          })
        }
      }
    } catch (error) {
      // Own catch scope (qc1 F-106 / qc2 N-001 / qc3 F-006 fix-wave): a
      // pairing-registration throw must not claim the DISPATCH record failed
      // — the event was already appended successfully above.
      log('error', `pairing registration failed (contained — the dispatch record succeeded): ${errorMessage(error)}`)
    }
  } catch (error) {
    log('error', `dispatch record failed (contained — dispatch proceeds): ${errorMessage(error)}`)
  }
}

/**
 * Record one settle event (spec §2.1.3). Fully try/catch-contained; a failing
 * record logs only. Callers resolve the harness dir from the PAIRED dispatch
 * (the pairing store's dispatchRef — never a payload probe).
 * @param input - harness dir + agent id + outcome + optional duration + the
 * PAIRED dispatch's identity (`role`/`planId`/`taskId` — same field names +
 * semantics as the dispatch event; written for every paired settle, so the
 * client can exactly pair the settle back to its dispatch).
 */
export function recordSettle(input: {
  harnessDir: string
  agent?: string
  outcome: SettleOutcome
  durationMs?: number
  role?: string
  planId?: string
  taskId?: string
}): void {
  try {
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'settle',
      ...(input.agent !== undefined && input.agent.trim() !== '' ? { agent: input.agent } : {}),
      outcome: input.outcome,
      ...(input.durationMs !== undefined && Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.planId !== undefined && input.planId !== '' ? { planId: input.planId } : {}),
      ...(input.taskId !== undefined && input.taskId !== '' ? { taskId: input.taskId } : {}),
    }
    appendEvent(input.harnessDir, event)
    try {
      invalidator?.(input.harnessDir)
    } catch (error) {
      log('error', `catalog invalidation failed (contained): ${errorMessage(error)}`)
    }
  } catch (error) {
    log('error', `settle record failed (contained): ${errorMessage(error)}`)
  }
}

/** Narrow an unknown JSONL line to a valid v1 event (malformed lines → undefined). */
function eventFromUnknown(value: unknown): AgentFlowEvent | undefined {
  const rec = asRecord(value)
  if (rec === undefined || rec.v !== 1 || typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return undefined
  const kind = rec.kind
  if (kind !== 'dispatch' && kind !== 'settle') return undefined
  const agent = typeof rec.agent === 'string' && rec.agent !== '' ? rec.agent : undefined
  if (kind === 'dispatch') {
    if (typeof rec.role !== 'string' || typeof rec.hard !== 'boolean') return undefined
    const verdict = rec.verdict
    if (verdict !== 'ok' && verdict !== 'advisory' && verdict !== 'denied') return undefined
    return {
      v: 1,
      ts: rec.ts,
      kind: 'dispatch',
      ...(agent !== undefined ? { agent } : {}),
      role: rec.role,
      ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
      ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
      ...(typeof rec.taskCategory === 'string' && rec.taskCategory !== '' ? { taskCategory: rec.taskCategory } : {}),
      verdict,
      hard: rec.hard,
    }
  }
  const outcome = rec.outcome
  if (outcome !== 'ok' && outcome !== 'error' && outcome !== 'denied') return undefined
  return {
    v: 1,
    ts: rec.ts,
    kind: 'settle',
    ...(agent !== undefined ? { agent } : {}),
    outcome,
    ...(typeof rec.durationMs === 'number' && Number.isFinite(rec.durationMs) ? { durationMs: rec.durationMs } : {}),
    // Paired-dispatch identity (plan `20260811-panel-f4-timeliness` Task 1):
    // `role` presence marks a PAIRED settle (kept even when '' — an
    // empty-role identity is still an identity); planId/taskId omit when empty.
    ...(typeof rec.role === 'string' ? { role: rec.role } : {}),
    ...(typeof rec.planId === 'string' && rec.planId !== '' ? { planId: rec.planId } : {}),
    ...(typeof rec.taskId === 'string' && rec.taskId !== '' ? { taskId: rec.taskId } : {}),
  }
}

/** Map one ledger event to its catalog view (settle rows carry the paired identity when present). */
function eventView(event: AgentFlowEvent): AgentFlowEventView {
  if (event.kind === 'dispatch') {
    return {
      ts: event.ts,
      kind: 'dispatch',
      agent: event.agent ?? null,
      role: event.role,
      planId: event.planId ?? null,
      taskId: event.taskId ?? null,
      taskCategory: event.taskCategory ?? null,
      ...(event.verdict !== undefined ? { verdict: event.verdict } : {}),
      ...(event.hard !== undefined ? { hard: event.hard } : {}),
    }
  }
  return {
    ts: event.ts,
    kind: 'settle',
    agent: event.agent ?? null,
    role: event.role ?? '',
    planId: event.planId ?? null,
    taskId: event.taskId ?? null,
    taskCategory: null,
    // Presence marker: a PAIRED settle (carries the dispatch identity) — the
    // client pairs on it (legacy unpaired settles stay unpaired, honest).
    ...(event.role !== undefined ? { paired: true } : {}),
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  }
}

/** Role × outcome counts of a bounded latest-first event window (count desc). */
function summaryOf(events: readonly AgentFlowEvent[]): AgentFlowSummaryRow[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    const role = event.kind === 'dispatch' ? event.role : ''
    const outcome = event.kind === 'dispatch' ? event.verdict : event.outcome
    const key = `${role}\u0000${outcome}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [role, outcome] = key.split('\u0000')
      return { role: role!, outcome: outcome!, count }
    })
    // count desc; ties break deterministically (role, then outcome) so the
    // summary is stable for consumers (the model line / panel).
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role) || a.outcome.localeCompare(b.outcome))
}

/**
 * Read the agent-flow ledger as the catalog view (spec §2.1.3 — fix-wave
 * qc1 F-001 / qc2 F-6): the latest events first (bounded by `limit`) plus
 * the role × outcome summary over the SAME window (so `by role` counts sum
 * to the event count). A MISSING ledger file returns the EMPTY view
 * `{ events: [], summary: [] }` — recording hasn't started (it begins at
 * plan merge), and the panel renders its "no actual dispatches yet" empty
 * state instead of an evidence-missing degrade; only an UNREADABLE file
 * returns null (advisory degrade — the catalog renders no agent-flow line).
 * Malformed lines are skipped, never fatal.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param limit - explicit window bound: `undefined` → `AGENT_FLOW_DEFAULT_LIMIT`;
 * otherwise `Math.max(0, Math.floor(limit))` — `0` requests the EMPTY window.
 */
export function readAgentFlow(harnessDir: string, limit?: number): AgentFlowView | null {
  const file = join(harnessDir, AGENT_FLOW_FILE)
  if (!existsSync(file)) {
    // Missing ledger = no records yet — the empty view, never a degrade.
    return { events: [], summary: [] }
  }
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return null // unreadable (EACCES / io error) — advisory degrade only
  }
  const events: AgentFlowEvent[] = []
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as unknown
      const event = eventFromUnknown(parsed)
      if (event !== undefined) events.push(event)
    } catch {
      continue // malformed line — skip, never crash the catalog
    }
  }
  // Explicit limit semantics (qc2 F-6): undefined → default; otherwise a
  // non-negative floor — `0` → the empty window.
  const n = limit === undefined ? AGENT_FLOW_DEFAULT_LIMIT : Math.max(0, Math.floor(limit))
  const latestFirst = events.reverse().slice(0, n)
  return {
    events: latestFirst.map(eventView),
    summary: summaryOf(latestFirst),
  }
}

/* ---------------------------------- settle (real completion pairing) ---------------------------------- */

/**
 * Record a settle carrying a PAIRED dispatch's identity (plan
 * `20260811-panel-f4-timeliness` Task 1): the harness dir + agent + identity
 * come from the dispatchRef (the apply-scoped pairing store) — never probed
 * from a payload. `role` is always written (the dispatchRef always carries
 * it, possibly ''); planId/taskId omit when absent — the same field
 * names + semantics as the dispatch event.
 */
function recordSettleWithRef(ref: AgentFlowDispatchRef, outcome: SettleOutcome, durationMs: number | undefined): void {
  recordSettle({
    harnessDir: ref.harnessDir,
    ...(ref.agent !== undefined && ref.agent.trim() !== '' ? { agent: ref.agent } : {}),
    outcome,
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    role: ref.role,
    ...(ref.planId !== undefined ? { planId: ref.planId } : {}),
    ...(ref.taskId !== undefined ? { taskId: ref.taskId } : {}),
  })
}

/**
 * The `tools/post-execute` settle pairing (plan `20260811-panel-f4-timeliness`
 * Task 1 — replaces the old defensive payload probing): the VERIFIED
 * dsh-tools registry dispatches this seam for every tool call
 * (`runPostExecute` → `postExecute`, upstream source), so the listener only
 * decides whether a completion signal exists for the PAIRED dispatch:
 *
 * - non-dispatch tool (`exec.name` ∉ Config `dispatchTools`) → nothing;
 * - dispatch tool whose agent-namespaced call key
 *   (`${sessionId}\u0000${callId}`, qc1 F-101 fix-wave) is not in the pairing
 *   store (HMR reset, host-hook dispatch, non-gate path) → nothing (warned
 *   once per registration — honest degrade, never fabricated settlement);
 * - `result.isError === true` OR an `error` payload present → settle `error`
 *   immediately (fabrication guard, qc2 F-001 / qc3 F-003a — the dispatch
 *   call failed; a result carrying `error` without `isError` never settles ok);
 * - successful `result.value` shape `{ kind: 'background', taskId }` with a
 *   valid taskId → store `taskId → dispatchRef` (the real settle arrives via
 *   `ctx.tasks.onTaskDone`); `{ kind: 'background' }` WITHOUT a valid taskId
 *   → nothing mappable (no settle, qc3 F-003b);
 * - `{ kind: 'continuable', subagentId }` → no terminal signal this round →
 *   no settle (documented limit — the child owns its turns);
 * - any other successful value (foreground `{ kind: 'foreground', … }`
 *   included) → settle `ok` (the call completed synchronously).
 * The consumed `dispatchByCallId` entry is DELETED after the branch resolves
 * the call (map pruning, qc1 F-102 / qc2 F-002 / qc3 F-002 — each callId
 * pairs exactly once; the map holds only in-flight calls).
 *
 * The waterfall MUST be delegated via `next()` on every path — returning
 * without calling `next` bails the chain and breaks every tool call. A
 * throwing record never propagates.
 *
 * Cordis typing note: `ctx.on` only accepts declared event keys and
 * `tools/post-execute` is undeclared — the registration casts through the
 * runtime-accepted event-name string (the event bus dispatches any name).
 * @param ctx - registrant context (fiber disposal unwinds the listener).
 * @param config - the plugin Config (dispatch-tool matching).
 * @param pairing - the apply-scoped pairing store (dispatchByCallId read,
 * dispatchByTaskId written by the background branch).
 */
export function registerSettleListener(ctx: Context, config: Config, pairing: AgentFlowPairing): void {
  const dispatchTools = config.dispatchTools ?? [...DEFAULT_DISPATCH_TOOLS]
  let unpairedWarned = false
  const listener = (exec: unknown, result: unknown, next?: () => unknown): unknown => {
    try {
      const execRec = asRecord(exec)
      const name = execRec === undefined ? undefined : execRec.name
      if (typeof name !== 'string' || !dispatchTools.includes(name)) {
        // Non-dispatch tool call → no record (the waterfall still delegates below).
      } else {
        // Agent-namespaced call key (qc1 F-101 fix-wave): a raw callId is not
        // globally unique across sessions in one process — the session id in
        // the key keeps this settle from pairing into ANOTHER session's
        // dispatchRef. Same derivation as `recordDispatch` registration.
        const key = callPairingKey(exec)
        const dispatchRef = key !== undefined ? pairing.dispatchByCallId.get(key) : undefined
        if (dispatchRef === undefined) {
          // Dispatch tool with no paired call key (HMR reset / host-hook /
          // non-gate path) → honest no-settle; warned once per registration.
          if (!unpairedWarned) {
            unpairedWarned = true
            log('warn', `${SETTLE_SEAM} for dispatch tool "${name}" had no paired call key (${key ?? 'none'}) — no settle recorded (pairing window missed / HMR reset; honest degrade)`)
          }
        } else {
          const resultRec = asRecord(result)
          if (resultRec !== undefined) {
            // Fabrication guard (qc2 F-001 / qc3 F-003a fix-wave): a failed
            // result detected by EITHER the canonical `isError` flag OR an
            // `error` payload settles `error` — a result carrying `error`
            // without `isError: true` must NEVER settle a fabricated `ok`.
            if (resultRec.isError === true || resultRec.error !== undefined) {
              // The dispatch call itself failed → settle error.
              recordSettleWithRef(dispatchRef, 'error', undefined)
            } else {
              const value = asRecord(resultRec.value)
              if (value !== undefined && value.kind === 'background') {
                if (typeof value.taskId === 'string' && value.taskId !== '') {
                  // Background task started — the settle arrives via onTaskDone.
                  pairing.dispatchByTaskId.set(value.taskId, dispatchRef)
                }
                // Background WITHOUT a valid taskId → nothing mappable (qc3
                // F-003b fix-wave) — never a fabricated ok settle.
              } else if (value !== undefined && value.kind === 'continuable') {
                // Continuable child — no terminal signal this round → honest no-settle.
              } else {
                // Foreground / any other successful value → the call completed.
                recordSettleWithRef(dispatchRef, 'ok', undefined)
              }
            }
          }
          // resultRec === undefined → no result payload at all — nothing mappable.
        }
        // The call is CONSUMED — each callId pairs exactly once (map pruning,
        // qc1 F-102 / qc2 F-002 / qc3 F-002 fix-wave): the dispatchByCallId
        // entry is deleted after the post-execute branch resolves the call, so
        // the map holds only in-flight calls (a no-op when the key was never
        // registered or already consumed).
        if (key !== undefined) pairing.dispatchByCallId.delete(key)
      }
    } catch (error) {
      log('error', `settle record failed (contained): ${errorMessage(error)}`)
    }
    // Waterfall dispatch (real registry) hands a `next` — delegate on EVERY
    // path (returning without calling next bails the waterfall and breaks
    // every tool call); a direct host emission (plain `emit`) has no `next`
    // and stays silent.
    return next === undefined ? undefined : next()
  }
  ctx.on(SETTLE_SEAM as never, listener as never)
  // The pairing trace is emitted at most ONCE per logger binding (≈ once per
  // apply — qc1 F-006): repeated registrations (tests, HMR) must not re-spam.
  if (!settleNoteLogged) {
    settleNoteLogged = true
    log('info', SETTLE_SEAM_PAIRING_NOTE)
  }
}

/**
 * The structural read of the dsh-tasks terminal snapshot the pairing consumes
 * (plan `20260811-panel-f4-timeliness` Task 1). The `ctx.tasks.onTaskDone`
 * contract was verified against the upstream `@deepseek-ai/dsh-tasks`
 * `types.ts`: `TaskDoneListener = (snapshot, owner) => …`, terminal
 * `snapshot.status` ∈ `completed | killed | failed`, `startedAt`/`finishedAt`
 * are epoch ms (`finishedAt` absent while running). Structural (no runtime or
 * type import of the optional dsh-tasks seam — the plugin treats it as an
 * optional service, wired via `ctx.inject(['tasks'])`).
 */
export interface TaskDoneSnapshot {
  /** The registry-issued task id (`<kind>-N`, e.g. `subagent-1`). */
  id: string
  /** Terminal lifecycle status: `completed | killed | failed`. */
  status: string
  /** Epoch ms when the task was registered. */
  startedAt?: number
  /** Epoch ms when the task settled. */
  finishedAt?: number
}

/**
 * Record the settle for one background-task terminal (plan
 * `20260811-panel-f4-timeliness` Task 1 — the `ctx.tasks.onTaskDone` path):
 * the snapshot's task id must hit the pairing store's `dispatchByTaskId`
 * (populated by the post-execute background branch) — a miss records NOTHING
 * (honest degrade, never fabricated). Outcome mapping: `completed → ok` /
 * `killed → denied` / `failed → error`; `durationMs = finishedAt − startedAt`
 * when both are present. After a SUCCESSFUL settle the consumed
 * `dispatchByTaskId` entry is deleted (map pruning, qc1 F-102 / qc2 F-002 /
 * qc3 F-002 — the map holds only in-flight tasks; a contract-violating
 * non-terminal snapshot records nothing and KEEPS the entry so a later real
 * terminal can still settle). Fully contained — never throws into the task
 * registry's listener notification.
 * @param snapshot - the terminal task snapshot (structural read).
 * @param pairing - the apply-scoped pairing store.
 */
export function recordTaskSettle(snapshot: TaskDoneSnapshot, pairing: AgentFlowPairing): void {
  try {
    const dispatchRef = pairing.dispatchByTaskId.get(snapshot.id)
    if (dispatchRef === undefined) return // unpaired task → no settle
    // Terminal mapping (spec R1): completed → ok / killed → denied / failed →
    // error. Anything ELSE (a contract-violating non-terminal snapshot) maps
    // to NOTHING — never a guessed outcome.
    let outcome: SettleOutcome
    if (snapshot.status === 'completed') outcome = 'ok'
    else if (snapshot.status === 'killed') outcome = 'denied'
    else if (snapshot.status === 'failed') outcome = 'error'
    else return
    const durationMs = typeof snapshot.startedAt === 'number' && typeof snapshot.finishedAt === 'number'
      ? snapshot.finishedAt - snapshot.startedAt
      : undefined
    recordSettleWithRef(dispatchRef, outcome, durationMs)
    // Consumed — the map holds only in-flight tasks (qc1 F-102 / qc2 F-002 /
    // qc3 F-002 fix-wave).
    pairing.dispatchByTaskId.delete(snapshot.id)
  } catch (error) {
    log('error', `settle record failed (contained): ${errorMessage(error)}`)
  }
}
