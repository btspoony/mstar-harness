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
 * Task 4 — ledger integration (this file's last describe block): every
 * gated workflow/ralph call produces ONE durable `workflow-verdict` ledger
 * row (verdict + metaName/objective + mode) through the ledger plan's
 * record path; a denied call produces NO child (W-B2 run) rows; a
 * compliant call still produces the W-B2 run rows via the workflow-ledger
 * consumer (the P2 ledger plan's consumer, active when a `sessions`
 * service is present). The P-c answer observation (the Task-2 Important
 * handoff fold-in): an ALLOWED ask executes the call, the consumer
 * observes `tool-workflow/run-start`, records the W-B2 run row AND caches
 * `allow` for the run name — a second same-name call under `ask` reuses
 * the decision without re-asking; a denied answer produces no run → the
 * next call re-asks (fail-closed). The cache-recording failure is
 * contained — it never breaks the ledger append.
 *
 * Task 5 fold-ins (tests 13–15): (13) the P-c cache-key congruence fix
 * (the Task-4 review Important) — the gate and the run-start observation
 * key the ask cache through ONE shared normalization
 * (`normalizeWorkflowName`), so a control-char name asks once, observes
 * under the same key, and never re-asks; (14) the ask-deny fail-closed e2e
 * — an ask answered deny produces NO run rows and NO cache entry, and the
 * next same-name call re-asks through the real gate; (15) the >1024-char
 * name congruence — the cache key is the UNCAPPED full name on both seams
 * (the ledger ROW's display name is capped separately).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, seedHarness, seedV2Tree, FakeSessionsRegistry, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import { DISPATCH_LOGGER } from '../src/gates/dispatch.ts'
import { readAgentFlow } from '../src/gates/agent-flow.ts'
import { registerWorkflowLedger, setWorkflowLedgerLogger } from '../src/gates/workflow-ledger.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import type { AgentFlowEventView } from '../src/types.ts'
import type { WorkflowAskCache } from '../src/gates/workflow-policy.ts'

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

/** A PARSEABLE but shape-invalid status.json (`plans` non-array) — P-b degraded like the unreadable case (F-301). */
const SHAPE_INVALID_STATUS = '{ "version": 1, "plans": {} }'

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

  it('(g) allowlist entry containing a control char matches the normalized gate identity (qc1-S2)', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard', workflowNames: ['deploy-x\u0000'] })
    const advisories = captureAdvisories(app.ctx)

    // The gate composes `metaName` through `normalizeWorkflowName`; the
    // allowlist comparison normalizes its entries at the boundary too — an
    // operator-pasted control-char variant matches the same identity (the
    // config itself is never mutated). Under hard, a miss would deny.
    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
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

  it('(g) parseable-but-shape-invalid status.json → fail-open + ONE warn (P-b degraded with parity to the unreadable read); P-a still runs (F-301)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-g-')
    await seedHarness(join(ws, '.agents'), { 'status.json': SHAPE_INVALID_STATUS })
    const app = booted = await bootApp({ workflowGate: 'hard', workflowNames: ['deploy-x'], harnessDir: null })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    // Allowlisted under hard: P-b is degraded (fail-open + ONE warn — the
    // same loudness as the unreadable read, F-301), P-a still evaluates and
    // passes — the call is allowed, exactly ONE warn, no advisory.
    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
    expect(warns.length - warnSnapshot).toBe(1)
  })

  it('(h) v2 root without root plans[] + workflow + hard + unknown name → P-a deny survives the degraded P-b (workflow.name.unknown, exactly ONE warn) (F-304)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-pb-h-')
    // A v2 root (active workflow) WITHOUT root `plans[]`: the CURRENT P-b
    // read (root plans[] — Task 3 re-points it to the snapshot) treats the
    // missing key as shape-invalid → the same fail-open + ONE warn degrade
    // as the unreadable read. The v2 root ALSO satisfies the agent-flow
    // writer's active-workflow precondition, so the verdict row records.
    await seedHarness(join(ws, '.agents'), {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)
    const warns = captureDispatchWarns(app.ctx)
    const warnSnapshot = warns.length

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('expected deny')
    // The deny is the P-a unknown-name veto, NOT the lease red line — the
    // P-b degrade did not swallow the name-axis policy.
    expect(decision.reason).toContain('deploy-x')
    expect(decision.reason).not.toContain('workflow.lease.uncovered')
    expect(advisories).toHaveLength(0)
    // Exactly ONE warn: the P-b degrade warn (the deny logs at error level).
    expect(warns.length - warnSnapshot).toBe(1)
    // The verdict row records into the ACTIVE workflow dir of the calling
    // workspace's harness (`.agents/workflows/wf-1/agent-flow.jsonl`).
    const events = readAgentFlow(join(ws, '.agents', 'workflows/wf-1'))!.events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'workflow-verdict',
      verdict: 'denied',
      workflow: 'deploy-x',
      mode: 'hard',
      code: 'workflow.name.unknown',
    })
  })
})

/* ---------------------------------- Task 4: ledger integration ---------------------------------- */

/** The booted app's agent-flow ledger events, latest first (the verdict-row read). */
function ledgerEvents(app: BootResult): readonly AgentFlowEventView[] {
  // v3 layout: the ledger lives in the ACTIVE workflow dir (the boot's
  // seeded v2 tree — `seedV2` — has one active workflow `wf-1`).
  const view = readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))
  if (view === null) throw new Error(`ledger unreadable at ${join(app.harnessDir, 'workflows/wf-1')}`)
  return view.events
}

/** One structural fake parent session for the e2e consumer tests (consumer-read surface). */
const parentSession = (id: string, cwd: string): { id: string; events: unknown[]; header: { cwd: string } } =>
  ({ id, events: [], header: { cwd } })

describe('workflow gate — Task 4 ledger integration (verdict rows + P-c observation)', () => {
  it('(1) warn + unknown name → ONE advisory verdict row (workflow-verdict, mode + name carried)', async () => {
    const app = booted = await bootApp({ workflowGate: 'warn', seedV2: true })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    const events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'workflow-verdict',
      tool: 'workflow',
      workflow: 'deploy-x',
      mode: 'warn',
      verdict: 'advisory',
      code: 'workflow.name.unknown',
    })
  })

  it('(2) warn + allowlisted name → ONE ok verdict row (P-a passes; the durable row still lands)', async () => {
    const app = booted = await bootApp({ workflowGate: 'warn', workflowNames: ['deploy-x'], seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    const events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ok', workflow: 'deploy-x', mode: 'warn' })
  })

  it('(3) hard + unknown name → denied verdict row + NO child rows (veto precedes start)', async () => {
    const app = booted = await bootApp({ workflowGate: 'hard', seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision.kind).toBe('deny')
    const events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'workflow-verdict',
      verdict: 'denied',
      workflow: 'deploy-x',
      mode: 'hard',
      code: 'workflow.name.unknown',
    })
    // The veto short-circuited before start: NO W-B2 run/member rows exist.
    expect(events.filter((e) => e.kind !== 'workflow-verdict')).toHaveLength(0)
  })

  it('(4) ask first-seen → ask verdict row; allow answer observed via run-start → cache records allow; second same-name call allowed without re-ask', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', sessionsService: 'fake', seedV2: true })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-ask-e2e', app.root)
    sessions.register(parent)

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')
    let events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ask', workflow: 'deploy-x', mode: 'ask' })

    // The human approves: the registry executes the workflow → the durable
    // run-start lands in the parent session log. The consumer observes it:
    // the W-B2 run row lands AND the allow answer caches per-session (the
    // Task-2 Important handoff fold-in — no approval-outcome access needed).
    sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-ask-e2e', name: 'deploy-x' })
    events = ledgerEvents(app)
    expect(events.map((e) => e.kind)).toEqual(['workflow-run', 'workflow-verdict'])
    expect(app.ctx.dshHostAdapter.workflowAskCache.get('deploy-x')).toBe('allow')

    // Second same-name call: the cached allow is reused — no re-ask, allowed.
    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second).toEqual({ kind: 'allow' })
    events = ledgerEvents(app)
    expect(events.map((e) => e.kind)).toEqual(['workflow-verdict', 'workflow-run', 'workflow-verdict'])
    expect(events[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ok', workflow: 'deploy-x', mode: 'ask' })
  })

  it('(5) ask cached deny → denied + verdict row; no re-ask', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', seedV2: true })

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')
    app.ctx.dshHostAdapter.workflowAskCache.record('deploy-x', 'deny')

    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second.kind).toBe('deny')
    const events = ledgerEvents(app)
    expect(events.map((e) => e.kind)).toEqual(['workflow-verdict', 'workflow-verdict'])
    expect(events[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'denied', workflow: 'deploy-x', mode: 'ask' })
    expect(events[1]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ask', workflow: 'deploy-x', mode: 'ask' })
  })

  it('(6) P-b uncovered + hard → denied (workflow.lease.uncovered in the reason)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-t4-pb-hard-')
    // The P-b lease attribution reads the ROOT `plans[]` (the current
    // dispatch.ts read — Task 3 re-points it to the snapshot), so the
    // fixture stays a v1-shaped status doc. The agent-flow WRITER requires
    // an ACTIVE v2 workflow — a v1 root is migration-required, so the
    // verdict ROW is skipped (one-time warn; never a root v1 write). The
    // verdict-row assertion for the P-b path returns in Task 3 when
    // dispatch.ts reads the snapshot (v2 fixture + snapshot plans[]).
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'hard', harnessDir: null })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') throw new Error('expected deny')
    // The deny reason cites the uncovered plan (the P-b red line) — the
    // same reason shape the P-b describe-block tests (a)/(e) pin.
    expect(decision.reason).toContain('plan-orphan')
    expect(decision.reason).toContain('without execution_lease coverage')
  })

  it('(7) P-b uncovered + warn → allowed + advisory with workflow.lease.uncovered', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-t4-pb-warn-')
    // Same v1-shaped fixture as (6): the P-b lease attribution reads the
    // root `plans[]` (Task 3 re-points it to the snapshot); the agent-flow
    // writer requires an ACTIVE v2 workflow, so the verdict ROW is skipped
    // on this v1 root (one-time warn — never a root v1 write).
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'warn', harnessDir: null })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(violationCodes(advisories[0])).toContain('workflow.lease.uncovered')
  })

  it('(8) ralph (objective present) → ok verdict row carrying the objective (no workflow name)', async () => {
    const app = booted = await bootApp({ seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExec('probe the codebase'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    const events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'workflow-verdict',
      tool: 'ralph',
      objective: 'probe the codebase',
      mode: 'warn',
      verdict: 'ok',
    })
    expect(events[0]).not.toHaveProperty('workflow')
  })

  it('(9) compliant workflow run produces the W-B2 run rows alongside the verdict row (consumer integration)', async () => {
    const app = booted = await bootApp({ workflowGate: 'warn', sessionsService: 'fake', seedV2: true })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-warn-e2e', app.root)
    sessions.register(parent)

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })
    expect(ledgerEvents(app)).toHaveLength(1) // the advisory verdict row

    // The compliant call RAN: the real tool emits the durable tool-workflow
    // session events; the workflow-ledger consumer records the W-B2 rows
    // into the SAME ledger, beside the gate's verdict row.
    sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-warn-e2e', name: 'deploy-x' })
    sessions.append(parent, 'tool-workflow/agent-start', { runId: 'run-warn-e2e', seq: 1, label: 'worker', childId: 'child-1' })
    sessions.append(parent, 'tool-workflow/run-end', { runId: 'run-warn-e2e', stopReason: 'completed' })

    const events = ledgerEvents(app)
    expect(events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run', 'workflow-verdict'])
    expect(events[0]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-warn-e2e', stopReason: 'completed' })
    expect(events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-warn-e2e', childId: 'child-1' })
    expect(events[2]).toMatchObject({ kind: 'workflow-run', runId: 'run-warn-e2e', name: 'deploy-x' })
    expect(events[3]).toMatchObject({ kind: 'workflow-verdict', verdict: 'advisory', workflow: 'deploy-x', mode: 'warn' })
  })

  it('(10) off → NO verdict row (the short-circuit precedes the policy)', async () => {
    const app = booted = await bootApp({ workflowGate: 'off', seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(ledgerEvents(app)).toHaveLength(0)
  })

  it('(11) malformed args → pass-through + NO verdict row (fail-open has no policy verdict)', async () => {
    const app = booted = await bootApp({ seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('workflow', { script: 'probe' }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(ledgerEvents(app)).toHaveLength(0)
  })

  it('(12) P-c observation is contained: a throwing cache never breaks the ledger append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ws-t4-contain-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedV2Tree(harnessDir)
    const ctx = new Context()
    const sessions = new FakeSessionsRegistry(ctx)
    const parent = parentSession('parent-throw-e2e', root)
    sessions.register(parent)
    const throwingCache = {
      record(): never {
        throw new Error('cache exploded')
      },
      get(): undefined {
        return undefined
      },
    } as unknown as WorkflowAskCache
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((level, message) => {
      if (level === 'warn') captured.push(message)
    })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), throwingCache)
      sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-throw-e2e', name: 'deploy-x' })
      const view = readAgentFlow(join(harnessDir, 'workflows/wf-1'))
      expect(view).not.toBeNull()
      // The ledger append succeeded despite the throwing cache hook.
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run'])
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run', runId: 'run-throw-e2e', name: 'deploy-x' })
      // The hook's OWN containment absorbed the throw: the observation
      // degrade warn fired, and the listener-level catch never ran (a
      // propagating hook throw would log 'live consume failed').
      expect(captured.filter((m) => m.includes('P-c allow observation degraded'))).toHaveLength(1)
      expect(captured.filter((m) => m.includes('live consume failed'))).toHaveLength(0)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('(13) P-c cache-key congruence (Task-5 fold-in): a control-char name gates and observes under ONE normalized key — second call no re-ask', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', sessionsService: 'fake', seedV2: true })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-ctrl-e2e', app.root)
    sessions.register(parent)
    // `au\u0000dit` — the gate composes `metaName` through the shared
    // `normalizeWorkflowName` (ASCII control chars stripped); the run-start
    // observation keys the cache with the SAME normalized name. Pre-fix the
    // gate looked up the RAW key while the observation recorded the
    // stripped one → the resolved name re-asked forever.
    const rawName = 'au\u0000dit'
    const normalized = 'audit'

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec(rawName), defaultAllow)
    expect(first.kind).toBe('ask')
    if (first.kind !== 'ask') throw new Error('expected ask')
    // The ask's identity (and the verdict row) is the NORMALIZED name —
    // the gate speaks one identity everywhere.
    expect(first.reason).toContain(normalized)
    expect(ledgerEvents(app)[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ask', workflow: normalized, mode: 'ask' })

    // The human approves: the call runs → the durable run-start lands with
    // the name as the tool received it (raw, control char included). The
    // consumer records `allow` under the NORMALIZED key — the same key the
    // gate used for the ask.
    sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-ctrl-e2e', name: rawName })
    expect(app.ctx.dshHostAdapter.workflowAskCache.get(normalized)).toBe('allow')
    // The RAW key is never recorded — congruence comes from the shared
    // normalization, not from storing both spellings.
    expect(app.ctx.dshHostAdapter.workflowAskCache.get(rawName)).toBeUndefined()

    // Second same-name call: the cached allow is reused — NO re-ask.
    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec(rawName), defaultAllow)
    expect(second).toEqual({ kind: 'allow' })
    expect(ledgerEvents(app)[0]).toMatchObject({ kind: 'workflow-verdict', verdict: 'ok', workflow: normalized, mode: 'ask' })
  })

  it('(14) ask answered deny → call denied, NO run rows, next call re-asks (fail-closed — no grant evidence, never an invented allow)', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', sessionsService: 'fake', seedV2: true })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-deny-e2e', app.root)
    sessions.register(parent)

    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(first.kind).toBe('ask')
    expect(ledgerEvents(app).map((e) => e.kind)).toEqual(['workflow-verdict'])

    // The human DENIES: the upstream approval waterfall refuses the call —
    // the gate never sees the answer (the registry's serviceAsk consumes
    // the approval result internally) and the workflow never runs. The
    // observable gate-side facts of a denied ask: NO run-start event, NO
    // W-B2 run rows, NO cache entry (no grant evidence).
    expect(ledgerEvents(app).filter((e) => e.kind === 'workflow-run')).toHaveLength(0)
    expect(app.ctx.dshHostAdapter.workflowAskCache.get('deploy-x')).toBeUndefined()

    // Next same-name call: still unresolved → the gate ASKS again
    // (fail-closed — it never invents an allow OR a deny from a missing
    // answer; a grant must be observed, never assumed).
    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec('deploy-x'), defaultAllow)
    expect(second.kind).toBe('ask')
    expect(ledgerEvents(app).map((e) => e.kind)).toEqual(['workflow-verdict', 'workflow-verdict'])
  })

  it('(15) name exceeding MAX_NAME still gate-keys consistently: the cache key is the UNCAPPED full name on both seams (the ledger ROW display name is capped separately)', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', sessionsService: 'fake', seedV2: true })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-long-e2e', app.root)
    sessions.register(parent)
    const longName = `long-${'x'.repeat(1100)}` // > WORKFLOW_LEDGER_MAX_NAME_LENGTH (1024)

    // The gate path never caps ids: the full name IS the allowlist/ask
    // identity. First-seen → ask (the reason carries the full name).
    const first = await app.ctx.waterfall('tools/pre-execute', workflowExec(longName), defaultAllow)
    expect(first.kind).toBe('ask')
    if (first.kind !== 'ask') throw new Error('expected ask')
    expect(first.reason).toContain(longName)

    // Approval → run-start lands → the consumer records `allow` keyed on
    // the UNCAPPED runName (`row.runName` — never the capped row field).
    sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-long-e2e', name: longName })
    expect(app.ctx.dshHostAdapter.workflowAskCache.get(longName)).toBe('allow')
    // The ledger ROW's display name IS capped (1024 + '…') — the cap is
    // display-only, the cache identity stays the full name (pins the
    // uncapped congruence explicitly).
    const runRow = ledgerEvents(app).find((e) => e.kind === 'workflow-run')
    expect(runRow).toBeDefined()
    if (runRow === undefined) throw new Error('expected workflow-run row')
    expect(runRow.name).not.toBe(longName)
    expect(runRow.name).toMatch(/…$/)

    // Second same-name call: the uncapped congruence holds — the cached
    // allow reuses the full-name key, NO re-ask.
    const second = await app.ctx.waterfall('tools/pre-execute', workflowExec(longName), defaultAllow)
    expect(second).toEqual({ kind: 'allow' })
  })

  it('(16) W-1: a run observed before any ask is never cached — the ask channel survives a P-b-uncovered window (ask mode still asks after recovery)', async () => {
    const ws = await makeHarnessWorkspace('dsh-ws-w1-')
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(IN_PROGRESS_ORPHAN) })
    const app = booted = await bootApp({ workflowGate: 'ask', harnessDir: null, sessionsService: 'fake' })
    const sessions = app.ctx.get('sessions') as unknown as FakeSessionsRegistry
    const parent = parentSession('parent-w1-e2e', ws)
    sessions.register(parent)

    // The P-b red line preempts P-c: the name is NEVER asked (advisory warn
    // verdict under ask mode, not an ask) — but the call RUNS, so the
    // durable run-start lands in the parent session log.
    const first = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)
    expect(first).toEqual({ kind: 'allow' })
    sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-w1-e2e', name: 'deploy-x' })

    // W-1: never asked ⇒ never cached — the observation must NOT promote the
    // run to allow (a P-b advisory run is not an approval resolution).
    expect(app.ctx.dshHostAdapter.workflowAskCache.get('deploy-x')).toBeUndefined()

    // The workspace is recovered (the orphan plan is resolved): P-b passes.
    await seedHarness(join(ws, '.agents'), { 'status.json': statusDoc(DONE_NO_LEASE) })

    // Ask mode keeps its promise for the never-resolved name: ASK again —
    // the pre-ask run did not pre-authorize it.
    const second = await app.ctx.waterfall('tools/pre-execute', workflowExecFrom('deploy-x', ws), defaultAllow)
    expect(second.kind).toBe('ask')
  })

  it('(17) WorkflowAskCache record + markAsked normalize keys internally (F-302 doc contract; wasAsked matches raw spellings)', async () => {
    const app = booted = await bootApp({ workflowGate: 'ask', seedV2: true })
    const cache = app.ctx.dshHostAdapter.workflowAskCache

    // F-302: the explicit record() seam stores under the STRIPPED key — a
    // raw-key record is never consulted by the normalized gate lookups.
    cache.record('au\u0000dit', 'allow')
    expect(cache.get('audit')).toBe('allow')
    expect(cache.get('au\u0000dit')).toBeUndefined()

    // W-1: markAsked/wasAsked normalize identically — raw spellings match
    // the marked identity (the observation feeds the run name through the
    // same shared normalization before either call).
    cache.markAsked('deploy-x\u0000')
    expect(cache.wasAsked('deploy-x')).toBe(true)
    expect(cache.wasAsked('deploy-x\u0000')).toBe(true)
    expect(cache.wasAsked('other-x')).toBe(false)
  })

  it('(18) W-2: ralph objective with control chars is stripped at the verdict-row write boundary (hostile objective never reaches the ledger view)', async () => {
    const app = booted = await bootApp({ seedV2: true })

    // A hostile objective: NUL + BEL embedded in the model-controlled text.
    // The JSONL line is line-safe (JSON.stringify escapes), but the panel
    // view passes the objective through raw — the write boundary must strip
    // the control chars (same discipline as the name/label/phase fields).
    const decision = await app.ctx.waterfall('tools/pre-execute', ralphExec('probe \u0000the\u0007 codebase'), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    const events = ledgerEvents(app)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'workflow-verdict',
      tool: 'ralph',
      objective: 'probe the codebase',
      mode: 'warn',
      verdict: 'ok',
    })
  })
})
