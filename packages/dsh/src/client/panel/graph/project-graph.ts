/**
 * `projectGraph(source): ZoneView` — the pure projection of the
 * `mstar-engine-status` catalog source onto the zone dashboard view model
 * (spec panel-zones §3). Total function: NEVER throws, produces no
 * React render types, and degrades per field instead of guessing — the
 * same philosophy as `selectEngineStatus`'s try/catch fallback and the
 * `guards.ts` contract (missing → `unknown`, never a fabricated value).
 *
 * Two strictly separated inputs (spec §3):
 * - schema constants (`./schema.ts`) — the 5 iteration steps (PHASE_IDS), the
 *   6 kanban buckets (PLAN_STATE_IDS) and the expected role pipeline
 *   (EXPECTED_ROLE_FLOW), all client-side design knowledge;
 * - catalog evidence — `iteration.gate.transition` lights the current step
 *   (its forward target becomes `next`), `gate.ok/violations` become the
 *   PASS/FAIL verdict + count, and `state.plans[].status` rows fall into the
 *   exact-match kanban buckets.
 *
 * Migration from the legacy graph GraphView (spec §3, per field):
 * - kept & moved: `violations` / `flow.events` / `flow.unexpected` → top-level
 *   `violations` / `events` / `unexpected` (FlowEventView projection unchanged,
 *   incl. the `settled` pairing marker — shared with the plan-3 agent-entity
 *   status derivation via `pairSettleIndexes`); `iterationId` →
 *   `iteration.iterationId`;
 * - deleted (legacy graph structure): `phases`, `phaseEdges`,
 *   `planStates`, `planEdges`, `connector`, `currentPhase`, `flow.stages`
 *   (the stage skeleton + lit/count merge into the `agents` projection in
 *   plan 3; plan 2 delivers the `agents` skeleton);
 * - added: `iteration.steps / currentStep / branches`, `tasks.columns / total
 *   / truncated`, `agents`.
 *
 * Degradation (spec §8): `source === null` → legal empty view (the panel
 * never mounts the graph for that case, but the projection stays total);
 * missing iteration / unresolvable transition → `active: false` + 5 idle
 * steps + `degraded.iteration` (the old `degraded.transition` is merged into
 * `iteration.active === false` — `degraded.iteration ⟺ !active`); `state`
 * null → 6-column skeleton (count 0) + `degraded.state`; `state.plans`
 * missing → same skeleton + `degraded.plans`; `state.agentFlow`
 * missing/unreadable → agents skeleton + `degraded`; 0 events → `empty`.
 */

import type { MstarEngineStatusSource } from '../../../types.ts'
import { bool, count, str } from '../guards.ts'
import { PLAN_CAP, sortPlans } from '../plan-sort.ts'
import {
  EXPECTED_ROLE_FLOW, PHASE_EDGES, PHASE_IDS, PLAN_STATE_IDS, TRANSITION_TO_PHASE,
  type PhaseId, type PlanStateId,
} from './schema.ts'

/** Current-step verdict from `gate.ok` (spec §3). */
export type PhaseVerdict = 'pass' | 'fail' | 'unknown'

/** One gate violation row, str()-guarded (drives the footer collapsible list, spec §2). */
export interface GraphViolation {
  severity: string
  code: string
  message: string
}

/* ------------------------------ flow events (spec §3 — moved from `flow.*`) ------------------------------ */

/** Event status coloring: dispatch → dispatched|advisory|denied; settle → ok|error|denied. */
export type FlowEventStatus = 'dispatched' | 'advisory' | 'denied' | 'ok' | 'error'

/**
 * One projected agent-flow event (spec agent-flow-catalog-graph §2.4 —
 * unchanged by the zone refactor). Every field degrades individually via
 * `guards.ts` — a missing/illegal value becomes `null`/''/`0`/a base status,
 * never a throw and never a guessed value. Rows whose `kind` is not
 * dispatch/settle cannot be classified and are skipped entirely
 * (belt-and-suspenders: the T1 ledger reader already normalizes kind).
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

/* ---------------------------------- iteration zone (spec §3) ---------------------------------- */

/**
 * One iteration step (spec §3): the PHASE_IDS skeleton with
 * current/next/idle lit by `gate.transition` evidence. The `step` number is
 * 1-based (1..5). `verdict` is carried by the CURRENT step only.
 */
export interface IterationStepView {
  id: PhaseId
  /** 1-based position in PHASE_IDS (1..5). */
  step: number
  state: 'current' | 'next' | 'idle'
  /** Current-step gate verdict; 'unknown' on non-current steps. */
  verdict: PhaseVerdict
}

/* ---------------------------------- tasks zone (spec §3) ---------------------------------- */

/**
 * One kanban column (spec §3): the PLAN_STATE_IDS skeleton with plan rows
 * bucketed by EXACT status match (any other status → `unknown`). `count` is
 * the FULL column count; the Done column is additionally sorted with the
 * shared plan-sort key (`plan-sort.ts`) and capped at PLAN_CAP — `capped`
 * carries the display count (PLAN_CAP) when the column overflows, else null.
 */
export interface KanbanColumnView {
  id: PlanStateId
  /** Displayed rows (Done: top PLAN_CAP of the plan-sort order). */
  plans: { id: string; status: string }[]
  /** Full column count (before the Done cap). */
  count: number
  /** PLAN_CAP when the column overflows (Done > 5); null otherwise. */
  capped: number | null
}

/* ---------------------------------- agents zone (spec §4 — plan 2 skeleton) ---------------------------------- */

/**
 * One pending agent-pipeline stage (plan 2 skeleton; entity construction
 * lands in plan 3 — spec §4): the EXPECTED_ROLE_FLOW skeleton with its
 * expected role chips. No evidence → the stage renders as a dashed
 * "待执行" placeholder.
 */
export interface AgentZoneStage {
  /** `${phase}:${stage}`. */
  id: string
  phase: PhaseId
  stage: string
  roles: readonly string[]
}

/**
 * The projected agents zone — plan 2 delivers the SKELETON only (spec §3:
 * "plan 3 完整；plan 2 先交付骨架"): the pending stage list plus the
 * degraded/empty flags projected from `state.agentFlow` presence. Entities,
 * stage lit/count and the flow arrows are the plan-3 projection.
 */
export interface AgentZoneView {
  /** The EXPECTED_ROLE_FLOW skeleton (pending stages). */
  stages: readonly AgentZoneStage[]
  /** `state.agentFlow` missing/unreadable (ledger absent → no evidence to show). */
  degraded: boolean
  /** `state.agentFlow` present but 0 events (recording started at plan merge). */
  empty: boolean
}

/* ---------------------------------- ZoneView (spec §3) ---------------------------------- */

export interface ZoneView {
  iteration: {
    /** Iteration exists AND `gate.transition` resolves (spec §3; `degraded.iteration ⟺ !active`). */
    active: boolean
    iterationId: string | null
    /** 5 steps in PHASE_IDS order (spec §3). */
    steps: IterationStepView[]
    /** 1-based index of the current step in PHASE_IDS; null = inactive. */
    currentStep: number | null
    /** Branch anchors from `state`; null while inactive (rendered only when active, spec §3). */
    branches: { iterationBase: string | null; target: string | null; specIntegration: string | null } | null
    /** Current-step gate verdict; 'unknown' when inactive. */
    verdict: PhaseVerdict
    /** Current-step `gate.violations` count; null when inactive. */
    violationCount: number | null
  }
  tasks: {
    /** 6 columns: Todo/InProgress/InReview/Done/Blocked/unknown (spec §3). */
    columns: KanbanColumnView[]
    /** Plan total across all columns, unknown included. */
    total: number
    /** Done column overflow (rows > PLAN_CAP). */
    truncated: boolean
  }
  agents: AgentZoneView
  /** Current-step gate verdict — footer gate-summary seat (spec §3). */
  verdict: PhaseVerdict
  /** Gate violations (str()-guarded), for the footer list. */
  violations: GraphViolation[]
  /** Actual agent-flow events, latest first, ≤50 (spec §3; `flow.events` moved top-level). */
  events: FlowEventView[]
  /** Off-pipeline-role DISPATCH events (settles never appear). */
  unexpected: FlowEventView[]
  degraded: { iteration: boolean; state: boolean; plans: boolean }
}

/* ------------------------------ projection helpers ------------------------------ */

/** The default (unlit) iteration step — schema-only, evidence lights it later. */
function idleStep(id: PhaseId, step: number): IterationStepView {
  return { id, step, state: 'idle', verdict: 'unknown' }
}

/** One guarded plan row: id/status str()-guarded (missing → ''), doneAt str()-guarded (missing → null). */
interface PlanRow {
  id: string
  status: string
  doneAt: string | null
}

/** One guarded plan row: id/status str()-guarded, missing → '' (never fabricated). */
function planRow(raw: unknown): PlanRow {
  const row = raw as { id?: unknown; status?: unknown; doneAt?: unknown } | null | undefined
  return {
    id: str(row?.id) ?? '',
    status: str(row?.status) ?? '',
    doneAt: str(row?.doneAt),
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

/** Guarded state section: the workspace-state digest (plans + branch anchors), null when missing. */
function stateRow(source: MstarEngineStatusSource | null): { plans?: unknown; iterationBaseBranch?: unknown; targetBranch?: unknown; specIntegrationBranch?: unknown } | null {
  const state = source == null ? null : (source as { state?: unknown }).state
  if (state === null || typeof state !== 'object') return null
  return state as { plans?: unknown; iterationBaseBranch?: unknown; targetBranch?: unknown; specIntegrationBranch?: unknown }
}

export function projectGraph(source: MstarEngineStatusSource | null): ZoneView {
  const degraded = { iteration: false, state: false, plans: false }

  // --- iteration zone: 5-step skeleton, then transition evidence (spec §3) ---
  const steps: IterationStepView[] = PHASE_IDS.map((id, i) => idleStep(id, i + 1))
  let active = false
  let currentStep: number | null = null
  let iterationId: string | null = null
  let verdict: PhaseVerdict = 'unknown'
  let violationCount: number | null = null
  let violations: GraphViolation[] = []
  let branches: ZoneView['iteration']['branches'] = null

  const iteration = source == null ? null : (source as { iteration?: unknown }).iteration
  if (iteration !== null && iteration !== undefined) {
    const row = iteration as { iterationId?: unknown; gate?: unknown }
    iterationId = str(row.iterationId)
    const gate = row.gate as { transition?: unknown; ok?: unknown; violations?: unknown } | null | undefined
    const transition = gate === null || typeof gate !== 'object' ? null : str(gate.transition)
    const phaseId = transition === null || !Object.hasOwn(TRANSITION_TO_PHASE, transition)
      ? undefined
      : TRANSITION_TO_PHASE[transition]
    if (phaseId !== undefined) {
      active = true
      const index = PHASE_IDS.indexOf(phaseId)
      currentStep = index + 1 // 1-based
      const current = steps[index]!
      current.state = 'current'
      const ok = gate === null || typeof gate !== 'object' ? null : bool(gate.ok)
      current.verdict = ok === null ? 'unknown' : ok ? 'pass' : 'fail'
      const rawViolations = gate !== null && typeof gate === 'object' && Array.isArray(gate.violations)
        ? gate.violations
        : null
      violationCount = rawViolations === null ? null : rawViolations.length
      violations = rawViolations === null ? [] : rawViolations.map(violationRow)
      verdict = current.verdict
      // The forward edge target answers "where next" (spec §3; Phase 5 has no
      // forward edge — a known limitation, the engine gate emits only 2→3→4).
      const forward = PHASE_EDGES.find((e) => e.source === phaseId && e.kind === 'forward')
      if (forward !== undefined) steps[PHASE_IDS.indexOf(forward.target)]!.state = 'next'
      // Branch anchors come from `state`; projected only while active (the
      // iteration zone renders them exclusively in the active state, spec §3).
      const state = stateRow(source)
      branches = {
        iterationBase: str(state?.iterationBaseBranch),
        target: str(state?.targetBranch),
        specIntegration: str(state?.specIntegrationBranch),
      }
    }
  }
  // `degraded.transition` is merged into `iteration.active === false` (spec §3).
  degraded.iteration = !active

  // --- tasks zone: 6-column skeleton, evidence = exact status match (spec §3) ---
  const columns: KanbanColumnView[] = PLAN_STATE_IDS.map((id) => ({ id, plans: [], count: 0, capped: null }))
  const doneRows: PlanRow[] = []
  let total = 0
  let truncated = false

  const state = stateRow(source)
  if (state === null) {
    degraded.state = true
    degraded.plans = true
  } else {
    const plans = state.plans
    if (!Array.isArray(plans)) {
      degraded.plans = true
    } else {
      for (const raw of plans) {
        const row = planRow(raw)
        total += 1
        const bucket = (PLAN_STATE_IDS as readonly string[]).includes(row.status)
          ? (row.status as PlanStateId)
          : 'unknown'
        const column = columns.find((c) => c.id === bucket)!
        column.count += 1
        if (bucket === 'Done') {
          // Done rows are sorted + capped below (needs doneAt — not a view field).
          doneRows.push(row)
        } else {
          column.plans.push({ id: row.id, status: row.status })
        }
      }
    }
  }

  // Done column: shared plan-sort key (spec §3 — `plan-sort.ts`, reused not
  // copied) + PLAN_CAP; `tasks.truncated` = Done column rows > PLAN_CAP.
  const doneColumn = columns.find((c) => c.id === 'Done')!
  doneColumn.plans = sortPlans(doneRows)
    .slice(0, PLAN_CAP)
    .map((r) => ({ id: r.id, status: r.status }))
  if (doneRows.length > PLAN_CAP) {
    truncated = true
    doneColumn.capped = PLAN_CAP
  }

  // --- agents zone skeleton + flow events (spec §3/§4 — plan 2) ---
  const agents = projectAgents(source)
  const flow = projectFlowEvents(source)

  return {
    iteration: {
      active,
      iterationId,
      steps,
      currentStep,
      branches,
      verdict,
      violationCount,
    },
    tasks: { columns, total, truncated },
    agents,
    verdict,
    violations,
    events: flow.events,
    unexpected: flow.unexpected,
    degraded,
  }
}

/* ---------------------------------- agents zone skeleton (spec §4 — plan 2) ---------------------------------- */

/**
 * `projectAgents(source): AgentZoneView` — the agents-zone SKELETON (plan 2;
 * entities/edges land in plan 3). Total function: NEVER throws. Projects only
 * `state.agentFlow` PRESENCE onto the EXPECTED_ROLE_FLOW pending-stage
 * skeleton:
 *
 * - `state.agentFlow` null/unreadable (the server returns null ONLY for an
 *   unreadable ledger) → `degraded` (skeleton + the evidence-missing note);
 * - a MISSING ledger file reads as the server's empty view → present with 0
 *   events → `empty` (recording starts at plan merge — the no-dispatches-yet
 *   note);
 * - otherwise → plain skeleton (lit/count and entities come with plan 3).
 */
export function projectAgents(source: MstarEngineStatusSource | null): AgentZoneView {
  const stages: AgentZoneStage[] = EXPECTED_ROLE_FLOW.map((s) => ({
    id: `${s.phase}:${s.stage}`,
    phase: s.phase,
    stage: s.stage,
    roles: s.roles,
  }))
  const state = source == null ? null : (source as { state?: unknown }).state
  const agentFlow = state == null ? undefined : (state as { agentFlow?: unknown }).agentFlow
  const rawAgentFlow = agentFlow as { events?: unknown } | null | undefined
  const rawEvents = rawAgentFlow === null || rawAgentFlow === undefined || typeof rawAgentFlow !== 'object'
    ? null
    : rawAgentFlow.events
  if (rawEvents === null || !Array.isArray(rawEvents)) {
    // Ledger unreadable / absent agentFlow (non-object / non-array) →
    // skeleton + degraded marker (panel note; never a throw).
    return { stages, degraded: true, empty: false }
  }
  if (rawEvents.length === 0) {
    // Ledger exists (or the server's empty view for a missing ledger) but
    // nothing recorded yet (recording starts at plan merge — spec §4).
    return { stages, degraded: false, empty: true }
  }
  return { stages, degraded: false, empty: false }
}

/* ---------------------------------- flow events projection (spec §3 — moved from `flow.*`) ---------------------------------- */

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
 * Best-effort settle→dispatch pairing (spec §4): the shared pure function
 * behind BOTH the events projection (`settled` marker) and the plan-3
 * agent-entity status derivation — one implementation, no heuristic drift.
 * Input rows are in FILE order (the catalog is latest-first, so the pairing
 * walks reversed) keeping the most recent same-agent dispatch; each settle
 * pairs with it and the paired dispatch's index is returned. A settle with no
 * prior same-agent dispatch (agent null, truncated window, or a missed
 * record) stays an independent settle. Output: the index set of paired
 * dispatches.
 */
export function pairSettleIndexes(
  rows: readonly { kind: 'dispatch' | 'settle'; agent: string | null }[],
): ReadonlySet<number> {
  const settled = new Set<number>()
  const lastDispatch = new Map<string, number>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = rows[i]!
    if (entry.kind === 'dispatch') {
      if (entry.agent !== null) lastDispatch.set(entry.agent, i)
    } else if (entry.agent !== null) {
      const paired = lastDispatch.get(entry.agent)
      if (paired !== undefined) settled.add(paired)
    }
  }
  return settled
}

/**
 * `projectFlowEvents(source): { events, unexpected }` — the flow events
 * projection (spec §3: `flow.events` / `flow.unexpected` moved top-level;
 * `flow.stages` merged into the plan-3 agents projection). Total function:
 * NEVER throws, NEVER fabricates values.
 *
 * - events: the actual events, latest first, ≤50 (dispatch + settle rows);
 * - unexpected: DISPATCH events whose role is not in the expected role union
 *   (e.g. `general` / `explore` / `scout`). Settle rows are completion
 *   records — they carry no role at all, so they never flag as unexpected
 *   even though their `expected` field is false ('' ∉ union);
 * - settled: best-effort pairing via `pairSettleIndexes` (shared with the
 *   plan-3 entity status derivation). The panel never depends on the
 *   pairing's correctness;
 * - degradation: agentFlow null/unreadable → no events (the `agents`
 *   skeleton carries the `degraded` marker); the MISSING ledger file reads as
 *   the server's empty view → present with 0 events → no events either (the
 *   `agents` skeleton carries `empty`).
 */
export function projectFlowEvents(
  source: MstarEngineStatusSource | null,
): { events: FlowEventView[]; unexpected: FlowEventView[] } {
  const state = source == null ? null : (source as { state?: unknown }).state
  const agentFlow = state == null ? undefined : (state as { agentFlow?: unknown }).agentFlow
  const rawAgentFlow = agentFlow as { events?: unknown } | null | undefined
  const rawEvents = rawAgentFlow === null || rawAgentFlow === undefined || typeof rawAgentFlow !== 'object'
    ? null
    : rawAgentFlow.events
  if (rawEvents === null || !Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { events: [], unexpected: [] }
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

  for (const i of pairSettleIndexes(entries)) entries[i]!.view.settled = true

  const events = entries.map((e) => e.view) // latest-first preserved
  const unexpected = entries
    .filter((e) => e.kind === 'dispatch' && !e.view.expected)
    .map((e) => e.view)
  return { events, unexpected }
}
