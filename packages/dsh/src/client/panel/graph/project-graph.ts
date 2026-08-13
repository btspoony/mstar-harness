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
 *   5 kanban buckets (PLAN_STATE_IDS — Blocked/unknown merged into
 *   `blocked-unknown`, plan 20260813-panel-quick-fixes Task 1) and the
 *   expected role pipeline (EXPECTED_ROLE_FLOW), all client-side design
 *   knowledge;
 * - catalog evidence — `iteration.gate.transition` lights the current step
 *   (steps before it become `done` — plan 20260812-panel-f5-iteration-zone-fix
 *   Task 1, its forward target becomes `next`), `gate.ok/violations` become
 *   the PASS/FAIL verdict + count, and `state.plans[].status` rows fall into
 *   the exact-match kanban buckets. `iteration.compassStatus` (the steering
 *   compass frontmatter `status`, `'active' | 'locked'` — spec panel-f4 §2.3
 *   R9 / §5 D5) re-derives the current step during Phase 1: `'active'` WITH a
 *   `phase-2-execute` transition (compass and gate mutually consistent — QC
 *   wave F-001) → Step 1 (iteration-start) is current with verdict 'unknown'
 *   (Phase 1 has no gate evaluation → no PASS/FAIL badge) + next Step 2;
 *   `'active'` with a transition past Phase 2 (an inconsistent harness
 *   state), `'locked'`, or missing → the transition-driven logic below
 *   (Step 2→4 + gate verdict).
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
 *   / truncated`, `agents` (entities + actual/supervise edges + executing/
 *   pending counts — spec §4).
 *
 * Agent-entity semantics (plan 20260811-panel-f3-agent-general — the
 * per-role aggregation refactor): entities aggregate by ROLE, not by session
 * — a KNOWN_AGENTS roster role keys its own card (same role across sessions
 * folds into one card ×N), and EVERY non-roster dispatch (`scout`,
 * unregistered roles, anonymous `role === ''`) folds into the single
 * `general` bucket entity (key `'general'`, role shown `'general'`). The
 * legacy `unexpected` zone is GONE — stage-null non-on-demand entities now
 * project `zone: 'general'`. Placement (plan 20260812-panel-f5-agent-layout
 * Task 1, user 2026-08-12): the projection only declares the zone — the
 * RENDER places `zone: 'general'` entities in an unknown sub-partition at
 * the bottom of the LAST column (plan 20260812-panel-f5-design-system Task
 * 5, user 2026-08-12 feedback #3 — the standalone rightmost unknown column
 * is superseded: 4 columns total). The SDD loop back-edge (sdd-implement →
 * general) stays REMOVED from the projection (plan 20260811-panel-f4-agent-view
 * Task 1); the F5 supervise line is a SEPARATE sub-bucket edge
 * (`kind: 'supervise'`, see `superviseEdges`). The event-log `unexpected`
 * badge is a SEPARATE, unchanged semantic (`expected` ⟺ role ∈
 * EXPECTED_ROLE_FLOW union). The `sdd-implement` column is further split
 * into implementor / reviewer SUB-BUCKETS (plan 20260812-panel-f5-agent-layout
 * Task 1): every entity carries a projected `bucket` field ('implementor' /
 * 'reviewer' / null via SDD_BUCKET_ROLES — a layout dimension ORTHOGONAL to
 * expectedness: on-demand roles keep their `unexpected` badge inside the
 * implementor bucket).
 *
 * Degradation (spec §8): `source === null` → legal empty view (the panel
 * never mounts the graph for that case, but the projection stays total);
 * missing iteration / unresolvable transition → `active: false` + 5 idle
 * steps + `degraded.iteration` (the old `degraded.transition` is merged into
 * `iteration.active === false` — `degraded.iteration ⟺ !active`); `state`
 * null → 5-column skeleton (count 0) + `degraded.state`; `state.plans`
 * missing → same skeleton + `degraded.plans`; `state.agentFlow`
 * missing/unreadable → agents roster + `degraded` (full KNOWN_AGENTS idle
 * cards, no executing/pending claims); 0 events → `empty` (idle roster +
 * pending skeleton). `iteration.compassStatus` missing, non-union (old
 * catalog rows / fixtures — the field is OPTIONAL, spec D5), or `'active'`
 * with a transition past Phase 2 (an inconsistent harness state — QC wave
 * F-001) degrades to the existing transition-driven current-step logic
 * (Step 2→4) — backward compatible, `active` semantics unchanged.
 */

import type { MstarEngineStatusSource } from '../../../types.ts'
import { bool, count, str } from '../guards.ts'
import { comparePlansByIterationRecency, PLAN_CAP, sortPlans } from '../plan-sort.ts'
import {
  EXPECTED_ROLE_FLOW, GENERAL_BUCKET, KNOWN_AGENTS, PHASE_EDGES, PHASE_IDS, PLAN_STATE_IDS, SDD_BUCKET_ROLES, TRANSITION_TO_PHASE,
  type AgentZone, type KnownAgent, type PhaseId, type PlanStateId,
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
  /** `Execute as`; '' for settle rows without a paired identity. */
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
  /** dispatch: has an EXACT-identity-paired settle (exact pairing; an unpaired settle stays unpaired — honest); settle: always false. */
  settled: boolean
  /** Settle rows only (plan `20260811-panel-f4-timeliness` Task 1): the settle carries the PAIRED dispatch's identity (exact pairing). */
  paired?: boolean
  durationMs: number | null
}

/* ---------------------------------- iteration zone (spec §3) ---------------------------------- */

/**
 * One iteration step (spec §3 + plan 20260812-panel-f5-iteration-zone-fix
 * Task 1): the PHASE_IDS skeleton with current/next/done/idle lit by
 * `gate.transition` evidence — the CURRENT step, its forward target (`next`)
 * and every step BEFORE it (`done` — completed: the Task 1 fix, a finished
 * Step 1 must not read as idle「待命」 while Step 2 is current). The `step`
 * number is 1-based (1..5). `verdict` is carried by the CURRENT step only.
 */
export interface IterationStepView {
  id: PhaseId
  /** 1-based position in PHASE_IDS (1..5). */
  step: number
  /** 'current' (the gate transition) / 'next' (its forward target) / 'done'
   * (a step BEFORE the current one — completed) / 'idle' (schema-only). */
  state: 'current' | 'next' | 'done' | 'idle'
  /** Current-step gate verdict; 'unknown' on non-current steps. */
  verdict: PhaseVerdict
}

/* ---------------------------------- tasks zone (spec §3) ---------------------------------- */

/**
 * One kanban column (spec §3 + plan 20260813-panel-quick-fixes Task 1): the
 * PLAN_STATE_IDS skeleton with plan rows bucketed by status — `Blocked` and
 * any non-matching status (the former `unknown` catch-all) both fold into the
 * single `blocked-unknown` column. `count` is the FULL column count; `plans`
 * keeps EVERY row (no slice — the render truncates to PLAN_CAP and offers a
 * 「更多」 expand). The Done column is additionally sorted with the shared
 * plan-sort key (`plan-sort.ts`); every other column keeps input order.
 * `capped` carries PLAN_CAP when the column overflows, else null.
 */
export interface KanbanColumnView {
  id: PlanStateId
  /** ALL rows (Done: plan-sort order; others: input order). */
  plans: { id: string; status: string }[]
  /** Full column count (equal to `plans.length`). */
  count: number
  /** PLAN_CAP when the column overflows (count > PLAN_CAP); null otherwise. */
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
 * One agent entity card (spec §4 + §6.2 + plan 20260811-panel-f3-agent-general):
 * either a ROLE aggregated across its dispatch rows (count + latest ts;
 * identity fields reflect the LATEST dispatch — the same dispatch that
 * decides the status; `agent` / `task` are record fields, never the title)
 * or a synthesized `idle` card for a KNOWN_AGENTS roster member with NO
 * dispatch evidence (key = role id; count 0 / ts 0 — never a guessed status).
 * Non-roster dispatches (former `generalPurpose` / `scout` / anonymous '')
 * aggregate into the single `general` bucket entity.
 */
export interface AgentEntityView {
  /**
   * THE ROLE id for lit cards (KNOWN_AGENTS membership — `general` for every
   * non-roster dispatch); the KNOWN_AGENTS role id for idle cards. INVARIANT
   * (spec §6.2, F-001): keys are UNIQUE across the whole `entities` array —
   * an evidence-derived `general` key suppresses the idle general twin in
   * `idleEntities`, so the React `key` / `layoutAgents` `cards.set` never see
   * duplicates.
   */
  key: string
  /** The raw session id of the LATEST dispatch; null for idle cards. */
  agent: string | null
  /** Display name = `agent ?? key` (spec §4); the role id for idle cards. */
  name: string
  /** Role chip — the raw role of the latest dispatch; `'general'` for the
   * bucket entity; the known role id for idle cards. */
  role: string
  /** Task tag `${planId}#${taskId}` (missing planId → null; taskId missing → planId); null for idle cards. */
  task: string | null
  /** Spec §4 hardcoded priority: latest-dispatch verdict → paired settle → running. */
  status: AgentEntityStatus
  /** No dispatch evidence → the idle (muted "未工作") card; idle never counts into `executing`. */
  idle: boolean
  /** Dispatch count of this entity in the window (settles never count); 0 for idle cards. */
  count: number
  /** Latest dispatch ts (the status/identity source); 0 for idle cards. */
  ts: number
  /** Latest dispatch's stage via `roleStageIndex` (first constant-order match); null → off-pipeline role; KNOWN_AGENTS stage for idle cards. */
  stage: { phase: PhaseId; stage: string } | null
  /** Column zone (plan 20260811-panel-f3-agent-general — projection-owned,
   * the render NEVER heuristically guesses): 'flow' (stage columns), 'on-demand'
   * (ops-engineer / prompt-engineer — implementor-sub-bucket dispatches with
   * an on-demand badge; the standalone on-demand column is REMOVED, plan
   * 20260812-panel-f5-agent-layout Task 2) or 'general' (the general bucket —
   * the rightmost UNKNOWN column, Task 2). Derived from the role for lit
   * cards, from the KnownAgent `zone` for idle cards. */
  zone: AgentZone
  /** SDD sub-bucket (plan 20260812-panel-f5-agent-layout Task 1 —
   * projection-derived, the render ONLY consumes it): role ∈
   * SDD_BUCKET_ROLES.implementor → 'implementor' (incl. on-demand roles),
   * role ∈ SDD_BUCKET_ROLES.reviewer → 'reviewer' (code-reviewer); every
   * other role (qc/qa/review-edit-chain/general) → null. Same rule for idle
   * cards (KNOWN_AGENTS id → SDD_BUCKET_ROLES lookup). */
  bucket: AgentBucket | null
  /** Transparency tier (plan 20260812-panel-f5-design-system Task 4 — the
   * TIME dimension, design doc §3): the iteration's current phase vs the
   * entity's pipeline-stage phase — 'current' (chrome full-strength), 'next'
   * (mid transparency), 'off' (low transparency — passed phases, on-demand /
   * general bucket), null (no iteration/plan — NO override, idle status quo).
   * ORTHOGONAL to `bucket` (space: same-column partition) / `zone` (column) /
   * `status` (evidence): the render fades the card CHROME only — the status
   * point and the running ring/glow NEVER fade (design doc §3.4 HARD). */
  emphasis: AgentEmphasis
}

/** The SDD sub-bucket a role belongs to within the `sdd-implement` column
 * (plan 20260812-panel-f5-agent-layout Task 1): 'implementor' | 'reviewer';
 * roles in neither bucket project `null`. The bucket is a LAYOUT dimension,
 * ORTHOGONAL to expectedness (SDD_BUCKET_ROLES vs EXPECTED_ROLE_FLOW — an
 * on-demand role in the implementor bucket stays OUTSIDE the expected union). */
export type AgentBucket = 'implementor' | 'reviewer'

/** Transparency tier (plan 20260812-panel-f5-design-system Task 4 — design
 * doc §3.1): the TIME dimension of an entity — the iteration's current phase
 * vs the entity's pipeline-stage phase. 'current' → chrome full-strength,
 * 'next' → mid transparency (expected but not yet), 'off' → low transparency
 * (already-passed phase, or NO stage — on-demand / general bucket), null →
 * no iteration/plan (NO override — the render keeps the idle status quo). */
export type AgentEmphasis = 'current' | 'next' | 'off' | null

/**
 * Emphasis derivation (plan 20260812-panel-f5-design-system Task 4 — design
 * doc §3.3, the FINALIZED rule: Task 3 gate D4–D7 confirmed the tiers
 * 1/0.75/0.45, phase granularity, on-demand → 'off' and Phase 3–5 → all
 * 'off'). Reuses ONLY projected fields (`iteration.currentStep` +
 * `entity.stage`) — zero new catalog reads:
 *
 *   currentStep === null                      → null   (no iteration: no override)
 *   stage === null                            → 'off'  (on-demand / general bucket)
 *   phaseRank(stage.phase) <  rank(current)   → 'off'  (already-passed phase)
 *   phaseRank(stage.phase) === rank(current)  → 'current'
 *   otherwise                                 → 'next' (a later phase)
 *
 * Phase 3–5 have NO EXPECTED_ROLE_FLOW stages (design doc §3.2 note) — every
 * pipeline role's rank stays below the current phase → all 'off'. Total
 * function, never a throw: an out-of-range `currentStep` (impossible via the
 * projection — it derives 1..5) degrades to `null` (no override).
 */
function emphasisOf(
  stage: { phase: PhaseId; stage: string } | null,
  currentStep: number | null,
): AgentEmphasis {
  if (currentStep === null) return null
  if (stage === null) return 'off'
  const currentPhase = PHASE_IDS[currentStep - 1]
  if (currentPhase === undefined) return null // defensive: out-of-range step → no override
  const rank = PHASE_IDS.indexOf(stage.phase)
  const currentRank = PHASE_IDS.indexOf(currentPhase)
  if (rank < currentRank) return 'off'
  if (rank === currentRank) return 'current'
  return 'next'
}

/**
 * Entity status (spec §4, hardcoded priority; plan
 * 20260813-panel-quick-fixes Task 2): `denied` comes from the LATEST dispatch's
 * verdict (the only terminal verdict — settle-independent); `error`/`settled`
 * come from the settle paired with that dispatch; `running` = no paired settle
 * yet (exact identity pairing — an unpaired settle stays unpaired, honest);
 * `idle` = a KNOWN_AGENTS roster member with no dispatch evidence (spec §6.2 —
 * never guessed as running/settled). `advisory` is RETAINED as a union member
 * for backward shape, but the derivation (entityStatus) no longer emits it —
 * an advisory-verdict dispatch now falls through to its settle pair (or
 * `running`); the advisory VERDICT still renders in the event log.
 */
export type AgentEntityStatus =
  | 'running'
  | 'settled'
  | 'error'
  | 'denied'
  /** Retained for shape compat; the derivation (entityStatus) no longer emits it. */
  | 'advisory'
  | 'idle'

/** Edge kinds (spec §4 + plan 20260812-panel-f5-design-system Task 5 — the
 * 2026-08-12 finalized line semantics, design doc §2.2): handoff / sub-bucket
 * supervision arrows. `expected` (stage skeleton) and `next` (running
 * animation) are REMOVED — the column order implies the flow, the running
 * card glow/status point carries the position (user feedback #1/#5). */
export type AgentEdgeKind = 'actual' | 'supervise'

/**
 * One agents-zone arrow (spec §4 + plan 20260812-panel-f5-agent-layout Task
 * 1 + plan 20260812-panel-f5-design-system Task 5):
 * - `actual`: same-plan handoff between ts-adjacent dispatch ENTITY keys
 *   (source/target = entity key — role-based since plan
 *   20260811-panel-f3-agent-general). Task 5 filters general-bucket endpoints
 *   (a general handoff is noise, not a meaningful transfer) and keeps at most
 *   ONE edge per entity-key pair (the latest direction) — design doc §2.2;
 * - `supervise`: ONE static sub-bucket line inside the `sdd-implement`
 *   column — implementor ↔ reviewer mutual supervision (mstar-sdd contract;
 *   the render draws it as a bidirectional double arrow, Task 2).
 *   source/target embed the column id as an anchor prefix:
 *   `<stage-id>:implementor` / `<stage-id>:reviewer`. NOT per-entity pairs —
 *   drawing per-role pairs would fabricate concrete supervision relations
 *   where no evidence exists (evidence-level handoffs are covered by
 *   `actualEdges`). STATIC presence (design knowledge) + evidence-driven
 *   lighting via `evidenced` (dim without implement/review dispatch
 *   evidence, lit with it — never a fabricated activation).
 */
export interface AgentEdge {
  kind: AgentEdgeKind
  /** actual: entity key; supervise: `<stage-id>:implementor|reviewer`. */
  source: string
  target: string
  /** Unused by the Task 5 line set (the removed `next` arrow carried the
   * running entity key); kept for shape stability — always null. */
  entityKey: string | null
  /** Supervise edges only (plan 20260812-panel-f5-agent-layout Task 1):
   * evidence-driven lighting — true when any dispatch row's role belongs to
   * an SDD sub-bucket (implementor ∪ reviewer), false otherwise (dim).
   * Absent (undefined) for actual. */
  evidenced?: boolean
}

/**
 * The canvas degradation-note classification (spec §8, F-002): the projection
 * decides the note from the RAW ledger (never a UI-side heuristic on the
 * entity list): `empty` = 0 events; `settle-only` = events present but NO
 * dispatch row (all settle / garbage rows — genuinely no dispatch evidence);
 * `null` = dispatch evidence present (incl. anonymous dispatch rows — they
 * are evidence, not settle-only). The unreadable-ledger case is the SEPARATE
 * `degraded` flag, not a note value.
 */
export type AgentZoneNote = 'empty' | 'settle-only' | null

/**
 * The projected agents zone (spec §4 + §6.2): the EXPECTED_ROLE_FLOW stage
 * skeleton plus the dispatch-derived entity cards and the actual/supervise
 * arrows. Total function — NEVER throws and NEVER fabricates: the KNOWN_AGENTS
 * roster always projects as entities (idle cards when there is no evidence) —
 * agentFlow missing/unreadable → `degraded` (full idle roster + no
 * executing/pending claims); 0 events → `empty` (full idle roster + pending
 * skeleton); settle-only ledger → full idle roster (settles never produce
 * cards) + full pending skeleton.
 */
export interface AgentZoneView {
  /** The EXPECTED_ROLE_FLOW skeleton (pending stages). */
  stages: readonly AgentZoneStage[]
  /** `state.agentFlow` missing/unreadable (ledger absent → no evidence to show). */
  degraded: boolean
  /** `state.agentFlow` present but 0 events (recording started at plan merge). */
  empty: boolean
  /** The projected canvas note (spec §8, F-002 — see `AgentZoneNote`). */
  note: AgentZoneNote
  /** Evidence-derived dispatch entities ∪ idle KNOWN_AGENTS cards — the full roster is NEVER hidden (spec §6.2). */
  entities: readonly AgentEntityView[]
  /** expected (stage skeleton) + actual (same-plan handoffs) + at most one next (latest running). */
  edges: readonly AgentEdge[]
  /** `running` entity count — the summary "N 执行中" (idle cards never count). */
  executing: number
  /** Sum of expected roles of stages with no dispatch evidence — the summary "M 待执行". */
  pending: number
  /** The FIRST `state.plans[]` row with status 'InProgress' (catalog order);
   * null when no plan is in progress (plan 20260812-panel-f5-design-system
   * Task 8 — the Phase 2 group's current-plan annotation, user 2026-08-12
   * feedback #2). Total function: state/plans missing or no InProgress row →
   * null (never fabricated). */
  activePlanId: string | null
  /** How many `state.plans[]` rows are InProgress (the render shows
   * `+N more` when several plans run in parallel — honest, same shape as the
   * kanban overflow hint; never hides the count behind the first id). */
  activePlanCount: number
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
    /** 5 columns: Todo/InProgress/InReview/Done/blocked-unknown (spec §3). */
    columns: KanbanColumnView[]
    /** Plan total across all columns, the merged column included. */
    total: number
    /** Any column overflow (rows > PLAN_CAP). */
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

/** One guarded plan row: id/status str()-guarded (missing → ''), doneAt str()-guarded (missing → null), iterationRefs guarded (missing → []). */
interface PlanRow {
  id: string
  status: string
  doneAt: string | null
  iterationRefs: string[]
}

/** Guarded `iterationRefs`: non-empty-string array, else [] (missing → []). */
function iterationRefsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []
}

/** One guarded plan row: id/status str()-guarded, missing → '' (never fabricated). */
function planRow(raw: unknown): PlanRow {
  const row = raw as { id?: unknown; status?: unknown; doneAt?: unknown; iterationRefs?: unknown } | null | undefined
  return {
    id: str(row?.id) ?? '',
    status: str(row?.status) ?? '',
    doneAt: str(row?.doneAt),
    iterationRefs: iterationRefsOf(row?.iterationRefs),
  }
}

/** The kanban bucket of a plan status (plan 20260813-panel-quick-fixes Task 1):
 * the 4 exact-match states map to their own column; `Blocked` and every other
 * (unknown/catch-all) status fold into the single `blocked-unknown` column. */
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
    const row = iteration as { iterationId?: unknown; gate?: unknown; compassStatus?: unknown }
    iterationId = str(row.iterationId)
    const gate = row.gate as { transition?: unknown; ok?: unknown; violations?: unknown } | null | undefined
    const transition = gate === null || typeof gate !== 'object' ? null : str(gate.transition)
    const phaseId = transition === null || !Object.hasOwn(TRANSITION_TO_PHASE, transition)
      ? undefined
      : TRANSITION_TO_PHASE[transition]
    if (phaseId !== undefined) {
      active = true
      if (row.compassStatus === 'active' && transition === 'phase-2-execute') {
        // Phase 1 in flight (steering compass `status: active`, not yet
        // locked — spec panel-f4 §2.3 R9 + §5 D5) AND the gate still agrees
        // (transition `phase-2-execute` — QC wave F-001: the override fires
        // only while compass and gate are mutually consistent; compass
        // `active` with a transition past Phase 2, e.g. `phase-3-close` in an
        // inconsistent harness state, falls through to the transition-driven
        // branch below, which shows the REAL gate verdict instead of hiding
        // it): Step 1 (iteration-start) is CURRENT with verdict 'unknown' —
        // the engine gate evaluates only Phase 2→3→4, so Phase 1 has no
        // PASS/FAIL verdict and no violation count (summary + step render no
        // badge; violationCount stays null, violations empty). Next = Step 2
        // via the SAME PHASE_EDGES forward rule the locked path uses
        // (iteration-start → autonomous-execute). `active` stays true — the
        // transition already resolved (engine `evaluatePhaseGate` emits
        // phase-2-execute + ok:true during Phase 1); only the CURRENT STEP is
        // re-derived here. No `done` step on this branch (plan
        // 20260812-panel-f5-iteration-zone-fix Task 1): Step 1 is current and
        // nothing precedes it (index 0 → no completed steps).
        currentStep = 1
        const current = steps[0]!
        current.state = 'current'
        // QC wave F-002 (qc3): the Phase-1 verdict is EXPLICIT — not the
        // idleStep default — so a future change to that default can never
        // silently give Phase 1 a PASS/FAIL badge.
        current.verdict = 'unknown'
        const forward = PHASE_EDGES.find((e) => e.source === 'iteration-start' && e.kind === 'forward')
        if (forward !== undefined) steps[PHASE_IDS.indexOf(forward.target)]!.state = 'next'
      } else {
        // `compassStatus === 'locked'` (Phase 1 complete) or missing/non-union
        // (guard degrade — Total-function) → the existing gate-transition-
        // driven logic (Step 2→4 + gate verdict).
        const index = PHASE_IDS.indexOf(phaseId)
        currentStep = index + 1 // 1-based
        const current = steps[index]!
        current.state = 'current'
        // Completed steps (plan 20260812-panel-f5-iteration-zone-fix Task 1 —
        // the user bug: a finished Step 1 must not read as idle「待命」 while
        // Step 2 is current): every step BEFORE the current one projects
        // `done` (steps 0..index-1; index 0 → no done, e.g. an iteration at
        // the first lit phase). current/next logic above stays unchanged.
        for (let i = 0; i < index; i++) steps[i]!.state = 'done'
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
      }
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

  // --- tasks zone: 5-column skeleton (Blocked + unknown merged into
  // `blocked-unknown`, plan 20260813-panel-quick-fixes Task 1) ---
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
        const bucket = planBucket(row.status)
        const column = columns.find((c) => c.id === bucket)!
        column.count += 1
        if (bucket === 'Done') {
          // Done rows are sorted below (needs doneAt — not a view field).
          doneRows.push(row)
        } else {
          column.plans.push({ id: row.id, status: row.status })
        }
      }
    }
  }

  // Done column: shared plan-sort key (spec §3 — `plan-sort.ts`, reused not
  // copied). ALL rows are KEPT (no slice — the render truncates to PLAN_CAP
  // and offers the 「更多」 expand); the cap is a RENDER concern, so every
  // column only reports `capped` (PLAN_CAP) when it overflows.
  const doneColumn = columns.find((c) => c.id === 'Done')!
  doneColumn.plans = sortPlans(doneRows).map((r) => ({ id: r.id, status: r.status }))
  for (const column of columns) {
    if (column.count > PLAN_CAP) {
      column.capped = PLAN_CAP
      truncated = true
    }
  }

  // --- agents zone + flow events (spec §3/§4) ---
  // `currentStep` (already computed above, spec §3) drives the entity
  // transparency tiers (plan 20260812-panel-f5-design-system Task 4 — design
  // doc §3.3: null → no override, every entity `emphasis: null`).
  const agents = projectAgents(source, currentStep)
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

/**
 * The SDD sub-bucket of a role (plan 20260812-panel-f5-agent-layout Task 1):
 * role ∈ SDD_BUCKET_ROLES.implementor → 'implementor' (incl. the on-demand
 * ops-engineer / prompt-engineer — bucket membership is a LAYOUT dimension,
 * orthogonal to expectedness), role ∈ SDD_BUCKET_ROLES.reviewer →
 * 'reviewer' (code-reviewer); every other role (qc / qa / review-edit-chain /
 * general) → null. Total function, never a throw.
 */
function bucketOf(role: string): AgentBucket | null {
  if (SDD_BUCKET_ROLES.implementor.includes(role)) return 'implementor'
  if (SDD_BUCKET_ROLES.reviewer.includes(role)) return 'reviewer'
  return null
}

/** The `sdd-implement` stage column id (the sub-buckets' host column) —
 * DERIVED from the projected stages (the same `${phase}:${stage}` key
 * construction the projection emits — a phase/stage rename can never
 * silently orphan the supervise line); null when the stage is absent. */
function sddImplementColumnId(stages: readonly AgentZoneStage[]): string | null {
  const s = stages.find((x) => x.stage === 'sdd-implement')
  return s === undefined ? null : s.id
}

/**
 * The sub-bucket supervision edge (plan 20260812-panel-f5-agent-layout Task
 * 1): ONE static design-knowledge line between the `sdd-implement` column's
 * implementor and reviewer sub-buckets (the mstar-sdd mutual-supervision
 * contract — the render draws it as a bidirectional double arrow, Task 2).
 * NOT per-entity pairs: drawing implementor→reviewer per role pair would
 * fabricate concrete supervision relations where no evidence exists (the
 * evidence-level handoffs are already covered by `actualEdges`). STATIC
 * presence (existence = design knowledge — the edge is emitted even without
 * any dispatch evidence, degraded/empty branches included) + evidence-driven
 * lighting via `AgentEdge.evidenced` (dim with no implement/review dispatch
 * evidence, lit with it — the same pattern as the expected skeleton: never a
 * fabricated activation). Anchors embed the column id as a prefix:
 * `<stage-id>:implementor` / `<stage-id>:reviewer`.
 */
function superviseEdges(stages: readonly AgentZoneStage[], entries: readonly { view: FlowEventView }[]): AgentEdge[] {
  const columnId = sddImplementColumnId(stages)
  if (columnId === null) return []
  const evidenced = entries.some(
    (e) => e.view.kind === 'dispatch' && bucketOf(e.view.role) !== null,
  )
  return [{
    kind: 'supervise',
    source: `${columnId}:implementor`,
    target: `${columnId}:reviewer`,
    entityKey: null,
    evidenced,
  }]
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
  /** Column zone (plan 20260811-panel-f3-agent-general): 'flow' when staged;
   * KNOWN_AGENTS `zone` for off-pipeline roster roles; 'general' otherwise. */
  zone: AgentZone
  /** SDD sub-bucket (plan 20260812-panel-f5-agent-layout Task 1): derived
   * from the entity role via `bucketOf` — see AgentEntityView.bucket. */
  bucket: AgentBucket | null
  /** Index of the latest dispatch in the classified entries array (pair lookup). */
  latestIndex: number
  /** dispatchStatus of the latest dispatch ('denied' | 'advisory' | 'dispatched'). */
  verdict: FlowEventStatus
}

/**
 * The entity key of a dispatch row (plan 20260811-panel-f3-agent-general —
 * per-role aggregation): a KNOWN_AGENTS roster role keys its OWN card
 * (in-union → key = role); EVERY non-roster dispatch — the former
 * `generalPurpose` SDD reviewer, `scout`, unregistered roles and anonymous
 * `role === ''` — folds into the single `general` bucket entity. Total
 * function: every dispatch row yields a key, never a throw.
 */
function entityKeyOf(role: string): string {
  if (role !== '' && KNOWN_AGENTS.some((a) => a.id === role)) return role
  return GENERAL_BUCKET
}

/** The zone helper shared by lit + idle cards (plan 20260811-panel-f3-agent-general):
 * a staged role is 'flow'; an off-pipeline role takes its KNOWN_AGENTS `zone`
 * (on-demand / general), defaulting to 'general'. Never a render-side heuristic. */
function roleZone(role: string, stage: { phase: PhaseId; stage: string } | null): AgentZone {
  if (stage !== null) return 'flow'
  const known = KNOWN_AGENTS.find((a) => a.id === role)
  return known === undefined ? GENERAL_BUCKET : (known.zone ?? GENERAL_BUCKET)
}

/**
 * Entity status (spec §4 hardcoded priority; plan
 * 20260813-panel-quick-fixes Task 2): `denied` is the ONLY terminal verdict —
 * a denied dispatch stays denied, settle-independent. `advisory` is NO LONGER
 * terminal (a soft-enforcement dispatch is a "放行" pass-through, not a final
 * state — it must not mask a real completion): the settle paired with that
 * dispatch decides — `error` → error, `ok`/`denied` → settled; no pair →
 * running (exact identity pairing — an unpaired settle stays unpaired, honest).
 * `advisory` stays a valid `AgentEntityStatus` union member for backward shape
 * but nothing projects it now; the advisory VERDICT still renders in the event
 * log via `dispatchStatus` (unchanged).
 */
function entityStatus(acc: EntityAccum, pairStatus: ReadonlyMap<number, FlowEventStatus>): AgentEntityStatus {
  if (acc.verdict === 'denied') return 'denied'
  const paired = pairStatus.get(acc.latestIndex)
  return paired === 'error' ? 'error' : paired === undefined ? 'running' : 'settled'
}

/**
 * Aggregate dispatch rows into entity cards (spec §4 + plan
 * 20260811-panel-f3-agent-general): key = the ROLE classification
 * (`entityKeyOf` — a KNOWN_AGENTS role id, or `'general'` for every
 * non-roster / anonymous dispatch); the same key aggregates across sessions
 * (count + latest ts, identity fields from the latest dispatch — `agent` /
 * `task` are record fields, the general entity's role displays `'general'`).
 * Anonymous rows (role '') are NOT skipped — they are dispatch evidence and
 * belong to the general bucket (user decision). Settle rows never produce
 * entities — they are COMPLETION records, not dispatches (spec §4; a paired
 * settle now carries the dispatch identity but never becomes a card).
 */
function aggregateEntities(
  entries: readonly { view: FlowEventView }[],
  pairStatus: ReadonlyMap<number, FlowEventStatus>,
  currentStep: number | null,
): AgentEntityView[] {
  const acc = new Map<string, EntityAccum>()
  for (let i = 0; i < entries.length; i++) {
    const v = entries[i]!.view
    if (v.kind !== 'dispatch') continue
    const key = entityKeyOf(v.role)
    const role = key === GENERAL_BUCKET ? GENERAL_BUCKET : v.role
    const task = v.planId === null ? null : v.taskId === null ? v.planId : `${v.planId}#${v.taskId}`
    const cur = acc.get(key)
    if (cur === undefined) {
      acc.set(key, {
        key,
        agent: v.agent,
        name: v.agent ?? role,
        role,
        task,
        count: 1,
        ts: v.ts,
        stage: v.stage,
        zone: roleZone(role, v.stage),
        bucket: bucketOf(role),
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
        cur.name = v.agent ?? role
        cur.role = role
        cur.task = task
        cur.stage = v.stage
        cur.zone = roleZone(role, v.stage)
        cur.bucket = bucketOf(role)
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
    zone: e.zone,
    bucket: e.bucket,
    emphasis: emphasisOf(e.stage, currentStep),
    status: entityStatus(e, pairStatus),
    idle: false,
  }))
}

/**
 * Same-plan handoff arrows (spec §4 + plan 20260812-panel-f5-design-system
 * Task 5 — design doc §2.2): within each planId, the ts-ascending adjacent
 * dispatch ENTITY pairs — keys are ROLE-based since plan
 * 20260811-panel-f3-agent-general (`entityKeyOf`, the same classification the
 * entity cards use, so a handoff always connects two real cards; anonymous
 * rows fold into the `general` key). Plan-less dispatches cannot form a pair
 * → excluded; a self-pair (the same entity twice in a row) is skipped — a
 * card never hands off to itself.
 *
 * Task 5 简洁化 (user 2026-08-12 feedback #5, design doc §2.2): general-bucket
 * endpoints are FILTERED (a handoff into/out of the anonymous catch-all is
 * noise, not a meaningful transfer — the general card is a sink, not a flow
 * participant), and each unordered entity-key PAIR emits AT MOST ONE edge —
 * the latest direction (an A→B→A→B oscillation collapses to the final B
 * handoff). Total function, never a throw.
 */
function actualEdges(entries: readonly { view: FlowEventView }[]): AgentEdge[] {
  const byPlan = new Map<string, { key: string; ts: number; idx: number }[]>()
  entries.forEach((e, idx) => {
    const v = e.view
    if (v.kind !== 'dispatch') return
    if (v.planId === null) return // no plan → no same-plan chain
    const key = entityKeyOf(v.role)
    const list = byPlan.get(v.planId)
    if (list === undefined) byPlan.set(v.planId, [{ key, ts: v.ts, idx }])
    else list.push({ key, ts: v.ts, idx })
  })
  // Unordered-pair dedupe map: the walk is ts-ascending, so the LAST write per
  // pair carries the LATEST direction (design doc §2.2 — 同对实体键至多 1 条).
  const pairEdges = new Map<string, AgentEdge>()
  for (const planId of Array.from(byPlan.keys()).sort()) {
    const rows = byPlan.get(planId)!
      .slice()
      .sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.idx - b.idx)
    for (let i = 0; i + 1 < rows.length; i++) {
      if (rows[i]!.key === rows[i + 1]!.key) continue // self-pair skip
      const a = rows[i]!.key
      const b = rows[i + 1]!.key
      if (a === GENERAL_BUCKET || b === GENERAL_BUCKET) continue // general endpoints filtered
      const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`
      pairEdges.set(pairKey, { kind: 'actual', source: a, target: b, entityKey: null })
    }
  }
  return Array.from(pairEdges.values())
}

/**
 * Idle roster cards (spec §6.2): every KNOWN_AGENTS member WITHOUT role
 * evidence gets an `idle` entity (key = role id) — the full known roster is
 * NEVER hidden, degraded/empty branches included. `idle` cards carry no
 * fabricated claims: agent null, count 0, ts 0, task null, status `idle`.
 *
 * Key-uniqueness guard (F-001 — qc1/qc2 Warning): `evidencedRoles` suppresses
 * the idle card of a role WITH dispatch evidence, but a NON-roster dispatch
 * (e.g. `scout` — no KNOWN_AGENTS entry for it) produces a lit card keyed
 * `general` WITHOUT the `general` role being literally evidenced.
 * `litKeys` (the evidence-derived entity key set) suppresses the idle general
 * twin in that case too — the entity key space stays unique, so
 * `layoutAgents`' `cards.set` and the React `key` never collide/overwrite.
 */
function idleEntities(
  evidencedRoles: ReadonlySet<string>,
  litKeys: ReadonlySet<string>,
  currentStep: number | null,
): AgentEntityView[] {
  const out: AgentEntityView[] = []
  for (const known of KNOWN_AGENTS) {
    if (evidencedRoles.has(known.id)) continue
    if (litKeys.has(known.id)) continue // F-001: the lit card occupies this roster slot
    const stage = known.stage ?? null
    out.push({
      key: known.id,
      agent: null,
      name: known.displayName ?? known.id,
      role: known.id,
      task: null,
      status: 'idle',
      idle: true,
      count: 0,
      ts: 0,
      stage,
      zone: idleZone(known),
      bucket: bucketOf(known.id),
      emphasis: emphasisOf(stage, currentStep),
    })
  }
  return out
}

/** Idle-card zone (plan 20260811-panel-f3-agent-general): the KnownAgent's
 * explicit off-pipeline zone (on-demand / general) — staged roster members
 * are 'flow'. */
function idleZone(known: KnownAgent): AgentZone {
  if (known.stage !== null) return 'flow'
  return known.zone ?? GENERAL_BUCKET
}

/**
 * The「当前迭代」iteration-id set (plan 20260813-panel-quick-fixes Task 2 — the
 * Clarify filter口径). Only `projectAgents` consumes it; `projectFlowEvents`
 * is unfiltered. Total function — never throws, an empty set is legal.
 *
 * - Steering compass active (`iterationId` non-null): the current iteration
 *   IS that id → the set is `{ iterationId }`.
 * - No compass (`iterationId` null): the「最近一次迭代」 — among plans with
 *   NON-EMPTY `iterationRefs`, the single most-recent plan (the SHARED
 *   `comparePlansByIterationRecency` order from `plan-sort.ts`: max 8-digit id
 *   date prefix, tie-break max doneAt, then id DESC) names the latest
 *   iteration → the set is that plan's `iterationRefs` (empty when none).
 */
function currentIterationIds(iterationId: string | null, plans: readonly PlanRow[]): ReadonlySet<string> {
  if (iterationId !== null && iterationId !== '') return new Set([iterationId])
  let latest: PlanRow | undefined
  for (const plan of plans) {
    if (plan.iterationRefs.length === 0) continue
    if (latest === undefined || comparePlansByIterationRecency(plan, latest) < 0) latest = plan
  }
  return new Set(latest === undefined ? [] : latest.iterationRefs)
}

/**
 * The「当前迭代」keep predicate (plan 20260813-panel-quick-fixes Task 2): a
 * dispatch row is filtered OUT only when it is PROVABLY cross-iteration — its
 * plan is KNOWN (present in `state.plans`), carries a NON-EMPTY `iterationRefs`,
 * and NONE of those refs are in the current-iteration id set. Everything else
 * is kept: plan-less dispatches (`planId === null`), dispatches whose plan is
 * unknown to the registry, and dispatches whose plan has EMPTY `iterationRefs`
 * (standalone / current work) — never hidden, because there is no
 * cross-iteration signal to filter on. Total function, never throws.
 */
function isCurrentIterationDispatch(
  planId: string | null,
  planRefs: ReadonlyMap<string, readonly string[]>,
  currentIds: ReadonlySet<string>,
): boolean {
  if (planId === null) return true
  const refs = planRefs.get(planId)
  if (refs === undefined || refs.length === 0) return true
  return refs.some((it) => currentIds.has(it))
}

/**
 * `projectAgents(source, currentStep): AgentZoneView` — the agents zone (spec
 * §4 + §6.2). `currentStep` is the ITERATION's current step (1-based into
 * PHASE_IDS, null when inactive — already computed by `projectGraph`, spec
 * §3): it drives each entity's `emphasis` tier (plan
 * 20260812-panel-f5-design-system Task 4 — design doc §3.3; `null` → every
 * entity `emphasis: null`, no override).
 * Total function: NEVER throws and NEVER fabricates values:
 *
 * - `state.agentFlow` null/unreadable → `degraded`: the FULL KNOWN_AGENTS
 *   roster as idle entities + skeleton (executing 0, pending 0 — never a
 *   guessed count; the roster is never hidden);
 * - a MISSING ledger file reads as the server's empty view → present with 0
 *   events → `empty`: full idle roster + pending skeleton (every expected
 *   role is pending);
 * - otherwise: entities aggregated from dispatch rows (with `idle: false`),
 *   statuses via the shared pairing walk, the un-evidenced KNOWN_AGENTS
 *   members appended as idle cards, actual/supervise edges (design doc §2.2 —
 *   the `expected` skeleton and `next` animation edges are REMOVED by plan
 *   20260812-panel-f5-design-system Task 5), and the
 *   executing (running entities — idle never counts) / pending
 *   (un-evidenced stage roles) counts.
 *
 * Entity-key invariant (F-001 — qc1/qc2 Warning): the concatenated key space
 * (evidence keys ∪ idle role ids) is UNIQUE by construction — `idleEntities`
 * suppresses a known role's idle card when its id already exists as an
 * evidence-derived entity key (a NON-roster dispatch produces a lit `general`
 * key while the roster `general` id stays un-evidenced — the twin is
 * suppressed via `litKeys`), so the render layer's `key`/`cards.set` never
 * collide.
 *
 * Canvas note (F-002 — qc1 Warning): `note` classifies the readable ledger in
 * the projection ('empty' / 'settle-only' / null — see `AgentZoneNote`); the
 * UI consumes it directly and never infers settle-only from the entity list
 * (garbage rows would fake it).
 *
 * Phase-2 plan note (plan 20260812-panel-f5-design-system Task 8 — user
 * 2026-08-12 feedback #2): `activePlanId` / `activePlanCount` ride the
 * `state.plans[]` InProgress rows (catalog order) — the Phase 2 group label
 * annotates the current plan; degraded/empty branches include the note too
 * (it is a state.plans annotation, independent of the ledger evidence).
 */
export function projectAgents(source: MstarEngineStatusSource | null, currentStep: number | null): AgentZoneView {
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

  // The Phase-2 current-plan annotation (plan 20260812-panel-f5-design-system
  // Task 8 — design doc §1.2, user 2026-08-12 feedback #2): the
  // `state.plans[]` rows with status 'InProgress' (catalog order).
  // `activePlanId` = the FIRST one; `activePlanCount` = all of them (the
  // render shows `+N more` when several plans run in parallel — honest,
  // never hides the rest behind the first id). Total function: state /
  // plans missing or no InProgress row → null / 0 (never fabricated).
  const rawPlans = state == null ? undefined : (state as { plans?: unknown }).plans
  const activePlans = Array.isArray(rawPlans)
    ? rawPlans
        .map((p) => ({ id: str((p as { id?: unknown })?.id), status: str((p as { status?: unknown })?.status) }))
        .filter((p) => p.status === 'InProgress' && p.id !== '')
        .map((p) => p.id)
    : []
  const activePlanId = activePlans[0] ?? null
  const activePlanCount = activePlans.length

  if (rawEvents === null || !Array.isArray(rawEvents)) {
    // No ledger evidence at all → every known agent is idle (spec §6.2);
    // `note` is null — the `degraded` flag IS the note for this branch. The
    // supervise edge still exists (STATIC design knowledge), dimmed
    // (evidenced false — no evidence to light it). The Phase-2 plan note
    // still renders (it is a state.plans annotation, independent of the
    // ledger evidence).
    return {
      stages, degraded: true, empty: false, note: null,
      entities: idleEntities(new Set(), new Set(), currentStep),
      edges: superviseEdges(stages, []), executing: 0, pending: 0,
      activePlanId, activePlanCount,
    }
  }

  const entries = classifyFlowRows(rawEvents)
  const empty = rawEvents.length === 0
  // F-002: the canvas note is a PROJECTION decision on the raw ledger (the UI
  // never infers ledger semantics from the entity list): 0 events → 'empty';
  // events but NO dispatch row (all settle / garbage) → 'settle-only';
  // any dispatch row (anonymous included — it IS dispatch evidence) → null.
  const note: AgentZoneNote = empty ? 'empty' : entries.some((e) => e.view.kind === 'dispatch') ? null : 'settle-only'

  // The「当前迭代」filter (plan 20260813-panel-quick-fixes Task 2): entities
  // and actual edges derive ONLY from the current iteration's dispatch rows.
  // Settle rows are always kept (they carry the pairing identity); a dispatch
  // row survives unless it is PROVABLY cross-iteration (see
  // `isCurrentIterationDispatch`). A cross-iteration plan's events therefore
  // produce no entity/edge (the roster falls back to idle). `note`/`empty`/
  // `degraded` stay computed from the RAW ledger above — the event-log tab
  // (projectFlowEvents) is unfiltered too.
  const iterationRow = source == null ? null : (source as { iteration?: unknown }).iteration
  const iterationId = iterationRow === null || iterationRow === undefined
    ? null
    : str((iterationRow as { iterationId?: unknown }).iterationId)
  const planRows: PlanRow[] = Array.isArray(rawPlans) ? rawPlans.map(planRow) : []
  const planRefs = new Map<string, readonly string[]>()
  for (const plan of planRows) planRefs.set(plan.id, plan.iterationRefs)
  const currentIds = currentIterationIds(iterationId, planRows)
  const filtered = entries.filter((e) =>
    e.view.kind === 'settle' || isCurrentIterationDispatch(e.view.planId, planRefs, currentIds),
  )

  // Evidence (spec §4): a stage is evidenced when any dispatch row's role maps
  // to it (roles are unique across stages, so this equals literal role
  // membership). Counted from the FILTERED dispatch rows (plan
  // 20260813-panel-quick-fixes Task 2 — a cross-iteration dispatch lights no
  // stage) — a session re-dispatched under several roles lights EACH role's
  // stage (per-role aggregation). The same set drives the per-stage `evidenced`
  // flag (the render's pending-placeholder decision) and the `pending` count —
  // no drift.
  const evidenced = new Set<string>()
  // Role evidence (spec §6.2): the roles with ANY filtered dispatch row — drives
  // the idle-roster suppression (a known agent with current-iteration dispatch
  // evidence is never ALSO shown idle; garbage rows degrade to role '' and never
  // match).
  const evidencedRoles = new Set<string>()
  for (const e of filtered) {
    if (e.view.kind !== 'dispatch') continue
    if (e.view.stage !== null) evidenced.add(`${e.view.stage.phase}:${e.view.stage.stage}`)
    if (e.view.role !== '') evidencedRoles.add(e.view.role)
  }
  for (const s of stages) s.evidenced = evidenced.has(s.id)

  // Shared settle→dispatch pairing (one walk, spec §4 + plan
  // `20260811-panel-f4-timeliness` Task 1): the settle status per paired
  // dispatch index; entity status looks up its latest dispatch's pair. The
  // pairing key is the EXACT identity (agent, role, planId, taskId) a paired
  // settle carries — `view.status` already carries settleStatus(outcome) for
  // settle rows, so the record values are the settle statuses directly.
  const pairStatus = pairSettleStatus(
    filtered.map((e) => ({
      kind: e.view.kind,
      agent: e.view.agent,
      role: e.view.role,
      planId: e.view.planId,
      taskId: e.view.taskId,
      ...(e.view.paired === true ? { paired: true as const } : {}),
      status: e.view.status,
    })),
  )

  const lit = aggregateEntities(filtered, pairStatus, currentStep)
  // F-001: the evidence-derived key set drives the idle-twin suppression —
  // a lit `general` key (from any non-roster dispatch) never coexists with the
  // idle roster `general` card.
  const litKeys = new Set(lit.map((e) => e.key))
  const entities = [...lit, ...idleEntities(evidencedRoles, litKeys, currentStep)]
  // Task 5 line set (design doc §2.2): actual (filtered handoffs) + supervise
  // (static design knowledge). `expected` skeleton / `next` animation edges
  // are REMOVED — 简洁化 (user 2026-08-12 feedback #1/#5). The actual edges
  // derive from the FILTERED rows (plan 20260813-panel-quick-fixes Task 2);
  // the supervise line stays UNCHANGED (raw rows — its evidence-driven lighting
  // is sub-bucket presence, independent of the iteration filter).
  const edges = [
    ...actualEdges(filtered),
    ...superviseEdges(stages, entries),
  ]

  const executing = entities.filter((e) => e.status === 'running').length
  // Pending = expected roles of stages with NO dispatch evidence (spec §4).
  const pending = stages.reduce((sum, s) => sum + (evidenced.has(s.id) ? 0 : s.roles.length), 0)

  return { stages, degraded: false, empty, note, entities, edges, executing, pending, activePlanId, activePlanCount }
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
    paired?: unknown
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
    // Paired-identity presence (settle rows only — the exact-pairing marker,
    // plan `20260811-panel-f4-timeliness` Task 1).
    ...(kind === 'settle' && row?.paired === true ? { paired: true } : {}),
    durationMs: count(row?.durationMs),
  }
}

/** One row of the pairing walk — the identity a PAIRED settle carries (plan
 * `20260811-panel-f4-timeliness` Task 1, spec R1: exact identity pairing,
 * never owner+time guessing). */
interface PairingRow {
  kind: 'dispatch' | 'settle'
  agent: string | null
  role?: string
  planId?: string | null
  taskId?: string | null
  /** Settle rows only: true → the settle carries the paired dispatch's identity (exact pairing). */
  paired?: boolean
  status?: FlowEventStatus
}

/** The exact pairing key: `(agent, role, planId, taskId)` — the settle identity matches the dispatch identity field-for-field. */
function pairingKeyOf(row: PairingRow): string {
  return [row.agent ?? '', row.role ?? '', row.planId ?? '', row.taskId ?? ''].join('\u0000')
}

/**
 * Shared settle→dispatch pairing walk (spec §4 — the ONE implementation
 * behind BOTH the events projection (`settled` marker, via
 * `pairSettleIndexes`) and the agent-entity status derivation (via the
 * returned settle status per paired dispatch index) — no heuristic drift).
 * Input rows are in FILE order (the catalog is latest-first, so the pairing
 * walks reversed) keeping the most recent same-identity dispatch; each
 * PAIRED settle (`paired === true`) pairs with it. Pairing key = the EXACT
 * `(agent, role, planId, taskId)` identity (plan
 * `20260811-panel-f4-timeliness` Task 1 — upgraded from the old
 * most-recent-same-AGENT guess: under QC tri N=3 concurrent dispatches from
 * one session all three settles used to land on the latest dispatch; the
 * identity key lets each settle land on ITS dispatch). A settle WITHOUT
 * identity (legacy rows / unpaired) stays independent — NO fallback guessing
 * (honest, spec R1); a settle with no prior same-identity dispatch (agent
 * null, truncated window, missed record) stays independent too. Output:
 * paired dispatch index → the settle's status (`entry.status` for settle
 * rows — the events path omits it, defaulting to `ok`, and only the keys
 * matter there).
 */
function pairSettleStatus(rows: readonly PairingRow[]): Map<number, FlowEventStatus> {
  const record = new Map<number, FlowEventStatus>()
  const lastDispatch = new Map<string, number>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = rows[i]!
    if (entry.kind === 'dispatch') {
      if (entry.agent !== null) lastDispatch.set(pairingKeyOf(entry), i)
    } else if (entry.paired === true && entry.agent !== null) {
      const paired = lastDispatch.get(pairingKeyOf(entry))
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
export function pairSettleIndexes(rows: readonly PairingRow[]): ReadonlySet<number> {
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
 * - settled: EXACT identity pairing via `pairSettleIndexes` (the same walk the
 *   agent-entity status derivation uses; an unpaired settle stays unpaired —
 *   honest). The panel never depends on the pairing's correctness;
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
  // behind the events projection and the entity status derivation; the
  // identity-based key is plan `20260811-panel-f4-timeliness` Task 1).
  for (const i of pairSettleIndexes(entries.map((e) => ({
    kind: e.view.kind,
    agent: e.view.agent,
    role: e.view.role,
    planId: e.view.planId,
    taskId: e.view.taskId,
    ...(e.view.paired === true ? { paired: true as const } : {}),
  })))) {
    entries[i]!.view.settled = true
  }

  const events = entries.map((e) => e.view) // latest-first preserved
  const unexpected = entries
    .filter((e) => e.view.kind === 'dispatch' && !e.view.expected)
    .map((e) => e.view)
  return { events, unexpected }
}
