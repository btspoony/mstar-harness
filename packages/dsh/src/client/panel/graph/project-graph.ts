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
 *   incl. the `settled` pairing marker — shared with the agent-entity status
 *   derivation via the single `pairSettleStatus` pairing walk); `iterationId`
 *   → `iteration.iterationId`;
 * - deleted (legacy graph structure): `phases`, `phaseEdges`,
 *   `planStates`, `planEdges`, `connector`, `currentPhase`, `flow.stages`
 *   (the stage skeleton + entities/edges now live in the `agents` projection —
 *   spec §4);
 * - added: `iteration.steps / currentStep / branches`, `tasks.columns / total
 *   / truncated`, `agents` (entities + expected/actual/next edges + executing/
 *   pending counts — spec §4).
 *
 * Degradation (spec §8): `source === null` → legal empty view (the panel
 * never mounts the graph for that case, but the projection stays total);
 * missing iteration / unresolvable transition → `active: false` + 5 idle
 * steps + `degraded.iteration` (the old `degraded.transition` is merged into
 * `iteration.active === false` — `degraded.iteration ⟺ !active`); `state`
 * null → 6-column skeleton (count 0) + `degraded.state`; `state.plans`
 * missing → same skeleton + `degraded.plans`; `state.agentFlow`
 * missing/unreadable → agents skeleton + `degraded` (no entity/pending
 * claims — the note explains); 0 events → `empty` (pending skeleton only).
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

/* ---------------------------------- agents zone (spec §4) ---------------------------------- */

/**
 * One agent-pipeline stage (spec §4): the EXPECTED_ROLE_FLOW skeleton with its
 * expected role chips. No dispatch evidence → the stage renders as a dashed
 * "待执行" placeholder and its expected roles count into `pending`.
 */
export interface AgentZoneStage {
  /** `${phase}:${stage}`. */
  id: string
  phase: PhaseId
  stage: string
  roles: readonly string[]
  /**
   * Dispatch evidence (spec §4): any dispatch row's role maps to this stage —
   * the render shows the dashed "待执行" placeholder ONLY for un-evidenced
   * stages (the `pending` count is the same per-stage test). Evidence comes
   * from ALL dispatch rows, not just each entity's latest — an agent
   * re-dispatched under another role still lights its earlier stage.
   */
  evidenced: boolean
}

/**
 * One agent entity card (spec §4): a session aggregated across its dispatch
 * rows (count + latest ts). The card identity fields (name/role/task/stage)
 * reflect the LATEST dispatch — the same dispatch that decides the status.
 */
export interface AgentEntityView {
  /** `agent` (session id); fallback `${role}+${ts}` when the agent id is missing. */
  key: string
  /** The raw session id; null when the fallback key was used. */
  agent: string | null
  /** Display name = `agent ?? role` (spec §4). */
  name: string
  /** Role chip ('' when the dispatch carried no role). */
  role: string
  /** Task tag `${planId}#${taskId}` (missing planId → null; taskId missing → planId). */
  task: string | null
  /** Spec §4 hardcoded priority: latest-dispatch verdict → paired settle → running. */
  status: AgentEntityStatus
  /** Dispatch count of this entity in the window (settles never count). */
  count: number
  /** Latest dispatch ts (the status/identity source). */
  ts: number
  /** Latest dispatch's stage via `roleStageIndex` (first constant-order match); null → unexpected role. */
  stage: { phase: PhaseId; stage: string } | null
}

/**
 * Entity status (spec §4, hardcoded priority): `denied`/`advisory` come from
 * the LATEST dispatch's verdict (verdict wins regardless of settling);
 * `error`/`settled` come from the settle paired with that dispatch; `running`
 * = no paired settle (best-effort heuristic, never pretended).
 */
export type AgentEntityStatus = 'running' | 'settled' | 'error' | 'denied' | 'advisory'

/** Edge kinds (spec §4): skeleton / handoff / next-flow arrows. */
export type AgentEdgeKind = 'expected' | 'actual' | 'next'

/**
 * One agents-zone arrow (spec §4):
 * - `expected`: skeleton arrow between consecutive EXPECTED_ROLE_FLOW stage
 *   columns (source/target = stage id);
 * - `actual`: same-plan handoff between ts-adjacent dispatch ENTITY keys
 *   (source/target = entity key);
 * - `next`: the latest running entity's stage column → the next constant-order
 *   column (source/target = stage id; `entityKey` = the running card).
 */
export interface AgentEdge {
  kind: AgentEdgeKind
  /** expected/next: stage id (`${phase}:${stage}`); actual: entity key. */
  source: string
  target: string
  /** The running entity key the next arrow highlights; null for expected/actual. */
  entityKey: string | null
}

/**
 * The projected agents zone (spec §4): the EXPECTED_ROLE_FLOW stage skeleton
 * plus the dispatch-derived entity cards and the expected/actual/next arrows.
 * Total function — NEVER throws and NEVER fabricates: agentFlow
 * missing/unreadable → `degraded` (skeleton only, no entity/pending claims);
 * 0 events → `empty` (pending skeleton only); settle-only ledger → no entity
 * cards (settles never produce entities) + full pending skeleton.
 */
export interface AgentZoneView {
  /** The EXPECTED_ROLE_FLOW skeleton (pending stages). */
  stages: readonly AgentZoneStage[]
  /** `state.agentFlow` missing/unreadable (ledger absent → no evidence to show). */
  degraded: boolean
  /** `state.agentFlow` present but 0 events (recording started at plan merge). */
  empty: boolean
  /** Aggregated dispatch entities — one card per agent key (spec §4). */
  entities: readonly AgentEntityView[]
  /** expected (stage skeleton) + actual (same-plan handoffs) + at most one next (latest running). */
  edges: readonly AgentEdge[]
  /** `running` entity count — the summary "N 执行中". */
  executing: number
  /** Sum of expected roles of stages with no dispatch evidence — the summary "M 待执行". */
  pending: number
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

  // --- agents zone + flow events (spec §3/§4) ---
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

/* ---------------------------------- agents zone projection (spec §4) ---------------------------------- */

/** Skeleton stage-column arrows: consecutive EXPECTED_ROLE_FLOW stages (spec §4). */
function expectedEdges(stages: readonly AgentZoneStage[]): AgentEdge[] {
  const edges: AgentEdge[] = []
  for (let i = 0; i + 1 < stages.length; i++) {
    edges.push({ kind: 'expected', source: stages[i]!.id, target: stages[i + 1]!.id, entityKey: null })
  }
  return edges
}

/** One in-progress entity accumulator (the aggregation walk, spec §4). */
interface EntityAccum {
  key: string
  agent: string | null
  name: string
  role: string
  task: string | null
  count: number
  ts: number
  stage: { phase: PhaseId; stage: string } | null
  /** Index of the latest dispatch in the classified entries array (pair lookup). */
  latestIndex: number
  /** dispatchStatus of the latest dispatch ('denied' | 'advisory' | 'dispatched'). */
  verdict: FlowEventStatus
}

/**
 * Entity status (spec §4 hardcoded priority): the latest-dispatch verdict
 * wins (denied/advisory, settle-independent); otherwise the settle paired
 * with that dispatch — `error` → error, `ok`/`denied` → settled; no pair →
 * running (best-effort heuristic, never pretended).
 */
function entityStatus(acc: EntityAccum, pairStatus: ReadonlyMap<number, FlowEventStatus>): AgentEntityStatus {
  if (acc.verdict === 'denied') return 'denied'
  if (acc.verdict === 'advisory') return 'advisory'
  const paired = pairStatus.get(acc.latestIndex)
  return paired === 'error' ? 'error' : paired === undefined ? 'running' : 'settled'
}

/**
 * Aggregate dispatch rows into entity cards (spec §4): key = `agent` (session
 * id) with `${role}+${ts}` fallback; the same key aggregates (count + latest
 * ts, identity fields from the latest dispatch). Dispatch rows with NO
 * identity at all (agent null AND role '') are skipped — a card with nothing
 * on it is never fabricated (spec §8 garbage rows). Settle rows never produce
 * entities (they carry no role/plan identity — spec §4).
 */
function aggregateEntities(
  entries: readonly { view: FlowEventView }[],
  pairStatus: ReadonlyMap<number, FlowEventStatus>,
): AgentEntityView[] {
  const acc = new Map<string, EntityAccum>()
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i]!.view
    if (v.kind !== 'dispatch') continue
    if (v.agent === null && v.role === '') continue // anonymous → no card
    const key = v.agent ?? `${v.role}+${v.ts}`
    const task = v.planId === null ? null : v.taskId === null ? v.planId : `${v.planId}#${v.taskId}`
    const cur = acc.get(key)
    if (cur === undefined) {
      acc.set(key, {
        key,
        agent: v.agent,
        name: v.agent ?? v.role,
        role: v.role,
        task,
        count: 1,
        ts: v.ts,
        stage: v.stage,
        latestIndex: i,
        verdict: v.status,
      })
    } else {
      cur.count += 1
      // The latest dispatch = max ts; equal ts → first in file order (the
      // catalog is latest-first, so the smaller index is the more recent).
      if (v.ts > cur.ts || (v.ts === cur.ts && i < cur.latestIndex)) {
        cur.ts = v.ts
        cur.latestIndex = i
        cur.verdict = v.status
        cur.agent = v.agent
        cur.name = v.agent ?? v.role
        cur.role = v.role
        cur.task = task
        cur.stage = v.stage
      }
    }
  }
  return Array.from(acc.values()).map((e) => ({
    key: e.key,
    agent: e.agent,
    name: e.name,
    role: e.role,
    task: e.task,
    count: e.count,
    ts: e.ts,
    stage: e.stage,
    status: entityStatus(e, pairStatus),
  }))
}

/**
 * Same-plan handoff arrows (spec §4): within each planId, the ts-ascending
 * adjacent dispatch ENTITY pairs. Anonymous rows (no card) and plan-less
 * dispatches cannot form a pair → excluded; a self-pair (the same entity
 * twice in a row) is skipped — a card never hands off to itself.
 */
function actualEdges(entries: readonly { view: FlowEventView }[]): AgentEdge[] {
  const byPlan = new Map<string, { key: string; ts: number; idx: number }[]>()
  entries.forEach((e, idx) => {
    const v = e.view
    if (v.kind !== 'dispatch') return
    if (v.agent === null && v.role === '') return // anonymous → no card
    if (v.planId === null) return // no plan → no same-plan chain
    const key = v.agent ?? `${v.role}+${v.ts}`
    const list = byPlan.get(v.planId)
    if (list === undefined) byPlan.set(v.planId, [{ key, ts: v.ts, idx }])
    else list.push({ key, ts: v.ts, idx })
  })
  const edges: AgentEdge[] = []
  for (const planId of Array.from(byPlan.keys()).sort()) {
    const rows = byPlan.get(planId)!
      .slice()
      .sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.idx - b.idx)
    for (let i = 0; i + 1 < rows.length; i++) {
      if (rows[i]!.key === rows[i + 1]!.key) continue // self-pair skip
      edges.push({ kind: 'actual', source: rows[i]!.key, target: rows[i + 1]!.key, entityKey: null })
    }
  }
  return edges
}

/**
 * The `next` arrow (spec §4): the LATEST running entity (max ts; tie →
 * smallest entity key) sits in a stage column → the next EXPECTED_ROLE_FLOW
 * column. No running entity / running entity without a stage (unexpected
 * role) / already at the last column (ops-on-demand) → NO next edge (honest
 * — never a guess).
 */
function nextEdges(entities: readonly AgentEntityView[], stages: readonly AgentZoneStage[]): AgentEdge[] {
  let best: AgentEntityView | null = null
  for (const e of entities) {
    if (e.status !== 'running') continue
    if (best === null || e.ts > best.ts || (e.ts === best.ts && e.key < best.key)) best = e
  }
  if (best === null || best.stage === null) return []
  const fromId = `${best.stage.phase}:${best.stage.stage}`
  const index = stages.findIndex((s) => s.id === fromId)
  if (index === -1 || index + 1 >= stages.length) return []
  return [{ kind: 'next', source: fromId, target: stages[index + 1]!.id, entityKey: best.key }]
}

/**
 * `projectAgents(source): AgentZoneView` — the agents zone (spec §4). Total
 * function: NEVER throws and NEVER fabricates values:
 *
 * - `state.agentFlow` null/unreadable → `degraded` (skeleton + the
 *   evidence-missing note; no entity/pending claims — executing 0, pending 0,
 *   never a guessed count);
 * - a MISSING ledger file reads as the server's empty view → present with 0
 *   events → `empty` (pending skeleton: every expected role is pending);
 * - otherwise: entities aggregated from dispatch rows, statuses via the
 *   shared pairing walk, expected/actual/next edges, and the executing
 *   (running entities) / pending (un-evidenced stage roles) counts.
 */
export function projectAgents(source: MstarEngineStatusSource | null): AgentZoneView {
  const stages: AgentZoneStage[] = EXPECTED_ROLE_FLOW.map((s) => ({
    id: `${s.phase}:${s.stage}`,
    phase: s.phase,
    stage: s.stage,
    roles: s.roles,
    evidenced: false,
  }))
  const state = source == null ? null : (source as { state?: unknown }).state
  const agentFlow = state == null ? undefined : (state as { agentFlow?: unknown }).agentFlow
  const rawAgentFlow = agentFlow as { events?: unknown } | null | undefined
  const rawEvents = rawAgentFlow === null || rawAgentFlow === undefined || typeof rawAgentFlow !== 'object'
    ? null
    : rawAgentFlow.events
  if (rawEvents === null || !Array.isArray(rawEvents)) {
    return { stages, degraded: true, empty: false, entities: [], edges: expectedEdges(stages), executing: 0, pending: 0 }
  }

  const entries = classifyFlowRows(rawEvents)
  const empty = rawEvents.length === 0

  // Evidence (spec §4): a stage is evidenced when any dispatch row's role maps
  // to it (roles are unique across stages, so this equals literal role
  // membership). Counted from ALL dispatch rows — an agent re-dispatched under
  // another role still lights its earlier stage. The same set drives the
  // per-stage `evidenced` flag (the render's pending-placeholder decision) and
  // the `pending` count — no drift.
  const evidenced = new Set<string>()
  for (const e of entries) {
    if (e.view.kind === 'dispatch' && e.view.stage !== null) {
      evidenced.add(`${e.view.stage.phase}:${e.view.stage.stage}`)
    }
  }
  for (const s of stages) s.evidenced = evidenced.has(s.id)

  // Shared settle→dispatch pairing (one walk, spec §4): the settle status per
  // paired dispatch index; entity status looks up its latest dispatch's pair.
  // `view.status` already carries settleStatus(outcome) for settle rows, so
  // the record values are the settle statuses directly.
  const pairStatus = pairSettleStatus(
    entries.map((e) => ({ kind: e.view.kind, agent: e.view.agent, status: e.view.status })),
  )

  const entities = aggregateEntities(entries, pairStatus)
  const edges = [...expectedEdges(stages), ...actualEdges(entries), ...nextEdges(entities, stages)]

  const executing = entities.filter((e) => e.status === 'running').length
  // Pending = expected roles of stages with NO dispatch evidence (spec §4).
  const pending = stages.reduce((sum, s) => sum + (evidenced.has(s.id) ? 0 : s.roles.length), 0)

  return { stages, degraded: false, empty, entities, edges, executing, pending }
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
 * Shared settle→dispatch pairing walk (spec §4) — the ONE implementation
 * behind BOTH the events projection (`settled` marker, via
 * `pairSettleIndexes`) and the agent-entity status derivation (via the
 * returned settle status per paired dispatch index) — no heuristic drift.
 * Input rows are in FILE order (the catalog is latest-first, so the pairing
 * walks reversed) keeping the most recent same-agent dispatch; each settle
 * pairs with it. A settle with no prior same-agent dispatch (agent null,
 * truncated window, or a missed record) stays an independent settle. Output:
 * paired dispatch index → the settle's status (`entry.status` for settle
 * rows — the events path omits it, defaulting to `ok`, and only the keys
 * matter there).
 */
function pairSettleStatus(
  rows: readonly { kind: 'dispatch' | 'settle'; agent: string | null; status?: FlowEventStatus }[],
): Map<number, FlowEventStatus> {
  const record = new Map<number, FlowEventStatus>()
  const lastDispatch = new Map<string, number>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = rows[i]!
    if (entry.kind === 'dispatch') {
      if (entry.agent !== null) lastDispatch.set(entry.agent, i)
    } else if (entry.agent !== null) {
      const paired = lastDispatch.get(entry.agent)
      if (paired !== undefined) record.set(paired, entry.status ?? 'ok')
    }
  }
  return record
}

/**
 * The paired dispatch index set (spec §4): the events projection's `settled`
 * marker. Same walk as the entity status derivation — `pairSettleStatus`
 * minus the settle statuses.
 */
export function pairSettleIndexes(
  rows: readonly { kind: 'dispatch' | 'settle'; agent: string | null }[],
): ReadonlySet<number> {
  return new Set(pairSettleStatus(rows).keys())
}

/**
 * Classify the windowed ledger rows into guarded event entries (spec §2.4):
 * unclassifiable rows (kind ∉ dispatch|settle) are skipped — never guessed;
 * valid rows degrade per field via `flowEventOf`. Latest-first order is
 * preserved (the pairing walk and the entity aggregation both depend on it).
 */
function classifyFlowRows(rawEvents: readonly unknown[]): { view: FlowEventView }[] {
  const stageIndex = roleStageIndex()
  const windowed = rawEvents.slice(0, FLOW_EVENT_WINDOW)
  const entries: { view: FlowEventView }[] = []
  windowed.forEach((raw, i) => {
    const view = flowEventOf(raw, i, stageIndex)
    if (view === null) return
    entries.push({ view })
  })
  return entries
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
 * - settled: best-effort pairing via `pairSettleIndexes` (the same walk the
 *   agent-entity status derivation uses). The panel never depends on the
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
  if (rawEvents === null || !Array.isArray(rawEvents)) {
    return { events: [], unexpected: [] }
  }

  const entries = classifyFlowRows(rawEvents)
  // settled markers via the shared pairing walk (spec §4 — one implementation
  // behind the events projection and the entity status derivation).
  for (const i of pairSettleIndexes(entries.map((e) => ({ kind: e.view.kind, agent: e.view.agent })))) {
    entries[i]!.view.settled = true
  }

  const events = entries.map((e) => e.view) // latest-first preserved
  const unexpected = entries
    .filter((e) => e.view.kind === 'dispatch' && !e.view.expected)
    .map((e) => e.view)
  return { events, unexpected }
}
