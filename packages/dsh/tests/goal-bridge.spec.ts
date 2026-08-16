/**
 * Goal bridge tests (plan `20260816-dsh-nb2-goal-bridge` Task 2): the
 * one-way mirror of the active iteration objective into the dsh goal service
 * (`ctx.get('goals')` STRUCTURAL view — no peer dependency) with the flat
 * `maxGoalRounds` cap. The mirror is fake-testable: `mirrorIterationGoal`
 * receives the goals view + a per-workspace resolver + the resolved round
 * cap, so every branch is exercised against an in-memory fake — root filter,
 * steering-compass scan (active|locked), objective text contract, CAS edit
 * with the stale re-read retry, and the service-missing degrade.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessResolver } from '../src/gates/_shared.ts'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  isRootLikeAgent,
  mirrorIterationGoal,
  registerGoalBridge,
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
  calls: Array<{ op: 'get' | 'create' | 'edit'; args: unknown[] }> = []
  current: FakeGoalRecord | undefined
  /** Consecutive `edit` calls to fail with `GOAL_STALE_REVISION` (0 = never). */
  editStaleCount = 0

  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  get(agent: unknown): GoalView | undefined {
    this.calls.push({ op: 'get', args: [agent] })
    return this.current
  }

  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): GoalView {
    this.calls.push({ op: 'create', args: [agent, request] })
    this.current = {
      id: 'goal-1',
      revision: 1,
      objective: request.objective,
      phase: 'active',
      maxGoalRounds: request.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS,
    }
    return this.current as GoalView
  }

  edit(agent: unknown, ref: GoalRefView, request: { objective?: string; maxGoalRounds?: number }): GoalView {
    this.calls.push({ op: 'edit', args: [agent, ref, request] })
    if (this.editStaleCount > 0) {
      this.editStaleCount -= 1
      // Simulate the concurrent writer committing BETWEEN the mirror's get and edit:
      // the current goal advances one revision, so the mirror's ref is stale.
      this.current = { ...this.current!, revision: this.current!.revision + 1 }
      throw Object.assign(new Error(`stale goal ref "${ref.id}" revision ${ref.revision}`), { code: 'GOAL_STALE_REVISION' })
    }
    this.current = {
      ...this.current!,
      revision: ref.revision + 1,
      ...(request.objective !== undefined ? { objective: request.objective } : {}),
    }
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
      expect(goals.calls.filter((c) => c.op === 'edit')).toHaveLength(0)
      expect(goals.current!.objective).toBe(createdObjective)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('objective drift (new active iteration) → CAS edit with the current { id, revision }', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-drift-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-first', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)

      // The steering iteration flips (iteration-close → new iteration start):
      // the first compass stops steering, the second one steers.
      await rm(join(harnessDir, 'iterations', 'iter-20260816-first'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-second', 'active')

      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const edits = goals.calls.filter((c) => c.op === 'edit')
      expect(edits).toHaveLength(1)
      // CAS identity: the CURRENT goal's { id, revision }, objective-only request.
      const ref = edits[0]!.args[1] as GoalRefView
      const req = edits[0]!.args[2] as { objective: string }
      expect(ref).toEqual({ id: 'goal-1', revision: 1 })
      expect(req.objective).toContain('iter-20260816-second')
      expect(goals.current!.objective).toContain('iter-20260816-second')
      expect(goals.calls.filter((c) => c.op === 'create')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stale edit (GOAL_STALE_REVISION) → re-read once and retry the edit with the fresh ref', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-stale-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-stale', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      // Drift + a concurrent mutation between get and edit.
      await rm(join(harnessDir, 'iterations', 'iter-20260816-stale'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-stale2', 'active')
      goals.editStaleCount = 1 // the FIRST edit stales; the fake bumps the revision as the concurrent commit

      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      const edits = goals.calls.filter((c) => c.op === 'edit')
      expect(edits).toHaveLength(2)
      // First edit used the STALE ref; the retry used the FRESH revision.
      const firstRef = edits[0]!.args[1] as GoalRefView
      const retryRef = edits[1]!.args[1] as GoalRefView
      expect(firstRef.revision).toBe(1)
      expect(retryRef.revision).toBe(2)
      expect(goals.current!.objective).toContain('iter-20260816-stale2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stale edit twice → warn + abandon (false; no create, no third attempt)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-stale2-')
    try {
      await seedCompass(harnessDir, 'iter-20260816-stale-a', 'active')
      const goals = new FakeGoalsService(new Context())
      const resolver = new HarnessResolver(harnessDir)
      expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(true)
      await rm(join(harnessDir, 'iterations', 'iter-20260816-stale-a'), { recursive: true, force: true })
      await seedCompass(harnessDir, 'iter-20260816-stale-b', 'active')
      goals.editStaleCount = 2 // BOTH the first edit AND the re-read retry stale

      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        expect(mirrorIterationGoal(rootAgent(root), { resolver, goals, maxGoalRounds: 64 })).toBe(false)
        expect(goals.calls.filter((c) => c.op === 'edit')).toHaveLength(2)
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

  it('subagent/start decision point: the parentSession root walk re-evaluates idempotently (in place → no churn; drift → CAS edit)', async () => {
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
        expect(goals.calls.filter((c) => c.op === 'edit')).toHaveLength(0)

        // The steering iteration flips mid-session → the decision point CAS-edits.
        await rm(join(harnessDir, 'iterations', 'iter-20260816-d1'), { recursive: true, force: true })
        await seedCompass(harnessDir, 'iter-20260816-d2', 'active')
        ctx.events.emit('subagent/start', { runId: 'run-2', provider: 'in-process', id: 'child-d1', local: true })

        const edits = goals.calls.filter((c) => c.op === 'edit')
        expect(edits).toHaveLength(1)
        const ref = edits[0]!.args[1] as GoalRefView
        expect(ref).toEqual({ id: 'goal-1', revision: 1 })
        expect(goals.current!.objective).toContain('iter-20260816-d2')
      } finally {
        setGoalBridgeLogger(prior)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
