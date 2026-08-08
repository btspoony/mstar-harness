/**
 * Task 2 — iteration gate at agent/pre-step + worktree L1/L2 dispatch check
 * (plan 20260808-dsh-seams-bundle).
 *
 * Two seams under test:
 *
 * (a) agent/pre-step iteration gate — the existing engine-status catalog
 * listener ALSO appends one `mstar-iteration-gate` catalog row (engine
 * `evaluatePhaseGate` against the control-path status.json + the steering
 * delivery-compass.md; Task 1 tool result shape), cached at BOOT (qc3
 * W-002 discipline — no per-step disk I/O; a mid-session status/compass
 * change does not re-watermark until a config reload re-runs apply()).
 * Advisory contract: calls `next()`, never vetoes, never replaces the
 * delegated messages. No status.json + steering compass at boot → the row
 * is simply absent (the engine-status catalog still appends).
 *
 * (b) tools/pre-execute worktree checks — when the Assignment declares
 * parallel tracks (≥2 `Worktree path` header entries, or the documented
 * `Dispatch mode: parallel independent tracks` marker), the gate runs the
 * engine `l2PreDispatchCheck` over the declared tracks (absolute + distinct
 * paths, dir exists, `git branch --show-current` matches the Working
 * branch; duplicate/relative paths → `worktree.l2.*` violations); with
 * `metadata.control_worktree_path` + a plan `execution_lease` present, the
 * engine `l1PreDispatchCheck` verifies the control-vs-feature topology
 * (lease worktree MUST differ from the control worktree). Violations flow
 * through the existing enforcement path: advisory + allow (warn default),
 * PreToolDecision { kind: 'deny' } without `next()` under hard.
 *
 * Dev-time reality (brief): the llm/agent/tools seams are dev-time stubs, so
 * the waterfalls are simulated with the typed harness — the exact
 * `ctx.waterfall(...)` dispatches the real dsh loop/registry perform.
 * Branch probes run REAL `git -C <path> branch --show-current` against
 * fixture worktrees (engine parity — the engine probes are subprocess-based).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'

let booted: BootResult | undefined
const fixtureRoots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------ shared fixtures ------------------------------ */

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

/** status.json built from a plans[] array (harness VALID_STATUS base). */
function statusWithPlans(plans: unknown[], residuals: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, updated_at: '2026-08-08', plans, residual_findings: residuals, metadata: {} }
}

const PLAN_DONE = { id: 'fixture-plan-1', title: 'Fixture plan', status: 'Done', file: 'plans/fixture.md' }
const PLAN_TODO = { ...PLAN_DONE, status: 'Todo' }

/* ------------------------------ pre-step helpers ------------------------------ */

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
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

/** The second-to-last message (the engine-status row when the gate row is last). */
const secondLastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-2) : undefined

/** Seed a boot-time iteration state (status.json + steering compass) under root/harness. */
async function seedIteration(root: string, plans: unknown[], compass: string): Promise<void> {
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await seedHarness(harnessDir, {
    'status.json': JSON.stringify(statusWithPlans(plans)),
    'iterations/iter-20260808-wt/delivery-compass.md': compass,
  })
}

/* ------------------------------ dispatch helpers ------------------------------ */

let seq = 0

/** One pending tool call in the registry pipeline shape (dsh-tools 9451be2). */
function toolExec(name: string, args: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution'),
  }
}

/** The subagent tool call shape: `{ description, prompt, run_in_background? }`. */
const subagentExec = (prompt: string): ToolExecution => toolExec('subagent', { description: 'probe', prompt })

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/** Collect dispatch-gate advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const advisories: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { advisories.push(payload) })
  return advisories
}

const violationCodes = (advisory: DispatchGateAdvisory | undefined): string[] =>
  advisory?.result.violations.map((v) => v.code) ?? []

/** A writable Assignment header with the core fields (track lines are appended). */
const TRACK_ASSIGNMENT_HEADER = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
`

/** Build an Assignment with a set of extra header lines (track declarations). */
function trackAssignment(extraLines: string[]): string {
  return `${TRACK_ASSIGNMENT_HEADER}${extraLines.join('\n')}\n\nDo the thing, evidence-first.\n`
}

/* ------------------------------ git worktree fixtures ------------------------------ */

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  fixtureRoots.push(root)
  return root
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Create a temp git repo with an initial commit and one linked worktree per
 * branch via real `git worktree add` (L2 probe realism — the engine probes
 * `git -C <path> branch --show-current`). Returns branch → absolute path.
 */
function worktreeFixture(root: string, branches: readonly string[]): Map<string, string> {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(['init', '-q'], repo)
  git(['config', 'user.email', 'wt-l2-test@example.com'], repo)
  git(['config', 'user.name', 'Worktree L2 Test'], repo)
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'initial'], repo)
  const paths = new Map<string, string>()
  for (const branch of branches) {
    const path = join(root, `wt-${branch.replace(/\//g, '-')}`)
    git(['worktree', 'add', '-q', '-b', branch, path], repo)
    paths.set(branch, path)
  }
  return paths
}

/* ===========================================================================
 * (a) pre-step iteration gate — catalog composition
 * ========================================================================== */

describe('pre-step iteration gate — catalog composition (real Loader boot)', () => {
  it('boot with status.json + steering compass → pre-step appends the iteration-gate row after the engine-status row (Task 1 tool result shape)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wt-l2-gate-'))
    fixtureRoots.push(root)
    await seedIteration(root, [PLAN_TODO], COMPASS_ACTIVE)
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    // Advisory: the delegated decision wins — enter, with every inbox message preserved.
    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 2)
    expect(decision.kind === 'enter' && decision.messages.slice(0, -2)).toEqual(inbox)

    // Row order: engine-status first, iteration-gate appended after it.
    expect(secondLastMessage(decision)?.source).toMatchObject({ kind: 'mstar-engine-status' })
    const gate = lastMessage(decision)
    expect(gate?.role).toBe('user')
    expect(gate?.source).toMatchObject({
      kind: 'mstar-iteration-gate',
      form: 'catalog',
      iterationId: 'iter-20260808-wt',
      statusPath: join(app.harnessDir, 'status.json'),
      compassPath: join(app.harnessDir, 'iterations/iter-20260808-wt/delivery-compass.md'),
    })
    // The cached view reuses the Task 1 tool result shape (transition /
    // all_plans_done / ok / entry / exit / violations).
    const source = gate?.source
    expect(source).toBeDefined()
    if (source === undefined) return
    expect(source.gate).toMatchObject({
      transition: 'phase-2-execute',
      all_plans_done: false,
      ok: true,
      entry: { ok: false },
      exit: { ok: false },
      violations: [],
    })
    expect(source.gate.entry.violations.map((v) => v.code)).toContain('PLAN_NOT_DONE')
    // Boot-time evaluation passes NO git probes (documented in
    // iterationGateSource): the exit branch/base items are unverifiable.
    const exitCodes = source.gate.exit.violations.map((v) => v.code)
    expect(exitCodes).toContain('EXIT_BRANCH_UNVERIFIABLE')
    expect(exitCodes).toContain('EXIT_PR_BASE_UNVERIFIABLE')
    // The composed session log carries the model-facing gate line.
    expect(gate?.content[0]?.type).toBe('text')
    const text = gate?.content[0]?.type === 'text' ? gate.content[0].text : ''
    expect(text).toContain('<mstar_iteration_gate>')
    expect(text).toContain('iteration: iter-20260808-wt')
    expect(text).toContain('transition: phase-2-execute')
    expect(text).toContain('all plans done: false')
    expect(text).toContain('gate: PASS')
  })

  it('failing gate fixture → row renders FAIL with the violation codes (phase-3-close)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wt-l2-gate-fail-'))
    fixtureRoots.push(root)
    // All plans Done but the STEERING compass is still locked — the §3.5
    // close-exit checklist fails (status must be completed + end_date).
    await seedIteration(root, [PLAN_DONE], COMPASS_ACTIVE)
    const app = booted = await bootApp({ root })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const gate = lastMessage(decision)
    expect(gate?.source).toMatchObject({ kind: 'mstar-iteration-gate' })
    const source = gate?.source
    if (source === undefined) return
    expect(source.gate).toMatchObject({ transition: 'phase-3-close', all_plans_done: true, ok: false })
    const codes = source.gate.violations.map((v) => v.code)
    expect(codes).toContain('EXIT_STATUS_NOT_COMPLETED')
    const text = gate?.content[0]?.type === 'text' ? gate.content[0].text : ''
    expect(text).toContain('gate: FAIL')
    expect(text).toContain('EXIT_STATUS_NOT_COMPLETED')
  })

  it('next() delegation — the iteration row builds on the delegated decision (inbox preserved; later decider messages kept)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wt-l2-delegate-'))
    fixtureRoots.push(root)
    await seedIteration(root, [PLAN_TODO], COMPASS_ACTIVE)
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    // A later-mounted decider replaces the message set with its own enter
    // decision; the mstar listener must build on THAT.
    const replaced = [inboxMessage()]
    app.ctx.on('agent/pre-step', async (_payload, _next): Promise<PreStepDecision> => {
      return { kind: 'enter', messages: replaced }
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.slice(0, -2)).toEqual(replaced)
    expect(decision.kind === 'enter' && decision.messages.at(-1)?.source).toMatchObject({ kind: 'mstar-iteration-gate' })
  })

  it('aborted step → the delegated decision returns unchanged, no catalog rows (advisory never publishes on a blocked step)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wt-l2-abort-'))
    fixtureRoots.push(root)
    await seedIteration(root, [PLAN_TODO], COMPASS_ACTIVE)
    const app = booted = await bootApp({ root })
    const controller = new AbortController()
    controller.abort()

    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      { agent: {}, messages: [], turn: 1, step: 1, signal: controller.signal },
      defaultEnter([]),
    )

    // Narrowed abort race: an abort after delegation returns the delegated
    // decision unchanged; neither catalog row is appended.
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('process-stability (qc3 W-002): gate result cached at boot — seeding status/compass AFTER boot does not add the row, no per-step I/O', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]

    // Boot without iteration state → only the engine-status row.
    const before = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    expect(before.kind === 'enter' && before.messages.length).toBe(inbox.length + 1)
    expect(lastMessage(before)?.source).toMatchObject({ kind: 'mstar-engine-status' })

    // A compass + status.json appearing mid-session does NOT re-watermark:
    // the gate result is boot-resolved (no disk I/O on the agent-loop hot
    // path; the staleness clears on the next config reload → apply()).
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify(statusWithPlans([PLAN_TODO])),
      'iterations/iter-20260808-wt/delivery-compass.md': COMPASS_ACTIVE,
    })
    const after = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    expect(after.kind === 'enter' && after.messages.length).toBe(inbox.length + 1)
    expect(lastMessage(after)?.source).toMatchObject({ kind: 'mstar-engine-status' })
  })

  it('boot-time degrade — malformed status.json keeps the row absent while the engine-status catalog still appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-wt-l2-badstatus-'))
    fixtureRoots.push(root)
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': 'not json {{{',
      'iterations/iter-20260808-wt/delivery-compass.md': COMPASS_ACTIVE,
    })
    const app = booted = await bootApp({ root })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision.kind === 'enter' && decision.messages).toHaveLength(1)
    expect(lastMessage(decision)?.source).toMatchObject({ kind: 'mstar-engine-status' })
  })
})

/* ===========================================================================
 * (b) dispatch gate — worktree L2 parallel tracks + L1 control-vs-feature
 * ========================================================================== */

describe('dispatch gate — worktree L2 parallel tracks (warn default)', () => {
  it('two tracks sharing one worktreePath → advisory worktree.l2.track-path-collision, dispatch allowed', async () => {
    const root = tmpRoot('dsh-wt-l2-dupe-')
    const shared = join(root, 'wt-shared')
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      `**Worktree path**: ${shared}`,
      '**Working branch**: feature/a',
      `**Worktree path**: ${shared}`,
      '**Working branch**: feature/b',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('worktree.l2.track-path-collision')
    expect(violationCodes(advisories[0])).not.toContain('worktree.l1.lease-equals-control')
  })

  it('relative track worktreePath → advisory worktree.l2.track-path-relative', async () => {
    const root = tmpRoot('dsh-wt-l2-relative-')
    const absolute = join(root, 'wt-absolute')
    mkdirSync(absolute, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      '**Worktree path**: wt/relative-a',
      '**Working branch**: feature/a',
      `**Worktree path**: ${absolute}`,
      '**Working branch**: feature/b',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('worktree.l2.track-path-relative')
  })

  it('valid distinct absolute tracks on their branches → silent pass', async () => {
    const root = tmpRoot('dsh-wt-l2-valid-')
    const wts = worktreeFixture(root, ['feature/track-a', 'feature/track-b'])
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      `**Worktree path**: ${wts.get('feature/track-a')}`,
      '**Working branch**: feature/track-a',
      `**Worktree path**: ${wts.get('feature/track-b')}`,
      '**Working branch**: feature/track-b',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  }, 60_000)

  it('two tracks sharing ONE Working branch (same-branch multi-dir topology) → silent pass', async () => {
    const root = tmpRoot('dsh-wt-l2-sharedbranch-')
    const wts = worktreeFixture(root, ['feature/shared'])
    // Second checkout on the SAME branch — a git clone (git forbids the same
    // branch in two linked worktrees; the multi-dir topology uses clones).
    const clone = join(root, 'clone-shared')
    git(['clone', '-q', '-b', 'feature/shared', join(root, 'repo'), clone], root)
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    // One `Working branch` line applies to every track (mstar-branch-worktree
    // 同分支多目录例外) — no count-mismatch, both checkouts probe on the branch.
    const prompt = trackAssignment([
      `**Worktree path**: ${wts.get('feature/shared')}`,
      `**Worktree path**: ${clone}`,
      '**Working branch**: feature/shared',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  }, 60_000)

  it('track count mismatch (2 Worktree path vs 3 Working branch entries) → worktree.l2.track-count-mismatch', async () => {
    const root = tmpRoot('dsh-wt-l2-count-')
    const a = join(root, 'wt-a')
    mkdirSync(a, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      `**Worktree path**: ${a}`,
      '**Working branch**: feature/a',
      `**Worktree path**: ${join(root, 'wt-b')}`,
      '**Working branch**: feature/b',
      '**Working branch**: feature/c',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('worktree.l2.track-count-mismatch')
  })

  it('Dispatch mode: parallel independent tracks marker with a single track → L2 runs (valid track passes)', async () => {
    const root = tmpRoot('dsh-wt-l2-marker-')
    const wts = worktreeFixture(root, ['feature/marker-a'])
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      '**Dispatch mode**: parallel independent tracks',
      `**Worktree path**: ${wts.get('feature/marker-a')}`,
      '**Working branch**: feature/marker-a',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  }, 60_000)

  it('parallel marker with NO Worktree path → advisory worktree.l2.no-tracks (declared parallel, no isolation)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      '**Dispatch mode**: parallel independent tracks',
      '**Working branch**: feature/a',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('worktree.l2.no-tracks')
  })
})

describe('dispatch gate — worktree L2 hard mode', () => {
  it('duplicate track worktreePath under hard → PreToolDecision deny, downstream never runs', async () => {
    const root = tmpRoot('dsh-wt-l2-hard-')
    const shared = join(root, 'wt-shared')
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })
    const prompt = trackAssignment([
      `**Worktree path**: ${shared}`,
      '**Working branch**: feature/a',
      `**Worktree path**: ${shared}`,
      '**Working branch**: feature/b',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('worktree.l2.track-path-collision')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('relative track path under hard → deny with worktree.l2.track-path-relative', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const prompt = trackAssignment([
      '**Worktree path**: wt/relative-a',
      '**Working branch**: feature/a',
      `**Worktree path**: ${join(tmpRoot('dsh-wt-l2-hard-rel-'), 'wt-b')}`,
      '**Working branch**: feature/b',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('worktree.l2.track-path-relative')
  })
})

describe('dispatch gate — worktree L1 control-vs-feature (when metadata present)', () => {
  /** InProgress plan row with a valid execution_lease (lease-gate fixture shape). */
  const planWithLease = (worktree: string, branch: string): Record<string, unknown> => ({
    id: 'l1-plan',
    title: 'L1 fixture',
    status: 'InProgress',
    execution_lease: { holder: 'test-agent', claimed_at: '2026-08-08', worktree_path: worktree, working_branch: branch },
  })

  const statusWithControl = (control: string, plan: Record<string, unknown>): string =>
    JSON.stringify({
      version: 1,
      updated_at: '2026-08-08',
      plans: [plan],
      residual_findings: {},
      metadata: { control_worktree_path: control },
    })

  const l1Assignment = (worktree: string): string => `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: plans/l1-plan.md
**Worktree path**: ${worktree}
**Working branch**: feature/a

Do the thing, evidence-first.
`

  it('execution_lease.worktree_path equals metadata.control_worktree_path → advisory worktree.l1.lease-equals-control (critical)', async () => {
    const root = tmpRoot('dsh-wt-l1-eq-')
    const control = join(root, 'control')
    mkdirSync(control, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    await seedHarness(app.harnessDir, { 'status.json': statusWithControl(control, planWithLease(control, 'feature/a')) })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(l1Assignment(control)), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const codes = violationCodes(advisories[0])
    expect(codes).toContain('worktree.l1.lease-equals-control')
    const violation = advisories[0]!.result.violations.find((v) => v.code === 'worktree.l1.lease-equals-control')
    expect(violation?.severity).toBe('critical')
  })

  it('L1 control==feature under hard → deny with the critical code', async () => {
    const root = tmpRoot('dsh-wt-l1-hard-')
    const control = join(root, 'control')
    mkdirSync(control, { recursive: true })
    const app = booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(app.harnessDir, { 'status.json': statusWithControl(control, planWithLease(control, 'feature/a')) })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(l1Assignment(control)), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('worktree.l1.lease-equals-control')
  })

  it('metadata absent (no control path) → L1 silent, no worktree codes (only the lease gate may speak)', async () => {
    const root = tmpRoot('dsh-wt-l1-nometa-')
    const worktree = join(root, 'wt-a')
    mkdirSync(worktree, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    // metadata: {} — no control_worktree_path; the lease matches the assignment
    // exactly, so even the lease gate is silent.
    await seedHarness(app.harnessDir, {
      'status.json': JSON.stringify({
        version: 1,
        updated_at: '2026-08-08',
        plans: [planWithLease(worktree, 'feature/a')],
        residual_findings: {},
        metadata: {},
      }),
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(l1Assignment(worktree)), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

describe('dispatch gate — worktree hostile inputs + header-region scoping', () => {
  it('body-quoted Worktree path lines after ## Task do not form tracks (header-region discipline)', async () => {
    const root = tmpRoot('dsh-wt-l2-body-')
    const a = join(root, 'wt-a')
    mkdirSync(a, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    // ONE header track + a second track quoted in the task body — the body
    // entry must not pair into an L2 declaration (the engine header boundary
    // is the single grammar, qc1 F-001 / qc2 F-001).
    const prompt = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/a
**Worktree path**: ${a}

## Task

Quoted example of a parallel-track header:
**Worktree path**: ${join(root, 'wt-b')}
**Working branch**: feature/b
`

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('empty Worktree path value lines are dropped — a malformed entry does not fabricate a track', async () => {
    const root = tmpRoot('dsh-wt-l2-empty-')
    const a = join(root, 'wt-a')
    mkdirSync(a, { recursive: true })
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const prompt = trackAssignment([
      '**Worktree path**:',
      `**Worktree path**: ${a}`,
      '**Working branch**: feature/a',
    ])

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    // One non-empty entry → no parallel-track declaration → silent.
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('garbage non-Assignment prompt stays silent under hard (shape guard, no false positives)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec('This is not an assignment at all.\n\nJust do some work.\n'),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})
