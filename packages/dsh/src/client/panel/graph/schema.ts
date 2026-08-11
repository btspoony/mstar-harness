/**
 * Graph schema constants (spec panel-layout-graph §2.0): the workflow loop
 * (phase ring — mstar-iteration Phase 1–5) and the per-plan status machine
 * (mstar-plan-artifacts) are CLIENT-SIDE DESIGN KNOWLEDGE. They are written
 * once here with their provenance and STRICTLY SEPARATED from catalog
 * evidence (`iteration.gate.transition` / `state.plans[].status`), which
 * `projectGraph` projects onto this skeleton.
 *
 * Known limitation (spec §2.3 — a documented constraint, not a defect): the
 * engine phase gate only evaluates Phase 2→3→4, so the catalog never emits
 * `iteration-start` / `merge-ready` as current — those nodes stay idle. The
 * loop edge is planning semantics (one iteration closes, the next begins).
 */

/** Phase ring node ids in loop order (spec §2.3). */
export const PHASE_IDS = [
  'iteration-start',
  'autonomous-execute',
  'iteration-close',
  'pr-delivery',
  'merge-ready',
] as const
export type PhaseId = (typeof PHASE_IDS)[number]

/** Plan state machine bucket ids (spec §2.4): 5 known states + the `unknown` catch-all. */
export const PLAN_STATE_IDS = ['Todo', 'InProgress', 'InReview', 'Done', 'Blocked', 'unknown'] as const
export type PlanStateId = (typeof PLAN_STATE_IDS)[number]

export interface PhaseEdge {
  source: PhaseId
  target: PhaseId
  kind: 'forward' | 'loop'
}

/** Phase ring edges: forward start→…→merge-ready, plus the loop merge-ready→start (spec §2.3). */
export const PHASE_EDGES: PhaseEdge[] = [
  { source: 'iteration-start', target: 'autonomous-execute', kind: 'forward' },
  { source: 'autonomous-execute', target: 'iteration-close', kind: 'forward' },
  { source: 'iteration-close', target: 'pr-delivery', kind: 'forward' },
  { source: 'pr-delivery', target: 'merge-ready', kind: 'forward' },
  { source: 'merge-ready', target: 'iteration-start', kind: 'loop' },
]

/** Plan state machine edges (spec §2.4): `Done` and `unknown` are terminal (no out-edges). */
export const PLAN_STATE_EDGES: { source: PlanStateId; target: PlanStateId }[] = [
  { source: 'Todo', target: 'InProgress' },
  { source: 'InProgress', target: 'InReview' },
  { source: 'InProgress', target: 'Blocked' },
  { source: 'InReview', target: 'Done' },
  { source: 'Blocked', target: 'InProgress' },
]

/** `gate.transition` → phase id (spec §2.3): the engine emits only these three. */
export const TRANSITION_TO_PHASE: Readonly<Record<string, PhaseId>> = {
  'phase-2-execute': 'autonomous-execute',
  'phase-3-close': 'iteration-close',
  'phase-4-pr-delivery': 'pr-delivery',
}

/**
 * Expected role pipeline (spec agent-flow-catalog-graph §2.3): WHO is expected
 * to be dispatched in each iteration phase. Like the phase ring / plan state
 * machine above, this is CLIENT-SIDE DESIGN KNOWLEDGE — written once with its
 * provenance and STRICTLY SEPARATED from catalog evidence: `projectGraph`'s
 * flow projection lights this skeleton with `state.agentFlow` dispatch events
 * (stage lit/count) and flags events whose role is NOT in this union
 * (unexpected — e.g. `general` / `scout` or unregistered roles).
 *
 * Provenance (mstar role vocabulary — exact strings, dispatch order):
 * - review-edit-chain: product-manager → architect → writing-specialist —
 *   the mstar-iteration §1.6 Review & Edit chain (Prepare-phase design
 *   review, Phase 1).
 * - sdd-implement: fullstack-dev / fullstack-dev-2 / frontend-dev — the
 *   mstar-sdd implementer roles (Phase 2 task execution).
 * - qc-tri: qc-specialist ×3 — the mstar-sdd plan QC triage (Phase 2).
 * - qa-gate: qa-engineer — the QA gate (Phase 2 closing — the pipeline
 *   TERMINAL stage; ops-engineer is NOT in the pipeline).
 * - Phase 3–5 (iteration-close / pr-delivery / merge-ready) dispatch no
 *   routine subagents → no stages (spec §2.3).
 *
 * Off-pipeline roles (plan 20260811-panel-f3-agent-general) live in the
 * KNOWN_AGENTS roster with `zone` markers, NOT here: `ops-engineer` and
 * `prompt-engineer` are on-demand dispatches (mstar-roles routing table,
 * as needed) rendered in their own on-demand column; the SDD per-task
 * reviewer (the former `sdd-task-review` stage / `generalPurpose` role —
 * mstar-sdd L2 reviewer) moved OFF the pipeline into the single `general`
 * bucket (plan 20260811-panel-f3-agent-general — user decision), which also
 * collects every unmatched / anonymous dispatch (role ''). The SDD
 * implement ↔ review loop (mstar-sdd: implement → task review → rework →
 * re-implement) is a skeleton EDGE (sdd-implement → general back-edge), not
 * a stage.
 *
 * Matching rules (spec §2.3 — implemented by `projectGraph`'s flow
 * projection): `expected` ⟺ `event.role` ∈ the union of ALL `roles` below
 * (EXACT string — `qc-specialist-2` never folds into `qc-specialist`); a role
 * listed in several stages matches the FIRST stage in this constant order;
 * `unexpected` ⟺ role ∉ union. Settle rows carry no role (T1 sets ''), so
 * they never match a stage.
 */
export interface ExpectedRoleStage {
  /** The iteration phase this pipeline stage belongs to (PhaseId union). */
  phase: PhaseId
  /** Pipeline-stage id — the render + match key (`${phase}:${stage}`). */
  stage: string
  /** Expected role ids in dispatch order (mstar-roles / mstar-sdd vocabulary). */
  roles: readonly string[]
}

/** Expected role pipeline skeleton: 4 stages (spec agent-flow-catalog-graph §2.3,
 * plan 20260811-panel-f3-agent-general — sdd-task-review removed, the SDD L2
 * reviewer moved off-pipeline into the `general` bucket; qa-gate is the
 * terminal stage). */
export const EXPECTED_ROLE_FLOW: readonly ExpectedRoleStage[] = [
  { phase: 'iteration-start',    stage: 'review-edit-chain', roles: ['product-manager', 'architect', 'writing-specialist'] },
  { phase: 'autonomous-execute', stage: 'sdd-implement',     roles: ['fullstack-dev', 'fullstack-dev-2', 'frontend-dev'] },
  { phase: 'autonomous-execute', stage: 'qc-tri',            roles: ['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'] },
  { phase: 'autonomous-execute', stage: 'qa-gate',           roles: ['qa-engineer'] },
]

/**
 * The known-agent roster (spec §4 / §6.2 / decision point D3 + plan
 * 20260811-panel-f3-agent-general): the static FULL set of ASSIGNABLE roles
 * the panel may ever show — every EXPECTED_ROLE_FLOW role PLUS the
 * off-pipeline roles `prompt-engineer` (in the mstar-roles table but not in
 * the pipeline) and `ops-engineer` (on-demand ops dispatch), PLUS `general`
 * (the single general bucket — see below). Exactly 13 roles.
 *
 * `explore` is DELIBERATELY NOT in the roster (plan
 * 20260811-panel-f3-agent-general — user F3 feedback): it is a scouting
 * adjunct role with no standalone presentation value, so it is removed from
 * the canvas (a stray `explore` dispatch still folds into the `general`
 * bucket — it is not a KNOWN_AGENTS id).
 *
 * `project-manager` is deliberately NOT in the roster (plan
 * 20260811-panel-f2-quickfix Item 2 — user F2 feedback): it is the PRIMARY
 * orchestration agent (mstar-roles mapping `mode: primary`), the seat that
 * DISPATCHES subagents — never an assignable subagent itself, so it must
 * not appear as a dispatchable entity in the 代理执行 tab.
 *
 * The panel NEVER hides a known agent: every member without dispatch
 * evidence projects as an `idle` entity (spec §6.2 — degraded/empty
 * branches included). `stage` = the role's stage in EXPECTED_ROLE_FLOW
 * (first constant-order match); null for the off-pipeline roles, which
 * carry an explicit `zone` — `on-demand` (ops-engineer / prompt-engineer,
 * their own canvas column) or `general` (the general bucket = the SDD
 * per-task reviewer — the former `generalPurpose` role — plus ANY
 * unmatched / anonymous dispatch (role '') in the projection).
 */
/** The general-bucket id (plan 20260811-panel-f3-agent-general): the single
 * bucket every off-roster / anonymous dispatch folds into — the SDD per-task
 * reviewer (the former `generalPurpose` role) plus ANY unmatched / anonymous
 * dispatch (role '') in the projection. Single source for the value:
 * `entityKeyOf`'s fallback key, the `expectedEdges` SDD-loop target,
 * `roleZone` / `idleZone` defaults, the render's `GENERAL_COLUMN` and the
 * KNOWN_AGENTS roster id ALL derive from it — renaming the bucket changes
 * exactly one constant. The `'general'` literal in the `AgentZone` /
 * `KnownAgent.zone` unions below is the type-level binding (a union member
 * cannot reference a value) — keep them in sync with this constant. */
export const GENERAL_BUCKET = 'general' as const

export type AgentZone = 'flow' | 'on-demand' | 'general'

export interface KnownAgent {
  /** Role id — the entity key and the default card title (render may localize). */
  id: string
  /** Optional display label; render falls back to `id` when absent. */
  displayName?: string
  /** The role's EXPECTED_ROLE_FLOW stage; null → off-pipeline role. */
  stage?: { phase: PhaseId; stage: string } | null
  /** Off-pipeline zone (plan 20260811-panel-f3-agent-general): 'on-demand'
   * for the on-demand column, 'general' (the default when omitted) for the
   * general bucket. The `'general'` literal is the type-level binding of
   * `GENERAL_BUCKET` (see above) — a union member cannot reference a value. */
  zone?: 'on-demand' | 'general'
}

/** Known-agent roster — 13 roles, spec §4 order (project-manager + explore excluded). */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: 'product-manager', stage: { phase: 'iteration-start', stage: 'review-edit-chain' } },
  { id: 'architect', stage: { phase: 'iteration-start', stage: 'review-edit-chain' } },
  { id: 'fullstack-dev', stage: { phase: 'autonomous-execute', stage: 'sdd-implement' } },
  { id: 'fullstack-dev-2', stage: { phase: 'autonomous-execute', stage: 'sdd-implement' } },
  { id: 'frontend-dev', stage: { phase: 'autonomous-execute', stage: 'sdd-implement' } },
  { id: 'qa-engineer', stage: { phase: 'autonomous-execute', stage: 'qa-gate' } },
  { id: 'qc-specialist', stage: { phase: 'autonomous-execute', stage: 'qc-tri' } },
  { id: 'qc-specialist-2', stage: { phase: 'autonomous-execute', stage: 'qc-tri' } },
  { id: 'qc-specialist-3', stage: { phase: 'autonomous-execute', stage: 'qc-tri' } },
  { id: 'ops-engineer', stage: null, zone: 'on-demand' },
  { id: 'writing-specialist', stage: { phase: 'iteration-start', stage: 'review-edit-chain' } },
  { id: 'prompt-engineer', stage: null, zone: 'on-demand' },
  { id: GENERAL_BUCKET, stage: null, zone: GENERAL_BUCKET },
]
