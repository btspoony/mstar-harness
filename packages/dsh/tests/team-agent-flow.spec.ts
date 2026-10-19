/**
 * Task 4 — the agent-flow ledger records Agent Teams dispatches without a
 * false settle.
 *
 * The official team surface behaves differently from `subagent` at every seam
 * the ledger consumes:
 *
 * - `spawn_teammate` returns as soon as the member is durable `active`; the
 *   member's TURN has not run yet, and the tool result deliberately strips the
 *   child SessionId (`{ member: { target } }`), so the roster read is the only
 *   verified name → child-session resolution;
 * - the member is an ordinary continuable subagent child, so its initial-turn
 *   settlement arrives later as the verified `subagent/end` event;
 * - `send_message` only means the target inbox ACCEPTED the message, and the
 *   task-board writes are not delegation completions at all;
 * - the experimental service is optional and may be absent entirely.
 *
 * The ledger must therefore never settle a team carrier at tool return. It
 * pairs `spawn_teammate` to its member child and settles on that child's
 * `subagent/end`; every other shape records an EXPLICIT unresolved
 * continuation (`kind: 'continuation'`, `state: 'unresolved'`) instead of a
 * fabricated `ok`, consumes the call pairing entry on every path (no unbounded
 * `dispatchByCallId`, no cross-call mis-settle), never reserves a call-window
 * catalog slot for a team call, and records nothing at all when the team
 * service is not mounted.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDshLedgerWindow } from '@mstar-harness/engine'
import {
  AGENT_FLOW_TEAM_CHILD_CAPACITY,
  readAgentFlow,
  recordDispatch,
  registerSettleListener,
  SETTLE_SEAM,
  setAgentFlowLogger,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowDispatchRef, AgentFlowPairing } from '../src/gates/agent-flow.ts'
import { bootApp, seedActiveWorkflow, selectedGenerationFor, type BootResult } from './harness.ts'

const roots: string[] = []
let booted: BootResult | undefined
afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/* ---------------------------------- fixtures ---------------------------------- */

/** A fully valid Assignment — the dispatch row is what every case starts from. */
const ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`

/** The `spawn_teammate` call shape (carrier = `prompt`). */
const spawnExec = (callId: string, prompt = ASSIGNMENT): unknown => ({
  callId,
  name: 'spawn_teammate',
  agent: { id: 'session-1' },
  arguments: { name: 'reviewer', description: 'Review the diff.', prompt, context: 'fresh' },
})

/** The REAL tool result shape: `member.target` (name) and NO child SessionId. */
const spawnResult = (target = 'reviewer', status = 'running'): unknown => ({
  isError: false,
  value: { member: { target, phase: 'active', status, description: 'Review the diff.' } },
})

/** A live member row as the service-side roster exposes it (with the child SessionId). */
const rosterRow = (id: string, name: string): unknown => ({
  id,
  name,
  role: 'teammate',
  status: 'running',
  phase: 'active',
  diagnostics: [],
})

async function activeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-agent-flow-'))
  roots.push(root)
  const harnessDir = join(root, '.agents')
  await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, 'session-1', root)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows', 'wf-1'), selectedGeneration: selectedGenerationFor(harnessDir) }
}

function newPairing(): AgentFlowPairing {
  return { dispatchByCallId: new Map(), dispatchByJobId: new Map(), catalogBySession: new WeakMap() }
}

/** Mount the optional service on the given context (a bare test Context or the booted app root). */
function provideTeamRoster(ctx: Context, members: readonly unknown[]): void {
  ctx.provide('agentTeams' as never, { listMembers: () => members } as never)
}

const emit = (ctx: Context, event: string, ...args: unknown[]): void =>
  (ctx as unknown as { emit(name: string, ...rest: unknown[]): void }).emit(event, ...args)

interface LedgerRow {
  kind?: string
  state?: string
  reason?: string
  role?: string
  childId?: string
  outcome?: string
  eventId?: string
}

/** Parse the native ledger window (the durable row is what "carries" a marker). */
const ledgerRows = (harnessDir: string, workflowId = 'wf-1'): LedgerRow[] =>
  (readDshLedgerWindow({ harnessDir }, workflowId, 100) ?? []).map((line) => JSON.parse(line) as LedgerRow)

const state = (pairing: AgentFlowPairing) => ({
  call: pairing.dispatchByCallId.size,
  child: pairing.teamDispatchByChildId?.size ?? 0,
})

/* ------------------------------ spawn_teammate pairing ------------------------------ */

describe('team agent flow — spawn_teammate is never settled at tool return', () => {
  it('pairs the roster member child and settles on the member turn (subagent/end), not on the tool return', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-1', 'reviewer')])
    registerSettleListener(ctx, {}, pairing)
    const exec = spawnExec('call-1')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    expect(ledgerRows(harnessDir).map((row) => row.kind)).toEqual(['dispatch'])

    emit(ctx, SETTLE_SEAM, exec, spawnResult())
    // The tool return is NOT a completion: dispatch only, no settle, and the
    // call entry is consumed while the member child is paired instead.
    expect(ledgerRows(harnessDir).map((row) => row.kind)).toEqual(['dispatch'])
    expect(state(pairing)).toEqual({ call: 0, child: 1 })

    emit(ctx, 'subagent/end', { id: 'child-1', stopReason: 'completed' })
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

  it('maps the member turn terminal stop reasons truthfully (aborted → denied, error → error)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-aborted', 'a'), rosterRow('child-errored', 'b')])
    registerSettleListener(ctx, {}, pairing)
    for (const [callId, name] of [['call-a', 'a'], ['call-b', 'b']] as const) {
      const exec = spawnExec(callId)
      recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
      })
      emit(ctx, SETTLE_SEAM, exec, spawnResult(name))
    }
    expect(state(pairing)).toEqual({ call: 0, child: 2 })
    emit(ctx, 'subagent/end', { id: 'child-aborted', stopReason: 'aborted' })
    emit(ctx, 'subagent/end', { id: 'child-errored', stopReason: 'error' })
    const settles = ledgerRows(harnessDir).filter((row) => row.kind === 'settle')
    expect(settles).toContainEqual(expect.objectContaining({ outcome: 'denied', childId: 'child-aborted' }))
    expect(settles).toContainEqual(expect.objectContaining({ outcome: 'error', childId: 'child-errored' }))
  })

  it('settles error when the spawn call itself failed (the member is provably gone) and pairs nothing', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [])
    registerSettleListener(ctx, {}, pairing)
    const exec = spawnExec('call-failed')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, { isError: true, value: undefined })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    expect(ledgerRows(harnessDir).filter((row) => row.kind === 'settle')).toContainEqual(
      expect.objectContaining({ outcome: 'error' }),
    )
  })
})

/* ------------------------------ explicit unresolved continuation ------------------------------ */

describe('team agent flow — an unpaired continuation is explicit, never an ok settle', () => {
  it('records `continuation`/`unresolved` when the member is not resolvable in the roster', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, []) // the created member is not listed — no child identity
    registerSettleListener(ctx, {}, pairing)
    const exec = spawnExec('call-orphan')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, spawnResult())
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    const continuation = rows.find((row) => row.kind === 'continuation')
    expect(continuation).toMatchObject({ kind: 'continuation', state: 'unresolved', role: 'fullstack-dev' })
    expect(continuation?.reason).toContain('reviewer')
    // Durable-only marker: the projected view keeps its existing kinds and
    // therefore still shows the dispatch as the last recorded fact.
    expect(readAgentFlow(workflowDir, 'wf-1')?.events.map((event) => event.kind)).toEqual(['dispatch'])
  })

  it('records `continuation`/`unresolved` for a non-member carrier (send_message acceptance is not a completion)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-1', 'reviewer')])
    registerSettleListener(ctx, {}, pairing)
    const exec = {
      callId: 'call-message',
      name: 'send_message',
      agent: { id: 'session-1' },
      arguments: { target: 'reviewer', message: ASSIGNMENT },
    }
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, { isError: false, value: { sent: true } })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')?.state).toBe('unresolved')
  })

  it('records `continuation`/`unresolved` for an unrecognized member stop reason', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-1', 'reviewer')])
    registerSettleListener(ctx, {}, pairing)
    const exec = spawnExec('call-1')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, spawnResult())
    emit(ctx, 'subagent/end', { id: 'child-1', stopReason: 'something-new' })
    expect(state(pairing)).toEqual({ call: 0, child: 0 })
    const rows = ledgerRows(harnessDir)
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')?.reason).toContain('something-new')
  })
})

/* ------------------------------ bounded state / cross-call safety ------------------------------ */

describe('team agent flow — bounded pairing state and cross-call safety', () => {
  it('consumes the call entry on every team post-execute (no unbounded growth)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-1', 'a'), rosterRow('child-2', 'b'), rosterRow('child-3', 'c')])
    registerSettleListener(ctx, {}, pairing)
    for (const [callId, name] of [['c1', 'a'], ['c2', 'b'], ['c3', 'c']] as const) {
      const exec = spawnExec(callId)
      recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
      })
      expect(state(pairing).call).toBe(1)
      emit(ctx, SETTLE_SEAM, exec, spawnResult(name))
      expect(state(pairing).call).toBe(0)
    }
  })

  it('a later non-gated subagent call with a colliding per-message call id never settles the team dispatch', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-1', 'reviewer')])
    registerSettleListener(ctx, {}, pairing)
    const teamExec = spawnExec('call-0')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec: teamExec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    // Same session + SAME raw call id, different tool: the pairing key carries
    // the tool name, so this can never consume the team ref.
    const collide = { callId: 'call-0', name: 'subagent', agent: { id: 'session-1' }, arguments: { description: 'probe', prompt: ASSIGNMENT } }
    emit(ctx, SETTLE_SEAM, collide, { isError: false, value: { kind: 'foreground', runId: 'wrong-child' } })
    expect(state(pairing)).toEqual({ call: 1, child: 0 })
    expect(ledgerRows(harnessDir).some((row) => row.kind === 'settle')).toBe(false)

    emit(ctx, SETTLE_SEAM, teamExec, spawnResult())
    expect(state(pairing)).toEqual({ call: 0, child: 1 })
    emit(ctx, 'subagent/end', { id: 'child-1', stopReason: 'completed' })
    expect(ledgerRows(harnessDir).filter((row) => row.kind === 'settle')).toContainEqual(
      expect.objectContaining({ outcome: 'ok', childId: 'child-1' }),
    )
  })

  it('never reserves a call-window catalog slot for a team call', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const pairing = newPairing()
    const session = { id: 'session-1', seq: 1, eventAt: () => undefined }
    const exec = {
      callId: 'call-1',
      name: 'spawn_teammate',
      agent: { id: 'session-1', session },
      arguments: { name: 'reviewer', description: 'Review the diff.', prompt: ASSIGNMENT },
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

  it('bounds the member-child map: the oldest pairing is evicted with an explicit continuation row', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing = newPairing()
    provideTeamRoster(ctx, [rosterRow('child-new', 'new')])
    const base = { harnessDir, workflowId: 'wf-1', workflowDir, selectedGeneration, role: 'fullstack-dev' }
    const filled = new Map<string, AgentFlowDispatchRef>()
    for (let index = 0; index < AGENT_FLOW_TEAM_CHILD_CAPACITY; index += 1) {
      filled.set(`old-${index}`, { ...base, agent: 'session-1', callId: `old-call-${index}` })
    }
    pairing.teamDispatchByChildId = filled
    registerSettleListener(ctx, {}, pairing)
    const exec = spawnExec('call-new')
    recordDispatch({
      harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
      exec, pairing, prompt: ASSIGNMENT, violations: [], hard: false, teamPresent: true,
    })
    emit(ctx, SETTLE_SEAM, exec, spawnResult('new'))
    expect(pairing.teamDispatchByChildId?.size).toBe(AGENT_FLOW_TEAM_CHILD_CAPACITY)
    expect(pairing.teamDispatchByChildId?.has('child-new')).toBe(true)
    expect(pairing.teamDispatchByChildId?.has('old-0')).toBe(false)
    expect(ledgerRows(harnessDir).find((row) => row.kind === 'continuation')?.state).toBe('unresolved')
  })
})

/* ------------------------------ absent service / ACTIVE workflow ------------------------------ */

describe('team agent flow — the optional team service', () => {
  it('records nothing for team tools while the service is absent, and never throws', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const pairing = newPairing()
    const warnings: string[] = []
    const previous = setAgentFlowLogger((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    try {
      expect(() => recordDispatch({
        harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration,
        exec: spawnExec('call-1'), pairing, prompt: ASSIGNMENT, violations: [], hard: false,
      })).not.toThrow()
      expect(ledgerRows(harnessDir)).toEqual([])
      expect(pairing.dispatchByCallId.size).toBe(0)
      expect(pairing.teamDispatchByChildId?.size ?? 0).toBe(0)
      expect(warnings).toEqual([])
    } finally {
      setAgentFlowLogger(previous)
    }
  })
})

/* ------------------------------ the real composition (ACTIVE workflow seeded) ------------------------------ */

/** A fully valid writable Assignment (the same positive-control shape the dispatch specs use). */
const VALID_WRITABLE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/team-ledger
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`

/** The registry pipeline shape of one pending tool call. */
function pipelineExec(callId: string, agent: unknown): unknown {
  return {
    callId,
    name: 'spawn_teammate',
    agent,
    arguments: { name: 'reviewer', description: 'Review the diff.', prompt: VALID_WRITABLE, context: 'fresh' },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution'),
  }
}

/** The carrying session identity the durable binding store is keyed by. */
const sessionAgent = (sessionId: string, cwd: string): unknown => ({ id: sessionId, session: { header: { id: sessionId, cwd } } })

describe('team agent flow — an ACTIVE-workflow-seeded team call resolves or is explicitly unresolved', () => {
  it('records the dispatch through the real gate, then resolves it on the member turn (no silent leak)', async () => {
    const app = booted = await bootApp()
    await seedActiveWorkflow(app.harnessDir, 'wf-team', [], {}, 'sess-team', app.root)
    provideTeamRoster(app.ctx, [rosterRow('child-live', 'reviewer')])
    const exec = pipelineExec('call-live', sessionAgent('sess-team', app.root))

    expect(await app.ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    expect(ledgerRows(app.harnessDir, 'wf-team').map((row) => row.kind)).toEqual(['dispatch'])

    emit(app.ctx, SETTLE_SEAM, exec, spawnResult())
    expect(ledgerRows(app.harnessDir, 'wf-team').map((row) => row.kind)).toEqual(['dispatch'])

    emit(app.ctx, 'subagent/end', { id: 'child-live', stopReason: 'completed' })
    const rows = ledgerRows(app.harnessDir, 'wf-team')
    expect(rows.filter((row) => row.kind === 'settle')).toContainEqual(
      expect.objectContaining({ outcome: 'ok', childId: 'child-live', role: 'fullstack-dev' }),
    )
    expect(rows.some((row) => row.kind === 'continuation')).toBe(false)
  })

  it('records an explicit unresolved continuation when the seeded member is not resolvable', async () => {
    const app = booted = await bootApp()
    await seedActiveWorkflow(app.harnessDir, 'wf-team-orphan', [], {}, 'sess-orphan', app.root)
    provideTeamRoster(app.ctx, [])
    const exec = pipelineExec('call-orphan', sessionAgent('sess-orphan', app.root))

    expect(await app.ctx.waterfall('tools/pre-execute', exec as never, () => Promise.resolve({ kind: 'allow' as const }))).toEqual({ kind: 'allow' })
    emit(app.ctx, SETTLE_SEAM, exec, spawnResult())

    const rows = ledgerRows(app.harnessDir, 'wf-team-orphan')
    expect(rows.some((row) => row.kind === 'settle')).toBe(false)
    expect(rows.find((row) => row.kind === 'continuation')).toMatchObject({ state: 'unresolved', role: 'fullstack-dev' })
  })
})
