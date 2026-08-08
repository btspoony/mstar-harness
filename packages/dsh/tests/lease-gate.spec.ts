/**
 * Task 5 — lease gate: `verifyPlanExecutionLease` on dispatch (plan
 * 20260808-dsh-package-core).
 *
 * Extends the Task 4 dispatch gate: when the Assignment declares
 * `Execution mode: sdd` (engine `executionModeToN` semantics — sdd maps to
 * N=3) OR the plan's status.json row is `InProgress`, the gate verifies the
 * plan's `execution_lease` (engine `verifyPlanExecutionLease` +
 * `validateExecutionLease`) and cross-checks the lease against the dispatch
 * context (holder vs the dispatching session's agent id; worktree_path vs
 * the Assignment's `Worktree path`; working_branch vs the Assignment's
 * branch forms) — the status-and-residuals.md § Pre-dispatch re-verify
 * contract ("confirm this session still passes verify-held-lease; mismatch
 * or absent lease → STOP — do not dispatch").
 *
 * Parity note (brief): opencode's `validateDispatchAssignment` does NOT run
 * lease checks at dispatch — the lease gate is an additive dsh check,
 * clearly scoped to SDD/InProgress writable dispatches; the opencode parity
 * field set (Task 4 codes) is untouched.
 *
 * Harness approach: same real-composition boot as Tasks 3–4 — status.json is
 * seeded under the harness dir and the `tools/pre-execute` waterfall is
 * simulated with the typed harness (`ctx.waterfall('tools/pre-execute', exec,
 * () => Promise.resolve({ kind: 'allow' }))`).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

const PLAN_ID = '20260808-dsh-package-core'
const WORKTREE = '/srv/worktrees/mstar-dsh-package'
const BRANCH = 'feature/dsh-package-core'
const HOLDER = 'omp-session-lease-holder'

/** Fully valid SDD writable Assignment (all fields the lease gate needs). */
const SDD_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** Writable Assignment with NO `Execution mode` — plan-status trigger only. */
const NO_MODE_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** Non-SDD writable Assignment (inline mode). */
const INLINE_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: inline
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** SDD assignment with a mismatched worktree declaration. */
const SDD_WRONG_WORKTREE = SDD_ASSIGNMENT.replace(WORKTREE, '/srv/worktrees/other-package')

/** SDD assignment with a mismatched working branch. */
const SDD_WRONG_BRANCH = SDD_ASSIGNMENT.replace(BRANCH, 'feature/other-branch')

/** SDD assignment with no `Plan Path` / `SDD dir` / `plan_id` — unresolvable plan. */
const SDD_NO_PLAN = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** SDD assignment with `Enforcement: hard` + missing lease (violation to harden on). */
const SDD_HARD = `## Assignment

**Enforcement**: hard
**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** Read-only orientation role — lease gate must not block read-only dispatch. */
const SCOUT_SDD = `## Assignment

**Execute as**: scout
**Delegation**: n/a
**Task category**: deep
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md

Survey the codebase, report only.
`

/** The lease object stored under `plans[].execution_lease` (SSOT location). */
const VALID_LEASE = {
  holder: HOLDER,
  claimed_at: '2026-08-08',
  worktree_path: WORKTREE,
  working_branch: BRANCH,
}

const statusDoc = (plan: Record<string, unknown>): string =>
  JSON.stringify({
    version: 1,
    updated_at: '2026-08-08',
    plans: [plan],
    residual_findings: {},
    metadata: {},
  })

/** InProgress plan row with a valid lease. */
const IN_PROGRESS_WITH_LEASE: Record<string, unknown> = {
  id: PLAN_ID,
  title: 'dsh package core',
  status: 'InProgress',
  execution_lease: VALID_LEASE,
}

/** Todo plan row — no lease, not in flight. */
const TODO_NO_LEASE: Record<string, unknown> = {
  id: PLAN_ID,
  title: 'dsh package core',
  status: 'Todo',
}

/** InProgress plan row WITHOUT a lease — orphan. */
const IN_PROGRESS_ORPHAN: Record<string, unknown> = {
  id: PLAN_ID,
  title: 'dsh package core',
  status: 'InProgress',
}

/* ---------------------------------- helpers ---------------------------------- */

let seq = 0

/** One pending tool call in the registry pipeline shape (dsh-tools 9451be2). */
function toolExec(name: string, args: unknown, agent?: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution'),
  }
}

/** The subagent tool call shape: `{ description, prompt, run_in_background? }`. */
const subagentExec = (prompt: string, agent?: unknown): ToolExecution =>
  toolExec('subagent', { description: 'probe', prompt }, agent)

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

/* ---------------------------------- lease matrix ---------------------------------- */

describe('dispatch gate — lease matrix (sdd / InProgress)', () => {
  it('SDD dispatch + InProgress plan + valid lease (holder/worktree/branch match) → allow, silent pass', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_WITH_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_ASSIGNMENT, { id: HOLDER }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('SDD assignment with no lease (plan Todo) → advisory lease.verify.missing, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(TODO_NO_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.verify.missing')
  })

  it('InProgress plan without lease (no Execution mode on the Assignment) → advisory lease.verify.orphan', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(NO_MODE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.verify.orphan')
  })

  it('lease holder differs from the dispatching session → advisory lease.dispatch.holder-mismatch', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_WITH_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_ASSIGNMENT, { id: 'omp-session-someone-else' }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.holder-mismatch')
  })

  it('Assignment Worktree path differs from the lease → advisory lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_WITH_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_WRONG_WORKTREE), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('Assignment Working branch differs from the lease → advisory lease.dispatch.branch-mismatch', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_WITH_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_WRONG_BRANCH), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.branch-mismatch')
  })

  it('non-SDD assignment (inline) + plan not InProgress → no lease check, silent pass even with a lease present', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc({ ...TODO_NO_LEASE, execution_lease: VALID_LEASE }) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('non-SDD assignment (inline) + InProgress plan → lease check still fires (plan-status trigger)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.verify.orphan')
  })

  it('read-only role (scout) → lease gate skipped even for sdd + InProgress orphan', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_SDD), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('sdd Assignment without a resolvable plan id → no lease check, silent pass', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_NO_PLAN), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- hostile inputs ---------------------------------- */

describe('dispatch gate — lease hostile inputs', () => {
  it('malformed status.json + sdd → advisory lease.dispatch.unreadable (warn), no crash', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': '{ not json' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unreadable')
  })

  it('sdd Assignment with the plan row missing from status.json → advisory lease.dispatch.plan-not-found', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc({ id: 'some-other-plan', title: 'x', status: 'Todo' }) })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.plan-not-found')
  })

  it('missing status.json + sdd → no lease state to verify, silent pass (degrade-allow)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

})

/* ---------------------------------- Task 4 carry-over ---------------------------------- */

describe('dispatch gate — custom dispatchTools (Task 4 reviewer carry-over)', () => {
  it('renamed delegation tool in Config.dispatchTools is matched by the lease gate', async () => {
    const app = booted = await bootApp({ dispatchTools: ['delegate'] })
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(TODO_NO_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall(
      'tools/pre-execute',
      toolExec('delegate', { description: 'probe', prompt: SDD_ASSIGNMENT }),
      defaultAllow,
    )

    expect(violationCodes(advisories[0])).toContain('lease.verify.missing')
  })

  it('default-tool exec is inert when the deployment renamed the tool', async () => {
    const app = booted = await bootApp({ dispatchTools: ['delegate'] })
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(TODO_NO_LEASE) })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- hard mode ---------------------------------- */

describe('dispatch gate — lease hard mode', () => {
  it('sdd + missing lease + Enforcement: hard → deny without next() (short-circuit)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': statusDoc(TODO_NO_LEASE) })
    let secondRan = false

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_HARD), async () => {
      secondRan = true
      return { kind: 'allow' }
    })

    expect(decision).toMatchObject({ kind: 'deny' })
    expect(decision.kind === 'deny' && decision.reason).toContain('lease.verify.missing')
    expect(secondRan).toBe(false)
  })
})
