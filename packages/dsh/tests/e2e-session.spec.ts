/**
 * Task 5 — end-to-end integration test: a FULL mstar-gated session in one
 * composed dsh app (plan 20260808-dsh-seams-bundle).
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
 *  3. lease gate — SDD dispatch against a mismatched execution_lease warns
 *     (default) and denies (hard);
 *  4. skill-lint gate — broken SKILL.md write flagged;
 *  5. seam gates — broken DESIGN.md write flagged;
 *  6. agent/pre-step — engine-status watermark + iteration-gate row composed
 *     into the step messages (AC-7 "full mstar-gated session");
 *  7. v2 seam tools — mstar_sdd_workspace creates the SDD dir,
 *     mstar_iteration_gate evaluates the committed fixtures;
 *  8. bundledSkillDir — the Task 4 reviewer note: relative roots are
 *     cwd-anchored (launch cwd = package root), with the fixture proof and
 *     the shipped `./skills` default tied back to the bundle patch.
 *
 * AC-7/AC-8 evidence: this spec IS the "local install simulation boots a
 * full mstar-gated session" observable; the `dsh plugin --profile add`
 * CLI real-run outcome is documented in task-5-report.md.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import type { DispatchGateAdvisory, SeamLintAdvisory, SkillLintAdvisory, StatusGateAdvisory } from '../src/index.ts'
import { DshHostAdapter, readAgentFlow } from '../src/index.ts'
import { bootApp, seedHarness, v2Root, v2RootWithWorkflow, v2Snapshot, v2SnapshotWithPlans, v2WorkflowEntry, type BootResult } from './harness.ts'
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
/** The package root — the process cwd the test suite runs under. */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')

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
function run(ctx: BootResult['ctx'], name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId, name, arguments: args, signal })
}

/** FsTarget for a local-backend path. */
const target = (path: string): FsTarget => ({ targetKey: path as FsTarget['targetKey'], displayPath: path })

/** FsTarget for the canonical `{HARNESS_DIR}/status.json`. */
const statusTarget = (harnessDir: string): FsTarget => target(join(harnessDir, 'status.json'))

/** FsTarget for a SKILL.md under a skill root. */
const skillTarget = (root: string, name: string): FsTarget => target(join(root, name, 'SKILL.md'))

/** Seed a file at an absolute path (intermediate dirs created). */
async function seedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Collect status-gate advisory emits on the app context. */
function captureStatusAdvisories(ctx: BootResult['ctx']): StatusGateAdvisory[] {
  const seen: StatusGateAdvisory[] = []
  ctx.on('mstar/status-gate', (payload) => { seen.push(payload) })
  return seen
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

/** The snapshot plan row with a valid execution_lease (v3 lease home). */
const LEASE_PLAN = {
  id: 'e2e-lease-plan',
  title: 'E2E lease plan',
  status: 'InProgress',
  execution_lease: {
    holder: 'e2e-agent',
    claimed_at: '2026-08-08',
    worktree_path: '/dsh-e2e/lease-worktree',
    working_branch: 'feature/e2e-lease',
  },
}

/** Seed the v2 lease tree: v2 root + active workflow snapshot carrying the leased plan row. */
async function seedLeaseTree(harnessDir: string): Promise<void> {
  await seedHarness(harnessDir, {
    'status.json': v2RootWithWorkflow(),
    'workflows/wf-1/snapshot.json': v2SnapshotWithPlans('wf-1', [LEASE_PLAN]),
  })
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

/* ===========================================================================
 * 2. Status gate — invalid status.json write under hard mode
 * ========================================================================== */

describe('status gate — invalid status.json write (hard refusal evidence)', () => {
  it('hard mode + invalid on-disk status.json → repair-escape advisory (hardBlocked, repair), write delegates', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    await seedFile(join(app.harnessDir, 'status.json'), fixture('status/invalid.json'))
    const advisories = captureStatusAdvisories(app.ctx)

    const intent = await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    // The content-blind slot cannot deadlock the repairing write: the veto
    // signal is the ENFORCED verdict in the advisory (the write is allowed
    // as a repair with hardBlocked true — the hard-mode refusal evidence).
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('write')
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
    expect(violationCodes(advisories[0])).toContain('status.invalid-workflows')
  })

  it('host-hook refusal channel: beforeStatusWrite rejects the invalid fixture document', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    const result = await app.ctx.dshHostAdapter.beforeStatusWrite(
      join(app.harnessDir, 'status.json'),
      JSON.parse(fixture('status/invalid.json')),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('status.invalid-workflows')
  })

  it('valid status.json → silent pass (no advisory)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    await seedFile(join(app.harnessDir, 'status.json'), fixture('status/valid.json'))
    const advisories = captureStatusAdvisories(app.ctx)

    await app.ctx.waterfall('fs/write-intent', statusTarget(app.harnessDir), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })
})

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

  it('SDD assignment with a MATCHING lease → silent allow (the lease gate positive control)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    await seedLeaseTree(app.harnessDir)
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/sdd-lease-valid.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * 4. Lease gate — SDD dispatch against a mismatched execution_lease
 * ========================================================================== */

describe('lease gate — SDD dispatch lease violation', () => {
  it('mismatched Worktree path → advisory lease.dispatch.worktree-mismatch, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    await seedLeaseTree(app.harnessDir)
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/sdd-lease-mismatch.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('mismatched Worktree path under hard → deny with lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    await seedLeaseTree(app.harnessDir)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/sdd-lease-mismatch.md')), defaultAllow)

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
    await mkdir(harnessDir, { recursive: true })
    // Seeded BEFORE boot: the gate row is boot-cached (qc3 W-002). v3: the
    // catalog aggregates the selected workflow lifecycle (root v2
    // `workflows[]` → the workflow snapshot).
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('e2e-iter', 'iteration')]),
      'workflows/e2e-iter/snapshot.json': v2Snapshot('e2e-iter', {
        type: 'iteration',
        plans: [{ id: 'fixture-plan-1', title: 'Fixture plan', status: 'Todo', file: 'plans/fixture.md' }],
      }),
      'iterations/e2e-iter/delivery-compass.md': fixture('iteration/delivery-compass.md'),
    })
    const app = booted = await bootApp({ root, cordisYml: FIXTURE_CORDIS_YML })
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // ONE unified catalog row (watermark + iteration gate + workspace state).
    expect(decision.messages.length).toBe(inbox.length + 1)
    expect(decision.messages.slice(0, -1)).toEqual(inbox)

    const row = decision.messages.at(-1)
    expect(row?.role).toBe('user')
    expect(row?.source).toMatchObject({ kind: 'mstar-engine-status', form: 'catalog' })
    const source = row?.source
    if (source === undefined || source.kind !== 'mstar-engine-status') return

    // Watermark fields — AC-6 shape.
    expect(source.version).toBe(ENGINE_VERSION)
    expect(source.harnessDir).toBe(harnessDir)
    expect(source.enforcement).toEqual({ hard: false, source: 'none' })

    // Iteration phase-gate section: the boot-evaluated gate in the Task 1
    // tool result shape (transition / all_plans_done / ok / codes) over the
    // SELECTED workflow snapshot.
    expect(source.iteration).toMatchObject({
      iterationId: 'e2e-iter',
      statusPath: join(harnessDir, 'workflows/e2e-iter/snapshot.json'),
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
    expect(source.state).toMatchObject({
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
    expect(text).toContain('residuals: none open')
    expect(text).toContain('branch: dev-dsh → dev-dsh')
    expect(text).toContain('leases: none active')
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
    const result = await run(app.ctx, 'mstar_iteration_gate', {
      snapshot_path: join(FIXTURES, 'workflow', 'wf-1', 'snapshot.json'),
      compass_path: join(FIXTURES, 'iteration', 'delivery-compass.md'),
    })

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
 * 9. bundledSkillDir — relative root is cwd-anchored (Task 4 reviewer note)
 * ========================================================================== */

describe('bundledSkillDir — launch-cwd resolution (Task 4 reviewer note)', () => {
  it('the test launch cwd IS the package root — grounds the ./skills resolution finding', () => {
    expect(process.cwd()).toBe(PACKAGE_ROOT)
  })

  it('a relative bundledSkillDir resolves against the launch cwd (fixture proof)', async () => {
    // `./tests/fixtures/skills` is relative: skill-filesystem `join()` semantics
    // anchor it to process.cwd() (the package root), so the committed
    // fixture skill is discovered as a BUNDLED source. If the root were
    // anchored anywhere else (install dir, module dir), discovery would be
    // empty — the e2e proves the cwd anchoring the shipped `./skills`
    // default relies on.
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, bundledSkillDir: './tests/fixtures/skills' })
    const skills = await booted.ctx.skills.list()
    const good = skills.find((s) => s.name === 'good-skill')
    expect(good).toBeDefined()
    expect(good!.source).toBe('bundled')
    expect(good!.provider).toBe('mstar')
    // Missing-description skills are not discoverable (frontmatter contract).
    expect(skills.some((s) => s.name === 'broken-skill')).toBe(false)
  })

  it('the shipped bundle patch ships no bundledSkillDir config key — the plugin resolves its own packaged harness-skills mirror', () => {
    const patch = readFileSync(new URL('../bundle/cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).not.toContain('bundledSkillDir:')
  })

  it('the shipped default (./skills, no deployment keys) boots safely: engine-status watermark always appends', async () => {
    // Exactly the shipped patch config minus deployment keys: harnessDir
    // omitted (the plugin never probes from the launch cwd — without the
    // config the harness dir resolves per session workspace at event time;
    // this agent-less step has no workspace, so the watermark shows
    // `harness dir: none`), no enforcement (warn-only by construction),
    // bundledSkillDir ./skills.
    // The boot must settle and the advisory catalog must still append; the
    // resolved harness dir / enforcement / gate row are environment state,
    // so only the process-immutable watermark is asserted.
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, bundledSkillDir: './skills', harnessDir: null })
    expect(booted.ctx.dshHostAdapter).toBeInstanceOf(DshHostAdapter)

    const decision = await booted.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    const statusRow = decision.messages.find((m) => m.source.kind === 'mstar-engine-status')
    expect(statusRow).toBeDefined()
    const text = statusRow?.content[0]?.type === 'text' ? statusRow.content[0].text : ''
    expect(text).toContain('<mstar_engine_status>')
    expect(text).toContain(`mstar version: ${ENGINE_VERSION}`)
  })
})

/* ===========================================================================
 * 10. Agent-flow ledger — real settle verification (plan
 *     `20260811-panel-f4-timeliness` Task 1: the REAL registry emits
 *     tools/post-execute — the old "settle unavailable at dev time" gate is
 *     obsolete, replaced by the paired-settle assertion)
 * ========================================================================== */

describe('agent-flow — real settle pairing (real call through the composed registry)', () => {
  it('a real subagent call through the composed registry records a dispatch AND a paired settle (post-execute foreground completion)', async () => {
    booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, dispatchBinding: 'qc-specialist' })
    // v3 write-path precondition: the agent-flow writer appends only to an
    // ACTIVE workflow — seed the v2 tree (root status.json + one active
    // workflow) before the call.
    await seedHarness(booted.harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
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
