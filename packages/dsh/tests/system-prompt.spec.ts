/**
 * Task 2 — system-prompt module + harness-rules injection (plan
 * `20260816-dsh-nb1-systemprompt`): the GLOBAL-layer `mstar:harness-rules`
 * pointer section (order 2, live provider text — never "static" since Task
 * 3; zero complete `{{...}}` groups via `stripInterpolationHazard`
 * screening, plan QC fix wave W-1) plus the `mstar:engine-status`
 * PromptContext (bounded machine summary over the catalog's
 * `buildCatalogSources` source — never the full status.json), visible to
 * the root session AND every dispatched child. The structural existence
 * check degrades (missing `ctx.systemPrompt` → `false` + one debug log;
 * boot unaffected), and the child-scoped `mstar:role-persona` section
 * (fallbacks-decoration) stays byte-stable alongside the new global section
 * (regression — plan HARD constraint "不撤销 mstar:role-persona"). Task 3:
 * the section's enforcement word is LIVE — a text provider re-reads the
 * compass per assembly (soft/hard), so a mid-session enforcement flip lands
 * on the next assembly without re-registration (h/i). Plan QC fix wave:
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
import { bootApp, fakeChild, FakeLoaderRegistry, seedHarness, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'
import { PERSONA_INTERPOLATION_HAZARD, stripInterpolationHazard } from '../src/gates/_shared.ts'
import { HarnessResolver } from '../src/index.ts'
import { PERSONA_SECTION_NAME } from '../src/gates/fallbacks-decoration.ts'
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

/** A v2 tree exercising every state-section feature (plans, residuals, metadata, lease). */
const RICH_WORKFLOW = 'v2.2.0'
const RICH_ROOT = v2Root([v2WorkflowEntry(RICH_WORKFLOW, 'iteration')])
const RICH_SNAPSHOT = v2Snapshot(RICH_WORKFLOW, {
  type: 'iteration',
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
  branch: { base: 'dev-dsh', integration: 'iteration/v2.2.0', target: 'dev-dsh' },
  execution_policy: { push_policy: 'no-push', worktree_mode: 'feature-worktree' },
  control_worktree_path: '/control/worktree',
})
/** The project register (the v1 `residual_findings` home after migrate). */
const RICH_REGISTER = JSON.stringify({
  entries: {
    'plan-b': [
      { id: 'R1', title: 'deferred blocker', severity: 'high', lifecycle: 'open', source_plan: 'plan-b', registered_at: '2026-08-08' },
      { id: 'R2', title: 'style nit', severity: 'nit', source_plan: 'plan-b', registered_at: '2026-08-08' },
    ],
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

/** Let the inject child fiber settle (the registration runs asynchronously on it). */
async function settleInjectChild(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
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

  it('(b) engine-status context — idle default boot (no status.json seeded) injects exactly the version watermark line (D1)', async () => {
    booted = await bootApp()
    const assembly = await booted.ctx.systemPrompt.assemble()
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    expect(context!.text).toBe(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(context!.text).not.toContain('harness')
    expect(context!.text).not.toContain('enforcement')
  })

  it('(c) active contract — the rich tree renders the slim digest: version watermark + ONE workflow line, non-Done plans only (D2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-rich-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': RICH_ROOT,
      [`workflows/${RICH_WORKFLOW}/snapshot.json`]: RICH_SNAPSHOT,
      'projects/_default/residuals.json': RICH_REGISTER,
      'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS,
    })
    booted = await bootApp({ root })

    const assembly = await booted.ctx.systemPrompt.assemble()
    const text = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)!.text
    // The slim digest: the version watermark always + the ONE active
    // workflow line with the non-Done plan join (plan-a stays, plan-b's
    // Done row is filtered out).
    expect(text).toContain(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(text).toContain('workflow v2.2.0 (iteration) running | plans: plan-a(InProgress)')
    expect(text).not.toContain('plan-b')
    // Omitted (hard, D2): residuals, leases, direction, the iteration-gate
    // line, harness dir and enforcement all leave this surface.
    expect(text).not.toContain('residuals')
    expect(text).not.toContain('leases')
    expect(text).not.toContain('direction')
    expect(text).not.toContain('gate')
    expect(text).not.toContain('enforcement')
    expect(text).not.toContain('harness ')
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

  it('(j) HMR re-apply — the inject child collects the registrations\' disposers, so a fresh apply lands without a duplicate-name throw and the old closure (old harness dir) does not linger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-hmr-'))
    const harnessDirA = join(root, 'harness-a')
    const harnessDirB = join(root, 'harness-b')
    await mkdir(harnessDirA, { recursive: true })
    await mkdir(harnessDirB, { recursive: true })
    // Each mounted harness dir carries its own active workflow so the digest
    // context discriminates the mount (the slim digest renders the selected
    // active workflow, not the boot dir path).
    await seedHarness(harnessDirA, {
      'status.json': v2Root([v2WorkflowEntry('wf-a')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
    })
    await seedHarness(harnessDirB, {
      'status.json': v2Root([v2WorkflowEntry('wf-b')]),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b'),
    })
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` must resolve (hmr-safety
    // spec pattern); the REAL dsh-system-prompt service is composed so the
    // section/context land through the real layers.
    new FakeLoaderRegistry(ctx)
    await ctx.plugin(SystemPromptPlugin)
    // The plugin's apply rebinds the MODULE log sink on every (re-)apply, so
    // registration-path warns are observed through the LOGGER service instead:
    // a duplicate-name throw is logged as a `mstar/harness-prompt` warn.
    const warns: string[] = []
    ctx.logger.exporter({
      // cordis default logger threshold is INFO — warn(2)/debug(3) are
      // filtered unless the exporter raises its own levels floor.
      levels: { default: 2 },
      export(message) {
        if (message.name === HARNESS_PROMPT_LOGGER && message.type === 'warn') {
          warns.push(String(message.args[0]))
        }
      },
    })
    try {
      // Mount 1 — the registrations land on the GLOBAL layer (boot value A).
      const fiber = await ctx.plugin(plugin, { harnessDir: harnessDirA })
      await settleInjectChild()
      let assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)!.text).toContain(`harness dir: ${harnessDirA}`)
      expect(assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)!.text).toContain('workflow wf-a (plan) running')
      expect(warns).toHaveLength(0)

      // HMR re-apply with a CHANGED config (the real hot-reload scenario): the
      // old registrations must be disposed (inject-child disposers) BEFORE the
      // fresh apply registers — no duplicate-name warn, the NEW boot value
      // lands, and the old apply closure (harnessDirA) renders nowhere.
      await fiber.dispose()
      const reloaded = await ctx.plugin(plugin, { harnessDir: harnessDirB })
      await settleInjectChild()
      assembly = await ctx.systemPrompt.assemble()
      const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
      expect(section).toBeDefined()
      expect(section!.text).toContain(`harness dir: ${harnessDirB}`)
      expect(section!.text).not.toContain(`harness dir: ${harnessDirA}`)
      const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)!
      expect(context.text).toContain('workflow wf-b (plan) running')
      expect(context.text).not.toContain('wf-a')
      expect(warns).toHaveLength(0)
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('(k) zero-config (harnessDir: null) — the providers resolve the harness dir from the ASSEMBLY context\'s agent (session workspace), the enforcement word matches that workspace\'s compass, and a live flip lands without re-registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-zeroconfig-'))
    const workspace = join(root, 'workspace')
    const wsHarnessDir = join(workspace, '.mstar')
    await mkdir(wsHarnessDir, { recursive: true })
    await seedHarness(wsHarnessDir, {
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', { type: 'iteration' }),
    })
    // `harnessDir: null` omits the config key — the plugin resolves per
    // session workspace at event/assembly time, never from the process cwd.
    booted = await bootApp({ root, harnessDir: null })
    const app = booted
    // The root-session agent shape (dsh `assembleContextFor(agent)`): the
    // provider reads `agent.session.header.cwd` structurally. `@deepseek-ai/
    // dsh-agent` augments `AssembleContext` with `agent?: Agent`.
    const agent = { id: 'zero-config-session', session: { header: { cwd: workspace }, events: [] } } as unknown as Agent
    const assembleForAgent = () => app.ctx.systemPrompt.assemble({ agent })

    // No compass yet → fail-soft, but the harness dir IS the workspace's
    // probed `.mstar/` (the zero-config default the README documents).
    let assembly = await assembleForAgent()
    let section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toContain(`harness dir: ${wsHarnessDir}`)
    expect(section!.text).toContain('enforcement: soft')
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    expect(context!.text).toContain('workflow v2.2.0 (iteration) running | plans: none')
    expect(context!.text).not.toContain('harness ')

    // Live flip under zero-config: the hard compass lands on the next
    // assembly (same boot, same registration — the enforcement word follows
    // the WORKSPACE compass, matching the gates' own per-workspace resolve).
    await seedHarness(wsHarnessDir, { 'iterations/v2.2.0/delivery-compass.md': RICH_COMPASS })
    assembly = await assembleForAgent()
    section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    expect(section!.text).toContain(`harness dir: ${wsHarnessDir}`)
    expect(section!.text).toContain('enforcement: hard')
  })

  it('(l) interpolation-hazard screening — hostile dynamic values ({{x}} in plan id / lease holder / iteration id / compass direction) render without throwing and keep the screened text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-hostile-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // Operator-controlled fields carrying COMPLETE `{{...}}` groups: the
    // workflow id (`{{iter}}`), the plan id (`{{plan}}`) and — fixture-only,
    // never rendered by the slim digest — a lease holder + compass direction
    // prose.
    const HOSTILE_ROOT = v2Root([v2WorkflowEntry('{{iter}}', 'iteration')])
    const HOSTILE_SNAPSHOT = v2Snapshot('{{iter}}', {
      type: 'iteration',
      plans: [
        {
          plan_id: '{{plan}}',
          title: 'Hostile',
          status: 'InProgress',
          execution_lease: { holder: '{{leaser}}', claimed_at: '2026-08-08' },
        },
      ],
    })
    const HOSTILE_COMPASS = [
      '---',
      'iteration_id: v2.2.0',
      'status: active',
      'enforcement: hard',
      'iteration_base_branch: dev-dsh',
      'target_branch: dev-dsh',
      'plans:',
      '  - {{plan}}',
      '---',
      '',
      '## Direction lock (autonomous)',
      '',
      '- **Problem statement:** The {{template}} syntax must stay literal.',
      '',
      '## Scope',
      '',
      'body',
    ].join('\n')
    await seedHarness(harnessDir, {
      'status.json': HOSTILE_ROOT,
      'workflows/{{iter}}/snapshot.json': HOSTILE_SNAPSHOT,
      'iterations/{{iter}}/delivery-compass.md': HOSTILE_COMPASS,
    })
    booted = await bootApp({ root })
    const assembly = await booted.ctx.systemPrompt.assemble()
    const section = assembly.sections.find((s) => s.name === HARNESS_RULES_SECTION_NAME)
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(section).toBeDefined()
    expect(context).toBeDefined()
    // No complete `{{...}}` group survives the screening (the pre-fix code
    // embeds the raw values → the real renderers THROW here).
    expect(PERSONA_INTERPOLATION_HAZARD.test(section!.text)).toBe(false)
    expect(PERSONA_INTERPOLATION_HAZARD.test(context!.text)).toBe(false)
    expect(() => renderPrompt(assembly)).not.toThrow()
    expect(() => renderContextSnapshot(assembly)).not.toThrow()
    // The screened text stays readable — the original content is retained.
    expect(context!.text).toContain('workflow { {iter} } (iteration) running')
    expect(context!.text).toContain('{ {plan} }(InProgress)')
    // The omitted surfaces (leases / direction / iteration gate) never
    // render — even their screened literals stay out.
    expect(context!.text).not.toContain('leases:')
    expect(context!.text).not.toContain('direction:')
    expect(context!.text).not.toContain(': gate')
  })

  it('(m) interpolation-hazard screening — a lone `{{` in a plan id stays literal (upstream renders it as prose; the helper must not mangle it)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-lone-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', {
        type: 'iteration',
        plans: [{ plan_id: 'plan-{{open', title: 'Lone', status: 'InProgress' }],
      }),
    })
    booted = await bootApp({ root })
    const assembly = await booted.ctx.systemPrompt.assemble()
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)
    expect(context).toBeDefined()
    // The lone `{{` (no later `}}`) survives verbatim in the embedded plan
    // id and renders as literal prose — no throw, no mangling.
    expect(context!.text).toContain('plan-{{open(InProgress)')
    expect(() => renderContextSnapshot(assembly)).not.toThrow()
    expect(() => renderPrompt(assembly)).not.toThrow()
  })
})

describe('stripInterpolationHazard (STRICT {{variable}} screening — plan QC fix wave W-1)', () => {
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

describe('mstar:engine-status slim digest (plan 20260820-dsh-engine-status-slim)', () => {
  /** Boot an app seeded with the given harness files and return its context digest text + assembly. */
  async function bootSlim(seed: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-system-prompt-slim-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, seed)
    const app = await bootApp({ root })
    booted = app
    const assembly = await app.ctx.systemPrompt.assemble()
    const context = assembly.contexts.find((c) => c.name === ENGINE_STATUS_CONTEXT_NAME)!
    return { assembly, text: context.text }
  }

  it('(slim-1) idle beats terminal fallback — an empty active set renders the version line alone even with a terminal snapshot on disk (D1)', async () => {
    const { text } = await bootSlim({
      'status.json': v2Root([]),
      'workflows/wf-old/snapshot.json': v2Snapshot('wf-old', { status: 'completed', ended_at: '2026-08-19' }),
    })
    expect(text).toBe(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(text).not.toContain('wf-old')
    expect(text).not.toContain('workflow')
  })

  it('(slim-2) mixed plan statuses — Done plans are filtered out of the non-Done join (D2)', async () => {
    const { text } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', {
        type: 'iteration',
        plans: [
          { plan_id: 'p-todo', title: 'Todo', status: 'Todo' },
          { plan_id: 'p-prog', title: 'Progress', status: 'InProgress' },
          { plan_id: 'p-done', title: 'Done', status: 'Done', done_at: '2026-08-19' },
          { plan_id: 'p-blocked', title: 'Blocked', status: 'Blocked' },
        ],
      }),
    })
    expect(text).toBe(
      `mstar engine status: v${PLUGIN_VERSION}\nworkflow v2.2.0 (iteration) running | plans: p-todo(Todo) p-prog(InProgress) p-blocked(Blocked)`,
    )
    expect(text).not.toContain('p-done')
  })

  it('(slim-3) all plans Done (workflow still running) renders `plans: none` — the empty-after-filter copy (D2)', async () => {
    const { text } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', {
        type: 'iteration',
        plans: [{ plan_id: 'p-done', title: 'Done', status: 'Done', done_at: '2026-08-19' }],
      }),
    })
    expect(text).toBe(`mstar engine status: v${PLUGIN_VERSION}\nworkflow v2.2.0 (iteration) running | plans: none`)
  })

  it('(slim-4) stale trust (D3) — a still-registered workflow renders its snapshot\'s OWN status word (completed), never a re-derivation', async () => {
    const { text } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', { type: 'iteration', status: 'completed', ended_at: '2026-08-19' }),
    })
    expect(text).toContain('workflow v2.2.0 (iteration) completed')
  })

  it('(slim-5) missing snapshot — an active entry with no workflows/ dir degrades to the version line and never throws (S-d fix-wave)', async () => {
    const { text, assembly } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
    })
    expect(text).toBe(`mstar engine status: v${PLUGIN_VERSION}`)
    expect(() => renderContextSnapshot(assembly)).not.toThrow()
  })

  it('(slim-6) cap after filter — 10 non-Done plans render the first 8 + `+2 more`; the 9th non-Done id and both Done ids stay out (D5)', async () => {
    const plans = [
      ...Array.from({ length: 10 }, (_, i) => ({ plan_id: `p-${i}`, title: `Plan ${i}`, status: 'InProgress' })),
      { plan_id: 'p-done-1', title: 'Done 1', status: 'Done', done_at: '2026-08-19' },
      { plan_id: 'p-done-2', title: 'Done 2', status: 'Done', done_at: '2026-08-19' },
    ]
    const { text } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('v2.2.0', 'iteration')]),
      'workflows/v2.2.0/snapshot.json': v2Snapshot('v2.2.0', { type: 'iteration', plans }),
    })
    expect(text).toContain('plans: p-0(InProgress) p-1(InProgress) p-2(InProgress) p-3(InProgress) p-4(InProgress) p-5(InProgress) p-6(InProgress) p-7(InProgress) +2 more')
    expect(text).not.toContain('p-8(InProgress)')
    expect(text).not.toContain('p-done-1')
    expect(text).not.toContain('p-done-2')
  })

  it('(slim-7) the status word is the snapshot\'s — a paused snapshot renders `paused`, not a hardcoded `active` (D2)', async () => {
    const { text } = await bootSlim({
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1', { status: 'paused' }),
    })
    expect(text).toContain('workflow wf-1 (plan) paused')
  })
})
