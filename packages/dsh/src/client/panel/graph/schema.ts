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
