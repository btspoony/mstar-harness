/**
 * Agent-flow ledger — the server-side record of ACTUAL subagent dispatch and
 * (best-effort) settle events (plan `20260810-agent-flow-catalog-graph`, spec
 * §2.1 定稿). The context catalog's `state.agentFlow` evidence reads this
 * ledger, so the panel can render what actually happened (vs the client-side
 * expected role flow).
 *
 * Recording point (spec §2.1.1): the shared `DshHostAdapter.dispatchGate`
 * core — the ONE validation path behind the `tools/pre-execute` listener
 * (exec-bound) and the host `beforeDispatch` hook (exec-less). Every
 * Assignment-shaped dispatch that reaches the gate records, INCLUDING hard
 * denies (verdict derivation below); non-Assignment delegation never reaches
 * the gate and stays silent. Recording is advisory: every record path is
 * try/catch-contained and logs only (`mstar/agent-flow`) — a failing ledger
 * never blocks a dispatch (documented degrade).
 *
 * File / bounds (spec §2.1.3): `{HARNESS_DIR}/agent-flow.jsonl` (JSON Lines;
 * harness dirs are gitignored by convention). One event per line; after every
 * append the file is truncated to the most recent `AGENT_FLOW_MAX_EVENTS`
 * (500) lines (read-all → tail → overwrite — bounded small file).
 * `readAgentFlow` returns the latest-first view (default limit 50) with a
 * role × outcome summary; missing/unreadable file → null; malformed lines are
 * skipped, never fatal.
 *
 * Settle (spec §2.1.2 — Tier 2, best-effort): `tools/post-execute` is NOT
 * part of the verified dsh-tools consumer surface (the peer-stub declares
 * only `tools/pre-execute`), so settle events depend on HOST emission.
 * `registerSettleListener` wires a defensive listener (error-containment
 * envelope + payload shape probing — an unmapped payload is dropped with a
 * one-line log). A host that never emits the seam leaves the ledger
 * dispatch-only — the documented settle-unavailable degrade; the panel must
 * not fabricate settlement. The Task 1 verification gate proves both halves:
 * the listener records a settle when a host emits (simulated in-test), and
 * the dev-time registry emits no post-execute (real-call assertion).
 *
 * Module boundary: no barrel — the entry and the adapter import by explicit
 * relative path; the public exports (`recordDispatch` / `recordSettle` /
 * `readAgentFlow` + constants + types) are re-exported verbatim by the entry.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Context } from 'cordis'
import { assignmentHeaderRegion, parseAssignmentFields } from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { AgentFlowEventView, AgentFlowSummaryRow, AgentFlowView } from '../types.ts'
import { asRecord, type HarnessResolver } from './_shared.ts'
import { planIdOf, sessionIdOf } from './dispatch.ts'

/** The agent-flow ledger file name under `{HARNESS_DIR}`. */
export const AGENT_FLOW_FILE = 'agent-flow.jsonl'
/** Truncation bound: the ledger keeps only the most recent events. */
export const AGENT_FLOW_MAX_EVENTS = 500
/** Default read limit (the catalog passes 50 per spec §2.2). */
export const AGENT_FLOW_DEFAULT_LIMIT = 50
/** Logger label for the agent-flow ledger (dsh logger naming: `<scope>/<subject>`). */
export const AGENT_FLOW_LOGGER = 'mstar/agent-flow'
/**
 * The settle seam name. Not part of the verified dsh-tools consumer surface
 * (peer-stub declares only `tools/pre-execute`) — see the module doc for the
 * Tier-2 best-effort semantics.
 */
export const SETTLE_SEAM = 'tools/post-execute'
/**
 * The human-readable settle-unavailable trace (spec §2.1.2 verification
 * gate): logged once when the defensive settle listener is registered and
 * documented as the ledger's dispatch-only degrade. A host that emits
 * `tools/post-execute` upgrades the ledger to dispatch + settle; one that
 * never does leaves this trace as the visible confirmation.
 */
export const SETTLE_SEAM_UNAVAILABLE_NOTE =
  `settle seam "${SETTLE_SEAM}" is not part of the verified dsh-tools surface (the consumed peer-stub declares only tools/pre-execute) — settle events depend on host emission (best-effort); the agent-flow ledger stays dispatch-only until a host emits the seam`

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
      /** The settled session's stable id (payload-probed). */
      agent?: string
      outcome: SettleOutcome
      durationMs?: number
    }

/** Module-scoped log sink (bound to `mstar/agent-flow` by the entry at apply). */
type AgentFlowLogSink = (level: 'info' | 'warn' | 'error', message: string) => void
let logSink: AgentFlowLogSink | undefined

/**
 * Bind the module's log sink (called once at apply; tests may rebind to
 * capture ledger logs).
 * @param sink - the sink (entry binds `ctx.logger('mstar/agent-flow')`);
 * `undefined` clears the binding (restores the pre-bind no-op state).
 * @returns the PREVIOUS sink (tests restore it in a `finally`).
 */
export function setAgentFlowLogger(sink: AgentFlowLogSink | undefined): AgentFlowLogSink | undefined {
  const prior = logSink
  logSink = sink
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

/** A header value that means "no value" (placeholder conventions). */
function isNaValue(value: string | undefined): value is undefined {
  return value === undefined || /^(?:n\/?a|none)$/i.test(value)
}

/**
 * Best-effort extraction of the targeted `Task N` from the Assignment BODY
 * (spec §2.1.1 — `taskIdOf`). The engine `assignmentHeaderRegion` boundary is
 * reused: only text AFTER the header region is scanned, so a `## Task N`
 * example quoted in the header never resolves a task id. The FIRST numbered
 * task heading in the body wins (assignments target one task); normalized to
 * `T<n>` (matches the panel render `planId#taskId`, e.g. `20260810-x#T2`).
 * @param prompt - the full Assignment text.
 */
export function taskIdOf(prompt: string): string | undefined {
  const header = assignmentHeaderRegion(prompt)
  const body = prompt.slice(header.length)
  const match = body.match(/^#{1,6}[ \t]+Task[ \t]+(\d+)\b[^\n]*$/m)
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

/**
 * Append one event to `{HARNESS_DIR}/agent-flow.jsonl` and truncate the file
 * to the most recent `AGENT_FLOW_MAX_EVENTS` lines (read-all → tail →
 * overwrite — the documented bounded-file tradeoff). May throw (fs) — callers
 * contain.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param event - the v1 event to record.
 */
function appendEvent(harnessDir: string, event: AgentFlowEvent): void {
  const file = join(harnessDir, AGENT_FLOW_FILE)
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  // Truncate: keep only the most recent MAX lines (JSON Lines; a trailing
  // newline produces one empty tail element that must not count as a line).
  const content = readFileSync(file, 'utf8')
  const lines = content.replace(/\n$/, '').split('\n')
  if (lines.length > AGENT_FLOW_MAX_EVENTS) {
    writeFileSync(file, `${lines.slice(-AGENT_FLOW_MAX_EVENTS).join('\n')}\n`)
  }
}

/**
 * Record one dispatch event (spec §2.1.3). Fully try/catch-contained — NEVER
 * throws into the gate; a failing record logs only (`mstar/agent-flow`).
 * Verdict derivation (ok/advisory/denied, incl. hard denies) and the header
 * identity derivation (role / planId / taskId / taskCategory) reuse the gate's
 * own parsers — one grammar.
 * @param input - harness dir + exec (agent id) + Assignment text + the gate's
 * violations + the hard-enforcement resolution.
 */
export function recordDispatch(input: {
  harnessDir: string
  exec?: unknown
  prompt: string
  violations: readonly unknown[]
  hard: boolean
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
  } catch (error) {
    log('error', `dispatch record failed (contained — dispatch proceeds): ${errorMessage(error)}`)
  }
}

/**
 * Record one settle event (spec §2.1.3). Fully try/catch-contained; a failing
 * record logs only. Callers (the defensive settle listener) resolve the
 * harness dir from the payload's agent workspace.
 * @param input - harness dir + agent id + outcome + optional duration.
 */
export function recordSettle(input: {
  harnessDir: string
  agent?: string
  outcome: SettleOutcome
  durationMs?: number
}): void {
  try {
    const event: AgentFlowEvent = {
      v: 1,
      ts: Date.now(),
      kind: 'settle',
      ...(input.agent !== undefined && input.agent.trim() !== '' ? { agent: input.agent } : {}),
      outcome: input.outcome,
      ...(input.durationMs !== undefined && Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}),
    }
    appendEvent(input.harnessDir, event)
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
  }
}

/** Map one ledger event to its catalog view (settle rows carry no role/plan identity → empty/null). */
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
    role: '',
    planId: null,
    taskId: null,
    taskCategory: null,
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
 * Read the agent-flow ledger as the catalog view (spec §2.1.3): the latest
 * events first (bounded by `limit`, default 50) plus the role × outcome
 * summary over the SAME window (so `by role` counts sum to the event count).
 * Returns null when the file is missing or unreadable (advisory degrade —
 * the catalog renders no agent-flow line). Malformed lines are skipped, never
 * fatal.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param limit - view bound (default `AGENT_FLOW_DEFAULT_LIMIT`).
 */
export function readAgentFlow(harnessDir: string, limit?: number): AgentFlowView | null {
  const file = join(harnessDir, AGENT_FLOW_FILE)
  if (!existsSync(file)) return null
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return null
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
  const n = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : AGENT_FLOW_DEFAULT_LIMIT
  const latestFirst = events.reverse().slice(0, n)
  return {
    events: latestFirst.map(eventView),
    summary: summaryOf(latestFirst),
  }
}

/* ---------------------------------- settle (Tier-2) ---------------------------------- */

/** Probe a value for an agent identity: a string id or an `{ id }` handle. */
function agentIdOf(value: unknown): string | undefined {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  if (typeof rec.agent === 'string' && rec.agent.trim() !== '') return rec.agent
  const agent = asRecord(rec.agent)
  const id = agent?.id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/** Probe a value for a settle outcome: explicit `outcome` / `isError` / `error` keys. */
function outcomeOf(value: unknown): SettleOutcome | undefined {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const outcome = rec.outcome
  if (outcome === 'ok' || outcome === 'error' || outcome === 'denied') return outcome
  if (rec.isError === true) return 'error'
  if (rec.isError === false) return 'ok'
  if (rec.error !== undefined) return 'error'
  return undefined
}

/** Probe a value for a settle duration (finite number). */
function durationOf(value: unknown): number | undefined {
  const rec = asRecord(value)
  if (rec === undefined) return undefined
  const duration = rec.durationMs
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined
}

/** The agent HANDLE of a settle payload arg (for workspace resolution), when present. */
function agentHandleOf(value: unknown): unknown {
  return asRecord(value)?.agent
}

/** One mapped settle from a probed payload (undefined when nothing maps). */
interface MappedSettle {
  agent?: string
  outcome: SettleOutcome
  durationMs?: number
}

/**
 * Shape-probe an unknown settle payload into a recordable event. Two forms
 * are tolerated because the seam's payload is unverified: a single-object
 * payload `{ exec?, result?, agent?, outcome?, durationMs? }` and the
 * `(exec, result)` pair (ToolExecution + ToolExecutionResult-ish). Returns
 * undefined when no outcome can be derived — the caller logs once and records
 * nothing (spec §2.1.2: never fabricate settlement).
 */
function settleFromArgs(exec: unknown, result: unknown): MappedSettle | undefined {
  const first = asRecord(exec)
  const second = asRecord(result)
  // Single-object payload form: `{ exec?, result?, agent?, outcome?, durationMs? }`
  // — detected by the NESTED exec/result keys only (a ToolExecution carries an
  // `agent` field too, so `agent`/`outcome` alone never selects this branch).
  if (first !== undefined && (first.exec !== undefined || first.result !== undefined)) {
    const nestedExec = asRecord(first.exec)
    const nestedResult = asRecord(first.result)
    const agent = agentIdOf(first) ?? (nestedExec !== undefined ? agentIdOf(nestedExec) : undefined)
    const outcome = outcomeOf(first) ?? (nestedResult !== undefined ? outcomeOf(nestedResult) : undefined)
    if (outcome !== undefined) {
      const durationMs = durationOf(first) ?? (nestedResult !== undefined ? durationOf(nestedResult) : undefined)
      return { ...(agent !== undefined ? { agent } : {}), outcome, ...(durationMs !== undefined ? { durationMs } : {}) }
    }
    // Nested probe found no outcome — fall through to the pair form (the first
    // arg may actually be the ToolExecution of a `(exec, result)` emission).
  }
  // Pair form: `(exec, result)` — ToolExecution + ToolExecutionResult-ish.
  const agent = agentIdOf(first) ?? agentIdOf(second)
  const outcome = outcomeOf(second) ?? outcomeOf(first)
  if (outcome === undefined) return undefined
  const durationMs = durationOf(second) ?? durationOf(first)
  return { ...(agent !== undefined ? { agent } : {}), outcome, ...(durationMs !== undefined ? { durationMs } : {}) }
}

/**
 * Register the defensive `tools/post-execute` settle listener (spec §2.1.2 —
 * Tier 2, best-effort). The seam is NOT part of the verified dsh-tools
 * consumer surface, so the registration is defensive and error-contained: an
 * unmapped payload logs once and records nothing; a throwing record never
 * propagates. A host that emits the seam upgrades the ledger to dispatch +
 * settle; one that never does leaves the ledger dispatch-only (the
 * settle-unavailable trace is logged once at registration and documented).
 *
 * Cordis typing note: `ctx.on` only accepts declared event keys and
 * `tools/post-execute` is undeclared — the registration casts through the
 * runtime-accepted event-name string (the event bus dispatches any name; a
 * host that never emits simply never triggers the listener).
 * @param ctx - registrant context (fiber disposal unwinds the listener).
 * @param resolver - per-workspace `{HARNESS_DIR}` resolver (the payload's
 * agent workspace — never the process cwd).
 */
export function registerSettleListener(ctx: Context, resolver: HarnessResolver): void {
  const listener = (exec: unknown, result: unknown): void => {
    try {
      const mapped = settleFromArgs(exec, result)
      if (mapped === undefined) {
        log('warn', `${SETTLE_SEAM} payload did not map to a settle event (unverified shape) — nothing recorded`)
        return
      }
      const harnessDir = resolver.forAgent(agentHandleOf(exec) ?? agentHandleOf(result))
      if (harnessDir === null) return
      recordSettle({ harnessDir, agent: mapped.agent, outcome: mapped.outcome, durationMs: mapped.durationMs })
    } catch (error) {
      log('error', `settle record failed (contained): ${errorMessage(error)}`)
    }
  }
  ctx.on(SETTLE_SEAM as never, listener as never)
  log('info', SETTLE_SEAM_UNAVAILABLE_NOTE)
}
