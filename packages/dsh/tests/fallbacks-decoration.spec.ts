/**
 * Task 2 — role-based subagent decoration at the `subagent/start` seam (plan
 * `20260814-dsh-fallbacks-integration`): the synchronous listener resolves the
 * published child via `ctx.get('agents')?.get(info.id)` and registers the
 * configured persona as the child's `mstar:role-persona` system-prompt
 * section — the hooks-claude-code pattern (agent-scoped on `Agent.ctx`;
 * contributions are agent-local and unwind on disposal by the Agent.ctx
 * contract — the per-agent systemPrompt realm composition is the host's,
 * not this plugin's).
 *
 * The seam is driven directly (the hooks-claude-code coverage pattern): the
 * child is fake-registered on the harness `FakeAgentRegistry`, its session is
 * a REAL `@deepseek-ai/dsh-session` seeded with the Assignment prompt (the
 * extraction reads the same event log the real child carries at
 * `subagent/start` emit time), and the child ctx is a REAL agent-scoped
 * context with `systemPrompt` injected. Composition case (e) applies the REAL
 * registry `dsh-llm-fallbacks` and asserts the interop log carries the
 * service version.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fallbacks from 'dsh-llm-fallbacks'
import * as plugin from '../src/index.ts'
import { FakeLoaderRegistry, bootApp, fakeChild, fakeChildWithSession, startInfo, type BootResult } from './harness.ts'
import { fallbacksMounted } from '../src/gates/fallbacks-probe.ts'
import {
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  setDecorationAgentsDir,
  setDecorationLogger,
  type DecorationLogLevel,
} from '../src/gates/fallbacks-decoration.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mstar role id the test Assignment declares and the persona is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** The configured persona text for `fullstack-dev`. */
const PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

/** One mstar-style Assignment prompt seeded into a child session. */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** A non-Assignment task prompt (no header fields). */
const PLAIN_PROMPT = 'Summarize the attached file.'

/** The mirror default persona for `fullstack-dev` (multiline `|-` description). */
const MIRROR_DEFAULT = 'Line one of the mirror default.\nLine two of the mirror default.'

/** A fixture mirror shell whose default differs from the config PERSONA. */
const MIRROR_SHELL = [
  '---',
  `name: ${EXECUTE_AS}`,
  'description: |-',
  '  Line one of the mirror default.',
  '  Line two of the mirror default.',
  'mode: subagent',
  '---',
  '',
  '## Morning Star Role Binding',
].join('\n')

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-decoration-mirror-'))
  for (const [name, content] of shells) await writeFile(join(dir, name), content)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Capture decoration logs through the module sink (agent-flow test pattern). */
function captureLogs(): { captured: Array<[DecorationLogLevel, string]>; restore: () => void } {
  const captured: Array<[DecorationLogLevel, string]> = []
  const prior = setDecorationLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setDecorationLogger(prior) }
}

describe('subagent/start decoration — mstar:role-persona injection', () => {
  it('(a) Assignment with a configured Execute as → the child system prompt carries the mstar:role-persona section', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      const section = assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)
      expect(section).toBeDefined()
      expect(section!.text).toBe(PERSONA)
      // Order 1 renders right after the deployment persona slot (order 0).
      expect(PERSONA_SECTION_ORDER).toBe(1)
    } finally {
      restore()
    }
  })

  it('(b) role-unmatched or non-Assignment prompt → no section, no log spam', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    // Role-unmatched: an Assignment whose Execute as has NO configured persona
    // AND no mirror shell (Task 3 defaults — the packaged mirror IS bound at
    // apply, so the unmatched role must be absent from it: `scout` is not one
    // of the 14 pinned shells, and the mirror shell set itself is pinned by
    // harness-agents-mirror.spec.ts).
    const unmatched = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout'))
    booted.ctx.get('agents')!.register(unmatched.agent)
    // Non-Assignment: a plain task prompt with no header fields.
    const plain = await fakeChild(booted.ctx, PLAIN_PROMPT)
    booted.ctx.get('agents')!.register(plain.agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(unmatched.agent.id))
      booted.ctx.events.emit('subagent/start', startInfo(plain.agent.id))

      const unmatchedAssembly = await unmatched.agent.ctx.systemPrompt.assemble({ scope: unmatched.scopeKey })
      const plainAssembly = await plain.agent.ctx.systemPrompt.assemble({ scope: plain.scopeKey })
      expect(unmatchedAssembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
      expect(plainAssembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
      expect(captured).toHaveLength(0) // no-op is silent
    } finally {
      restore()
    }
  })

  it('(c) fallbacks unmounted → persona still injected from Config + exactly one debug log', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    expect(fallbacksMounted(booted.ctx)).toBe(false) // no fallbacks row applied
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
      // Exactly one log line, at debug level (same-channel degradation).
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
    } finally {
      restore()
    }
  })

  it('(d) agents service absent → skip + one debug log; child unresolved → silent no-op; never throws', async () => {
    // No agents service in the composition (the real app always composes
    // dsh-agent, but a minimal composition must not crash the dispatch).
    const noAgents = booted = await bootApp({ rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const absent = captureLogs()
    try {
      expect(() => noAgents.ctx.events.emit('subagent/start', startInfo('child-unknown'))).not.toThrow()
      expect(absent.captured).toHaveLength(1)
      expect(absent.captured[0]![0]).toBe('debug')
      expect(absent.captured[0]![1]).toContain('agents')
    } finally {
      absent.restore()
    }

    // Agents service present but the child id is not registered → silent no-op.
    const withAgents = booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const unresolved = captureLogs()
    try {
      expect(() => withAgents.ctx.events.emit('subagent/start', startInfo('child-not-registered'))).not.toThrow()
      expect(unresolved.captured).toHaveLength(0)
    } finally {
      unresolved.restore()
    }
  })

  it('(f) child with an empty seed (no user message yet) → silent no-op, no log', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const { agent, scopeKey } = await fakeChildWithSession(booted.ctx, Session.create(SessionId('child-empty'), []))
    booted.ctx.get('agents')!.register(agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
      expect(captured).toHaveLength(0) // empty seed → seededTaskPrompt undefined → silent no-op
    } finally {
      restore()
    }
  })

  it('(g) persona values containing the {{...}} interpolation hazard are rejected at config validation (W-001)', async () => {
    // dsh system-prompt strict interpolation renders persona section text and
    // throws on any `{{` paired with a later `}}` at child prompt assembly —
    // the Config schema rejects such values at plugin mount with a clear
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

  it('(h) a throwing log sink never escapes the decoration listener (never-throws containment, F-002)', async () => {
    const app = booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const { agent, scopeKey } = await fakeChild(app.ctx, ASSIGNMENT_PROMPT)
    app.ctx.get('agents')!.register(agent)

    const prior = setDecorationLogger(() => { throw new Error('sink exploded') })
    try {
      // Happy path: the injection debug log throws INSIDE the contained sink —
      // the listener still completes and the persona still lands.
      expect(() => app.ctx.events.emit('subagent/start', startInfo(agent.id))).not.toThrow()
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)

      // Degrade path: the catch block's warn log ALSO throws inside the
      // contained sink — the listener still never escapes. A pre-registered
      // duplicate `mstar:role-persona` section forces the section() insert to
      // throw, driving the decoration into its catch block.
      const dup = await fakeChild(app.ctx, ASSIGNMENT_PROMPT)
      app.ctx.get('agents')!.register(dup.agent)
      dup.agent.ctx.systemPrompt.section({ name: PERSONA_SECTION_NAME, order: PERSONA_SECTION_ORDER, text: 'pre-registered' })
      expect(() => app.ctx.events.emit('subagent/start', startInfo(dup.agent.id))).not.toThrow()
    } finally {
      setDecorationLogger(prior)
    }
  })

  it('(i) rolePersonas: null config → dispatch proceeds, silent no-op (null-safe perf guard, N-002)', async () => {
    // schemastery's `isNullable` passes `null` through the Config transform
    // unvalidated (QC re-review probe: `~standard.validate(null)` → value
    // `null`), so `config.rolePersonas` can be `null` at runtime despite the
    // TS type. The perf guard must be null-safe: dispatch proceeds, silent
    // no-op — no throw, no log (same contract as the unset case). Guard
    // semantics reworked for Task 3 defaults: "no rolePersonas AND no mirror
    // → skip silently" (case (e)) — the mirror is bound ABSENT here so the
    // guard path is exercised deterministically (the apply binds the
    // packaged mirror, which would otherwise supply a fullstack-dev default).
    const app = booted = await bootApp({ agentsService: 'fake', rolePersonas: null as never })
    const prior = setDecorationAgentsDir(undefined)
    try {
      const { agent, scopeKey } = await fakeChild(app.ctx, ASSIGNMENT_PROMPT)
      app.ctx.get('agents')!.register(agent)

      const { captured, restore } = captureLogs()
      try {
        expect(() => app.ctx.events.emit('subagent/start', startInfo(agent.id))).not.toThrow()
        const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
        expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
        expect(captured).toHaveLength(0) // silent no-op
      } finally {
        restore()
      }
    } finally {
      setDecorationAgentsDir(prior)
    }
  })

  it('(e) composition with dsh-llm-fallbacks applied → persona injected + one info interop log carrying service.version', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    // The real registry plugin applied as a row (same entry-shape cast the
    // Task 1 probe test applies).
    const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
    await booted.ctx.plugin(fallbacksPlugin)
    expect(fallbacksMounted(booted.ctx)).toBe(true)
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
      // One info-level interop log carrying the service version. The version
      // itself is deliberately NOT pinned (it moves with the caret range —
      // pre-existing drift stop-gate, re-anchored version-agnostic in Task 3).
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('info')
      expect(captured[0]![1]).toContain('dsh-llm-fallbacks mounted (v')
    } finally {
      restore()
    }
  })

  // ---- Task 3 lookup chain (plan 20260815-dsh-fallbacks-personas): config → mirror default → skip ----

  it('(j) config persona wins over a mirror default (lookup chain: config → default)', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, MIRROR_SHELL]])
    const prior = setDecorationAgentsDir(fixture.dir)
    try {
      const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
      booted.ctx.get('agents')!.register(agent)
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      // The configured persona wins — the mirror default is never consulted.
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
    } finally {
      setDecorationAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(k) no configured persona → the mirror default is injected (multiline |- description)', async () => {
    booted = await bootApp({ agentsService: 'fake' })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, MIRROR_SHELL]])
    const prior = setDecorationAgentsDir(fixture.dir)
    try {
      const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
      booted.ctx.get('agents')!.register(agent)
      const { captured, restore } = captureLogs()
      try {
        booted.ctx.events.emit('subagent/start', startInfo(agent.id))

        const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
        expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(MIRROR_DEFAULT)
        // Exactly one debug log (unmounted channel), naming the default source.
        expect(captured).toHaveLength(1)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[0]![1]).toContain('harness-agents default')
      } finally {
        restore()
      }
    } finally {
      setDecorationAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(m) a mirror shell whose description carries the {{...}} hazard → default skipped + one warn, never throws', async () => {
    const app = booted = await bootApp({ agentsService: 'fake' })
    const fixture = await fixtureMirror([[`${EXECUTE_AS}.md`, HAZARD_SHELL]])
    const prior = setDecorationAgentsDir(fixture.dir)
    try {
      const first = await fakeChild(app.ctx, ASSIGNMENT_PROMPT)
      app.ctx.get('agents')!.register(first.agent)
      const second = await fakeChild(app.ctx, ASSIGNMENT_PROMPT)
      app.ctx.get('agents')!.register(second.agent)

      const { captured, restore } = captureLogs()
      try {
        expect(() => app.ctx.events.emit('subagent/start', startInfo(first.agent.id))).not.toThrow()
        expect(() => app.ctx.events.emit('subagent/start', startInfo(second.agent.id))).not.toThrow()

        const assembly = await first.agent.ctx.systemPrompt.assemble({ scope: first.scopeKey })
        expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
        // Exactly ONE warn across both applies — the per-(mirrorRoot, mtime)
        // cache warns at extraction time (first miss) and serves the cached
        // skip on the second lookup. No other logs: mirror present, no inject.
        expect(captured).toHaveLength(1)
        expect(captured[0]![0]).toBe('warn')
        expect(captured[0]![1]).toContain(EXECUTE_AS)
      } finally {
        restore()
      }
    } finally {
      setDecorationAgentsDir(prior)
      await fixture.cleanup()
    }
  })

  it('(n) mirror absent → config-only lookups, one debug log per apply (not per lookup)', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    // Force the mirror absent (the apply binds the packaged mirror).
    const prior = setDecorationAgentsDir(undefined)
    try {
      const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
      booted.ctx.get('agents')!.register(agent)
      const unmatched = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'scout'))
      booted.ctx.get('agents')!.register(unmatched.agent)

      const { captured, restore } = captureLogs()
      try {
        booted.ctx.events.emit('subagent/start', startInfo(agent.id))
        booted.ctx.events.emit('subagent/start', startInfo(unmatched.agent.id))

        // Config hit → persona injected + its single unmounted debug log.
        const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
        expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
        // Config miss + no mirror → skipped + ONE mirror-absent debug per apply.
        const unmatchedAssembly = await unmatched.agent.ctx.systemPrompt.assemble({ scope: unmatched.scopeKey })
        expect(unmatchedAssembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()

        // Two applies → two debug lines (one per apply, never per lookup).
        expect(captured).toHaveLength(2)
        expect(captured[0]![0]).toBe('debug')
        expect(captured[1]![0]).toBe('debug')
        expect(captured[1]![1]).toContain('mirror absent')
      } finally {
        restore()
      }
    } finally {
      setDecorationAgentsDir(prior)
    }
  })
})
