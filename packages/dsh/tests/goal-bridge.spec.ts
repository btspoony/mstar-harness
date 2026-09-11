/**
 * Goal bridge tests: the observe-only blocked-goal advisory and the
 * zero-write pin.
 *
 * The advisory half covers the `session/event` firehose consumer — ONE
 * `mstar/goal-bridge` warn per qualifying `goal/change` envelope (block
 * operation or blocked phase), the v1 wire gate, the workspace attribution,
 * the bounded display caps, and the contained degrade.
 *
 * The pin half is the load-bearing contract: mstar NEVER writes dsh goal
 * state (no `create` / `edit` / `complete` / `pause` / `resume`), so an
 * operator's `/goal pause` can never be re-armed by the plugin. It seeds the
 * adversarial pre-state — an ACTIVE steering compass plus a PAUSED goal with
 * a drifted objective — then fires every edge the retired mirror listened on
 * (the root `agent/session-start`, the `subagent/start` parentSession root
 * walk, and the same two edges again after a mid-session iteration flip) and
 * asserts the goal is untouched with an EMPTY service-call log.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { registerGoalBridge, setGoalBridgeLogger } from '../src/gates/goal-bridge.ts'

async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  return { root, harnessDir }
}

/** Seed ONE steering compass whose frontmatter status steers (`active`). */
async function seedCompass(harnessDir: string, iterationId: string): Promise<void> {
  const compassPath = join(harnessDir, 'iterations', iterationId, 'delivery-compass.md')
  await mkdir(join(harnessDir, 'iterations', iterationId), { recursive: true })
  await writeFile(compassPath, '---\nstatus: active\n---\n')
}

/** Minimal structural `agents` service for the `subagent/start` root walk. */
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

/* ---------------------------------- zero goal writes ---------------------------------- */

/**
 * The operator's PAUSED goal, with an objective drifted from the active
 * steering iteration — the adversarial pre-state (the retired mirror
 * completed and replaced exactly this goal; a matching objective was already
 * a no-op pre-change, so drift is the discriminating case).
 */
const PAUSED_DRIFTED_GOAL = {
  id: 'goal-1',
  revision: 7,
  phase: 'paused',
  maxGoalRounds: 256,
  objective:
    "Run iteration iter-0001-old through the complete flow to its exit: iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready. Exit: the iteration's delivery PR is merged to the target branch and the merge-ready loop closes; the harness status.json stays the source of truth.",
}

/**
 * The same operator goal, already carrying the complete-flow objective of
 * the ACTIVE steering iteration (the "already in place" pre-state).
 */
const PAUSED_MATCHING_GOAL = {
  id: 'goal-1',
  revision: 3,
  phase: 'paused',
  maxGoalRounds: 256,
  objective:
    "Run iteration iter-0001-match through the complete flow to its exit: iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready. Exit: the iteration's delivery PR is merged to the target branch and the merge-ready loop closes; the harness status.json stays the source of truth.",
}

/** One recorded goals-service call (`op` = the service method name). */
interface RecordedGoalCall {
  op: string
  args: unknown[]
}

/**
 * Minimal recording stand-in for the dsh `goals` service: ONE pre-seeded
 * snapshot plus a call log. `create` / `complete` apply their upstream
 * observable effect, so an empty `writes` log and an untouched snapshot are
 * the same fact observed twice — a goal-mutating bridge fails both.
 * `writes` is the mutating surface the retired mirror used (the zero-write
 * contract); `calls` also catches a read-only lookup, which an observe-only
 * bridge must not perform either.
 */
class RecordingGoalsService extends Service {
  readonly calls: RecordedGoalCall[] = []
  current: Record<string, unknown> | undefined

  constructor(ctx: Context, seeded?: Record<string, unknown>) {
    super(ctx, 'goals')
    this.current = seeded
  }

  get writes(): RecordedGoalCall[] {
    return this.calls.filter((call) => call.op === 'create' || call.op === 'complete')
  }

  get(agent: unknown): unknown {
    this.calls.push({ op: 'get', args: [agent] })
    return this.current
  }

  create(agent: unknown, request: { objective: string }): unknown {
    this.calls.push({ op: 'create', args: [agent, request] })
    this.current = { ...this.current, id: 'goal-1', revision: 1, phase: 'active', objective: request.objective }
    return this.current
  }

  complete(agent: unknown, ref: unknown): unknown {
    this.calls.push({ op: 'complete', args: [agent, ref] })
    if (this.current !== undefined) {
      const { revision } = this.current
      this.current = { ...this.current, phase: 'complete', revision: (typeof revision === 'number' ? revision : 0) + 1 }
    }
    return this.current
  }
}

/**
 * Drive the zero-write pin: an ACTIVE steering compass plus a root/child
 * agent registry over a recording goals service, then every edge the retired
 * mirror listened on — the root `agent/session-start`, the `subagent/start`
 * parentSession root walk, and (when `driftedIterationId` is given) the same
 * two edges again after the steering iteration flips mid-session.
 */
async function driveZeroWriteScenario(options: {
  prefix: string
  iterationId: string
  driftedIterationId?: string
  seededGoal?: Record<string, unknown>
}): Promise<{ root: string; goals: RecordingGoalsService }> {
  const { root, harnessDir } = await tempHarness(options.prefix)
  await seedCompass(harnessDir, options.iterationId)
  const ctx = new Context()
  const goals = new RecordingGoalsService(ctx, options.seededGoal === undefined ? undefined : { ...options.seededGoal })
  const agents = new FakeAgentRegistry(ctx)
  const rootFixture = { id: 'root-pin', session: { header: { cwd: root } } }
  const child = { id: 'child-pin', session: { header: { cwd: root, parentSession: 'root-pin' } } }
  agents.register(rootFixture)
  agents.register(child)
  const prior = setGoalBridgeLogger(() => {})
  try {
    registerGoalBridge(ctx, new HarnessResolver(harnessDir))
    ctx.events.emit('agent/session-start', { agent: rootFixture, source: 'fresh' })
    ctx.events.emit('subagent/start', { runId: 'run-1', provider: 'in-process', id: 'child-pin', local: true })
    if (options.driftedIterationId !== undefined) {
      await rm(join(harnessDir, 'iterations', options.iterationId), { recursive: true, force: true })
      await seedCompass(harnessDir, options.driftedIterationId)
      ctx.events.emit('agent/session-start', { agent: rootFixture, source: 'fresh' })
      ctx.events.emit('subagent/start', { runId: 'run-2', provider: 'in-process', id: 'child-pin', local: true })
    }
  } finally {
    setGoalBridgeLogger(prior)
  }
  return { root, goals }
}

describe('goal bridge — zero goal writes (observe-only)', () => {
  it('active compass + PAUSED goal with a drifted objective → session-start, the subagent/start root walk and the iteration drift write NOTHING (goal untouched, zero calls)', async () => {
    const { root, goals } = await driveZeroWriteScenario({
      prefix: 'dsh-goal-bridge-zerowrite-',
      iterationId: 'iter-0001-pin',
      driftedIterationId: 'iter-0001-pin2',
      seededGoal: PAUSED_DRIFTED_GOAL,
    })
    try {
      // The operator's paused goal keeps its objective, phase and revision.
      expect(goals.current).toEqual(PAUSED_DRIFTED_GOAL)
      expect(goals.writes).toEqual([])
      // …and the bridge never even reads the goal service.
      expect(goals.calls).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no goal exists → the same decision edges never create one', async () => {
    const { root, goals } = await driveZeroWriteScenario({
      prefix: 'dsh-goal-bridge-zerowrite-absent-',
      iterationId: 'iter-0001-absent',
      driftedIterationId: 'iter-0001-absent2',
    })
    try {
      expect(goals.current).toBeUndefined()
      expect(goals.calls).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a paused goal already carrying the mirrored objective → untouched, zero calls', async () => {
    const { root, goals } = await driveZeroWriteScenario({
      prefix: 'dsh-goal-bridge-zerowrite-match-',
      iterationId: 'iter-0001-match',
      seededGoal: PAUSED_MATCHING_GOAL,
    })
    try {
      expect(goals.current).toEqual(PAUSED_MATCHING_GOAL)
      expect(goals.calls).toEqual([])
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
          'Run iteration iter-00000816-advisory through the complete flow: iteration-start → per-plan cycles → iteration-close → PR delivery → merge-ready. Exit: merged.',
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
      // Seed a status.json fixture — the advisory must NEVER touch it (observe-only).
      const statusPath = join(harnessDir, 'status.json')
      const beforeStatus = JSON.stringify({ v: 1, plans: [], residual_findings: {} }, null, 2)
      await writeFile(statusPath, beforeStatus)
      const beforeEntries = (await readdir(harnessDir)).sort()

      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir))
        ctx.events.emit('session/event', goalSession(root), goalChangeEnvelope({
          operation: 'block',
          phase: 'blocked',
          blockedReason: { code: 'rounds-exhausted', message: 'max autonomous rounds reached' },
        }))

        expect(captured.filter((m) => m.startsWith('warn:'))).toHaveLength(1)
        const warn = captured.find((m) => m.startsWith('warn:'))!
        expect(warn).toContain('goal blocked [rounds-exhausted]')
        expect(warn).toContain('max autonomous rounds reached')
        expect(warn).toContain('objective: Run iteration iter-00000816-advisory')
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
        registerGoalBridge(ctx, new HarnessResolver(harnessDir))
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
        registerGoalBridge(ctx, new HarnessResolver(harnessDir))
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
        registerGoalBridge(ctx, new HarnessResolver(harnessDir))
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
        registerGoalBridge(ctx, new HarnessResolver(undefined))
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

  it('a long blockedReason.code is length-capped in the advisory (bounded log line)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-goal-bridge-codecap-')
    try {
      const ctx = new Context()
      const captured: string[] = []
      const prior = setGoalBridgeLogger((level, message) => captured.push(`${level}: ${message}`))
      try {
        registerGoalBridge(ctx, new HarnessResolver(harnessDir))
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

  it('a throwing WORKSPACE resolver in the session/event listener → contained degrade warn ("goal blocked advisory degraded"), the emit never throws ', async () => {
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
        registerGoalBridge(ctx, new ThrowingWorkspaceResolver(harnessDir))
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
