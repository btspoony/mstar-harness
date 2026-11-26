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
import { useCleanControlRoot, bootApp, seedActiveWorkflow, seedHarness, type BootResult } from './harness.ts'

useCleanControlRoot()
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
const SDD_ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
execution_mode: sdd
plan_path: /srv/plans/${PLAN_ID}.md
worktree_path: ${WORKTREE}
working_branch: ${BRANCH}
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`

/** Writable Assignment with NO `Execution mode` — plan-status trigger only. */
const INLINE_ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one focused implementer round
plan_path: /srv/plans/${PLAN_ID}.md
worktree_path: ${WORKTREE}
working_branch: ${BRANCH}
---

## Assignment

Do the thing.
`

/** SDD assignment resolving the plan id through the `SDD dir` fallback only. */
const SDD_VIA_SDD_DIR = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — one focused implementer round
execution_mode: sdd
sdd_dir: /srv/mstar/sdd/${PLAN_ID}
worktree_path: ${WORKTREE}
working_branch: ${BRANCH}
---

## Assignment

Do the thing.
`

/** SDD assignment that declares no Worktree path at all. */
const SDD_NO_WORKTREE = `---
execute_as: fullstack-dev
execution_mode: sdd
plan_path: /srv/plans/${PLAN_ID}.md
working_branch: ${BRANCH}
---

## Assignment

Do the thing.
`

/** SDD assignment with `Enforcement: hard` + an unrecorded row scope (violation to harden on). */
const SDD_HARD = `---
execute_as: fullstack-dev
execution_mode: sdd
enforcement: hard
plan_path: /srv/plans/${PLAN_ID}.md
worktree_path: ${WORKTREE}
working_branch: ${BRANCH}
---

## Assignment

Do the thing.
`

/** Read-only orientation role — the row-scope gate must not block read-only dispatch. */
const SCOUT_ASSIGNMENT = `---
execute_as: scout
delegation: forbidden
task_category: deep
task_budget: S — read-only orientation
execution_mode: sdd
plan_path: /srv/plans/${PLAN_ID}.md
worktree_path: ${WORKTREE}
---

## Assignment

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
  const activePlan = {
    ...plan,
    file: `plans/${String(plan.id)}.md`,
    ...(plan.metadata === ROW_SCOPE ? { metadata: { ...ROW_SCOPE, worktree_path: featurePath } } : {}),
  }
  await seedActiveWorkflow(
    harnessDir,
    'wf-1',
    [activePlan],
    {
      type: 'iteration',
      branch: { base: 'main', integration: 'integration/fixture' },
      integration_worktree_path: integrationPath,
    },
    'seed-wf-1',
    root,
  )
  await seedHarness(harnessDir, {
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
  }, agent ?? { id: 'project-manager', session: { header: {} } })

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

/* ------------------------------ D16 legacy body-label regression ------------------------------ */

describe('dispatch gate — the retired body-label grammar refuses at the lease surface too', () => {
  it('a body-label Assignment is refused with dispatch.assignment.legacy-format (the only legacy fixture)', async () => {
    // D16 regression — the ONE body-label fixture of this spec: a carrier
    // whose fields live in the retired `**Label**` grammar must reach the
    // legacy-format refusal on the lease-gate surface exactly as on every
    // other gate, never pass as a field-gate miss.
    const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Plan path**: /srv/plans/${PLAN_ID}.md
**Worktree path**: ${WORKTREE}
**Working branch**: ${BRANCH}

Do the thing.
`
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(LEGACY_BODY_LABEL), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('dispatch.assignment.legacy-format')
  })
})

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
  it('alternate create-form and direct-on branch spellings are compared with the row branch', async () => {
    // Explicit blank binding: each dispatch then carries exactly one advisory
    // (empty-binding), so the ABSENCE of branch-mismatch stays observable.
    const app = booted = await bootApp({ dispatchBinding: '' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)
    const createForm = SDD_ASSIGNMENT.replace(`working_branch: ${BRANCH}`, `working_branch: create ${BRANCH} from main`)
    const directOn = SDD_ASSIGNMENT.replace(
      `working_branch: ${BRANCH}`,
      `branch_policy: direct on ${BRANCH} — approved`,
    )

    await app.ctx.waterfall('tools/pre-execute', subagentExec(createForm), defaultAllow)
    await app.ctx.waterfall('tools/pre-execute', subagentExec(directOn), defaultAllow)

    expect(advisories).toHaveLength(2)
    expect(advisories.every((advisory) => !violationCodes(advisory).includes('lease.dispatch.branch-mismatch'))).toBe(true)
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
      subagentExec(SDD_ASSIGNMENT.replace(/^plan_path:.*\n/m, '')),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

describe('dispatch gate — hostile inputs', () => {
  // Disposition: malformed status.json is not an execution authority after the ACTIVE cutover; retain the surviving missing-row ACTIVE case below.

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

/* ===========================================================================
 * Malformed front matter at the lease gate (the shared entries API)
 * ========================================================================= */

describe('dispatch gate — lease isolation shapes', () => {
  it('an indented nested plan_path never reads as the root plan identity — the lease check does not fire', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)
    // A `plan_path` line indented under a parent key is a NESTED map entry,
    // never the root field: the local line reader treated it as a root key,
    // so the lease resolved a plan id the document never declared (here a
    // DIFFERENT plan — pre-fix it surfaced lease.dispatch.plan-not-found).
    const nested = SDD_ASSIGNMENT.replace(
      `plan_path: /srv/plans/${PLAN_ID}.md`,
      'phase_gate_checklist:\n  plan_path: /srv/plans/nested-other-plan.md',
    )

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(nested), defaultAllow)


    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).not.toContain('lease.dispatch.plan-not-found')
    expect(violationCodes(advisories[0]).filter((code) => code.startsWith('lease.dispatch.'))).toEqual([])
  })

  it('duplicate plan_path keys refuse as document.frontmatter.invalid instead of silently pairing the first', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)
    const duplicated = SDD_ASSIGNMENT.replace(
      `plan_path: /srv/plans/${PLAN_ID}.md`,
      `plan_path: /srv/plans/${PLAN_ID}.md\nplan_path: /srv/plans/another-plan.md`,
    )

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(duplicated), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('document.frontmatter.invalid')
    // The whole block is refused: the lease never re-verifies a malformed document.
    // The retired duplicate grammar read the FIRST key — the row's own — so pre-fix
    // this dispatch verified clean and emitted NO advisory at all (silent pass).
    expect(advisories).toHaveLength(1)
  })

  it('an unterminated fence declares nothing at the lease gate — schema refusal only', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    await seedRowDoc(app.harnessDir, IN_PROGRESS_WITH_SCOPE)
    const advisories = captureAdvisories(app.ctx)
    // The opening fence never closes (the closing --- line is dropped): every
    // field line below is inert, so the lease must not re-verify anything.
    const unterminated = SDD_ASSIGNMENT.replace(/\n---\n\n## Assignment/, '\n\n## Assignment')

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(unterminated), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('document.frontmatter.absent')
    expect(violationCodes(advisories[0]).filter((code) => code.startsWith('lease.dispatch.'))).toEqual([])
  })
})
