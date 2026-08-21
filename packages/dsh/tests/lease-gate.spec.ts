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
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, v2RootWithWorkflow, v2SnapshotWithPlans, type BootResult } from './harness.ts'
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

/** SDD assignment resolving the plan via the `SDD dir` fallback (no Plan Path). */
const SDD_VIA_SDD_DIR = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**SDD dir**: /srv/sdd/${PLAN_ID}
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** Same, but the SDD dir basename is empty (`/`) — unresolvable plan id. */
const SDD_VIA_SDD_DIR_ROOT = SDD_VIA_SDD_DIR.replace(`/srv/sdd/${PLAN_ID}`, '/')

/** SDD assignment with a resolvable plan but NO Worktree path declaration. */
const SDD_NO_WORKTREE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Working branch**: ${BRANCH}

Do the thing, evidence-first.
`

/** The lease object stored under `plans[].execution_lease` (SSOT location). */
const VALID_LEASE = {
  holder: HOLDER,
  claimed_at: '2026-08-08',
  worktree_path: WORKTREE,
  working_branch: BRANCH,
}

/** Seed the v2 lease tree: v2 root + active workflow snapshot carrying one plan row (the v3 lease home). */
async function seedLeaseDoc(harnessDir: string, plan: Record<string, unknown>): Promise<void> {
  await seedHarness(harnessDir, {
    'status.json': v2RootWithWorkflow(),
    'workflows/wf-1/snapshot.json': v2SnapshotWithPlans('wf-1', [plan]),
  })
}

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
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
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
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
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
    await seedLeaseDoc(app.harnessDir, TODO_NO_LEASE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.verify.missing')
  })

  it('InProgress plan without lease (no Execution mode on the Assignment) → advisory lease.verify.orphan', async () => {
    const app = booted = await bootApp()
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(NO_MODE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.verify.orphan')
  })

  it('lease holder differs from the dispatching session → advisory lease.dispatch.holder-mismatch', async () => {
    const app = booted = await bootApp()
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
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
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_WRONG_WORKTREE), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('Assignment Working branch differs from the lease → advisory lease.dispatch.branch-mismatch', async () => {
    const app = booted = await bootApp()
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_WRONG_BRANCH), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.branch-mismatch')
  })

  it('plan id resolves from the SDD dir fallback (no Plan Path) → lease check runs against it', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_VIA_SDD_DIR, { id: HOLDER }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('SDD dir with an empty basename → unresolvable plan id, silent pass', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_VIA_SDD_DIR_ROOT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('SDD assignment without a Worktree path + valid lease → advisory lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp()
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_NO_WORKTREE, { id: HOLDER }), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('non-SDD assignment (inline) + plan not InProgress → no lease check, silent pass even with a lease present', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, { ...TODO_NO_LEASE, execution_lease: VALID_LEASE })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('non-SDD assignment (inline) + InProgress plan → lease check still fires (plan-status trigger)', async () => {
    const app = booted = await bootApp()
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.verify.orphan')
  })

  it('read-only role (scout) → lease gate skipped even for sdd + InProgress orphan', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_SDD), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('sdd Assignment without a resolvable plan id → no lease check, silent pass', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
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
    await seedLeaseDoc(app.harnessDir, { id: 'some-other-plan', title: 'x', status: 'Todo' })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.plan-not-found')
  })

  it('missing status.json + sdd → advisory lease.dispatch.unverifiable, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    // qc2 W-002: a missing status file is NOT a silent fail-open for sdd —
    // the execution_lease is unverifiable, so the claim-before-InProgress red
    // line surfaces an advisory (warn mode).
    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unverifiable')
  })

  it('missing status.json + non-SDD writable dispatch → still a silent pass (degrade-allow for inline)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    // Non-SDD dispatches carry no lease obligation; the degrade-allow is the
    // documented behavior for them (README Known Limitations).
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('missing status.json + sdd + Enforcement: hard → deny with lease.dispatch.unverifiable', async () => {
    const app = booted = await bootApp()
    let secondRan = false

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_HARD), async () => {
      secondRan = true
      return { kind: 'allow' }
    })

    // Under hard the unverifiable lease state is a vetoable violation, the
    // same enforcement path as the malformed-doc arm (lease.dispatch.unreadable).
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('lease.dispatch.unverifiable')
    expect(secondRan).toBe(false)
  })

})

/* ---------------------------------- Task 4 carry-over ---------------------------------- */

describe('dispatch gate — Assignment header-region scoping (qc1 F-001)', () => {
  /** Valid SDD header, then a `# Target` body quoting DIFFERENT field values. */
  const BODY_QUOTED_FIELDS = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

# Target

Do the thing. Quoted examples must never leak into header fields:
**Worktree path**: /srv/worktrees/other-package
**Plan Path**: /srv/plans/other.md
**Working branch**: feature/other-branch
`

  /** Header WITHOUT `Execution mode`; the body quotes an sdd mode line. */
  const BODY_QUOTED_MODE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

# Target

Do the thing. Quoted example must not trigger the lease gate:
**Execution mode**: sdd
`

  /** Header WITH `Execution mode: sdd` but NO plan-id field; the body quotes one. */
  const BODY_QUOTED_PLAN = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

# Target

Do the thing. Quoted example must not resolve a plan id:
**Plan Path**: /srv/plans/${PLAN_ID}.md
`

  it('body-quoted Worktree path / Plan Path / Working branch do not leak into the lease comparisons', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_WITH_LEASE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(BODY_QUOTED_FIELDS, { id: HOLDER }),
      defaultAllow,
    )

    // The header fields match the lease; the body-quoted mismatches must not
    // produce worktree/branch violations (engine header-region contract).
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('body-quoted Execution mode: sdd does not trigger the lease gate (header mode only)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, TODO_NO_LEASE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_MODE), defaultAllow)

    // Header has no Execution mode → not sdd; the Todo plan row is not
    // InProgress → no lease check. Before the fix the body-quoted mode made
    // this an sdd dispatch and lease.verify.missing fired.
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('body-quoted Plan Path does not resolve a plan id (unresolvable plan stays silent)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedLeaseDoc(app.harnessDir, IN_PROGRESS_ORPHAN)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_PLAN), defaultAllow)

    // planIdOf reads the header region only; with no header plan id the lease
    // gate degrades silently even though the body quotes the plan path.
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- Task 4 carry-over ---------------------------------- */

describe('dispatch gate — custom dispatchTools (Task 4 reviewer carry-over)', () => {
  it('renamed delegation tool in Config.dispatchTools is matched by the lease gate', async () => {
    const app = booted = await bootApp({ dispatchTools: ['delegate'] })
    await seedLeaseDoc(app.harnessDir, TODO_NO_LEASE)
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
    await seedLeaseDoc(app.harnessDir, TODO_NO_LEASE)
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
    await seedLeaseDoc(app.harnessDir, TODO_NO_LEASE)
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
