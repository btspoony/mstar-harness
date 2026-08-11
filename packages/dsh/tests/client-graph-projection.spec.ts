/**
 * Pure projection tests for `projectGraph` (spec panel-zones §3 + §8): the
 * total function maps an `mstar-engine-status` catalog source to a `ZoneView`
 * — iteration zone (5 PHASE_IDS steps + Step N + current/next/idle + verdict
 * + branches + disabled determination), tasks zone (6 kanban columns +
 * exact-match bucketing + unknown column + shared plan-sort key + Done cap 5
 * + truncated), agents skeleton (EXPECTED_ROLE_FLOW pending stages +
 * degraded/empty from `state.agentFlow` presence), and the migrated top-level
 * verdict / violations / events / unexpected / degraded.
 *
 * Degradation contract (spec §8): missing/illegal fields set the matching
 * `degraded` flag and render as skeleton/unknown — the function NEVER throws
 * and NEVER fabricates values; `degraded.iteration ⟺ !active` (the old
 * `degraded.transition` is merged into `iteration.active === false`); Phase
 * 1/5 steps are schema-only (the engine gate never emits those transitions —
 * a known limitation, not a defect, spec §2.3).
 *
 * The shared plan-sort rule lives in `plan-sort.ts` (its own unit tests stay
 * untouched); this file adds the projection-side integration: the Done column
 * applies `sortPlans` + PLAN_CAP, `tasks.truncated` = Done rows > 5.
 *
 * No React / ReactFlow imports — the projection is DOM-free and fully
 * unit-testable (spec §2.1).
 */

import { describe, expect, it } from 'bun:test'
import type { MstarEngineStatusSource } from '../src/types'
import type { AgentFlowEventView, AgentFlowView } from '../src/types'
import type { EnforcementSource } from '@mstar-harness/engine'
import { pairSettleIndexes, projectGraph } from '../src/client/panel/graph/project-graph'
import {
  EXPECTED_ROLE_FLOW, KNOWN_AGENTS, PHASE_IDS, PLAN_STATE_IDS,
  type PhaseId, type PlanStateId,
} from '../src/client/panel/graph/schema'
import { PLAN_CAP, sortPlans } from '../src/client/panel/plan-sort'

/** Full fixture: every evidence field populated (spec §3). */
const fullSource: MstarEngineStatusSource = {
  kind: 'mstar-engine-status',
  form: 'catalog',
  version: '2.0.6',
  harnessDir: '/proj/.mstar',
  enforcement: { hard: true, source: 'iteration compass' as EnforcementSource },
  iteration: {
    iterationId: 'iter-20260810-panel-zones',
    statusPath: '/proj/.mstar/status.json',
    compassPath: '/proj/.mstar/iterations/iter-20260810-panel-zones/delivery-compass.md',
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
    specIntegrationBranch: 'iteration/iter-20260810-panel-zones',
    pushPolicy: 'push authorized',
    worktreeMode: 'feature-worktree',
    controlWorktreePath: '/proj',
    leases: [],
    knowledge: null,
    direction: null,
    agentFlow: null,
  },
}

/** Transition at Phase 4 → current step 4, next = merge-ready (Phase 5 as NEXT is legal). */
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
  version: '2.0.6',
  harnessDir: null,
  enforcement: { hard: false, source: 'iteration compass' as EnforcementSource },
  state: null,
}

/* ---------------------------------------------------------------------------
 * Iteration zone (spec §3): steps / Step N / current/next/idle / verdict /
 * branches / disabled determination.
 * ------------------------------------------------------------------------- */

describe('projectGraph — iteration zone (spec §3)', () => {
  const view = projectGraph(fullSource)

  it('emits the fixed 5 steps in PHASE_IDS order with 1-based step numbers', () => {
    expect(view.iteration.steps.map((s) => s.id)).toEqual([...PHASE_IDS])
    expect(view.iteration.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5])
  })

  it('lights the transition step as current and its forward target as next', () => {
    const byId = new Map(view.iteration.steps.map((s) => [s.id, s]))
    expect(byId.get('autonomous-execute')!.state).toBe('current')
    expect(byId.get('iteration-close')!.state).toBe('next')
    // Schema-only steps stay idle — never lit by the gate (Phase 1/5 known limitation).
    expect(byId.get('iteration-start')!.state).toBe('idle')
    expect(byId.get('pr-delivery')!.state).toBe('idle')
    expect(byId.get('merge-ready')!.state).toBe('idle')
  })

  it('projects gate.ok/violations onto the CURRENT step only (PASS + count)', () => {
    const current = view.iteration.steps.find((s) => s.state === 'current')!
    expect(current.verdict).toBe('pass')
    // Other steps carry no verdict.
    for (const step of view.iteration.steps) {
      if (step.state !== 'current') expect(step.verdict).toBe('unknown')
    }
    expect(view.iteration.verdict).toBe('pass')
    expect(view.iteration.violationCount).toBe(2)
    // Top-level verdict mirrors the iteration verdict (footer gate summary).
    expect(view.verdict).toBe('pass')
  })

  it('carries the iteration id, active flag, Step N and branches on a full source', () => {
    expect(view.iteration.active).toBe(true)
    expect(view.iteration.iterationId).toBe('iter-20260810-panel-zones')
    expect(view.iteration.currentStep).toBe(2) // phase-2-execute → autonomous-execute
    expect(view.iteration.branches).toEqual({
      iterationBase: 'dev-dsh',
      target: 'dev-dsh',
      specIntegration: 'iteration/iter-20260810-panel-zones',
    })
    expect(view.degraded).toEqual({ iteration: false, state: false, plans: false })
  })

  it('Phase 4 transition → current step 4, next lands on merge-ready (never current)', () => {
    const v = projectGraph(prDeliverySource)
    const byId = new Map(v.iteration.steps.map((s) => [s.id, s]))
    expect(byId.get('pr-delivery')!.state).toBe('current')
    expect(byId.get('merge-ready')!.state).toBe('next')
    expect(v.iteration.currentStep).toBe(4)
  })

  it('FAIL gate → current step verdict fail with violation count', () => {
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
    const current = v.iteration.steps.find((s) => s.state === 'current')!
    expect(current.verdict).toBe('fail')
    expect(v.iteration.verdict).toBe('fail')
    expect(v.verdict).toBe('fail')
    expect(v.iteration.violationCount).toBe(3)
  })

  it('non-boolean gate.ok → verdict unknown, count still from a real violations array (active unchanged)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, ok: 'yes' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    expect(v.iteration.active).toBe(true)
    expect(v.iteration.currentStep).toBe(2)
    expect(v.iteration.verdict).toBe('unknown')
    expect(v.verdict).toBe('unknown')
    expect(v.iteration.violationCount).toBe(2)
  })

  it('gate.violations non-array → no violation count/list, verdict still from gate.ok', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, violations: 'nope' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    const current = v.iteration.steps.find((s) => s.state === 'current')!
    expect(current.verdict).toBe('pass')
    expect(v.iteration.violationCount).toBeNull()
    expect(v.violations).toEqual([])
    expect(v.iteration.active).toBe(true)
  })

  it('iterationId missing → iteration.iterationId null (active still resolved from the transition)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, iterationId: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.iteration.active).toBe(true)
    expect(v.iteration.iterationId).toBeNull()
  })
})

describe('projectGraph — iteration disabled determination (spec §3 / §8)', () => {
  it('iteration absent → active false, 5 idle steps, degraded.iteration (never guessed)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: undefined,
    } as unknown as MstarEngineStatusSource)
    expect(v.iteration.active).toBe(false)
    expect(v.iteration.currentStep).toBeNull()
    expect(v.iteration.iterationId).toBeNull()
    expect(v.iteration.branches).toBeNull()
    expect(v.iteration.verdict).toBe('unknown')
    expect(v.iteration.violationCount).toBeNull()
    expect(v.iteration.steps).toHaveLength(5)
    expect(v.iteration.steps.every((s) => s.state === 'idle' && s.verdict === 'unknown')).toBe(true)
    expect(v.verdict).toBe('unknown')
    expect(v.violations).toEqual([])
    expect(v.degraded.iteration).toBe(true)
    expect(v.degraded.state).toBe(false)
    // Plans still project without an iteration (state is independent).
    expect(v.tasks.columns.find((c) => c.id === 'InProgress')!.count).toBe(1)
  })

  it('missing transition → active false (old degraded.transition merged into degraded.iteration)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, transition: undefined },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    expect(v.iteration.active).toBe(false)
    expect(v.iteration.currentStep).toBeNull()
    expect(v.iteration.steps.every((s) => s.state === 'idle')).toBe(true)
    expect(v.degraded.iteration).toBe(true)
    // The merged semantics: no separate transition flag any more.
    expect(v.degraded).toEqual({ iteration: true, state: false, plans: false })
  })

  it('illegal transition string → same disabled treatment', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: {
        ...fullSource.iteration!,
        gate: { ...fullSource.iteration!.gate, transition: 'phase-9-bogus' },
      } as unknown as MstarEngineStatusSource['iteration'],
    })
    expect(v.iteration.active).toBe(false)
    expect(v.iteration.currentStep).toBeNull()
    expect(v.degraded.iteration).toBe(true)
  })

  it('missing gate → same disabled treatment', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.iteration.active).toBe(false)
    expect(v.degraded.iteration).toBe(true)
  })

  it('gate present but not an object → disabled, steps idle (never guessed)', () => {
    const v = projectGraph({
      ...fullSource,
      iteration: { ...fullSource.iteration!, gate: 42 },
    } as unknown as MstarEngineStatusSource)
    expect(v.iteration.active).toBe(false)
    expect(v.iteration.currentStep).toBeNull()
    expect(v.iteration.steps.every((s) => s.state === 'idle')).toBe(true)
    expect(v.degraded.iteration).toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * Tasks zone (spec §3): 6 columns / exact-match bucketing / unknown column /
 * shared sort key / Done cap / truncated / total.
 * ------------------------------------------------------------------------- */

describe('projectGraph — tasks zone (spec §3)', () => {
  const view = projectGraph(fullSource)

  it('emits the fixed 6 columns in PLAN_STATE_IDS order', () => {
    expect(view.tasks.columns.map((c) => c.id)).toEqual([...PLAN_STATE_IDS])
    expect(view.tasks.columns.map((c) => c.id)).toEqual(['Todo', 'InProgress', 'InReview', 'Done', 'Blocked', 'unknown'])
  })

  it('buckets each plan row by EXACT status match; any other string lands in unknown', () => {
    const byId = new Map(view.tasks.columns.map((c) => [c.id, c]))
    expect(byId.get('Todo')!.plans).toEqual([{ id: 'plan-a', status: 'Todo' }])
    expect(byId.get('InProgress')!.plans).toEqual([{ id: 'plan-b', status: 'InProgress' }])
    expect(byId.get('Done')!.plans).toEqual([{ id: 'plan-c', status: 'Done' }])
    expect(byId.get('Blocked')!.plans).toEqual([{ id: 'plan-d', status: 'Blocked' }])
    expect(byId.get('InReview')!.plans).toEqual([])
    // Unknown bucket keeps the raw status string as-is (not translated, not guessed).
    expect(byId.get('unknown')!.plans).toEqual([{ id: 'plan-e', status: 'custom-stalled' }])
  })

  it('counts every column (full, pre-cap) and totals plans including unknown', () => {
    const byId = new Map(view.tasks.columns.map((c) => [c.id, c]))
    expect(byId.get('Todo')!.count).toBe(1)
    expect(byId.get('InProgress')!.count).toBe(1)
    expect(byId.get('Done')!.count).toBe(1)
    expect(byId.get('Blocked')!.count).toBe(1)
    expect(byId.get('unknown')!.count).toBe(1)
    expect(byId.get('InReview')!.count).toBe(0)
    expect(view.tasks.total).toBe(5)
  })

  it('no Done overflow on the full fixture → capped null, truncated false', () => {
    const done = view.tasks.columns.find((c) => c.id === 'Done')!
    expect(done.capped).toBeNull()
    expect(view.tasks.truncated).toBe(false)
  })

  it('state null → 6-column skeleton (count 0) + degraded.state (+ plans)', () => {
    const v = projectGraph(noHarnessSource)
    expect(v.tasks.columns).toHaveLength(6)
    expect(v.tasks.columns.every((c) => c.plans.length === 0 && c.count === 0 && c.capped === null)).toBe(true)
    expect(v.tasks.total).toBe(0)
    expect(v.tasks.truncated).toBe(false)
    expect(v.degraded.state).toBe(true)
    expect(v.degraded.plans).toBe(true)
  })

  it('state.plans missing/non-array → skeleton columns + degraded.plans', () => {
    const v = projectGraph({
      ...fullSource,
      state: { ...fullSource.state!, plans: undefined },
    } as unknown as MstarEngineStatusSource)
    expect(v.tasks.columns.every((c) => c.plans.length === 0 && c.count === 0)).toBe(true)
    expect(v.tasks.total).toBe(0)
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
    const unknown = v.tasks.columns.find((c) => c.id === 'unknown')!
    // Raw non-string statuses degrade to an empty display string (never a guessed label).
    expect(unknown.plans).toEqual([
      { id: 'plan-x', status: '' },
      { id: 'plan-y', status: '' },
    ])
    expect(v.tasks.columns.find((c) => c.id === 'Done')!.plans).toEqual([{ id: 'plan-z', status: 'Done' }])
  })
})

describe('projectGraph — Done column sort + cap (spec §3, shared plan-sort key)', () => {
  /** A source whose Done column carries the given rows (id → doneAt). */
  function doneSource(rows: { id: string; doneAt: string | null }[]): MstarEngineStatusSource {
    return {
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: rows.map((r) => ({ id: r.id, status: 'Done', doneAt: r.doneAt })),
      },
    }
  }

  it('sorts the Done column with the shared plan-sort key (doneAt digitized DESC)', () => {
    const v = projectGraph(doneSource([
      { id: 'plan-old', doneAt: '2026-08-01' },
      { id: 'plan-new', doneAt: '2026-08-10' },
      { id: 'plan-mid', doneAt: '2026-07-20' },
    ]))
    expect(v.tasks.columns.find((c) => c.id === 'Done')!.plans.map((p) => p.id)).toEqual(['plan-new', 'plan-old', 'plan-mid'])
  })

  it('doneAt missing/garbage sorts last; id-date fallback + id tie-break still apply (integration with plan-sort)', () => {
    const rows = [
      { id: 'plan-b', doneAt: '2026-08-08' },
      { id: '20260810-x', doneAt: null },
      { id: 'plan-a', doneAt: '2026-08-10' },
      { id: '20260809-y', doneAt: null },
      { id: 'plan-z', doneAt: 'garbage-date' },
    ]
    const v = projectGraph(doneSource(rows))
    const got = v.tasks.columns.find((c) => c.id === 'Done')!.plans.map((p) => p.id)
    // The projection applies sortPlans — assert the same order the shared
    // module produces (single implementation, no drift).
    expect(got).toEqual(sortPlans(rows).map((r) => r.id))
    expect(got).toEqual(['plan-a', 'plan-b', '20260810-x', '20260809-y', 'plan-z'])
  })

  it('cap 5: 7 Done plans → display top 5 sorted, count 7, capped 5, truncated true, total 7', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `202608${String(i + 1).padStart(2, '0')}-p${i}`, doneAt: null }))
    const v = projectGraph(doneSource(rows))
    const done = v.tasks.columns.find((c) => c.id === 'Done')!
    expect(done.plans).toHaveLength(PLAN_CAP)
    expect(done.count).toBe(7)
    expect(done.capped).toBe(PLAN_CAP)
    expect(v.tasks.truncated).toBe(true)
    expect(v.tasks.total).toBe(7)
    // Display = the shared sort order's top PLAN_CAP (id-date DESC here).
    expect(done.plans.map((p) => p.id)).toEqual(sortPlans(rows).slice(0, PLAN_CAP).map((r) => r.id))
  })

  it('cap boundary: exactly 5 Done plans → all shown, capped null, truncated false', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `plan-${i}`, doneAt: null }))
    const v = projectGraph(doneSource(rows))
    const done = v.tasks.columns.find((c) => c.id === 'Done')!
    expect(done.plans).toHaveLength(5)
    expect(done.count).toBe(5)
    expect(done.capped).toBeNull()
    expect(v.tasks.truncated).toBe(false)
  })

  it('non-Done columns are NOT capped and keep input order (only Done sorts)', () => {
    const v = projectGraph({
      ...fullSource,
      state: {
        ...fullSource.state!,
        plans: [
          { id: 'todo-2', status: 'Todo', doneAt: null },
          { id: 'todo-1', status: 'Todo', doneAt: null },
          { id: 'todo-3', status: 'Todo', doneAt: '2026-08-08' },
        ],
      },
    })
    const todo = v.tasks.columns.find((c) => c.id === 'Todo')!
    expect(todo.plans.map((p) => p.id)).toEqual(['todo-2', 'todo-1', 'todo-3']) // input order
    expect(todo.capped).toBeNull()
    expect(todo.count).toBe(3)
    expect(v.tasks.truncated).toBe(false)
  })
})

/* ---------------------------------------------------------------------------
 * Agents zone skeleton (spec §4 — plan 2): pending stages + degraded/empty
 * from `state.agentFlow` presence.
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

/**
 * The expected idle tail (spec §6.2): KNOWN_AGENTS members WITHOUT role
 * evidence project as idle cards — this mirrors the projection's suppression
 * rule so assertions can compute the expected roster tail.
 */
function idleRosterIds(evidencedRoles: readonly string[]): string[] {
  return KNOWN_AGENTS.filter((a) => !evidencedRoles.includes(a.id)).map((a) => a.id)
}

describe('projectGraph — agents zone skeleton (spec §4, plan 2)', () => {
  it('is the fixed 6-stage EXPECTED_ROLE_FLOW skeleton with the spec\'d exact role vocabularies', () => {
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

  it('agentFlow null (ledger absent) → degraded skeleton + full idle roster (spec §6.2)', () => {
    const agents = projectGraph(fullSource).agents
    expect(agents.degraded).toBe(true)
    expect(agents.empty).toBe(false)
    expect(agents.stages).toHaveLength(6)
    expect(agents.stages.map((s) => s.id)).toEqual([
      'iteration-start:review-edit-chain',
      'autonomous-execute:sdd-implement',
      'autonomous-execute:sdd-task-review',
      'autonomous-execute:qc-tri',
      'autonomous-execute:qa-gate',
      'autonomous-execute:ops-on-demand',
    ])
    expect(agents.stages[0]!.roles).toEqual(['product-manager', 'architect', 'writing-specialist'])
  })

  it('source null / state null → same degraded skeleton (total function)', () => {
    expect(projectGraph(null).agents.degraded).toBe(true)
    expect(projectGraph(noHarnessSource).agents.degraded).toBe(true)
  })

  it('agentFlow empty view (0 events) → empty, NOT degraded (qc1 F-001 fix-wave: a MISSING ledger file now reads as this empty view — the panel shows the no-dispatches-yet state)', () => {
    const agents = projectGraph(flowSource([])).agents
    expect(agents.degraded).toBe(false)
    expect(agents.empty).toBe(true)
    expect(agents.stages).toHaveLength(6)
  })

  it('unreadable agentFlow (non-object / events non-array) → degraded, never throws', () => {
    const project = (agentFlow: unknown) => projectGraph({
      ...fullSource,
      state: { ...fullSource.state!, agentFlow },
    } as unknown as MstarEngineStatusSource).agents
    for (const bad of [42, 'nope', [], { events: 'nope' }, { events: 42 }, { no: 'events' }]) {
      expect(() => project(bad)).not.toThrow()
      expect(project(bad).degraded).toBe(true)
      expect(project(bad).empty).toBe(false)
      expect(project(bad).stages).toHaveLength(6)
    }
  })

  it('agentFlow with events → plain skeleton (degraded false, empty false; entities/edges land in this plan)', () => {
    const agents = projectGraph(flowSource([dispatchRow({ ts: 1, role: 'fullstack-dev' })])).agents
    expect(agents.degraded).toBe(false)
    expect(agents.empty).toBe(false)
    expect(agents.stages).toHaveLength(6)
  })
})

/* ---------------------------------------------------------------------------
 * Agents zone entities (spec §4): aggregation / fallback key / card fields /
 * status derivation (verdict priority → paired settle → running).
 * ------------------------------------------------------------------------- */

describe('projectGraph — agents zone entities (spec §4)', () => {
  it('aggregates the same agent across dispatches: one card, count + latest ts', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 6, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T2' }),
      dispatchRow({ ts: 4, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
      dispatchRow({ ts: 2, role: 'generalPurpose', agent: 'a1' }),
    ]))
    const [a1] = view.agents.entities
    expect(a1!.key).toBe('a1')
    expect(a1!.count).toBe(3)
    expect(a1!.ts).toBe(6)
  })

  it('card identity fields come from the LATEST dispatch (name/role/task/stage/ts)', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 6, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T2' }),
      dispatchRow({ ts: 4, role: 'generalPurpose', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
    ]))
    const [a1] = view.agents.entities
    expect(a1!.name).toBe('a1') // agent ?? role
    expect(a1!.agent).toBe('a1')
    expect(a1!.role).toBe('fullstack-dev')
    expect(a1!.task).toBe('plan-x#T2')
    expect(a1!.stage).toEqual({ phase: 'autonomous-execute', stage: 'sdd-implement' })
  })

  it('fallback key = role+ts when the agent id is missing (host-hook path)', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      dispatchRow({ ts: 3, role: 'fullstack-dev' }),
    ]))
    const idleTail = idleRosterIds(['fullstack-dev'])
    expect(view.agents.entities.map((e) => e.key)).toEqual(['fullstack-dev+5', 'fullstack-dev+3', ...idleTail])
    expect(view.agents.entities.map((e) => e.name)).toEqual(['fullstack-dev', 'fullstack-dev', ...idleTail])
    expect(view.agents.entities.map((e) => e.agent)).toEqual([null, null, ...idleTail.map(() => null)])
  })

  it('identical fallback keys (same role+ts) aggregate into one card', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
    ]))
    // 1 evidence card + the 14 un-evidenced KNOWN_AGENTS idle cards (spec §6.2).
    expect(view.agents.entities).toHaveLength(1 + idleRosterIds(['fullstack-dev']).length)
    expect(view.agents.entities[0]!.key).toBe('fullstack-dev+5')
    expect(view.agents.entities[0]!.count).toBe(2)
    expect(view.agents.entities[0]!.idle).toBe(false)
  })

  it('task tag: planId#taskId; planId alone when taskId missing; null when planId missing', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x', taskId: 'T1' }),
      dispatchRow({ ts: 2, role: 'fullstack-dev', agent: 'a2', planId: 'plan-x' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a3' }),
    ]))
    const byKey = new Map(view.agents.entities.map((e) => [e.key, e]))
    expect(byKey.get('a1')!.task).toBe('plan-x#T1')
    expect(byKey.get('a2')!.task).toBe('plan-x')
    expect(byKey.get('a3')!.task).toBeNull()
  })
})

describe('projectGraph — agents zone status derivation (spec §4)', () => {
  it('latest-dispatch verdict denied wins even with a paired settle', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1', verdict: 'denied' }),
    ]))
    expect(view.agents.entities[0]!.status).toBe('denied')
  })

  it('latest-dispatch verdict advisory → advisory (verdict priority, settle ignored)', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'error' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1', verdict: 'advisory' }),
    ]))
    expect(view.agents.entities[0]!.status).toBe('advisory')
  })

  it('paired settle ok → settled', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(view.agents.entities[0]!.status).toBe('settled')
  })

  it('paired settle error → error; settle outcome denied → settled at the ENTITY level', () => {
    const errorView = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'error' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(errorView.agents.entities[0]!.status).toBe('error')
    const deniedView = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a2', outcome: 'denied' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a2' }),
    ]))
    expect(deniedView.agents.entities[0]!.status).toBe('settled')
  })

  it('no paired settle → running; a dispatch after the last settle is running again', () => {
    const running = projectGraph(flowSource([
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(running.agents.entities[0]!.status).toBe('running')
    // File order: D(t9) → S(t8) → D(t7). The settle pairs the OLDER dispatch
    // (most recent same-agent dispatch before it in file order); the latest
    // dispatch (t9) has no pair → running (honest).
    const again = projectGraph(flowSource([
      dispatchRow({ ts: 9, role: 'fullstack-dev', agent: 'a1' }),
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(again.agents.entities[0]!.status).toBe('running')
  })

  it('different agents never pair; the settle-only agent stays running', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a2', outcome: 'ok' }),
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(view.agents.entities[0]!.status).toBe('running')
  })

  it('settle-only flow → no settle-derived cards; the full KNOWN_AGENTS roster shows idle', () => {
    const agents = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
      settleRow({ ts: 7, agent: 'a2', outcome: 'error' }),
    ])).agents
    // Settle rows never produce cards (spec §4), but the known roster is never
    // hidden: every known agent projects as an idle card (spec §6.2).
    expect(agents.degraded).toBe(false)
    expect(agents.empty).toBe(false)
    expect(agents.entities).toHaveLength(KNOWN_AGENTS.length)
    expect(agents.entities.every((e) => e.idle && e.status === 'idle')).toBe(true)
    expect(agents.executing).toBe(0)
  })
})

/* ---------------------------------------------------------------------------
 * Agents zone edges (spec §4): expected skeleton arrows / actual same-plan
 * handoffs / next determination (multiple-running rule).
 * ------------------------------------------------------------------------- */

describe('projectGraph — agents zone edges (spec §4)', () => {
  it('expected: 5 skeleton arrows across consecutive EXPECTED_ROLE_FLOW stages', () => {
    const agents = projectGraph(flowSource([dispatchRow({ ts: 1, role: 'fullstack-dev' })])).agents
    expect(agents.edges.filter((e) => e.kind === 'expected').map((e) => [e.source, e.target])).toEqual([
      ['iteration-start:review-edit-chain', 'autonomous-execute:sdd-implement'],
      ['autonomous-execute:sdd-implement', 'autonomous-execute:sdd-task-review'],
      ['autonomous-execute:sdd-task-review', 'autonomous-execute:qc-tri'],
      ['autonomous-execute:qc-tri', 'autonomous-execute:qa-gate'],
      ['autonomous-execute:qa-gate', 'autonomous-execute:ops-on-demand'],
    ])
  })

  it('actual: same-plan ts-ascending adjacent dispatch entity pairs', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 5, role: 'qc-specialist', agent: 'a3', planId: 'plan-x' }),
      dispatchRow({ ts: 3, role: 'generalPurpose', agent: 'a2', planId: 'plan-x' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const actual = view.agents.edges.filter((e) => e.kind === 'actual')
    expect(actual.map((e) => [e.source, e.target])).toEqual([
      ['a1', 'a2'],
      ['a2', 'a3'],
    ])
    expect(actual.every((e) => e.entityKey === null)).toBe(true)
  })

  it('actual: different plans never cross; plan-less dispatches excluded', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 5, role: 'qc-specialist', agent: 'b1', planId: 'plan-y' }),
      dispatchRow({ ts: 4, role: 'generalPurpose', agent: 'a2', planId: 'plan-x' }),
      dispatchRow({ ts: 3, role: 'fullstack-dev', agent: 'noplan' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    const actual = view.agents.edges.filter((e) => e.kind === 'actual')
    expect(actual.map((e) => [e.source, e.target])).toEqual([['a1', 'a2']])
  })

  it('actual: a self-pair (the same entity twice in a plan) is skipped', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 4, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1', planId: 'plan-x' }),
    ]))
    expect(view.agents.edges.filter((e) => e.kind === 'actual')).toEqual([])
  })
})

describe('projectGraph — agents zone next edge (spec §4)', () => {
  it('next: the latest running entity → the next constant-order stage column', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 10, role: 'generalPurpose', agent: 'a2' }),
      dispatchRow({ ts: 8, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(view.agents.edges.filter((e) => e.kind === 'next')).toEqual([
      { kind: 'next', source: 'autonomous-execute:sdd-task-review', target: 'autonomous-execute:qc-tri', entityKey: 'a2' },
    ])
  })

  it('next: multiple running with equal ts → the smallest entity key wins', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 10, role: 'fullstack-dev', agent: 'b-agent' }),
      dispatchRow({ ts: 10, role: 'fullstack-dev', agent: 'a-agent' }),
    ]))
    expect(view.agents.edges.filter((e) => e.kind === 'next')).toEqual([
      { kind: 'next', source: 'autonomous-execute:sdd-implement', target: 'autonomous-execute:sdd-task-review', entityKey: 'a-agent' },
    ])
  })

  it('next: no running entity → no next edge (honest)', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 20, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 10, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    expect(view.agents.edges.filter((e) => e.kind === 'next')).toEqual([])
  })

  it('next: running at the LAST stage (ops-on-demand) → no next edge', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 10, role: 'ops-engineer', agent: 'a1' }),
    ]))
    expect(view.agents.edges.filter((e) => e.kind === 'next')).toEqual([])
  })

  it('next: running with an unexpected role (no stage) → no next edge', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 10, role: 'scout', agent: 'a1' }),
    ]))
    expect(view.agents.entities[0]!.status).toBe('running')
    expect(view.agents.entities[0]!.stage).toBeNull()
    expect(view.agents.edges.filter((e) => e.kind === 'next')).toEqual([])
  })
})

/* ---------------------------------------------------------------------------
 * Agents zone counts + the spec §8 degradation matrix (never throw, never
 * guess: degraded → no claims; empty / settle-only → full pending skeleton).
 * ------------------------------------------------------------------------- */

describe('projectGraph — agents zone counts (spec §4)', () => {
  it('executing = running entity count; settled/error/denied are not executing', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 20, agent: 's1', outcome: 'ok' }),
      dispatchRow({ ts: 19, role: 'fullstack-dev', agent: 's1' }),
      dispatchRow({ ts: 18, role: 'fullstack-dev', agent: 'r1' }),
      settleRow({ ts: 17, agent: 'e1', outcome: 'error' }),
      dispatchRow({ ts: 16, role: 'generalPurpose', agent: 'e1' }),
      dispatchRow({ ts: 15, role: 'qc-specialist', agent: 'd1', verdict: 'denied' }),
    ]))
    const byKey = new Map(view.agents.entities.map((e) => [e.key, e.status]))
    expect(byKey.get('s1')).toBe('settled')
    expect(byKey.get('r1')).toBe('running')
    expect(byKey.get('e1')).toBe('error')
    expect(byKey.get('d1')).toBe('denied')
    expect(view.agents.executing).toBe(1)
  })

  it('pending = expected roles of stages with NO dispatch evidence', () => {
    // Evidence: fullstack-dev (sdd-implement, 3 roles) + generalPurpose
    // (sdd-task-review, 1 role); total expected roles = 12 → pending 8.
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 2, role: 'fullstack-dev', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'generalPurpose', agent: 'a2' }),
    ])).agents
    expect(agents.pending).toBe(8)
    expect(agents.executing).toBe(2)
  })

  it('evidence comes from ALL dispatch rows, not only each entity\'s latest', () => {
    // a1 dispatched as fullstack-dev (t1) then re-dispatched as
    // generalPurpose (t3) — BOTH stages stay evidenced.
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'generalPurpose', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).agents
    expect(agents.pending).toBe(12 - 3 - 1) // 8
  })

  it('stage.evidenced flags the SAME stages as the pending count (render placeholder decision)', () => {
    // Evidence: fullstack-dev (sdd-implement) + generalPurpose
    // (sdd-task-review); the re-dispatched a1 lights its earlier stage too.
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'generalPurpose', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).agents
    const byId = new Map(agents.stages.map((s) => [s.id, s.evidenced]))
    expect(byId.get('autonomous-execute:sdd-implement')).toBe(true)
    expect(byId.get('autonomous-execute:sdd-task-review')).toBe(true)
    for (const id of ['iteration-start:review-edit-chain', 'autonomous-execute:qc-tri', 'autonomous-execute:qa-gate', 'autonomous-execute:ops-on-demand']) {
      expect(byId.get(id)).toBe(false)
    }
    // The count equals the sum of un-evidenced stage roles (no drift).
    const unEvidenced = agents.stages.filter((s) => !s.evidenced).reduce((sum, s) => sum + s.roles.length, 0)
    expect(unEvidenced).toBe(agents.pending)
  })
})

describe('projectGraph — agents zone degradation matrix (spec §8)', () => {
  it('degraded (agentFlow null / unreadable) → full idle roster, NO executing/pending claims (0/0)', () => {
    const degraded = projectGraph(fullSource).agents // agentFlow: null
    expect(degraded.degraded).toBe(true)
    // The known roster is never hidden (spec §6.2): all 15 agents show idle.
    expect(degraded.entities).toHaveLength(KNOWN_AGENTS.length)
    expect(degraded.entities.every((e) => e.idle && e.status === 'idle' && e.count === 0 && e.ts === 0)).toBe(true)
    expect(degraded.executing).toBe(0)
    expect(degraded.pending).toBe(0)
    expect(degraded.edges.filter((e) => e.kind === 'expected')).toHaveLength(5)
    // No evidence claims on a degraded skeleton either (render shows no
    // pending placeholders — spec §8).
    expect(degraded.stages.every((s) => !s.evidenced)).toBe(true)
  })

  it('empty ledger → empty + full idle roster + full pending skeleton (0 executing, 12 pending)', () => {
    const agents = projectGraph(flowSource([])).agents
    expect(agents.empty).toBe(true)
    expect(agents.degraded).toBe(false)
    expect(agents.entities).toHaveLength(KNOWN_AGENTS.length)
    expect(agents.entities.every((e) => e.idle && e.status === 'idle')).toBe(true)
    expect(agents.executing).toBe(0)
    expect(agents.pending).toBe(12)
  })

  it('only-settle ledger → idle roster + full pending skeleton (摘要 0 执行中 · M 待执行)', () => {
    const agents = projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
      settleRow({ ts: 7, agent: 'a2', outcome: 'error' }),
    ])).agents
    expect(agents.degraded).toBe(false)
    expect(agents.empty).toBe(false)
    // Settles never produce cards; the known roster still shows idle.
    expect(agents.entities).toHaveLength(KNOWN_AGENTS.length)
    expect(agents.entities.every((e) => e.idle && e.status === 'idle')).toBe(true)
    expect(agents.executing).toBe(0)
    expect(agents.pending).toBe(12)
    expect(agents.stages).toHaveLength(6)
    // F-002: the projection classifies the ledger — settle rows but no
    // dispatch rows → the settle-only note (never UI-inferred).
    expect(agents.note).toBe('settle-only')
  })

  it('F-002: the canvas note is PROJECTED — empty (0 events) / settle-only (rows but no dispatch) / null (dispatch evidence)', () => {
    // 0 events → 'empty'.
    expect(projectGraph(flowSource([])).agents.note).toBe('empty')
    // Events but NO dispatch row (settle rows only) → 'settle-only'.
    expect(projectGraph(flowSource([
      settleRow({ ts: 8, agent: 'a1', outcome: 'ok' }),
    ])).agents.note).toBe('settle-only')
    // Any dispatch row → null (real evidence; anonymous rows count too —
    // they are dispatch activity, not a settle-only ledger).
    expect(projectGraph(flowSource([
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).agents.note).toBeNull()
    expect(projectGraph(flowSource([{ kind: 'dispatch' }])).agents.note).toBeNull()
    // Unreadable / absent ledger → null note (the `degraded` flag is the signal).
    expect(projectGraph(fullSource).agents.note).toBeNull()
    expect(projectGraph(null).agents.note).toBeNull()
    expect(projectGraph(noHarnessSource).agents.note).toBeNull()
  })

  it('F-002: a garbage-only ledger never fakes evidence — note settle-only (no dispatch rows to show)', () => {
    // All rows unclassifiable (kind ∉ dispatch|settle) → no dispatch
    // evidence at all → the honest settle-only note (the old UI-side
    // allIdle heuristic produced the same anchor; the projection now owns it).
    const agents = projectGraph(flowSource([42, null, 'garbage', { kind: 'banana' }])).agents
    expect(agents.degraded).toBe(false)
    expect(agents.empty).toBe(false)
    expect(agents.note).toBe('settle-only')
    expect(agents.entities.every((e) => e.idle)).toBe(true)
    // Mixing garbage with a REAL dispatch row → evidence wins, no note.
    const mixed = projectGraph(flowSource([
      42,
      'garbage',
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ])).agents
    expect(mixed.note).toBeNull()
    expect(mixed.entities.some((e) => !e.idle)).toBe(true)
  })

  it('anonymous dispatch rows (no agent, no role) are skipped — never ghost cards', () => {
    const view = projectGraph(flowSource([
      { kind: 'dispatch', ts: 9, role: 42 }, // garbage role → '' → anonymous
      { kind: 'dispatch', ts: 8 },           // fully anonymous
      dispatchRow({ ts: 6, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    // a1 (lit) + the 14 un-evidenced known roles (idle) — anonymous rows add nothing.
    expect(view.agents.entities.map((e) => e.key)).toEqual(['a1', ...idleRosterIds(['fullstack-dev'])])
    expect(view.agents.executing).toBe(1)
    expect(view.agents.entities.filter((e) => e.idle).every((e) => e.status === 'idle')).toBe(true)
  })

  it('all-garbage agent-flow rows → total function: idle roster only, never throws', () => {
    const agents = projectGraph(flowSource([42, null, 'garbage', { kind: 'banana' }, { kind: 'dispatch' }])).agents
    expect(agents.degraded).toBe(false)
    // No role evidence → the whole known roster is idle.
    expect(agents.entities).toHaveLength(KNOWN_AGENTS.length)
    expect(agents.entities.every((e) => e.idle && e.status === 'idle')).toBe(true)
    expect(agents.executing).toBe(0)
  })
})

/* ---------------------------------------------------------------------------
 * KNOWN_AGENTS full roster (spec §4 / §6.2 / decision point D3): exactly 15
 * roles — every EXPECTED_ROLE_FLOW role + project-manager / prompt-engineer /
 * explore + generalPurpose; stages pinned to the flow (first constant-order
 * match), null for the off-pipeline roles.
 * ------------------------------------------------------------------------- */

describe('projectGraph — KNOWN_AGENTS full roster (spec §4 / §6.2 / D3)', () => {
  it('is exactly the 15 spec roles in spec §4 order, no duplicates', () => {
    expect(KNOWN_AGENTS).toHaveLength(15)
    expect(KNOWN_AGENTS.map((a) => a.id)).toEqual([
      'project-manager', 'product-manager', 'architect', 'fullstack-dev', 'fullstack-dev-2',
      'frontend-dev', 'qa-engineer', 'qc-specialist', 'qc-specialist-2', 'qc-specialist-3',
      'ops-engineer', 'writing-specialist', 'prompt-engineer', 'generalPurpose', 'explore',
    ])
    expect(new Set(KNOWN_AGENTS.map((a) => a.id)).size).toBe(15)
  })

  it('covers every EXPECTED_ROLE_FLOW role (12) plus the 3 off-pipeline roles', () => {
    const flowRoles = EXPECTED_ROLE_FLOW.flatMap((s) => [...s.roles])
    expect(flowRoles).toHaveLength(12)
    for (const role of flowRoles) {
      expect(KNOWN_AGENTS.some((a) => a.id === role)).toBe(true)
    }
    // The architect-verified gaps (spec §6.5 D3): orchestrator / table-only / scout.
    for (const role of ['project-manager', 'prompt-engineer', 'explore']) {
      expect(KNOWN_AGENTS.some((a) => a.id === role)).toBe(true)
    }
  })

  it('stage = the first constant-order EXPECTED_ROLE_FLOW match; null for off-pipeline roles', () => {
    const firstStage = (role: string) => {
      for (const s of EXPECTED_ROLE_FLOW) {
        if (s.roles.includes(role)) return { phase: s.phase, stage: s.stage }
      }
      return null
    }
    for (const known of KNOWN_AGENTS) {
      expect(known.stage ?? null).toEqual(firstStage(known.id))
    }
    expect(KNOWN_AGENTS.find((a) => a.id === 'project-manager')!.stage ?? null).toBeNull()
    expect(KNOWN_AGENTS.find((a) => a.id === 'prompt-engineer')!.stage ?? null).toBeNull()
    expect(KNOWN_AGENTS.find((a) => a.id === 'explore')!.stage ?? null).toBeNull()
  })

  it('generalPurpose (the user-named SDD general reviewer) sits in sdd-task-review', () => {
    const gp = KNOWN_AGENTS.find((a) => a.id === 'generalPurpose')!
    expect(gp.stage).toEqual({ phase: 'autonomous-execute', stage: 'sdd-task-review' })
  })
})

/* ---------------------------------------------------------------------------
 * Agents roster full coverage (spec §6.2): every KNOWN_AGENTS member has an
 * entity — lit when dispatch-evidenced, idle otherwise — across degraded /
 * empty / evidence states; idle never counts into `executing`.
 * ------------------------------------------------------------------------- */

describe('projectGraph — agents roster full coverage (spec §6.2)', () => {
  it('every KNOWN_AGENTS member has an entity (idle or lit) across degraded / empty / evidence states', () => {
    for (const agents of [
      projectGraph(fullSource).agents, // degraded: agentFlow null
      projectGraph(flowSource([])).agents, // empty: 0 events
      projectGraph(flowSource([dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' })])).agents,
    ]) {
      // A lit member's card is keyed by session id — match on the ROLE field
      // (idle cards carry role = id, lit cards carry role = the known id).
      for (const known of KNOWN_AGENTS) {
        expect(agents.entities.some((e) => e.role === known.id)).toBe(true)
      }
    }
  })

  it('no evidence → the whole roster is idle cards (idle true, status idle, count 0, ts 0, agent null)', () => {
    const agents = projectGraph(flowSource([])).agents
    expect(agents.entities).toHaveLength(15)
    for (const e of agents.entities) {
      expect(e.status).toBe('idle')
      expect(e.idle).toBe(true)
      expect(e.count).toBe(0)
      expect(e.ts).toBe(0)
      expect(e.agent).toBeNull()
      expect(e.task).toBeNull()
      expect(e.name).toBe(e.role)
    }
    expect(agents.executing).toBe(0)
  })

  it('idle cards carry the KNOWN_AGENTS stage (null for off-pipeline roles)', () => {
    const agents = projectGraph(flowSource([])).agents
    const byId = new Map(agents.entities.map((e) => [e.key, e]))
    for (const known of KNOWN_AGENTS) {
      expect(byId.get(known.id)!.stage ?? null).toEqual(known.stage ?? null)
    }
  })

  it('dispatch evidence lights the known agent (idle false) and suppresses its idle card', () => {
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 2, role: 'generalPurpose', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a2' }),
    ])).agents
    const byKey = new Map(agents.entities.map((e) => [e.key, e]))
    expect(byKey.get('a2')!.idle).toBe(false)
    expect(byKey.get('a2')!.status).toBe('running')
    expect(byKey.get('a1')!.idle).toBe(false)
    // Lit roles never ALSO appear as idle cards (evidence suppresses the idle twin).
    expect(byKey.get('fullstack-dev')).toBeUndefined()
    expect(byKey.get('generalPurpose')).toBeUndefined()
    // The other 13 known roles are idle.
    const idle = agents.entities.filter((e) => e.idle)
    expect(idle).toHaveLength(13)
    expect(idle.every((e) => e.status === 'idle')).toBe(true)
  })

  it('evidence via an agent-less dispatch row (role present) still lights the role', () => {
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 1, role: 'ops-engineer' }), // no agent id → fallback key
    ])).agents
    const keys = agents.entities.map((e) => e.key)
    expect(keys).toContain('ops-engineer+1')
    expect(agents.entities.filter((e) => e.idle).map((e) => e.key)).not.toContain('ops-engineer')
  })

  it('executing counts running evidence entities only — idle never counts', () => {
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 1, role: 'frontend-dev', agent: 'a1' }),
    ])).agents
    expect(agents.entities).toHaveLength(15)
    expect(agents.executing).toBe(1)
  })
})

/* ---------------------------------------------------------------------------
 * Entity key uniqueness (F-001 — qc1/qc2 Warning): a dispatch row whose
 * session id equals a KNOWN_AGENTS role id while its `role` differs (e.g.
 * `{ agent: 'project-manager', role: 'fullstack-dev' }`) must NEVER yield two
 * entities with the same key — the idle twin is suppressed by the lit key
 * set, so React `key` / `layoutAgents` `cards.set` never collide and
 * `executing` stays consistent with the visible cards.
 * ------------------------------------------------------------------------- */

describe('projectGraph — agents entity key uniqueness (F-001)', () => {
  it('session id == another role id: the lit card occupies the slot, the idle twin is suppressed', () => {
    // `agent` (session id) = 'project-manager' collides with the KNOWN_AGENTS
    // id; the row's `role` is fullstack-dev — the old code emitted a lit
    // card keyed 'project-manager' AND an idle card keyed 'project-manager'.
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'project-manager' }),
    ])).agents
    // No duplicate keys (the invariant the render layer depends on).
    const keys = agents.entities.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    // The lit card exists, is running, and carries the honest role.
    const lit = agents.entities.find((e) => e.key === 'project-manager')!
    expect(lit).toBeDefined()
    expect(lit.idle).toBe(false)
    expect(lit.status).toBe('running')
    expect(lit.role).toBe('fullstack-dev')
    // Exactly ONE card per key — no React duplicate-key twin.
    expect(agents.entities.filter((e) => e.key === 'project-manager')).toHaveLength(1)
    // The suppressed idle twins: neither the collided role id nor the
    // evidenced role id appears among the idle cards.
    const idleKeys = agents.entities.filter((e) => e.idle).map((e) => e.key)
    expect(idleKeys).not.toContain('project-manager')
    expect(idleKeys).not.toContain('fullstack-dev')
    // 1 lit + 13 idle = 14 unique cards (the collided roster slot is the lit card).
    expect(agents.entities).toHaveLength(14)
    // `executing` matches the visible cards (1 running lit card — no hidden
    // duplicate to disagree with the summary).
    expect(agents.executing).toBe(1)
  })

  it('collision via an unexpected role (agent = KNOWN_AGENTS id, role not in the roster) — same suppression', () => {
    // role 'scout' is unexpected (no idle card for it anyway); the session id
    // 'explore' collides with the KNOWN_AGENTS 'explore' → idle twin suppressed.
    const agents = projectGraph(flowSource([
      dispatchRow({ ts: 7, role: 'scout', agent: 'explore' }),
    ])).agents
    const keys = agents.entities.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(agents.entities.filter((e) => e.key === 'explore')).toHaveLength(1)
    expect(agents.entities.find((e) => e.key === 'explore')!.idle).toBe(false)
    // 1 lit + 14 idle (the other 14 roster members; 'explore' slot = lit card).
    expect(agents.entities).toHaveLength(15)
    expect(agents.executing).toBe(1)
  })

  it('key-uniqueness invariant holds across degraded / empty / evidence / collision states', () => {
    for (const agents of [
      projectGraph(fullSource).agents, // degraded: agentFlow null
      projectGraph(flowSource([])).agents, // empty: 0 events
      projectGraph(flowSource([dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' })])).agents,
      projectGraph(flowSource([dispatchRow({ ts: 7, role: 'fullstack-dev', agent: 'project-manager' })])).agents,
      projectGraph(flowSource([dispatchRow({ ts: 7, role: 'scout', agent: 'explore' })])).agents,
    ]) {
      const keys = agents.entities.map((e) => e.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

/* ---------------------------------------------------------------------------
 * Top-level events / unexpected (spec §3 — migrated from flow.events /
 * flow.unexpected; FlowEventView projection unchanged).
 * ------------------------------------------------------------------------- */

describe('projectGraph — events / unexpected (spec §3 migration)', () => {
  it('agentFlow null → no events, no unexpected (the degraded marker lives on agents)', () => {
    const view = projectGraph(fullSource)
    expect(view.events).toEqual([])
    expect(view.unexpected).toEqual([])
  })

  it('source null → same empty event seats (total function)', () => {
    const view = projectGraph(null)
    expect(view.events).toEqual([])
    expect(view.unexpected).toEqual([])
  })

  it('projects events latest-first with status coloring and the stage mapping', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 6, role: 'fullstack-dev', verdict: 'ok' }),
      dispatchRow({ ts: 5, role: 'fullstack-dev', verdict: 'advisory' }),
      dispatchRow({ ts: 4, role: 'fullstack-dev', verdict: 'denied' }),
      settleRow({ ts: 3, outcome: 'ok' }),
      settleRow({ ts: 2, outcome: 'error' }),
      settleRow({ ts: 1, outcome: 'denied' }),
    ]))
    expect(view.events.map((e) => e.status)).toEqual(['dispatched', 'advisory', 'denied', 'ok', 'error', 'denied'])
    const implement = view.events.find((e) => e.role === 'fullstack-dev')!
    expect(implement.stage).toEqual({ phase: 'autonomous-execute', stage: 'sdd-implement' })
    expect(implement.expected).toBe(true)
    expect(view.unexpected).toEqual([])
  })

  it('settle rows carry no role: they never flag unexpected', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 3, role: 'frontend-dev', agent: 'a1' }),
      settleRow({ ts: 2, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 1, role: 'scout' }), // off-pipeline dispatch → unexpected
    ]))
    const settle = view.events.find((e) => e.kind === 'settle')!
    expect(settle.role).toBe('')
    expect(settle.expected).toBe(false)
    // unexpected = off-pipeline-role DISPATCHES only — settles never appear.
    expect(view.unexpected.map((e) => e.role)).toEqual(['scout'])
  })

  it('keeps only the latest 50 events, latest-first', () => {
    const events = Array.from({ length: 60 }, (_, i) => dispatchRow({ ts: 60 - i, role: 'fullstack-dev' }))
    const view = projectGraph(flowSource(events))
    expect(view.events).toHaveLength(50)
    expect(view.events[0]!.ts).toBe(60)
    expect(view.events[49]!.ts).toBe(11)
  })

  it('id = `${ts}-${kind}-${index}` — unique even for equal ts+kind, stable across projections', () => {
    const events = [
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      dispatchRow({ ts: 5, role: 'fullstack-dev' }),
      settleRow({ ts: 5 }),
    ]
    const ids = projectGraph(flowSource(events)).events.map((e) => e.id)
    expect(ids).toEqual(['5-dispatch-0', '5-dispatch-1', '5-settle-2'])
    // Same source → same ids (React keys stay stable).
    expect(projectGraph(flowSource(events)).events.map((e) => e.id)).toEqual(ids)
  })

  it('unexpected list preserves the latest-first event order', () => {
    const view = projectGraph(flowSource([
      dispatchRow({ ts: 4, role: 'scout' }),
      dispatchRow({ ts: 3, role: 'general' }),
      dispatchRow({ ts: 2, role: 'fullstack-dev' }),
      settleRow({ ts: 1 }),
    ]))
    expect(view.unexpected.map((e) => e.ts)).toEqual([4, 3])
  })
})

describe('projectGraph — settle pairing (shared pairSettleIndexes)', () => {
  it('a settle pairs with the most recent same-agent dispatch BEFORE it in file order', () => {
    // File order: D1(a1, t1) → D2(a1, t3) → S1(a1, t4); the catalog is latest-first.
    const view = projectGraph(flowSource([
      settleRow({ ts: 4, agent: 'a1', outcome: 'ok' }),
      dispatchRow({ ts: 3, role: 'fullstack-dev', agent: 'a1' }),
      dispatchRow({ ts: 1, role: 'fullstack-dev', agent: 'a1' }),
    ]))
    const [s1, d2, d1] = view.events
    expect(d1!.settled).toBe(false)
    expect(d2!.settled).toBe(true)
    expect(s1!.settled).toBe(false) // settle rows are never "settled" themselves
  })

  it('the shared pure function returns the paired dispatch index set', () => {
    const rows = [
      { kind: 'settle' as const, agent: 'a1' },
      { kind: 'dispatch' as const, agent: 'a1' },
      { kind: 'dispatch' as const, agent: 'a1' },
      { kind: 'dispatch' as const, agent: null },
    ]
    expect(Array.from(pairSettleIndexes(rows)).sort((a, b) => a - b)).toEqual([1])
  })

  it('different agents never pair; agent-less rows never pair', () => {
    const view = projectGraph(flowSource([
      settleRow({ ts: 3, agent: 'a2', outcome: 'ok' }),
      settleRow({ ts: 2, outcome: 'ok' }), // agent null
      dispatchRow({ ts: 1, role: 'fullstack-dev' }), // agent null
    ]))
    expect(view.events.every((e) => !e.settled)).toBe(true)
  })
})

/* ---------------------------------------------------------------------------
 * Totality + the spec §8 degradation matrix (never throw, never guess).
 * ------------------------------------------------------------------------- */

describe('projectGraph — totality (spec §8)', () => {
  it('source null → legal empty ZoneView, everything degraded, never a throw', () => {
    const v = projectGraph(null)
    expect(v.iteration.active).toBe(false)
    expect(v.iteration.steps).toHaveLength(5)
    expect(v.iteration.steps.every((s) => s.state === 'idle')).toBe(true)
    expect(v.iteration.currentStep).toBeNull()
    expect(v.iteration.branches).toBeNull()
    expect(v.tasks.columns).toHaveLength(6)
    expect(v.tasks.columns.every((c) => c.count === 0)).toBe(true)
    expect(v.tasks.total).toBe(0)
    expect(v.tasks.truncated).toBe(false)
    expect(v.agents.degraded).toBe(true)
    expect(v.verdict).toBe('unknown')
    expect(v.violations).toEqual([])
    expect(v.events).toEqual([])
    expect(v.unexpected).toEqual([])
    expect(v.degraded).toEqual({ iteration: true, state: true, plans: true })
  })

  it('never throws on a structurally garbage source (spec §8 full-garbage row)', () => {
    expect(() => projectGraph({ garbage: true } as unknown as MstarEngineStatusSource)).not.toThrow()
    expect(() => projectGraph({ iteration: 'not-an-object', state: 42 } as unknown as MstarEngineStatusSource)).not.toThrow()
    expect(() => projectGraph({ iteration: { gate: { transition: { deep: true } } } } as unknown as MstarEngineStatusSource)).not.toThrow()
  })

  it('prototype-key transitions (__proto__/constructor/toString/hasOwnProperty) degrade, never crash', () => {
    // Plain-object lookups hit Object.prototype inherited values (truthy) for these
    // keys — they must take the illegal-transition path, not the current-step path.
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
      expect(v.iteration.active).toBe(false)
      expect(v.iteration.currentStep).toBeNull()
      expect(v.iteration.steps.every((s) => s.state === 'idle')).toBe(true)
      expect(v.degraded.iteration).toBe(true)
    }
  })

  it('never throws on garbage agent-flow rows; unclassifiable rows are skipped, valid rows still project', () => {
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
    const view = projectGraph(source)
    expect(view.events.map((e) => e.ts)).toEqual([8, 7, 6, 5])
    expect(view.events.map((e) => e.kind)).toEqual(['dispatch', 'settle', 'dispatch', 'settle'])
    expect(view.events.map((e) => e.status)).toEqual(['dispatched', 'ok', 'dispatched', 'error'])
    expect(view.events[3]!.durationMs).toBe(120)
    expect(view.unexpected.map((e) => e.role)).toEqual(['']) // the role-42 dispatch degrades to ''
    expect(view.agents.degraded).toBe(false)
    expect(view.agents.empty).toBe(false)
  })

  it('spec §8 matrix: iteration disabled + state null degrades zones independently', () => {
    // iteration absent + state null (no-harness predicate) → iteration
    // disabled AND tasks skeleton degraded AND agents skeleton degraded.
    const v = projectGraph(noHarnessSource)
    expect(v.iteration.active).toBe(false)
    expect(v.tasks.columns.every((c) => c.count === 0)).toBe(true)
    expect(v.degraded).toEqual({ iteration: true, state: true, plans: true })
  })
})

/** Compile-time pin: ZoneView fields referenced by the render layer stay stable (spec §3). */
describe('projectGraph — ZoneView shape (spec §3)', () => {
  it('types steps/columns as the documented unions', () => {
    const view = projectGraph(fullSource)
    const phaseIds: PhaseId[] = view.iteration.steps.map((s) => s.id)
    const stateIds: PlanStateId[] = view.tasks.columns.map((c) => c.id)
    expect(phaseIds).toContain('merge-ready')
    expect(stateIds).toContain('unknown')
    expect(view.tasks.columns[0]!.capped).toBeNull()
    expect(view.iteration.verdict).toBe('pass')
  })
})
