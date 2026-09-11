/**
 * Task 4 — dispatch hard gate: `tools/pre-execute` on the subagent delegation
 * tool.
 *
 * Harness approach: same real-composition boot as Task 3 — the dsh seam
 * packages resolve from the npm registry, and the
 * waterfall is simulated with the typed harness: the exact
 * `ctx.waterfall('tools/pre-execute', exec,
 * () => Promise.resolve({ kind: 'allow' }))` dispatch the real ToolRegistry
 * performs (core/tools index.ts, dsh-private 9451be2). Unlike the fs intent
 * slots (veto = throw), the tools/pre-execute refusal channel is the
 * PreToolDecision value: returning `{ kind: 'deny', reason }` WITHOUT calling
 * `next()` vetoes the call; calling `next()` delegates (allow).
 *
 * Parity: the gate reuses the SAME engine fns as the opencode consumer
 * (`packages/opencode/src/mstar.ts` `validateDispatchAssignment`) →
 * identical violation codes by construction; the matrix asserts the concrete
 * codes per case (acceptance: parity with the opencode validated field set).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { assignmentHeaderRegion } from '@mstar-harness/engine'
import { bootApp, seedHarness, v2Root, v2SnapshotWithPlans, v2WorkflowEntry, type BootResult } from './harness.ts'
import { updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import { planIdOf } from '../src/gates/dispatch.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** Fully valid writable Assignment (mirrors the opencode `completeAssignment`). */
const VALID_WRITABLE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/dsh-package-core

Do the thing, evidence-first.
`

/** Missing `Execute as` — the opencode consumer's first field-gate case. */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** Assignment-shaped but none of the three core fields and no branch form. */
const MISSING_ALL_CORE = `## Assignment

Do the thing.
`

/** Writable assignment with no branch form at all. */
const MISSING_BRANCH = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`

/** Writable assignment carrying BOTH branch forms. */
const MULTIPLE_BRANCH_FORMS = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x
**Branch policy**: direct on main — hotfix

Do the thing.
`

/** Create-form Working branch without `<base>`. */
const CREATE_WITHOUT_BASE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: create feature/y

Do the thing.
`

/** Read-only orientation role — no branch form is legitimate. */
const SCOUT_NO_BRANCH = `## Assignment

**Execute as**: scout
**Delegation**: n/a
**Task category**: deep

Survey the codebase, report only.
`

/** Existing-branch form on a default protected branch without an exception. */
const WORKING_BRANCH_MAIN = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

Do the thing.
`

/** `Branch policy: direct on main — <reason>` — the exception matches the gate branch. */
const DIRECT_ON_MAIN = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Branch policy**: direct on main — hotfix approved by user

Do the thing.
`

/** Self-recursion: the Assignment's `Execute as` equals the dispatcher's own role. */
const SELF_RECURSION = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** Hard flag in the Assignment HEADER plus a violation (branch form missing) to harden on. */
const HARD_HEADER_FLAG = `## Assignment

**Enforcement**: hard
**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`

/** Hard flag quoted in the TASK BODY must NOT harden.*/
const HARD_BODY_FLAG = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

## Task

Example: **Enforcement**: hard
`

/** Working branch on main with a BODY-QUOTED direct-on exception — the quoted exception must not nullify the protection.*/
const BODY_QUOTED_BRANCH_POLICY = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

## Task

The task body quotes an example header line:
**Branch policy**: direct on main — hotfix quoted in the body
`

/** A read-only header with BODY-QUOTED Working branch / Execute as examples — must not fire false denies.*/
const BODY_QUOTED_FIELDS = `## Assignment

**Execute as**: scout
**Delegation**: n/a
**Task category**: deep

## Task

The task body quotes example header lines:
**Working branch**: main
**Execute as**: fullstack-dev
`

/** Not an Assignment at all — must stay silent (no false positives). */
const GARBAGE_PROMPT = `This is not an assignment at all.

Just do some work.
`

/* ---------------------------------- helpers ---------------------------------- */

let seq = 0

/** One pending tool call in the registry pipeline shape (dsh-tools 9451be2). */
function toolExec(name: string, args: unknown, agent?: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent: agent as ToolExecution['agent'] }),
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

/* ---------------------------------- warn (default) mode ---------------------------------- */

describe('dispatch gate — warn (default) mode', () => {
  it('valid writable Assignment → allow, advisory with dispatch.anti-recursion.empty-binding (unset binding fails closed)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const anti = advisories[0]!.result.violations.find((v) => v.code === 'dispatch.anti-recursion.empty-binding')
    expect(anti).toBeDefined()
    expect(anti!.severity).toBe('critical')
  })

  it('missing Execute as → advisory with assignment.field.missing-execute-as, dispatch allowed', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('subagent')
    expect(advisories[0]!.role).toBe('')
    expect(advisories[0]!.hard).toBe(false)
    expect(violationCodes(advisories[0])).toContain('assignment.field.missing-execute-as')
  })

  it('missing branch form → advisory with assignment.field.branch-missing', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing')
  })

  it('multiple branch forms → advisory with assignment.field.branch-multiple', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MULTIPLE_BRANCH_FORMS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-multiple')
  })

  it('create-form without base → advisory with assignment.field.branch-missing-base', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(CREATE_WITHOUT_BASE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing-base')
  })

  it('read-only role (scout) without branch form → allow, advisory with dispatch.anti-recursion.empty-binding (no read-only carve-out)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('dispatch.anti-recursion.empty-binding')
    // Read-only roles still skip the branch gates — no branch-missing.
    expect(violationCodes(advisories[0])).not.toContain('assignment.field.branch-missing')
  })

  it('Working branch on main without exception → advisory with dispatch.default-branch.protected', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(WORKING_BRANCH_MAIN), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('dispatch.default-branch.protected')
  })

  it('well-formed Branch policy direct on main → allow, advisory with dispatch.anti-recursion.empty-binding (exception honored)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(DIRECT_ON_MAIN), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    // The direct-on exception is honored — no default-branch violation.
    expect(violationCodes(advisories[0])).not.toContain('dispatch.default-branch.protected')
    expect(violationCodes(advisories[0])).toContain('dispatch.anti-recursion.empty-binding')
  })

  it('anti-recursion: Assignment Execute as == configured dispatcher role → critical advisory', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'fullstack-dev' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const anti = advisories[0]!.result.violations.find((v) => v.code === 'dispatch.anti-recursion.self-type')
    expect(anti).toBeDefined()
    expect(anti!.severity).toBe('critical')
  })

  it('no configured binding → dispatch.anti-recursion.empty-binding fires, self-type does not (fail closed)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    // MISSING_BRANCH carries Execute as: fullstack-dev (a self-typed role when a
    // binding were configured) — without a binding the empty-binding violation
    // fires alongside the field gate; self-type cannot fire (no binding).
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing')
    expect(violationCodes(advisories[0])).toContain('dispatch.anti-recursion.empty-binding')
    expect(violationCodes(advisories[0])).not.toContain('dispatch.anti-recursion.self-type')
  })

  it('warn mode delegates to the remaining chain (a later decider owns the allow decision)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'ask', reason: 'human in the loop' })
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    expect(secondRan).toBe(true)
    expect(decision).toEqual({ kind: 'ask', reason: 'human in the loop' })
    expect(advisories).toHaveLength(1)
  })
})

/* ---------------------------------- hard mode ---------------------------------- */

describe('dispatch gate — hard mode (Config enforcement: hard)', () => {
  it('missing Execute as → PreToolDecision { kind: deny }, downstream never runs', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.missing-execute-as')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('anti-recursion self-type under hard → deny with the critical code', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'fullstack-dev' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.self-type')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical]')
  })

  it('valid Assignment under hard → allow (no violations → no veto)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('unset dispatchBinding under hard → deny with dispatch.anti-recursion.empty-binding (fail closed)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.empty-binding')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical]')
  })

  it("the Assignment's OWN **Enforcement**: hard header flag hardens without Config (opencode parity)", async () => {
    const app = booted = await bootApp()

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(HARD_HEADER_FLAG), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.branch-missing')
  })

  it('a body-quoted **Enforcement**: hard line does NOT harden (header region only)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(HARD_BODY_FLAG), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(false)
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing')
  })

  it('Config enforcement: soft rolls back an Assignment hard flag (local rollback, roadmap D2)', async () => {
    const app = booted = await bootApp({ enforcement: 'soft' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(HARD_HEADER_FLAG), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(false)
  })

  it('non-subagent tools are never gated (gate scope is the delegation tool only)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      toolExec('read_file', { path: '/tmp/note.md', prompt: MISSING_EXECUTE_AS }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- hostile inputs ---------------------------------- */

describe('dispatch gate — hostile inputs', () => {
  it('garbage (non-Assignment) prompt → silent allow (shape guard, no false positives)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(GARBAGE_PROMPT), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('empty prompt → silent allow', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(''), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('non-string prompt (schema-invalid payload) → inert allow, gate never crashes', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      toolExec('subagent', { description: 'probe', prompt: 42 }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
  })

  it('arguments not an object → inert allow, gate never crashes', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('subagent', 'not-an-object'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
  })
})

/* ---------------------------------- header-region scoping  ---------------------------------- */

describe('dispatch gate — header-region scoping ', () => {
  it('a body-quoted Branch policy direct-on exception cannot nullify the default-branch protection (fail-open fix)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_BRANCH_POLICY), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    // The header declares `Working branch: main`; the body-quoted exception
    // is invisible to the gate, so the protection fires.
    expect(violationCodes(advisories[0])).toContain('dispatch.default-branch.protected')
    expect(violationCodes(advisories[0])).not.toContain('assignment.field.branch-multiple')
  })

  it('the same body-quoted exception under Enforcement: hard → deny with dispatch.default-branch.protected', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_BRANCH_POLICY), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.default-branch.protected')
  })

  it('body-quoted Working branch / Execute as examples do not fire false hard-mode denies (fail-closed fix)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'fullstack-dev' })
    const advisories = captureAdvisories(app.ctx)

    // The HEADER is a valid read-only scout assignment — no branch form
    // obligation, no self-recursion. The body-quoted `Working branch: main`
    // / `Execute as: fullstack-dev` examples must not flip the verdict.
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_FIELDS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- parity ---------------------------------- */

describe('dispatch gate — parity with the opencode validated field set', () => {
  it('missing all core fields → exactly the opencode field-set codes', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'fullstack-dev' })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_ALL_CORE), defaultAllow)

    // Same engine fns as packages/opencode validateDispatchAssignment →
    // identical codes by construction; assert the concrete set here.
    expect(violationCodes(advisories[0]).sort()).toEqual([
      'assignment.field.branch-missing',
      'assignment.field.missing-delegation',
      'assignment.field.missing-execute-as',
      'assignment.field.missing-task-category',
    ])
    // Severities match the engine contract (critical only for anti-recursion).
    expect(advisories[0]!.result.violations.every((v) => v.severity === 'high')).toBe(true)
  })

  it('missing Execute as carries the legacy assignment.presence alias (engine alias parity)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    const violation = advisories[0]!.result.violations.find((v) => v.code === 'assignment.field.missing-execute-as')
    expect(violation?.aliases).toContain('assignment.presence.missing-execute-as')
  })

  it('$MSTAR_WORKING_BRANCH env fallback feeds the default-branch gate (opencode parity)', async () => {
    process.env.MSTAR_WORKING_BRANCH = 'main'
    try {
      const app = booted = await bootApp()
      const advisories = captureAdvisories(app.ctx)

      await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

      expect(violationCodes(advisories[0])).toContain('dispatch.default-branch.protected')
    } finally {
      delete process.env.MSTAR_WORKING_BRANCH
    }
  })
})

/* ---------------------------------- Task 4 reviewer carry-overs (Task 6) ---------------------------------- */

describe('dispatch gate — Task 4 reviewer carry-overs (explore / compass / degrade)', () => {
  /** Read-only orientation role (the reviewer note: only `scout` was fixture-covered). */
  const EXPLORE_NO_BRANCH = `## Assignment

**Execute as**: explore
**Delegation**: n/a
**Task category**: deep

Survey the codebase, report only.
`

  it('explore read-only role without branch form → allow, advisory with dispatch.anti-recursion.empty-binding (no read-only carve-out)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(EXPLORE_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('dispatch.anti-recursion.empty-binding')
    // Read-only roles still skip the branch + lease gates.
    expect(violationCodes(advisories[0])).not.toContain('assignment.field.branch-missing')
  })

  it('explore under Enforcement: hard → deny with dispatch.anti-recursion.empty-binding (read-only assignments carry no other vetoable violations)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(EXPLORE_NO_BRANCH), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.empty-binding')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('compass frontmatter Enforcement: hard (no Config/Assignment flag) → deny', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'iterations/v2.1.0/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.branch-missing')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('engine-failure degrade: allow + structured degraded advisory, never a silent pass ', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    // Any unexpected failure inside the gate (engine or payload access) must
    // degrade to allow in BOTH modes — a hard gate failure never hardens a
    // workflow that was soft (preExecuteListener catch; opencode parity). The
    // degrade is NOT masked as a pass: the plugin-owned advisory carries
    // `degraded: true` so hard deployments can detect a dead control.
    const broken: ToolExecution = {
      ...subagentExec(MISSING_EXECUTE_AS),
      get arguments() { throw new Error('boom: gate internals exploded') },
    }
    const decision = await app.ctx.waterfall('tools/pre-execute', broken, defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(secondRan).toBe(true) // next() was still invoked — chain integrity preserved
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.degraded).toBe(true)
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.tool).toBe('subagent')
    expect(advisories[0]!.result.ok).toBe(true)
  })

  it('a throwing advisory consumer is contained by the degrade path (emit failure cannot break the chain)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    app.ctx.on('mstar/dispatch-gate', () => { throw new Error('consumer boom') })
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const broken: ToolExecution = {
      ...subagentExec(MISSING_EXECUTE_AS),
      get arguments() { throw new Error('boom: gate internals exploded') },
    }
    const decision = await app.ctx.waterfall('tools/pre-execute', broken, defaultAllow)

    // The degraded emit failure degrades to a log — the chain still delegates.
    expect(decision).toEqual({ kind: 'allow' })
    expect(secondRan).toBe(true)
  })
})

describe('dispatch gate — Assignment header values written as markdown code spans', () => {
  const idOf = (assignment: string): string | undefined => planIdOf(assignmentHeaderRegion(assignment))

  it('a backticked Plan Path resolves the bare plan id (no trailing backtick)', () => {
    // Regression: the extractor kept the wrapping backticks, so `plan.md`
    // became `` plan.md` `` — the `.md` suffix test failed and the id was
    // carried into the ledger with the backtick, matching no registered plan.
    expect(idOf('**Plan Path**: `/x/plans/20260101-demo.md`')).toBe('20260101-demo')
  })

  it('a backticked SDD dir resolves the bare directory name', () => {
    expect(idOf('**SDD dir**: `/x/.mstar/sdd/20260101-demo`')).toBe('20260101-demo')
  })

  it('a backticked plan_id resolves verbatim', () => {
    expect(idOf('**plan_id**: `20260101-demo`')).toBe('20260101-demo')
  })

  it('unbackticked values are unchanged, and a multi-span value is left literal', () => {
    expect(idOf('**Plan Path**: /x/plans/20260101-demo.md')).toBe('20260101-demo')
    // Only ONE clean wrapping pair is stripped: a value that wraps several
    // spans has backticks inside, so it is left exactly as written.
    expect(idOf('**plan_id**: `/a`, `/b`')).toBe('`/a`, `/b`')
  })
})

/* ===========================================================================
 * D4 — session-bound lease attribution (two concurrent actives)
 * ========================================================================== */

const LEASE_PLAN_ID = '00000810-lease-attribution'
const LEASE_WORKTREE = '/srv/worktrees/lease-attribution'
const LEASE_BRANCH = 'feature/lease-attribution'
const LEASE_HOLDER = 'omp:iter-someone-else'

/** Fully valid SDD writable Assignment matching the seeded lease exactly. */
const SDD_LEASED = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Execution mode**: sdd
**Working branch**: ${LEASE_BRANCH}
**Worktree path**: ${LEASE_WORKTREE}
**Plan Path**: /proj/plans/${LEASE_PLAN_ID}.md

Do the thing, evidence-first.
`

/** The InProgress plan row + its execution_lease (held by ANOTHER agent). */
const LEASED_PLAN: Record<string, unknown> = {
  id: LEASE_PLAN_ID,
  title: 'leased plan',
  status: 'InProgress',
  execution_lease: {
    holder: LEASE_HOLDER,
    claimed_at: '2026-08-08',
    worktree_path: LEASE_WORKTREE,
    working_branch: LEASE_BRANCH,
  },
}

/** An agent carrying the durable session identity the binding store is keyed by. */
const sessionAgent = (sessionId: string, cwd: string): unknown =>
  ({ id: sessionId, session: { header: { id: sessionId, cwd } } })

describe('dispatch gate — D4 session-bound lease attribution (explicit selection never bypasses the no-steal check)', () => {
  /** Seed two actives: `wf-a` holds the leased plan row, `wf-b` holds none. */
  async function seedTwoActives(harnessDir: string): Promise<void> {
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2SnapshotWithPlans('wf-a', [LEASED_PLAN]),
      'workflows/wf-b/snapshot.json': v2SnapshotWithPlans('wf-b', []),
    })
  }

  it('the session pick selects WHICH snapshot is re-verified — an id that does not hold the plan row reports plan-not-found', async () => {
    const app = booted = await bootApp()
    await seedTwoActives(app.harnessDir)
    expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-b' }).kind).toBe('written')
    const advisories = captureAdvisories(app.ctx)

    // `sess-x` holds no lease (its id is not the lease holder and its cwd is
    // not the lease worktree), so the durable pick is the ONLY binding
    // evidence — and it names the lifecycle WITHOUT the plan row.
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_LEASED, sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('lease.dispatch.plan-not-found')
    expect(violationCodes(advisories[0])).not.toContain('lease.dispatch.holder-mismatch')
  })

  it('the bound lease is still no-steal checked — an explicit pick never bypasses holder-mismatch', async () => {
    const app = booted = await bootApp()
    await seedTwoActives(app.harnessDir)
    expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_LEASED, sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    const codes = violationCodes(advisories[0])
    expect(codes).toContain('lease.dispatch.holder-mismatch')
    expect(codes).not.toContain('lease.dispatch.plan-not-found')

    // The SAME session shape with the holder id passes the no-steal check —
    // the pick resolves the plan row and the lease verifies clean (worktree
    // and branch match the Assignment).
    const matching = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(SDD_LEASED, sessionAgent(LEASE_HOLDER, app.root)),
      defaultAllow,
    )
    expect(matching).toEqual({ kind: 'allow' })
    const lastCodes = violationCodes(advisories.at(-1))
    expect(lastCodes).not.toContain('lease.dispatch.holder-mismatch')
    expect(lastCodes).not.toContain('lease.dispatch.plan-not-found')
    expect(lastCodes).not.toContain('lease.dispatch.unverifiable')
  })
})
