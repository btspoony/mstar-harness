/**
 * Plan `20260815-dsh-workflow-gate` Task 1 — config surface + args-shape
 * branch skeleton: the `workflowGate` mode short-circuit (`off` →
 * pass-through, no verdict row), the default-`warn` advisory for
 * policy-unknown workflow names, non-workflow tools unaffected, and the
 * malformed-args fail-open + one warn path. The branch composes a
 * `WorkflowGateInput` for the Task 2/3 policies; verdict rows surface
 * through the existing dispatch record path (`mstar/dispatch-gate`
 * advisory) until Task 4 wires the durable ledger rows.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import { DISPATCH_LOGGER } from '../src/gates/dispatch.ts'

let booted: BootResult | undefined

afterEach(async () => {
  if (booted !== undefined) {
    await booted.dispose()
    booted = undefined
  }
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

/** Missing `Execute as` — the subagent field-gate's first advisory case. */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
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
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** A well-formed `workflow` call (architect-verified shape: `{ script, meta: { name, ... }, args? }`). */
const workflowExec = (metaName: string): ToolExecution =>
  toolExec('workflow', { script: 'probe', meta: { name: metaName, description: 'probe' } })

/** A well-formed `ralph` call (shape: `{ objective, maxRounds?, maxHandoffChars? }`). */
const ralphExec = (objective: string): ToolExecution => toolExec('ralph', { objective })

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

/**
 * Capture `mstar/dispatch-gate` warn logs through a cordis logger exporter
 * (the default buffer exporter filters warns out — threshold 1 — so the
 * exporter registers its own `levels.default: 2` threshold). The
 * dispatcher's log snapshot is taken per test via `length` deltas: the
 * plugin's own boot-time warns on the same logger name must not count.
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

/* ---------------------------------- mode off ---------------------------------- */

describe('workflow gate — mode off', () => {
  it('(a) workflowGate off → workflow call passes through, no verdict row', async () => {
    const app = booted = await bootApp({ workflowGate: 'off' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- warn mode ---------------------------------- */

describe('workflow gate — warn mode', () => {
  it('(b) warn + unknown name → allowed, advisory verdict row + warn', async () => {
    const app = booted = await bootApp({ workflowGate: 'warn' })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('workflow')
    expect(advisories[0]!.role).toBe('')
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.ok).toBe(false)
    expect(violationCodes(advisories[0])).toContain('workflow.name.unknown')
    expect(warns.length - warnSnapshot).toBe(1)
  })

  it('(e) workflowGate defaults to warn when the key is absent', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    // Absent key ⇒ warn mode ⇒ the unknown-name advisory fires (allow + row).
    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('workflow')
    expect(advisories[0]!.hard).toBe(false)
    expect(violationCodes(advisories[0])).toContain('workflow.name.unknown')
  })

  it('(d) workflow call without meta → pass-through + one warn (fail-open)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('workflow', { script: 'probe' }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(1)
  })

  it('ralph call (objective present) passes through — P-a does not apply (no meta.name)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExec('probe the codebase'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(0)
  })
})

/* ---------------------------------- non-workflow tools ---------------------------------- */

describe('workflow gate — non-workflow tools unaffected', () => {
  it('(c) subagent Assignment gate semantics unchanged (prompt branch untouched)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('subagent')
    expect(violationCodes(advisories[0])).toContain('assignment.field.missing-execute-as')
  })

  it('(c) valid subagent Assignment → clean pass, silent (no workflow advisory)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_WRITABLE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(c) unrelated tool name passes through untouched', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('bash', { command: 'echo hi' }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})
