/**
 * `projectGraph(source): GraphView` — the pure projection of the
 * `mstar-engine-status` catalog source onto the workflow graph (spec
 * panel-layout-graph §2.1–§2.5). Total function: NEVER throws, produces no
 * React/ReactFlow types, and degrades per field instead of guessing — the
 * same philosophy as `selectEngineStatus`'s try/catch fallback and the
 * `guards.ts` contract (missing → `unknown`, never a fabricated value).
 *
 * Two strictly separated inputs (spec §2.0):
 * - schema constants (`./schema.ts`) — the phase ring + plan state machine
 *   skeleton, client-side design knowledge;
 * - catalog evidence — `iteration.gate.transition` lights the current phase
 *   (its forward target becomes `next`), `gate.ok/violations` become the
 *   PASS/FAIL verdict + count, and `state.plans[].status` rows fall into the
 *   exact-match buckets.
 *
 * Degradation (spec §2.5): `source === null` → legal empty view (the panel
 * never mounts the graph for that case, but the projection stays total);
 * missing `iteration` → `degraded.iteration`; missing/invalid `transition` →
 * ring all idle + `degraded.transition`; `state` null → empty machine +
 * `degraded.state`; `state.plans` missing → skeleton + `degraded.plans`.
 *
 * The flow section (spec agent-flow-catalog-graph §2.3/§2.4 — `projectFlow`):
 * `state.agentFlow` evidence (the T1 ledger view) is projected onto the
 * `EXPECTED_ROLE_FLOW` skeleton — stage lit/count from matched dispatch
 * events, latest-first event rows (≤50), an `unexpected` list of
 * off-pipeline-role DISPATCH events, a best-effort settle→dispatch pairing
 * heuristic, and `degraded`/`empty` flags for the missing-ledger /
 * no-events-yet panel notes. Settle rows carry no role (T1 sets ''), so they
 * never light a stage and never appear in `unexpected` (they are completion
 * records, not role events — see `projectFlow`).
 *
 * Known limitation (spec §2.3): Phase 1/5 nodes never light as current and
 * the loop edge is planning-only — the engine gate emits only Phase 2→3→4.
 */

import type { MstarEngineStatusSource } from '../../../types.ts'
import { bool, count, str } from '../guards.ts'
import {
  EXPECTED_ROLE_FLOW, PHASE_EDGES, PHASE_IDS, PLAN_STATE_EDGES, PLAN_STATE_IDS, TRANSITION_TO_PHASE,
  type PhaseId, type PlanStateId,
} from './schema.ts'

/** Phase node state (spec §2.2): current=evidence highlight, next=forward target, idle=unlit schema, unknown=reserved. */
export type PhaseState = 'current' | 'next' | 'idle' | 'unknown'
/** Current-phase verdict from `gate.ok` (spec §2.2). */
export type PhaseVerdict = 'pass' | 'fail' | 'unknown'

export interface PhaseView {
  id: PhaseId
  state: PhaseState
  verdict: PhaseVerdict
  /** `gate.violations.length` — set on the current node only. */
  violationCount: number | null
}

export interface PlanStateView {
  id: PlanStateId
  /** Raw catalog rows (str()-guarded id/status as-is, spec §2.4). */
  plans: { id: string; status: string }[]
  /** `plans.length > 0`. */
  lit: boolean
}

/** One gate violation row, str()-guarded (drives the footer collapsible list, spec §4). */
export interface GraphViolation {
  severity: string
  code: string
  message: string
}

/* ------------------------------ flow (spec agent-flow-catalog-graph §2.4) ------------------------------ */

/** Event status coloring: dispatch → dispatched|advisory|denied; settle → ok|error|denied. */
export type FlowEventStatus = 'dispatched' | 'advisory' | 'denied' | 'ok' | 'error'

/**
 * One projected agent-flow event (spec agent-flow-catalog-graph §2.4). Every
 * field degrades individually via `guards.ts` — a missing/illegal value
 * becomes `null`/''/`0`/a base status, never a throw and never a guessed
 * value. Rows whose `kind` is not dispatch/settle cannot be classified and
 * are skipped entirely (belt-and-suspenders: the T1 ledger reader already
 * normalizes kind).
 */
export interface FlowEventView {
  /** `${ts}-${kind}-${index}` — stable id (index = position in the projected window). */
  id: string
  ts: number
  kind: 'dispatch' | 'settle'
  /** `Execute as`; '' for settle rows (T1 settles carry no role). */
  role: string
  planId: string | null
  taskId: string | null
  taskCategory: string | null
  agent: string | null
  /** dispatch → dispatched|advisory|denied; settle → ok|error|denied (spec §2.4). */
  status: FlowEventStatus
  /** `role` ∈ the EXPECTED_ROLE_FLOW role union (spec §2.3 exact-string match). */
  expected: boolean
  /** The matched expected stage; null → unexpected role. */
  stage: { phase: PhaseId; stage: string } | null
  /** dispatch: has a paired settle (best-effort heuristic); settle: always false. */
  settled: boolean
  durationMs: number | null
}

/** One expected-pipeline stage skeleton lit by matched dispatch events (spec §2.4). */
export interface FlowStageView {
  /** `${phase}:${stage}`. */
  id: string
  phase: PhaseId
  stage: string
  roles: readonly string[]
  /** ≥1 matched dispatch event. */
  lit: boolean
  /** Matched dispatch event count (settles never count — they carry no role). */
  count: number
}

/** The projected expected/actual flow section of the GraphView (spec agent-flow-catalog-graph §2.4). */
export interface GraphFlowView {
  /** The EXPECTED_ROLE_FLOW skeleton with lit/count from dispatch evidence. */
  stages: readonly FlowStageView[]
  /** Actual events, latest first, ≤50 (dispatch + settle rows). */
  events: readonly FlowEventView[]
  /** Off-pipeline-role DISPATCH events (unexpected role events; settles never appear). */
  unexpected: readonly FlowEventView[]
  /** `state.agentFlow` missing/unreadable (ledger absent → no evidence to show). */
  degraded: boolean
  /** `state.agentFlow` present but 0 events (recording started at plan merge). */
  empty: boolean
}

export interface GraphView {
  /** Fixed 5 nodes in ring order (spec §2.2). */
  phases: PhaseView[]
  /** Schema phase edges (4 forward + 1 loop). */
  phaseEdges: { source: PhaseId; target: PhaseId; kind: 'forward' | 'loop' }[]
  /** Fixed 6 buckets (5 known + unknown). */
  planStates: PlanStateView[]
  /** Schema plan-state edges. */
  planEdges: { source: PlanStateId; target: PlanStateId }[]
  /** Current phase → most-populated lit non-Done/Blocked bucket, or null. */
  connector: { source: PhaseId; target: PlanStateId } | null
  currentPhase: PhaseId | null
  iterationId: string | null
  /** Gate violations (str()-guarded), for the footer list. */
  violations: GraphViolation[]
  /** Expected/actual subagent flow (spec agent-flow-catalog-graph §2.4). */
  flow: GraphFlowView
  degraded: { iteration: boolean; state: boolean; plans: boolean; transition: boolean }
}

/** The default (unlit) phase view — schema-only, evidence lights it later. */
function idlePhase(id: PhaseId): PhaseView {
  return { id, state: 'idle', verdict: 'unknown', violationCount: null }
}

/** One guarded plan row: id/status str()-guarded, missing → '' (never fabricated). */
function planRow(raw: unknown): { id: string; status: string } {
  const row = raw as { id?: unknown; status?: unknown } | null | undefined
  return {
    id: str(row?.id) ?? '',
    status: str(row?.status) ?? '',
  }
}

/** Guarded violation row: code/message/severity str()-guarded, missing → ''. */
function violationRow(raw: unknown): GraphViolation {
  const row = raw as { code?: unknown; message?: unknown; severity?: unknown } | null | undefined
  return {
    severity: str(row?.severity) ?? '',
    code: str(row?.code) ?? '',
    message: str(row?.message) ?? '',
  }
}

export function projectGraph(source: MstarEngineStatusSource | null): GraphView {
  const degraded = { iteration: false, state: false, plans: false, transition: false }

  // --- phase ring: schema skeleton, then transition evidence (spec §2.3) ---
  const phases: PhaseView[] = PHASE_IDS.map(idlePhase)
  let currentPhase: PhaseId | null = null
  let iterationId: string | null = null
  let violations: GraphViolation[] = []

  const iteration = source == null ? null : (source as { iteration?: unknown }).iteration
  if (iteration === null || iteration === undefined) {
    degraded.iteration = true
    degraded.transition = true
  } else {
    const row = iteration as { iterationId?: unknown; gate?: unknown }
    iterationId = str(row.iterationId)
    const gate = row.gate as { transition?: unknown; ok?: unknown; violations?: unknown } | null | undefined
    const transition = gate === null || typeof gate !== 'object' ? null : str(gate.transition)
    const phaseId = transition === null || !Object.hasOwn(TRANSITION_TO_PHASE, transition)
      ? undefined
      : TRANSITION_TO_PHASE[transition]
    if (phaseId === undefined) {
      // Missing/illegal transition → ring stays idle + unknown marker (never guessed, spec §2.3).
      degraded.transition = true
    } else {
      currentPhase = phaseId
      const current = phases.find((p) => p.id === phaseId)!
      current.state = 'current'
      const ok = gate === null || typeof gate !== 'object' ? null : bool(gate.ok)
      current.verdict = ok === null ? 'unknown' : ok ? 'pass' : 'fail'
      const rawViolations = gate !== null && typeof gate === 'object' && Array.isArray(gate.violations)
        ? gate.violations
        : null
      current.violationCount = rawViolations === null ? null : rawViolations.length
      violations = rawViolations === null ? [] : rawViolations.map(violationRow)
      // The forward edge target answers "where next" (spec §2.3).
      const forward = PHASE_EDGES.find((e) => e.source === phaseId && e.kind === 'forward')
      if (forward !== undefined) phases.find((p) => p.id === forward.target)!.state = 'next'
    }
  }

  // --- plan state machine: schema buckets, evidence = exact status match (spec §2.4) ---
  const planStates: PlanStateView[] = PLAN_STATE_IDS.map((id) => ({ id, plans: [], lit: false }))
  const state = source == null ? null : (source as { state?: unknown }).state
  if (state === null || state === undefined) {
    degraded.state = true
    degraded.plans = true
  } else {
    const plans = (state as { plans?: unknown }).plans
    if (!Array.isArray(plans)) {
      degraded.plans = true
    } else {
      for (const raw of plans) {
        const row = planRow(raw)
        const bucket = (PLAN_STATE_IDS as readonly string[]).includes(row.status)
          ? (row.status as PlanStateId)
          : 'unknown'
        const target = planStates.find((b) => b.id === bucket)!
        target.plans.push(row)
        target.lit = true
      }
    }
  }

  // --- connector: current phase → most-populated lit non-Done/Blocked bucket,
  // machine-order tie-break (spec §2.4) ---
  let connector: GraphView['connector'] = null
  if (currentPhase !== null) {
    let best: PlanStateId | null = null
    let bestCount = 0
    for (const bucket of planStates) {
      if (bucket.id === 'Done' || bucket.id === 'Blocked') continue
      if (!bucket.lit) continue
      if (bucket.plans.length > bestCount) {
        best = bucket.id
        bestCount = bucket.plans.length
      }
    }
    if (best !== null) connector = { source: currentPhase, target: best }
  }

  return {
    phases,
    phaseEdges: PHASE_EDGES,
    planStates,
    planEdges: PLAN_STATE_EDGES,
    connector,
    currentPhase,
    iterationId,
    violations,
    flow: projectFlow(source),
    degraded,
  }
}

/* ---------------------------------- flow projection (spec agent-flow-catalog-graph §2.3/§2.4) ---------------------------------- */

/** Projected event window bound: the view keeps the latest events only (spec §2.4: ≤50). */
const FLOW_EVENT_WINDOW = 50

/**
 * role → first expected stage in EXPECTED_ROLE_FLOW constant order (spec
 * §2.3: a role listed in several stages matches 取常量序首个 — the first).
 */
function roleStageIndex(): Map<string, { phase: PhaseId; stage: string }> {
  const index = new Map<string, { phase: PhaseId; stage: string }>()
  for (const stage of EXPECTED_ROLE_FLOW) {
    for (const role of stage.roles) {
      if (!index.has(role)) index.set(role, { phase: stage.phase, stage: stage.stage })
    }
  }
  return index
}

/**
 * Dispatch status coloring (spec §2.4): the RECORDED dispatch itself is the
 * evidence of dispatch — only an explicit `denied`/`advisory` verdict refines
 * it; a missing/illegal verdict degrades to the base `dispatched` (never a
 * guessed advisory/denied).
 */
function dispatchStatus(verdict: unknown): FlowEventStatus {
  return verdict === 'denied' ? 'denied' : verdict === 'advisory' ? 'advisory' : 'dispatched'
}

/**
 * Settle status coloring (spec §2.4): the RECORDED settle proves completion —
 * only an explicit `error`/`denied` outcome refines it; a missing/illegal
 * outcome degrades to the base `ok` (never a guessed error/denied).
 */
function settleStatus(outcome: unknown): FlowEventStatus {
  return outcome === 'error' ? 'error' : outcome === 'denied' ? 'denied' : 'ok'
}

/** The expected stage skeleton (spec §2.4): every EXPECTED_ROLE_FLOW stage, unlit. */
function flowStageSkeleton(): FlowStageView[] {
  return EXPECTED_ROLE_FLOW.map((s) => ({
    id: `${s.phase}:${s.stage}`,
    phase: s.phase,
    stage: s.stage,
    roles: s.roles,
    lit: false,
    count: 0,
  }))
}

/**
 * One guarded ledger row (spec §2.4): every field degrades individually via
 * `guards.ts` (missing → `null`/''/`0`, never a fabricated value). A row
 * whose `kind` is not dispatch/settle cannot be classified (no status, no
 * stage semantics) → `null` (skipped — belt-and-suspenders: the T1 ledger
 * reader already normalizes kind).
 * @param raw - one `agentFlow.events` row.
 * @param index - position in the projected window (stable id component).
 */
function flowEventOf(
  raw: unknown,
  index: number,
  stageIndex: Map<string, { phase: PhaseId; stage: string }>,
): FlowEventView | null {
  const row = raw as {
    ts?: unknown; kind?: unknown; role?: unknown; planId?: unknown; taskId?: unknown
    taskCategory?: unknown; agent?: unknown; verdict?: unknown; outcome?: unknown; durationMs?: unknown
  } | null | undefined
  const kind = row?.kind
  if (kind !== 'dispatch' && kind !== 'settle') return null
  const role = str(row?.role) ?? ''
  const matched = stageIndex.get(role)
  const ts = count(row?.ts) ?? 0
  return {
    id: `${ts}-${kind}-${index}`,
    ts,
    kind,
    role,
    planId: str(row?.planId),
    taskId: str(row?.taskId),
    taskCategory: str(row?.taskCategory),
    agent: str(row?.agent),
    status: kind === 'dispatch' ? dispatchStatus(row?.verdict) : settleStatus(row?.outcome),
    expected: matched !== undefined,
    stage: matched ?? null,
    settled: false,
    durationMs: count(row?.durationMs),
  }
}

/**
 * `projectFlow(source): GraphFlowView` — the flow section projection (spec
 * agent-flow-catalog-graph §2.3/§2.4). Total function: NEVER throws, NEVER
 * fabricates values. `state.agentFlow` evidence (the T1 ledger view,
 * latest-first) is projected onto the `EXPECTED_ROLE_FLOW` skeleton:
 *
 * - stages: skeleton + lit/count from matched DISPATCH events (exact-string
 *   role match, first-stage-in-constant-order); settle rows carry no role
 *   (T1 sets '') so they never light a stage;
 * - events: the actual events, latest first, ≤50 (dispatch + settle rows);
 * - unexpected: DISPATCH events whose role is not in the expected role union
 *   (e.g. `general` / `explore` / `scout`). Settle rows are completion
 *   records — they carry no role at all, so they never flag as unexpected
 *   even though their `expected` field is false ('' ∉ union);
 * - settled: best-effort (agent, file-order) pairing — each settle pairs
 *   with the most recent same-agent dispatch BEFORE it in file order (spec
 *   §2.3); an unpaired settle (no prior same-agent dispatch in the window)
 *   stays an independent settle marker. The panel never depends on the
 *   pairing's correctness;
 * - degradation: `state.agentFlow` null/unreadable (the server returns null
 *   ONLY for an unreadable ledger — fix-wave qc1 F-001) → `degraded`
 *   (skeleton + no events — the panel shows the evidence-missing note); a
 *   MISSING ledger file reads as the server's empty view → present with 0
 *   events → `empty` (recording starts at plan merge — the empty-state note,
 *   per the plan promise).
 */
export function projectFlow(source: MstarEngineStatusSource | null): GraphFlowView {
  const stages = flowStageSkeleton()
  const state = source == null ? null : (source as { state?: unknown }).state
  const agentFlow = state == null ? undefined : (state as { agentFlow?: unknown }).agentFlow
  const rawAgentFlow = agentFlow as { events?: unknown } | null | undefined
  const rawEvents = rawAgentFlow === null || rawAgentFlow === undefined || typeof rawAgentFlow !== 'object'
    ? null
    : rawAgentFlow.events
  if (rawEvents === null || !Array.isArray(rawEvents)) {
    // Ledger unreadable / absent agentFlow (non-object / non-array) →
    // skeleton + degraded marker (panel note; never a throw). Fix-wave
    // (qc1 F-001): a MISSING ledger file arrives as the server's EMPTY view
    // (events: []) → the `empty` branch below, NOT this degrade — the panel
    // keeps the plan's promised "no actual dispatches yet" empty state.
    return { stages, events: [], unexpected: [], degraded: true, empty: false }
  }
  if (rawEvents.length === 0) {
    // Ledger exists (or the server's empty view for a missing ledger) but
    // nothing recorded yet (recording starts at plan merge — spec §3).
    return { stages, events: [], unexpected: [], degraded: false, empty: true }
  }

  const stageIndex = roleStageIndex()
  const windowed = rawEvents.slice(0, FLOW_EVENT_WINDOW)
  // Classify first: unclassifiable rows are skipped (never guessed), and the
  // pairing below walks only valid rows in file order.
  const entries: { view: FlowEventView; kind: 'dispatch' | 'settle'; agent: string | null }[] = []
  windowed.forEach((raw, i) => {
    const view = flowEventOf(raw, i, stageIndex)
    if (view === null) return
    entries.push({ view, kind: view.kind, agent: view.agent })
  })

  // Best-effort settle→dispatch pairing (spec §2.3): scan file order (the
  // catalog is latest-first, so walk reversed) keeping the most recent
  // same-agent dispatch; each settle pairs with it and marks the dispatch
  // `settled`. A settle with no prior same-agent dispatch (agent null,
  // truncated window, or a missed record) stays an independent settle.
  const settledByIndex = new Set<number>()
  const lastDispatch = new Map<string, number>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.kind === 'dispatch') {
      if (entry.agent !== null) lastDispatch.set(entry.agent, i)
    } else if (entry.agent !== null) {
      const paired = lastDispatch.get(entry.agent)
      if (paired !== undefined) settledByIndex.add(paired)
    }
  }
  for (const i of settledByIndex) entries[i]!.view.settled = true

  // Stage lit/count from matched dispatch events only (spec §2.4).
  for (const entry of entries) {
    if (entry.kind !== 'dispatch') continue
    const stage = entry.view.stage
    if (stage === null) continue
    const target = stages.find((s) => s.id === `${stage.phase}:${stage.stage}`)
    if (target !== undefined) {
      target.count += 1
      target.lit = true
    }
  }

  const events = entries.map((e) => e.view) // latest-first preserved
  const unexpected = entries
    .filter((e) => e.kind === 'dispatch' && !e.view.expected)
    .map((e) => e.view)
  return { stages, events, unexpected, degraded: false, empty: false }
}
