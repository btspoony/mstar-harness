/**
 * Pure projection tests for `projectGraph` (spec panel-layout-graph §2.1–§2.5):
 * the total function maps an `mstar-engine-status` catalog source to a
 * `GraphView` — phase ring (schema constants + `gate.transition` evidence),
 * plan state machine (schema constants + `state.plans[].status` evidence),
 * current-phase highlight + next edge, PASS/FAIL verdict + violation count,
 * and the connector (current phase → most-populated lit non-Done/Blocked
 * bucket, machine-order tie-break).
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
import { projectGraph } from '../src/client/panel/graph/project-graph'
import {
  PHASE_EDGES, PLAN_STATE_EDGES,
  type PhaseId, type PlanStateId,
} from '../src/client/panel/graph/schema'

/** Full fixture: every evidence field populated (spec §2.1–§2.4). */
const fullSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.4',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' },
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
      { id: 'plan-a', status: 'Todo' },
      { id: 'plan-b', status: 'InProgress' },
      { id: 'plan-c', status: 'Done' },
      { id: 'plan-d', status: 'Blocked' },
      { id: 'plan-e', status: 'custom-stalled' },
    ],
    residuals: [],
    iterationBaseBranch: 'dev-dsh',
    targetBranch: 'dev-dsh',
    specIntegrationBranch: 'iteration/iter-20260809-mstar-panel-beautify',
    pushPolicy: 'push authorized',
    worktreeMode: 'feature-worktree',
    controlWorktreePath: '/proj',
    leases: [],
    knowledge: null,
    direction: null,
  },
}

/** A source with a single InProgress plan → unambiguous connector target. */
const focusedSource: MstarEngineStatusSource = {
  ...fullSource,
  state: {
    ...fullSource.state!,
    plans: [{ id: 'plan-b', status: 'InProgress' }],
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
  enforcement: { hard: false, source: 'iteration compass' },
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
        ] as unknown as MstarEngineStatusSource['state'],
      },
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
          { id: 'plan-a', status: 'Todo' },
          { id: 'plan-b', status: 'InProgress' },
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
          { id: 'plan-c', status: 'Done' },
          { id: 'plan-d', status: 'Blocked' },
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
        plans: [{ id: 'plan-e', status: 'custom-stalled' }],
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
