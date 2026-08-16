/**
 * Task 2 — system-prompt module + harness-rules injection (plan
 * `20260816-dsh-nb1-systemprompt`): the GLOBAL-layer `mstar:harness-rules`
 * pointer section (order 2, static text, zero complete `{{...}}` groups) plus
 * the `mstar:engine-status` PromptContext (bounded machine summary over the
 * catalog's `buildCatalogSources` source — never the full status.json),
 * visible to the root session AND every dispatched child. The structural
 * existence check degrades (missing `ctx.systemPrompt` → `false` + one debug
 * log; boot unaffected), and the child-scoped `mstar:role-persona` section
 * (fallbacks-decoration) stays byte-stable alongside the new global section
 * (regression — plan HARD constraint "不撤销 mstar:role-persona"). Task 3:
 * the section's enforcement word is LIVE — a text provider re-reads the
 * compass per assembly (soft/hard), so a mid-session enforcement flip lands
 * on the next assembly without re-registration (h/i).
 *
 * Registration is exercised through the REAL-composition boot (the apply
 * wiring calls `registerHarnessPrompt` at apply; the REAL
 * `@deepseek-ai/dsh-system-prompt` service is composed), plus direct
 * module calls for the degrade path (a bare context without the service).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { bootApp, fakeChild, seedHarness, type BootResult } from './harness.ts'
import { PERSONA_INTERPOLATION_HAZARD } from '../src/gates/_shared.ts'
import { HarnessResolver } from '../src/index.ts'
import { PERSONA_SECTION_NAME } from '../src/gates/fallbacks-decoration.ts'
import {
  ENGINE_STATUS_CONTEXT_NAME,
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

/** A status.json exercising every state-section feature (plans, residuals, metadata, lease). */
const RICH_STATUS = JSON.stringify({
  version: 1,
  updated_at: '2026-08-08',
  plans: [
    {
      plan_id: 'plan-a',
      title: 'Plan A',
      status: 'InProgress',
      execution_lease: {
        holder: 'dsh-session-1',
        claimed_at: '2026-08-08',
        worktree_path: '/worktrees/plan-a',
        working_branch: 'feature/plan-a',
      },
    },
    { id: 'plan-b', title: 'Plan B', status: 'Done', done_at: '2026-08-08' },
  ],
  residual_findings: {
    'plan-b': [
      { id: 'R1', title: 'deferred blocker', severity: 'high', lifecycle: 'open' },
      { id: 'R2', title: 'style nit', severity: 'nit' },
    ],
  },
  metadata: {
    iteration_base_branch: 'dev-dsh',
    target_branch: 'dev-dsh',
    spec_integration_branch: 'iteration/v2.2.0',
    push_policy: 'no-push',
    worktree_mode: 'feature-worktree',
    control_worktree_path: '/control/worktree',
  },
})

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

/** Capture harness-prompt logs through the module sink (decoration test pattern). */
function captureLogs(): { captured: Array<[HarnessPromptLogLevel, string]>; restore: () => void } {
  const captured: Array<[HarnessPromptLogLevel, string]> = []
  const prior = setHarnessPromptLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setHarnessPromptLogger(prior) }
}

describe('mstar:harness-rules global section + mstar:engine-status context (plan 20260816-dsh-nb1-systemprompt Task 2)', () => {
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

  it('(b) engine-status context — the provider returns the bounded machine summary (watermark + state digest)', async () => {
    booted = await bootApp()
    const assembly = await booted.ctx.systemPrompt.assemble()
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    expect(context!.text).toContain(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(context!.text).toContain(`harness ${booted.harnessDir}`)
    expect(context!.text).toContain('enforcement soft')
  })

  it('(c) bounded projection — rich status/compass surface renders headline facts, never the full status.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-rich-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': RICH_STATUS,
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
    })
    booted = await bootApp({ root })

    const assembly = await booted.ctx.systemPrompt.assemble()
    const text = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)!.text
    // Headline facts: watermark + iteration gate + compact state line.
    expect(text).toContain('enforcement hard')
    expect(text).toContain('iteration v2.2.0: gate PASS')
    expect(text).toContain('plans: plan-a(InProgress) plan-b(Done)')
    expect(text).toContain('residuals: high 1, nit 1')
    expect(text).toContain('leases: plan-a → dsh-session-1')
    expect(text).toContain('direction: The dsh host plugin needs richer in-session harness context for operators.')
    // Bounded: no residual detail, no agent-flow events, no knowledge
    // digest, no branch/policy anchors — the full status.json never leaks.
    expect(text).not.toContain('deferred blocker')
    expect(text).not.toContain('style nit')
    expect(text).not.toContain('dev-dsh')
    expect(text).not.toContain('iteration/v2.2.0')
    expect(text).not.toContain('knowledge')
    expect(text).not.toContain('agent-flow')
  })

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

  it('(g) child persona coexistence regression — mstar:role-persona stays byte-stable alongside the global harness-rules section', async () => {
    const app = booted = await bootApp({ agentsService: 'fake', rolePersonas: { 'fullstack-dev': 'You are a fullstack-dev executor for the Morning Star harness.' } })
    const { agent, scopeKey } = await fakeChild(app.ctx, '**Execute as**: fullstack-dev\n\nImplement the assigned work.')
    app.ctx.get('agents')!.register(agent)

    app.ctx.events.emit('subagent/start', { runId: `run-${agent.id}`, provider: 'in-process', id: agent.id, local: true })

    const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
    // The child keeps its scoped persona section, byte-identical to the
    // configured persona text (HARD regression constraint).
    const persona = assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)
    expect(persona).toBeDefined()
    expect(persona!.text).toBe('You are a fullstack-dev executor for the Morning Star harness.')
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
