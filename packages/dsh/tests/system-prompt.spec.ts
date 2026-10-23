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
 * boot unaffected), and the child identity rides the SELECTED agent preset
 * of the native subagent channel since
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
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import { bootApp, fakeChild, FakeLoaderRegistry, seedActiveWorkflow, seedHarness, type BootResult } from './harness.ts'
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
async function assembleWithEngineStatus(ctx: BootResult['ctx']) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const assembly = await ctx.systemPrompt.assemble()
    if (assembly.contexts.some((context) => context.name === ENGINE_STATUS_CONTEXT_NAME)) return assembly
    await settleInjectChild()
  }
  throw new Error('mstar:engine-status context did not register')
}

/** One pre-existing inbox message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inbox' }] })

/** One `agent/pre-step` payload carrying a real session identity. */
function stepPayloadOf(app: BootResult, sessionId: string, messages: UserMessage[], turn: number) {
  return {
    agent: { session: { header: { id: sessionId, cwd: app.root } } },
    messages,
    turn,
    step: turn,
    signal: new AbortController().signal,
  } as never
}

/** The model-facing text of the emitted engine-status row from a REAL `agent/pre-step`. */
async function catalogRowText(app: BootResult, sessionId: string, turn: number): Promise<string> {
  const inbox = [inboxMessage()]
  const decision = await app.ctx.waterfall(
    'agent/pre-step',
    stepPayloadOf(app, sessionId, inbox, turn),
    () => Promise.resolve({ kind: 'enter', messages: inbox } as never),
  )
  const row = decision.kind === 'enter' ? decision.messages.at(-1) : undefined
  return row?.content[0]?.type === 'text' ? row.content[0].text : ''
}

/**
 * The composed `@deepseek-ai/dsh-system-prompt` ROW fiber, looked up through
 * the cordis plugin registry (the class plugin's name is `SystemPrompt`).
 * Disposing it models the host removing the service — the inject child that
 * owns the mstar registration unwinds, exactly like an HMR unload.
 */
function promptServiceRowFiber(ctx: BootResult['ctx']): { dispose(): Promise<void> } {
  type RegistryRuntime = { name?: string; fibers: Iterable<{ dispose(): Promise<void> }> }
  const registry = (ctx as unknown as { registry: { values(): Iterable<RegistryRuntime> } }).registry
  for (const runtime of registry.values()) {
    if (runtime.name !== 'SystemPrompt') continue
    for (const fiber of runtime.fibers) return fiber
  }
  throw new Error('system-prompt row fiber not found')
}

describe('mstar:harness-rules global section + mstar:engine-status context ', () => {
  it('(a) global registration — the root assembly carries the mstar:harness-rules section (name/order/minimal pointer content)', async () => {
    booted = await bootApp()
    const assembly = await assembleWithEngineStatus(booted.ctx)
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    // Order 2: after the deployment persona slot (0), before plan:policy
    // (50) and tool guidance (100-199). No child-scoped role section exists
    // any more (the selected agent preset carries the child identity).
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

  it('(a2) appends the delegation contract only when the Agent Teams layer is mounted', async () => {
    booted = await bootApp()
    const without = await assembleWithEngineStatus(booted.ctx)
    const withoutText = without.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text
    // No Team service → `spawn_teammate` is not callable, so the contract must
    // not name it; the pointer block stays exactly as it was.
    expect(withoutText).not.toContain('spawn_teammate')

    booted.ctx.provide('agentTeams' as never, { listMembers: () => [] } as never)
    const withTeam = await assembleWithEngineStatus(booted.ctx)
    const withText = withTeam.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text
    // The two facts a coordinator otherwise finds only in
    // `mstar-host` → `references/dsh.md`: the default channel, and the header
    // shape every delegation prompt needs (workflow children included).
    expect(withText).toContain('`spawn_teammate` is the default channel for writable work')
    expect(withText).toContain('"## Assignment" and "Execute as: <role>"')
    expect(withText).toContain('`workflow agent()` included')
  })

  it('(b) engine-status context — idle default boot (no status.json seeded) injects exactly the version watermark line (D1)', async () => {
    booted = await bootApp()
    const assembly = await assembleWithEngineStatus(booted.ctx)
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    expect(context!.text).toBe(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(context!.text).not.toContain('harness')
    expect(context!.text).not.toContain('enforcement')
  })

  // Disposition: only legacy status.json/snapshot.json transport assertions were removed; the ACTIVE graph's consumer rendering rules remain tested below.
  async function activeDigest(plans: Array<{ id: string; title: string; status: string }>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-active-'))
    await seedActiveWorkflow(join(root, 'harness'), 'prompt-digest', plans, {}, 'seed-prompt-digest', root)
    booted = await bootApp({ root })
    const assembly = await assembleWithEngineStatus(booted.ctx)
    return assembly.contexts.find((context) => context.name === ENGINE_STATUS_CONTEXT_NAME)!.text
  }

  it('(c) filters Done rows from the active workflow digest', async () => {
    const text = await activeDigest([
      { id: 'todo-plan', title: 'Todo plan', status: 'Todo' },
      { id: 'done-plan', title: 'Done plan', status: 'Done' },
    ])
    expect(text).toContain('workflow prompt-digest (plan) running | plans: todo-plan(Todo)')
    expect(text).not.toContain('done-plan')
  })

  it('(c2) renders plans: all done when every active plan is Done (distinct from `plans: none`)', async () => {
    const text = await activeDigest([
      { id: 'done-a', title: 'Done A', status: 'Done' },
      { id: 'done-b', title: 'Done B', status: 'Done' },
    ])
    expect(text).toContain('workflow prompt-digest (plan) running | plans: all done')
    expect(text).not.toContain('plans: none')
  })

  it('(c3) caps active plan rendering at eight and reports the overflow count', async () => {
    const plans = Array.from({ length: 9 }, (_, index) => ({
      id: `plan-${index + 1}`,
      title: `Plan ${index + 1}`,
      status: 'Todo',
    }))
    const text = await activeDigest(plans)
    expect(text).toContain('workflow prompt-digest (plan) running | plans: plan-1(Todo) plan-2(Todo) plan-3(Todo) plan-4(Todo) plan-5(Todo) plan-6(Todo) plan-7(Todo) plan-8(Todo) +1 more')
    expect(text).not.toContain('plan-9')
  })

  it('(c4) carries the gate verdict and the branch anchors — the always-on channel after compaction', async () => {
    // The catalog row is a change-driven DELTA and is not re-anchored per turn,
    // so after host-side context compaction this digest is the only always-on
    // channel for the two facts a phase-transition / PR-base decision needs.
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-gate-'))
    const harnessDir = join(root, 'harness')
    const COMPASS_REL = 'iterations/iter-digest/delivery-compass.md'
    await seedActiveWorkflow(harnessDir, 'iter-digest', [
      { id: 'plan-todo', title: 'Todo plan', file: 'plans/plan-todo.md', status: 'Todo' },
    ], { type: 'iteration', compass_ref: COMPASS_REL }, 'seed-iter-digest', root, 'iter-digest')
    await seedHarness(harnessDir, {
      [COMPASS_REL]: [
        '---',
        'iteration_id: iter-digest',
        'start_date: 2026-08-19',
        'status: active',
        'iteration_base_branch: feature/x',
        'target_branch: main',
        'plans:',
        '  - plan-todo',
        '---',
        '',
        '## Direction lock',
        '',
        '- **Problem statement:** Digest gate fixture.',
        '',
      ].join('\n'),
    })
    booted = await bootApp({ root })
    const text = (await assembleWithEngineStatus(booted.ctx))
      .contexts.find((context) => context.name === ENGINE_STATUS_CONTEXT_NAME)!.text
    expect(text.split('\n')).toEqual([
      `mstar engine status: v${PLUGIN_VERSION}`,
      'workflow iter-digest (iteration) running | plans: plan-todo(Todo) | branch: feature/x → main | gate: PASS (phase-2-execute)',
    ])
  })

  it('(d) interpolation safety — neither injected text carries a complete {{...}} group and both render without throwing', async () => {
    booted = await bootApp()
    const assembly = await assembleWithEngineStatus(booted.ctx)
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

  it('(g) preset-channel cutover — NO child-scoped mstar:role-persona section exists; the global harness-rules section still reaches children', async () => {
    // The child identity moved to the SELECTED agent preset of the NATIVE
    // subagent channel (`SubagentStartRequest.agentPreset` via `rolePresets`,
    // role-persona.ts) — the old additive section is GONE. The global
    // harness-rules section must keep reaching dispatched children (the
    // regression this case originally pinned, minus the removed section).
    const app = booted = await bootApp({ agentsService: 'fake', rolePresets: { 'fullstack-dev': 'mstar-execute' } })
    await assembleWithEngineStatus(app.ctx)
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
    const assembly = await assembleWithEngineStatus(booted.ctx)
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain('enforcement: hard')
  })

  it('(i) mid-session enforcement flip switches the section word on the next assembly without re-registration', async () => {
    booted = await bootApp()
    const before = await assembleWithEngineStatus(booted.ctx)
    expect(before.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text).toContain('enforcement: soft')
    // Flip the compass to hard mid-session — same boot, same registration
    // (the section text provider re-reads the compass per assembly).
    await seedHarness(booted.harnessDir, {
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
    })
    const after = await assembleWithEngineStatus(booted.ctx)
    const section = after.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain('enforcement: hard')
  })

  it('(j) a contained registration failure keeps the row watermark fallback (scheduled ≠ landed)', async () => {
    // `registerHarnessPrompt` returns true for both compositions (the service
    // exists, so the inject child is scheduled), yet the registration itself
    // throws inside the child. The fallback criterion is CONFIRMED live
    // registration, so the row must still carry the version / harness-dir /
    // enforcement trio in both cases.
    for (const failure of ['section', 'context'] as const) {
      booted = await bootApp({ systemPromptFailure: failure })
      // The service IS composed, so `registerHarnessPrompt` reported `true`
      // and scheduled the inject child — the schedule is not the finding's
      // failure mode.
      expect(booted.ctx.get('systemPrompt')).toBeDefined()
      // Let the inject child run its (failing) registration.
      await settleInjectChild()
      const text = await catalogRowText(booted, `ses_registration_${failure}`, 1)
      expect(text.startsWith('<mstar_engine_status>\nmstar version: ')).toBe(true)
      expect(text).toContain(`harness dir: ${booted.harnessDir}`)
      expect(text).toContain('enforcement: soft')
      // The failure really is a NON-landing: the section only landed for the
      // context failure, and the engine-status context never landed.
      const assembly = await booted.ctx.systemPrompt.assemble()
      const sectionLanded = assembly.sections.some((section) => section.name === HARNESS_RULES_SECTION_NAME)
      expect(sectionLanded).toBe(failure === 'context')
      expect(assembly.contexts.some((context) => context.name === ENGINE_STATUS_CONTEXT_NAME)).toBe(false)
      await booted.dispose()
      booted = undefined
    }
  })

  it('(k) disposing a live registration returns the row watermark (onDisposed)', async () => {
    const app = booted = await bootApp()
    // Wait until BOTH registrations are live — the confirmed state the lazy
    // predicate reads — then the row is watermark-free (unchanged live case).
    await assembleWithEngineStatus(app.ctx)
    const liveText = await catalogRowText(app, 'ses_disposed', 1)
    expect(liveText.startsWith('<mstar_engine_status>\n')).toBe(true)
    expect(liveText).not.toContain('mstar version:')
    expect(liveText).not.toContain('harness dir:')
    // Removing the service row (HMR / host teardown) disposes the inject child
    // and its collected registration: `onDisposed` flips the fallback back,
    // and the still-mounted listener re-enables the watermark on the next step.
    await promptServiceRowFiber(app.ctx).dispose()
    await settleInjectChild()
    const fallbackText = await catalogRowText(app, 'ses_disposed', 2)
    expect(fallbackText.startsWith('<mstar_engine_status>\nmstar version: ')).toBe(true)
    expect(fallbackText).toContain(`harness dir: ${app.harnessDir}`)
    expect(fallbackText).toContain('enforcement: soft')
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

