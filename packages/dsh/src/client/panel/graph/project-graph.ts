/**
 * `projectGraph(snapshot): ZoneView` — the pure projection of one
 * store-backed `PanelSnapshot` onto the panel's zone view model.
 *
 * Total function: NEVER throws, produces no React render types, and degrades
 * per field and per ZONE instead of guessing — a failed roadmap read must not
 * blank the task board, and a missing ledger must not fabricate an empty one.
 *
 * Two strictly separated inputs:
 * - schema constants (`./schema.ts`) — the 5 iteration phases, the 5 kanban
 *   buckets and the `gate.transition` → phase map: client-side design
 *   knowledge;
 * - snapshot evidence — the engine's dashboard DTOs per workspace view
 *   (`workflow` / `iteration` / `roadmap` / `issues` / `projects`), the
 *   retained catalog facts (`iterationGate` / `knowledge` / `selection`) and
 *   the agent-flow ledger. The projection reads them STRUCTURALLY through
 *   `guards.ts`, so a DTO that grows or loses a field degrades instead of
 *   crashing the panel.
 *
 * Zones:
 * - `iteration` — the 5-step stepper: `retained.iterationGate.gate.transition`
 *   lights the current step, steps before it are `done`, its forward target is
 *   `next`; `gate.ok` / `gate.violations` become the PASS/FAIL verdict. A
 *   Phase-1 compass (`compassStatus: 'active'` with `phase-2-execute`) lights
 *   Step 1 with no verdict — the engine evaluates no gate in Phase 1.
 * - `tasks` — the plan board: the workflow's plan rows (falling back to the
 *   iteration's), bucketed by status; `Blocked` and every unknown status fold
 *   into `blocked-unknown`; the Done column uses the shared plan-sort key.
 * - `project` — the additive rollup: roadmap milestone names + open-issue
 *   severity counts, with the roadmap source's own verdict.
 * - `roadmap` — direction, goals and milestones with their open-issue
 *   membership. THE THREE READ STATES SURVIVE (`ok` / `not-applicable` /
 *   `unavailable`, plus `ok` with no roadmap row and `ok` with zero
 *   milestones) — they are never flattened into one "empty".
 * - `events` — ONE time-descending flow across the agent-flow ledger and the
 *   gate violations. Rows carry the merged badge kind
 *   (`dispatch` / `settle` / `violation`) plus the ledger kind verbatim.
 */

import type { PanelSnapshot, PanelWorkspaceView } from '../../../panel/panel-snapshot.ts'
import type { IterationPlanDTO, WorkflowPlanDTO } from '@mstar-harness/engine'
import type {
  AgentFlowContinuationEventView,
  AgentFlowEventView,
  IterationGateViolationView,
} from '../../../types.ts'
import { bool, count, str } from '../guards.ts'
import { PLAN_CAP, sortPlans } from '../plan-sort.ts'
import {
  PHASE_EDGES, PHASE_IDS, PLAN_STATE_IDS, TRANSITION_TO_PHASE,
  type PhaseId, type PlanStateId,
} from './schema.ts'

/** Current-step verdict from `gate.ok`. */
export type PhaseVerdict = 'pass' | 'fail' | 'unknown'

/* ---------------------------------- iteration zone ---------------------------------- */

export interface IterationStepView {
  id: PhaseId
  /** 1-based position in PHASE_IDS (1..5). */
  step: number
  /** `current` (the gate transition) / `next` (its forward target) / `done` (a step before the current one) / `idle` (schema-only). */
  state: 'current' | 'next' | 'done' | 'idle'
  /** Current-step gate verdict; 'unknown' on non-current steps. */
  verdict: PhaseVerdict
}

/* ---------------------------------- tasks zone ---------------------------------- */

/** One kanban column: the PLAN_STATE_IDS skeleton with its plan rows. */
export interface KanbanColumnView {
  id: PlanStateId
  /** ALL rows (Done: plan-sort order; others: workflow order). */
  plans: { id: string; status: string }[]
  count: number
  /** PLAN_CAP when the column overflows; null otherwise. */
  capped: number | null
}

/* ---------------------------------- events ---------------------------------- */

/**
 * The merged event badge: 流转 (a dispatch-family record), 结算 (a settle) or
 * 违规 (a gate violation). Everything the ledger carries maps onto exactly one
 * of the three; the ledger's own kind stays available as `ledgerKind`.
 */
export type FlowEventKind = 'dispatch' | 'settle' | 'violation'

/** Event status coloring: dispatch → dispatched|advisory|denied; settle → ok|error|denied; everything else → unknown (honest). */
export type FlowEventStatus = 'dispatched' | 'advisory' | 'denied' | 'ok' | 'error' | 'unknown'

/**
 * One projected event row. Every field degrades individually — a missing value
 * becomes `null` / `''` / `0`, never a guess and never a throw.
 */
export interface FlowEventView {
  /** `${ts}-${ledgerKind}-${index}` — stable id (index = position in the window). */
  id: string
  /** Event time (ms); 0 when the source carries none (violation rows — the render shows「—」). */
  ts: number
  /** The merged badge. */
  kind: FlowEventKind
  /** The ledger kind verbatim (`dispatch` | `settle` | `subagent-link` | `continuation` | the workflow kinds | any unknown kind string); `''` for violation rows. */
  ledgerKind: string
  /** `Execute as`; '' for settle rows without a paired identity and for workflow/unknown rows. */
  role: string
  planId: string | null
  taskId: string | null
  taskCategory: string | null
  agent: string | null
  status: FlowEventStatus
  /** Dispatch rows: an EXACT-identity-paired settle exists. */
  settled: boolean
  durationMs: number | null
  /** Violation rows only. */
  readonly severity?: string
  readonly code?: string
  readonly message?: string
  /** Workflow run identity (workflow-* + unknown rows, when carried). */
  readonly runId?: string
  readonly name?: string
  readonly memberCount?: number
  readonly seq?: number
  readonly label?: string
  readonly phase?: string
  readonly childId?: string
  readonly taskRef?: string
  readonly stopReason?: string
  /** Continuation rows: the only state is `unresolved`. */
  readonly state?: 'unresolved'
  /** The bounded display reason a `continuation` row carries. */
  readonly reason?: string
  /** The call-scoped pairing identity when the row carried one. */
  readonly callId?: string
  /** Settle rows only: the settle carries the paired dispatch's identity. */
  readonly paired?: boolean
}

/* ---------------------------------- project rollup zone ---------------------------------- */

/** The roadmap source verdict the rollup discloses (present / absent / unavailable). */
export interface RoadmapSourceView {
  kind: 'present' | 'absent' | 'unavailable'
  /** Project ids whose roadmap row is missing (partial coverage). */
  absentProjectIds: string[]
  diagnostic: string | null
}

/** The additive project rollup: roadmap milestone names + open-issue severity counts. */
export interface ProjectRollupZoneView {
  milestones: string[]
  roadmapSource: RoadmapSourceView
  /** Open residual severity counts (non-zero severities only). */
  openResiduals: { severity: string; count: number }[]
}

/* ---------------------------------- roadmap zone ---------------------------------- */

export interface RoadmapGoalView {
  ordinal: number
  parentOrdinal: number | null
  checked: boolean
  title: string
}

export interface RoadmapMilestoneIssueView {
  id: string
  title: string
  severity: string
}

export interface RoadmapMilestoneView {
  name: string
  target: string | null
  status: string | null
  /** The milestone's OPEN issues (`id · severity · title`). */
  issues: RoadmapMilestoneIssueView[]
}

/**
 * The roadmap zone. The read states are part of the CONTRACT, never a UI
 * heuristic:
 * - `not-applicable` — no project resolved; nothing was read;
 * - `unavailable` — a read was attempted and failed; `reason` is the store's
 *   own text;
 * - `ok` — the authority answered. `present: false` means it has no roadmap
 *   row for the project (`data: null`); `present: true` with zero milestones
 *   is a DIFFERENT state (a roadmap with no milestone rows).
 */
export interface RoadmapZoneView {
  state: 'ok' | 'not-applicable' | 'unavailable'
  /** `ok` only: does the authority hold a roadmap row for the project? */
  present: boolean
  /** `ok` only; `null` means absent (no roadmap row, or a content-less roadmap). */
  direction: string | null
  goals: RoadmapGoalView[]
  milestones: RoadmapMilestoneView[]
  unassignedIssues: number
  /** The store's own refusal text when `state === 'unavailable'`, else null. */
  reason: string | null
}

/* ---------------------------------- ZoneView ---------------------------------- */

export interface ZoneView {
  iteration: {
    /** An iteration gate resolved (an active iteration). */
    active: boolean
    iterationId: string | null
    /** 5 steps in PHASE_IDS order. */
    steps: IterationStepView[]
    /** 1-based index of the current step in PHASE_IDS; null = inactive. */
    currentStep: number | null
    /** Branch anchors from the workflow DTO; null while inactive. */
    branches: { iterationBase: string | null; target: string | null; specIntegration: string | null } | null
    /** Current-step gate verdict; 'unknown' when inactive. */
    verdict: PhaseVerdict
    /** Current-step `gate.violations` count; null when inactive. */
    violationCount: number | null
  }
  tasks: {
    /** 5 columns: Todo/InProgress/InReview/Done/blocked-unknown. */
    columns: KanbanColumnView[]
    total: number
    /** Any column overflow (rows > PLAN_CAP). */
    truncated: boolean
  }
  project: ProjectRollupZoneView
  roadmap: RoadmapZoneView
  /** ONE time-descending flow: dispatch-family rows, settles and violations together. */
  events: FlowEventView[]
  /** Per-zone degradation — never a global switch. */
  degraded: { iteration: boolean; state: boolean; plans: boolean; ledger: boolean }
}

/* ------------------------------ projection helpers ------------------------------ */

/*
 * The snapshot members are read through their DECLARED types (`PanelSnapshot`'s
 * own members, `PanelWorkspaceView<T>`), never through a stringly-keyed record:
 * a member rename is a compile error here instead of a silent `undefined`. The
 * unknown-byte convergence lives at the wire parse boundary
 * (`parsePanelSnapshotRead`) and, below, in the FIELD guards on a DTO's own
 * members — a host that leaves a field out still degrades that field, never the
 * panel.
 */

/** A workspace read's state; a MISSING member reads as `unavailable`. */
function stateOf(view: PanelWorkspaceView<unknown> | null | undefined): 'ok' | 'not-applicable' | 'unavailable' {
  return view === null || view === undefined ? 'unavailable' : view.state
}

/** The answered payload of one workspace read, or null when it did not answer. */
function dataOf<T>(view: PanelWorkspaceView<T> | null | undefined): T | null {
  return view !== null && view !== undefined && view.state === 'ok' ? view.data : null
}

/** The store's own reason for a non-ok read; `missing-view` when the member is absent. */
function reasonOf(view: PanelWorkspaceView<unknown> | null | undefined): string | null {
  if (view === null || view === undefined) return 'missing-view'
  return view.state === 'ok' ? null : str(view.reason) ?? ''
}

/**
 * The object rows of a WIRE-DERIVED array: a `null` hole is dropped, never
 * dereferenced. The parse boundary validates the snapshot's envelope, not every
 * element inside a DTO array, so an element can still be absent — the
 * projection degrades it away instead of throwing.
 */
function rowsOf<T>(value: readonly (T | null | undefined)[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => row !== null && typeof row === 'object') : []
}

/** The default (unlit) iteration step — schema-only, evidence lights it later. */
function idleStep(id: PhaseId, step: number): IterationStepView {
  return { id, step, state: 'idle', verdict: 'unknown' }
}

/** One guarded plan row: id/status str()-guarded (missing → ''), doneAt str()-guarded. */
interface PlanRow {
  id: string
  status: string
  doneAt: string | null
}

/**
 * One plan row from a workflow or an iteration plan DTO. The two shapes differ:
 * the workflow row carries `status`/`doneAt` itself, the iteration row nests
 * them under `execution` (null = the plan never started).
 */
function planRowOf(row: WorkflowPlanDTO | IterationPlanDTO | null | undefined): PlanRow {
  if (row === null || row === undefined) return { id: '', status: '', doneAt: null }
  const execution = 'execution' in row ? row.execution : null
  return {
    id: str(row.planId) ?? '',
    status: str('status' in row ? row.status : null) ?? str(execution?.status) ?? '',
    doneAt: str('doneAt' in row ? row.doneAt : null) ?? str(execution?.doneAt),
  }
}

/** The kanban bucket of a plan status: exact matches first, everything else → `blocked-unknown`. */
function planBucket(status: string): PlanStateId {
  switch (status) {
    case 'Todo':
    case 'InProgress':
    case 'InReview':
    case 'Done':
      return status
    default:
      return 'blocked-unknown'
  }
}

/** The plan rows of the snapshot, plus whether the authority was readable at all. */
function planRowsOf(workspace: PanelSnapshot['workspace'] | null): { rows: PlanRow[]; readable: boolean } {
  const workflowPlans = dataOf(workspace?.workflow)?.plans
  if (Array.isArray(workflowPlans)) return { rows: workflowPlans.map(planRowOf), readable: true }
  const iterationPlans = dataOf(workspace?.iteration)?.plans
  if (Array.isArray(iterationPlans)) return { rows: iterationPlans.map(planRowOf), readable: true }
  return { rows: [], readable: false }
}

/* ---------------------------------- flow events ---------------------------------- */

/** Projected event window bound: the view keeps the latest events only. */
const FLOW_EVENT_WINDOW = 50

/** Dispatch status coloring: only an explicit denied/advisory verdict refines the base `dispatched`. */
function dispatchStatus(verdict: unknown): FlowEventStatus {
  return verdict === 'denied' ? 'denied' : verdict === 'advisory' ? 'advisory' : 'dispatched'
}

/** Settle status coloring: only an explicit error/denied outcome refines the base `ok`. */
function settleStatus(outcome: unknown): FlowEventStatus {
  return outcome === 'error' ? 'error' : outcome === 'denied' ? 'denied' : 'ok'
}

/** The merged badge of a ledger kind: settles are 结算, every other readable kind is 流转. */
function badgeOf(ledgerKind: string): FlowEventKind {
  return ledgerKind === 'settle' ? 'settle' : 'dispatch'
}

/** The shared prefix of every projected ledger row. */
function flowBaseOf(
  row: { readonly kind: string; readonly ts: number; readonly agent: string | null; readonly role: string; readonly planId: string | null; readonly taskId: string | null },
  index: number,
): Pick<FlowEventView, 'id' | 'ts' | 'kind' | 'ledgerKind' | 'role' | 'planId' | 'taskId' | 'agent'> {
  const ts = count(row.ts) ?? 0
  return {
    id: `${ts}-${row.kind}-${index}`,
    ts,
    kind: badgeOf(row.kind),
    ledgerKind: row.kind,
    role: str(row.role) ?? '',
    planId: str(row.planId),
    taskId: str(row.taskId),
    agent: str(row.agent),
  }
}

/**
 * One ledger row of the dispatch / settle / link / workflow kinds. Every field
 * degrades individually; a row without a readable kind is unclassifiable and
 * skipped (never guessed).
 */
function flowEventOf(row: AgentFlowEventView | null | undefined, index: number): FlowEventView | null {
  if (row === null || row === undefined) return null
  if (str(row.kind) === null) return null
  const base = flowBaseOf(row, index)
  const childId = str(row.childId)
  const taskRef = str(row.taskRef)
  const callId = str(row.callId)
  const withCall = callId === null ? {} : { callId }
  switch (row.kind) {
    case 'dispatch':
      return {
        ...base,
        ...withCall,
        taskCategory: str(row.taskCategory),
        status: dispatchStatus(row.verdict),
        settled: false,
        durationMs: count(row.durationMs),
      }
    case 'settle':
      return {
        ...base,
        ...withCall,
        taskCategory: str(row.taskCategory),
        status: settleStatus(row.outcome),
        settled: false,
        durationMs: count(row.durationMs),
        ...(row.paired === true ? { paired: true } : {}),
        ...(childId !== null ? { childId } : {}),
        ...(taskRef !== null ? { taskRef } : {}),
      }
    case 'subagent-link':
      return {
        ...base,
        ...withCall,
        taskCategory: null,
        status: 'unknown',
        settled: false,
        durationMs: null,
        ...(childId !== null ? { childId } : {}),
        ...(taskRef !== null ? { taskRef } : {}),
      }
    default: {
      // The workflow kinds: a generic row with the run identity when carried.
      const runId = str(row.runId)
      const name = str(row.name)
      const seq = count(row.seq)
      const label = str(row.label)
      const phase = str(row.phase)
      const stopReason = str(row.stopReason)
      return {
        ...base,
        ...withCall,
        taskCategory: null,
        status: 'unknown',
        settled: false,
        durationMs: null,
        ...(runId !== null ? { runId } : {}),
        ...(row.kind === 'workflow-run' && name !== null ? { name } : {}),
        ...(row.kind === 'workflow-agent' ? {
          ...(seq !== null ? { seq } : {}),
          ...(label !== null ? { label } : {}),
          ...(phase !== null ? { phase } : {}),
          ...(childId !== null ? { childId } : {}),
        } : {}),
        ...(row.kind === 'workflow-run-end' && stopReason !== null ? { stopReason } : {}),
      }
    }
  }
}

/**
 * One unresolved-continuation row (`continuation`): a NONTERMINAL marker, so it
 * carries no verdict, no duration and no settle state.
 */
function continuationEventOf(row: AgentFlowContinuationEventView, index: number): FlowEventView {
  const base = flowBaseOf(row, index)
  const callId = str(row.callId)
  const reason = str(row.reason)
  return {
    ...base,
    ...(callId !== null ? { callId } : {}),
    taskCategory: null,
    status: 'unknown',
    settled: false,
    durationMs: null,
    state: 'unresolved',
    ...(reason !== null ? { reason } : {}),
  }
}

/** One row of the pairing walk — the identity a PAIRED settle carries. */
interface PairingRow {
  kind: FlowEventKind
  agent: string | null
  role: string
  planId: string | null
  taskId: string | null
  callId?: string | null
  paired?: boolean
}

/** The exact pairing key: `(agent, role, planId, taskId, callId)`. */
function pairingKeyOf(row: PairingRow): string {
  return [row.agent ?? '', row.role, row.planId ?? '', row.taskId ?? '', row.callId ?? ''].join('\u0000')
}

/**
 * The paired dispatch index set (the `settled` marker): a PAIRED settle pairs
 * onto the most recent EXACT-identity dispatch before it. A settle without
 * identity stays independent — no fallback guessing.
 */
export function pairSettleIndexes(rows: readonly PairingRow[]): ReadonlySet<number> {
  const record = new Set<number>()
  const lastDispatch = new Map<string, number>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = rows[i]!
    if (entry.kind === 'dispatch') {
      if (entry.agent !== null) lastDispatch.set(pairingKeyOf(entry), i)
    } else if (entry.paired === true && entry.agent !== null) {
      const paired = lastDispatch.get(pairingKeyOf(entry))
      if (paired !== undefined) record.add(paired)
    }
  }
  return record
}

/** One gate violation row; a missing field degrades to the 「—」 seat. */
function violationEventOf(row: IterationGateViolationView | null | undefined, index: number): FlowEventView {
  return {
    id: `violation-${index}`,
    // A gate violation carries no timestamp: 0 renders「—」, never a made-up time.
    ts: 0,
    kind: 'violation',
    ledgerKind: '',
    role: '',
    planId: null,
    taskId: null,
    taskCategory: null,
    agent: null,
    status: 'unknown',
    settled: false,
    durationMs: null,
    severity: str(row?.severity) ?? '',
    code: str(row?.code) ?? '',
    message: str(row?.message) ?? '',
  }
}

/**
 * The merged event flow: ledger rows (windowed, latest first) plus the gate
 * violations, ordered by time descending. Violations carry no time, so they
 * sort last — the order never invents one.
 */
function projectEvents(snapshot: PanelSnapshot | null): { events: FlowEventView[]; degraded: boolean } {
  const ledger = snapshot?.ledger ?? null
  // Absent ledger = the read did not answer. An EMPTY ledger is data.
  const degraded = ledger === null
  const events: FlowEventView[] = []
  if (ledger !== null) {
    const windowed = ledger.events.slice(0, FLOW_EVENT_WINDOW)
    // Pre-count the member rows per runId so the workflow-run row can carry it.
    const memberCounts = new Map<string, number>()
    for (const row of windowed) {
      if (row === null || typeof row !== 'object' || row.kind !== 'workflow-agent') continue
      const runId = str(row.runId)
      if (runId !== null) memberCounts.set(runId, (memberCounts.get(runId) ?? 0) + 1)
    }
    windowed.forEach((row, i) => {
      if (row === null || typeof row !== 'object') return
      const view = row.kind === 'continuation' ? continuationEventOf(row, i) : flowEventOf(row, i)
      if (view === null) return
      const runId = view.runId
      const members = runId === undefined ? undefined : memberCounts.get(runId)
      events.push(view.ledgerKind === 'workflow-run' && members !== undefined && members > 0
        ? { ...view, memberCount: members }
        : view)
    })
    const paired = pairSettleIndexes(events.map((e) => ({
      kind: e.kind,
      agent: e.agent,
      role: e.role,
      planId: e.planId,
      taskId: e.taskId,
      callId: e.callId ?? null,
      ...(e.paired === true ? { paired: true as const } : {}),
    })))
    for (const i of paired) events[i]!.settled = true
  }
  // The gate's own violations join the SAME flow.
  rowsOf(snapshot?.retained.iterationGate?.gate.violations)
    .forEach((violation, i) => events.push(violationEventOf(violation, i)))
  // Time-descending across all three kinds (violations, ts 0, stay last).
  events.sort((a, b) => b.ts - a.ts)
  return { events, degraded }
}

/* ---------------------------------- roadmap projection ---------------------------------- */

/** The roadmap zone: three read states, plus the two `ok` sub-states. */
function projectRoadmap(snapshot: PanelSnapshot | null): RoadmapZoneView {
  const view = snapshot?.workspace.roadmap
  const empty = { present: false, direction: null, goals: [], milestones: [], unassignedIssues: 0 }
  if (stateOf(view) === 'not-applicable') {
    return { ...empty, state: 'not-applicable', reason: reasonOf(view) }
  }
  if (stateOf(view) !== 'ok') {
    return { ...empty, state: 'unavailable', reason: reasonOf(view) }
  }
  const dto = dataOf(view)
  if (dto === null) {
    // `ok` with `data: null` — the authority has no roadmap row for the project.
    return { ...empty, state: 'ok', reason: null }
  }
  // A content-less roadmap is a SUPPORTED state (milestones without Markdown).
  const content = dto.content
  const direction = content === null ? null : str(content.direction)
  const goals: RoadmapGoalView[] = rowsOf(content?.goals).map((goal) => ({
    ordinal: count(goal.ordinal) ?? 0,
    parentOrdinal: count(goal.parentOrdinal),
    checked: bool(goal.checked) ?? false,
    title: str(goal.title) ?? '',
  }))
  // Issue severity lives on the issues view; the roadmap's milestone membership
  // carries only id/title/disposition, so the severity is joined by id.
  const issueRows = new Map<string, { severity: string; disposition: string }>()
  const issueItems = dataOf(snapshot?.workspace.issues)?.items
  for (const item of rowsOf(issueItems)) {
    const id = str(item.id)
    if (id === null) continue
    issueRows.set(id, { severity: str(item.severity) ?? '', disposition: str(item.disposition) ?? '' })
  }
  const milestoneData = dto.milestones
  const milestoneIssues = new Map<string, RoadmapMilestoneIssueView[]>()
  for (const issue of rowsOf(milestoneData?.issues)) {
    const id = str(issue.id)
    const milestoneId = str(issue.milestoneId)
    if (id === null || milestoneId === null) continue
    // Membership is the OPEN issues of the milestone.
    if ((str(issue.disposition) ?? '') !== 'open') continue
    const joined = issueRows.get(id)
    const row = { id, title: str(issue.title) ?? '', severity: joined?.severity ?? '' }
    const rows = milestoneIssues.get(milestoneId)
    if (rows === undefined) milestoneIssues.set(milestoneId, [row])
    else rows.push(row)
  }
  const milestones: RoadmapMilestoneView[] = rowsOf(milestoneData?.milestones).map((milestone) => ({
    name: str(milestone.name) ?? '',
    target: str(milestone.target),
    status: str(milestone.status),
    issues: milestoneIssues.get(str(milestone.milestoneId) ?? '') ?? [],
  }))
  return {
    state: 'ok',
    present: true,
    direction,
    goals,
    milestones,
    unassignedIssues: count(milestoneData?.unassignedIssues) ?? 0,
    reason: null,
  }
}

/* ---------------------------------- project rollup ---------------------------------- */

/** The additive rollup: milestone names, the roadmap source verdict and open-issue severity counts. */
function projectRollup(snapshot: PanelSnapshot | null, roadmap: RoadmapZoneView): ProjectRollupZoneView {
  const milestones = roadmap.state === 'ok' ? roadmap.milestones.map((m) => m.name).filter((name) => name !== '') : []
  // The roadmap source verdict, from the same read state the roadmap zone uses.
  const roadmapSource: RoadmapSourceView = roadmap.state === 'unavailable'
    ? { kind: 'unavailable', absentProjectIds: [], diagnostic: roadmap.reason }
    : roadmap.state === 'not-applicable' || !roadmap.present
      ? { kind: 'absent', absentProjectIds: [], diagnostic: null }
      : { kind: 'present', absentProjectIds: [], diagnostic: null }
  // Open issues by severity, from the issues view (zero-count severities omitted).
  const issueItems = dataOf(snapshot?.workspace.issues)?.items
  const counts = new Map<string, number>()
  for (const item of rowsOf(issueItems)) {
    if ((str(item.disposition) ?? '') !== 'open') continue
    const severity = str(item.severity) ?? 'unknown'
    counts.set(severity, (counts.get(severity) ?? 0) + 1)
  }
  const openResiduals = Array.from(counts, ([severity, count]) => ({ severity, count }))
    .sort((a, b) => b.count - a.count || a.severity.localeCompare(b.severity))
  return { milestones, roadmapSource, openResiduals }
}

/* ---------------------------------- projectGraph ---------------------------------- */

export function projectGraph(snapshot: PanelSnapshot | null): ZoneView {
  const workspace = snapshot === null ? null : snapshot.workspace
  const degraded = { iteration: false, state: false, plans: false, ledger: false }

  // --- iteration zone: the gate transition lights the 5-step skeleton ---
  const steps: IterationStepView[] = PHASE_IDS.map((id, i) => idleStep(id, i + 1))
  let active = false
  let currentStep: number | null = null
  let iterationId: string | null = null
  let verdict: PhaseVerdict = 'unknown'
  let violationCount: number | null = null
  let branches: ZoneView['iteration']['branches'] = null

  const gateView = snapshot?.retained.iterationGate ?? null
  const gate = gateView?.gate ?? null
  const transition = gate === null ? null : str(gate.transition)
  const phaseId = transition === null || !Object.hasOwn(TRANSITION_TO_PHASE, transition)
    ? undefined
    : TRANSITION_TO_PHASE[transition]
  iterationId = str(gateView?.iterationId)
    ?? str(dataOf(snapshot?.workspace.iteration)?.iterationId)
  if (phaseId !== undefined) {
    active = true
    const phaseIndex = PHASE_IDS.indexOf(phaseId)
    if (gateView?.compassStatus === 'active' && transition === 'phase-2-execute') {
      // Phase 1 in flight (compass `status: active`, gate still agreeing):
      // Step 1 is current with NO verdict — the engine gate evaluates only
      // Phase 2→3→4, so there is no PASS/FAIL badge and no violation count.
      currentStep = 1
      steps[0]!.state = 'current'
      const forward = PHASE_EDGES.find((e) => e.source === 'iteration-start' && e.kind === 'forward')
      if (forward !== undefined) steps[PHASE_IDS.indexOf(forward.target)]!.state = 'next'
    } else {
      currentStep = phaseIndex + 1
      const current = steps[phaseIndex]!
      current.state = 'current'
      // Completed steps must not read as idle while a later one is current.
      for (let i = 0; i < phaseIndex; i++) steps[i]!.state = 'done'
      const ok = gate === null ? null : bool(gate.ok)
      current.verdict = ok === null ? 'unknown' : ok ? 'pass' : 'fail'
      const violations = gate !== null && Array.isArray(gate.violations) ? gate.violations : null
      violationCount = violations === null ? null : violations.length
      verdict = current.verdict
      const forward = PHASE_EDGES.find((e) => e.source === phaseId && e.kind === 'forward')
      if (forward !== undefined) steps[PHASE_IDS.indexOf(forward.target)]!.state = 'next'
    }
    // Branch anchors come from the workflow DTO; projected only while active.
    const branch = dataOf(snapshot?.workspace.workflow)?.branch ?? null
    branches = {
      iterationBase: str(branch?.base),
      target: str(branch?.target),
      specIntegration: str(branch?.integration) ?? str(branch?.source),
    }
  }
  degraded.iteration = !active

  // --- tasks zone: the plan board ---
  const columns: KanbanColumnView[] = PLAN_STATE_IDS.map((id) => ({ id, plans: [], count: 0, capped: null }))
  const doneRows: PlanRow[] = []
  let total = 0
  let truncated = false
  const { rows, readable } = planRowsOf(workspace)
  if (!readable) degraded.plans = true
  for (const row of rows) {
    total += 1
    const bucket = planBucket(row.status)
    const column = columns.find((c) => c.id === bucket)!
    column.count += 1
    if (bucket === 'Done') doneRows.push(row)
    else column.plans.push({ id: row.id, status: row.status })
  }
  const doneColumn = columns.find((c) => c.id === 'Done')!
  doneColumn.plans = sortPlans(doneRows).map((r) => ({ id: r.id, status: r.status }))
  for (const column of columns) {
    if (column.count > PLAN_CAP) {
      column.capped = PLAN_CAP
      truncated = true
    }
  }

  // `state` degrades when NEITHER workspace authority could be read (a global
  // absence); one failed view never blanks the others.
  degraded.state = stateOf(workspace?.workflow) !== 'ok' && stateOf(workspace?.iteration) !== 'ok'

  const roadmap = projectRoadmap(snapshot)
  const project = projectRollup(snapshot, roadmap)
  const flow = projectEvents(snapshot)
  degraded.ledger = flow.degraded

  return {
    iteration: { active, iterationId, steps, currentStep, branches, verdict, violationCount },
    tasks: { columns, total, truncated },
    project,
    roadmap,
    events: flow.events,
    degraded,
  }
}
