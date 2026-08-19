/**
 * Goal bridge tests (plan `20260816-dsh-nb2-goal-bridge` Task 2): the
 * one-way mirror of the active iteration objective into the dsh goal service
 * (`ctx.get('goals')` STRUCTURAL view — no peer dependency) with the flat
 * `maxGoalRounds` cap. The mirror is fake-testable: `mirrorIterationGoal`
 * receives the goals view + a per-workspace resolver + the resolved round
 * cap, so every branch is exercised against an in-memory fake — root filter,
 * steering-compass scan (active|locked), objective text contract, the
 * drift rebuild (complete then create) with the stale re-read retry, and
 * the service-missing degrade.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessResolver } from '../src/gates/_shared.ts'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  isRootLikeAgent,
  mirrorIterationGoal,
  registerGoalBridge,
  rootAgentOf,
  setGoalBridgeLogger,
  type GoalRefView,
  type GoalView,
} from '../src/gates/goal-bridge.ts'

/** The complete-flow keyword sequence the goal objective MUST carry verbatim (mstar-host `/goal` rule). */
const FLOW_SEQUENCE = 'iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready'

async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  return { root, harnessDir }
}

async function seedCompass(harnessDir: string, iterationId: string, status: 'active' | 'locked' | 'completed'): Promise<void> {
  const compassPath = join(harnessDir, 'iterations', iterationId, 'delivery-compass.md')
  await mkdir(join(harnessDir, 'iterations', iterationId), { recursive: true })
  await writeFile(compassPath, `---\nstatus: ${status}\n---\n`)
}

/** A root-like agent (no `header.parentSession` — the T1-verified discriminator). */
const rootAgent = (cwd: string): unknown => ({ id: 'root-1', session: { header: { cwd } } })

/** A child agent (in-process subagent: `parentSession` stamped at creation). */
const childAgent = (cwd: string): unknown => ({ id: 'child-1', session: { header: { cwd, parentSession: 'root-1' } } })

interface FakeGoalRecord {
  id: string
  revision: number
  objective: string
  phase: string
  maxGoalRounds: number
}

/** The fake registered as a cordis `goals` service (`ctx.get('goals')` — the structural read the bridge performs). */
class FakeGoalsService extends Service {
  calls: Array<{ op: 'get' | 'create' | 'complete'; args: unknown[] }> = []
  current: FakeGoalRecord | undefined
  /** Consecutive `complete` calls to fail with `GOAL_STALE_REVISION` (0 = never). */
  completeStaleCount = 0

  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  get(agent: unknown): GoalView | undefined {
    this.calls.push({ op: 'get', args: [agent] })
    return this.current
  }

  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): GoalView {
    this.calls.push({ op: 'create', args: [agent, request] })
    // Upstream parity (goal/src/index.ts:244-257): `create` REPLACES a
    // completed goal (fresh revision 1, phase active); every other live
    // phase throws GOAL_ALREADY_EXISTS.
    if (this.current !== undefined && this.current.phase !== 'complete') {
      throw Object.assign(new Error(`goal "${this.current.id}" already exists with phase "${this.current.phase}"`), { code: 'GOAL_ALREADY_EXISTS' })
    }
    this.current = {
      id: 'goal-1',
      revision: 1,
      objective: request.objective,
      phase: 'active',
      maxGoalRounds: request.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
    }
    return this.current as GoalView
  }

  complete(agent: unknown, ref: GoalRefView): GoalView {
    this.calls.push({ op: 'complete', args: [agent, ref] })
    if (this.completeStaleCount > 0) {
      this.completeStaleCount -= 1
      // Simulate the concurrent writer committing BETWEEN the mirror's get and complete:
      // the current goal advances one revision, so the mirror's ref is stale.
      this.current = { ...this.current!, revision: this.current!.revision + 1 }
      throw Object.assign(new Error(`stale goal ref "${ref.id}" revision ${ref.revision}`), { code: 'GOAL_STALE_REVISION' })
    }
    this.current = { ...this.current!, revision: ref.revision + 1, phase: 'complete' }
    return this.current as GoalView
  }
}

/** Minimal structural `agents` service for the `subagent/start` root-walk tests. */
class FakeAgentRegistry extends Service {
  private readonly live = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  register(agent: unknown): void {
    const id = (agent as { id?: unknown }).id
    if (typeof id === 'string') this.live.set(id, agent)
  }

  get(id: string): unknown {
    return this.live.get(id)
  }
}

describe('goal bridge — mirrorIterationGoal (objective mirror + round cap)', () => {
  it('root-like agent + active compass → create receives the complete-flow objective (iteration id + flow sequence + exit; no sub-stage wording) and the explicit maxGoalRounds', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-create-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-goal-bridge', 'active')
      const goals = new FakeGoalsService(new Context())
      const ok = mirrorIterationGoal(rootAgent(root), { resolver: new HarnessResolver(harnessDir), goals, maxGoalRounds: 42 })

      expect(ok).toBe(true)
      const create = goals.calls.find((c) => c.op === 'create')
      expect(create).toBeDefined()
      const request = create!.args[1] as { objective: string; maxGoalRounds: number }
      expect(request.maxGoalRounds).toBe(42)
      // Text contract (HARD): iteration id + the full keyword sequence + the exit definition.
      expect(request.objective).toContain('iter-20260816-goal-bridge')
      expect(request.objective).toContain(FLOW_SEQUENCE)
      expect(request.objective).toMatch(/exit/i)
      // No sub-stage wording — the goal is the COMPLETE flow, never a sub-stage.
      expect(request.objective).not.toMatch(/Phase 1|only|write the plan|implement one task|specify → clarify → plan/i)
      // get-先行: the goal was read before the create (no GOAL_ALREADY_EXISTS path).
      expect(goals.calls[0]!.op).toBe('get')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a locked compass also steers → create fires with the objective', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-locked-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-locked', 'locked')
      const goals = new FakeGoalsService(new Context())
      const ok = mirrorIterationGoal(rootAgent(root), { resolver: new HarnessResolver(harnessDir), goals, maxGoalRounds: 128 })

      expect(ok).toBe(true)
      expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)
      const request = goals.calls.find((c) => c.op === 'create')!.args[1] as { objective: string }
      expect(request.objective).toContain('iter-20260816-locked')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('completed compass → no goal set (false, zero create/edit calls)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-completed-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-done', 'completed')
      const goals = new FakeGoalsService(new Context())
      const ok = mirrorIterationGoal(rootAgent(root), { resolver: new HarnessResolver(harnessDir), goals, maxGoalRounds: 256 })

      expect(ok).toBe(false)
      expect(goals.calls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no active iteration (iterations dir absent) → no goal set (false)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-noiter-')
    try {
      const goals = new FakeGoalsService(new Context())
      const ok = mirrorIterationGoal(rootAgent(root), { resolver: new HarnessResolver(harnessDir), goals, maxGoalRounds: 256 })

      expect(ok).toBe(false)
      expect(goals.calls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('child agent (parentSession fixture) → no goal set (false) even with an active compass', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-child-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-child', 'active')
      const goals = new FakeGoalsService(new Context())
      const ok = mirrorIterationGoal(childAgent(root), { resolver: new HarnessResolver(harnessDir), goals, maxGoalRounds: 256 })

      expect(ok).toBe(false)
      expect(goals.calls).toHaveLength(0)
      // The root discriminator itself: parentSession absent → root-like; present → not.
      expect(isRootLikeAgent(rootAgent(root))).toBe(true)
      expect(isRootLikeAgent(childAgent(root))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resume: existing goal with matching objective → no duplicate create (no GOAL_ALREADY_EXISTS), no edit, mirror in place (true)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-resume-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-resume', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      // First pass creates the goal (mirror on the FIRST session-start).
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const createdObjective = (goals.calls.find((c) => c.op === 'create')!.args[1] as { objective: string }).objective
      const createsBefore = goals.calls.filter((c) => c.op === 'create').length

      // Resume (re-session-start): the goal exists with the matching objective —
      // get-先行 prevents GOAL_ALREADY_EXISTS; no edit, no create.
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(createsBefore)
      expect(goals.current!.objective).toBe(createdObjective)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('objective drift on a LIVE goal (new active iteration) → complete the old goal FIRST, then create a fresh goal (clean round budget)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-drift-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-first', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)

      // The steering iteration flips (iteration-close → new iteration start):
      // the first compass stops steering, the second one steers. The old goal
      // is still LIVE (phase active) — `create` alone would throw
      // GOAL_ALREADY_EXISTS, so the mirror completes it first (qc3 F-001:
      // the new goal must NOT inherit the old goal's spent round budget).
      await rm(join(harnessDir, 'iterations', 'iter-20260816-first'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-second', 'active')

      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const completes = goals.calls.filter((c) => c.op === 'complete')
      expect(completes).toHaveLength(1)
      // CAS identity: the CURRENT goal's { id, revision }.
      expect(completes[0]!.args[1]).toEqual({ id: 'goal-1', revision: 1 })
      const creates = goals.calls.filter((c) => c.op === 'create')
      expect(creates).toHaveLength(2)
      // The replacement create ALWAYS carries the cap (qc3 F-008).
      const replacement = creates[1]!.args[1] as { objective: string; maxGoalRounds: number }
      expect(replacement.objective).toContain('iter-20260816-second')
      expect(replacement.maxGoalRounds).toBe(64)
      // Fresh goal: revision 1, phase active, new objective — zero round debt.
      expect(goals.current!.objective).toContain('iter-20260816-second')
      expect(goals.current!.phase).toBe('active')
      expect(goals.current!.revision).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('objective drift on a COMPLETED goal (operator completed at iteration-close) → create REPLACES it directly; no edit, no complete (qc2 W-1)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-drift-completed-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-c1', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      // The operator completes the goal at iteration-close (upstream `complete`).
      goals.complete(rootAgent(root), { id: goals.current!.id, revision: goals.current!.revision })
      expect(goals.current!.phase).toBe('complete')

      // New iteration steers → drift. Upstream `create` explicitly replaces a
      // completed goal ("A completed goal may be replaced" — goal/src/
      // index.ts:244-257): fresh revision 1, phase active, zero rounds.
      // NEVER a CAS edit — edit preserves phase, which would leave a
      // completed goal describing the ACTIVE iteration (a false "done").
      await rm(join(harnessDir, 'iterations', 'iter-20260816-c1'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-c2', 'active')

      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const creates = goals.calls.filter((c) => c.op === 'create')
      expect(creates).toHaveLength(2)
      // The only complete in the call log is the TEST's own operator complete
      // (the mirror replaces a completed goal with create alone — the
      // `edit` path is gone from the bridge surface entirely).
      expect(goals.calls.filter((c) => c.op === 'complete')).toHaveLength(1)
      const replacement = creates[1]!.args[1] as { objective: string; maxGoalRounds: number }
      expect(replacement.objective).toContain('iter-20260816-c2')
      expect(replacement.maxGoalRounds).toBe(64)
      expect(goals.current!.phase).toBe('active')
      expect(goals.current!.revision).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stale complete (GOAL_STALE_REVISION) → re-read once and retry the drift rebuild with the fresh ref', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-stale-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-stale', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      // Drift + a concurrent mutation between get and complete.
      await rm(join(harnessDir, 'iterations', 'iter-20260816-stale'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-stale2', 'active')
      goals.completeStaleCount = 1 // the FIRST complete stales; the fake bumps the revision as the concurrent commit

      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const completes = goals.calls.filter((c) => c.op === 'complete')
      expect(completes).toHaveLength(2)
      // First complete used the STALE ref; the retry used the FRESH revision.
      const firstRef = completes[0]!.args[1] as GoalRefView
      const retryRef = completes[1]!.args[1] as GoalRefView
      expect(firstRef.revision).toBe(1)
      expect(retryRef.revision).toBe(2)
      // The drift rebuild then created the fresh goal for the new iteration.
      expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(2)
      expect(goals.current!.objective).toContain('iter-20260816-stale2')
      expect(goals.current!.phase).toBe('active')
      expect(goals.current!.revision).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stale complete twice → warn + abandon (false; no third attempt)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-stale2-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-stale-a', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      await rm(join(harnessDir, 'iterations', 'iter-20260816-stale-a'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-stale-b', 'active')
      goals.completeStaleCount = 2 // BOTH the first complete AND the re-read retry stale

      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(false)
        expect(goals.calls.filter((c) => c.op === 'complete')).toHaveLength(2)
        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)
        expect(captured.some((m) => m.startsWith('warn:') && m.includes('GOAL_STALE_REVISION'))).toBe(true)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('goals service missing → mirror false; registerGoalBridge logs ONE debug and stays inert on emit', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-absent-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-absent', 'active')
      // Direct call with no goals view → false, no crash.
      expect(mirrorIterationGoal(rootAgent(root), { resolver: new HarnessResolver(harnessDir), goals: undefined, maxGoalRounds: 256 })).toBe(false)

      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        expect(captured).toHaveLength(1)
        expect(captured[0]).toBe('debug: goals service absent — goal bridge disabled (composition without @deepseek-ai/dsh-goal)')
        // Emits stay inert (no goals service to reach) — never a throw.
        expect(() => ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })).not.toThrow()
        expect(() => ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'child-1', local: true })).not.toThrow()
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('goal bridge — apply wiring (agent/session-start + subagent/start decision point)', () => {
  it('absent maxGoalRounds config → create receives the module default 256', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-default-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-default', 'active')
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const prior = setGoalBridgeLogger(() => {})
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })

        const create = goals.calls.find((c) => c.op === 'create')
        expect(create).toBeDefined()
        const request = create!.args[1] as { maxGoalRounds: number }
        expect(request.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
        expect(DEFAULT_MAX_GOAL_ROUNDS).toBe(256)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('session-start mirrors the ROOT agent; a child session-start is filtered (no goal on the child)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-wiring-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-wiring', 'active')
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const prior = setGoalBridgeLogger(() => {})
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })
        ctx.events.emit('agent/session-start', { agent: childAgent(root), source: 'fresh' })

        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)
        const request = goals.calls.find((c) => c.op === 'create')!.args[1] as { objective: string }
        expect(request.objective).toContain('iter-20260816-wiring')
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('subagent/start decision point: the parentSession root walk re-evaluates idempotently (in place → no churn; drift → complete + fresh create)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-decision-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-d1', 'active')
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const agents = new FakeAgentRegistry(ctx)
      const resolver = new HarnessResolver(harnessDir)
      // The root + a child whose parentSession chain reaches the root (in-process subagent).
      const rootAgentFixture = { id: 'root-d1', session: { header: { cwd: root } } }
      const child = { id: 'child-d1', session: { header: { cwd: root, parentSession: 'root-d1' } } }
      agents.register(rootAgentFixture)
      agents.register(child)
      const prior = setGoalBridgeLogger(() => {})
      try {
        registerGoalBridge(ctx, resolver, {})
        // First session-start creates the goal for iteration d1.
        ctx.events.emit('agent/session-start', { agent: rootAgentFixture, source: 'fresh' })
        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)

        // Decision point with the SAME steering iteration → idempotent no-op (no churn).
        ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'child-d1', local: true })
        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)
        expect(goals.calls.filter((c) => c.op === 'complete')).toHaveLength(0)

        // The steering iteration flips mid-session → the decision point
        // completes the old goal and creates a fresh one for the new iteration.
        await rm(join(harnessDir, 'iterations', 'iter-20260816-d1'), { recursive: true, force: true })
        await seedCompass(harnessDir, 'iter-20260816-d2', 'active')
        ctx.events.emit('subagent/start', { runId: 'run-2', provider: 'in-process', id: 'child-d1', local: true })

        const completes = goals.calls.filter((c) => c.op === 'complete')
        expect(completes).toHaveLength(1)
        expect(completes[0]!.args[1]).toEqual({ id: 'goal-1', revision: 1 })
        expect(goals.current!.objective).toContain('iter-20260816-d2')
        expect(goals.current!.phase).toBe('active')
        expect(goals.current!.revision).toBe(1)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rootAgentOf: a 2+ hop parentSession CYCLE returns undefined (seen-set guard — upstream liveLineage precedent; qc2 W-2)', () => {
    // A→B→A: no root reachable — the walk must break on the REVISITED id
    // instead of spinning forever (the sync decision-point listeners hang
    // otherwise). The current 1-cycle guard (parent === current) cannot see
    // this — the guard needs a seen-set over session ids.
    const agentA = { id: 'cycle-a', session: { header: { parentSession: 'cycle-b' } } }
    const agentB = { id: 'cycle-b', session: { header: { parentSession: 'cycle-a' } } }
    const registry = { get: (id: string) => (id === 'cycle-a' ? agentA : id === 'cycle-b' ? agentB : undefined) }
    expect(rootAgentOf(agentA, registry)).toBeUndefined()
    expect(rootAgentOf(agentB, registry)).toBeUndefined()
  })

  it('subagent/start decision point: a 2+ hop parentSession CYCLE in the live registry does not hang the listener (no goal mirrored)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-cycle-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-cycle', 'active')
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const agents = new FakeAgentRegistry(ctx)
      // 2-cycle fixture: A.parentSession = B.id AND B.parentSession = A.id.
      const agentA = { id: 'cycle-a', session: { header: { cwd: root, parentSession: 'cycle-b' } } }
      const agentB = { id: 'cycle-b', session: { header: { cwd: root, parentSession: 'cycle-a' } } }
      agents.register(agentA)
      agents.register(agentB)
      const prior = setGoalBridgeLogger(() => {})
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        // The decision point MUST return promptly (no infinite loop) and
        // must NOT mirror any goal (the walk abandons on the revisited id).
        expect(() => {
          ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'cycle-a', local: true })
        }).not.toThrow()
        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(0)
        expect(goals.calls.filter((c) => c.op === 'complete')).toHaveLength(0)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalid maxGoalRounds config (non-positive / non-integer) → ONE warn + fallback to the module default; the mirror still proceeds (qc3 F-004)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-badcap-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-badcap', 'active')
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), { maxGoalRounds: 0 })
        ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })

        const create = goals.calls.find((c) => c.op === 'create')
        expect(create).toBeDefined()
        // The invalid value never reaches the service — the module default is used.
        const createRequest = create!.args[1] as { maxGoalRounds: number } // the fake's own create request shape (test fixture)
        expect(createRequest.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
        // ONE loud warn at registration (misconfiguration, not a transient service issue).
        const warn = captured.filter((m) => m.startsWith('warn:') && m.includes('maxGoalRounds'))
        expect(warn).toHaveLength(1)
        expect(warn[0]).toContain('falling back')
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('negative / non-integer maxGoalRounds config → same fallback; a VALID cap passes through unwarned (control)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-badcap2-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-badcap2', 'active')
      for (const bad of [-5, 3.5]) {
        const ctx = new Context()
        const goals = new FakeGoalsService(ctx)
        const captured: string[] = []
        const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
        try {
          registerGoalBridge(ctx, new HarnessResolver(harnessDir), { maxGoalRounds: bad })
          ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })
          const createRequest = goals.calls.find((c) => c.op === 'create')!.args[1] as { maxGoalRounds: number } // the fake's own create request shape (test fixture)
          expect(createRequest.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
          expect(captured.filter((m) => m.startsWith('warn:') && m.includes('maxGoalRounds'))).toHaveLength(1)
        } finally {
          setGoalBridgeLogger(prior)
        }
      }
      // Control: a valid cap passes through with NO warn.
      const ctx = new Context()
      const goals = new FakeGoalsService(ctx)
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), { maxGoalRounds: 42 })
        ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })
        const createRequest = goals.calls.find((c) => c.op === 'create')!.args[1] as { maxGoalRounds: number } // the fake's own create request shape (test fixture)
        expect(createRequest.maxGoalRounds).toBe(42)
        expect(captured.filter((m) => m.startsWith('warn:') && m.includes('maxGoalRounds'))).toHaveLength(0)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing AGENT resolver on session-start → contained mirror warn ("goal bridge mirror failed"), the emit never throws (F-006)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-catch-agent-')
    try {
      const ctx = new Context()
      // The mirror is inert without the goals service (returns before the
      // resolver read) — register the fake so the throw is reachable.
      const goals = new FakeGoalsService(ctx)
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        class ThrowingAgentResolver extends HarnessResolver {
          override forAgent(_agent: unknown): string | null {
            throw new Error('resolver agent boom')
          }
        }
        registerGoalBridge(ctx, new ThrowingAgentResolver(harnessDir), {})
        expect(() => ctx.events.emit('agent/session-start', { agent: rootAgent(root), source: 'fresh' })).not.toThrow()
        const warn = captured.find((m) => m.startsWith('warn:') && m.includes('goal bridge mirror failed'))
        expect(warn).toBeDefined()
        expect(warn).toContain('resolver agent boom')
        expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(0) // the sync never reached the service
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * One durable `goal/change` session-event envelope (upstream `GoalChangeMeta`
 * — `{kind, version, operation, goal, roundsStarted, createdAt, updatedAt}`
 * inside the firehose envelope's `data`; the bridge reads it STRUCTURALLY,
 * never trusting the runtime shape). The fixture is built from overrides so
 * every filter branch (operation, phase, version, blockedReason) is driven
 * by the test, not by a shared literal.
 */
function goalChangeEnvelope(overrides: {
  operation?: unknown
  version?: unknown
  phase?: unknown
  blockedReason?: unknown
  objective?: unknown
} = {}): unknown {
  return {
    type: 'goal/change',
    seq: 1,
    time: 1000,
    data: {
      kind: 'goal/change',
      version: overrides.version ?? 1,
      operation: overrides.operation ?? 'edit',
      goal: {
        id: 'goal-1',
        revision: 3,
        objective:
          overrides.objective ??
          'Run iteration iter-20260816-advisory through the complete flow: iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready. Exit: merged.',
        phase: overrides.phase ?? 'active',
        ...(overrides.blockedReason !== undefined ? { blockedReason: overrides.blockedReason } : {}),
        maxGoalRounds: 256,
      },
      roundsStarted: 7,
      createdAt: 100,
      updatedAt: 1000,
    },
  }
}

/** A goal-owning session for the `session/event` firehose (`header.cwd` — the workspace attribution read). */
const goalSession = (cwd: string): unknown => ({ id: 'sess-goal-1', header: { cwd }, events: [] })

describe('goal bridge — blocked sync advisory (session/event firehose)', () => {
  it('operation "block" → ONE warn with blockedReason.code + objective summary + status.json residual pointer; ZERO status.json writes', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-block-')
    try {
      // Seed a status.json fixture — the advisory must NEVER touch it (one-way mirror).
      const statusPath = join(harnessDir, 'status.json')
      const beforeStatus = JSON.stringify({ v: 1, plans: [], residual_findings: {} }, null, 2)
      await writeFile(statusPath, beforeStatus)
      const beforeEntries = (await readdir(harnessDir)).sort()

      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))

        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(1)
        const warn = captured.find((m) => m.startsWith('warn:'))!
        expect(warn).toContain('goal blocked [rounds-exhausted]')
        expect(warn).toContain('max autonomous rounds reached')
        expect(warn).toContain('objective: Run iteration iter-20260816-advisory')
        // v3 residual pointer: the project register, never the root status.json
        // (entries keyed by plan id; no register exists in this bare harness →
        // the default project path).
        expect(warn).toContain(`${harnessDir}/projects/_default/residuals.json`)
        expect(warn).not.toContain(`${harnessDir}/status.json`)
        expect(warn).toMatch(/residual/i)

        // Zero status.json writes: byte-identical fixture + no file created/removed.
        expect(await readFile(statusPath, 'utf8')).toBe(beforeStatus)
        expect((await readdir(harnessDir)).sort()).toEqual(beforeEntries)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('goal.phase "blocked" WITHOUT a block operation (an edit while blocked) also warns once', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-blockedphase-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          operation: 'edit',
          phase: 'blocked',
          blockedReason: { code: 'iteration-closed', message: 'the steering iteration closed' },
        }))

        const warns = captured.filter((m) => m.startsWith('warn:'))
        expect(warns).toHaveLength(1)
        expect(warns[0]).toContain('goal blocked [iteration-closed]')
        expect(warns[0]).toContain(`${harnessDir}/projects/_default/residuals.json`)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('unknown version → silent skip (defensive): zero warns, the emit never throws', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-version-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        expect(() => ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          version: 2,
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))).not.toThrow()
        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(0)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('non-blocked goal/change and non-goal events are filtered (zero warns)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-filter-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        // Active-phase goal mutation — not blocked.
        ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({ operation: 'edit', phase: 'active' }))
        // A completely unrelated firehose envelope.
        ctx.events.emit('session/event', goalSession(root), { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
        // A goal/change envelope with a malformed data payload.
        ctx.events.emit('session/event', goalSession(root), { type: 'goal/change', seq: 2, time: 1, data: 'not-a-record' })

        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(0)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('unresolvable harness → the blocked event is skipped silently (workspace attribution, workflow-ledger precedent)', async () => {
    const { root } = await tempHarness('dsh-goal-bridge-attrib-')
    try {
      // A workspace WITHOUT a harness root (probe resolver — no explicit dir).
      const noHarnessWs = join(root, 'plain-workspace')
      await mkdir(noHarnessWs, { recursive: true })

      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(undefined), {})
        // Session cwd at a workspace with no harness → no attribution → silent skip.
        ctx.events.emit('session/event', { id: 'sess-plain', header: { cwd: noHarnessWs }, events: [] }, goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))
        // No session workspace at all → same skip.
        ctx.events.emit('session/event', { id: 'sess-nocwd', header: {}, events: [] }, goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))
        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(0)

        // Control: a workspace WITH a harness root (.mstar) attributes and warns.
        const ws = join(root, 'workspace')
        const wsHarness = join(ws, '.mstar')
        await mkdir(wsHarness, { recursive: true })
        ctx.events.emit('session/event', { id: 'sess-ws', header: { cwd: ws }, events: [] }, goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))
        const warns = captured.filter((m) => m.startsWith('warn:'))
        expect(warns).toHaveLength(1)
        expect(warns[0]).toContain(`${wsHarness}/projects/_default/residuals.json`)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a long blockedReason.code is length-capped in the advisory (bounded log line — qc2 S-1)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-codecap-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir), {})
        // Upstream validates lower-kebab but NOT length — a model-driven or
        // hostile code must not produce an unbounded log line.
        const longCode = 'model-driven-block-code-' + 'x'.repeat(300)
        ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: longCode, message: 'max autonomous rounds reached' },
        }))

        const warns = captured.filter((m) => m.startsWith('warn:'))
        expect(warns).toHaveLength(1)
        // Truncated to 128 (cap) with the visible marker — never the full code.
        expect(warns[0]).toContain(`goal blocked [${longCode.slice(0, 127)}…]`)
        expect(warns[0]).not.toContain('x'.repeat(300))
        // Bounded line: capped code (128) + capped message (512) + capped objective (512) + fixed pointer.
        expect(warns[0].length).toBeLessThan(1500)
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing WORKSPACE resolver in the session/event listener → contained degrade warn ("goal blocked advisory degraded"), the emit never throws (qc2 S-4)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-catch-event-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        class ThrowingWorkspaceResolver extends HarnessResolver {
          override forWorkspace(_cwd: string | undefined): string | null {
            throw new Error('resolver workspace boom')
          }
        }
        registerGoalBridge(ctx, new ThrowingWorkspaceResolver(harnessDir), {})
        expect(() => ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))).not.toThrow()
        const degrade = captured.find((m) => m.startsWith('warn:') && m.includes('goal blocked advisory degraded'))
        expect(degrade).toBeDefined()
        expect(degrade).toContain('resolver workspace boom')
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
