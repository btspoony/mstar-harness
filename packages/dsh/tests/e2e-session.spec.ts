/**
 * Task 5 — end-to-end integration test: a FULL mstar-gated session in one
 * composed dsh app.
 *
 * Boots the full-app fixture cordis.yml through the REAL-composition boot (dsh-skill +
 * dsh-system-prompt + dsh-tools + dsh-commands from the linked dsh source
 * tree + the mstar plugin — the committed `tests/fixtures/cordis.yml`
 * replaces the inline row list), mounts the
 * repo-root mirror skills/, and simulates one complete session:
 *
 *  1. status gate — invalid status.json write refused under hard mode
 *     (repair-escape advisory + host-hook failure result);
 *  2. dispatch gate — valid / read-only assignments pass, missing-field
 *     Assignment is denied under hard;
 *  3. row-scope gate — SDD dispatch against a mismatched worktree warns
 *     (default) and denies (hard);
 *  4. skill-lint gate — broken SKILL.md write flagged;
 *  5. seam gates — broken DESIGN.md write flagged;
 *  6. agent/pre-step — engine-status watermark + iteration-gate row composed
 *     into the step messages (AC-7 "full mstar-gated session");
 *  7. v2 seam tools — mstar_sdd_workspace creates the SDD dir,
 *     mstar_iteration_gate evaluates the committed fixtures;
 *  8. bundledSkillDir — explicit relative roots resolve from an isolated
 *     launch cwd, independently of the app workspace and test-runner cwd.
 *
 * AC-7/AC-8 evidence: this spec IS the "local install simulation boots a
 * full mstar-gated session" observable; the `dsh plugin --profile add`
 * CLI real-run outcome is documented in task-5-report.md.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DispatchGateAdvisory, SeamLintAdvisory, SkillLintAdvisory } from '../src/index.ts'
import { DshHostAdapter, readAgentFlow } from '../src/index.ts'
import { bootApp, seedActiveWorkflow, seedHarness, type BootResult } from './harness.ts'
import { buildCatalogPayloadWithStore } from '../src/gates/catalog.ts'
import { ENGINE_VERSION } from './engine-version.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- paths ---------------------------------- */

/** The committed fixture root (`tests/fixtures/`). */
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
/** The full-app cordis.yml fixture. */
const FIXTURE_CORDIS_YML = join(FIXTURES, 'cordis.yml')
/** The repo-root mirror skills/ (byte-identical to the control mirror). */
const MIRROR_SKILLS = fileURLToPath(new URL('../../../skills/', import.meta.url))

/** Read one committed fixture file. */
function fixture(rel: string): string {
  return readFileSync(join(FIXTURES, rel), 'utf8')
}

/* --------------------------------- helpers --------------------------------- */

/** Branded call identity for registry executes. */
const callId = 'e2e-session.spec' as ToolCallId
/** Test signal (never aborted). */
const signal = new AbortController().signal

/** Run one tool call through the composed registry. */
function run(ctx: BootResult['ctx'], name: string, args: Record<string, unknown>, agent?: unknown): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId, name, arguments: args, ...(agent === undefined ? {} : { agent }), signal } as never)
}

/** FsTarget for a local-backend path. */
const target = (path: string): FsTarget => ({ targetKey: path as FsTarget['targetKey'], displayPath: path })


/** FsTarget for a SKILL.md under a skill root. */
const skillTarget = (root: string, name: string): FsTarget => target(join(root, name, 'SKILL.md'))

/** Seed a file at an absolute path (intermediate dirs created). */
async function seedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}


/** Collect dispatch-gate advisory emits on the app context. */
function captureDispatchAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const seen: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { seen.push(payload) })
  return seen
}

/** Collect skill-lint advisory emits on the app context. */
function captureSkillAdvisories(ctx: BootResult['ctx']): SkillLintAdvisory[] {
  const seen: SkillLintAdvisory[] = []
  ctx.on('mstar/skill-lint', (payload) => { seen.push(payload) })
  return seen
}

/** Collect seam-lint advisory emits on the app context. */
function captureSeamAdvisories(ctx: BootResult['ctx']): SeamLintAdvisory[] {
  const seen: SeamLintAdvisory[] = []
  ctx.on('mstar/seam-lint', (payload) => { seen.push(payload) })
  return seen
}

const violationCodes = (advisory: { result: { violations: Array<{ code: string }> } } | undefined): string[] =>
  advisory?.result.violations.map((v) => v.code) ?? []

let seq = 0

/** One pending subagent tool call in the registry pipeline shape. */
function subagentExec(prompt: string): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description: 'probe', prompt },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/** One pre-existing user message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage => createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hello from the inbox' }],
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[]) => ({
  agent: {},
  messages,
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
} as never)

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined =>
  decision.messages.at(-1)

const LEASE_PLAN_ID = 'e2e-lease-plan'
const LEASE_BRANCH = 'feature/e2e-lease'

/** The SDD writable Assignment the row-scope gate re-verifies, parameterised by
 * the real feature checkout the row records. */
function sddAssignment(worktreePath: string): string {
  return `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: plans/${LEASE_PLAN_ID}.md
**Worktree path**: ${worktreePath}
**Working branch**: ${LEASE_BRANCH}
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`
}

/**
 * Build the real topology the row-scope gate re-verifies and seed the plan row
 * through the public producers: the app root is a git repo on `main`, plus a
 * dedicated integration checkout and the plan's feature worktree. The row's
 * recorded scope names the feature checkout, so a scope-bearing row has real
 * checkouts rather than absolute-looking placeholders. Returns the feature
 * path the Assignment must name to match.
 */
async function seedScopedRow(app: BootResult): Promise<string> {
  const root = app.root
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const integrationPath = join(root, 'integration-checkout')
  const featurePath = join(root, 'feature-checkout')
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'integration/fixture', integrationPath])
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', LEASE_BRANCH, featurePath])
  await seedActiveWorkflow(app.harnessDir, 'wf-1', [{
    id: LEASE_PLAN_ID,
    title: 'E2E scoped plan',
    file: `plans/${LEASE_PLAN_ID}.md`,
    status: 'InProgress',
    metadata: { worktree_path: featurePath, working_branch: LEASE_BRANCH },
  }], {
    type: 'iteration',
    branch: { base: 'main', integration: 'integration/fixture' },
    integration_worktree_path: integrationPath,
  }, 'seed-wf-1', root, 'wf-1')
  return featurePath
}

/* ===========================================================================
 * 1. Full dsh app boot — fixture cordis.yml composition
 * ========================================================================== */

describe('full dsh app boot — fixture cordis.yml composition', () => {
  it('boots the full-app fixture through the real Loader with gates, tools, and mounted skills live', async () => {
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, skillRoots: [MIRROR_SKILLS], enforcement: 'hard' })

    // Host adapter service attached (boot settled).
    expect(booted.ctx.dshHostAdapter).toBeInstanceOf(DshHostAdapter)
    // All v2 seam + validation tools registered on ctx.tools.
    for (const name of [
      'mstar_sdd_workspace',
      'mstar_sdd_task_brief',
      'mstar_iteration_gate',
      'mstar_design_md_validate',
      'mstar_audit_validate',
      'mstar_compound_validate',
      'mstar_roles_validate',
    ]) {
      expect(booted.ctx.tools.get(name), name).toBeDefined()
    }
    // The mirror skills/ mount is live through ctx.skills.
    const skills = await booted.ctx.skills.list()
    expect(skills.some((s) => s.name === 'mstar-harness-core')).toBe(true)
    expect(skills.some((s) => s.name === 'pm')).toBe(true)
  })
})

// Disposition — removed status.json gate cases; status-file write validation is a retired file-route behavior.

/* ===========================================================================
 * 3. Dispatch gate — full session dispatch decisions
 * ========================================================================== */

describe('dispatch gate — full session dispatch decisions', () => {
  it('valid writable Assignment → silent allow under hard', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/valid.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('read-only orientation Assignment → silent allow (no branch form needed)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/read-only.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('missing Execute as under hard → PreToolDecision deny, downstream decider never runs', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/missing-execute-as.md')), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.missing-execute-as')
  })

  it('SDD assignment with a matching recorded row scope → silent allow', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const feature = await seedScopedRow(app)
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(sddAssignment(feature)), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * 4. Row-scope gate — SDD dispatch against a mismatched source worktree
 * ========================================================================== */

describe('lease gate — SDD dispatch lease violation', () => {
  it('mismatched Worktree path → advisory lease.dispatch.worktree-mismatch, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, dispatchBinding: 'qc-specialist' })
    await seedScopedRow(app)
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(sddAssignment(join(app.root, 'not-the-feature-checkout'))), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('mismatched Worktree path under hard → deny with lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    await seedScopedRow(app)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(sddAssignment(join(app.root, 'not-the-feature-checkout'))), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('lease.dispatch.worktree-mismatch')
  })
})

/* ===========================================================================
 * 5. Skill-lint gate — broken SKILL.md flagged on write
 * ========================================================================== */

describe('skill-lint gate — broken skill flagged on write', () => {
  const SKILL_FIXTURES = join(FIXTURES, 'skills')

  it('broken SKILL.md (missing description) → advisory lint.frontmatter.description.missing', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, skillRoots: [SKILL_FIXTURES] })
    const advisories = captureSkillAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', skillTarget(SKILL_FIXTURES, 'broken-skill'), {}, () => undefined)

    expect(intent).toBeUndefined() // warn default: the intent proceeds
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(false)
    expect(violationCodes(advisories[0])).toContain('lint.frontmatter.description.missing')
  })

  it('valid SKILL.md → silent pass', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, skillRoots: [SKILL_FIXTURES] })
    const advisories = captureSkillAdvisories(app.ctx)

    await app.ctx.waterfall('fs/write-intent', skillTarget(SKILL_FIXTURES, 'good-skill'), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * 6. Seam gates — broken DESIGN.md flagged on write
 * ========================================================================== */

describe('seam gates — broken DESIGN.md flagged on write', () => {
  it('broken token frontmatter → advisory design-md.tokens.color-format (warn default)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-design-'))
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    await seedFile(join(root, 'DESIGN.md'), fixture('design/DESIGN.broken.md'))
    const advisories = captureSeamAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('design-md')
    expect(violationCodes(advisories[0])).toContain('design-md.tokens.color-format')
  })

  it('valid DESIGN.md → silent pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-design-ok-'))
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    await seedFile(join(root, 'DESIGN.md'), fixture('design/DESIGN.md'))
    const advisories = captureSeamAdvisories(app.ctx)

    await app.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * 7. agent/pre-step — iteration-gate row + catalog watermark
 * ========================================================================== */

describe('agent/pre-step — iteration-gate row + catalog watermark', () => {
  it('boot with status + steering compass → pre-step composes the engine-status watermark AND the iteration-gate row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-e2e-prestep-'))
    const harnessDir = join(root, 'harness')
    // The ACTIVE workflow snapshot carries the sole compass link.
    await seedActiveWorkflow(harnessDir, 'e2e-iter', [
      { id: 'fixture-plan-1', title: 'Fixture plan', status: 'Todo', file: 'plans/fixture.md' },
    ], { type: 'iteration', compass_ref: 'iterations/e2e-iter/delivery-compass.md' }, 'seed-e2e-iter', root, 'e2e-iter')
    await seedFile(join(harnessDir, 'iterations/e2e-iter/delivery-compass.md'), fixture('iteration/delivery-compass.md'))
    const app = booted = await bootApp({ root, harnessDir, cordisYml: FIXTURE_CORDIS_YML })
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // ONE unified catalog row (watermark + iteration gate + workspace state).
    expect(decision.messages.length).toBe(inbox.length + 1)
    expect(decision.messages.slice(0, -1)).toEqual(inbox)

    const row = decision.messages.at(-1)
    expect(row?.role).toBe('user')
    expect(row?.source).toEqual({ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' })
    // The catalog payload is NOT persisted on the row's source — read it from
    // the same builder the pre-step listener rendered the row from.
    const payload = await buildCatalogPayloadWithStore(app.ctx, harnessDir)

    // Watermark fields — AC-6 shape.
    expect(payload.version).toBe(ENGINE_VERSION)
    expect(payload.harnessDir).toBe(harnessDir)
    expect(payload.enforcement).toEqual({ hard: false, source: 'none' })

    // Iteration phase-gate section: the boot-evaluated gate in the Task 1
    // tool result shape (transition / all_plans_done / ok / codes) over the
    // SELECTED workflow snapshot.
    expect(payload.iteration).toMatchObject({
      gate: {
        transition: 'phase-2-execute',
        all_plans_done: false,
        ok: true,
        entry: { ok: false },
      },
    })

    // Workspace-state section: plan registry, residuals, branch anchors
    // (the snapshot carries no branch anchors, so the compass fills
    // base/target).
    expect(payload.state).toMatchObject({
      selection: { kind: 'active', workflowId: 'e2e-iter', dir: 'workflows/e2e-iter' },
      plans: [{ id: 'fixture-plan-1', status: 'Todo' }],
      residuals: [],
      iterationBaseBranch: 'dev-dsh',
      targetBranch: 'dev-dsh',
    })

    // The composed session log carries the model-facing block.
    const text = row?.content[0]?.type === 'text' ? row.content[0].text : ''
    expect(text).toContain('<mstar_engine_status>')
    expect(text).toContain(`mstar version: ${ENGINE_VERSION}`)
    expect(text).toContain(`harness dir: ${harnessDir}`)
    expect(text).toContain('enforcement: soft') // no compass hardens, no Config override
    expect(text).toContain('iteration: e2e-iter')
    expect(text).toContain('transition: phase-2-execute')
    expect(text).toContain('gate: PASS')
    expect(text).toContain('plans: fixture-plan-1(Todo)')
    // No issue/catalog authority exists in this workspace: the row discloses
    // the refusal instead of claiming there are no open issues.
    expect(text).toContain('residuals: none open')
    expect(text).toContain('branch: dev-dsh → dev-dsh')
    expect(text).toContain('row scope: none recorded')
  })
})

/* ===========================================================================
 * 8. v2 seam tools — callable over the committed fixtures
 * ========================================================================== */

describe('v2 seam tools — callable in-app over the committed fixtures', () => {
  it('mstar_sdd_workspace creates the SDD dir for a fixture plan', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    const result = await run(app.ctx, 'mstar_sdd_workspace', { plan_id: 'e2e-fixture-plan', control_root: app.root })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({ sdd_dir: realpathSync(join(app.harnessDir, 'sdd', 'e2e-fixture-plan')) })
    expect(existsSync(join((result.value as { sdd_dir: string }).sdd_dir, '.gitignore'))).toBe(true)
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('sdd dir:')
  })

  it('mstar_iteration_gate evaluates the committed fixtures (PASS, phase-2-execute)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    const snapshot = JSON.parse(fixture('workflow/wf-1/snapshot.json')) as { plans: unknown[]; [key: string]: unknown }
    await seedActiveWorkflow(app.harnessDir, 'wf-1', snapshot.plans, {
      ...snapshot,
      type: 'iteration',
      started_at: '2026-08-19',
      compass_ref: 'iterations/wf-1/delivery-compass.md',
      branch: { base: 'main', integration: 'iteration/fixture', target: 'main' },
      delivery_kind: 'development',
    }, 'seed-wf-1', app.root, 'wf-1')
    const result = await run(app.ctx, 'mstar_iteration_gate', {
      workflow_id: 'wf-1',
      compass_path: join(FIXTURES, 'iteration', 'delivery-compass.md'),
    }, { id: 'e2e-agent', session: { header: { id: 'seed-wf-1', cwd: app.root } } })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: false },
    })
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('PASS')
  })
})

/* ===========================================================================
 * 9. bundledSkillDir — explicit relative root is launch-cwd anchored
 * ========================================================================== */

describe('bundledSkillDir — launch-cwd resolution', () => {
  it('a relative bundledSkillDir discovers bundled skills from the launch cwd, not the app workspace', async () => {
    const launchRoot = await mkdtemp(join(tmpdir(), 'dsh-e2e-relative-skills-'))
    try {
      // Only the child has this launch cwd; no process-global chdir can race
      // other suites. The app workspace is a different directory.
      await symlink(join(FIXTURES, 'skills'), join(launchRoot, 'skills'), 'dir')
      const script = join(launchRoot, 'probe.ts')
      await writeFile(script, [
        `import { bootApp } from ${JSON.stringify(fileURLToPath(new URL('./harness.ts', import.meta.url)))}`,
        "import { join } from 'node:path'",
        `const app = await bootApp({ root: join(process.cwd(), 'workspace'), cordisYml: ${JSON.stringify(FIXTURE_CORDIS_YML)}, bundledSkillDir: './skills' })`,
        'try {',
        '  console.log(JSON.stringify(await app.ctx.skills.list()))',
        '} finally {',
        '  await app.dispose()',
        '}',
      ].join('\n'))
      const skills = JSON.parse(execFileSync(process.execPath, [script], {
        cwd: launchRoot,
        encoding: 'utf8',
      })) as Array<{ name: string; source: string; provider: string }>
      const good = skills.find((s) => s.name === 'good-skill')
      expect(good).toBeDefined()
      expect(good!.source).toBe('bundled')
      expect(good!.provider).toBe('mstar')
      // Missing-description skills remain undiscoverable.
      expect(skills.some((s) => s.name === 'broken-skill')).toBe(false)
    } finally {
      await rm(launchRoot, { recursive: true, force: true })
    }
  })

  it('an explicit relative root without deployment keys boots safely: engine-status watermark always appends', async () => {
    // No configured harness and no session workspace: skill configuration
    // must not prevent the advisory catalog from composing its watermark.
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, bundledSkillDir: './skills', harnessDir: null })
    expect(booted.ctx.dshHostAdapter).toBeInstanceOf(DshHostAdapter)

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const statusRow = decision.messages.find((m) => m.source.kind === 'plugin' && m.source.plugin === 'mstar-engine')
    expect(statusRow).toBeDefined()
    const text = statusRow?.content[0]?.type === 'text' ? statusRow.content[0].text : ''
    expect(text).toContain('<mstar_engine_status>')
    expect(text).toContain(`mstar version: ${ENGINE_VERSION}`)
  })
})

/* ===========================================================================
 * 10. Agent-flow ledger — real settle verification (plan
 *      Task 1: the REAL registry emits
 *     tools/post-execute — the old "settle unavailable at dev time" gate is
 *     obsolete, replaced by the paired-settle assertion)
 * ========================================================================== */

describe('agent-flow — real settle pairing (real call through the composed registry)', () => {
  it('a real subagent call through the composed registry records a dispatch AND a paired settle (post-execute foreground completion)', async () => {
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, dispatchBinding: 'qc-specialist' })
    // Seed an ACTIVE execution row before invoking the composed agent-flow writer.
    await seedActiveWorkflow(booted.harnessDir, 'wf-1', [], {}, 'seed-wf-1', booted.root, 'wf-1')
    // Dev-time reality: the real dsh-tools registry ships no delegation
    // tool, so the test registers the `subagent` tool it would have mounted —
    // the composed pipeline (pre-execute waterfall → validation → body →
    // render → post-execute waterfall) is the shipping registry code
    // (real dsh-tools).
    booted.ctx.tools.register(defineTool({
      name: 'subagent',
      description: 'delegate a task to a subagent',
      parameters: {
        description: { type: 'string' },
        prompt: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: async () => 'subagent result',
    }))

    // REAL subagent call through the composed registry (agent-bound).
    const result = await booted.ctx.tools.execute({
      callId,
      name: 'subagent',
      arguments: { description: 'probe', prompt: fixture('assignments/valid.md') },
      agent: { id: 'e2e-agent' } as unknown as import('@deepseek-ai/dsh-agent').Agent,
      signal,
    })
    expect(result.isError).toBe(false)

    // Dispatch recorded with the session's agent id AND a paired settle: the
    // registry's post-execute waterfall fired for the same callId — the
    // pairing store hit → the foreground result ('subagent result') settles
    // `ok` carrying the dispatch identity (role from the Assignment). v3
    // layout: the ledger lives in the ACTIVE workflow dir.
    const view = readAgentFlow(join(booted.harnessDir, 'workflows/wf-1'))
    expect(view).not.toBeNull()
    expect(view!.events).toHaveLength(2)
    expect(view!.events[0]).toMatchObject({
      kind: 'settle',
      outcome: 'ok',
      agent: 'e2e-agent',
      role: 'fullstack-dev', // the paired dispatch's Execute as (fixture valid.md)
      planId: null,
      taskId: null,
    })
    expect(view!.events[1]).toMatchObject({ kind: 'dispatch', verdict: 'ok', agent: 'e2e-agent', role: 'fullstack-dev' })
  })
})
