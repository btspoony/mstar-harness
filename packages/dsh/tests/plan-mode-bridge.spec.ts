/**
 * PlanMode bridge tests (plan  Task 4b — N-B3; D4 selected-compass
 * attribution): the Prepare-phase flag flip — a one-way mirror of the harness
 * Prepare state (the SELECTED lifecycle's OWN compass `status: active|locked`
 * AND ≥1 plan row `Todo` in its snapshot — the Prepare window) into the host
 * plan-mode session state (`ctx.get('planMode')` STRUCTURAL view — no peer
 * dependency; upstream `set` is idempotent, `'noop'` when already in
 * target). The bridge is fake-testable: `syncPlanMode` receives the
 * planMode view + a per-workspace resolver, so every branch is exercised
 * against an in-memory fake — root filter, Prepare-window target, the
 * session-scoped selection (lease / durable pick; unbound ⇒ NO set),
 * idempotent `'noop'` no-churn, the `subagent/start` root-walk decision
 * point, and the service-missing degrade.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { SessionHint } from '../src/gates/workflow-selection.ts'
import { seedActiveWorkflow, seedHarness } from './harness.ts'
import {
  planModeTarget,
  registerPlanModeBridge,
  setPlanModeBridgeLogger,
  syncPlanMode,
} from '../src/gates/plan-mode-bridge.ts'

/** The lifecycle the default fixtures seed (workflow id === iteration id — the real v3 shape). */
const ITER = 'iter-00000816-pm'

async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  return { root, harnessDir }
}

/**
 * Seed N ACTIVE lifecycles (the v3 registry), each snapshot carrying its plan
 * rows (the Prepare-window probe) and its own `compass_ref` (the D4
 * attribution key: the compass frontmatter's `iteration_id` must equal the
 * snapshot id). `compass: null` omits the reference entirely (a lifecycle with
 * no compass at all).
 */
async function seedLifecycles(
  harnessDir: string,
  rows: Array<{
    iterationId: string
    plans: Array<{ id: string; status: string }>
    compass?: 'active' | 'locked' | 'completed' | null
    compassRef?: string
  }>,
): Promise<void> {
  const root = dirname(harnessDir)
  for (const row of rows) {
    const compass = row.compass === undefined ? 'active' : row.compass
    const ref = row.compassRef ?? (compass === null ? null : `iterations/${row.iterationId}/delivery-compass.md`)
    const plans = row.plans.map((plan) => ({ ...plan, title: plan.id, file: `plans/${plan.id}.md` }))
    const snapshotOverrides: Record<string, unknown> = { type: 'iteration' }
    if (ref !== null) snapshotOverrides.compass_ref = ref
    await seedActiveWorkflow(harnessDir, row.iterationId, plans, snapshotOverrides, `seed-${row.iterationId}`, root, row.iterationId)
    if (compass !== null && row.compassRef === undefined) {
      await seedHarness(harnessDir, {
        [`iterations/${row.iterationId}/delivery-compass.md`]: `---\niteration_id: ${row.iterationId}\nstatus: ${compass}\n---\n`,
      })
    }
  }
}

/**
 * Durably bind a session to one active workflow (the picker's own store
 * primitive — the exact record the T3 endpoint commits).
 */
async function seedBinding(harnessDir: string, sessionId: string, cwd: string, workflowId: string): Promise<void> {
  const written = updateWorkflowSessionBinding(harnessDir, sessionId, cwd, {
    selectedWorkflowId: workflowId,
    excludedBeforeSeq: 0,
  })
  expect(written.kind).toBe('written')
}

/** A root-like agent (no `header.parentSession` — the T1-verified discriminator). */
const rootAgent = (cwd: string, id = 'root-1'): unknown => ({ id, session: { header: { cwd, id } } })

/** A child agent (in-process subagent: `parentSession` stamped at creation). */
const childAgent = (cwd: string): unknown => ({ id: 'child-1', session: { header: { cwd, parentSession: 'root-1' } } })
/** Let the async ACTIVE workflow read started by a host event settle. */
const settlePlanModeBridge = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

/**
 * The fake registered as a cordis `planMode` service (`ctx.get('planMode')` —
 * the structural read the bridge performs). Mirrors the upstream semantics
 * the bridge relies on (`plan-mode/src/index.ts:403-445`): `get` folds the
 * logged state (+ a pending selection when present) and `set` returns
 * `'noop'` WITHOUT appending a `plan/mode` event when the target already
 * matches — the churn meter is `events`.
 */
class FakePlanModeService extends Service {
  active = false
  pending: boolean | undefined
  /** Appended durable `plan/mode` session events (the churn meter). */
  events: Array<{ active: boolean }> = []
  setCalls = 0

  constructor(ctx: Context) {
    super(ctx, 'planMode')
  }

  get(agent: unknown): { active: boolean; pending?: boolean } {
    return this.pending === undefined ? { active: this.active } : { active: this.active, pending: this.pending }
  }

  set(agent: unknown, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    this.setCalls += 1
    const target = this.pending ?? this.active
    if (active === target) return 'noop'
    this.active = active
    this.pending = undefined
    this.events.push({ active })
    return 'committed'
  }
}

/** Minimal structural `agents` service for the `subagent/start` root-walk tests. */
class FakeAgentRegistry extends Service {
  private readonly live = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  register(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null || !('id' in agent)) return
    const id = agent.id
    if (typeof id === 'string') this.live.set(id, agent)
  }

  get(id: string): unknown {
    return this.live.get(id)
  }
}

describe('planMode bridge — planModeTarget (Prepare-window policy)', () => {
  it('the selected lifecycle own active compass + ≥1 plan row Todo → true (the Prepare window)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-on-')
    try {
      await seedLifecycles(harnessDir, [{
        iterationId: ITER,
        plans: [
          { id: 'plan-a', status: 'Todo' },
          { id: 'plan-b', status: 'InProgress' },
        ],
      }])
      expect(await planModeTarget(harnessDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a locked compass also steers → true', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-locked-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }], compass: 'locked' }])
      expect(await planModeTarget(harnessDir)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('all plans ≥ InProgress (no Todo row) → false', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-progress-')
    try {
      await seedLifecycles(harnessDir, [{
        iterationId: ITER,
        plans: [
          { id: 'plan-a', status: 'InProgress' },
          { id: 'plan-b', status: 'Done' },
        ],
      }])
      expect(await planModeTarget(harnessDir)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no compass_ref / completed compass / mismatched compass are not Prepare-window targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-planmode-target-noiter-'))
    const noCompass = join(root, 'no-compass')
    const completed = join(root, 'completed')
    const mismatch = join(root, 'mismatch')
    try {
      await seedLifecycles(noCompass, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }], compass: null }])
      expect(await planModeTarget(noCompass)).toBe(false)
      await seedLifecycles(completed, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }], compass: 'completed' }])
      expect(await planModeTarget(completed)).toBe(false)
      await seedLifecycles(mismatch, [{
        iterationId: ITER,
        plans: [{ id: 'plan-a', status: 'Todo' }],
        compassRef: 'iterations/iter-other/delivery-compass.md',
      }])
      await seedHarness(mismatch, {
        'iterations/iter-other/delivery-compass.md': '---\niteration_id: iter-other\nstatus: active\n---\n',
      })
      expect(await planModeTarget(mismatch)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Disposition — traversal/absolute refs in hand-edited snapshot.json were a file-route contract; ACTIVE producers reject invalid compass refs before selection.

  // Disposition — missing/plan-less status.json and snapshot.json cases tested retired file resolution; ACTIVE authority has no corresponding document read.
  it('an ACTIVE workflow with no plan rows is outside the Prepare window', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-emptyplans-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [] }])
      expect(await planModeTarget(harnessDir)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('unbound multi-active (two actives, no lease/cwd/pick) → undefined, never a fabricated false', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-unbound-')
    try {
      await seedLifecycles(harnessDir, [
        { iterationId: 'iter-a', plans: [{ id: 'plan-a', status: 'Todo' }] },
        { iterationId: 'iter-b', plans: [{ id: 'plan-b', status: 'Todo' }] },
      ])
      expect(await planModeTarget(harnessDir)).toBeUndefined()
      // A hint that matches NEITHER lifecycle is just as unbound.
      expect(await planModeTarget(harnessDir, { cwd: root, sessionId: 'root-1' })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the session durable pick decides which lifecycle (and which compass) plan mode mirrors — not registry order', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-target-pick-')
    try {
      await seedLifecycles(harnessDir, [
        { iterationId: 'iter-a', plans: [{ id: 'plan-a', status: 'InProgress' }] },
        { iterationId: 'iter-b', plans: [{ id: 'plan-b', status: 'Todo' }] },
      ])
      const hint = (selectedWorkflowId: string): SessionHint => ({ cwd: root, sessionId: 'root-1', selectedWorkflowId })
      // Same cwd for both sessions: only the durable pick separates them.
      expect(await planModeTarget(harnessDir, hint('iter-a'))).toBe(false)
      expect(await planModeTarget(harnessDir, hint('iter-b'))).toBe(true)
      // A pick naming a NON-active id falls through to the unbound state.
      expect(await planModeTarget(harnessDir, hint('iter-gone'))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('planMode bridge — syncPlanMode (root filter + set)', () => {
  it('Prepare window → set(agent, true) commits one plan/mode event', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-on-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const planMode = new FakePlanModeService(new Context())
      const ok = await syncPlanMode(rootAgent(root), { resolver: new HarnessResolver(harnessDir), planMode })

      expect(ok).toBe(true)
      expect(planMode.active).toBe(true)
      expect(planMode.events).toEqual([{ active: true }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no Prepare window (all plans ≥ InProgress) → set(agent, false) — already off → noop, zero churn', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-off-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'InReview' }] }])
      const planMode = new FakePlanModeService(new Context())
      const ok = await syncPlanMode(rootAgent(root), { resolver: new HarnessResolver(harnessDir), planMode })

      // The sync ran (set called with false) — but the session is ALREADY in
      // the default OFF state, so upstream set returns 'noop' and appends NO
      // plan/mode event (the no-churn guarantee, OFF direction).
      expect(ok).toBe(true)
      expect(planMode.setCalls).toBe(1)
      expect(planMode.active).toBe(false)
      expect(planMode.events).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('unbound multi-active → NO set at all (never a fabricated false for a lifecycle the session never selected)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-unbound-')
    try {
      await seedLifecycles(harnessDir, [
        { iterationId: 'iter-a', plans: [{ id: 'plan-a', status: 'Todo' }] },
        { iterationId: 'iter-b', plans: [{ id: 'plan-b', status: 'Todo' }] },
      ])
      const planMode = new FakePlanModeService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      const ok = await syncPlanMode(rootAgent(root), { resolver, planMode })

      expect(ok).toBe(false)
      expect(planMode.setCalls).toBe(0)
      expect(planMode.events).toEqual([])

      // The durable pick binds the session → the sync mirrors that
      // lifecycle's Prepare state (and only then).
      await seedBinding(harnessDir, 'root-1', root, 'iter-b')
      expect(await syncPlanMode(rootAgent(root), { resolver, planMode })).toBe(true)
      expect(planMode.events).toEqual([{ active: true }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('child agent → not set (root filter; false, zero set calls)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-child-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const planMode = new FakePlanModeService(new Context())
      const ok = await syncPlanMode(childAgent(root), { resolver: new HarnessResolver(harnessDir), planMode })

      expect(ok).toBe(false)
      expect(planMode.setCalls).toBe(0)
      expect(planMode.events).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('unresolvable harness → false, zero set calls', async () => {
    const { root } = await tempHarness('dsh-planmode-sync-noresolver-')
    try {
      const plainWorkspace = join(root, 'plain-workspace')
      await mkdir(plainWorkspace, { recursive: true })
      const planMode = new FakePlanModeService(new Context())
      const ok = await syncPlanMode(rootAgent(plainWorkspace), { resolver: new HarnessResolver(undefined), planMode })

      expect(ok).toBe(false)
      expect(planMode.setCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('planMode service absent → false (inert, no throw)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-absent-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      expect(await syncPlanMode(rootAgent(root), { resolver: new HarnessResolver(harnessDir), planMode: undefined })).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('noop semantics: already in target → the repeated evaluation produces NO new plan/mode event (no churn)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-sync-noop-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const planMode = new FakePlanModeService(new Context())
      const resolver = new HarnessResolver(harnessDir)

      expect(await syncPlanMode(rootAgent(root), { resolver, planMode })).toBe(true)
      expect(planMode.events).toEqual([{ active: true }])

      // Same harness state again (the decision-point re-evaluation): the fake
      // set returns 'noop' (upstream `if (active === target) return 'noop'`) —
      // the event log stays ONE entry, no churn.
      expect(await syncPlanMode(rootAgent(root), { resolver, planMode })).toBe(true)
      expect(planMode.setCalls).toBe(2)
      expect(planMode.events).toEqual([{ active: true }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('planMode bridge — apply wiring (agent/created + subagent/start decision point)', () => {
  it('session-start mirrors the ROOT; a child session-start is filtered (no set on the child)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-wiring-start-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const ctx = new Context()
      const planMode = new FakePlanModeService(ctx)
      const prior = setPlanModeBridgeLogger(() => {})
      try {
        registerPlanModeBridge(ctx, new HarnessResolver(harnessDir))
        ctx.events.emit('agent/created', { agent: rootAgent(root), source: 'fresh' })
        await settlePlanModeBridge()

        expect(planMode.active).toBe(true)
        expect(planMode.events).toEqual([{ active: true }])
      } finally {
        setPlanModeBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('subagent/start decision point: the parentSession root walk re-evaluates idempotently; a mid-session Prepare flip flips the flag', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-wiring-decision-')
    try {
      await seedLifecycles(harnessDir, [
        { iterationId: 'iter-a', plans: [{ id: 'plan-a', status: 'Todo' }] },
        { iterationId: 'iter-b', plans: [{ id: 'plan-b', status: 'InProgress' }] },
      ])
      const ctx = new Context()
      const planMode = new FakePlanModeService(ctx)
      const agents = new FakeAgentRegistry(ctx)
      const resolver = new HarnessResolver(harnessDir)
      const rootFixture = { id: 'root-d1', session: { header: { id: 'root-d1', cwd: root } } }
      const child = { id: 'child-d1', session: { header: { cwd: root, parentSession: 'root-d1' } } }
      agents.register(rootFixture)
      agents.register(child)
      const prior = setPlanModeBridgeLogger(() => {})
      try {
        registerPlanModeBridge(ctx, resolver)
        await seedBinding(harnessDir, 'root-d1', root, 'iter-a')
        ctx.events.emit('agent/created', { agent: rootFixture, source: 'fresh' })
        await settlePlanModeBridge()
        expect(planMode.events).toEqual([{ active: true }])
        // Decision point with the SAME Prepare state → idempotent no-op (no churn).
        ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'child-d1', local: true })
        await settlePlanModeBridge()
        expect(planMode.setCalls).toBe(2)

        // The Prepare window closes mid-session (the plan advances past Todo) →
        // the decision point flips the root flag back OFF.
        await seedBinding(harnessDir, 'root-d1', root, 'iter-b')
        ctx.events.emit('subagent/start', { runId: 'run-2', provider: 'in-process', id: 'child-d1', local: true })
        await settlePlanModeBridge()
        expect(planMode.events).toEqual([{ active: true }, { active: false }])
        expect(planMode.active).toBe(false)
      } finally {
        setPlanModeBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing resolver on session-start → contained sync warn ("planMode bridge sync failed"), the emit never throws ', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-catch-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const ctx = new Context()
      const planMode = new FakePlanModeService(ctx)
      const captured: string[] = []
      const prior = setPlanModeBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        class ThrowingResolver extends HarnessResolver {
          override forAgent(_agent: unknown): string | null {
            throw new Error('planmode resolver boom')
          }
        }
        registerPlanModeBridge(ctx, new ThrowingResolver(harnessDir))
        expect(() => ctx.events.emit('agent/created', { agent: rootAgent(root), source: 'fresh' })).not.toThrow()
        await settlePlanModeBridge()
        const warn = captured.find((m) => m.startsWith('warn:') && m.includes('planMode bridge sync failed'))
        expect(warn).toBeDefined()
        expect(warn).toContain('planmode resolver boom')
        expect(planMode.setCalls).toBe(0) // the sync never reached the service
      } finally {
        setPlanModeBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('planMode service absent → ONE debug log at registration; emits never throw (optional-unit degrade)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-planmode-wiring-absent-')
    try {
      await seedLifecycles(harnessDir, [{ iterationId: ITER, plans: [{ id: 'plan-a', status: 'Todo' }] }])
      const ctx = new Context()
      const captured: string[] = []
      const prior = setPlanModeBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerPlanModeBridge(ctx, new HarnessResolver(harnessDir))
        expect(captured).toContain('debug: planMode service absent — plan-mode bridge disabled (composition without @deepseek-ai/dsh-plan-mode)')

        expect(() => {
          ctx.events.emit('agent/created', { agent: rootAgent(root), source: 'fresh' })
          ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'child-1', local: true })
        }).not.toThrow()
        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(0)
      } finally {
        setPlanModeBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
