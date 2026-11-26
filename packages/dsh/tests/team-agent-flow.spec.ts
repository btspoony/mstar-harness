/**
 * The agent-flow ledger on the rc.3 Agent Teams surface.
 *
 * A teammate IS an ordinary continuable `subagent` / `subagent_fork` child, so
 * the ledger's pairing has nothing team-specific left in it:
 *
 * - the creation call returns `{ kind: 'activation', name }` — STARTED, not
 *   settled — and the name resolves to a child `SessionId` through the subagent
 *   surface (`ctx.get('subagents').resolveName`);
 * - that child's `subagent/end` is the ONLY completion the ledger records, in
 *   either order: the end after the tool return, or the end racing the async
 *   name resolution (kept and reconciled, never dropped);
 * - the remaining Team carriers are the shared board and the inbox —
 *   `team_task_create`, `team_task_update`, `send_message` — and none of them
 *   is a delegation completion.
 *
 * So no Team carrier settles at tool return: an activation settles on its
 * child's end, every other shape records an EXPLICIT unresolved continuation
 * (`kind: 'continuation'`, `state: 'unresolved'`) instead of a fabricated
 * `ok`, the call pairing entry is consumed on every path (no unbounded
 * `dispatchByCallId`, no cross-call mis-settle), a board/inbox call reserves no
 * call-window catalog slot, and an absent Team layer records nothing at all.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDshLedgerWindow } from '@mstar-harness/engine'
import {
  AGENT_FLOW_ACTIVATION_END_CAPACITY,
  AGENT_FLOW_TEAM_CHILD_CAPACITY,
  readAgentFlow,
  recordDispatch,
  registerSettleListener,
  SETTLE_SEAM,
  setAgentFlowLogger,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowDispatchRef, AgentFlowPairing } from '../src/gates/agent-flow.ts'
import {
  activationTick,
  bootApp,
  provideTeamServices,
  seedActiveWorkflow,
  selectedGenerationFor,
  type BootResult,
} from './harness.ts'

const roots: string[] = []
let booted: BootResult | undefined
afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/* ---------------------------------- fixtures ---------------------------------- */

/** A fully valid Assignment — the dispatch row is what every case starts from. */
const ASSIGNMENT = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
---

Do the thing.
`

/** The `subagent` / `subagent_fork` call shape (the ONLY teammate-creating channel). */
const subagentExec = (callId: string, prompt = ASSIGNMENT, name = 'subagent'): unknown => ({
  callId,
  name,
  agent: { id: 'session-1' },
  arguments: { description: 'Review the diff.', prompt },
})

/** The installed rc.3 creation result: the child is STARTED, never settled. */
const activationResult = (name = 'reviewer'): unknown => ({ isError: false, value: { kind: 'activation', name } })

/** One Team carrier call: the tool name plus its Assignment-bearing arguments. */
const carrierExec = (name: 'team_task_create' | 'team_task_update' | 'send_message', callId: string): unknown => ({
  callId,
  name,
  agent: { id: 'session-1' },
  arguments: name === 'team_task_create'
    ? { subject: 'Review the change', description: ASSIGNMENT }
    : name === 'team_task_update'
      ? { task_id: 'T-1', expected_revision: 2, action: 'edit', description: ASSIGNMENT }
      : { target: 'reviewer', message: ASSIGNMENT },
})

async function activeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-agent-flow-'))
  roots.push(root)
  const harnessDir = join(root, '.mstar')
  await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, 'session-1', root)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows', 'wf-1'), selectedGeneration: selectedGenerationFor(harnessDir) }
}

function newPairing(): AgentFlowPairing {
  // `teamDispatchByChildId` mirrors the production pairing store (the entry
  // apply always initializes it); the activation reconcile stores stay LAZY —
  // the pairing path creates them only when a child end actually races.
  return { dispatchByCallId: new Map(), dispatchByJobId: new Map(), teamDispatchByChildId: new Map(), catalogBySession: new WeakMap() }
}

const emit = (ctx: Context, event: string, ...args: unknown[]): void =>
  (ctx as unknown as { emit(name: string, ...rest: unknown[]): void }).emit(event, ...args)

/**
 * Drive one `subagent/end` edge through the REAL upstream emission shape: the
 * lifecycle emitter converts the live direct parent into a `scopeTarget` carrier
 * riding as `dispatchArgs[0]`, cordis `dispatch` shifts that carrier as the
 * listener `this`, and every callback is invoked with `(info)` ALONE.
 */
const emitLifecycleEnd = (ctx: Context, info: unknown, parent?: unknown): void => {
  const dispatchArgs = parent === undefined
    ? ['subagent/end', info]
    : [scopeTarget({} as object, parent as object), 'subagent/end', info]
  const events = (ctx as unknown as { events: { dispatch(type: string, args: unknown[]): ((...args: unknown[]) => unknown)[] } }).events
  for (const callback of events.dispatch('emit', dispatchArgs)) callback(info)
}

interface LedgerRow {
  kind?: string
  state?: string
  reason?: string
  role?: string
  childId?: string
  outcome?: string
  callId?: string
  eventId?: string
}

/** Parse the native ledger window (the durable row is what "carries" a marker). */
const ledgerRows = (harnessDir: string, workflowId = 'wf-1'): LedgerRow[] =>
  (readDshLedgerWindow({ harnessDir }, workflowId, 100) ?? []).map((line) => JSON.parse(line) as LedgerRow)

const state = (pairing: AgentFlowPairing) => ({
  call: pairing.dispatchByCallId.size,
  child: pairing.teamDispatchByChildId?.size ?? 0,
})

/** Record one dispatch on a fresh ACTIVE fixture, returning the store handles the case needs. */
async function recordDispatchOnFixture(exec: unknown) {
  const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
  const pairing = newPairing()
  recordDispatch({ harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration, exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false })
  return { harnessDir, workflowDir, selectedGeneration, pairing }
}

/** Record one dispatch against an already-created fixture (the pre-execute half). */
function recordOn(fixture: Awaited<ReturnType<typeof activeFixture>>, exec: unknown, pairing: AgentFlowPairing): void {
  recordDispatch({
    harnessDir: fixture.harnessDir,
    workflowId: 'wf-1',
    resolvedWorkflowDir: fixture.workflowDir,
    selectedGeneration: fixture.selectedGeneration,
    exec,
    pairing,
    prompt: ASSIGNMENT,
    violations: [],
    hard: false,
  })
}

/** The settle rows of one fixture's ledger (the observable completion evidence). */
const settlesOf = (harnessDir: string): LedgerRow[] =>
  ledgerRows(harnessDir).filter((row) => row.kind === 'settle')

/* ------------------------------ activation pairing ------------------------------ */

describe('team agent flow — an activation settles on its child end, never at tool return', () => {
  it('records the dispatch at tool return and settles only when the child end arrives', async () => {
    const exec = subagentExec('call-1')
    const { harnessDir, workflowDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
    registerSettleListener(ctx, {}, pairing)
    expect(ledgerRows(harnessDir).map((row) => row.kind)).toEqual(['dispatch'])

    emit(ctx, SETTLE_SEAM, exec, activationResult())
    await activationTick()
    // STARTED, not settled: the dispatch row stands alone and the child is paired.
    expect(ledgerRows(harnessDir).map((row) => row.kind)).toEqual(['dispatch'])
    expect(state(pairing)).toEqual({ call: 0, child: 1 })

    emitLifecycleEnd(ctx, { id: 'child-1', stopReason: 'completed' })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.filter((row) => row.kind === 'settle')).toEqual([
      expect.objectContaining({ outcome: 'ok', role: 'fullstack-dev', childId: 'child-1' }),
    ])
    expect(rows.some((row) => row.kind === 'continuation')).toBe(false)
    expect(readAgentFlow(workflowDir, 'wf-1')?.events).toContainEqual(expect.objectContaining({
      kind: 'settle', outcome: 'ok', childId: 'child-1', role: 'fullstack-dev',
    }))
  })

  it('settles from an end that arrives before the async name resolution completes', async () => {
    const exec = subagentExec('call-early')
    const { harnessDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-early' }])
    registerSettleListener(ctx, {}, pairing)

    emit(ctx, SETTLE_SEAM, exec, activationResult())
    // The child's end beats the name → id resolution: no pairing entry exists
    // yet, so the record is kept against the parent's in-flight dispatch.
    emitLifecycleEnd(ctx, { id: 'child-early', stopReason: 'completed', parentSessionId: 'session-1' })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    expect(ledgerRows(harnessDir).some((row) => row.kind === 'settle')).toBe(false)

    await activationTick()
    // Reconciled from the kept end: one settle, nothing else.
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.filter((row) => row.kind === 'settle')).toEqual([
      expect.objectContaining({ outcome: 'ok', childId: 'child-early', role: 'fullstack-dev' }),
    ])
    expect(rows.some((row) => row.kind === 'continuation')).toBe(false)
  })

  it('maps the child stop reasons truthfully (aborted → denied, error → error)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'a', childId: 'child-aborted' }, { name: 'b', childId: 'child-errored' }])
    registerSettleListener(ctx, {}, pairing)
    for (const [callId, name] of [['call-a', 'a'], ['call-b', 'b']] as const) {
      const exec = subagentExec(callId)
      recordDispatch({ harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration, exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false })
      emit(ctx, SETTLE_SEAM, exec, activationResult(name))
    }
    await activationTick()
    expect(state(pairing)).toEqual({ call: 0, child: 2 })
    emitLifecycleEnd(ctx, { id: 'child-aborted', stopReason: 'aborted' })
    emitLifecycleEnd(ctx, { id: 'child-errored', stopReason: 'error' })
    const settles = ledgerRows(harnessDir).filter((row) => row.kind === 'settle')
    expect(settles).toContainEqual(expect.objectContaining({ outcome: 'denied', childId: 'child-aborted' }))
    expect(settles).toContainEqual(expect.objectContaining({ outcome: 'error', childId: 'child-errored' }))
  })

  it('records the explicit unresolved continuation when the returned name does not resolve', async () => {
    const exec = subagentExec('call-orphan')
    const { harnessDir, workflowDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    provideTeamServices(ctx, []) // the created child is not in the subagent catalog
    registerSettleListener(ctx, {}, pairing)

    emit(ctx, SETTLE_SEAM, exec, activationResult('reviewer'))
    await activationTick()
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    const continuation = rows.find((row) => row.kind === 'continuation')
    expect(continuation).toMatchObject({ kind: 'continuation', state: 'unresolved', role: 'fullstack-dev' })
    expect(continuation?.reason).toContain('reviewer')
    // The call-scoped attribution identity: the row carries the paired dispatch's
    // live call id, so a reader pairs it onto ITS dispatch, never a later one.
    expect(continuation?.callId).toBe('call-orphan')
    const view = readAgentFlow(workflowDir, 'wf-1')
    expect(view?.events.map((event) => event.kind)).toEqual(['continuation', 'dispatch'])
    expect(view?.events.find((event) => event.kind === 'continuation')).toMatchObject({
      state: 'unresolved',
      reason: expect.stringContaining('reviewer'),
      callId: 'call-orphan',
    })
  })

  it('records the unresolved continuation when the resolved id is not a real child of this session', async () => {
    const exec = subagentExec('call-not-child')
    const { harnessDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    // resolveName ECHOES an id here that the subagent tree does not contain:
    // an id alone is not a child that can ever emit `subagent/end`.
    ctx.provide('agentTeams' as never, { isEnabled: () => false, setEnabled: () => {} } as never)
    ctx.provide('subagents' as never, {
      namesOf: () => undefined,
      resolveName: () => 'foreign-child',
      listDescendants: () => [],
    } as never)
    registerSettleListener(ctx, {}, pairing)

    emit(ctx, SETTLE_SEAM, exec, activationResult('reviewer'))
    await activationTick()
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')?.reason).toContain('not a child of this session')
  })

  it('settles error when the creating call itself failed (no child was started)', async () => {
    const exec = subagentExec('call-failed')
    const { harnessDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
    registerSettleListener(ctx, {}, pairing)

    emit(ctx, SETTLE_SEAM, exec, { isError: true, value: undefined })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.filter((row) => row.kind === 'settle')).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(rows.some((row) => row.kind === 'continuation')).toBe(false)
  })

  it('records the explicit unresolved continuation for an unrecognized child stop reason', async () => {
    const exec = subagentExec('call-1')
    const { harnessDir, pairing } = await recordDispatchOnFixture(exec)
    const ctx = new Context()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
    registerSettleListener(ctx, {}, pairing)

    emit(ctx, SETTLE_SEAM, exec, activationResult())
    await activationTick()
    emitLifecycleEnd(ctx, { id: 'child-1', stopReason: 'something-new' })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')?.reason).toContain('something-new')
  })
})

/* ------------------------------ board and inbox carriers ------------------------------ */

describe('team agent flow — the board and the inbox are never delegation completions', () => {
  for (const name of ['team_task_create', 'team_task_update', 'send_message'] as const) {
    it(`${name} records a dispatch plus the unresolved continuation, never a settle`, async () => {
      const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
      const ctx = new Context()
      const pairing = newPairing()
      provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
      registerSettleListener(ctx, {}, pairing)
      const exec = carrierExec(name, `call-${name}`)
      recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
      })

      emit(ctx, SETTLE_SEAM, exec, { isError: false, value: { ok: true } })
      expect(state(pairing)).toEqual({ call: 0, child: 0 })
      const rows = ledgerRows(harnessDir)
      expect(rows.some((row) => row.kind === 'settle')).toBe(false)
      const continuation = rows.find((row) => row.kind === 'continuation')
      expect(continuation).toMatchObject({ kind: 'continuation', state: 'unresolved', role: 'fullstack-dev' })
      expect(continuation?.reason).toContain('not delegation completions')
    })
  }

  it('a failed board call settles error (the write provably did not land)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
    registerSettleListener(ctx, {}, pairing)
    const exec = carrierExec('team_task_create', 'call-board-failed')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })

    emit(ctx, SETTLE_SEAM, exec, { isError: true, value: undefined })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    expect(ledgerRows(harnessDir).filter((row) => row.kind === 'settle')).toEqual([
      expect.objectContaining({ outcome: 'error' }),
    ])
  })

  it('records nothing for a Team carrier while the Team layer is absent', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const pairing = newPairing()
    const warnings: string[] = []
    const previous = setAgentFlowLogger((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    try {
      expect(() => recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec: carrierExec('team_task_create', 'call-1'), pairing, prompt: ASSIGNMENT, violations: [], hard: false,
      })).not.toThrow()
      expect(ledgerRows(harnessDir)).toEqual([])
      expect(pairing.dispatchByCallId.size).toBe(0)
      expect(pairing.teamDispatchByChildId?.size ?? 0).toBe(0)
      expect(warnings).toEqual([])
    } finally {
      setAgentFlowLogger(previous)
    }
  })

  it('records the board carrier without a subagent surface: its presence gate is the Team layer, not member identity', async () => {
    // The Team probe (`agentTeams`) and the subagent surface (`subagents`) are
    // independent: a composition mounting the board but no subagent-tree reads
    // still records the board call — and names the continuation it cannot pair.
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    ctx.provide('agentTeams' as never, { isEnabled: () => false, setEnabled: () => {} } as never)
    registerSettleListener(ctx, {}, pairing)
    const exec = carrierExec('team_task_create', 'call-board-only')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, { isError: false, value: { ok: true } })
    const rows = ledgerRows(harnessDir)
    expect(rows.map((row) => row.kind).sort()).toEqual(['continuation', 'dispatch'])
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
  })
})

/* ------------------------------ bounded state / cross-call safety ------------------------------ */

describe('team agent flow — bounded pairing state and cross-call safety', () => {
  it('consumes the call entry on every activation post-execute (no unbounded growth)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'a', childId: 'child-a' }, { name: 'b', childId: 'child-b' }, { name: 'c', childId: 'child-c' }])
    registerSettleListener(ctx, {}, pairing)
    for (const [callId, name] of [['c1', 'a'], ['c2', 'b'], ['c3', 'c']] as const) {
      const exec = subagentExec(callId)
      recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false,
      })
      expect(state(pairing).call).toBe(1)
      emit(ctx, SETTLE_SEAM, exec, activationResult(name))
      expect(state(pairing).call).toBe(0)
      await activationTick()
      emitLifecycleEnd(ctx, { id: `child-${name}`, stopReason: 'completed' })
      expect(state(pairing).child).toBe(0)
    }
    expect(ledgerRows(harnessDir).filter((row) => row.kind === 'settle')).toHaveLength(3)
  })

  it('a later subagent call with a colliding per-message call id never consumes the board dispatch', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-1' }])
    registerSettleListener(ctx, {}, pairing)
    const boardExec = carrierExec('team_task_create', 'call-0')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec: boardExec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    // Same session + SAME raw call id, different tool: the pairing key carries
    // the tool name, so this call can never consume the board ref.
    emit(ctx, SETTLE_SEAM, subagentExec('call-0'), activationResult('reviewer'))
    await activationTick()
    expect(state(pairing)).toEqual({ call: 1, child: 0 })
    expect(ledgerRows(harnessDir).some((row) => row.kind === 'settle')).toBe(false)

    emit(ctx, SETTLE_SEAM, boardExec, { isError: false, value: { ok: true } })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    expect(ledgerRows(harnessDir).some((row) => row.kind === 'settle')).toBe(false)
  })

  it('never reserves a call-window catalog slot for a Team carrier', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const pairing = newPairing()
    const session = { id: 'session-1', seq: 1, eventAt: () => undefined }
    const exec = {
      callId: 'call-1',
      name: 'team_task_create',
      agent: { id: 'session-1', session },
      arguments: { subject: 'Review the change', description: ASSIGNMENT },
    }
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    expect(pairing.catalogBySession.get(session)).toBeUndefined()
  })

  it('an unknown exec-bound name records its dispatch but leaves NO pairing entry', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const pairing = newPairing()
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec: { callId: 'call-x', name: 'mystery_delegate', agent: { id: 'session-1' } },
      pairing, prompt: ASSIGNMENT, violations: [], hard: false,
    })
    expect(pairing.dispatchByCallId.size).toBe(0)
    expect(ledgerRows(harnessDir).map((row) => row.kind)).toEqual(['dispatch'])
  })

  it('bounds the child map: the oldest pairing is evicted with an explicit continuation row', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'new', childId: 'child-new' }])
    const base = { harnessDir, workflowId: 'wf-1', workflowDir, selectedGeneration, role: 'fullstack-dev' }
    const filled = new Map<string, AgentFlowDispatchRef>()
    for (let index = 0; index < AGENT_FLOW_TEAM_CHILD_CAPACITY; index += 1) {
      filled.set(`old-${index}`, { ...base, agent: 'session-1', callId: `old-call-${index}` })
    }
    pairing.teamDispatchByChildId = filled
    registerSettleListener(ctx, {}, pairing)
    const exec = subagentExec('call-new')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false,
    })
    emit(ctx, SETTLE_SEAM, exec, activationResult('new'))
    await activationTick()
    expect(pairing.teamDispatchByChildId?.size).toBe(AGENT_FLOW_TEAM_CHILD_CAPACITY)
    expect(pairing.teamDispatchByChildId?.has('child-new')).toBe(true)
    expect(pairing.teamDispatchByChildId?.has('old-0')).toBe(false)
    expect(ledgerRows(harnessDir).find((row) => row.kind === 'continuation')?.state).toBe('unresolved')
  })
})

/* ------------------------------ early-end admission (R-1) ------------------------------ */

describe('team agent flow — early-end admission keeps genuine ends and is honest at the capacity', () => {
  it('settles a genuine early end beside an unclaimable record of the same parent (R-1)', async () => {
    const fixture = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'a', childId: 'child-a' }, { name: 'b', childId: 'child-b' }])
    registerSettleListener(ctx, {}, pairing)
    const first = subagentExec('call-a')
    const second = subagentExec('call-b')
    recordOn(fixture, first, pairing)
    recordOn(fixture, second, pairing)

    // Two overlapping in-flight dispatches of ONE parent. A child no ref can
    // ever claim arrives first and is admitted (a legitimate leftover), then the
    // first dispatch's call window closes and its name resolves.
    emitLifecycleEnd(ctx, { id: 'child-stray', stopReason: 'completed', parentSessionId: 'session-1' })
    emit(ctx, SETTLE_SEAM, first, activationResult('a'))
    await activationTick()
    // The second dispatch's child end beats its own async name resolution.
    emit(ctx, SETTLE_SEAM, second, activationResult('b'))
    emitLifecycleEnd(ctx, { id: 'child-b', stopReason: 'completed', parentSessionId: 'session-1' })
    await activationTick()
    // The first child's end arrives after its pairing (the live settle path).
    emitLifecycleEnd(ctx, { id: 'child-a', stopReason: 'completed' })

    // Both dispatches settle exactly once, attributed to their own child and
    // call id; the stray leftover never costs the genuine early end.
    // (The native window is latest-first, so order the rows by child id.)
    expect(settlesOf(fixture.harnessDir).sort((a, b) => String(a.childId).localeCompare(String(b.childId)))).toEqual([
      expect.objectContaining({ outcome: 'ok', childId: 'child-a', role: 'fullstack-dev', callId: 'call-a' }),
      expect.objectContaining({ outcome: 'ok', childId: 'child-b', role: 'fullstack-dev', callId: 'call-b' }),
    ])
    expect(ledgerRows(fixture.harnessDir).some((row) => row.kind === 'continuation')).toBe(false)
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
  })

  it('settles the FIRST end when a later turn ends before the name resolves', async () => {
    const fixture = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'reviewer', childId: 'child-turn' }])
    registerSettleListener(ctx, {}, pairing)
    const exec = subagentExec('call-turn')
    recordOn(fixture, exec, pairing)

    // The creating dispatch starts; its own child ends with `completed`, then
    // the parent wakes the same teammate and that later turn ends with `error`
    // — all before the async name resolution lands.
    emit(ctx, SETTLE_SEAM, exec, activationResult('reviewer'))
    emitLifecycleEnd(ctx, { id: 'child-turn', stopReason: 'completed', parentSessionId: 'session-1' })
    emitLifecycleEnd(ctx, { id: 'child-turn', stopReason: 'error', parentSessionId: 'session-1' })

    await activationTick()

    // The creating dispatch settles from the turn IT started: a later wake-up
    // must never rewrite its outcome.
    const rows = settlesOf(fixture.harnessDir)
    expect(rows).toEqual([
      expect.objectContaining({ outcome: 'ok', childId: 'child-turn', role: 'fullstack-dev' }),
    ])
    expect(ledgerRows(fixture.harnessDir).some((row) => row.kind === 'continuation')).toBe(false)
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
  })

  it('evicts the oldest early end at the capacity and records the explicit unresolved continuation', async () => {
    const fixture = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamServices(ctx, [{ name: 'evicted', childId: 'evict-0' }])
    registerSettleListener(ctx, {}, pairing)
    const warnings: string[] = []
    const previous = setAgentFlowLogger((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    try {
      // One in-flight dispatch keeps the parent's window open while its scope
      // fills past the capacity with ends no ref can claim.
      recordOn(fixture, subagentExec('call-window'), pairing)
      for (let index = 0; index <= AGENT_FLOW_ACTIVATION_END_CAPACITY; index += 1) {
        emitLifecycleEnd(ctx, { id: `evict-${index}`, stopReason: 'completed', parentSessionId: 'session-1' })
      }
      // The dispatch that created the EVICTED child resolves its name late.
      const exec = subagentExec('call-evicted')
      recordOn(fixture, exec, pairing)
      emit(ctx, SETTLE_SEAM, exec, activationResult('evicted'))
      await activationTick()

      // The oldest record was evicted with a warn naming it.
      expect(warnings.some((message) => message.includes('evict-0') && message.includes('evicted at the early-end capacity'))).toBe(true)
      // The eventual dispatch is honest: ONE explicit unresolved continuation
      // naming the capacity, and no fabricated settle.
      const rows = ledgerRows(fixture.harnessDir)
      expect(rows.some((row) => row.kind === 'settle')).toBe(false)
      expect(rows.filter((row) => row.kind === 'continuation')).toEqual([
        expect.objectContaining({
          state: 'unresolved',
          role: 'fullstack-dev',
          callId: 'call-evicted',
          reason: expect.stringContaining('evicted at the early-end capacity'),
        }),
      ])
    } finally {
      setAgentFlowLogger(previous)
    }
  })

  it('settles the same child end exactly once whether it beats or follows the name resolution', async () => {
    // Order A — the end beats the async name resolution (reconciled).
    const early = await activeFixture()
    const earlyCtx = new Context()
    const earlyPairing = newPairing()
    provideTeamServices(earlyCtx, [{ name: 'reviewer', childId: 'child-early' }])
    registerSettleListener(earlyCtx, {}, earlyPairing)
    const earlyExec = subagentExec('call-early')
    recordOn(early, earlyExec, earlyPairing)
    emit(earlyCtx, SETTLE_SEAM, earlyExec, activationResult())
    emitLifecycleEnd(earlyCtx, { id: 'child-early', stopReason: 'completed' })
    await activationTick()
    // A re-woken child's later end is the same child: never a second settle.
    emitLifecycleEnd(earlyCtx, { id: 'child-early', stopReason: 'completed' })
    expect(settlesOf(early.harnessDir)).toEqual([
      expect.objectContaining({ outcome: 'ok', childId: 'child-early', role: 'fullstack-dev' }),
    ])
    expect(state(earlyPairing)).toEqual({ call: 0, child: 0 })

    // Order B — the end follows the pairing write (the keyed-by-child path).
    const late = await activeFixture()
    const lateCtx = new Context()
    const latePairing = newPairing()
    provideTeamServices(lateCtx, [{ name: 'reviewer', childId: 'child-late' }])
    registerSettleListener(lateCtx, {}, latePairing)
    const lateExec = subagentExec('call-late')
    recordOn(late, lateExec, latePairing)
    emit(lateCtx, SETTLE_SEAM, lateExec, activationResult())
    await activationTick()
    emitLifecycleEnd(lateCtx, { id: 'child-late', stopReason: 'completed' })
    emitLifecycleEnd(lateCtx, { id: 'child-late', stopReason: 'completed' })
    expect(settlesOf(late.harnessDir)).toEqual([
      expect.objectContaining({ outcome: 'ok', childId: 'child-late', role: 'fullstack-dev' }),
    ])
    expect(state(latePairing)).toEqual({ call: 0, child: 0 })
  })
})

/* ------------------------------ the real composition (ACTIVE workflow seeded) ------------------------------ */

/** A fully valid writable Assignment (the positive-control shape the dispatch specs use). */
const VALID_WRITABLE = `---
execute_as: fullstack-dev
delegation: forbidden
task_category: logic
working_branch: feature/team-ledger
task_budget: S — one focused implementer round
---

Do the thing, evidence-first.
`

/** The registry pipeline shape of one pending creation call. */
function pipelineExec(callId: string, agent: unknown): unknown {
  return {
    callId,
    name: 'subagent',
    agent,
    arguments: { description: 'Review the diff.', prompt: VALID_WRITABLE },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution'),
  }
}

/** The carrying session identity the durable binding store is keyed by. */
const sessionAgent = (sessionId: string, cwd: string): unknown => ({ id: sessionId, session: { header: { id: sessionId, cwd } } })

describe('team agent flow — an ACTIVE-workflow-seeded activation resolves or is explicitly unresolved', () => {
  it('records the dispatch through the real gate, then settles it on the child end (no silent leak)', async () => {
    const app = booted = await bootApp()
    await seedActiveWorkflow(app.harnessDir, 'wf-team', [], {}, 'sess-team', app.root)
    provideTeamServices(app.ctx, [{ name: 'reviewer', childId: 'child-live' }])
    const exec = pipelineExec('call-live', sessionAgent('sess-team', app.root))

    expect(await app.ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    expect(ledgerRows(app.harnessDir, 'wf-team').map((row) => row.kind)).toEqual(['dispatch'])

    emit(app.ctx, SETTLE_SEAM, exec, activationResult())
    await activationTick()
    expect(ledgerRows(app.harnessDir, 'wf-team').map((row) => row.kind)).toEqual(['dispatch'])

    emitLifecycleEnd(app.ctx, { id: 'child-live', stopReason: 'completed' })
    const rows = ledgerRows(app.harnessDir, 'wf-team')
    expect(rows.filter((row) => row.kind === 'settle')).toContainEqual(
      expect.objectContaining({ outcome: 'ok', childId: 'child-live', role: 'fullstack-dev' }),
    )
    expect(rows.some((row) => row.kind === 'continuation')).toBe(false)
  })

  it('records an explicit unresolved continuation when the created child is not resolvable', async () => {
    const app = booted = await bootApp()
    await seedActiveWorkflow(app.harnessDir, 'wf-team-orphan', [], {}, 'sess-orphan', app.root)
    provideTeamServices(app.ctx, [])
    const exec = pipelineExec('call-orphan', sessionAgent('sess-orphan', app.root))

    expect(await app.ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    emit(app.ctx, SETTLE_SEAM, exec, activationResult())
    await activationTick()

    const rows = ledgerRows(app.harnessDir, 'wf-team-orphan')
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')).toMatchObject({ state: 'unresolved', role: 'fullstack-dev' })
  })
})

/**
 * ------------------- D16 legacy body-label regression -------------------
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */

describe('team agent flow — the retired body-label grammar is inert in the ledger', () => {
  it('a body-label Assignment records no derived fields (the only legacy fixture)', async () => {
    // D16 regression — the ONE body-label fixture of this spec: the dispatch
    // gate refuses the retired `**Label**` grammar upstream, so its ledger
    // mirror is a dispatch row with NO derived role/category/plan fields.
    // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const LEGACY_BODY_LABEL = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec: subagentExec('call-legacy', LEGACY_BODY_LABEL),
      pairing: newPairing(),
      prompt: LEGACY_BODY_LABEL,
      violations: [],
      hard: false,
    })
    expect(readAgentFlow(workflowDir, 'wf-1')?.events).toEqual([
      expect.objectContaining({ kind: 'dispatch', role: '', taskCategory: null, planId: null }),
    ])
  })
})
