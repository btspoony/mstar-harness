/**
 * Task 4 — dispatch hard gate: `tools/pre-execute` on the subagent delegation
 * tool (plan 20260808-dsh-package-core).
 *
 * Harness approach: same real-composition boot as Task 3 — the dsh seam
 * packages are dev-time peer-stubs (no runtime), so the waterfall is simulated
 * with the typed harness: the exact `ctx.waterfall('tools/pre-execute', exec,
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
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'

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

/** Hard flag quoted in the TASK BODY must NOT harden (qc1 F-003 / qc2 F-003). */
const HARD_BODY_FLAG = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

## Task

Example: **Enforcement**: hard
`

/** Working branch on main with a BODY-QUOTED direct-on exception — the quoted exception must not nullify the protection (qc2 F-001). */
const BODY_QUOTED_BRANCH_POLICY = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: main

## Task

The task body quotes an example header line:
**Branch policy**: direct on main — hotfix quoted in the body
`

/** A read-only header with BODY-QUOTED Working branch / Execute as examples — must not fire false denies (qc2 F-001). */
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

/* ---------------------------------- warn (default) mode ---------------------------------- */

describe('dispatch gate — warn (default) mode', () => {
  it('valid writable Assignment → allow, silent pass (no advisory)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
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

  it('read-only role (scout) without branch form → pass, silent (branch gates skipped)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SCOUT_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('Working branch on main without exception → advisory with dispatch.default-branch.protected', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(WORKING_BRANCH_MAIN), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('dispatch.default-branch.protected')
  })

  it('well-formed Branch policy direct on main → pass, silent (exception honored)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(DIRECT_ON_MAIN), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
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

  it('no configured binding → anti-recursion precheck skipped (empty binding is not self-recursion)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    // MISSING_BRANCH carries Execute as: fullstack-dev (a self-typed role when a
    // binding were configured) — without a binding only the field gate fires.
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing')
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
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
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

/* ---------------------------------- header-region scoping (qc2 F-001) ---------------------------------- */

describe('dispatch gate — header-region scoping (qc2 F-001)', () => {
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

  it('explore read-only role without branch form → silent pass (branch + lease gates skipped)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(EXPLORE_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('explore under Enforcement: hard → allow (read-only assignments carry no vetoable violations)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(EXPLORE_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
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

  it('engine-failure degrade: allow + structured degraded advisory, never a silent pass (qc2 W-003)', async () => {
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
