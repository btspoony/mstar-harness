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
 * Known limitation (spec §2.3): Phase 1/5 nodes never light as current and
 * the loop edge is planning-only — the engine gate emits only Phase 2→3→4.
 */

import type { MstarEngineStatusSource } from '../../../types.ts'
import { bool, str } from '../guards.ts'
import {
  PHASE_EDGES, PHASE_IDS, PLAN_STATE_EDGES, PLAN_STATE_IDS, TRANSITION_TO_PHASE,
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
    const phaseId = transition === null ? undefined : TRANSITION_TO_PHASE[transition]
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
    degraded,
  }
}
