/**
 * Persona seam probe pin family (plan Task 2) — a DEDICATED file (not an
 * extension of the persona suite) so a seam drift fails a NAMED spec. Pins
 * the three drift surfaces the probe exists for:
 *
 * - the seam NAME: `PERSONA_SEAM_EVENT` is the cordis `internal/get`
 *   service-read waterfall event; a rename is a one-line, intentional edit
 *   in `role-persona.ts` whose trigger is this file going red;
 * - the wrapper INSTALL: on a real composition, `subagents` reads through
 *   a runtime-bearing context resolve to the branded wrapper (exactly one
 *   own symbol, value `true`, non-enumerable, key surface unchanged) and a
 *   start through the native channel still SELECTS the role's preset
 *   (`request.agentPreset`);
 * - the probe VERDICTS: the full `evaluateSeamProbe` outcome table (f2–f6
 *   below are the authoritative table home; Task 1's unit originals p1–p6
 *   live in `role-persona.spec.ts`), the sanctioned apply-ctx
 *   `service-absent` no-warn path, the `wrap-skipped` end-to-end variant,
 *   and the warn-emission surface (exactly ONE `mstar/role-persona` WARN,
 *   templated on `PERSONA_SEAM_EVENT`, when `ok === false`).
 *
 * Context shapes (Task 1 report note): a proxied `internal/get` dispatch
 * only happens on a RUNTIME-BEARING context — the full branded-`ok` probe
 * runs inside the same inject scope the harness's real subagents resolution
 * uses (`startActivationViaNativeChannel`); a plugin-fiber apply context
 * (`inject: ['loader']`, the wiring shape) cannot resolve `subagents` and
 * lands `service-absent` by design — never a warn; a root-fiber context
 * does not dispatch the waterfall at all → `seam-absent` → the fail-loud
 * warn, even though the raw read still resolves.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'bun:test'
import {
  FakeLoaderRegistry,
  FakeSubagentProvider,
  FakeSubagentService,
  bootApp,
  startActivationViaNativeChannel,
  type BootResult,
} from './harness.ts'
import {
  PERSONA_SEAM_EVENT,
  ROLE_PERSONA_LOGGER,
  ROLE_PERSONA_WRAPPER_BRAND,
  evaluateSeamProbe,
  probeRolePersonaSeam,
  setRolePersonaLogger,
  type PersonaSeamProbeResult,
  type RolePersonaLogLevel,
  type SubagentsServiceView,
} from '../src/gates/role-persona.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mstar role id the test Assignment declares and the preset map is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** The registered provider name every start is driven against. */
const PROVIDER = 'fake-spawn'

/** The deployed agent preset id the role selects (the channel's merge target). */
const PRESET = 'mstar-execute'

/** One mstar-style Assignment prompt sent as the start request's task text. */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/**
 * The fail-loud warn, reconstructed by templating the exported seam
 * constant exactly as `role-persona.ts` does (`SEAM_WARN` + the probe's
 * reason suffix) — the warn-emission pin asserts this verbatim, so a
 * wording or seam drift in the operator-facing message fails here.
 */
const SEAM_WARN_TEXT = `role persona channel not installed — cordis '${PERSONA_SEAM_EVENT}' seam missing or unrecognized (role presets will not be selected for subagent starts)`

/** Capture role-persona logs through the module sink (agent-flow test pattern). */
function captureLogs(): { captured: Array<[RolePersonaLogLevel, string]>; restore: () => void } {
  const captured: Array<[RolePersonaLogLevel, string]> = []
  const prior = setRolePersonaLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setRolePersonaLogger(prior) }
}

/** A stand-in branded wrapper built exactly like the channel stamps them (decision-table input). */
function brandedWrapper(proto: object = {}): object {
  const wrapper = Object.create(proto)
  Object.defineProperty(wrapper, ROLE_PERSONA_WRAPPER_BRAND, { value: true, enumerable: false })
  return wrapper
}

/** One native `startActivation` spec whose request prompt text carries `text` (Assignment or plain). */
function startSpec(text: string): Parameters<SubagentsServiceView['startActivation']>[0] {
  return { provider: PROVIDER, request: { prompt: [{ type: 'text', text }] } }
}

/**
 * Boot the delivery composition: the FAKE subagents service (the channel's
 * wrap target — its `startActivation` is the one start surface of dsh 0.2.1)
 * + the fake `agentPresets` registry declaring the role's preset + one
 * preset-capable provider.
 */
async function bootWithProvider(): Promise<{ app: BootResult; provider: FakeSubagentProvider }> {
  booted = await bootApp({ subagents: 'fake', agentPresetsService: [PRESET], rolePresets: { [EXECUTE_AS]: PRESET } })
  const provider = new FakeSubagentProvider(PROVIDER, { agentPresetCapability: true })
  // Registration targets the raw root-context read (the root fiber has no
  // runtime, so the read bypasses the channel wrapper — the direct registry
  // path; the wrapper delegates the same registry anyway).
  ;(booted.ctx.subagents as unknown as FakeSubagentService).registerProvider(provider)
  return { app: booted, provider }
}

describe('persona seam probe — pin family', () => {
  it('(f1) the seam is the cordis internal/get service-read waterfall event (literal pin)', () => {
    // A rename of the seam constant must be a one-line, INTENTIONAL edit in
    // role-persona.ts — this pin is the failing trigger, and the exact warn
    // pins below (f9)/(f10) carry the same templated literal.
    expect(PERSONA_SEAM_EVENT).toBe('internal/get')
    // The logger label the apply-bound sink registers under (the
    // `mstar/role-persona` WARN surface the fail-loud contract names).
    expect(ROLE_PERSONA_LOGGER).toBe('mstar/role-persona')
  })
})

describe('persona seam probe — decision table (pure evaluateSeamProbe, one home)', () => {
  it('(f2) canary fired + branded wrapper → ok, no reason (healthy, silent)', () => {
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: brandedWrapper() })).toEqual({ ok: true })
  })

  it('(f3) canary fired + read threw → ok:true, service-absent — never a warn', () => {
    const result = evaluateSeamProbe({ dispatched: true, readError: new Error('cannot get property "subagents" without inject'), value: undefined })
    expect(result).toEqual({ ok: true, reason: 'service-absent' })
  })

  it('(f4) canary fired + unbranded object or non-object resolved values → wrap-skipped', () => {
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: Object.create(null) })).toEqual({ ok: false, reason: 'wrap-skipped' })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: undefined })).toEqual({ ok: false, reason: 'wrap-skipped' })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: null })).toEqual({ ok: false, reason: 'wrap-skipped' })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: 'subagents' })).toEqual({ ok: false, reason: 'wrap-skipped' })
  })

  it('(f5) canary silent → ok:false, seam-absent — dominates value and error', () => {
    // A silent canary means the delivery channel is gone; no other input can rehabilitate it.
    expect(evaluateSeamProbe({ dispatched: false, readError: undefined, value: brandedWrapper() })).toEqual({ ok: false, reason: 'seam-absent' })
    expect(evaluateSeamProbe({ dispatched: false, readError: new Error('renamed seam'), value: undefined })).toEqual({ ok: false, reason: 'seam-absent' })
  })

  it('(f6) brand lookalikes → wrap-skipped (the brand must be exactly `true`)', () => {
    const wrongValue = Object.create(null)
    Object.defineProperty(wrongValue, ROLE_PERSONA_WRAPPER_BRAND, { value: false, enumerable: false })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: wrongValue })).toEqual({ ok: false, reason: 'wrap-skipped' })
    const wrongType = Object.create(null)
    Object.defineProperty(wrongType, ROLE_PERSONA_WRAPPER_BRAND, { value: 'yes', enumerable: false })
    expect(evaluateSeamProbe({ dispatched: true, readError: undefined, value: wrongType })).toEqual({ ok: false, reason: 'wrap-skipped' })
  })
})

describe('persona seam probe — real composition (bootApp, fake subagents service)', () => {
  it('(f7) full probe from an inject-scoped runtime-bearing ctx → ok:true, silent; the read is branded; start still selects the preset', async () => {
    const { app, provider } = await bootWithProvider()

    const { captured, restore } = captureLogs()
    try {
      // The probe runs inside the SAME inject scope the harness's real
      // subagents resolution uses (startActivationViaNativeChannel) — the
      // runtime-bearing context whose proxied read dispatches the waterfall,
      // so the branded-`ok` branch is exercised end to end.
      const probed = Promise.withResolvers<PersonaSeamProbeResult>()
      const wrapperReady = Promise.withResolvers<unknown>()
      void app.ctx.inject(['subagents'], (sctx) => {
        // Guarded: the inject callback is fire-and-forget (`void`), so an
        // unhandled throw here would never settle `probed` and the await
        // below would time out instead of failing as an assertion — compute
        // both values first, then resolve; any throw rejects `probed`.
        try {
          const result = probeRolePersonaSeam(sctx)
          const wrapper = (sctx as unknown as { subagents?: unknown }).subagents
          probed.resolve(result)
          wrapperReady.resolve(wrapper)
        } catch (error) {
          probed.reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
      expect(await probed.promise).toEqual({ ok: true })
      // Healthy boot + probe: silent — no warn (and nothing else yet).
      expect(captured.some(([level]) => level === 'warn')).toBe(false)
      expect(captured).toHaveLength(0)

      // The controlled read's value: the branded wrapper — exactly one own
      // symbol (the brand), value `true`, NON-enumerable (key/spread surface
      // stays service-shaped), and the wrapper stops installing the moment
      // the brand stamp drifts (this assertion is that tripwire).
      const wrapper = (await wrapperReady.promise) as object
      expect(Object.getOwnPropertySymbols(wrapper)).toEqual([ROLE_PERSONA_WRAPPER_BRAND])
      expect((wrapper as Record<symbol, unknown>)[ROLE_PERSONA_WRAPPER_BRAND]).toBe(true)
      expect(Object.getOwnPropertyDescriptor(wrapper, ROLE_PERSONA_WRAPPER_BRAND)?.enumerable).toBe(false)
      expect(Object.keys(wrapper)).toEqual(['startActivation'])

      // Delivery unchanged through the probed channel: the start SELECTS the
      // role's preset in the resolved request (the one delivery debug is the
      // only log — still zero warns).
      await startActivationViaNativeChannel(app, startSpec(ASSIGNMENT_PROMPT))
      expect(provider.starts[0]!.request.agentPreset).toBe(PRESET)
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
    } finally {
      restore()
    }
  })

  it('(f8) the wiring shape (plugin-fiber apply ctx, inject: [loader]) lands service-absent by design — never a warn', async () => {
    // The real plugin applies with `inject: ['loader']`, so the in-apply
    // controlled read cannot resolve `subagents` (throws "without inject")
    // even on a composition that provides the service — the outcome table's
    // sanctioned `service-absent` row (`ok: true`, one debug, NO warn).
    // This fixture replicates exactly that apply-context shape.
    const ctx = new Context()
    new FakeLoaderRegistry(ctx)
    const { captured, restore } = captureLogs()
    let result: PersonaSeamProbeResult | undefined
    try {
      await ctx.plugin({
        name: 'persona-seam-probe-apply-ctx-fixture',
        inject: ['loader'],
        apply: (applyCtx: Context) => { result = probeRolePersonaSeam(applyCtx) },
      } as Parameters<Context['plugin']>[0])
      expect(result).toEqual({ ok: true, reason: 'service-absent' })
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('unresolved at apply')
    } finally {
      restore()
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('(f9) wrap-skipped end to end: the seam dispatches but the value reaches the probe unbranded → exactly ONE warn, verbatim', async () => {
    const { app } = await bootWithProvider()
    // A hostile INNER listener (registered AFTER the plugin, so it composes
    // inside the channel's `next()` — the wrap-containment test pattern):
    // hands the channel an unrecognized shape, driving the real
    // `wrapSubagentsService` pass-through (the listener ran, nothing was
    // wrapped) — the exact runtime path the `wrap-skipped` verdict names.
    app.ctx.on(PERSONA_SEAM_EVENT, (_readCtx, name, _error, next) => {
      const value: unknown = next()
      if (name !== 'subagents') return value
      return {}
    })

    const { captured, restore } = captureLogs()
    try {
      const probed = Promise.withResolvers<PersonaSeamProbeResult>()
      void app.ctx.inject(['subagents'], (sctx) => { probed.resolve(probeRolePersonaSeam(sctx)) })
      expect(await probed.promise).toEqual({ ok: false, reason: 'wrap-skipped' })
      // The warn-emission surface: exactly ONE `mstar/role-persona` WARN,
      // the SEAM_WARN text templated on PERSONA_SEAM_EVENT + the reason.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('warn')
      expect(captured[0]![1]).toBe(`${SEAM_WARN_TEXT} (reason: wrap-skipped)`)
    } finally {
      restore()
    }
  })

  it('(f10) seam-absent end to end: a context that cannot dispatch warns ONCE, verbatim, despite the raw read resolving', async () => {
    const { app } = await bootWithProvider()
    const { captured, restore } = captureLogs()
    try {
      // The root fiber is not runtime-bearing: the controlled read resolves
      // the RAW runtime (no waterfall dispatch — the codebase's own pinned
      // root-read behavior) while the canary stays silent. `seam-absent`
      // dominates the resolved value — the fail-loud drift this family
      // exists to catch, with everything else looking healthy.
      expect(probeRolePersonaSeam(app.ctx)).toEqual({ ok: false, reason: 'seam-absent' })
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('warn')
      expect(captured[0]![1]).toBe(`${SEAM_WARN_TEXT} (reason: seam-absent)`)
    } finally {
      restore()
    }
  })
})
