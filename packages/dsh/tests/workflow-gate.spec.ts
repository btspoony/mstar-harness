/**
 * Plan `20260815-dsh-workflow-gate` — the workflow/ralph gate branch.
 *
 * Task 1 — config surface + args-shape branch skeleton: the `workflowGate`
 * mode short-circuit (`off` → pass-through, no verdict row), the
 * default-`warn` advisory for policy-unknown workflow names, non-workflow
 * tools unaffected, and the malformed-args fail-open + one warn path.
 *
 * Task 2 — the centralized policy (`gates/workflow-policy.ts`): P-a name
 * allowlist (allowlisted names pass under ANY mode) + P-c first-seen ask
 * (`ask` mode: first-seen → `{kind:'ask'}` through the approval waterfall;
 * the answer recorded via the apply-scoped `WorkflowAskCache` is reused —
 * no re-ask; the cache dies with the context). Hard mode denies unknown
 * names naming the name; empty `workflowNames` ⇒ every name unknown.
 * Ralph has no `meta.name`, so P-a/P-c never apply to it (including the
 * malformed-args fold-in: ralph without `objective` → pass + one warn).
 *
 * Task 3 — P-b lease attribution: the calling workspace's status.json is
 * read through the contained resolver path (agent session cwd → harness
 * dir); any plan `InProgress` lacking `execution_lease` coverage (engine
 * `verifyPlanExecutionLease`) makes writable fan-out uncovered — deny
 * under `hard` (reason cites the plan id), advisory + warn under
 * `warn`/`ask`, allow for read-only workspaces / no harness dir / no
 * active plans. A status read failure is fail-open + ONE warn (a broken
 * status must not brick fan-out; P-a/P-c still run). P-b applies to ralph
 * too (no `meta.name` needed). Fold-ins from the Task 2 review: the
 * allowlisted-under-`warn` case (no advisory).
 *
 * Verdict rows surface through the existing dispatch record path
 * (`mstar/dispatch-gate` advisory) until Task 4 wires the durable ledger
 * rows.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, type BootResult } from './harness.ts'
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
function toolExec(name: string, args: unknown, agent?: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    ...(agent !== undefined ? { agent: agent as ToolExecution['agent'] } : {}),
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** A well-formed `workflow` call (architect-verified shape: `{ script, meta: { name, ... }, args? }`). */
const workflowExec = (metaName: string): ToolExecution =>
  toolExec('workflow', { script: 'probe', meta: { name: metaName, description: 'probe' } })

/** A well-formed `ralph` call (shape: `{ objective, maxRounds?, maxHandoffChars? }`). */
const ralphExec = (objective: string): ToolExecution => toolExec('ralph', { objective })

/** An agent whose session cwd is a workspace root (P-b attribution input). */
const agentIn = (cwd: string): unknown => ({ session: { header: { cwd } } })

/** A `workflow` call attributed to an agent in the given workspace. */
const workflowExecFrom = (metaName: string, cwd: string): ToolExecution =>
  toolExec('workflow', { script: 'probe', meta: { name: metaName, description: 'probe' } }, agentIn(cwd))

/** A `ralph` call attributed to an agent in the given workspace. */
const ralphExecFrom = (objective: string, cwd: string): ToolExecution =>
  toolExec('ralph', { objective }, agentIn(cwd))

/** The subagent tool call shape: `{ description, prompt, run_in_background? }`. */
const subagentExec = (prompt: string): ToolExecution => toolExec('subagent', { description: 'probe', prompt })

/* ------------------------------ P-b fixtures (Task 3) ------------------------------ */

/** A fresh workspace root (no harness dir) — the P-b "no harness" case. */
async function makeWorkspace(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** A workspace with a `.agents/` harness dir (probe candidate #2). */
async function makeHarnessWorkspace(prefix: string): Promise<string> {
  const ws = await makeWorkspace(prefix)
  await mkdir(join(ws, '.agents'), { recursive: true })
  return ws
}

/** status.json wrapping one plan row (lease-gate fixture shape). */
const statusDoc = (plan: Record<string, unknown>): string =>
  JSON.stringify({
    version: 1,
    updated_at: '2026-08-08',
    plans: [plan],
    residual_findings: {},
    metadata: {},
  })

/** InProgress plan row WITHOUT a lease — orphan (uncovered). */
const IN_PROGRESS_ORPHAN: Record<string, unknown> = {
  id: 'plan-orphan',
  title: 'orphan plan',
  status: 'InProgress',
}

/** InProgress plan row WITH a valid execution_lease (covered). */
const IN_PROGRESS_WITH_LEASE: Record<string, unknown> = {
  id: 'plan-leased',
  title: 'leased plan',
  status: 'InProgress',
  execution_lease: {
    holder: 'test-agent',
    claimed_at: '2026-08-08',
    worktree_path: '/tmp/lease-worktree',
    working_branch: 'feature/lease',
  },
}

/** Done plan row without a lease — not active, never uncovered. */
const DONE_NO_LEASE: Record<string, unknown> = {
  id: 'plan-done',
  title: 'done plan',
  status: 'Done',
}

/** statusDoc for a MALFORMED status.json — the P-b read-failure case. */
const UNREADABLE_STATUS = '{ "version": 1, "plans": ' // truncated — readJson throws

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

  it('fold-in (Task-2 review minor): allowlisted name under warn → allow, NO advisory (P-a passes under every mode)', async () => {
    const app = booted = await bootApp({ workflowGate: 'warn', workflowNames: ['deploy-x'] })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(0)
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

/* ---------------------------------- hard mode (P-a allowlist) ---------------------------------- */

describe('workflow gate — hard mode (P-a allowlist)', () => {
  it('(a) allowlisted name under hard → allow, no advisory (P-a)', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard', workflowNames: ['deploy-x'] })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(b) unknown name under hard → deny, reason names the workflow name', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toContain('deploy-x')
    // A deny short-circuits the chain — no advisory emit (the error log is
    // the signal, same as the subagent hard-deny path).
    expect(advisories).toHaveLength(0)
  })

  it('(f) empty workflowNames ⇒ every name unknown — hard denies', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard', workflowNames: [] })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision.kind).toBe('deny')
  })

  it('fold-in: ralph under hard — valid objective → allow (P-a/P-c never apply, no meta.name); malformed (no objective) → pass + ONE warn (fail-open)', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const valid = await app.ctx.waterfall('tools/pre-execute', ralphExec('probe the codebase'), defaultAllow)
    expect(valid).toEqual({ kind: 'allow' })

    const malformed = await app.ctx.waterfall('tools/pre-execute', toolExec('ralph', { maxRounds: 3 }), defaultAllow)
    expect(malformed).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(1)
  })
})

/* ---------------------------------- ask mode (P-c first-seen ask) ---------------------------------- */

describe('workflow gate — ask mode (P-c first-seen ask)', () => {
  it('(a) allowlisted name under ask → allow, no ask, no advisory (P-a)', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', workflowNames: ['deploy-x'] })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(c) unknown first-seen → {kind: ask}; answer allow → allowed + cached; second same-name call → no ask', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask' })

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')
    if (first.kind !== 'ask') throw new Error('expected ask')
    expect(first.reason).toContain('deploy-x')

    // The ask is serviced by the dsh approval waterfall (upstream). The
    // ANSWER (allowed-once) reaches the cache through the answerer
    // integration seam — simulated here on the apply-scoped cache.
    app.ctx.dshHostAdapter.workflowAskCache.record('deploy-x', 'allow')

    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second).toEqual({ kind: 'allow' })
  })

  it('(d) answer deny → denied + cached; second same-name call → no ask', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask' })

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')

    app.ctx.dshHostAdapter.workflowAskCache.record('deploy-x', 'deny')

    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second.kind).toBe('deny')
    if (second.kind !== 'deny') throw new Error('expected deny')
    expect(second.reason).toContain('deploy-x')
  })

  it('(e) cache dies with the context — HMR-safe (fresh apply starts empty)', async () => {
    const appA = booted = await bootApp({ workflowGate: 'ask' })
    const first = await appA.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')
    appA.ctx.dshHostAdapter.workflowAskCache.record('deploy-x', 'allow')
    const second = await appA.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second).toEqual({ kind: 'allow' })

    // Tear the fiber down (HMR reload = dispose + fresh apply): the cache
    // is apply-scoped — a new apply starts with an EMPTY cache, so the
    // same name is first-seen again and asks. No module-level Map survives.
    await appA.dispose()
    booted = undefined

    const appB = booted = await bootApp({ workflowGate: 'ask' })
    const third = await appB.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(third.kind).toBe('ask')
  })

  it('(f) empty workflowNames ⇒ every name unknown — ask first-seen', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', workflowNames: [] })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision.kind).toBe('ask')
  })
})

/* ---------------------------------- P-b lease attribution (Task 3) ---------------------------------- */

describe('workflow gate — P-b lease attribution', () => {
  it('(a) uncovered InProgress plan (no lease) + hard → deny, reason cites the plan id', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-a-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toContain('plan-orphan')
    // A deny short-circuits the chain — no advisory emit.
    expect(advisories).toHaveLength(0)
  })

  it('(b) uncovered InProgress plan under warn → allowed + advisory (workflow.lease.uncovered) + warn', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-b1-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'warn', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('workflow')
    expect(advisories[0]!.role).toBe('')
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.ok).toBe(false)
    expect(violationCodes(advisories[0])).toContain('workflow.lease.uncovered')
    expect(advisories[0]!.result.violations[0]!.message).toContain('plan-orphan')
    expect(warns.length - warnSnapshot).toBe(1)
  })

  it('(b) uncovered InProgress plan under ask → allowed + advisory + warn (P-b never asks — workspace red line, advisory only)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-b2-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'ask', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('workflow.lease.uncovered')
    expect(warns.length - warnSnapshot).toBe(1)
  })

  it('(c) lease-covered InProgress plan → allow, no advisory (P-b passes; P-a allowlist still honored under hard)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-c-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_WITH_LEASE) })
    const app = booted = await bootApp({ workflowGate: 'hard', workflowNames: ['deploy-x'], harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(d) no harness dir → allow (nothing to attribute); ralph under hard stays clean', async () => {
    const ws = await makeWorkspace('dsh-ws-pb-d1-')
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExecFrom('probe the codebase', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(d) harness dir with no active plans → allow (read-only workspace; non-InProgress rows never uncovered)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-d2-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(DONE_NO_LEASE) })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExecFrom('probe the codebase', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('(e) ralph call in an uncovered writable workspace + hard → deny (P-b applies to ralph; P-a/P-c do not)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-e-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExecFrom('probe the codebase', ws), defaultAllow)

    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('expected deny')
    expect(decision.reason).toContain('plan-orphan')
    expect(advisories).toHaveLength(0)
  })

  it('(f) status read failure → fail-open + ONE warn (broken status must not brick fan-out; P-a/P-c still run)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-f-')
    await seedHarness(join(ws, '.agents'), { 'status.json': UNREADABLE_STATUS })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    // Ralph under hard: P-b is degraded (fail-open + warn), P-a/P-c never
    // apply — the call is allowed with exactly ONE warn.
    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExecFrom('probe the codebase', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(1)
  })
})
