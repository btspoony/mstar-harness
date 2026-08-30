/**
 * Task 3 fix round — the CONTINUABLE persona surface (plan
 * `20260831-dsh-alpha2-optional-fallbacks`): the native persona channel
 * wraps BOTH start surfaces. Opt-in `backgroundMode: 'continuable'`
 * dispatches (tool-subagent `Config.backgroundMode`) route through
 * `SubagentRuntime.startContinuable({ provider, label, request, signal })`,
 * and the old `subagent/start` emit decoration covered those children too —
 * the channel must merge the role persona into `spec.request.persona` with
 * the SAME decision chain (explicit request persona wins →
 * `Config.rolePersonas` → mirror default → skip) and containment as the
 * one-shot surface.
 *
 * Native gates per surface (upstream contract, pinned by these tests):
 * - one-shot `start` rejects a persona for a provider without
 *   `SubagentCapabilities.persona` (fail loud);
 * - continuable children are composed by the continuation manager itself
 *   and gated by `SubagentProvider.prepareContinuable` instead (the
 *   `SubagentCapabilities` doc is ONE-SHOT-scoped) — a provider without it
 *   rejects the continuable start loud regardless of any persona, so the
 *   channel skips the merge there.
 *
 * Observation boundary: the real continuation manager materializes every
 * continuable child through `agents.create({ sessionId, meta, seed, … })`,
 * and the creation `seed` carries the `subagent/descriptor` event with the
 * snapshotted persona (the durable record fresh creation composes AND cold
 * resume replays). The harness agents fake records that creation and
 * throws — the earliest REAL observation point for the resolved continuable
 * request, without a live agent runtime.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'bun:test'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import {
  FakeAgentRegistry,
  FakeLoaderRegistry,
  FakeSubagentProvider,
  bootApp,
  fakeChild,
  startContinuableViaNativeChannel,
  startViaNativeChannel,
  type BootOptions,
  type BootResult,
} from './harness.ts'
import {
  setRolePersonaLogger,
  type ContinuableStartSpecView,
  type RolePersonaLogLevel,
  type SubagentStartRequestView,
  type SubagentsServiceView,
} from '../src/gates/role-persona.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mstar role id the test Assignment declares and the persona is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** The configured persona text for `fullstack-dev`. */
const PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

/** One mstar-style Assignment prompt sent as the continuable request's task text. */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** Capture role-persona logs through the module sink (role-persona.spec pattern). */
function captureLogs(): { captured: Array<[RolePersonaLogLevel, string]>; restore: () => void } {
  const captured: Array<[RolePersonaLogLevel, string]> = []
  const prior = setRolePersonaLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setRolePersonaLogger(prior) }
}

/**
 * Boot the REAL subagents runtime with a continuable-capable fake provider
 * and a fake-registered delegating parent (the real manager's admission
 * boundary). `sessionPersistence: 'fake'` satisfies the runtime's
 * `requirePersistence()` precondition.
 */
async function bootContinuable(
  providerOptions: { personaCapability?: boolean; continuable?: boolean },
  bootOverrides: Partial<BootOptions> = {},
): Promise<{ app: BootResult; provider: FakeSubagentProvider; agents: FakeAgentRegistry; parent: { id: string } }> {
  const app = booted = await bootApp({
    agentsService: 'fake',
    subagents: 'real',
    sessionPersistence: 'fake',
    rolePersonas: { [EXECUTE_AS]: PERSONA },
    ...bootOverrides,
  })
  const provider = new FakeSubagentProvider('fake-spawn', providerOptions)
  // Registration targets the raw root-context read (no fiber runtime → the
  // read bypasses the channel wrapper — the direct registry path; the
  // wrapper delegates the same registry anyway). Named-type cast: the
  // runtime's `registerProvider` is a real-class method the boot composes.
  ;(app.ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)
  const agents = app.ctx.get('agents') as unknown as FakeAgentRegistry
  const { agent: parent } = await fakeChild(app.ctx, 'parent session')
  agents.register(parent)
  return { app, provider, agents, parent: parent as unknown as { id: string } }
}

/**
 * One continuable spec for `parent` with `text` as the Assignment carrier.
 * The literal carries the REAL spec/request fields (`label`, `signal`,
 * `parent`) the structural views intentionally omit — hence the named-view
 * cast (same pattern as role-persona.spec's request builder).
 */
function continuableSpec(parent: unknown, text: string, overrides: Partial<SubagentStartRequest> = {}): ContinuableStartSpecView {
  return {
    provider: 'fake-spawn',
    label: 'continuable label',
    request: {
      prompt: [{ type: 'text', text }],
      parent,
      ...overrides,
    } as unknown as SubagentStartRequest,
    signal: new AbortController().signal,
  } as ContinuableStartSpecView
}

/** The `subagent/descriptor` event data recorded in one creation seed (undefined when absent). */
function descriptorOf(agents: FakeAgentRegistry): Record<string, unknown> | undefined {
  const seed = agents.createCalls[0]?.seed ?? []
  return seed.find((event) => event.type === 'subagent/descriptor')?.data
}

describe('native persona channel — the continuable start surface', () => {
  it('(a) role-matched continuable start → the creation descriptor carries the merged persona (real manager materialization)', async () => {
    const { app, provider, agents, parent } = await bootContinuable({ personaCapability: true, continuable: true })

    const { captured, restore } = captureLogs()
    try {
      // The manager hands off to `agents.create` (the capture-only harness
      // boundary) — the rejection proves the call flowed through the REAL
      // runtime → continuation manager → materialization path.
      await expect(startContinuableViaNativeChannel(app, continuableSpec(parent, ASSIGNMENT_PROMPT)))
        .rejects.toThrow('fake agents create: capture-only harness')

      expect(agents.createCalls).toHaveLength(1)
      expect(agents.createCalls[0]?.meta?.parentSession).toBe(parent.id)
      // The snapshot persona is the channel's merge — the durable record
      // fresh creation composes and cold resume replays.
      expect(descriptorOf(agents)).toMatchObject({
        mode: 'continuable',
        provider: 'fake-spawn',
        label: 'continuable label',
        persona: PERSONA,
      })
      // The request reached the real manager's detached creation hook.
      expect(provider.continuablePrepares).toHaveLength(1)
      // Exactly one debug line — the delivery log naming the SURFACE.
      expect(captured).toHaveLength(1)
      expect(captured[0]?.[0]).toBe('debug')
      expect(captured[0]?.[1]).toContain('native subagent persona channel')
      expect(captured[0]?.[1]).toContain('continuable start')
    } finally {
      restore()
    }
  })

  it('(b) an explicit request persona (caller intent) wins on the continuable surface — silent', async () => {
    const { app, agents, parent } = await bootContinuable({ personaCapability: true, continuable: true })

    const { captured, restore } = captureLogs()
    try {
      await expect(startContinuableViaNativeChannel(app, continuableSpec(parent, ASSIGNMENT_PROMPT, { persona: 'caller persona' })))
        .rejects.toThrow('fake agents create: capture-only harness')

      expect(descriptorOf(agents)?.persona).toBe('caller persona')
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(c) role-unmatched continuable prompt → no persona in the descriptor, silent', async () => {
    const { app, agents, parent } = await bootContinuable({ personaCapability: true, continuable: true })

    const { captured, restore } = captureLogs()
    try {
      await expect(startContinuableViaNativeChannel(app, continuableSpec(parent, ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout'))))
        .rejects.toThrow('fake agents create: capture-only harness')

      expect(descriptorOf(agents)?.persona).toBeUndefined()
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(d) provider without prepareContinuable → persona skipped + one debug; the native continuable rejection propagates unshadowed', async () => {
    // `personaCapability: true` but NO `continuable` — the one-shot flag is
    // one-shot-scoped, so the channel must gate on the NATIVE continuable
    // gate (`prepareContinuable`), not on the persona flag.
    const { app, agents, parent } = await bootContinuable({ personaCapability: true, continuable: false })

    const { captured, restore } = captureLogs()
    try {
      await expect(startContinuableViaNativeChannel(app, continuableSpec(parent, ASSIGNMENT_PROMPT)))
        .rejects.toThrow(/does not support continuable children/)

      expect(descriptorOf(agents)?.persona).toBeUndefined()
      expect(captured).toHaveLength(1)
      expect(captured[0]?.[0]).toBe('debug')
      expect(captured[0]?.[1]).toContain('does not support continuable children')
      expect(captured[0]?.[1]).toContain(EXECUTE_AS)
    } finally {
      restore()
    }
  })

  it('(e) one-shot starts in the same boot still merge (both surfaces share one channel)', async () => {
    const { app, provider, agents } = await bootContinuable({ personaCapability: true, continuable: true })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', {
        prompt: [{ type: 'text', text: ASSIGNMENT_PROMPT }],
        parent: { id: 'parent-fake', session: { id: 'parent-fake' } },
        signal: new AbortController().signal,
      } as unknown as SubagentStartRequest)

      expect(provider.starts[0]?.request.persona).toBe(PERSONA)
      expect(agents.createCalls).toHaveLength(0) // one-shot: no materialization
      expect(captured).toHaveLength(1)
      expect(captured[0]?.[1]).toContain('one-shot start')
    } finally {
      restore()
    }
  })
})

/**
 * Recording subagents service for the wrapper-level cases (f)–(h): a
 * structural fake mounted on a minimal boot (the test (t) role-persona.spec
 * pattern) whose `start`/`startContinuable` record the calls they receive —
 * post-merge, post-gate, post-containment.
 */
class RecordingSubagents extends Service {
  /** Resolved one-shot requests, in call order. */
  readonly starts: Array<{ name: string; request: { persona?: string } }> = []
  /** Resolved continuable specs, in call order. */
  readonly continuableSpecs: ContinuableStartSpecView[] = []

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  getProvider(): { capabilities: { persona: boolean } } {
    return { capabilities: { persona: true } }
  }

  start(name: string, request: { persona?: string }): unknown {
    this.starts.push({ name, request })
    return {}
  }

  startContinuable(spec: ContinuableStartSpecView): unknown {
    this.continuableSpecs.push(spec)
    return { childId: 'fake-child' }
  }
}

/** A one-shot-only subagents service: NO `startContinuable` (case (f)). */
class StartOnlySubagents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  getProvider(): { capabilities: { persona: boolean } } {
    return { capabilities: { persona: true } }
  }

  start(name: string, request: { persona?: string }): unknown {
    void name
    void request
    return {}
  }
}

/** The service class shape the minimal boot mounts (cordis Service subclass). */
type ServiceClass = new (ctx: Context) => Service

/** Minimal boot over one local service: loader row (the plugin's inject) + service row + plugin row. */
async function bootWithService(service: ServiceClass, persona: string): Promise<{ ctx: Context; root: string; fiber: { dispose(): Promise<unknown> } }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-role-persona-continuable-'))
  const ctx = new Context()
  new FakeLoaderRegistry(ctx)
  await ctx.plugin(service as unknown as Parameters<Context['plugin']>[0])
  const fiber = await ctx.plugin(plugin, { harnessDir: join(root, 'harness'), rolePersonas: { [EXECUTE_AS]: persona } })
  return { ctx, root, fiber }
}

/** Drive one one-shot start through the inject read path on a raw context. */
function startOnCtx(ctx: Context, request: SubagentStartRequestView): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  void ctx.inject(['subagents'], (sctx) => {
    const service = sctx.subagents as unknown as SubagentsServiceView
    Promise.resolve(service.start('fake-spawn', request)).then(resolve, reject)
  })
  return promise
}

/** Drive one continuable start through the inject read path on a raw context. */
function startContinuableOnCtx(ctx: Context, spec: ContinuableStartSpecView): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  void ctx.inject(['subagents'], (sctx) => {
    const service = sctx.subagents as unknown as SubagentsServiceView
    Promise.resolve(service.startContinuable(spec)).then(resolve, reject)
  })
  return promise
}

describe('native persona channel — continuable wrapper surface mechanics', () => {
  it('(f) a service without startContinuable gets no invented surface (the wrapper adds nothing the service lacks)', async () => {
    const { ctx, root, fiber } = await bootWithService(StartOnlySubagents, PERSONA)
    try {
      const { promise: got, resolve: resolveGot } = Promise.withResolvers<unknown>()
      void ctx.inject(['subagents'], (sctx) => resolveGot(sctx.subagents))
      const service = (await got) as unknown as SubagentsServiceView
      expect(typeof service.start).toBe('function')
      // StartOnlySubagents carries NO startContinuable — the wrapper must
      // not invent one (a reader's typeof answer is unchanged).
      expect(service.startContinuable).toBeUndefined()
    } finally {
      await fiber.dispose().catch(() => {})
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('(g) the persona config is apply-closed-over: an HMR re-apply re-binds the fresh Config (no process-global cross-talk)', async () => {
    const { ctx, root, fiber } = await bootWithService(RecordingSubagents, 'persona generation one')
    const recording = ctx.get('subagents') as unknown as RecordingSubagents
    try {
      // Generation one: two starts (also proving the same-generation
      // wrapper cache hit — one wrapper, both calls) merge gen-one personas.
      await startOnCtx(ctx, { prompt: [{ type: 'text', text: ASSIGNMENT_PROMPT }] })
      await startOnCtx(ctx, { prompt: [{ type: 'text', text: ASSIGNMENT_PROMPT }] })
      expect(recording.starts.map((call) => call.request.persona)).toEqual(['persona generation one', 'persona generation one'])

      // HMR swap: dispose the plugin fiber and re-apply with a DIFFERENT
      // rolePersonas over the SAME service — the second apply's binding
      // must win (a stale cached wrapper would keep serving generation one;
      // a process-global would cross-talk between applies).
      await fiber.dispose()
      const second = await ctx.plugin(plugin, { harnessDir: join(root, 'harness'), rolePersonas: { [EXECUTE_AS]: 'persona generation two' } })
      await startOnCtx(ctx, { prompt: [{ type: 'text', text: ASSIGNMENT_PROMPT }] })
      expect(recording.starts[2]?.request.persona).toBe('persona generation two')
      await second.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('(h) containment — a throwing continuable merge degrades with one warn and forwards the ORIGINAL spec', async () => {
    const { ctx, root, fiber } = await bootWithService(RecordingSubagents, PERSONA)
    const recording = ctx.get('subagents') as unknown as RecordingSubagents
    try {
      // A spec whose request prompt getter throws drives the wrapper's
      // continuable merge into its catch — one warn, and the ORIGINAL spec
      // object (identity) reaches the service.
      const hostileSpec = continuableSpec({ id: 'parent-hostile' }, 'irrelevant')
      Object.defineProperty(hostileSpec.request, 'prompt', {
        get() { throw new Error('prompt exploded') },
      })
      const { captured, restore } = captureLogs()
      try {
        await startContinuableOnCtx(ctx, hostileSpec)
        expect(recording.continuableSpecs[0]).toBe(hostileSpec) // identity — untouched
        expect(captured.some(([level, message]) => level === 'warn' && message.includes('degraded to pass-through'))).toBe(true)
      } finally {
        restore()
      }
    } finally {
      await fiber.dispose().catch(() => {})
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
