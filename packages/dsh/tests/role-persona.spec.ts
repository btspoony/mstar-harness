/**
 * Task 3 — native-first role-persona delivery (plan
 * ): a role-matched one-shot start
 * merges the persona into the request's NATIVE `persona` slot
 * (`@deepseek-ai/dsh-subagent` `SubagentStartRequest.persona`); the additive
 * `mstar:role-persona` system-prompt section is GONE. dsh composes the
 * native persona as the scoped shadowing `deployment:persona` section
 * (order 0), persists it in the child descriptor, and reapplies it on
 * resume — those semantics are upstream's; this suite pins the MERGE
 * contract:
 *
 * - the interception seam is the cordis `internal/get` service-read
 *   waterfall: `ctx.subagents` reads through a plugin-fiber context return
 *   the wrapping delegate, and the underlying runtime object is never
 *   mutated (reads of OTHER services pass through untouched);
 * - the REAL `@deepseek-ai/dsh-subagent` runtime is mounted and a
 *   `FakeSubagentProvider` records the RESOLVED request — post-merge,
 *   post-capability-gate;
 * - the capability gate: the native contract rejects a persona request for
 *   a provider without `SubagentCapabilities.persona` (fail loud), so the
 *   channel skips the merge for such providers and the start proceeds;
 * - persona delivery is fallbacks-independent: unmounted AND mounted
 *   fallbacks compositions both deliver (fallbacks stays seeds + advisory).
 *
 * Persona source precedence (* unchanged): an explicit `request.persona` (caller intent) wins →
 * `Config.rolePersonas[executeAs]` → bundled `harness-agents/` mirror
 * default → skip. `PERSONA_INTERPOLATION_HAZARD` validation stays
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'bun:test'
import type { SubagentStartRequest, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fallbacks from 'dsh-llm-fallbacks'
import * as plugin from '../src/index.ts'
import type { SubagentStartRequestView, SubagentsServiceView } from '../src/gates/role-persona.ts'
import {
  FakeLoaderRegistry,
  FakeSettingsRegistry,
  FakeSubagentProvider,
  bootApp,
  startViaNativeChannel,
  type BootResult,
} from './harness.ts'
import { fallbacksMounted } from '../src/gates/fallbacks-probe.ts'
import {
  ROLE_PERSONA_LOGGER,
  ROLE_PERSONA_WRAPPER_BRAND,
  evaluateSeamProbe,
  probeRolePersonaSeam,
  setRolePersonaAgentsDir,
  setRolePersonaLogger,
  type RolePersonaLogLevel,
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

/** The 0.5.2 fallbacks-declared persona competing for the SAME native slot (AC-7). */
const FALLBACKS_PERSONA = 'You are the fallbacks-declared executor persona.'

/** A declared-role id OUTSIDE mstar's taxonomy — isolates the fallbacks delivery path. */
const FALLBACKS_ONLY_ROLE = 'ac7-control'

/** One mstar-style Assignment prompt sent as the start request's task text. */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** A non-Assignment task prompt (no header fields). */
const PLAIN_PROMPT = 'Summarize the attached file.'

/**
 * The REVERSED-composition row list (case (t)): the same rows the default
 * boot composes, with the REAL `dsh-llm-fallbacks` row BEFORE the
 * `@mstar-harness/dsh` row. Both layers intercept the same `internal/get`
 * service read and each fills the native `persona` slot only when it is
 * free, so the composition order decides which wrapper runs first — the
 * default order mounts the mstar row first (probed on dsh 0.1.0-rc.6), this
 * fixture pins the re-ordered one.
 */
const REVERSED_CORDIS_YML = join(import.meta.dir, 'fixtures', 'cordis-fallbacks-first.yml')

/** One fixture mirror shell: frontmatter `name` + block-scalar `description` (`mode: subagent`). */
const mirrorShell = (name: string, description: string): string => [
  '---',
  `name: ${name}`,
  'description: |-',
  ...description.split('\n').map((line) => `  ${line}`),
  'mode: subagent',
  '---',
  '',
  '## Morning Star Role Binding',
].join('\n')

/** The mirror default persona for `fullstack-dev` (multiline `|-` description). */
const MIRROR_DEFAULT = 'Line one of the mirror default.\nLine two of the mirror default.'

/** A fixture mirror shell whose default differs from the config PERSONA. */
const MIRROR_SHELL = mirrorShell(EXECUTE_AS, MIRROR_DEFAULT)

/** A second mirror default (distinct text — the sink re-bind pin target). */
const MIRROR_DEFAULT_ALT = 'Alternate mirror default persona.'

/** A second fixture mirror shell whose default differs from MIRROR_DEFAULT. */
const MIRROR_SHELL_ALT = mirrorShell(EXECUTE_AS, MIRROR_DEFAULT_ALT)

/** A mirror-only probe role (configured NOWHERE) — the sink re-bind pin reads its persona. */
const PROBE_ROLE = 'probe-dev'

/** The probe-role shells (stems match PROBE_ROLE; the default differs per fixture root). */
const PROBE_SHELL = mirrorShell(PROBE_ROLE, MIRROR_DEFAULT)
const PROBE_SHELL_ALT = mirrorShell(PROBE_ROLE, MIRROR_DEFAULT_ALT)

/** A fixture mirror shell whose description carries the interpolation hazard. */
const HAZARD_SHELL = [
  '---',
  `name: ${EXECUTE_AS}`,
  'description: |-',
  '  You are the {{role}} executor.',
  'mode: subagent',
  '---',
  '',
  '## Morning Star Role Binding',
].join('\n')

/** Seed a throwaway fixture mirror (each test gets a fresh root — unique cache keys). */
async function fixtureMirror(shells: Array<[string, string]>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-role-persona-mirror-'))
  for (const [name, content] of shells) await writeFile(join(dir, name), content)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Capture role-persona logs through the module sink (agent-flow test pattern). */
function captureLogs(): { captured: Array<[RolePersonaLogLevel, string]>; restore: () => void } {
  const captured: Array<[RolePersonaLogLevel, string]> = []
  const prior = setRolePersonaLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setRolePersonaLogger(prior) }
}

/**
 * Boot with the REAL subagents runtime + one fake provider named
 * `providerName`. Default Config: `rolePersonas[fullstack-dev]` = PERSONA
 * (pass `rolePersonas: undefined` for mirror-only tests, `null` for the
 * null-safe guard test).
 */
async function bootWithProvider(
  providerName: string,
  options: { personaCapability?: boolean } = {},
  bootOverrides: Partial<Parameters<typeof bootApp>[0]> = {},
): Promise<{ app: BootResult; provider: FakeSubagentProvider }> {
  const app = booted = await bootApp({
    agentsService: 'fake',
    subagents: 'real',
    rolePersonas: { [EXECUTE_AS]: PERSONA },
    ...bootOverrides,
  })
  const provider = new FakeSubagentProvider(providerName, options)
  // Registration targets the raw root-context read (the root fiber has no
  // runtime, so the read bypasses the channel wrapper — the direct registry
  // path; the wrapper delegates the same registry anyway).
  ;(app.ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)
  return { app, provider }
}

/**
 * Declare fallback roles through the REAL settings seam (0.5.2 composes its
 * live config from `settings.installSection` — base row + stored section, so
 * a stored `roles` payload is what an operator's settings.yaml would carry:
 * the competing role-identity source). The plugin re-reads the section live,
 * so a declaration made after the row applied takes effect.
 */
async function declareFallbacksRoles(app: BootResult, roles: Array<{ id: string; persona: string }>): Promise<void> {
  const settings = app.ctx.get('settings') as FakeSettingsRegistry | undefined
  if (settings === undefined) throw new Error('settings seam unavailable in the fallbacks composition')
  await settings.update('fallbacks', { roles: { list: roles, rules: [] } })
}

/**
 * {@link declareFallbacksRoles}, then mount the 0.5.2 `dsh-llm-fallbacks` row
 * as a plain plugin row (the Task 1 probe test's entry-shape cast) with no
 * config argument — the composition where the mstar row mounts FIRST.
 */
async function applyFallbacksRow(app: BootResult, roles: Array<{ id: string; persona: string }>): Promise<void> {
  await declareFallbacksRoles(app, roles)
  const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
  await app.ctx.plugin(fallbacksPlugin)
  expect(fallbacksMounted(app.ctx)).toBe(true)
}

/** A real start request whose prompt text carries `text` (Assignment or plain). */
function startRequest(text: string, overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text }],
    parent: { id: 'parent-fake', session: { id: 'parent-fake' } },
    signal: new AbortController().signal,
    ...overrides,
  } as unknown as SubagentStartRequest
}

/** Compile-time drift gate: the REAL runtime surface stays assignable to the structural views this module consumes. */
type _RuntimeViewGate = SubagentRuntime extends SubagentsServiceView ? true : false
const _runtimeViewGate: _RuntimeViewGate = true
type _RequestViewGate = SubagentStartRequest extends SubagentStartRequestView ? true : false
const _requestViewGate: _RequestViewGate = true

describe('native persona channel — SubagentStartRequest.persona merge', () => {
  it('(a) Assignment with a configured Execute as → the resolved request carries the native persona', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts).toHaveLength(1)
      expect(provider.starts[0]!.request.descriptor).toMatchObject({ provider: 'fake-spawn', mode: 'one-shot' })
      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
      // Exactly one debug line — the delivery log naming the CHANNEL (no
      // fallbacks state in it).
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('native subagent persona channel')
      expect(captured[0]![1]).toContain(EXECUTE_AS)
    } finally {
      restore()
    }
  })

  it('(b) role-unmatched or non-Assignment prompt → request unchanged, silent', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout')))
      await startViaNativeChannel(app, 'fake-spawn', startRequest(PLAIN_PROMPT))

      expect(provider.starts).toHaveLength(2)
      expect(provider.starts[0]!.request.persona).toBeUndefined()
      expect(provider.starts[1]!.request.persona).toBeUndefined()
      expect(captured).toHaveLength(0) // no-op is silent
    } finally {
      restore()
    }
  })

  it('(c) fallbacks unmounted → persona still merged (native channel is fallbacks-independent) + one debug log', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    expect(fallbacksMounted(app.ctx)).toBe(false) // no fallbacks row applied

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
      // Exactly one log line, at debug level — and it names the CHANNEL, not fallbacks.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('native subagent persona channel')
      expect(captured[0]![1]).not.toContain('dsh-llm-fallbacks')
    } finally {
      restore()
    }
  })

  it('(d) provider without the persona capability → persona skipped + one debug, start proceeds (no fail-loud rejection)', async () => {
    // The native contract REJECTS a persona request for a capability-false
    // provider (out-of-process degrade shape) — the gate must prevent that
    // rejection by not merging.
    const { app, provider } = await bootWithProvider('fake-oop', { personaCapability: false })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-oop', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts).toHaveLength(1) // start resolved — never rejected
      expect(provider.starts[0]!.request.persona).toBeUndefined()
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('lacks the persona capability')
    } finally {
      restore()
    }
  })

  it('(e) composition with dsh-llm-fallbacks applied → persona still merged (seeds + advisory stay the fallbacks surface)', async () => {
    // 0.5.2 provides `llm-fallbacks` inside `ctx.inject(["settings"], …)`:
    // without the settings seam the plugin applies but registers no service,
    // so the composition would not actually be a fallbacks composition. Same
    // seam the probe test boots (the real dsh app always composes
    // `dsh-settings-file` before the plugin layers).
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { settingsService: 'fake' })
    // The real registry plugin applied as a row (same entry-shape cast the
    // Task 1 probe test applies).
    const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
    await app.ctx.plugin(fallbacksPlugin)
    expect(fallbacksMounted(app.ctx)).toBe(true)

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
      // Persona delivery no longer logs fallbacks state as its channel — the
      // one delivery line names the native channel only.
      expect(captured).toHaveLength(1)
      expect(captured[0]![1]).not.toContain('dsh-llm-fallbacks')
    } finally {
      restore()
    }
  })

  it('(f) request with no text blocks → request unchanged, silent', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(''))
      await startViaNativeChannel(app, 'fake-spawn', {
        prompt: [{ type: 'image', source: 'x' }],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      } as unknown as SubagentStartRequest)

      expect(provider.starts).toHaveLength(2)
      expect(provider.starts[0]!.request.persona).toBeUndefined()
      expect(provider.starts[1]!.request.persona).toBeUndefined()
      expect(captured).toHaveLength(0) // empty prompt → nothing to parse → silent no-op
    } finally {
      restore()
    }
  })

  it('(g) persona values containing the {{...}} interpolation hazard are rejected at config validation (W-001)', async () => {
    // The native persona has the SAME strict `{{…}}` template semantics as
    // the deployment persona (dsh renders it at child composition), so the
    // Config schema keeps rejecting such values at plugin mount with a clear
    // error instead of breaking every role-matched dispatch later.
    expect(() => plugin.Config({ rolePersonas: { [EXECUTE_AS]: `You are {{role}}` } } as never)).toThrow(/rolePersonas\["fullstack-dev"\] must not contain/)
    // A lone `{{` with no later `}}` renders as literal prose (safe) — allowed.
    expect(() => plugin.Config({ rolePersonas: { [EXECUTE_AS]: 'Use single braces in prose: {like this}.' } } as never)).not.toThrow()
    // Plain persona text without the hazard passes.
    expect(() => plugin.Config({ rolePersonas: { [EXECUTE_AS]: PERSONA } } as never)).not.toThrow()
    // The same rejection surfaces on the mount path: `ctx.plugin` validates
    // the config against the shipping schemastery schema (the loader path),
    // so a violating persona fails at APPLY with the clear error — never
    // deferred to a broken child prompt assembly.
    const ctx = new Context()
    new FakeLoaderRegistry(ctx)
    let rejected = false
    try {
      await ctx.plugin(plugin, { rolePersonas: { [EXECUTE_AS]: `You are {{role}}` } } as never)
    } catch (error) {
      rejected = true
      expect((error as Error).message).toContain('must not contain')
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
    expect(rejected).toBe(true)
  })

  it('(h) containment — a throwing log sink never escapes; a throwing merge degrades with one warn and the original request', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    // (1) Log containment : the merge still lands while the
    // sink throws — the delivery debug never escapes the channel.
    const sinkThrows = setRolePersonaLogger(() => { throw new Error('sink exploded') })
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
    } finally {
      setRolePersonaLogger(sinkThrows)
    }
    // (2) Merge containment: a prompt getter that throws drives
    // withRolePersona into its catch — the wrapper warns ONCE and forwards
    // the ORIGINAL request. The runtime's own spread then reads the poisoned
    // prompt and rejects — the channel adds NO new failure surface (the same
    // request rejects with or without the channel).
    const hostile: SubagentStartRequest = startRequest('irrelevant')
    Object.defineProperty(hostile, 'prompt', {
      get() { throw new Error('prompt exploded') },
    })
    const { captured, restore } = captureLogs()
    try {
      await expect(startViaNativeChannel(app, 'fake-spawn', hostile)).rejects.toThrow('prompt exploded')
      expect(provider.starts).toHaveLength(1) // the poisoned start never reached the provider
      expect(captured.some(([level, message]) => level === 'warn' && message.includes('degraded to pass-through'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('(i) rolePersonas: null config + no mirror → start proceeds, silent no-op (null-safe perf guard, N-002)', async () => {
    // schemastery's `isNullable` passes `null` through the Config transform
    // unvalidated, so `config.rolePersonas` can be `null` at runtime despite
    // the TS type. The perf guard must be null-safe. The mirror is bound
    // ABSENT here so the guard path is exercised deterministically.
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { rolePersonas: null as never })
    const prior = setRolePersonaAgentsDir(undefined)
    try {
      const { captured, restore } = captureLogs()
      try {
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
        expect(provider.starts[0]!.request.persona).toBeUndefined()
        expect(captured).toHaveLength(0) // silent no-op
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(prior)
    }
  })

  // ---- Task 3 lookup chain : explicit request → config → mirror default → skip ----

  it('(p) an explicit request persona (caller intent) wins over the role persona', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT, { persona: 'caller persona' }))

      expect(provider.starts[0]!.request.persona).toBe('caller persona')
      expect(captured).toHaveLength(0) // caller intent respected silently
    } finally {
      restore()
    }
  })

  // ---- AC-7 : caller-set persona under the real dsh-llm-fallbacks 0.5.2 composition ----

  it('(q) real dsh-llm-fallbacks 0.5.2 row + settings seam → an explicit caller persona still wins (AC-7)', async () => {
    // 0.5.2's dispatch seam competes for the SAME native slot: it resolves
    // the declared role from this Assignment and merges that role's declared
    // `persona` when the slot is free. Declaring a persona for the SAME role
    // id makes that competing delivery live; the caller's value must win.
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { settingsService: 'fake' })
    await applyFallbacksRow(app, [{ id: EXECUTE_AS, persona: FALLBACKS_PERSONA }])

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT, { persona: 'caller persona' }))

      expect(provider.starts[0]!.request.persona).toBe('caller persona')
      expect(captured).toHaveLength(0) // caller intent respected silently
    } finally {
      restore()
    }
  })

  it('(r) the same 0.5.2 composition delivers the declared fallbacks persona when the slot is free (AC-7 control)', async () => {
    // Same row + settings seam, but the Assignment declares a role OUTSIDE
    // mstar's taxonomy: the mstar channel resolves nothing, so the observed
    // persona can only come from the fallbacks seam. This shows the 0.5.2
    // role-identity path really fills the native slot on this composition —
    // (q)'s caller-wins assertion is not vacuous.
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { settingsService: 'fake' })
    await applyFallbacksRow(app, [{ id: FALLBACKS_ONLY_ROLE, persona: FALLBACKS_PERSONA }])

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, FALLBACKS_ONLY_ROLE)))

      expect(provider.starts[0]!.request.persona).toBe(FALLBACKS_PERSONA)
      expect(captured).toHaveLength(0) // the mstar channel had nothing to deliver
    } finally {
      restore()
    }
  })


  it('(s) Execute as fullstack-dev with no caller persona: mstar Config.rolePersonas wins over a distinct fallbacks row persona', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { settingsService: 'fake' })
    await applyFallbacksRow(app, [{ id: EXECUTE_AS, persona: FALLBACKS_PERSONA }])

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
    } finally {
      restore()
    }
  })

  it('(t) reversed composition (the fallbacks row BEFORE the mstar row): the operator Config.rolePersonas persona still wins — the wrapper order never displaces it', async () => {
    // (q)/(r)/(s) pin the DEFAULT profile order (mstar row first), where the
    // mstar wrapper is registered first and therefore runs first. This case
    // pins the RE-ORDERED composition: the real 0.5.2 row applies first — the
    // non-default profile order / a re-applied plugin row — so the fallbacks
    // wrapper would otherwise claim the native slot before the harness
    // channel ever sees the request. The operator's `rolePersonas` override is
    // the authoritative role identity for a role the harness resolves, so it
    // must win the slot on EITHER order. The competing fallbacks persona is
    // declared through the real settings seam — the same `roles.list[]`
    // materialization the mstar seeds/`harness-agents` mirror feeds.
    const app = booted = await bootApp({
      cordisYml: REVERSED_CORDIS_YML,
      agentsService: 'fake',
      subagents: 'real',
      settingsService: 'fake',
      fallbacksModule: fallbacks,
      rolePersonas: { [EXECUTE_AS]: PERSONA },
    })
    const provider = new FakeSubagentProvider('fake-spawn', { personaCapability: true })
    // Registration targets the raw root-context read (the root fiber has no
    // runtime) — the same direct registry path `bootWithProvider` uses.
    ;(app.ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)
    await declareFallbacksRoles(app, [
      { id: EXECUTE_AS, persona: FALLBACKS_PERSONA },
      { id: FALLBACKS_ONLY_ROLE, persona: FALLBACKS_PERSONA },
    ])

    const { captured, restore } = captureLogs()
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
      // The delivered persona is the CONFIG one — the merge log names the source.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('mstar Config')

      // Liveness control: on THIS composition the fallbacks seam really does
      // own the slot for a role the harness channel resolves nothing for —
      // so the assertion above is not vacuous (the 0.5.2 role-identity path
      // is live and would have filled the same slot first).
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, FALLBACKS_ONLY_ROLE)))
      expect(provider.starts[1]!.request.persona).toBe(FALLBACKS_PERSONA)
    } finally {
      restore()
    }
  })

  it('(j) config persona wins over a mirror default (lookup chain: config → default)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, MIRROR_SHELL]])
    const prior = setRolePersonaAgentsDir(fixture.dir)
    try {
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

      // The configured persona wins — the mirror default is never consulted.
      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
    } finally {
      setRolePersonaAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(k) no configured persona → the mirror default is delivered (multiline |- description)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { rolePersonas: undefined })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, MIRROR_SHELL]])
    const prior = setRolePersonaAgentsDir(fixture.dir)
    try {
      const { captured, restore } = captureLogs()
      try {
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

        expect(provider.starts[0]!.request.persona).toBe(MIRROR_DEFAULT)
        // Exactly one debug log, naming the default source.
        expect(captured).toHaveLength(1)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[0]![1]).toContain('harness-agents default')
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(m) a mirror shell whose description carries the {{...}} hazard → default skipped + one warn, never throws', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { rolePersonas: undefined })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, HAZARD_SHELL]])
    const prior = setRolePersonaAgentsDir(fixture.dir)
    try {
      const { captured, restore } = captureLogs()
      try {
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))

        expect(provider.starts).toHaveLength(2)
        expect(provider.starts[0]!.request.persona).toBeUndefined()
        // Exactly ONE warn across both starts — the per-(mirrorRoot, mtime)
        // cache warns at extraction time (first miss) and serves the cached
        // skip on the second lookup. No other logs: mirror present, no merge.
        expect(captured).toHaveLength(1)
        expect(captured[0]![0]).toBe('warn')
        expect(captured[0]![1]).toContain(EXECUTE_AS)
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(n) mirror absent → config-only lookups, one debug log per apply (not per start)', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    // Force the mirror absent (the apply binds the packaged mirror).
    const prior = setRolePersonaAgentsDir(undefined)
    try {
      const { captured, restore } = captureLogs()
      try {
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout')))
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'explorer')))

        // Config hit → persona merged + its single delivery debug log.
        expect(provider.starts[0]!.request.persona).toBe(PERSONA)
        // Config miss + no mirror → skipped + ONE mirror-absent debug per
        // apply (the latch holds across further starts — never per lookup).
        expect(provider.starts[1]!.request.persona).toBeUndefined()
        expect(provider.starts[2]!.request.persona).toBeUndefined()

        // Three starts → still exactly two debug lines (one merge + one mirror-absent).
        expect(captured).toHaveLength(2)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[1]![0]).toBe('debug')
        expect(captured[1]![1]).toContain('mirror absent')
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(prior)
    }
  })

  it('(o) hostile Execute as (dot-traversal) → no merge, no fs access outside the mirror, never throws', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true }, { rolePersonas: undefined })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, MIRROR_SHELL]])
    // A trap shell OUTSIDE the fixture mirror, reachable via `../` join
    // normalization — if the role id reached the filesystem, its persona
    // would be merged (the exact attack path through the
    // Assignment-header parse).
    const stem = `evil-${Math.random().toString(36).slice(2)}`
    const trap = join(tmpdir(), `${stem}.md`)
    await writeFile(trap, MIRROR_SHELL)
    const prior = setRolePersonaAgentsDir(fixture.dir)
    try {
      const { captured, restore } = captureLogs()
      try {
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, `../${stem}`)))
        expect(provider.starts[0]!.request.persona).toBeUndefined()
        // Invalid role id → silent skip (mirror present): no logs at all.
        expect(captured).toHaveLength(0)
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(prior)
      await fixture.cleanup()
      await rm(trap, { force: true })
    }
  })

  it('(s) a second setRolePersonaAgentsDir call re-binds the root, returns the prior binding, and re-arms the S-002 latch', async () => {
    // Sink lifetime pin (module-level `rolePersonaAgentsDir`): the
    // per-apply setter IS the re-bind — a second call swaps the root the
    // per-start read observes, returns the PRIOR binding for restore, and
    // re-arms the mirror-absent latch (once-per-apply debug). Config stays
    // present (the perf guard needs it for the absent-latch path); the
    // PROBE_ROLE Assignment is configured NOWHERE, so its persona text
    // names the bound mirror root unambiguously.
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    const fixtureA = await fixtureMirror([[`${PROBE_ROLE}.md`, PROBE_SHELL]])
    const fixtureB = await fixtureMirror([[`${PROBE_ROLE}.md`, PROBE_SHELL_ALT]])
    const original = setRolePersonaAgentsDir(fixtureA.dir)
    try {
      const { captured, restore } = captureLogs()
      try {
        // Binding A: the probe role's mirror default comes from A's shell.
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, PROBE_ROLE)))
        expect(provider.starts[0]!.request.persona).toBe(MIRROR_DEFAULT)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[0]![1]).toContain('harness-agents default')

        // The second set returns the PRIOR binding (A)...
        expect(setRolePersonaAgentsDir(fixtureB.dir)).toBe(fixtureA.dir)
        // ...and the mirror lookup follows the NEW root on the same
        // wrapper: the per-start read re-resolves the module binding (no
        // stale closure over A).
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, PROBE_ROLE)))
        expect(provider.starts[1]!.request.persona).toBe(MIRROR_DEFAULT_ALT)

        // Re-bind to ABSENT (returns B): a config-miss lookup now takes the
        // mirror-absent path and the re-set re-armed the latch, so the
        // debug fires once for THIS binding.
        expect(setRolePersonaAgentsDir(undefined)).toBe(fixtureB.dir)
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout')))
        expect(provider.starts[2]!.request.persona).toBeUndefined()
        // The latch holds on the SAME binding: a further miss stays silent.
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'code-reviewer')))
        expect(provider.starts[3]!.request.persona).toBeUndefined()

        // Re-setting the SAME binding (value unchanged) re-arms the latch
        // — the CALL is the reset, not the value transition.
        expect(setRolePersonaAgentsDir(undefined)).toBeUndefined()
        await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'ops-engineer')))
        expect(provider.starts[4]!.request.persona).toBeUndefined()

        // Exact log timeline: A delivery, B delivery, absent (fires),
        // absent (latch holds), absent (fires again after the re-set).
        expect(captured).toHaveLength(4)
        expect(captured[1]![1]).toContain('harness-agents default')
        expect(captured[2]![1]).toContain('mirror absent')
        expect(captured[3]![1]).toContain('mirror absent')
      } finally {
        restore()
      }
    } finally {
      setRolePersonaAgentsDir(original)
      await fixtureA.cleanup()
      await fixtureB.cleanup()
    }
  })

  it('(q) unknown provider → silent pass-through; the runtime fails loud its own way (NO_PROVIDER propagates)', async () => {
    const { app } = await bootWithProvider('fake-spawn', { personaCapability: true })

    const { captured, restore } = captureLogs()
    try {
      await expect(startViaNativeChannel(app, 'no-such-provider', startRequest(ASSIGNMENT_PROMPT)))
        .rejects.toThrow(/no subagent provider registered/)
      // The channel never shadows the runtime's own failure contract.
      expect(captured).toHaveLength(0)
    } finally {
      restore()
    }
  })

  it('(r) reads of OTHER services pass through the waterfall untouched; the runtime object is never mutated', async () => {
    const { app, provider } = await bootWithProvider('fake-spawn', { personaCapability: true })
    // A non-`subagents` read through a plugin-fiber context returns the raw
    // service identity (the wrapper is keyed to the subagents name only).
    const { promise: rawReady, resolve: resolveRaw } = Promise.withResolvers<unknown>()
    void app.ctx.inject(['loader'], (lctx) => resolveRaw((lctx as unknown as { loader?: unknown }).loader))
    expect(await rawReady).toBeInstanceOf(FakeLoaderRegistry)

    // The underlying runtime is unmutated: the real class instance keeps its
    // own `start`, and the wrapper is a delegate (prototype chain), so
    // `getProvider` reads the SAME provider registry the wrapper sees.
    const runtime = app.ctx.subagents as unknown as SubagentRuntime
    expect(runtime.getProvider('fake-spawn') as unknown).toBe(provider)
    expect(ROLE_PERSONA_LOGGER).toBe('mstar/role-persona')
  })

  it('(t) a poisoned service read degrades to pass-through with one warn (channel wrap containment)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-role-persona-wrap-'))
    const ctx = new Context()
    new FakeLoaderRegistry(ctx)
    // A minimal subagents service so the inject scope resolves; an INNER
    // waterfall listener (registered AFTER the plugin, so it composes inside
    // the channel's `next()`) hands the channel a value whose `start`
    // property access THROWS — driving the channel's wrap containment
    // (degrade to the raw value, never throw the read).
    class MinimalSubagents extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'subagents') }
    }
    try {
      await ctx.plugin(MinimalSubagents as Parameters<Context['plugin']>[0])
      const fiber = await ctx.plugin(plugin, { harnessDir: join(root, 'harness'), rolePersonas: { [EXECUTE_AS]: PERSONA } })
      ctx.on('internal/get', (readCtx, name, error, next) => {
        const value: unknown = next()
        if (name !== 'subagents') return value
        return Object.defineProperty({}, 'start', { get() { throw new Error('start access exploded') } })
      })
      const { captured, restore } = captureLogs()
      try {
        const { promise: got, resolve: resolveGot } = Promise.withResolvers<unknown>()
        void ctx.inject(['subagents'], (sctx) => resolveGot(sctx.subagents))
        expect(await got).toBeDefined() // the reader still receives the value — degraded, not lost
        expect(captured.some(([level, message]) => level === 'warn' && message.includes('channel degraded to pass-through'))).toBe(true)
      } finally {
        restore()
      }
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
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

  it('(p8) the real wrapper carries the non-enumerable brand and the channel still wraps after the apply-time probe ran', async () => {
    // The probe runs inside bootApp's apply (single call site after
    // registerRolePersonaChannel). Post-boot this composition must still show
    // the channel fully alive: reads are branded, the wrapper surface is
    // unchanged (non-enumerable symbol), and delivery still merges.
    booted = await bootApp({ agentsService: 'fake', subagents: 'real', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const provider = new FakeSubagentProvider('fake-spawn', { personaCapability: true })
    ;(booted.ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)

    const { promise, resolve } = Promise.withResolvers<unknown>()
    void booted.ctx.inject(['subagents'], (sctx) => resolve((sctx as unknown as { subagents: unknown }).subagents))
    const wrapper = (await promise) as object
    expect(Object.getOwnPropertySymbols(wrapper)).toEqual([ROLE_PERSONA_WRAPPER_BRAND])
    expect((wrapper as Record<symbol, unknown>)[ROLE_PERSONA_WRAPPER_BRAND]).toBe(true)
    // Non-enumerable: the wrapper's key/spread surface stays service-shaped.
    expect(Object.keys(wrapper).sort()).toEqual(['start', 'startContinuable'])
    const descriptor = Object.getOwnPropertyDescriptor(wrapper, ROLE_PERSONA_WRAPPER_BRAND)
    expect(descriptor?.enumerable).toBe(false)

    // Delivery unchanged through the probed channel (no behavior change).
    await startViaNativeChannel(booted, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
    expect(provider.starts[0]!.request.persona).toBe(PERSONA)
    // The apply-bound channel label is still pinned.
    expect(ROLE_PERSONA_LOGGER).toBe('mstar/role-persona')
  })
})
