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
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { assignmentHeaderRegion } from '@mstar-harness/engine'
import { foldedFamilyToolName, getCommandDefinitions, isCoordinatorSeatCommand } from '@mstar-harness/commands'
import { useCleanControlRoot, bootApp, seedActiveWorkflow, seedHarness, type BootResult } from './harness.ts'

useCleanControlRoot()
import * as entry from '../src/index.ts'
import { updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import { DISPATCH_LOGGER } from '../src/gates/dispatch.ts'
import { planIdOf } from '../src/gates/dispatch-assignment.ts'
import { readAgentFlow } from '../src/gates/agent-flow.ts'
import { dispatchCallerOf } from '../src/gates/dispatch-core.ts'
import { preExecuteListener } from '../src/gates/dispatch-listener.ts'
import { DshHostAdapter } from '../src/gates/adapter.ts'
import { HarnessResolver, ROOT_SESSION_DISPATCH_BINDING, type Config } from '../src/gates/_shared.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** Fully valid writable Assignment (mirrors the opencode `completeAssignment`). */
const VALID_WRITABLE = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/dsh-package-core
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`

/** Missing `Execute as` — the opencode consumer's first field-gate case. */
const MISSING_EXECUTE_AS = `---
delegation: forbidden
task_category: logic
working_branch: feature/x
---

## Assignment

Do the thing.
`

/** Assignment-shaped but none of the three core fields and no branch form:
 * the core keys are present-but-empty (the shape `validateAssignmentFields`
 * flags), so the document is Assignment-shaped AND missing all of them. */
const MISSING_ALL_CORE = `---
execute_as:
delegation:
task_category:
---

## Assignment

Do the thing.
`

/** Writable assignment with no branch form at all. */
const MISSING_BRANCH = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
---

## Assignment

Do the thing.
`

/** Writable assignment carrying BOTH branch forms. */
const MULTIPLE_BRANCH_FORMS = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/x
branch_policy: direct on main — hotfix
---

## Assignment

Do the thing.
`

/** Create-form Working branch without `<base>`. */
const CREATE_WITHOUT_BASE = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: create feature/y
---

## Assignment

Do the thing.
`

/** Read-only orientation role — no branch form is legitimate. */
const SCOUT_NO_BRANCH = `---
execute_as: scout
delegation: n/a
task_category: deep
---

## Assignment

Survey the codebase, report only.
`

/** Existing-branch form on a default protected branch without an exception. */
const WORKING_BRANCH_MAIN = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
---

## Assignment

Do the thing.
`

/** `Branch policy: direct on main — <reason>` — the exception matches the gate branch. */
const DIRECT_ON_MAIN = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
branch_policy: direct on main — hotfix approved by user
---

## Assignment

Do the thing.
`

/** Self-recursion: the Assignment's `Execute as` equals the dispatcher's own role. */
const SELF_RECURSION = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/x
---

## Assignment

Do the thing.
`

/** Self-recursion against the SHIPPED default binding (`project-manager`). */
const SELF_DISPATCH_PROJECT_MANAGER = `---
execute_as: project-manager
delegation: forbidden
task_category: logic
working_branch: feature/x
---

## Assignment

Do the thing.
`

/** Hard flag in the Assignment HEADER plus a violation (branch form missing) to harden on. */
const HARD_HEADER_FLAG = `---
enforcement: hard
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
---

## Assignment

Do the thing.
`

/** Hard flag quoted in the TASK BODY must NOT harden.*/
const HARD_BODY_FLAG = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
---

## Assignment

## Task

Example: **Enforcement**: hard
`

/** Working branch on main with a BODY-QUOTED direct-on exception — the quoted exception must not nullify the protection.*/
const BODY_QUOTED_BRANCH_POLICY = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: main
---

## Assignment

## Task

The task body quotes an example header line:
**Branch policy**: direct on main — hotfix quoted in the body
`

/** A read-only header with BODY-QUOTED Working branch / Execute as examples — must not fire false denies.*/
const BODY_QUOTED_FIELDS = `---
execute_as: scout
delegation: n/a
task_category: deep
task_budget: XS — one orientation round
---

## Assignment

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

/**
 * The CALLING sessions the anti-recursion caller derivation reads: a ROOT
 * session carries no `header.parentSession` (the coordinator seat), an
 * in-process subagent child stamps it at creation. Neither carries a durable
 * id/cwd, so the session-hint derivation stays as cheap as the agent-less
 * shapes these tests used before.
 */
const rootAgent = { session: { header: {} } }
const childAgent = { session: { header: { parentSession: 'root-session' } } }

/** Collect dispatch-gate advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const advisories: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { advisories.push(payload) })
  return advisories
}

const violationCodes = (advisory: DispatchGateAdvisory | undefined): string[] =>
  advisory?.result.violations.map((v) => v.code) ?? []

/**
 * Capture `mstar/dispatch-gate` warn logs through a cordis logger exporter (the
 * default buffer exporter filters warns out, so the exporter registers its own
 * `levels.default: 2` threshold). Only logs emitted AFTER registration are
 * captured — an apply-time warn needs the exporter installed before the apply.
 */
function captureDispatchWarns(ctx: BootResult['ctx']): string[] {
  const warns: string[] = []
  ctx.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      if (message.type === 'warn' && message.name === DISPATCH_LOGGER) warns.push(String(message.args[0]))
    },
  })
  return warns
}

/**
 * Write a role through the Loader's live volatile `dispatchBinding` reference —
 * the exact effect a dsh plugin-settings save has. Fails loud when the field is
 * not volatile (no live reference was created).
 */
function writeLiveDispatchBinding(app: BootResult, role: string): void {
  const config = app.pluginFiber?.effectiveConfig as { dispatchBinding?: Record<symbol, unknown> } | undefined
  const write = config?.dispatchBinding?.[Symbol.for('cosmokit.volatile.write')]
  expect(typeof write, 'the plugin config must carry a live volatile dispatchBinding reference').toBe('function')
  ;(write as (value: unknown) => void)(role)
}

/* ---------------------------------- warn (default) mode ---------------------------------- */

describe('dispatch gate — warn (default) mode', () => {
  it('explicitly blank dispatchBinding → allow, advisory with dispatch.anti-recursion.empty-binding (fails closed)', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const anti = advisories[0]!.result.violations.find((v) => v.code === 'dispatch.anti-recursion.empty-binding')
    expect(anti).toBeDefined()
    expect(anti!.severity).toBe('critical')
  })

  it('missing Execute as → advisory with assignment.field.execute-as, dispatch allowed', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('subagent')
    expect(advisories[0]!.role).toBe('')
    expect(advisories[0]!.hard).toBe(false)
    expect(violationCodes(advisories[0])).toContain('assignment.field.execute-as')
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
    const app = booted = await bootApp({ dispatchBinding: '' })
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
    const app = booted = await bootApp({ dispatchBinding: '' })
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

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION, rootAgent), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const anti = advisories[0]!.result.violations.find((v) => v.code === 'dispatch.anti-recursion.self-type')
    expect(anti).toBeDefined()
    expect(anti!.severity).toBe('critical')
  })

  it('explicitly blank binding → dispatch.anti-recursion.empty-binding fires, self-type does not (fail closed)', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)

    // MISSING_BRANCH carries Execute as: fullstack-dev (a self-typed role when a
    // binding were configured) — with a blank binding the empty-binding
    // violation fires alongside the field gate; self-type cannot fire (no
    // caller role to compare against).
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
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.execute-as')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('anti-recursion self-type under hard → deny with the critical code', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'fullstack-dev' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION, rootAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.self-type')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical]')
  })

  it('valid Assignment under hard → allow (no violations → no veto)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, rootAgent), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('an unset binding on a ROOT session reads as project-manager under hard → admit, no empty-binding', async () => {
    // No explicit binding: a root session IS the coordinator, so the red line
    // has a real role to compare against instead of failing closed.
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, rootAgent), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('the root-session caller still refuses an Execute as matching it (self-type red line intact)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_DISPATCH_PROJECT_MANAGER, rootAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.self-type')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical]')
  })

  it('explicitly blank dispatchBinding under hard → deny with dispatch.anti-recursion.empty-binding (fail closed)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })
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

  it('an explicitly blank binding is also warned about at apply, pointing at the settings form', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })
    // The apply-time warn fires before any test exporter can listen, so
    // re-apply the plugin row on the same context (the HMR shape) under a
    // warn exporter.
    await app.pluginFiber!.dispose()
    const warns = captureDispatchWarns(app.ctx)

    await app.ctx.plugin(entry, { harnessDir: app.harnessDir, enforcement: 'hard', dispatchBinding: '' })

    // The apply also warns about an unset `dispatchTools` on the same logger.
    const bindingWarns = warns.filter((warn) => warn.includes('dispatchBinding'))
    expect(bindingWarns).toHaveLength(1)
    expect(bindingWarns[0]).toContain('explicitly blank')
    expect(bindingWarns[0]).toContain('settings form')
    expect(bindingWarns[0]).not.toContain('until dispatchBinding is set')
  })

  it('a live dispatchBinding save is observed by the NEXT dispatch (plugin settings form path)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    // VALID_WRITABLE carries Execute as: fullstack-dev — not the bound role.
    expect(await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, rootAgent), defaultAllow)).toEqual({ kind: 'allow' })

    // The dsh plugin settings form saves through the live volatile field — no
    // remount, no re-apply.
    writeLiveDispatchBinding(app, 'fullstack-dev')
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, rootAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.self-type')
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

/* ---------------------------------- derived caller ---------------------------------- */

/* -------------------- boot diagnostic: explicit soft vs a repo hard arm -------------------- */

describe('boot enforcement diagnostic — Config soft suppresses a repo/compass hard arm', () => {
  it('stays silent under Config enforcement: soft; the same compass arm fires it without the override', async () => {
    const app = booted = await bootApp()
    // The repo-LEVEL hard arm: an ACTIVE iteration compass declaring
    // `enforcement: hard` — the arm `resolveRepoEnforcement` reads BELOW the
    // explicit Config override (precedence: Config > .mstarc > compass).
    await seedHarness(app.harnessDir, {
      'iterations/20260101-demo/delivery-compass.md': '---\niteration_id: 20260101-demo\nstatus: active\nenforcement: hard\n---\n',
    })
    // The apply-time warn fires before any test exporter can listen, so
    // re-apply the plugin row on the same context (the HMR shape).
    await app.pluginFiber!.dispose()
    const warns = captureDispatchWarns(app.ctx)
    const bootDiagnostics = (): string[] => warns.filter((warn) => warn.startsWith('Enforcement: hard is active'))

    // Contrast first: with no explicit override the compass hardens the boot,
    // so the unset-`dispatchTools` diagnostic fires — proof the arm is read.
    let fiber = await app.ctx.plugin(entry, { harnessDir: app.harnessDir })
    expect(bootDiagnostics()).toHaveLength(1)
    expect(bootDiagnostics()[0]).toContain('dispatchTools is unset')

    // The explicit soft rolls the arm back: the very same diagnostic is silent.
    await fiber.dispose()
    warns.length = 0
    fiber = await app.ctx.plugin(entry, { harnessDir: app.harnessDir, enforcement: 'soft' })
    expect(bootDiagnostics()).toHaveLength(0)
    await fiber.dispose()
  })
})

describe('the anti-recursion caller is DERIVED from the calling session, never invented', () => {
  it('dispatchCallerOf: a ROOT session reads the explicit binding verbatim (or the coordinator); a child/unreadable session is EMPTY', () => {
    expect(dispatchCallerOf({ dispatchBinding: 'fullstack-dev' }, rootAgent)).toBe('fullstack-dev')
    // An explicitly blank value on a ROOT session stays blank — never replaced
    // by the root identity.
    expect(dispatchCallerOf({ dispatchBinding: '' }, rootAgent)).toBe('')
    expect(dispatchCallerOf({}, rootAgent)).toBe(ROOT_SESSION_DISPATCH_BINDING)
    // A CHILD session never inherits the binding: the caller is empty, so the
    // engine's empty-binding fail-closed rule applies whatever is configured.
    expect(dispatchCallerOf({}, childAgent)).toBe('')
    expect(dispatchCallerOf({ dispatchBinding: 'project-manager' }, childAgent)).toBe('')
    expect(dispatchCallerOf({ dispatchBinding: 'fullstack-dev' }, childAgent)).toBe('')
    expect(dispatchCallerOf({ dispatchBinding: '' }, childAgent)).toBe('')
    expect(dispatchCallerOf({ dispatchBinding: 'project-manager' }, undefined)).toBe('')
    expect(dispatchCallerOf({}, undefined)).toBe('')
  })

  it('REGRESSION (reported bypass): a CHILD session with no explicit binding dispatching Execute as fullstack-dev is refused with dispatch.anti-recursion.empty-binding', async () => {
    // Before this derivation the schema default fabricated `project-manager` for every
    // caller, so a leaf could dispatch a same-role child and pass the
    // anti-recursion precheck. A leaf must not dispatch: the caller is empty.
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, childAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical] dispatch.anti-recursion.empty-binding')
    expect(decision.kind === 'deny' && decision.reason).not.toContain('dispatch.anti-recursion.self-type')
  })

  it('REGRESSION (reported bypass, explicit binding): a CHILD session with dispatchBinding: project-manager dispatching Execute as fullstack-dev is refused with dispatch.anti-recursion.empty-binding', async () => {
    // The explicit binding is a ROOT-session identity: a child session never
    // inherits it, so the configured coordinator identity cannot be borrowed
    // to defeat the anti-recursion precheck from a leaf.
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: ROOT_SESSION_DISPATCH_BINDING })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, childAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('[critical] dispatch.anti-recursion.empty-binding')
    // The configured role is never compared for a child — no wrong-identity
    // self-type verdict either.
    expect(decision.kind === 'deny' && decision.reason).not.toContain('dispatch.anti-recursion.self-type')
  })

  it('a child session whose explicit binding equals its own Execute as is refused with empty-binding, not self-type', async () => {
    // The caller is EMPTY for a child, so there is no role to compare against:
    // the dispatch fails closed as empty-binding rather than matching itself.
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'fullstack-dev' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(SELF_RECURSION, childAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.empty-binding')
    expect(decision.kind === 'deny' && decision.reason).not.toContain('dispatch.anti-recursion.self-type')
  })

  it('an explicitly blank binding still fails closed on a ROOT session', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE, rootAgent), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.empty-binding')
  })

  it('an UNREADABLE calling session (no session on the execution context) falls back to EMPTY, never to the coordinator', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.anti-recursion.empty-binding')
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
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(BODY_QUOTED_FIELDS, rootAgent), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- parity ---------------------------------- */

describe('dispatch gate — parity with the opencode validated field set', () => {
  it('missing all core fields → exactly the opencode field-set codes', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'fullstack-dev' })
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_ALL_CORE, rootAgent), defaultAllow)

    // Same engine fns as packages/opencode validateDispatchAssignment →
    // identical codes by construction; assert the concrete set here.
    // The Task-budget gate applies to implement rounds regardless of the
    // missing core fields (opencode parity, 435c6fc6).
    expect(violationCodes(advisories[0]).sort()).toEqual([
      'assignment.field.branch-missing',
      'assignment.field.delegation',
      'assignment.field.execute-as',
      'assignment.field.task-budget-missing',
      'assignment.field.task-category',
    ])
    // Severities match the engine contract (critical only for anti-recursion).
    expect(advisories[0]!.result.violations.every((v) => v.severity === 'high')).toBe(true)
  })

  it('missing Execute as carries the legacy assignment.presence alias (engine alias parity)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    const violation = advisories[0]!.result.violations.find((v) => v.code === 'assignment.field.execute-as')
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
  const EXPLORE_NO_BRANCH = `---
execute_as: explore
delegation: n/a
task_category: deep
---

## Assignment

Survey the codebase, report only.
`

  it('explore read-only role without branch form → allow, advisory with dispatch.anti-recursion.empty-binding (no read-only carve-out)', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(EXPLORE_NO_BRANCH), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('dispatch.anti-recursion.empty-binding')
    // Read-only roles still skip the branch + lease gates.
    expect(violationCodes(advisories[0])).not.toContain('assignment.field.branch-missing')
  })

  it('explore under Enforcement: hard → deny with dispatch.anti-recursion.empty-binding (read-only assignments carry no other vetoable violations)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })
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
    expect(idOf('---\nplan_path: `/x/plans/20260101-demo.md`\n---\n')).toBe('20260101-demo')
  })

  it('a backticked SDD dir resolves the bare directory name', () => {
    expect(idOf('---\nsdd_dir: `/x/.mstar/sdd/20260101-demo`\n---\n')).toBe('20260101-demo')
  })

  it('a backticked plan_id resolves verbatim', () => {
    expect(idOf('---\nplan_id: `20260101-demo`\n---\n')).toBe('20260101-demo')
  })

  it('unbackticked values are unchanged, and a multi-span value is left literal', () => {
    expect(idOf('---\nplan_path: /x/plans/20260101-demo.md\n---\n')).toBe('20260101-demo')
    // Only ONE clean wrapping pair is stripped: a value that wraps several
    // spans has backticks inside, so it is left exactly as written. The YAML
    // scalar is quoted so the backticks survive the document parse.
    expect(idOf('---\nplan_id: "`/a`, `/b`"\n---\n')).toBe('`/a`, `/b`')
  })
})

/* ===========================================================================
 * D4 — session-bound row-scope attribution (two concurrent actives)
 * ========================================================================== */

const LEASE_PLAN_ID = '00000810-lease-attribution'
const ROW_BRANCH = 'feature/lease-attribution'
/** A DIFFERENT branch an Assignment may declare — the re-verify comparison basis. */
const OTHER_BRANCH = 'feature/somewhere-else'

/** Fully valid SDD writable Assignment dispatching into the given checkout. */
function sddAssignment(worktreePath: string, branch: string): string {
  return `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
execution_mode: sdd
working_branch: ${branch}
worktree_path: ${worktreePath}
plan_path: /proj/plans/${LEASE_PLAN_ID}.md
task_budget: S — one focused implementer round
---

## Assignment

Do the thing, evidence-first.
`
}

/** An agent carrying the durable session identity the binding store is keyed by. */
const sessionAgent = (sessionId: string, cwd: string): unknown =>
  ({ id: sessionId, session: { header: { id: sessionId, cwd } } })

describe('dispatch gate — D4 session-bound row-scope attribution (explicit selection never bypasses the re-verify)', () => {
  /**
   * Seed two actives through the public producers: `wf-a` records the plan row
   * and its source scope, `wf-b` records none. The scope-bearing row needs a
   * real checkout, not an absolute-looking placeholder, so the fixture builds
   * the L1 topology the same dispatch proves: the app root is a git repo on
   * `main`, plus a dedicated integration checkout and the plan's feature
   * worktree. Returns the feature path the row records.
   */
  async function seedTwoActives(app: BootResult): Promise<string> {
    const root = app.root
    execFileSync('git', ['init', '-q', '-b', 'main', root])
    execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
    const integrationPath = join(root, 'integration-checkout')
    const featurePath = join(root, 'feature-checkout')
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'integration/fixture', integrationPath])
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', ROW_BRANCH, featurePath])
    await seedActiveWorkflow(app.harnessDir, 'wf-a', [{
      id: LEASE_PLAN_ID,
      title: 'scoped plan',
      file: `plans/${LEASE_PLAN_ID}.md`,
      status: 'InProgress',
      metadata: { worktree_path: featurePath, working_branch: ROW_BRANCH },
    }], {
      type: 'iteration',
      branch: { base: 'main', integration: 'integration/fixture' },
      integration_worktree_path: integrationPath,
    }, 'seed-wf-a', root, 'wf-a')
    await seedActiveWorkflow(app.harnessDir, 'wf-b', [], {}, 'seed-wf-b', root, 'wf-b')
    return featurePath
  }

  it('the session pick selects WHICH snapshot is re-verified — an id that does not hold the plan row reports plan-not-found', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    const feature = await seedTwoActives(app)
    expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-b' }).kind).toBe('written')
    const advisories = captureAdvisories(app.ctx)

    // `sess-x` records no scope of its own inside either lifecycle, so the
    // durable pick is the ONLY binding evidence — and it names the lifecycle
    // WITHOUT the plan row.
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(sddAssignment(feature, ROW_BRANCH), sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    const codes = violationCodes(advisories[0])
    expect(codes).toContain('lease.dispatch.plan-not-found')
    expect(codes).not.toContain('lease.dispatch.worktree-mismatch')
  })

  it('the bound row scope is still re-verified — an explicit pick never bypasses the scope mismatch', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    await seedTwoActives(app)
    expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(sddAssignment(join(app.root, 'elsewhere-checkout'), OTHER_BRANCH), sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    const codes = violationCodes(advisories[0])
    expect(codes).toContain('lease.dispatch.worktree-mismatch')
    expect(codes).toContain('lease.dispatch.branch-mismatch')
    expect(codes).not.toContain('lease.dispatch.plan-not-found')
    expect(codes).not.toContain('lease.dispatch.unverifiable')
  })

  it('the plan row the Assignment names identifies its lifecycle — no session pick needed while several are active', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    const feature = await seedTwoActives(app)
    // Deliberately NO durable pick and no session scope: several lifecycles are
    // active and the session cwd matches neither, so before the
    // operation-identified rung this dispatch could only report unverifiable.
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(sddAssignment(feature, ROW_BRANCH), sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    const codes = violationCodes(advisories[0])
    expect(codes).not.toContain('lease.dispatch.unverifiable')
    expect(codes).not.toContain('lease.dispatch.plan-not-found')
    // The named lifecycle is still re-verified against its own row scope.
    expect(codes).not.toContain('lease.dispatch.worktree-mismatch')
    expect(codes).not.toContain('lease.dispatch.branch-mismatch')
  })

  it('an Assignment dispatching into the row’s OWN recorded scope verifies clean (the positive control)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
    const feature = await seedTwoActives(app)
    expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
    const advisories = captureAdvisories(app.ctx)

    // The same pick resolves the plan row, and its recorded worktree/branch
    // match the Assignment — nothing to report.
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(sddAssignment(feature, ROW_BRANCH), sessionAgent('sess-x', app.root)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  describe('dispatch gate — ONE resolution per dispatch (the source cannot split decision from record)', () => {
    // The waterfall gate chain is microtask-only (synchronous fs/sqlite reads
    // with promise-skeleton awaits), so no timer can interleave INTO a
    // dispatch — the deterministic mid-dispatch seam is the first resolution
    // itself. The swap and first-refusal regressions live in
    // host-adapter.spec.ts over `dispatchGate`'s single-resolution input.
    it('a pointer dispatch of a CLEAN document through the waterfall records exactly one consistent ledger row', async () => {
      const app = booted = await bootApp({ dispatchBinding: 'qc-specialist' })
      const feature = await seedTwoActives(app)
      expect(updateWorkflowSessionBinding(app.harnessDir, 'sess-x', app.root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
      const advisories = captureAdvisories(app.ctx)

      const assignmentsDir = join(app.harnessDir, 'assignments')
      mkdirSync(assignmentsDir, { recursive: true })
      const file = join(assignmentsDir, 'consistent-pointer.md')
      writeFileSync(file, sddAssignment(feature, ROW_BRANCH))

      const decision = await app.ctx.waterfall(
        'tools/pre-execute',
        subagentExec(`Assignment file: ${file}`, sessionAgent('sess-x', app.root)),
        defaultAllow,
      )

      expect(decision).toEqual({ kind: 'allow' })
      expect(advisories).toHaveLength(0)
      const events = readAgentFlow(join(app.harnessDir, 'workflows', 'wf-a'), 'wf-a')?.events ?? []
      const dispatches = events.filter((event) => event.kind === 'dispatch')
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ role: 'fullstack-dev', verdict: 'ok' })
    }, 60_000)
  })
})

describe('dispatch gate — the carrying-session hint is derived ONLY where the gate reads it (D4 hot path)', () => {
  it('a tool the gate reads no hint for never touches the binding store', async () => {
    const app = booted = await bootApp()
    // No ACTIVE store in this workspace: every derivation of the session hint
    // reports the store's own degrade through the adapter's sink, so the warn
    // count IS the derivation count (the binding read is a store read now, so
    // the probe is the absent authority rather than a torn file).
    mkdirSync(app.harnessDir, { recursive: true })
    const warns: string[] = []
    const config: Config = {}
    const resolver = new HarnessResolver(app.harnessDir)
    const adapter = new DshHostAdapter(new Context(), {
      resolver,
      config,
      log: (level, message) => { if (level === 'warn') warns.push(message) },
    })
    const agent = sessionAgent('sess-x', app.root)

    // Not a gated tool: pure pass-through — `tools/pre-execute` fires for every
    // call, so this path must not pay the durable-binding read at all.
    expect(await preExecuteListener(app.ctx, resolver, config, adapter, toolExec('bash', { command: 'ls' }, agent), defaultAllow))
      .toEqual({ kind: 'allow' })
    expect(warns).toEqual([])

    // A dispatch-shaped call DOES carry the hint — derived once, reported once.
    await preExecuteListener(app.ctx, resolver, config, adapter, subagentExec(VALID_WRITABLE, agent), defaultAllow)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('mstar store init')
  })
})

/* ---------------------------------- leaf-seat tool boundary ---------------------------------- */

/**
 * PR #558 must-fix 1: the profile-wide `mstar-mcp` row mounts ONE GENERIC
 * connection for the whole host (no identity, no `--seat`), so a known leaf
 * could name a bound coordinator session on that connection and run
 * `plan.complete`. The guard lives on `tools/pre-execute`, where the host knows
 * the calling agent is a leaf, and reads the folded tool's `action` from the
 * call's arguments.
 */

/** The folded plan tool as the shipped bundle's `mstar` server publishes it. */
const PLAN_TOOL = 'mcp__mstar__mstar_plan'

/** A known leaf seat: the subagent origin the identity chain reads. */
const leafAgent = (): unknown => ({ id: 'leaf-session', session: { header: { origin: 'subagent' } } })

/** A known leaf seat by delegation depth (the other shape of the same contract). */
const depthLeafAgent = (): unknown => ({ id: 'depth-leaf', session: { header: { delegationDepth: 1 } } })

/** The coordinating session on the SAME generic connection. */
const coordinatingAgent = (): unknown => ({ id: 'coordinator-session', session: { header: { origin: 'user' } } })

/** One folded MCP call: the family tool plus its `action` selector. */
const foldedCall = (tool: string, args: Record<string, unknown>, agent: unknown): ToolExecution =>
  toolExec(tool, args, agent)

describe('leaf-seat tool boundary — coordinator actions on the folded MCP surface', () => {
  it('refuses plan.complete and plan.bind for a known leaf before the MCP child runs', async () => {
    const app = booted = await bootApp()
    for (const action of ['complete', 'bind']) {
      const decision = await app.ctx.waterfall('tools/pre-execute', foldedCall(PLAN_TOOL, { action, plan: 'p', sessionId: 'coordinator-session' }, leafAgent()), defaultAllow)
      expect(decision.kind).toBe('deny')
      expect((decision as { reason?: string }).reason).toContain('leaf-seat.coordinator-action')
      expect((decision as { reason?: string }).reason).toContain(action)
    }
  })

  it('refuses the same actions for a leaf recognised by delegation depth', async () => {
    const app = booted = await bootApp()
    const decision = await app.ctx.waterfall('tools/pre-execute', foldedCall(PLAN_TOOL, { action: 'complete' }, depthLeafAgent()), defaultAllow)
    expect(decision.kind).toBe('deny')
  })

  it('does not refuse the same generic connection for a non-leaf session', async () => {
    const app = booted = await bootApp()
    for (const action of ['complete', 'bind']) {
      expect(await app.ctx.waterfall('tools/pre-execute', foldedCall(PLAN_TOOL, { action }, coordinatingAgent()), defaultAllow))
        .toEqual({ kind: 'allow' })
    }
  })

  it('leaves the leaf’s allowed folded MCP actions reachable', async () => {
    const app = booted = await bootApp()
    const allowed: ToolExecution[] = [
      foldedCall(PLAN_TOOL, { action: 'prepare' }, leafAgent()),
      foldedCall(PLAN_TOOL, { action: 'progress' }, leafAgent()),
      foldedCall(PLAN_TOOL, { action: 'show' }, leafAgent()),
      foldedCall('mcp__mstar__mstar_issue', { action: 'add' }, leafAgent()),
      // The `workflow-note` family is coordinator-scoped for its WRITE
      // (`append`); its read action stays reachable, so the guard is not
      // refusing a whole family it was never asked about.
      foldedCall('mcp__mstar__mstar_workflow_note', { action: 'coverage', workflow: 'wf-a' }, leafAgent()),
      foldedCall('mcp__mstar__mstar_sdd', { task_number: 1 }, leafAgent()),
      foldedCall('mcp__mstar__mstar_schema', { family: 'plan' }, leafAgent()),
      toolExec('bash', { command: 'ls' }, leafAgent()),
    ]
    for (const exec of allowed) {
      expect(await app.ctx.waterfall('tools/pre-execute', exec, defaultAllow)).toEqual({ kind: 'allow' })
    }
  })

  it('refuses the workflow family’s coordinator actions, not only the plan pair', async () => {
    const app = booted = await bootApp()
    for (const action of ['evidence', 'delivery-anchors', 'adopt-terminal', 'lifecycle', 'execution-policy']) {
      const decision = await app.ctx.waterfall(
        'tools/pre-execute',
        foldedCall('mcp__mstar__mstar_workflow', { action, workflow: 'wf-a' }, leafAgent()),
        defaultAllow,
      )
      expect(decision.kind).toBe('deny')
      const reason = (decision as { reason?: string }).reason
      expect(reason).toContain('leaf-seat.coordinator-action')
      // The refusal names the command it refused, so a leaf learns which id
      // belongs to the coordinating session rather than only that it was
      // refused.
      expect(reason).toContain(`workflow.${action}`)
    }
  })

  it('does not refuse the workflow family for a non-leaf session on the same generic connection', async () => {
    const app = booted = await bootApp()
    for (const action of ['evidence', 'delivery-anchors', 'adopt-terminal']) {
      expect(await app.ctx.waterfall('tools/pre-execute', foldedCall('mcp__mstar__mstar_workflow', { action, workflow: 'wf-a' }, coordinatingAgent()), defaultAllow))
        .toEqual({ kind: 'allow' })
    }
  })

  it('refuses every command the shared coordinator-seat set names', async () => {
    const app = booted = await bootApp()
    const seat = getCommandDefinitions().filter((definition) => isCoordinatorSeatCommand(definition.id))
    // The set is derived from the command corpus; a corpus change that drops
    // the workflow family out of it must fail here, not pass silently.
    expect(seat.map((definition) => definition.id)).toContain('workflow.evidence')
    for (const definition of seat) {
      const action = definition.id.slice(definition.id.indexOf('.') + 1)
      const tool = `mcp__mstar__${foldedFamilyToolName(definition.cli.path[0]!)}`
      const decision = await app.ctx.waterfall('tools/pre-execute', foldedCall(tool, { action }, leafAgent()), defaultAllow)
      expect(decision.kind).toBe('deny')
      expect((decision as { reason?: string }).reason).toContain(definition.id)
    }
  })

  it('refuses the session actions that establish a seat, including the child-identity launch', async () => {
    const app = booted = await bootApp()
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      foldedCall('mcp__mstar__mstar_session', { action: 'recover', workflow: 'wf-a' }, leafAgent()),
      defaultAllow,
    )
    expect(decision.kind).toBe('deny')
    expect((decision as { reason?: string }).reason).toContain('session.recover')
    // The launch (`session.run`) mints a coordinator identity for a CHILD
    // process and spawns it, so the child binds on that minted seat without
    // ever passing this boundary: for a leaf that IS seat establishment, not a
    // way to exercise an existing binding.
    const launch = await app.ctx.waterfall(
      'tools/pre-execute',
      foldedCall('mcp__mstar__mstar_session', { action: 'run', workflow: 'wf-a' }, leafAgent()),
      defaultAllow,
    )
    expect(launch.kind).toBe('deny')
    expect((launch as { reason?: string }).reason).toContain('session.run')
  })

  it('refuses the same actions when the deployment server name contains the separator', async () => {
    // The server name is deployment-owned: a row named `mstar__prod` publishes
    // `mcp__mstar__prod__mstar_plan`. A separator count cannot recover the raw
    // name, and the shared row carries no `--seat` to refuse it server-side, so
    // this boundary has to reach the same refusal.
    const app = booted = await bootApp()
    for (const [tool, action, commandId] of [
      ['mcp__mstar__prod__mstar_plan', 'complete', 'plan.complete'],
      ['mcp__ops__mstar__mstar_workflow', 'evidence', 'workflow.evidence'],
    ] as const) {
      const decision = await app.ctx.waterfall('tools/pre-execute', foldedCall(tool, { action }, leafAgent()), defaultAllow)
      expect(decision.kind).toBe('deny')
      const reason = (decision as { reason?: string }).reason
      expect(reason).toContain('leaf-seat.coordinator-action')
      expect(reason).toContain(commandId)
    }
  })

  it('fails closed on a seat action whose published name the client truncated', async () => {
    // `dsh-mcp-client` appends `_<12 hex>` to a name it had to replace or
    // truncate. A truncated name keeps only the head of the family name, so the
    // guard refuses rather than letting an unattributable name through.
    const app = booted = await bootApp()
    const truncated = `${'mcp__'}${'x'.repeat(40)}__msta_0123456789ab`
    const decision = await app.ctx.waterfall('tools/pre-execute', foldedCall(truncated, { action: 'evidence' }, leafAgent()), defaultAllow)
    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason?: string }).reason
    expect(reason).toContain('leaf-seat.unattributed-tool')
    expect(reason).toContain('serverName: mstar')
  })
})

/* ===========================================================================
 * D14/D16 — the ONE assignment source: pointer parity, containment refusals
 * and the legacy body-label refusal
 * ========================================================================== */

/** The retired body-label format of {@link VALID_WRITABLE} — same fields as
 * `**Label**` body lines (the format front matter replaced). */
const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/dsh-package-core
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`

describe('dispatch gate — D14/D16 assignment source (pointer parity and legacy refusal)', () => {
  /** Write one assignment file under the accepted harness home and return the pointer prompt. */
  function pointerInHome(harnessDir: string, content: string): string {
    const dir = join(harnessDir, 'assignments')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'pointer-target.md')
    writeFileSync(file, content)
    return `Assignment file: ${file}`
  }

  it('a pointer under an accepted assignment home produces the SAME decision as the inline form', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const inlineAdvisories = captureAdvisories(app.ctx)

    await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)
    expect(inlineAdvisories).toHaveLength(1)
    const inlineCodes = violationCodes(inlineAdvisories[0]).sort()

    await app.dispose()
    booted = undefined

    const app2 = booted = await bootApp({ dispatchBinding: '' })
    const pointerAdvisories = captureAdvisories(app2.ctx)
    const pointer = pointerInHome(app2.harnessDir, VALID_WRITABLE)

    await app2.ctx.waterfall('tools/pre-execute', subagentExec(pointer), defaultAllow)

    expect(pointerAdvisories).toHaveLength(1)
    expect(violationCodes(pointerAdvisories[0]).sort()).toEqual(inlineCodes)
    expect(violationCodes(pointerAdvisories[0])).toContain('dispatch.anti-recursion.empty-binding')
  })

  it('an out-of-home pointer is a terminal refusal — denied in the default mode, no advisory', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)
    const outside = join(app.root, 'outside-assignment.md')
    writeFileSync(outside, VALID_WRITABLE)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(`Assignment file: ${outside}`), defaultAllow)

    // A source refusal is not an ordinary violation: there is no verified
    // document, so no enforcement setting softens it and no advisory path runs.
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.path')
    expect(advisories).toHaveLength(0)
  })

  it('an out-of-home pointer under Enforcement: hard denies the dispatch', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })
    const outside = join(app.root, 'outside-assignment.md')
    writeFileSync(outside, VALID_WRITABLE)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(`Assignment file: ${outside}`), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.path')
  })

  it('a gate that cannot resolve the control harness root refuses the pointer in the default mode (never skips containment)', async () => {
    const app = booted = await bootApp()
    // No explicit root AND an agent without a session cwd: the resolver
    // cannot produce ANY harness dir, so containment cannot be proven.
    const resolver = new HarnessResolver(undefined)
    const config: Config = {}
    const adapter = new DshHostAdapter(new Context(), { resolver, config })
    const agentless = toolExec('subagent', { description: 'probe', prompt: `Assignment file: ${join(app.root, 'anywhere.md')}` })

    const decision = await preExecuteListener(app.ctx, resolver, config, adapter, agentless, defaultAllow)

    // Terminal source refusal: the default (soft) mode denies it too.
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.path')
    expect(decision.kind === 'deny' && decision.reason).toContain('control harness root is unavailable')
  })

  it('a readable pointer to a non-Assignment file is ONE invalid Assignment, not a silent pass', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)
    const pointer = pointerInHome(app.harnessDir, 'ordinary notes, not an assignment document\n')

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(pointer), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' }) // soft mode: the shape refusal is an ordinary violation
    expect(violationCodes(advisories[0])).toContain('dispatch.assignment.shape')
  })

  it('a body-label prompt is vetoed in the default mode with both recoveries (the refusal is terminal)', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(LEGACY_BODY_LABEL), defaultAllow)

    // No verified declaration exists in the retired format, so no soft setting
    // downgrades it: the dispatch is vetoed before the advisory channel.
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.legacy-format')
    expect(decision.kind === 'deny' && decision.reason).toContain('front-matter document')
    expect(decision.kind === 'deny' && decision.reason).toContain('Assignment file:')
    // The schema's generic absent-fence row is superseded — one defect, one message.
    expect(decision.kind === 'deny' && decision.reason).not.toContain('document.frontmatter.absent')
    expect(advisories).toHaveLength(0)
  })

  it('the legacy refusal under Enforcement: hard denies the dispatch', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: '' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(LEGACY_BODY_LABEL), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.legacy-format')
  })

  it('a pointer resolving to a legacy body-label file is vetoed with dispatch.assignment.legacy-format too', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)
    const pointer = pointerInHome(app.harnessDir, LEGACY_BODY_LABEL)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(pointer), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('dispatch.assignment.legacy-format')
    expect(advisories).toHaveLength(0)
  })
})

/* ===========================================================================
 * Pointer/inline parity under the document's OWN hard enforcement
 * ========================================================================= */

describe('dispatch gate — pointer/inline hard-enforcement parity', () => {
  /** Write one assignment file under the accepted harness home and return the pointer prompt. */
  function hardPointerInHome(harnessDir: string, content: string): string {
    const dir = join(harnessDir, 'assignments')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'hard-parity-target.md')
    writeFileSync(file, content)
    return `Assignment file: ${file}`
  }

  /** Violation codes of a deny reason (the deny channel is the verdict — no advisory in hard mode). */
  const denyCodes = (decision: PreToolDecision): string[] =>
    decision.kind === 'deny' ? [...decision.reason.matchAll(/\[(?:critical|high|medium|low)\] ([\w.-]+)/g)].map((match) => match[1]!) : []

  it('a pointer whose document carries enforcement: hard plus a violation denies exactly as the inline form (no Config enforcement)', async () => {
    // No `enforcement` in Config, no compass arm: the ONLY hard source is the
    // Assignment document's own flag. The inline form denies; reading the
    // pointer LINE (no front matter) instead of the document used to allow in
    // warn mode.
    const app = booted = await bootApp({ dispatchBinding: '' })

    const inlineDecision = await app.ctx.waterfall('tools/pre-execute', subagentExec(HARD_HEADER_FLAG), defaultAllow)
    expect(inlineDecision.kind).toBe('deny')

    await app.dispose()
    booted = undefined

    const app2 = booted = await bootApp({ dispatchBinding: '' })
    const pointerDecision = await app2.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(hardPointerInHome(app2.harnessDir, HARD_HEADER_FLAG)),
      defaultAllow,
    )

    expect(pointerDecision.kind).toBe('deny')
    expect(pointerDecision.kind === 'deny' && pointerDecision.reason).toContain('assignment.field.branch-missing')
    expect(denyCodes(pointerDecision).sort()).toEqual(denyCodes(inlineDecision).sort())
  })

  it('the warn-mode advisory of a pointer violation names the document\'s own Execute as, not the pointer text', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const advisories = captureAdvisories(app.ctx)
    // The document carries execute_as: fullstack-dev; the pointer line carries none.
    const pointer = hardPointerInHome(app.harnessDir, MISSING_BRANCH)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(pointer), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.role).toBe('fullstack-dev')
    expect(violationCodes(advisories[0])).toContain('assignment.field.branch-missing')
  })
})

/* ===========================================================================
 * Isolation shapes at the worktree L2 gate (the shared entries API)
 * ========================================================================= */

describe('dispatch gate — worktree L2 isolation shapes', () => {
  /** Real git worktrees for the L2 probe (`git -C <path> branch --show-current`). */
  function trackWorktrees(root: string, branches: readonly string[]): Map<string, string> {
    const paths = new Map<string, string>()
    for (const branch of branches) {
      const path = join(root, `wt-${branch.replace(/\//g, '-')}`)
      execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, path])
      paths.set(branch, path)
    }
    return paths
  }

  /** Front-matter parallel-track document: both tracks as flow or block list values. */
  function parallelTracksDoc(pathA: string, branchA: string, pathB: string, branchB: string, flow: boolean, hard = false): string {
    const paths = flow ? `worktree_path: [${pathA}, ${pathB}]` : `worktree_path:\n  - ${pathA}\n  - ${pathB}`
    const branches = flow ? `working_branch: [${branchA}, ${branchB}]` : `working_branch:\n  - ${branchA}\n  - ${branchB}`
    return `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — parallel tracks
${paths}
${branches}${hard ? '\nenforcement: hard' : ''}
---

## Assignment

Two parallel writable tracks.
`
  }

  it('a flow-list parallel-track declaration enters the L2 isolation check (branch mismatch surfaces)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    // bootApp's root is already a git repo with its initial commit — add the
    // two track worktrees to it (the L2 probe needs real checkouts on their branches).
    const tracks = trackWorktrees(app.root, ['feature/track-a', 'feature/track-b'])
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(parallelTracksDoc(tracks.get('feature/track-a')!, 'feature/track-a', tracks.get('feature/track-b')!, 'feature/not-track-b', true)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    // A flow-list `worktree_path` is the parallel declaration: track B is
    // declared on the WRONG branch, so the mismatch can only surface when the
    // gate reads the list as two tracks — before the shared entries API the
    // flow array read as one scalar and the gate skipped isolation entirely.
    expect(violationCodes(advisories[0])).toContain('worktree.l2.branch-mismatch')
  }, 60_000)

  it('a block-list parallel-track declaration enters the same L2 isolation check (branch mismatch surfaces)', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    const tracks = trackWorktrees(app.root, ['feature/block-a', 'feature/block-b'])
    const advisories = captureAdvisories(app.ctx)

    // Track B declared on the WRONG branch: only a gate that reads the block
    // list as two tracks can detect it.
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(parallelTracksDoc(tracks.get('feature/block-a')!, 'feature/block-a', tracks.get('feature/block-b')!, 'feature/not-block-b', false)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('worktree.l2.branch-mismatch')
  }, 60_000)

  it('a correctly paired two-track list raises no branch-field or track violation', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    const tracks = trackWorktrees(app.root, ['feature/ok-a', 'feature/ok-b'])
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      subagentExec(parallelTracksDoc(tracks.get('feature/ok-a')!, 'feature/ok-a', tracks.get('feature/ok-b')!, 'feature/ok-b', true)),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    // The list IS the schema's own parallel shape: the shared field/branch
    // gate accepts it (no branch presence/multiple row) and the L2 pairing
    // finds both tracks on their declared branches.
    const codes = violationCodes(advisories[0])
    expect(codes.filter((code) => code.startsWith('assignment.field.branch') || code.startsWith('worktree.l2.'))).toEqual([])
    expect(codes).not.toContain('document.frontmatter.invalid')
  }, 60_000)

  it('a correctly paired two-track declaration under HARD enforcement is admitted with no veto', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    const tracks = trackWorktrees(app.root, ['feature/hard-a', 'feature/hard-b'])
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      // A ROOT session supplies the caller identity: a hard dispatch must clear
      // the anti-recursion binding too, not only the track checks.
      subagentExec(parallelTracksDoc(tracks.get('feature/hard-a')!, 'feature/hard-a', tracks.get('feature/hard-b')!, 'feature/hard-b', true, true), rootAgent),
      defaultAllow,
    )

    // Genuinely hard (the document's own flag vetoes ANY violation), so an
    // allow proves the pair is clean rather than soft mode hiding a refusal.
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  }, 60_000)

  it('a pointed control-write assignment resolves worktree_path from the POINTED file, while Git discovery stays on the checkout', async () => {
    const app = booted = await bootApp({ dispatchBinding: '' })
    const assignmentsDir = join(app.harnessDir, 'assignments')
    mkdirSync(assignmentsDir, { recursive: true })
    const branch = execFileSync('git', ['-C', app.root, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
    // `<app.root>/.mstar/assignments/../..` IS the control checkout: only the
    // pointed file's own directory makes that relative path resolve onto it.
    const doc = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — control write
write_domain: control
worktree_path: ../..
working_branch: ${branch}
control_write_paths:
  - .mstar/status.json
---

## Assignment

Update control state.
`
    const pointed = join(assignmentsDir, 'control-relative.md')
    writeFileSync(pointed, doc)
    const advisories = captureAdvisories(app.ctx)
    const priorCwd = process.cwd()
    try {
      // The control checkout is the checkout the gate inspects: run from it,
      // exactly as a session in that repo does.
      process.chdir(app.root)
      const viaPointer = await app.ctx.waterfall('tools/pre-execute', subagentExec(`Assignment file: ${pointed}`), defaultAllow)
      expect(viaPointer).toEqual({ kind: 'allow' })
      expect(violationCodes(advisories[advisories.length - 1])).not.toContain('dispatch.control-write.worktree-not-control')
      advisories.length = 0

      // Negative control: the SAME document inline has no pointed directory,
      // so the relative path resolves against the checkout and misses it.
      await app.ctx.waterfall('tools/pre-execute', subagentExec(doc), defaultAllow)
      expect(violationCodes(advisories[advisories.length - 1])).toContain('dispatch.control-write.worktree-not-control')
    } finally {
      process.chdir(priorCwd)
    }
  }, 60_000)

  it('duplicate worktree_path keys refuse as document.frontmatter.invalid instead of entering isolation', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    const tracks = trackWorktrees(app.root, ['feature/dupe-a', 'feature/dupe-b'])
    const advisories = captureAdvisories(app.ctx)
    // The retired parallel grammar: repeated keys. The shared entries parser
    // refuses the whole block — the schema layer reports the malformed
    // document rather than the worktree gate silently pairing the first keys.
    const prompt = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — parallel tracks
worktree_path: ${tracks.get('feature/dupe-a')!}
worktree_path: ${tracks.get('feature/dupe-b')!}
working_branch: feature/dupe-a
---

## Assignment

Two parallel writable tracks.
`

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('document.frontmatter.invalid')
    expect(violationCodes(advisories[0]).filter((code) => code.startsWith('worktree.l2.'))).toEqual([])
  }, 60_000)

  it('an unterminated fence declares nothing at the worktree gate — schema refusal only, no track pairing', async () => {
    const app = booted = await bootApp({ dispatchBinding: 'project-manager' })
    const tracks = trackWorktrees(app.root, ['feature/unterm-a', 'feature/unterm-b'])
    const advisories = captureAdvisories(app.ctx)
    // The opening fence never closes: every field line below is inert. Before
    // the shared entries API the local scanner still read the lines as root
    // keys and could pair tracks out of a malformed document.
    const prompt = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
task_budget: S — parallel tracks
worktree_path: [${tracks.get('feature/unterm-a')!}, ${tracks.get('feature/unterm-b')!}]
working_branch: [feature/unterm-a, feature/unterm-b]

## Assignment

Two parallel writable tracks.
`

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(prompt), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(violationCodes(advisories[0])).toContain('document.frontmatter.absent')
    expect(violationCodes(advisories[0]).filter((code) => code.startsWith('worktree.l2.'))).toEqual([])
  }, 60_000)
})
