/**
 * Role-preset delivery — `Config.rolePresets[<Execute as>]` →
 * `SubagentStartRequest.agentPreset`. dsh 0.2.1 removed the per-start
 * `persona` slot and the one-shot/continuable start pair:
 * `SubagentRuntime.startActivation(spec)` is the ONE start surface, and a
 * per-child identity is delivered by SELECTING the agent preset the
 * deployment declared for the role (its rows mount
 * `@deepseek-ai/dsh-persona`). The suite pins THIS channel's contract, never
 * an upstream shape:
 *
 * - the interception seam is the cordis `internal/get` service-read
 *   waterfall: a `ctx.subagents` read through a plugin-fiber context returns
 *   a prototype-delegating wrapper whose OWN `startActivation` merges the
 *   role's preset into the spec before delegating — the underlying runtime
 *   object is never mutated (no monkey-patching), and reads of OTHER
 *   services pass through untouched;
 * - the REAL `@deepseek-ai/dsh-subagent` runtime surface is consumed
 *   structurally (the compile-time drift gates below) while a
 *   `FakeSubagentProvider` records the RESOLVED request — post-merge,
 *   post-gate;
 * - gates: an independent selection needs a provider whose
 *   `capabilities.agentPreset` is true and which does NOT inherit its
 *   parent's conversation, and it needs the `agentPresets` registry mounted;
 *   a gate miss skips the selection with ONE contained debug log and the
 *   start proceeds unchanged (the contained degrade, never a failed
 *   dispatch);
 * - caller intent wins: a request that already carries `agentPreset` is
 *   forwarded untouched and silently;
 * - configured ids are validated ONCE per apply against the mounted roster;
 * - delivery is fallbacks-independent and compose-order-independent (the
 *   listener prepends, so the harness channel is outermost on any row
 *   order);
 * - degradation is contained: a throwing log sink never escapes, and a
 *   poisoned merge or poisoned service read degrades to pass-through with
 *   ONE warn and the ORIGINAL object.
 *
 * The `internal/get` seam probe keeps its own decision-table pins (pure
 * `evaluateSeamProbe` + the real `probeRolePersonaSeam`) at the end of the
 * file.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'bun:test'
import type { SubagentActivationSpec, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import type { SubagentActivationSpecView, SubagentsServiceView } from '../src/gates/role-persona.ts'
import { fallbacksMounted } from '../src/gates/fallbacks-probe.ts'
import {
  FakeAgentPresetRegistry,
  FakeLoaderRegistry,
  FakeSubagentProvider,
  FakeSubagentService,
  bootApp,
  startActivationViaNativeChannel,
  type BootResult,
} from './harness.ts'
import {
  ROLE_PERSONA_LOGGER,
  ROLE_PERSONA_WRAPPER_BRAND,
  evaluateSeamProbe,
  probeRolePersonaSeam,
  setRolePersonaLogger,
  type RolePersonaLogLevel,
} from '../src/gates/role-persona.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mstar role id the test Assignment declares and the preset is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** A preset id the mounted roster declares and the mapping selects. */
const PRESET_ID = 'mstar-execute'

/** A second declared preset id (the HMR re-bind target). */
const PRESET_ID_ALT = 'mstar-reviewer'

/** A configured id the roster does NOT declare (the apply-time validation probe). */
const UNDECLARED_PRESET_ID = 'ghost-preset'

/** An mstar role id the mapping does not cover (the silent skip). */
const UNMAPPED_ROLE = 'scout'

/** One mstar-style Assignment prompt: the header region the engine parses. */
const ASSIGNMENT_PROMPT = [
  `**Execute as**: ${EXECUTE_AS}`,
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** A non-Assignment task prompt (no header fields). */
const PLAIN_PROMPT = 'Summarize the attached file.'

/** The request shape `FakeSubagentProvider.starts` records. */
type RecordedRequest = { agentPreset?: string; cwd?: string; prompt?: unknown }

/** The prompt payload of one start request. */
function textPrompt(text: string): RecordedRequest {
  return { prompt: [{ type: 'text', text }] }
}

/**
 * One activation spec for `provider`: the request under test plus any field
 * the channel does not consume (forwarded verbatim) — `signal`, `label`,
 * `childId`, `delivery`.
 */
function specFor(provider: string, request: RecordedRequest, extra: Record<string, unknown> = {}): SubagentActivationSpecView {
  // Boundary cast: this fixture deliberately carries fields beyond the view
  // (the channel must forward them verbatim) and a signal the view omits.
  const spec = { provider, request, signal: new AbortController().signal, ...extra }
  return spec as unknown as SubagentActivationSpecView
}

/** Capture role-persona logs through the module sink (agent-flow test pattern). */
function captureLogs(): { captured: Array<[RolePersonaLogLevel, string]>; restore: () => void } {
  const captured: Array<[RolePersonaLogLevel, string]> = []
  const prior = setRolePersonaLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => { setRolePersonaLogger(prior) } }
}

/**
 * Boot the fake subagents runtime (mounted as the `subagents` service) plus
 * the fake preset roster, with one provider registered on it. Default
 * Config: `rolePresets[fullstack-dev]` = PRESET_ID; the provider is
 * preset-capable unless the caller says otherwise.
 */
async function bootWithProvider(
  providerName: string,
  options: { agentPresetCapability?: boolean; inheritsParentContext?: boolean } = {},
  bootOverrides: Partial<Parameters<typeof bootApp>[0]> = {},
): Promise<{ app: BootResult; provider: FakeSubagentProvider }> {
  const app = booted = await bootApp({
    subagents: 'fake',
    agentPresetsService: [PRESET_ID, PRESET_ID_ALT],
    rolePresets: { [EXECUTE_AS]: PRESET_ID },
    ...bootOverrides,
  })
  const provider = new FakeSubagentProvider(providerName, { agentPresetCapability: true, ...options })
  // Registration targets the RAW root-context read: the root fiber carries no
  // runtime, so this read bypasses the channel wrapper (the wrapper sits on
  // the plugin-fiber read path the starts below take).
  ;(app.ctx.subagents as unknown as FakeSubagentService).registerProvider(provider)
  return { app, provider }
}

/**
 * The mounted fake roster — declared ids plus the apply-time validation
 * reads. Boundary cast: the registry is an optional host service the plugin
 * consumes structurally, so its shape is asserted by the fake above.
 */
function registryOf(app: BootResult): FakeAgentPresetRegistry {
  const registry = app.ctx.get('agentPresets') as unknown as FakeAgentPresetRegistry
  return registry
}

/** Await an observable effect (bounded tick poll — never a fixed sleep). */
async function untilReached(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 0)
    await tick.promise
  }
  throw new Error('observable effect never materialized')
}

/** Read the subagents service through a plugin-fiber context (the wrapped read path). */
function readSubagents(ctx: Context): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  void ctx.inject(['subagents'], (sctx) => resolve(sctx.subagents))
  return promise
}

/** Compile-time drift gate: the REAL runtime surface stays assignable to the structural views this module consumes. */
type _RuntimeViewGate = SubagentRuntime extends SubagentsServiceView ? true : false
const _runtimeViewGate: _RuntimeViewGate = true
type _SpecViewGate = SubagentActivationSpec extends SubagentActivationSpecView ? true : false
const _specViewGate: _SpecViewGate = true

describe('native role-preset channel — Config.rolePresets → SubagentStartRequest.agentPreset', () => {
  it('(a) an Assignment whose Execute as is mapped → the resolved request carries the configured preset', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

      expect(provider.starts).toHaveLength(1)
      expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)
      // Exactly one debug line — the delivery log naming the role and the preset.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain(EXECUTE_AS)
      expect(captured[0]![1]).toContain(`preset '${PRESET_ID}'`)
    } finally {
      restore()
    }
  })

  it('(b) unmapped role or non-Assignment prompt → request unchanged (identity), silent', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    const unmapped = specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, UNMAPPED_ROLE)))
    const plain = specFor('fake-spawn', textPrompt(PLAIN_PROMPT))
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, unmapped)
      await startActivationViaNativeChannel(app, plain)

      expect(provider.starts).toHaveLength(2)
      // Identity, not just absence: no merge happened at all.
      expect(provider.starts[0]!.request).toBe(unmapped.request)
      expect(provider.starts[1]!.request).toBe(plain.request)
      expect(provider.starts[0]!.request).not.toHaveProperty('agentPreset')
      expect(provider.starts[1]!.request).not.toHaveProperty('agentPreset')
      expect(captured).toHaveLength(0) // no-op is silent
    } finally {
      restore()
    }
  })

  it('(c) delivery is fallbacks-independent: no fallbacks row mounted, the preset is still selected', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')
    expect(fallbacksMounted(app.ctx)).toBe(false)

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

      expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)
      // Exactly one line, at debug — and it names the channel, not fallbacks.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).not.toContain('dsh-llm-fallbacks')
    } finally {
      restore()
    }
  })

  it('(d) provider without the agentPreset capability → no selection + ONE debug, the start proceeds', async () => {
    // Selecting a preset the runtime would reject is never acceptable, so the
    // gate skips instead of letting the start fail loud.
    const { app, provider } = await bootWithProvider('fake-oop', { agentPresetCapability: false })

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-oop', textPrompt(ASSIGNMENT_PROMPT)))

      expect(provider.starts).toHaveLength(1) // the start resolved — never rejected
      expect(provider.starts[0]!.request).not.toHaveProperty('agentPreset')
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('does not support independent preset selection')
      expect(captured[0]![1]).toContain(EXECUTE_AS)
    } finally {
      restore()
    }
  })

  it('(d2) provider that inherits its parent conversation → same skip with ONE debug', async () => {
    const { app, provider } = await bootWithProvider('fake-fork', { inheritsParentContext: true })

    const { captured, restore } = captureLogs()
    try {
      const spec = specFor('fake-fork', textPrompt(ASSIGNMENT_PROMPT))
      await startActivationViaNativeChannel(app, spec)

      expect(provider.starts).toHaveLength(1)
      expect(provider.starts[0]!.request).toBe(spec.request)
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('does not support independent preset selection')
    } finally {
      restore()
    }
  })

  it('(e) caller intent wins: a request already carrying agentPreset passes through untouched, silently', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    const request: RecordedRequest = { ...textPrompt(ASSIGNMENT_PROMPT), agentPreset: 'caller-preset' }
    const spec = specFor('fake-spawn', request)
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, spec)

      expect(provider.starts[0]!.request).toBe(spec.request) // identity — untouched
      expect(provider.starts[0]!.request.agentPreset).toBe('caller-preset')
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(f) prompt with no text blocks → request unchanged, silent', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    const empty = specFor('fake-spawn', textPrompt(''))
    const imageOnly = specFor('fake-spawn', { prompt: [{ type: 'image', source: 'x' }] })
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, empty)
      await startActivationViaNativeChannel(app, imageOnly)

      expect(provider.starts).toHaveLength(2)
      expect(provider.starts[0]!.request).toBe(empty.request)
      expect(provider.starts[1]!.request).toBe(imageOnly.request)
      expect(captured).toHaveLength(0) // nothing to parse → silent no-op
    } finally {
      restore()
    }
  })

  it('(g) rolePresets unset → silent no-op (and no apply-time id validation)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', {}, { rolePresets: undefined })

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

      expect(provider.starts[0]!.request).not.toHaveProperty('agentPreset')
      expect(captured).toHaveLength(0)
      expect(registryOf(app).reads).toEqual([]) // no mapping → nothing to validate
    } finally {
      restore()
    }
  })

  it('(g2) a whitespace-only preset id is rejected at Config validation and on the mount path', async () => {
    // The id names a preset the deployment must have declared, so an empty
    // value would neither select nor stay silent — the schema refuses it with
    // a clear error at plugin mount instead of a mystery at dispatch time.
    expect(() => plugin.Config({ rolePresets: { [EXECUTE_AS]: '   ' } } as never)).toThrow(
      new RegExp(`rolePresets\\["${EXECUTE_AS}"\\] must name a deployed agent preset id`),
    )
    expect(() => plugin.Config({ rolePresets: { [EXECUTE_AS]: PRESET_ID } } as never)).not.toThrow()

    const ctx = new Context()
    new FakeLoaderRegistry(ctx)
    let rejected = false
    try {
      await ctx.plugin(plugin, { harnessDir: join(tmpdir(), 'dsh-role-preset-config'), rolePresets: { [EXECUTE_AS]: '   ' } } as never)
    } catch (error) {
      rejected = true
      expect((error as Error).message).toContain('must name a deployed agent preset id')
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
    expect(rejected).toBe(true)
  })

  it('(h) containment — a throwing log sink never escapes; a poisoned service read degrades with ONE warn', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')
    // (1) The sink throws: the selection still lands (the channel swallows
    // sink failures — a broken logger must never fail a start).
    const priorSink = setRolePersonaLogger(() => { throw new Error('sink exploded') })
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
      expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)
    } finally {
      setRolePersonaLogger(priorSink)
    }

    // (2) A poisoned service read: the wrap step throws → contained → ONE warn
    // and the ORIGINAL value still reaches the reader (degraded, not lost).
    const root = await mkdtemp(join(tmpdir(), 'dsh-role-preset-wrap-'))
    const ctx = new Context()
    new FakeLoaderRegistry(ctx)
    class MinimalSubagents extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'subagents') }
    }
    let handed: unknown
    try {
      await ctx.plugin(MinimalSubagents as Parameters<Context['plugin']>[0])
      const fiber = await ctx.plugin(plugin, { harnessDir: join(root, 'harness'), rolePresets: { [EXECUTE_AS]: PRESET_ID } })
      // Registered AFTER the channel (which prepends), so this composes INSIDE
      // the channel's `next()` and hands it a value whose `startActivation`
      // property access throws.
      ctx.on('internal/get', (_readCtx, name, _error, next) => {
        const value: unknown = next()
        if (name !== 'subagents') return value
        handed = Object.defineProperty({ getProvider: () => undefined }, 'startActivation', {
          get() { throw new Error('startActivation access exploded') },
        })
        return handed
      })
      const { captured, restore } = captureLogs()
      try {
        expect(await readSubagents(ctx)).toBe(handed)
        expect(captured).toHaveLength(1)
        expect(captured[0]![0]).toBe('warn')
        expect(captured[0]![1]).toContain('degraded to pass-through')
      } finally {
        restore()
      }
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('(h2) a poisoned merge warns ONCE and forwards the ORIGINAL request', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    // A request whose `prompt` getter throws drives the merge into its catch:
    // the ORIGINAL request object reaches the service (the channel adds no
    // failure surface of its own).
    const hostile: RecordedRequest = {}
    Object.defineProperty(hostile, 'prompt', { get() { throw new Error('prompt exploded') } })
    const spec = specFor('fake-spawn', hostile)
    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, spec)

      expect(provider.starts).toHaveLength(1)
      expect(provider.starts[0]!.request).toBe(hostile)
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('warn')
      expect(captured[0]![1]).toContain('degraded to pass-through')
    } finally {
      restore()
    }
  })

  it('(i) reads of other services pass through untouched and the service object is never mutated', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    // A non-`subagents` read is not wrapped: it answers the plain loader
    // service. (Identity across reads is not comparable — cordis binds the
    // resolved service to the reading context — so the observable is the
    // service it answers and the absence of the wrapper brand.)
    // Boundary cast: the harness's fake `loader` service is not in the cordis
    // service augmentation.
    const loaderRead = Promise.withResolvers<unknown>()
    void app.ctx.inject(['loader'], (lctx) => {
      const injectedView = lctx as unknown as { loader?: unknown }
      loaderRead.resolve(injectedView.loader)
    })
    const loader = await loaderRead.promise
    expect(loader).toBeInstanceOf(FakeLoaderRegistry)
    expect(Object.getOwnPropertySymbols(loader)).not.toContain(ROLE_PERSONA_WRAPPER_BRAND)

    // The underlying service object is not patched: it carries no brand and
    // keeps its own members.
    const raw = app.ctx.subagents as unknown as FakeSubagentService
    // Boundary cast: a service instance carries no declared symbol index.
    const brandedView = raw as unknown as Record<symbol, unknown>
    expect(brandedView[ROLE_PERSONA_WRAPPER_BRAND]).toBeUndefined()
    expect(raw.getProvider('fake-spawn')).toBe(provider)

    // Liveness: driving the RAW object performs no selection at all — the
    // channel never patched it.
    await raw.startActivation(specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
    expect(provider.starts).toHaveLength(1)
    expect(provider.starts[0]!.request).not.toHaveProperty('agentPreset')
  })

  it('(j) unknown provider → NO_PROVIDER propagates unshadowed (the channel stays silent)', async () => {
    const { app } = await bootWithProvider('fake-spawn')

    const { captured, restore } = captureLogs()
    try {
      await expect(startActivationViaNativeChannel(app, specFor('no-such-provider', textPrompt(ASSIGNMENT_PROMPT))))
        .rejects.toThrow(/no subagent provider registered/)
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(k) an undeclared configured id is read ONCE through the roster (apply-time validation)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', {}, { rolePresets: { [EXECUTE_AS]: UNDECLARED_PRESET_ID } })

    // The validation warn fires during apply — before a test can install a
    // sink — so the observable is the roster read itself.
    const registry = registryOf(app)
    await untilReached(() => registry.reads.length > 0)
    expect(registry.reads).toEqual([UNDECLARED_PRESET_ID])

    // Advisory only: the mapping is left configured.
    await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
    expect(provider.starts[0]!.request.agentPreset).toBe(UNDECLARED_PRESET_ID)
  })

  it('(k2) a declared configured id produces no warning', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    const registry = registryOf(app)
    await untilReached(() => registry.reads.length > 0)
    expect(registry.reads).toEqual([PRESET_ID])

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

      expect(captured.filter(([level]) => level === 'warn')).toHaveLength(0)
      expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)
    } finally {
      restore()
    }
  })

  it('(l) composition without the agentPresets registry → no selection + ONE debug per apply (latch)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', {}, { agentPresetsService: undefined })

    const { captured, restore } = captureLogs()
    try {
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
      await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

      expect(provider.starts).toHaveLength(2)
      expect(provider.starts[0]!.request).not.toHaveProperty('agentPreset')
      expect(provider.starts[1]!.request).not.toHaveProperty('agentPreset')
      // ONE debug for the whole apply — the latch holds across starts.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain("'agentPresets' service is not mounted")
    } finally {
      restore()
    }
  })

  it('(m) the plugin-fiber read is branded (non-enumerable) and its other members still serve', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')

    // Boundary cast: the wrapper's own surface is asserted structurally below.
    const wrapper = (await readSubagents(app.ctx)) as Record<string | symbol, unknown>
    expect(Object.getOwnPropertySymbols(wrapper)).toEqual([ROLE_PERSONA_WRAPPER_BRAND])
    expect(wrapper[ROLE_PERSONA_WRAPPER_BRAND]).toBe(true)
    expect(Object.getOwnPropertyDescriptor(wrapper, ROLE_PERSONA_WRAPPER_BRAND)?.enumerable).toBe(false)
    // Non-enumerable brand + one own member: the key/spread surface stays
    // minimal and service-shaped.
    expect(Object.keys(wrapper)).toEqual(['startActivation'])
    // Every plugin-fiber read is wrapped, and a reader never receives the raw
    // service object (identity across reads is not comparable — cordis binds
    // the resolved service to the reading context).
    // Boundary cast: the wrapper's own surface is asserted structurally.
    const freshWrapper = (await readSubagents(app.ctx)) as Record<symbol, unknown>
    expect(freshWrapper[ROLE_PERSONA_WRAPPER_BRAND]).toBe(true)
    expect(wrapper).not.toBe(app.ctx.subagents)
    // Delegated members still serve.
    const service = wrapper as unknown as SubagentsServiceView
    expect(typeof service.startActivation).toBe('function')
    expect(service.getProvider('fake-spawn')).toBe(provider)
  })

  it('(n) an HMR re-apply binds the fresh Config — the new mapping selects, with no cross-talk', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn')
    await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
    expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)

    // HMR reload: dispose the plugin row's fiber (the host composition and its
    // services stay live) and re-apply the plugin with a DIFFERENT mapping.
    await app.pluginFiber!.dispose()
    const second = await app.ctx.plugin(plugin, {
      harnessDir: app.harnessDir,
      rolePresets: { [EXECUTE_AS]: PRESET_ID_ALT },
    })
    try {
      const { captured, restore } = captureLogs()
      try {
        await startActivationViaNativeChannel(app, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))

        expect(provider.starts[1]!.request.agentPreset).toBe(PRESET_ID_ALT)
        expect(captured).toHaveLength(1)
        expect(captured[0]![1]).toContain(`preset '${PRESET_ID_ALT}'`)
      } finally {
        restore()
      }
    } finally {
      await second.dispose()
    }

    // The listener belongs to the fiber that registered it: with both applies
    // disposed, reads answer the plain service again (no wrapper brand).
    // Boundary cast: the resolved service carries no declared symbol index.
    const afterDispose = (await readSubagents(app.ctx)) as Record<symbol, unknown>
    expect(afterDispose[ROLE_PERSONA_WRAPPER_BRAND]).toBeUndefined()
  })
})

/**
 * A subagents service that records the WHOLE spec it receives — the fields
 * the channel must forward verbatim, not only the request it merges into.
 */
class RecordingSubagents extends Service {
  /** The specs received, in call order. */
  readonly specs: Array<Record<string, unknown>> = []

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  /** A preset-capable provider for every name (the merge gate must pass). */
  getProvider(): { capabilities: { agentPreset: boolean }; inheritsParentContext: boolean } {
    return { capabilities: { agentPreset: true }, inheritsParentContext: false }
  }

  startActivation(spec: SubagentActivationSpecView): unknown {
    this.specs.push(spec as unknown as Record<string, unknown>)
    return { childId: 'recording-child' }
  }
}

/**
 * Minimal boot for the wrapper mechanics: loader + roster + the recording
 * service + the plugin row (the `internal/get` seam and the wrapper are the
 * production ones).
 */
async function bootWithRecording(rolePresets: Record<string, string>): Promise<{ ctx: Context; service: RecordingSubagents; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-role-preset-mechanics-'))
  const ctx = new Context()
  new FakeLoaderRegistry(ctx)
  new FakeAgentPresetRegistry(ctx, { declared: [PRESET_ID, PRESET_ID_ALT] })
  const service = new RecordingSubagents(ctx)
  await ctx.plugin(plugin, { harnessDir: join(root, 'harness'), rolePresets })
  return {
    ctx,
    service,
    dispose: async () => {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Drive one activation through the plugin-fiber read path on a minimal boot. */
function startOnCtx(ctx: Context, spec: SubagentActivationSpecView): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  void ctx.inject(['subagents'], (sctx) => {
    const service = sctx.subagents as unknown as SubagentsServiceView
    try {
      Promise.resolve(service.startActivation(spec)).then(resolve, reject)
    } catch (error) {
      reject(error)
    }
  })
  return promise
}

describe('native role-preset channel — wrapper mechanics', () => {
  it('(o) a spec field the channel does not consume reaches the service verbatim', async () => {
    const boot = await bootWithRecording({ [EXECUTE_AS]: PRESET_ID })
    try {
      const spec = specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT), {
        label: 'child label',
        childId: 'child-1',
        delivery: 'caller',
      })
      await startOnCtx(boot.ctx, spec)

      const received = boot.service.specs[0]!
      // The merge rebuilds the spec by spreading it: every non-consumed field
      // survives, and the selection lands on the request.
      expect(received.provider).toBe('fake-spawn')
      expect(received.label).toBe('child label')
      expect(received.childId).toBe('child-1')
      expect(received.delivery).toBe('caller')
      expect(received.signal).toBeInstanceOf(AbortSignal)
      // Boundary cast: the recorded spec is an untyped bag (the channel spreads it).
      const receivedRequest = received.request as RecordedRequest
      expect(receivedRequest.agentPreset).toBe(PRESET_ID)
    } finally {
      await boot.dispose()
    }
  })
})

/** A stand-in branded wrapper built exactly like the channel stamps them (decision-table input). */
function brandedWrapper(proto: object = {}): object {
  const wrapper = Object.create(proto)
  Object.defineProperty(wrapper, ROLE_PERSONA_WRAPPER_BRAND, { value: true, enumerable: false })
  return wrapper
}

describe('role persona seam probe — decision table (pure evaluateSeamProbe)', () => {
  it('(p1) canary fired + branded wrapper → ok, no reason (healthy, silent)', () => {
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: brandedWrapper() })).toEqual({ ok: true })
  })

  it('(p2) canary fired + read threw → ok:true, service-absent — never a warn', () => {
    const result = evaluateSeamProbe({ dispatched: true, readError: new Error('cannot get property "subagents" without inject'), value: undefined })
    expect(result).toEqual({ ok: true, reason: 'service-absent' })
  })

  it('(p3) canary fired + unbranded object → ok:false, wrap-skipped', () => {
    const result = evaluateSeamProbe({ dispatched: true, readError: undefined, value: Object.create(null) })
    expect(result).toEqual({ ok: false, reason: 'wrap-skipped' })
  })

  it('(p4) canary silent → ok:false, seam-absent — dominates value and error', () => {
    // A silent canary means the delivery channel is gone; no other input can rehabilitate it.
    expect(evaluateSeamProbe({ dispatched: false, readError: undefined, value: brandedWrapper() })).toEqual({ ok: false, reason: 'seam-absent' })
    expect(evaluateSeamProbe({ dispatched: false, readError: new Error('renamed seam'), value: undefined })).toEqual({ ok: false, reason: 'seam-absent' })
  })

  it('(p5) canary fired + non-object resolved values (undefined / null / primitive) → wrap-skipped', () => {
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: undefined })).toEqual({ ok: false, reason: 'wrap-skipped' })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: null })).toEqual({ ok: false, reason: 'wrap-skipped' })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: 'subagents' })).toEqual({ ok: false, reason: 'wrap-skipped' })
  })

  it('(p6) brand lookalikes → wrap-skipped (the brand must be exactly `true`)', () => {
    const wrongValue = Object.create(null)
    Object.defineProperty(wrongValue, ROLE_PERSONA_WRAPPER_BRAND, { value: false, enumerable: false })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: wrongValue })).toEqual({ ok: false, reason: 'wrap-skipped' })
    const wrongType = Object.create(null)
    Object.defineProperty(wrongType, ROLE_PERSONA_WRAPPER_BRAND, { value: 'yes', enumerable: false })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: wrongType })).toEqual({ ok: false, reason: 'wrap-skipped' })
  })
})

describe('role persona seam probe — probeRolePersonaSeam', () => {
  it('(p7) a probe-internal error fails open — ok:true, exactly one debug, never throws', () => {
    const { captured, restore } = captureLogs()
    try {
      const hostile = { on: () => { throw new Error('registration exploded') } } as unknown as Context
      expect(probeRolePersonaSeam(hostile)).toEqual({ ok: true })
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('fail-open')
      expect(captured[0]![1]).toContain('registration exploded')
    } finally {
      restore()
    }
  })

  it('(p8) the real wrapper carries the non-enumerable brand and the channel still selects after the apply-time probe ran', async () => {
    // The probe runs inside bootApp's apply (single call site after
    // registerRolePersonaChannel). Post-boot this composition must still show
    // the channel fully alive: reads are branded, the wrapper surface is
    // minimal (non-enumerable symbol), and selection still lands.
    booted = await bootApp({
      subagents: 'fake',
      agentPresetsService: [PRESET_ID, PRESET_ID_ALT],
      rolePresets: { [EXECUTE_AS]: PRESET_ID },
    })
    const provider = new FakeSubagentProvider('fake-spawn', { agentPresetCapability: true })
    ;(booted.ctx.subagents as unknown as FakeSubagentService).registerProvider(provider)

    const wrapper = (await readSubagents(booted.ctx)) as object
    expect(Object.getOwnPropertySymbols(wrapper)).toEqual([ROLE_PERSONA_WRAPPER_BRAND])
    // Boundary cast: the brand is a symbol-keyed own property.
    const brandedView = wrapper as Record<symbol, unknown>
    expect(brandedView[ROLE_PERSONA_WRAPPER_BRAND]).toBe(true)
    // Non-enumerable: the wrapper's key/spread surface stays service-shaped.
    expect(Object.keys(wrapper)).toEqual(['startActivation'])
    const descriptor = Object.getOwnPropertyDescriptor(wrapper, ROLE_PERSONA_WRAPPER_BRAND)
    expect(descriptor?.enumerable).toBe(false)

    // Delivery unchanged through the probed channel (no behavior change).
    await startActivationViaNativeChannel(booted, specFor('fake-spawn', textPrompt(ASSIGNMENT_PROMPT)))
    expect(provider.starts[0]!.request.agentPreset).toBe(PRESET_ID)
    // The apply-bound channel label is still pinned.
    expect(ROLE_PERSONA_LOGGER).toBe('mstar/role-persona')
  })
})
