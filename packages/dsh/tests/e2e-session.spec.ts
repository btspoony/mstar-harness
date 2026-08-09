/**
 * Task 5 — end-to-end integration test: a FULL mstar-gated session in one
 * composed dsh app (plan 20260808-dsh-seams-bundle).
 *
 * Boots the full-app fixture cordis.yml through the real Loader (dsh-skill +
 * dsh-tools functional peer stubs + the mstar plugin — the committed
 * `tests/fixtures/cordis.yml` replaces the inline row list), mounts the
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
import type { CallId, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DispatchGateAdvisory, SeamLintAdvisory, SkillLintAdvisory, StatusGateAdvisory } from '../src/index.ts'
import { DshHostAdapter } from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

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
const callId = 'e2e-session.spec' as CallId
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
    token: Symbol('dsh.tool.execution'),
  }
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
})

/** The last message of an enter decision (the appended rows when present). */
const lastMessage = (decision: { kind: 'enter'; messages: UserMessage[] }): UserMessage | undefined =>
  decision.messages.at(-1)

/** status.json with an InProgress plan carrying a valid execution_lease. */
const LEASE_STATUS = JSON.stringify({
  version: 1,
  updated_at: '2026-08-08',
  plans: [{
    id: 'e2e-lease-plan',
    title: 'E2E lease plan',
    status: 'InProgress',
    execution_lease: {
      holder: 'e2e-agent',
      claimed_at: '2026-08-08',
      worktree_path: '/dsh-e2e/lease-worktree',
      working_branch: 'feature/e2e-lease',
    },
  }],
  residual_findings: {},
  metadata: {},
})

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
      expect(booted.ctx.tools.lookup(name), name).toBeDefined()
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
    expect(violationCodes(advisories[0])).toContain('status.invalid-plans')
  })

  it('host-hook refusal channel: beforeStatusWrite rejects the invalid fixture document', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    const result = await app.ctx.dshHostAdapter.beforeStatusWrite(
      join(app.harnessDir, 'status.json'),
      JSON.parse(fixture('status/invalid.json')),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe('status.invalid-plans')
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
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/valid.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('read-only orientation Assignment → silent allow (no branch form needed)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
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
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': LEASE_STATUS })
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
    await seedHarness(app.harnessDir, { 'status.json': LEASE_STATUS })
    const advisories = captureDispatchAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(fixture('assignments/sdd-lease-mismatch.md')), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('mismatched Worktree path under hard → deny with lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML, enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': LEASE_STATUS })

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
    // Seeded BEFORE boot: the gate row is boot-cached (qc3 W-002).
    await seedHarness(harnessDir, {
      'status.json': fixture('status/valid.json'),
      'iterations/e2e-iter/delivery-compass.md': fixture('iteration/delivery-compass.md'),
    })
    const app = booted = await bootApp({ root, cordisYml: FIXTURE_CORDIS_YML })
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // engine-status + iteration-gate + harness-state rows.
    expect(decision.messages.length).toBe(inbox.length + 3)
    expect(decision.messages.slice(0, -3)).toEqual(inbox)

    // Engine-status row: the catalog watermark (unified mstar version,
    // harness dir, enforcement) — AC-6 shape.
    const statusRow = decision.messages.at(-3)
    expect(statusRow?.source).toMatchObject({ kind: 'mstar-engine-status', form: 'catalog' })
    const statusText = statusRow?.content[0]?.type === 'text' ? statusRow.content[0].text : ''
    expect(statusText).toContain('<mstar_engine_status>')
    expect(statusText).toContain('mstar version: 2.0.4')
    expect(statusText).toContain(`harness dir: ${harnessDir}`)
    expect(statusText).toContain('enforcement: soft') // no compass hardens, no Config override

    // Iteration-gate row: the boot-evaluated phase gate in the Task 1 tool
    // result shape (transition / all_plans_done / ok / codes).
    const gate = decision.messages.at(-2)
    expect(gate?.source).toMatchObject({
      kind: 'mstar-iteration-gate',
      form: 'catalog',
      iterationId: 'e2e-iter',
      statusPath: join(harnessDir, 'status.json'),
    })
    const source = gate?.source
    expect(source).toBeDefined()
    if (source === undefined) return
    expect(source.gate).toMatchObject({
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: false },
    })
    const gateText = gate?.content[0]?.type === 'text' ? gate.content[0].text : ''
    expect(gateText).toContain('<mstar_iteration_gate>')
    expect(gateText).toContain('iteration: e2e-iter')
    expect(gateText).toContain('transition: phase-2-execute')
    expect(gateText).toContain('gate: PASS')

    // Harness-state row: the workspace digest (plan registry, residuals,
    // branch anchors from status.json metadata + compass frontmatter
    // fallback — the fixture metadata is empty, so the compass fills base
    // and target).
    const state = decision.messages.at(-1)
    expect(state?.source).toMatchObject({ kind: 'mstar-harness-state', form: 'catalog' })
    const stateText = state?.content[0]?.type === 'text' ? state.content[0].text : ''
    expect(stateText).toContain('<mstar_harness_state>')
    expect(stateText).toContain('plans: fixture-plan-1(Todo)')
    expect(stateText).toContain('residuals: none open')
    expect(stateText).toContain('branch: dev-dsh → dev-dsh')
    expect(stateText).toContain('leases: none active')
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
    expect(existsSync(join(result.value.sdd_dir, '.gitignore'))).toBe(true)
    expect(result.content[0]!.text).toContain('sdd dir:')
  })

  it('mstar_iteration_gate evaluates the committed fixtures (PASS, phase-2-execute)', async () => {
    const app = booted = await bootApp({ cordisYml: FIXTURE_CORDIS_YML })
    const result = await run(app.ctx, 'mstar_iteration_gate', {
      status_path: join(FIXTURES, 'status', 'valid.json'),
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
    expect(result.content[0]!.text).toContain('PASS')
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
    // `./tests/fixtures/skills` is relative: skill-local `join()` semantics
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
    expect(text).toContain('mstar version: 2.0.4')
  })
})
