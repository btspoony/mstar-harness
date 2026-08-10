/**
 * Pure projection tests for `projectGraph` (spec panel-layout-graph §2.1–§2.5
 * + agent-flow-catalog-graph §2.3/§2.4): the total function maps an
 * `mstar-engine-status` catalog source to a `GraphView` — phase ring (schema
 * constants + `gate.transition` evidence), plan state machine (schema
 * constants + `state.plans[].status` evidence), current-phase highlight +
 * next edge, PASS/FAIL verdict + violation count, the connector (current
 * phase → most-populated lit non-Done/Blocked bucket, machine-order
 * tie-break), and the flow section (`state.agentFlow` evidence projected onto
 * the `EXPECTED_ROLE_FLOW` skeleton: stage lit/count, latest-first events
 * ≤50, unexpected off-pipeline-role dispatches, status coloring, the
 * best-effort settle→dispatch pairing, degraded/empty flags).
 *
 * Degradation contract (AC-3, §2.5): missing/illegal fields set the matching
 * `degraded` flag and render as `unknown`/idle — the function NEVER throws and
 * NEVER fabricates values; Phase 1/5 nodes and the loop edge are schema-only
 * (the engine gate never emits those transitions — a known limitation, not a
 * defect, spec §2.3).
 *
 * No React / ReactFlow imports — the projection is DOM-free and fully
 * unit-testable (spec §2.1).
 */

import { describe, expect, it } from 'bun:test'
import type { MstarEngineStatusSource } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { projectGraph } from '../src/client/panel/graph/project-graph'
import {
  EXPECTED_ROLE_FLOW, PHASE_EDGES, PLAN_STATE_EDGES,
  type PhaseId, type PlanStateId,
} from '../src/client/panel/graph/schema'

/** Full fixture: every evidence field populated (spec §2.1–§2.4). */
const fullSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' as EnforcementSource },
  iteration: {
    iterationId: 'iter-20260809-mstar-panel-beautify',
    statusPath: '/proj/.mstar/status.json',
    compassPath: '/proj/.mstar/iterations/iter-20260809-mstar-panel-beautify/delivery-compass.md',
    gate: {
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: true, violations: [] },
      exit: { ok: true, violations: [] },
      violations: [
        { severity: 'medium', code: 'PLAN-3', message: 'plan not complete' },
        { severity: 'low', code: 'EXIT-1', message: 'compass wording drift' },
      ],
    },
  },
  state: {
    plans: [
      { id: 'plan-a', status: 'Todo', doneAt: null },
      { id: 'plan-b', status: 'InProgress', doneAt: null },
      { id: 'plan-c', status: 'Done', doneAt: '2026-08-08' },
      { id: 'plan-d', status: 'Blocked', doneAt: null },
      { id: 'plan-e', status: 'custom-stalled', doneAt: null },
    ],
    residuals: [],
    residualFindings: null,
    iterationBaseBranch: 'dev-dsh',
    targetBranch: 'dev-dsh',
    specIntegrationBranch: 'iteration/iter-20260809-mstar-panel-beautify',
    pushPolicy: 'push authorized',
    worktreeMode: 'feature-worktree',
    controlWorktreePath: '/proj',
    leases: [],
    knowledge: null,
    direction: null,
    agentFlow: null,
  },
}

/** A source with a single InProgress plan → unambiguous connector target. */
const focusedSource: MstarEngineStatusSource = {
  ...fullSource,
  state: {
    ...fullSource.state!,
    plans: [{ id: 'plan-b', status: 'InProgress', doneAt: null }],
  },
}

/** Transition at Phase 4 → current=pr-delivery, next=merge-ready (Phase 5 as NEXT is legal). */
const prDeliverySource: MstarEngineStatusSource = {
  ...fullSource,
  iteration: {
    ...fullSource.iteration!,
    gate: { ...fullSource.iteration!.gate, transition: 'phase-4-pr-delivery' },
  },
}

/** `state` null + no iteration ⇒ the no-harness predicate, but projection stays total. */
const noHarnessSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

describe('projectGraph — phase ring (spec §2.3)', () => {
  const view = projectGraph(fullSource)

  it('emits the fixed 5-node ring in loop order with schema edges', () => {
    const ids = view.phases.map((p) => p.id)
    expect(ids).toEqual([
      'iteration-start', 'autonomous-execute', 'iteration-close', 'pr-delivery', 'merge-ready',
    ])
    expect(view.phaseEdges).toEqual(PHASE_EDGES)
    // The loop edge is the "cycle": merge-ready → iteration-start, kind loop.
    expect(PHASE_EDGES).toContainEqual({ source: 'merge-ready', target: 'iteration-start', kind: 'loop' })
    expect(PHASE_EDGES.filter((e) => e.kind === 'forward')).toHaveLength(4)
    expect(PHASE_EDGES.filter((e) => e.kind === 'loop')).toHaveLength(1)
  })

  it('lights the transition phase as current and its forward target as next', () => {
    const byId = new Map(view.phases.map((p) => [p.id, p]))
    expect(byId.get('autonomous-execute')!.state).toBe('current')
    expect(byId.get('iteration-close')!.state).toBe('next')
    // Schema-only nodes stay idle — never lit by the gate (Phase 1/5 known limitation).
    expect(byId.get('iteration-start')!.state).toBe('idle')
    expect(byId.get('pr-delivery')!.state).toBe('idle')
    expect(byId.get('merge-ready')!.state).toBe('idle')
    expect(view.currentPhase).toBe('autonomous-execute')
  })

  it('projects gate.ok/violations onto the CURRENT node only (PASS + count)', () => {
    const current = view.phases.find((p) => p.state === 'current')!
    expect(current.verdict).toBe('pass')
    expect(current.violationCount).toBe(2)
    // Other nodes carry no verdict/count.
    for (const phase of view.phases) {
      if (phase.state !== 'current') {
        expect(phase.verdict).toBe('unknown')
        expect(phase.violationCount).toBeNull()
      }
    }
  })

  it('carries the iteration id and no degradation on a full source', () => {
    expect(view.iterationId).toBe('iter-20260809-mstar-panel-beautify')
    expect(view.degraded).toEqual({ iteration: false, state: false, plans: false, transition: false })
  })

  it('Phase 4 transition → next lands on merge-ready (Phase 5 as next is legal, never current)', () => {
    const v = projectGraph(prDeliverySource)
    const byId = new Map(v.phases.map((p) => [p.id, p]))
    expect(byId.get('pr-delivery')!.state).toBe('current')
    expect(byId.get('merge-ready')!.state).toBe('next')
    expect(v.currentPhase).toBe('pr-delivery')
  })

  it('FAIL gate → current verdict fail with violation count', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: {
          ...fullSource.iteration!.gate,
          ok: false,
          violations: [
            { severity: 'high', code: 'EXIT-3', message: 'exit gate not satisfied' },
            { severity: 'low', code: 'EXIT-4', message: 'wording drift' },
            { severity: 'low', code: 'EXIT-5', message: 'more drift' },
          ],
        },
      },
    })
    const current = v.phases.find((p) => p.state === 'current')!
    expect(current.verdict).toBe('fail')
    expect(current.violationCount).toBe(3)
  })
})

describe('projectGraph — transition degradation (spec §2.3 / §2.5)', () => {
  it('missing transition → currentPhase null, ring all idle, degraded.transition (never guessed)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, transition: undefined },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    expect(v.currentPhase).toBeNull()
    expect(v.phases.every((p) => p.state === 'idle')).toBe(true)
    expect(v.degraded.transition).toBe(true)
  })

  it('illegal transition string → same unknown treatment', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, transition: 'phase-9-bogus' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    expect(v.currentPhase).toBeNull()
    expect(v.degraded.transition).toBe(true)
  })

  it('missing gate → same unknown treatment', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.currentPhase).toBeNull()
    expect(v.degraded.transition).toBe(true)
  })

  it('gate present but not an object → transition degraded, ring idle (never guessed)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: 42 },
    } as unknown as MstarEngineStatusSource)
    expect(v.currentPhase).toBeNull()
    expect(v.phases.every((p) => p.state === 'idle')).toBe(true)
    expect(v.degraded.transition).toBe(true)
  })

  it('gate.violations non-array → no violation count/list, verdict still from gate.ok', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, violations: 'nope' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    const current = v.phases.find((p) => p.state === 'current')!
    expect(current.verdict).toBe('pass')
    expect(current.violationCount).toBeNull()
    expect(v.violations).toEqual([])
    expect(v.degraded.transition).toBe(false)
  })

  it('iteration absent → ring idle + iteration/transition degraded, state machine unaffected', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: undefined,
    } as unknown as MstarEngineStatusSource)
    expect(v.iterationId).toBeNull()
    expect(v.currentPhase).toBeNull()
    expect(v.phases.every((p) => p.state === 'idle')).toBe(true)
    expect(v.degraded.iteration).toBe(true)
    expect(v.degraded.transition).toBe(true)
    expect(v.degraded.state).toBe(false)
    // Plans still project without an iteration.
    expect(v.planStates.find((s) => s.id === 'InProgress')!.lit).toBe(true)
  })

  it('non-boolean gate.ok → verdict unknown, count still from a real violations array', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, ok: 'yes' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    const current = v.phases.find((p) => p.state === 'current')!
    expect(current.verdict).toBe('unknown')
    expect(current.violationCount).toBe(2)
  })
})

describe('projectGraph — plan state machine (spec §2.4)', () => {
  const view = projectGraph(fullSource)

  it('emits the fixed 6 buckets (5 known + unknown) with schema edges', () => {
    const ids = view.planStates.map((s) => s.id)
    expect(ids).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'Blocked', 'unknown'])
    expect(view.planEdges).toEqual(PLAN_STATE_EDGES)
    // Done and unknown are terminal (no out-edges by schema).
    expect(PLAN_STATE_EDGES.some((e) => e.source === 'Done')).toBe(false)
    expect(PLAN_STATE_EDGES.some((e) => e.source === 'unknown')).toBe(false)
  })

  it('buckets each plan row by EXACT status match; any other string lands in unknown', () => {
    const byId = new Map(view.planStates.map((s) => [s.id, s]))
    expect(byId.get('Todo')!.plans).toEqual([{ id: 'plan-a', status: 'Todo' }])
    expect(byId.get('InProgress')!.plans).toEqual([{ id: 'plan-b', status: 'InProgress' }])
    expect(byId.get('Done')!.plans).toEqual([{ id: 'plan-c', status: 'Done' }])
    expect(byId.get('Blocked')!.plans).toEqual([{ id: 'plan-d', status: 'Blocked' }])
    expect(byId.get('InReview')!.plans).toEqual([])
    // Unknown bucket keeps the raw status string as-is (not translated, not guessed).
    expect(byId.get('unknown')!.plans).toEqual([{ id: 'plan-e', status: 'custom-stalled' }])
  })

  it('bucket lit = plans.length > 0; unknown rows render in the unknown bucket', () => {
    const byId = new Map(view.planStates.map((s) => [s.id, s]))
    expect(byId.get('Todo')!.lit).toBe(true)
    expect(byId.get('InProgress')!.lit).toBe(true)
    expect(byId.get('Done')!.lit).toBe(true)
    expect(byId.get('Blocked')!.lit).toBe(true)
    expect(byId.get('unknown')!.lit).toBe(true)
    expect(byId.get('InReview')!.lit).toBe(false)
  })

  it('state null → all buckets empty + degraded.state (+ plans, no rows to read)', () => {
    const v = projectGraph(noHarnessSource)
    expect(v.planStates.every((s) => s.plans.length === 0 && !s.lit)).toBe(true)
    expect(v.degraded.state).toBe(true)
    expect(v.degraded.plans).toBe(true)
  })

  it('state.plans missing/non-array → skeleton buckets + degraded.plans', () => {
    const v = projectGraph({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.planStates.every((s) => s.plans.length === 0)).toBe(true)
    expect(v.degraded.plans).toBe(true)
    expect(v.degraded.state).toBe(false)
  })

  it('non-string / missing plan status → unknown bucket, no fabricated status value', () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-x', status: 42 },
          { id: 'plan-y' },
          { id: 'plan-z', status: 'Done' },
        ],
      } as unknown as MstarEngineStatusSource['state'],
    })
    const unknown = v.planStates.find((s) => s.id === 'unknown')!
    expect(unknown.lit).toBe(true)
    // Raw non-string statuses degrade to an empty display string (never a guessed label).
    expect(unknown.plans).toEqual([
      { id: 'plan-x', status: '' },
      { id: 'plan-y', status: '' },
    ])
    expect(v.planStates.find((s) => s.id === 'Done')!.plans).toEqual([{ id: 'plan-z', status: 'Done' }])
  })
})

describe('projectGraph — connector (spec §2.4)', () => {
  it('points from the current phase to the most-populated lit non-Done/Blocked bucket', () => {
    const v = projectGraph(focusedSource)
    expect(v.connector).toEqual({ source: 'autonomous-execute', target: 'InProgress' })
  })

  it('tie → machine-order first lit bucket (Todo before InProgress before unknown)', () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-a', status: 'Todo', doneAt: null },
          { id: 'plan-b', status: 'InProgress', doneAt: null },
        ],
      },
    })
    expect(v.connector).toEqual({ source: 'autonomous-execute', target: 'Todo' })
  })

  it('Done/Blocked-only plans → no eligible bucket → connector null', () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'plan-c', status: 'Done', doneAt: null },
          { id: 'plan-d', status: 'Blocked', doneAt: null },
        ],
      },
    })
    expect(v.connector).toBeNull()
  })

  it('unknown bucket participates when it is the only lit non-Done/Blocked bucket', () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [{ id: 'plan-e', status: 'custom-stalled', doneAt: null }],
      },
    })
    expect(v.connector).toEqual({ source: 'autonomous-execute', target: 'unknown' })
  })

  it('no current phase → connector null even with lit buckets', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: { ...fullSource.iteration!.gate, transition: undefined } },
    } as unknown as MstarEngineStatusSource)
    expect(v.currentPhase).toBeNull()
    expect(v.connector).toBeNull()
  })
})

describe('projectGraph — totality (spec §2.1 / §2.5)', () => {
  it('source null → legal empty GraphView, everything degraded, never a throw', () => {
    const v = projectGraph(null)
    expect(v.phases).toHaveLength(5)
    expect(v.planStates).toHaveLength(6)
    expect(v.phases.every((p) => p.state === 'idle')).toBe(true)
    expect(v.planStates.every((s) => !s.lit)).toBe(true)
    expect(v.currentPhase).toBeNull()
    expect(v.connector).toBeNull()
    expect(v.iterationId).toBeNull()
    expect(v.degraded).toEqual({ iteration: true, state: true, plans: true, transition: true })
  })

  it('never throws on a structurally garbage source', () => {
    expect(() => projectGraph({ garbage: true } as unknown as MstarEngineStatusSource)).not.toThrow()
    expect(() => projectGraph({ iteration: 'not-an-object', state: 42 } as unknown as MstarEngineStatusSource)).not.toThrow()
    expect(() => projectGraph({ iteration: { gate: { transition: { deep: true } } } } as unknown as MstarEngineStatusSource)).not.toThrow()
  })

  it('prototype-key transitions (__proto__/constructor/toString/hasOwnProperty) degrade, never crash', () => {
    // Plain-object lookups hit Object.prototype inherited values (truthy) for these
    // keys — they must take the illegal-transition path, not the current-node path.
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const source = {
        ...fullSource,
        iteration: {
          ...fullSource.iteration!,
          gate: { ...fullSource.iteration!.gate, transition: key },
        },
      } as unknown as MstarEngineStatusSource
      expect(() => projectGraph(source)).not.toThrow()
      const v = projectGraph(source)
      expect(v.currentPhase).toBeNull()
      expect(v.phases.every((p) => p.state === 'idle')).toBe(true)
      expect(v.degraded.transition).toBe(true)
    }
  })

  it('iterationId missing → null, not a fabricated string', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, iterationId: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.iterationId).toBeNull()
  })
})

/** Compile-time pin: GraphView fields referenced by the render layer stay stable. */
describe('projectGraph — GraphView shape (spec §2.2)', () => {
  it('types phases/edges/states as the documented unions', () => {
    const view = projectGraph(fullSource)
    const phaseIds: PhaseId[] = view.phases.map((p) => p.id)
    const stateIds: PlanStateId[] = view.planStates.map((s) => s.id)
    expect(phaseIds).toContain('merge-ready')
    expect(stateIds).toContain('unknown')
  })
})

/* ---------------------------------------------------------------------------
 * Flow projection (spec agent-flow-catalog-graph §2.3/§2.4): `state.agentFlow`
 * evidence projected onto the EXPECTED_ROLE_FLOW skeleton — stage lit/count,
 * latest-first events (≤50), unexpected off-pipeline-role dispatches, status
 * coloring, the best-effort settle→dispatch pairing, and degraded/empty.
 * ------------------------------------------------------------------------- */

/** One dispatch row as the T1 ledger view emits it (spec §2.2). */
function dispatchRow(over: {
  ts: number
  role: string
  agent?: string
  planId?: string
  taskId?: string
  verdict?: 'ok' | 'advisory' | 'denied'
}): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'dispatch',
    agent: over.agent ?? null,
    role: over.role,
    planId: over.planId ?? null,
    taskId: over.taskId ?? null,
    taskCategory: null,
    ...(over.verdict !== undefined ? { verdict: over.verdict } : {}),
  }
}

/** One settle row as the T1 ledger view emits it (spec §2.2 — carries no role). */
function settleRow(over: {
  ts: number
  agent?: string
  outcome?: 'ok' | 'error' | 'denied'
  durationMs?: number
}): AgentFlowEventView {
  return {
    ts: over.ts,
    kind: 'settle',
    agent: over.agent ?? null,
    role: '',
    planId: null,
    taskId: null,
    taskCategory: null,
    ...(over.outcome !== undefined ? { outcome: over.outcome } : {}),
    ...(over.durationMs !== undefined ? { durationMs: over.durationMs } : {}),
  }
}

/** A full source whose `state.agentFlow` carries the given events (latest-first). */
function flowSource(events: readonly unknown[]): MstarEngineStatusSource {
  return {
    ...fullSource,
    state: {
      ...fullSource.state!,
      // The ledger view type is satisfied by the projection's guarded reads;
      // garbage rows are passed through the unknown-typed events array.
      agentFlow: { events, summary: [] } as unknown as AgentFlowView,
    },
  }
}

describe('projectGraph — EXPECTED_ROLE_FLOW schema (spec agent-flow-catalog-graph §2.3)', () => {
  it('is the fixed 6-stage pipeline with the spec\'d exact role vocabularies', () => {
    expect(EXPECTED_ROLE_FLOW).toHaveLength(6)
    expect(EXPECTED_ROLE_FLOW.map((s) => `${s.phase}:${s.stage}`)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ])
    expect(EXPECTED_ROLE_FLOW[0]!.roles).toEqual(['product-manager', 'architect', 'writing-specialist'])
    expect(EXPECTED_ROLE_FLOW[1]!.roles).toEqual(['fullstack-dev', 'fullstack-dev-2', 'frontend-dev'])
    // sdd-task-review = the mstar-sdd L2 reviewer role generalPurpose (NOT qc-specialist*).
    expect(EXPECTED_ROLE_FLOW[2]!.roles).toEqual(['generalPurpose'])
    expect(EXPECTED_ROLE_FLOW[3]!.roles).toEqual(['qc-specialist', 'qc-specialist-2', 'qc-specialist-3'])
    expect(EXPECTED_ROLE_FLOW[4]!.roles).toEqual(['qa-engineer'])
    expect(EXPECTED_ROLE_FLOW[5]!.roles).toEqual(['ops-engineer'])
    // Phase 3–5 have no stages (no routine subagent dispatch) — every stage
    // lives in Phase 1–2 (spec §2.3).
    for (const s of EXPECTED_ROLE_FLOW) {
      expect(['iteration-start', 'autonomous-execute']).toContain(s.phase)
    }
  })
})

describe('projectGraph — flow degraded/empty (spec agent-flow-catalog-graph §2.4)', () => {
  it('agentFlow null (ledger absent) → degraded skeleton, no events, nothing lit', () => {
    const flow = projectGraph(fullSource).flow
    expect(flow.degraded).toBe(true)
    expect(flow.empty).toBe(false)
    expect(flow.events).toEqual([])
    expect(flow.unexpected).toEqual([])
    expect(flow.stages).toHaveLength(6)
    expect(flow.stages.every((s) => !s.lit && s.count === 0)).toBe(true)
    expect(flow.stages.map((s) => s.id)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ])
  })

  it('source null / state null → same degraded marker (total function)', () => {
    expect(projectGraph(null).flow.degraded).toBe(true)
    expect(projectGraph(noHarnessSource).flow.degraded).toBe(true)
  })

  it('agentFlow empty view (0 events) → empty, NOT degraded (qc1 F-001 fix-wave: a MISSING ledger file now reads as this empty view — the panel shows the no-dispatches-yet state, recording starts at plan merge)', () => {
    const flow = projectGraph(flowSource([])).flow
    expect(flow.degraded).toBe(false)
    expect(flow.empty).toBe(true)
    expect(flow.events).toEqual([])
    expect(flow.stages.every((s) => !s.lit)).toBe(true)
  })

  it('unreadable agentFlow (non-object / events non-array) → degraded, never throws', () => {
    const project = (agentFlow: unknown) => projectGraph({
      ...fullSource,
      state: { ...fullSource.state!, agentFlow },
    } as unknown as MstarEngineStatusSource).flow
    for (const bad of [42, 'nope', [], { events: 'nope' }, { events: 42 }, { no: 'events' }]) {
      expect(() => project(bad)).not.toThrow()
      expect(project(bad).degraded).toBe(true)
      expect(project(bad).empty).toBe(false)
      expect(project(bad).events).toEqual([])
      expect(project(bad).stages.every((s) => !s.lit)).toBe(true)
    }
  })
})

describe('projectGraph — flow stage lighting (spec agent-flow-catalog-graph §2.3)', () => {
  it('each expected role lights its stage with count; exact stage mapping', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 6, role: 'frontend-dev' }),    // sdd-implement
      dispatchRow({ ts: 5, role: 'generalPurpose' }),  // sdd-task-review
      dispatchRow({ ts: 4, role: 'qc-specialist-2' }), // qc-tri (exact string)
      dispatchRow({ ts: 3, role: 'product-manager' }), // review-edit-chain
      dispatchRow({ ts: 2, role: 'qa-engineer' }),     // qa-gate
      dispatchRow({ ts: 1, role: 'ops-engineer' }),    // ops-on-demand
    ])).flow
    const byId = new Map(flow.stages.map((s) => [s.id, s]))
    for (const id of [
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ]) {
      expect(byId.get(id)!.lit).toBe(true)
      expect(byId.get(id)!.count).toBe(1)
    }
    const byRole = new Map(flow.events.map((e) => [e.role, e]))
    expect(byRole.get('frontend-dev')!.stage).toEqual({ phase: 'autonomous-execute', stage: 'sdd-implement' })
    expect(byRole.get('generalPurpose')!.stage).toEqual({ phase: 'autonomous-execute', stage: 'sdd-task-review' })
    expect(byRole.get('qc-specialist-2')!.stage).toEqual({ phase: 'autonomous-execute', stage: 'qc-tri' })
    expect(byRole.get('product-manager')!.stage).toEqual({ phase: 'iteration-start', stage: 'review-edit-chain' })
    expect(byRole.get('qa-engineer')!.stage).toEqual({ phase: 'autonomous-execute', stage: 'qa-gate' })
    expect(byRole.get('ops-engineer')!.stage).toEqual({ phase: 'autonomous-execute', stage: 'ops-on-demand' })
    expect(flow.events.every((e) => e.expected)).toBe(true)
    expect(flow.unexpected).toEqual([])
  })

  it('multiple dispatches of one role accumulate the stage count', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'fullstack-dev' }),
      dispatchRow({ ts: 2, role: 'fullstack-dev' }),
      dispatchRow({ ts: 1, role: 'frontend-dev' }),
    ])).flow
    const implement = flow.stages.find((s) => s.id === 'autonomous-execute:sdd-implement')!
    expect(implement.lit).toBe(true)
    expect(implement.count).toBe(3)
  })

  it('exact-string matching: qc-specialist-4 / fullstack-dev-9 are NOT folded → unexpected', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'qc-specialist-4' }),
      dispatchRow({ ts: 2, role: 'fullstack-dev-9' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev' }),
    ])).flow
    const qcTri = flow.stages.find((s) => s.id === 'autonomous-execute:qc-tri')!
    const implement = flow.stages.find((s) => s.id === 'autonomous-execute:sdd-implement')!
    expect(qcTri.lit).toBe(false)
    expect(qcTri.count).toBe(0)
    expect(implement.count).toBe(1)
    expect(flow.unexpected.map((e) => e.role)).toEqual(['qc-specialist-4', 'fullstack-dev-9'])
    const qc4 = flow.events.find((e) => e.role === 'qc-specialist-4')!
    expect(qc4.expected).toBe(false)
    expect(qc4.stage).toBeNull()
  })

  it('settle rows carry no role: they never light a stage, never flag unexpected', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'frontend-dev', agent: 'a1' }),
      settleRow({ ts: 2, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 1, role: 'scout' }), // off-pipeline dispatch → unexpected
    ])).flow
    const implement = flow.stages.find((s) => s.id === 'autonomous-execute:sdd-implement')!
    expect(implement.count).toBe(1) // settles never count toward a stage
    const settle = flow.events.find((e) => e.kind === 'settle')!
    expect(settle.role).toBe('')
    expect(settle.expected).toBe(false)
    expect(settle.stage).toBeNull()
    // unexpected = off-pipeline-role DISPATCHES only — settles never appear.
    expect(flow.unexpected.map((e) => e.role)).toEqual(['scout'])
  })

  it('a dispatch with a missing role (\'\') is unplaceable → unexpected', () => {
    const flow = projectGraph(flowSource([dispatchRow({ ts: 1, role: '' })])).flow
    expect(flow.events[0]!.expected).toBe(false)
    expect(flow.events[0]!.stage).toBeNull()
    expect(flow.unexpected.map((e) => e.role)).toEqual([''])
  })
})

describe('projectGraph — flow status coloring (spec agent-flow-catalog-graph §2.4)', () => {
  it('dispatch verdict → dispatched|advisory|denied; settle outcome → ok|error|denied', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 6, role: 'fullstack-dev', verdict: 'ok' }),
      dispatchRow({ ts: 5, role: 'fullstack-dev', verdict: 'advisory' }),
      dispatchRow({ ts: 4, role: 'fullstack-dev', verdict: 'denied' }),
      settleRow({ ts: 3, outcome: 'ok' }),
      settleRow({ ts: 2, outcome: 'error' }),
      settleRow({ ts: 1, outcome: 'denied' }),
    ])).flow
    expect(flow.events.map((e) => e.status)).toEqual(['dispatched', 'advisory', 'denied', 'ok', 'error', 'denied'])
  })

  it('missing/illegal verdict or outcome degrades to the kind base (never a guessed error/denied)', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 4, role: 'fullstack-dev' }), // no verdict
      { ts: 3, kind: 'dispatch', agent: null, role: 'fullstack-dev', planId: null, taskId: null, taskCategory: null, verdict: 'banana' },
      settleRow({ ts: 2 }),                          // no outcome
      { ts: 1, kind: 'settle', agent: null, role: '', planId: null, taskId: null, taskCategory: null, outcome: 'bogus' },
    ])).flow
    expect(flow.events.map((e) => e.status)).toEqual(['dispatched', 'dispatched', 'ok', 'ok'])
  })
})

describe('projectGraph — flow event window & ids (spec agent-flow-catalog-graph §2.4)', () => {
  it('keeps only the latest 50 events, latest-first', () => {
    const events = Array.from({ length: 60 }, (_, i) => dispatchRow({ ts: 60 - i, role: 'fullstack-dev' }))
    const flow = projectGraph(flowSource(events)).flow
    expect(flow.events).toHaveLength(50)
    expect(flow.events[0]!.ts).toBe(60)
    expect(flow.events[49]!.ts).toBe(11)
    expect(flow.stages.find((s) => s.id === 'autonomous-execute:sdd-implement')!.count).toBe(50)
    expect(flow.degraded).toBe(false)
    expect(flow.empty).toBe(false)
  })

  it('id = `${ts}-${kind}-${index}` — unique even for equal ts+kind, stable across projections', () => {
    const events = [
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      settleRow({ ts: 5 }),
    ]
    const ids = projectGraph(flowSource(events)).flow.events.map((e) => e.id)
    expect(ids).toEqual(['5-dispatch-0', '5-dispatch-1', '5-settle-2'])
    // Same source → same ids (React keys stay stable).
    expect(projectGraph(flowSource(events)).flow.events.map((e) => e.id)).toEqual(ids)
  })

  it('unexpected list preserves the latest-first event order', () => {
    const flow = projectGraph(flowSource([
      dispatchRow({ ts: 4, role: 'scout' }),
      dispatchRow({ ts: 3, role: 'general' }),
      dispatchRow({ ts: 2, role: 'fullstack-dev' }),
      settleRow({ ts: 1 }),
    ])).flow
    expect(flow.unexpected.map((e) => e.ts)).toEqual([4, 3])
  })
})

describe('projectGraph — flow settled pairing heuristic (spec agent-flow-catalog-graph §2.3)', () => {
  it('a settle pairs with the most recent same-agent dispatch BEFORE it in file order', () => {
    // File order: D1(a1, t1) → D2(a1, t3) → S1(a1, t4); the catalog is latest-first.
    const flow = projectGraph(flowSource([
      settleRow({ ts: 4, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 3, role: 'fullstack-dev', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).flow
    const [s1, d2, d1] = flow.events
    expect(d1!.settled).toBe(false)
    expect(d2!.settled).toBe(true)
    expect(s1!.settled).toBe(false) // settle rows are never "settled" themselves
  })

  it('different agents never pair', () => {
    const flow = projectGraph(flowSource([
      settleRow({ ts: 2, agent: 'a2', outcome: 'ok' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).flow
    expect(flow.events[1]!.settled).toBe(false)
  })

  it('a later dispatch of the same agent resets the pairing target', () => {
    // File order: D1(a1,t1) → D2(a1,t3) → S1(a1,t4) → S2(a1,t5).
    const flow = projectGraph(flowSource([
      settleRow({ ts: 5, agent: 'a1', outcome: 'ok' }),
      settleRow({ ts: 4, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 3, role: 'frontend-dev', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'frontend-dev', agent: 'a1' }),
    ])).flow
    const [s2, s1, d2, d1] = flow.events
    expect(d1!.settled).toBe(false)
    expect(d2!.settled).toBe(true) // both settles pair to the most recent same-agent dispatch
    expect(s1!.settled).toBe(false)
    expect(s2!.settled).toBe(false)
  })

  it('an unpaired settle marks nothing; agent-less rows never pair', () => {
    const flow = projectGraph(flowSource([
      settleRow({ ts: 3, agent: 'a1', outcome: 'ok' }), // no prior a1 dispatch in the window
      settleRow({ ts: 2, outcome: 'ok' }),              // agent null
      dispatchRow({ ts: 1, role: 'fullstack-dev' }),    // agent null
    ])).flow
    expect(flow.events.every((e) => !e.settled)).toBe(true)
  })
})

describe('projectGraph — flow totality (spec agent-flow-catalog-graph §2.4)', () => {
  it('never throws on garbage rows; unclassifiable rows are skipped, valid rows still project', () => {
    const source = flowSource([
      42,
      null,
      'garbage',
      { kind: 'banana', ts: 9 },                  // unclassifiable kind → skipped
      { kind: 'dispatch', role: 42, ts: 8 },      // valid kind, garbage fields → degraded row
      { kind: 'settle', outcome: 42, ts: 7 },     // valid kind, garbage outcome → base status
      dispatchRow({ ts: 6, role: 'fullstack-dev', verdict: 'ok' }),
      settleRow({ ts: 5, outcome: 'error', durationMs: 120 }),
    ])
    expect(() => projectGraph(source)).not.toThrow()
    const flow = projectGraph(source).flow
    expect(flow.events.map((e) => e.ts)).toEqual([8, 7, 6, 5])
    expect(flow.events.map((e) => e.kind)).toEqual(['dispatch', 'settle', 'dispatch', 'settle'])
    expect(flow.events.map((e) => e.status)).toEqual(['dispatched', 'ok', 'dispatched', 'error'])
    expect(flow.events[3]!.durationMs).toBe(120)
    expect(flow.unexpected.map((e) => e.role)).toEqual(['']) // the role-42 dispatch degrades to ''
    expect(flow.stages.find((s) => s.id === 'autonomous-execute:sdd-implement')!.count).toBe(1)
    expect(flow.degraded).toBe(false)
    expect(flow.empty).toBe(false)
  })

  it('GraphView.flow is always present with the documented shape', () => {
    const flow = projectGraph(fullSource).flow
    const stageIds: string[] = flow.stages.map((s) => s.id)
    expect(stageIds).toContain('autonomous-execute:sdd-implement')
    expect(Array.isArray(flow.events)).toBe(true)
    expect(Array.isArray(flow.unexpected)).toBe(true)
    expect(typeof flow.degraded).toBe('boolean')
    expect(typeof flow.empty).toBe('boolean')
  })
})
