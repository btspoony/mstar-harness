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
 * (unexpected — e.g. `general` / `explore` / `scout` or unregistered roles).
 *
 * Provenance (mstar role vocabulary — exact strings, dispatch order):
 * - review-edit-chain: product-manager → architect → writing-specialist —
 *   the mstar-iteration §1.6 Review & Edit chain (Prepare-phase design
 *   review, Phase 1).
 * - sdd-implement: fullstack-dev / fullstack-dev-2 / frontend-dev — the
 *   mstar-sdd implementer roles (Phase 2 task execution).
 * - sdd-task-review: generalPurpose — the mstar-sdd L2 task reviewer
 *   (SKILL.md step 6); NOT qc-specialist*.
 * - qc-tri: qc-specialist ×3 — the mstar-sdd plan QC triage (Phase 2).
 * - qa-gate: qa-engineer — the QA gate (Phase 2 closing).
 * - ops-on-demand: ops-engineer — on-demand ops dispatch (mstar-roles
 *   routing table), Phase 2 only, as needed.
 * - Phase 3–5 (iteration-close / pr-delivery / merge-ready) dispatch no
 *   routine subagents → no stages (spec §2.3).
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

/** Expected role pipeline skeleton: 6 stages (spec agent-flow-catalog-graph §2.3). */
export const EXPECTED_ROLE_FLOW: readonly ExpectedRoleStage[] = [
  { phase: 'iteration-start',    stage: 'review-edit-chain', roles: ['product-manager', 'architect', 'writing-specialist'] },
  { phase: 'autonomous-execute', stage: 'sdd-implement',     roles: ['fullstack-dev', 'fullstack-dev-2', 'frontend-dev'] },
  { phase: 'autonomous-execute', stage: 'sdd-task-review',   roles: ['generalPurpose'] },
  { phase: 'autonomous-execute', stage: 'qc-tri',            roles: ['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'] },
  { phase: 'autonomous-execute', stage: 'qa-gate',           roles: ['qa-engineer'] },
  { phase: 'autonomous-execute', stage: 'ops-on-demand',     roles: ['ops-engineer'] },
]
