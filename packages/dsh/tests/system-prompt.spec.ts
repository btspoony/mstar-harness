/**
 * Task 2 — system-prompt module + harness-rules injection (plan
 * ): the GLOBAL-layer `mstar:harness-rules`
 * pointer section (order 2, live provider text — never "static" since Task
 * 3; zero complete `{{...}}` groups via `stripInterpolationHazard`
 * screening) plus the `mstar:engine-status`
 * PromptContext (bounded machine summary over the catalog's
 * `buildCatalogSources` source — never the full status.json), visible to
 * the root session AND every dispatched child. The structural existence
 * check degrades (missing `ctx.systemPrompt` → `false` + one debug log;
 * boot unaffected), and the child persona is delivered through the NATIVE
 * subagent persona channel since
 * Task 3 — NO child-scoped `mstar:role-persona` section exists anymore (g
 * pins the cutover). Task 3 (nb1): the section's enforcement word is LIVE —
 * a text provider re-reads the compass per assembly (soft/hard), so a
 * mid-session enforcement flip lands on the next assembly without
 * re-registration (h/i). Plan QC fix wave:
 * per-assembly harness-dir resolution from the assembly context's agent
 * (zero-config deployments resolve per session workspace — W-2, k), and
 * disposer collection on the inject child so an HMR re-apply disposes the
 * old registrations before the fresh ones land (W-HMR, j).
 *
 * Registration is exercised through the REAL-composition boot (the apply
 * wiring calls `registerHarnessPrompt` at apply; the REAL
 * `@deepseek-ai/dsh-system-prompt` service is composed), plus direct
 * module calls for the degrade path (a bare context without the service).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import { bootApp, fakeChild, FakeLoaderRegistry, seedHarness, type BootResult } from './harness.ts'
import { PERSONA_INTERPOLATION_HAZARD, stripInterpolationHazard } from '../src/gates/_shared.ts'
import { HarnessResolver } from '../src/index.ts'
import {
  ENGINE_STATUS_CONTEXT_NAME,
  HARNESS_PROMPT_LOGGER,
  HARNESS_RULES_SECTION_NAME,
  HARNESS_RULES_SECTION_ORDER,
  registerHarnessPrompt,
  setHarnessPromptLogger,
  type HarnessPromptLogLevel,
} from '../src/gates/system-prompt.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The plugin's own manifest version (the provider watermark's `version` field). */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version


/** A steering compass with an active iteration + a `## Direction lock` problem statement. */
const RICH_COMPASS = [
  '---',
  'iteration_id: v2.2.0',
  'status: active',
  'enforcement: hard',
  'iteration_base_branch: dev-dsh',
  'target_branch: dev-dsh',
  'plans:',
  '  - plan-a',
  '---',
  '',
  '## Direction lock (autonomous)',
  '',
  '- **Problem statement:** The dsh host plugin needs richer in-session harness context for operators.',
  '',
  '## Scope',
  '',
  'body',
].join('\n')

/** Capture harness-prompt logs through the module sink (role-persona test pattern). */
function captureLogs(): { captured: Array<[HarnessPromptLogLevel, string]>; restore: () => void } {
  const captured: Array<[HarnessPromptLogLevel, string]> = []
  const prior = setHarnessPromptLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setHarnessPromptLogger(prior) }
}

/** Let the inject child fiber settle (the registration runs asynchronously on it). */
async function settleInjectChild(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
}

describe('mstar:harness-rules global section + mstar:engine-status context ', () => {
  it('(a) global registration — the root assembly carries the mstar:harness-rules section (name/order/minimal pointer content)', async () => {
    booted = await bootApp()
    const assembly = await booted.ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    // Order 2: after the deployment persona slot (0) and the child role
    // persona (1), before plan:policy (50) and tool guidance (100-199).
    expect(HARNESS_RULES_SECTION_ORDER).toBe(2)
    const personaIndex = assembly.sections.findIndex((s) => s.name === 'deployment:persona')
    const rulesIndex = assembly.sections.findIndex((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(rulesIndex).toBeGreaterThan(personaIndex)
    // Live-assembly order lock (L2 Minor 2): the assembled section carries no
    // `order` field (only name + text), so the sorted position IS the order —
    // in the real composition: harness:identity (-100) at 0, deployment:persona
    // (0) at 1, mstar:harness-rules (2) at 2.
    expect(rulesIndex).toBe(2)
    // Minimal pointer block: presence / enforcement word / resolved
    // {HARNESS_DIR} / one read-mstar-harness-core directive.
    expect(section!.text).toContain('Morning Star')
    expect(section!.text).toContain('enforcement: soft')
    expect(section!.text).toContain(`harness dir: ${booted.harnessDir}`)
    expect(section!.text).toContain('mstar-harness-core')
  })

  it('(b) engine-status context — idle default boot (no status.json seeded) injects exactly the version watermark line (D1)', async () => {
    booted = await bootApp()
    const assembly = await booted.ctx.systemPrompt.assemble()
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    expect(context!.text).toBe(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(context!.text).not.toContain('harness')
    expect(context!.text).not.toContain('enforcement')
  })

  // Disposition: legacy status.json/snapshot.json digest assertions are removed with the retired file-route reader; live prompt registration, enforcement and persona behavior remain exercised.

  it('(d) interpolation safety — neither injected text carries a complete {{...}} group and both render without throwing', async () => {
    booted = await bootApp()
    const assembly = await booted.ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(section).toBeDefined()
    expect(context).toBeDefined()
    // Zero complete `{{...}}` groups (STRICT interpolation throws on any
    // unknown/malformed/undefined reference at render).
    expect(PERSONA_INTERPOLATION_HAZARD.test(section!.text)).toBe(false)
    expect(PERSONA_INTERPOLATION_HAZARD.test(context!.text)).toBe(false)
    // End-to-end: the real renderers complete without throwing.
    expect(() => renderPrompt(assembly)).not.toThrow()
    expect(() => renderContextSnapshot(assembly)).not.toThrow()
  })

  it('(e) service-missing degrade — registerHarnessPrompt returns false + one debug log; boot unaffected', async () => {
    const { captured, restore } = captureLogs()
    try {
      const result = registerHarnessPrompt(new Context(), { resolver: new HarnessResolver(undefined) })
      expect(result).toBe(false)
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
      expect(captured[0]![1]).toContain('systemPrompt')
    } finally {
      restore()
    }
  })

  it('(f) service-present direct call — registerHarnessPrompt returns true and the registrations land globally', async () => {
    const ctx = new Context()
    const { default: SystemPromptPlugin } = await import('@deepseek-ai/dsh-system-prompt')
    await ctx.plugin(SystemPromptPlugin, {})
    try {
      const result = registerHarnessPrompt(ctx, { resolver: new HarnessResolver(undefined) })
      expect(result).toBe(true)
      // The registration is scheduled through an inject child (HMR-safe
      // effect ownership); let the child fiber settle before assembling.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)).toBeDefined()
      expect(assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)).toBeDefined()
      // No harness dir resolved on the bare context → the pointer renders `none`.
      expect(assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text).toContain('harness dir: none')
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
  })

  it('(g) persona-channel cutover — NO child-scoped mstar:role-persona section exists; the global harness-rules section still reaches children', async () => {
    // The child persona
    // moved to the NATIVE subagent persona channel (`SubagentStartRequest.persona`,
    // role-persona.ts) — the old additive section is GONE. The global
    // harness-rules section must keep reaching dispatched children (the
    // regression this case originally pinned, minus the removed section).
    const app = booted = await bootApp({ agentsService: 'fake', rolePersonas: { 'fullstack-dev': 'You are a fullstack-dev executor for the Morning Star harness.' } })
    const { agent, scopeKey } = await fakeChild(app.ctx, '**Execute as**: fullstack-dev\n\nImplement the assigned work.')
    app.ctx.get('agents')!.register(agent)

    app.ctx.events.emit('subagent/start', { runId: `run-${agent.id}`, provider: 'in-process', id: agent.id, local: true })

    const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
    // The additive persona section no longer exists anywhere in the child
    // assembly (the cutover regression — persona delivery does not touch
    // the system-prompt layer).
    expect(assembly.sections.find((s) => s.name === 'mstar:role-persona')).toBeUndefined()
    // The global harness-rules section is visible to the child assembly too
    // (global layer — root AND children).
    expect(assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)).toBeDefined()
    expect(assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)).toBeDefined()
  })

  it('(h) enforcement word is live — a hard steering compass renders `enforcement: hard` in the section text (soft covered by (a))', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-enforcement-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
    })
    booted = await bootApp({ root })
    const assembly = await booted.ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain('enforcement: hard')
  })

  it('(i) mid-session enforcement flip switches the section word on the next assembly without re-registration', async () => {
    booted = await bootApp()
    const before = await booted.ctx.systemPrompt.assemble()
    expect(before.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text).toContain('enforcement: soft')
    // Flip the compass to hard mid-session — same boot, same registration
    // (the section text provider re-reads the compass per assembly).
    await seedHarness(booted.harnessDir, {
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
    })
    const after = await booted.ctx.systemPrompt.assemble()
    const section = after.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain('enforcement: hard')
  })



})

describe('stripInterpolationHazard (STRICT {{variable}} screening)', () => {
  it('breaks complete {{...}} groups so no pair survives the renderer scan', () => {
    expect(stripInterpolationHazard('{{x}}')).toBe('{ {x} }')
    expect(stripInterpolationHazard('a {{x}} b')).toBe('a { {x} } b')
    expect(stripInterpolationHazard('{{x}} {{y}}')).toBe('{ {x} } { {y} }')
    expect(stripInterpolationHazard('no braces here')).toBe('no braces here')
  })

  it('leaves a lone `{{` without a later `}}` verbatim (upstream renders it literally)', () => {
    expect(stripInterpolationHazard('use `{{` to open')).toBe('use `{{` to open')
    expect(stripInterpolationHazard('{{')).toBe('{{')
    expect(stripInterpolationHazard('{{x}} {{')).toBe('{ {x} } {{')
  })

  it('screens malformed and nested groups without leaving a complete pair (renderer never throws)', () => {
    const outputs = ['{{x y}}', '{{ }}', '{{{x}}}', '{{a{{b}}c}}', '{{{x}}'].map(stripInterpolationHazard)
    for (const out of outputs) expect(PERSONA_INTERPOLATION_HAZARD.test(out)).toBe(false)
  })
})

