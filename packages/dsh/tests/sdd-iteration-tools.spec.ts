/**
 * Task 1 — sdd + iteration tool wrappers (plan 20260808-dsh-seams-bundle):
 * `mstar_sdd_workspace` / `mstar_sdd_task_brief` / `mstar_iteration_gate`
 * registered on `ctx.tools` via the dsh-tools `defineTool` contract, running
 * the engine in-app against control-path artifacts.
 *
 * Composition: the app boots the REAL-composition harness with the
 * `@deepseek-ai/dsh-tools` registry installed from the npm registry (its
 * default export provides the `ctx.tools` service), so registration and
 * execution exercise
 * the shipping plugin path — tools are looked up and executed through the
 * registry, never called directly.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, valueOf, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** Branded call identity for registry executes. */
const callId = 'sdd-iteration-tools.spec' as CallId
/** Test signal (never aborted). */
const signal = new AbortController().signal

/** Run one tool call through the composed registry. */
function run(ctx: BootResult['ctx'], name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId, name, arguments: args, signal })
}

/** Assert the generic-card presentCall contract (title / kind / rawInput). */
function expectGenericCall(view: unknown, rawInput: unknown): void {
  const card = view as { card?: string; title?: string; kind?: string; rawInput?: unknown } | undefined
  expect(card).toBeDefined()
  expect(card!.card).toBe('generic')
  expect(typeof card!.title).toBe('string')
  expect(card!.title!.length).toBeGreaterThan(0)
  expect(card!.kind).toBe('other')
  expect(card!.rawInput).toEqual(rawInput)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixture plan: Task 1 contains a fenced "## Task 2" heading (ignored by the
 * fence-aware extraction) plus a real Task 2 section. */
const PLAN_FIXTURE = [
  '# Fixture Plan',
  '',
  '## Task 1',
  '- Step one: create the workspace.',
  '```',
  '## Task 2',
  '```',
  '- Step two: gate the iteration.',
  '## Task 2',
  '- Step three: extract this brief.',
  '',
].join('\n') + '\n'

/** Valid in-progress delivery compass (mstar-iteration §1.3 template shape). */
const COMPASS_ACTIVE = [
  '---',
  'iteration_id: fixture-iter',
  'start_date: 2026-08-08',
  'status: locked',
  'iteration_base_branch: dev-dsh',
  'target_branch: dev-dsh',
  'plans:',
  '  - fixture-plan-1',
  '---',
  '',
  '# Fixture Delivery Compass',
  '',
].join('\n')

/** Completed compass: `status: completed` + `end_date` (iteration-close shape). */
const COMPASS_COMPLETED = COMPASS_ACTIVE
  .replace('start_date: 2026-08-08', 'start_date: 2026-08-08\nend_date: 2026-08-10')
  .replace('status: locked', 'status: completed')

/** status.json built from a plans[] array (harness VALID_STATUS base). */
function statusWithPlans(plans: unknown[], residuals: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, updated_at: '2026-08-08', plans, residual_findings: residuals, metadata: {} }
}

const PLAN_DONE = { id: 'fixture-plan-1', title: 'Fixture plan', status: 'Done', file: 'plans/fixture.md' }
const PLAN_TODO = { ...PLAN_DONE, status: 'Todo' }

/** Matching §3.5 branch probes for the all-done fixtures. */
const MATCHING_PROBES = { branch: 'iteration/v2.1.0', integration: 'iteration/v2.1.0', target: 'dev-dsh' }

// ---------------------------------------------------------------------------
// Registration (real composition)
// ---------------------------------------------------------------------------

describe('sdd/iteration tool registration — real composition', () => {
  it('registers mstar_sdd_workspace / mstar_sdd_task_brief / mstar_iteration_gate on ctx.tools', async () => {
    const app = booted = await bootApp()
    const names = ['mstar_sdd_workspace', 'mstar_sdd_task_brief', 'mstar_iteration_gate']
    const seen = new Set<string>()
    for (const name of names) {
      const tool = app.ctx.tools.get(name)
      expect(tool).toBeDefined()
      expect(tool!.description.length).toBeGreaterThan(0)
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }
  })

  it('declares generic presentCall cards (title / kind / rawInput) with valid args', async () => {
    const app = booted = await bootApp()
    expectGenericCall(app.ctx.tools.get('mstar_sdd_workspace')!.presentCall?.({ plan_id: 'plan-a' }), 'plan-a')
    expectGenericCall(app.ctx.tools.get('mstar_sdd_task_brief')!.presentCall?.({ plan_file: 'plan.md', task_number: 1 }), 'plan.md')
    expectGenericCall(
      app.ctx.tools.get('mstar_iteration_gate')!.presentCall?.({ status_path: 's.json', compass_path: 'c.md' }),
      'c.md',
    )
  })

  it('presentCall falls back softly on hostile args (no throw, undefined = generic card)', async () => {
    const app = booted = await bootApp()
    expect(app.ctx.tools.get('mstar_sdd_workspace')!.presentCall?.({})).toBeUndefined()
    expect(app.ctx.tools.get('mstar_iteration_gate')!.presentCall?.({ status_path: 42 })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mstar_sdd_workspace
// ---------------------------------------------------------------------------

describe('mstar_sdd_workspace', () => {
  it('creates {HARNESS_DIR}/sdd/<plan-id> for a fixture plan (with the SDD gitignore)', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_workspace', { plan_id: 'fixture-plan-1', control_root: app.root })

    expect(result.isError).toBe(false)
    if (result.isError) return
    // sddWorkspace returns the physical path (symlinks resolved — `cd && pwd`
    // semantics), so the expectation is realpathed too.
    expect(valueOf(result) as { sdd_dir: string }).toEqual({ sdd_dir: realpathSync(join(app.harnessDir, 'sdd', 'fixture-plan-1')) })
    expect(existsSync(join(valueOf(result).sdd_dir!, '.gitignore'))).toBe(true)
    expect(readFileSync(join(valueOf(result).sdd_dir!, '.gitignore'), 'utf8')).toBe('*\n')
    // Native projection mirrors the CLI's `sdd dir: <path>` output.
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('sdd dir:')
  })

  it('resolves against the plugin harness dir even without {HARNESS_DIR}/status.json', async () => {
    const app = booted = await bootApp()
    // bootApp creates the harness dir without seeding status.json.
    const result = await run(app.ctx, 'mstar_sdd_workspace', { plan_id: 'bare-plan', control_root: app.root })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(existsSync(join(app.harnessDir, 'sdd', 'bare-plan'))).toBe(true)
  })

  it.skipIf(!cwdIsLinkedWorktree())('fails closed in a linked worktree without control_root (no second SDD tree)', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_workspace', { plan_id: 'stray-plan' })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('linked worktree')
    expect(existsSync(join(app.harnessDir, 'sdd', 'stray-plan'))).toBe(false)
  })

  it('hostile: missing plan_id → INVALID_ARGS', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_workspace', { control_root: app.root })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.info?.code).toBe('INVALID_ARGS')
    expect(result.error.message).toContain('missing required property \"plan_id\"')
  })

  it('hostile: non-string plan_id → INVALID_ARGS', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_workspace', { plan_id: 42 })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.info?.code).toBe('INVALID_ARGS')
    expect(result.error.message).toContain('\"plan_id\" must be a string')
  })

  it('hostile: nonexistent control_root → failure result', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_workspace', {
      plan_id: 'plan-a',
      control_root: join(app.root, 'does-not-exist'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('not a directory')
  })
})

// ---------------------------------------------------------------------------
// mstar_sdd_task_brief
// ---------------------------------------------------------------------------

describe('mstar_sdd_task_brief', () => {
  /** Write the fixture plan next to the app root and return its path. */
  async function seedPlan(root: string): Promise<string> {
    const planFile = join(root, 'fixture-plan.md')
    await writeFileSync(planFile, PLAN_FIXTURE)
    return planFile
  }

  it('extracts the Task N section (fence-aware) into out_file', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)
    const outFile = join(app.root, 'task-1-brief.md')

    const result = await run(app.ctx, 'mstar_sdd_task_brief', { plan_file: planFile, task_number: 1, out_file: outFile })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result) as unknown as { brief_file: string; task_number: number }).toEqual({ brief_file: outFile, task_number: 1 })
    const brief = readFileSync(outFile, 'utf8')
    expect(brief).toContain('Step one')
    expect(brief).toContain('Step two')
    expect(brief).not.toContain('Step three')
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('task 1 brief:')
  })

  it('extracts a later section and stops at the previous heading boundary', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)

    const result = await run(app.ctx, 'mstar_sdd_task_brief', {
      plan_file: planFile,
      task_number: 2,
      out_file: join(app.root, 'task-2-brief.md'),
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    const brief = readFileSync(join(app.root, 'task-2-brief.md'), 'utf8')
    expect(brief).toContain('Step three')
    expect(brief).not.toContain('Step one')
  })

  it('defaults the out file to {sdd_dir}/task-N-brief.md (in-app SDD_DIR mirror)', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)
    const sddDir = join(app.root, 'sdd-briefs')

    const result = await run(app.ctx, 'mstar_sdd_task_brief', { plan_file: planFile, task_number: 2, sdd_dir: sddDir })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result).brief_file).toBe(join(sddDir, 'task-2-brief.md'))
    expect(existsSync(join(sddDir, 'task-2-brief.md'))).toBe(true)
  })

  it('hostile: neither out_file nor sdd_dir → failure result', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)

    const result = await run(app.ctx, 'mstar_sdd_task_brief', { plan_file: planFile, task_number: 1 })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('out_file or sdd_dir')
  })

  it('hostile: missing plan file → failure result', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_sdd_task_brief', {
      plan_file: join(app.root, 'no-such-plan.md'),
      task_number: 1,
      out_file: join(app.root, 'x.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('no such plan file')
  })

  it('hostile: task_number below 1 → usage failure result (engine SddScriptError)', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)

    const result = await run(app.ctx, 'mstar_sdd_task_brief', {
      plan_file: planFile,
      task_number: 0,
      out_file: join(app.root, 'x.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('usage: mstar sdd task-brief')
  })

  it('hostile: nonexistent task → failure result', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)

    const result = await run(app.ctx, 'mstar_sdd_task_brief', {
      plan_file: planFile,
      task_number: 9,
      out_file: join(app.root, 'x.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('task 9 not found')
  })

  it('hostile: non-integer task_number → INVALID_ARGS', async () => {
    const app = booted = await bootApp()
    const planFile = await seedPlan(app.root)

    const result = await run(app.ctx, 'mstar_sdd_task_brief', {
      plan_file: planFile,
      task_number: 1.5,
      out_file: join(app.root, 'x.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.info?.code).toBe('INVALID_ARGS')
    expect(result.error.message).toContain('\"task_number\" must be an integer')
  })
})

// ---------------------------------------------------------------------------
// mstar_iteration_gate
// ---------------------------------------------------------------------------

describe('mstar_iteration_gate', () => {
  it('passes on a valid in-progress fixture (transition phase-2-execute)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_TODO])),
      'delivery-compass.md': COMPASS_ACTIVE,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result)).toMatchObject({
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      violations: [],
    })
    // Execution in progress: entry warnings (PLAN_NOT_DONE) do not fail the gate.
    expect(valueOf(result).entry!.ok).toBe(false)
    expect(valueOf(result).entry!.violations.map((v) => v.code)).toContain('PLAN_NOT_DONE')
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('PASS')
  })

  it('passes on an all-done fixture (transition phase-4-pr-delivery)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_DONE])),
      'delivery-compass.md': COMPASS_COMPLETED,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
      ...MATCHING_PROBES,
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result)).toMatchObject({
      transition: 'phase-4-pr-delivery',
      all_plans_done: true,
      ok: true,
      entry: { ok: true, violations: [] },
      exit: { ok: true, violations: [] },
      violations: [],
    })
  })

  it('fails with violation codes on a broken compass (completed without end_date)', async () => {
    const app = booted = await bootApp()
    const brokenCompass = COMPASS_COMPLETED.replace('\nend_date: 2026-08-10', '')
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_DONE])),
      'delivery-compass.md': brokenCompass,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
      ...MATCHING_PROBES,
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result)).toMatchObject({ transition: 'phase-3-close', all_plans_done: true, ok: false })
    expect(valueOf(result).entry!.ok).toBe(false)
    expect(valueOf(result).exit!.ok).toBe(false)
    const codes = valueOf(result).violations.map((v) => v.code)
    expect(codes).toContain('COMPASS_END_DATE_REQUIRED')
    // The render carries the failing codes (acceptance: pass/fail with codes).
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('FAIL')
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('COMPASS_END_DATE_REQUIRED')
  })

  it('fails with OPEN_RESIDUALS on open plan residuals', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_DONE], {
        'fixture-plan-1': [{ id: 'R1', title: 'open finding', severity: 'medium', lifecycle: 'open' }],
      })),
      'delivery-compass.md': COMPASS_COMPLETED,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
      ...MATCHING_PROBES,
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result).ok).toBe(false)
    expect(valueOf(result).violations.map((v) => v.code)).toContain('OPEN_RESIDUALS')
  })

  it('fails with EXIT_BRANCH_MISMATCH when the working branch probe disagrees', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_DONE])),
      'delivery-compass.md': COMPASS_COMPLETED,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
      branch: 'feature/rogue',
      integration: 'iteration/v2.1.0',
      target: 'dev-dsh',
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result).ok).toBe(false)
    expect(valueOf(result).violations.map((v) => v.code)).toContain('EXIT_BRANCH_MISMATCH')
  })

  it('reports PLAN_NOT_IN_STATUS on entry while the running gate still passes', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([])),
      'delivery-compass.md': COMPASS_ACTIVE,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result)).toMatchObject({ transition: 'phase-2-execute', all_plans_done: false, ok: true })
    expect(valueOf(result).entry!.violations.map((v) => v.code)).toContain('PLAN_NOT_IN_STATUS')
  })

  it('hostile: missing status/compass files → failure results', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'delivery-compass.md': COMPASS_ACTIVE })

    const missingStatus = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })
    expect(missingStatus.isError).toBe(true)
    if (!missingStatus.isError) return
    expect(missingStatus.error.message).toContain('status file not found')

    await seedHarness(app.harnessDir, { 'status.json': JSON.stringify(statusWithPlans([])) })
    const missingCompass = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'no-compass.md'),
    })
    expect(missingCompass.isError).toBe(true)
    if (!missingCompass.isError) return
    expect(missingCompass.error.message).toContain('compass file not found')
  })

  it('hostile: invalid JSON status → failure result', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': 'not json {{{',
      'delivery-compass.md': COMPASS_ACTIVE,
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('Invalid JSON')
  })

  it('hostile: compass without a frontmatter fence → failure result', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([])),
      'delivery-compass.md': '# no frontmatter here\n',
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('no YAML frontmatter fence')
  })

  it('hostile: unsupported compass frontmatter line → failure result', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([])),
      'delivery-compass.md': '---\n- orphan item before any key\n---\n',
    })

    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(app.harnessDir, 'status.json'),
      compass_path: join(app.harnessDir, 'delivery-compass.md'),
    })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('unsupported frontmatter line')
  })

  it('hostile: missing required status_path → INVALID_ARGS', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_iteration_gate', { compass_path: 'c.md' })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.info?.code).toBe('INVALID_ARGS')
    expect(result.error.message).toContain('missing required property \"status_path\"')
  })

  it('hostile: non-string status_path → INVALID_ARGS', async () => {
    const app = booted = await bootApp()
    const result = await run(app.ctx, 'mstar_iteration_gate', { status_path: 42, compass_path: 'c.md' })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.info?.code).toBe('INVALID_ARGS')
    expect(result.error.message).toContain('\"status_path\" must be a string')
  })
})

// ---------------------------------------------------------------------------
// Environment-dependent: linked-worktree fail-closed guard
// ---------------------------------------------------------------------------

/** Whether the test process cwd's git top-level is a linked worktree
 * (mirror of engine sdd.ts `isLinkedWorktree` classification — the tool runs
 * against process.cwd() and the fail-closed guard only fires there). */
function cwdIsLinkedWorktree(): boolean {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: topLevel,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return gitDir.includes('/.git/worktrees/') || gitDir.includes('/worktrees/')
  } catch {
    return false
  }
}
