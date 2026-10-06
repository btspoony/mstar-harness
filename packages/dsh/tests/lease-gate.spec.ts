/**
 * Dispatch gate — the row-scope gate on writable dispatch.
 *
 * When the Assignment declares `Execution mode: sdd` (engine
 * `executionModeToN` semantics — sdd maps to N=3) OR the plan's status.json
 * row is `InProgress`, the gate re-reads the plan row's own recorded scope
 * (`metadata.worktree_path` / `metadata.working_branch`) and cross-checks it
 * against the dispatch context (`Worktree path` vs the row's worktree; the
 * Assignment's branch forms vs the row's working branch) — the
 * status-and-residuals.md § Pre-dispatch re-verify contract ("mismatch or an
 * unrecorded row scope → STOP — do not dispatch").
 *
 * Parity note (brief): opencode's `validateDispatchAssignment` does NOT run
 * row-scope checks at dispatch — this gate is an additive dsh check, clearly
 * scoped to SDD/InProgress writable dispatches; the opencode parity field set
 * (Task 4 codes) is untouched.
 *
 * Harness approach: same real-composition boot as Tasks 3–4 — status.json is
 * seeded under the harness dir and the `tools/pre-execute` waterfall is
 * simulated with the typed harness (`ctx.waterfall('tools/pre-execute', exec,
 * () => Promise.resolve({ kind: 'allow' }))`).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, v2Root, v2WorkflowEntry, v2SnapshotWithPlans, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

const PLAN_ID = '00000808-dsh-package-core'
const WORKTREE = '/srv/worktrees/mstar-dsh-package'
const BRANCH = 'feature/dsh-package-core'

/** Fully valid SDD writable Assignment (all fields the row-scope gate needs). */
const SDD_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`

/** Writable Assignment with NO `Execution mode` — plan-status trigger only. */
const INLINE_ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Task budget (implement / ops rounds)**: S — one focused implementer round
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing.
`

/** SDD assignment resolving the plan id through the `SDD dir` fallback only. */
const SDD_VIA_SDD_DIR = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Task budget (implement / ops rounds)**: S — one focused implementer round
**Execution mode**: sdd
**SDD dir**: /srv/mstar/sdd/${PLAN_ID}
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing.
`

/** SDD assignment that declares no Worktree path at all. */
const SDD_NO_WORKTREE = `## Assignment

**Execute as**: fullstack-dev
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Working branch**: ${BRANCH}

Do the thing.
`

/** SDD assignment with `Enforcement: hard` + an unrecorded row scope (violation to harden on). */
const SDD_HARD = `## Assignment

**Execute as**: fullstack-dev
**Execution mode**: sdd
**Enforcement**: hard
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing.
`

/** Read-only orientation role — the row-scope gate must not block read-only dispatch. */
const SCOUT_ASSIGNMENT = `## Assignment

**Execute as**: scout
**Delegation**: forbidden
**Task category**: deep
**Task budget (implement / ops rounds)**: S — read-only orientation
**Execution mode**: sdd
**Plan Path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}

Read only.
`

/** The row's recorded scope (`metadata.worktree_path` / `metadata.working_branch`). */
const ROW_SCOPE = { worktree_path: WORKTREE, working_branch: BRANCH }

/** Seed the v2 tree: v2 root + active workflow snapshot carrying one plan row. */
async function seedRowDoc(harnessDir: string, plan: Record<string, unknown>): Promise<void> {
  // Scope-bearing rows need real checkouts, not absolute-looking placeholders.
  const root = booted!.root
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const integrationPath = join(root, 'integration-checkout')
  const featurePath = join(root, 'feature-checkout')
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'integration/fixture', integrationPath])
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', BRANCH, featurePath])
  const snapshot = v2SnapshotWithPlans('wf-1', [{
    ...plan,
    file: `plans/${String(plan.id)}.md`,
    ...(plan.metadata === ROW_SCOPE ? { metadata: { ...ROW_SCOPE, worktree_path: featurePath } } : {}),
  }], {
    type: 'iteration',
    branch: { base: 'main', integration: 'integration/fixture' },
    integration_worktree_path: integrationPath,
  })
  await seedHarness(harnessDir, {
    'status.json': v2Root([v2WorkflowEntry('wf-1', 'iteration')]),
    'workflows/wf-1/snapshot.json': snapshot,
    [`plans/${String(plan.id)}.md`]: `# ${String(plan.id)}\n`,
  })
}

/** InProgress plan row with its scope recorded. */
const IN_PROGRESS_WITH_SCOPE: Record<string, unknown> = {
  id: PLAN_ID,
  title: 'dsh package core',
  status: 'InProgress',
  metadata: ROW_SCOPE,
}

/** Todo plan row — no scope recorded, not in flight. */
const TODO_NO_SCOPE: Record<string, unknown> = {
  id: PLAN_ID,
  title: 'dsh package core',
  status: 'Todo',
}

/** InProgress plan row with no recorded scope. */
const IN_PROGRESS_NO_SCOPE: Record<string, unknown> = {
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
  toolExec('subagent', {
    description: 'probe',
    prompt: prompt
      .replaceAll(WORKTREE, join(booted!.root, 'feature-checkout'))
      .replaceAll('/srv/plans', join(booted!.harnessDir, 'plans'))
      .replaceAll('/srv/mstar/sdd', join(booted!.harnessDir, 'sdd')),
  }, agent)

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

/* ---------------------------------- scope matrix ---------------------------------- */

describe('dispatch gate — row-scope matrix (sdd / InProgress)', () => {
  it('SDD dispatch + InProgress plan + recorded scope (worktree/branch match) → allow, silent pass', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('SDD dispatch + Todo row without recorded scope → advisory lease.dispatch.unverifiable, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, TODO_NO_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unverifiable')
  })

  it('InProgress plan with no recorded scope → advisory lease.dispatch.unverifiable', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, IN_PROGRESS_NO_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unverifiable')
  })

  it('Assignment Worktree path differs from the row scope → advisory lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const mismatched = SDD_ASSIGNMENT.replace(WORKTREE, '/srv/worktrees/other-checkout')
    await app.ctx.waterfall('tools/pre-execute', subagentExec(mismatched), defaultAllow)

    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('Assignment Working branch differs from the row scope → advisory lease.dispatch.branch-mismatch', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const mismatched = SDD_ASSIGNMENT.replace(BRANCH, 'feature/somewhere-else')
    await app.ctx.waterfall('tools/pre-execute', subagentExec(mismatched), defaultAllow)

    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.branch-mismatch')
  })

  it('plan id resolves from the SDD dir fallback (no Plan Path) → the check runs against it', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_VIA_SDD_DIR), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('SDD assignment without a Worktree path + recorded row scope → advisory lease.dispatch.worktree-mismatch', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_NO_WORKTREE), defaultAllow)

    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.worktree-mismatch')
  })

  it('non-SDD assignment (inline) + plan not InProgress → no check, silent pass even with a scope recorded', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, { ...TODO_NO_SCOPE, metadata: ROW_SCOPE })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('non-SDD assignment (inline) + InProgress plan → the check still fires (plan-status trigger)', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, IN_PROGRESS_NO_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(INLINE_ASSIGNMENT), defaultAllow)

    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unverifiable')
  })

  it('read-only role (scout) → the gate is skipped even for sdd + an InProgress row', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_NO_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('sdd Assignment without a resolvable plan id → no check, silent pass', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_NO_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_ASSIGNMENT.replace(/^\*\*Plan Path\*\*:.*\n/m, '')),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

describe('dispatch gate — hostile inputs', () => {
  it('malformed status.json + sdd → advisory lease.dispatch.unreadable (warn), no crash', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, { 'status.json': '{ not json' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unreadable')
  })

  it('sdd Assignment with the plan row missing from the snapshot → advisory lease.dispatch.plan-not-found', async () => {
    const app = booted = await bootApp()
    await seedRowDoc(app.harnessDir, { ...IN_PROGRESS_WITH_SCOPE, id: 'some-other-plan' })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(violationCodes(advisories[0])).toContain('lease.dispatch.plan-not-found')
  })

  it('missing status.json + sdd → advisory lease.dispatch.unverifiable, dispatch allowed (warn default)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_ASSIGNMENT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.unverifiable')
  })

  it('missing status.json + sdd + Enforcement: hard → deny with lease.dispatch.unverifiable', async () => {
    const app = booted = await bootApp()

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SDD_HARD), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('lease.dispatch.unverifiable')
  })
})

describe('dispatch gate — header scoping', () => {
  it('body-quoted Worktree path / Plan Path / Working branch do not leak into the comparisons', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const quoted = `${SDD_ASSIGNMENT}
## Task

Do the thing. Quoted example must not trigger the gate:
**Worktree path**: /srv/worktrees/somewhere-else
**Working branch**: feature/somewhere-else
`
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(quoted), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    // The header fields match the row scope; the body-quoted mismatches must not be read.
    expect(violationCodes(advisories[0])).not.toContain('lease.dispatch.worktree-mismatch')
    expect(violationCodes(advisories[0])).not.toContain('lease.dispatch.branch-mismatch')
  })
})
