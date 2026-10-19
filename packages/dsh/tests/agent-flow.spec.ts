import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDshLedgerRow, openStore, readDshLedgerWindow } from '@mstar-harness/engine'
import { callIdentity, readAgentFlow as readSelectedAgentFlow, recordDispatch, recordJobSettle, recordSettle, registerSettleListener, registerSubagentCatalogListener, SETTLE_SEAM, setAgentFlowInvalidator, setAgentFlowLogger } from '../src/gates/agent-flow.ts'
import type { AgentFlowPairing } from '../src/gates/agent-flow.ts'
import { updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
import { resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'

import { seedActiveWorkflow, selectedGenerationFor } from './harness.ts'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function activeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-flow-native-'))
  roots.push(root)
  const harnessDir = join(root, '.agents')
  await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, 'session-1', root)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows', 'wf-1'), selectedGeneration: selectedGenerationFor(harnessDir) }
}
const readFlow = (dir: string, workflowId = 'wf-1') => readSelectedAgentFlow(dir, workflowId)

/**
 * Drive one `subagent/end` edge through the REAL upstream emission shape
 * (mirrors tests/team-agent-flow.spec.ts: the lifecycle emitter converts the
 * live direct parent into a `scopeTarget` carrier riding as `dispatchArgs[0]`,
 * and cordis `dispatch` shifts that carrier as the listener `this`, invoking
 * every callback with `(info)` alone).
 */
const emitLifecycleEnd = (ctx: Context, info: unknown, parent?: unknown): void => {
  const dispatchArgs = parent === undefined
    ? ['subagent/end', info]
    : [scopeTarget({} as object, parent as object), 'subagent/end', info]
  const events = (ctx as unknown as { events: { dispatch(type: string, args: unknown[]): ((...args: unknown[]) => unknown)[] } }).events
  for (const callback of events.dispatch('emit', dispatchArgs)) callback(info)
}

describe('agent-flow native event rows', () => {
  it('records dispatch and settle attribution in the selected workflow store', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      prompt: '## Assignment\n\n**Execute as**: fullstack-dev\n**Task category**: logic\n',
      violations: [],
      hard: false,
    })
    recordSettle({ harnessDir, workflowId: 'wf-1', workflowDir, selectedGeneration, agent: 'session-1', outcome: 'ok', role: 'fullstack-dev' })
    expect(readFlow(workflowDir, 'wf-1')?.events.map((event) => event.kind)).toEqual(['settle', 'dispatch'])
    expect(readFlow(workflowDir, 'wf-1')?.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', role: 'fullstack-dev' })
    expect(readDshLedgerWindow({ harnessDir }, 'wf-1', 10)).toHaveLength(2)
  })
  it('pairs the real post-execute settle to its selected-generation dispatch', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const exec = { callId: 'call-1', name: 'subagent', agent: { id: 'session-1' } }
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec,
      pairing,
      prompt: `## Assignment

**Execute as**: fullstack-dev
`,
      violations: [],
      hard: false,
    })
    // Cordis accepts runtime event names beyond its declared event map.
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    emitter.emit(SETTLE_SEAM, exec, { isError: false, value: { kind: 'foreground', runId: 'child-session' } })
    expect(readFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['settle', 'dispatch'])
    expect(readFlow(workflowDir)?.events[0]).toMatchObject({ kind: 'settle', role: 'fullstack-dev', childId: 'child-session' })
    expect(pairing.dispatchByCallId.size).toBe(0)
    const persisted = readDshLedgerWindow({ harnessDir }, 'wf-1', 10)?.map((line) => JSON.parse(line) as { kind: string; eventId?: string }) ?? []
    const settle = persisted.find((event) => event.kind === 'settle')
    expect(settle?.eventId).toBe(callIdentity('settle', 'session-1', 'call-1')?.eventId)
  })

  it('preserves duplicate live evidence rows in the native store', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const row = JSON.stringify({ v: 1, ts: 1, kind: 'settle', outcome: 'ok' })
    expect(appendDshLedgerRow({ harnessDir }, 'wf-1', row, undefined, selectedGeneration).kind).toBe('written')
    expect(appendDshLedgerRow({ harnessDir }, 'wf-1', row, undefined, selectedGeneration).kind).toBe('written')
    expect(readFlow(workflowDir)?.events).toHaveLength(2)
  })

  it('filters malformed native rows while projecting only derived dispatch fields', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const prompt = `## Assignment

**Execute as**: @fullstack-dev
**Plan Path**: /private/plans/native-flow.md

## Task 7

SECRET_PROMPT_BODY_MUST_NOT_PERSIST
`
    recordDispatch({ harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration, prompt, violations: [], hard: false })
    expect(appendDshLedgerRow(
      { harnessDir },
      'wf-1',
      JSON.stringify({ v: 1, ts: 1, kind: 'settle', outcome: 'unknown' }),
      undefined,
      selectedGeneration,
    ).kind).toBe('written')
    expect(appendDshLedgerRow(
      { harnessDir },
      'wf-1',
      JSON.stringify({ v: 1, ts: 2, kind: 'subagent-link', childId: '', label: 'invalid', role: 'fullstack-dev' }),
      undefined,
      selectedGeneration,
    ).kind).toBe('written')
    expect(appendDshLedgerRow(
      { harnessDir },
      'wf-1',
      JSON.stringify({
        v: 1,
        ts: 3,
        kind: 'settle',
        outcome: 'error',
        role: 'fullstack-dev',
        childId: 'c'.repeat(4_100),
        taskRef: '',
      }),
      undefined,
      selectedGeneration,
    ).kind).toBe('written')
    const raw = readDshLedgerWindow({ harnessDir }, 'wf-1', 20) ?? []
    expect(raw.join('\\n')).not.toContain('SECRET_PROMPT_BODY_MUST_NOT_PERSIST')
    const view = readFlow(workflowDir)
    expect(view?.events).toContainEqual(expect.objectContaining({ kind: 'dispatch', role: 'fullstack-dev', planId: 'native-flow', taskId: 'T7' }))
    const malformedOptionalSettle = view?.events.find((event) => event.kind === 'settle' && event.outcome === 'error')
    expect(malformedOptionalSettle).toBeDefined()
    expect(malformedOptionalSettle).not.toHaveProperty('childId')
    expect(malformedOptionalSettle).not.toHaveProperty('taskRef')
    expect(view?.events).toHaveLength(2)
    expect(view?.summary).toEqual([
      { role: '', outcome: 'error', count: 1 },
      { role: 'fullstack-dev', outcome: 'ok', count: 1 },
    ])
  })
  it('links only catalog entries inside the paired session window and keeps terminal/job identity separate', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const source: unknown[] = [{
      type: 'subagent/catalog',
      seq: 0,
      time: 1,
      data: { version: 0, childCreatedAt: 1, childId: 'pre-window-child', label: 'early', mode: 'continuable' },
    }]
    const parent = {
      id: 'session-1',
      seq: 1,
      eventAt: (seq: number) => source[seq],
    }
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    registerSubagentCatalogListener(ctx, pairing)
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    const assignment = `## Assignment

**Execute as**: fullstack-dev
**Plan Path**: /tmp/plans/ledger-plan.md

## Task 1

Catalog correlation regression.
`
    const earlyExec = {
      callId: 'early-call',
      name: 'subagent',
      agent: { id: 'session-1', session: parent },
      arguments: { description: 'early' },
    }
    recordDispatch({ harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration, exec: earlyExec, pairing, prompt: assignment, violations: [], hard: false })
    source[1] = {
      type: 'subagent/catalog', seq: 1, time: 2,
      data: { version: 0, childCreatedAt: 2, childId: 'wrong-label', label: 'not-early', mode: 'continuable' },
    }
    source[2] = {
      type: 'subagent/catalog', seq: 2, time: 3,
      data: { version: 0, childCreatedAt: 3, childId: 'wrong-child', label: 'early', mode: 'continuable' },
    }
    source[3] = {
      type: 'subagent/catalog', seq: 3, time: 4,
      data: { version: 0, childCreatedAt: 4, childId: 'early-child', label: 'early', mode: 'continuable' },
    }
    parent.seq = 4
    emitter.emit(SETTLE_SEAM, earlyExec, { isError: false, value: { kind: 'continuable', subagentId: 'early-child' } })

    const lateExec = {
      callId: 'late-call',
      name: 'subagent',
      agent: { id: 'session-1', session: parent },
      arguments: { description: 'late' },
    }
    recordDispatch({ harnessDir, workflowId: 'wf-1', resolvedWorkflowDir: workflowDir, selectedGeneration, exec: lateExec, pairing, prompt: assignment, violations: [], hard: false })
    emitter.emit(SETTLE_SEAM, lateExec, { isError: false, value: { kind: 'background', jobId: 'job-identity' } })
    recordJobSettle({ id: 'job-identity', status: 'killed', startedAt: 100, finishedAt: 150 }, pairing)
    const foreignParent = { ...parent, eventAt: () => ({
      type: 'subagent/catalog', seq: 4, time: 5,
      data: { version: 0, childCreatedAt: 5, childId: 'foreign-child', label: 'late', mode: 'one-shot' },
    }) }
    ctx.events.emit({}, 'session/event', foreignParent, {
      type: 'subagent/catalog', seq: 4, time: 5,
      data: { version: 0, childCreatedAt: 5, childId: 'foreign-child', label: 'late', mode: 'one-shot' },
    })
    source[4] = {
      type: 'subagent/catalog', seq: 4, time: 6,
      data: { version: 0, childCreatedAt: 6, childId: 'late-child', label: 'late', mode: 'one-shot' },
    }
    parent.seq = 5
    ctx.events.emit({}, 'session/event', parent, source[4])

    const events = readFlow(workflowDir)?.events ?? []
    expect(events.filter((event) => event.kind === 'subagent-link')).toHaveLength(2)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'subagent-link', childId: 'early-child', label: 'early', planId: 'ledger-plan', taskId: 'T1', role: 'fullstack-dev',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'subagent-link', childId: 'late-child', label: 'late', taskRef: 'job-identity',
    }))
    const killed = events.find((event) => event.kind === 'settle' && event.outcome === 'denied')
    expect(killed).toMatchObject({ taskRef: 'job-identity' })
    expect(killed).not.toHaveProperty('childId')
    expect(events.filter((event) => event.kind === 'subagent-link').every((event) => !('outcome' in event))).toBe(true)
    expect(readFlow(workflowDir)?.summary).toContainEqual({ role: 'fullstack-dev', outcome: 'subagent-link', count: 2 })
  })
  it('keeps job terminal, error precedence, continuable, and same-call session pairings truthful', async () => {
    const { root, harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    await seedActiveWorkflow(harnessDir, 'wf-2', [], {}, 'session-2', root)
    const secondWorkflowDir = join(harnessDir, 'workflows', 'wf-2')
    const secondTarget = await resolveExecutionLedgerTarget('session-2', root)
    expect(secondTarget?.workflowId).toBe('wf-2')
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    const prompt = `## Assignment

**Execute as**: fullstack-dev
`
    const dispatch = (callId: string, agentId = 'session-1', targetDir = workflowDir, generation = selectedGeneration) => {
      const exec = { callId, name: 'subagent', agent: { id: agentId } }
      recordDispatch({ harnessDir, workflowId: targetDir === secondTarget!.workflowDir ? 'wf-2' : 'wf-1', resolvedWorkflowDir: targetDir, selectedGeneration: generation, exec, pairing, prompt, violations: [], hard: false })
      return exec
    }
    const postExecute = (exec: unknown, result: unknown) => emitter.emit(SETTLE_SEAM, exec, result)

    const running = dispatch('running-call')
    postExecute(running, { isError: false, value: { kind: 'background', jobId: 'running-job' } })
    recordJobSettle({ id: 'running-job', status: 'running', startedAt: 10 }, pairing)
    recordJobSettle({ id: 'not-paired', status: 'completed', startedAt: 10, finishedAt: 20 }, pairing)
    expect(readFlow(workflowDir)?.events.map((event) => event.kind)).toContain('dispatch')
    expect(readFlow(workflowDir)?.events.some((event) => event.kind === 'settle')).toBe(false)

    const continuable = dispatch('continuable-call')
    postExecute(continuable, { isError: false, value: { kind: 'continuable', subagentId: 'child-still-running' } })
    const invalidJob = dispatch('invalid-job-call')
    postExecute(invalidJob, { isError: false, value: { kind: 'background', jobId: '' } })
    recordJobSettle({ id: '', status: 'completed' }, pairing)
    const errored = dispatch('errored-background-call')
    postExecute(errored, { isError: true, value: { kind: 'background', jobId: 'must-not-pair' } })
    recordJobSettle({ id: 'must-not-pair', status: 'completed' }, pairing)

    const killed = dispatch('killed-call')
    postExecute(killed, { isError: false, value: { kind: 'background', jobId: 'killed-job' } })
    recordJobSettle({ id: 'killed-job', status: 'killed', startedAt: 100, finishedAt: 140 }, pairing)
    const failed = dispatch('failed-call')
    postExecute(failed, { isError: false, value: { kind: 'background', jobId: 'failed-job' } })
    recordJobSettle({ id: 'failed-job', status: 'failed', startedAt: 200, finishedAt: 250 }, pairing)

    const sameCallFirst = dispatch('shared-call', 'session-1', workflowDir, selectedGeneration)
    const sameCallSecond = dispatch('shared-call', 'session-2', secondTarget!.workflowDir, { storeId: secondTarget!.storeId, epoch: secondTarget!.epoch })
    updateWorkflowSessionBinding(harnessDir, 'session-1', root, { selectedWorkflowId: 'wf-2', excludedBeforeSeq: 0 })
    expect(await resolveExecutionLedgerTarget('session-1', root)).toBeNull()
    postExecute(sameCallSecond, { isError: false, value: { kind: 'foreground', runId: 'second-child' } })
    postExecute(sameCallFirst, { isError: false, value: { kind: 'foreground', runId: 'first-child' } })
    const events = readFlow(workflowDir)?.events ?? []
    const secondEvents = readFlow(secondWorkflowDir, 'wf-2')?.events ?? []
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settle', outcome: 'denied', taskRef: 'killed-job', durationMs: 40 }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settle', outcome: 'error', taskRef: 'failed-job', durationMs: 50 }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settle', outcome: 'error', agent: 'session-1' }))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settle', agent: 'session-1', childId: 'first-child' }))
    expect(secondEvents).toContainEqual(expect.objectContaining({ kind: 'settle', agent: 'session-2', childId: 'second-child' }))
    expect(events.filter((event) => event.kind === 'settle' && event.agent === 'session-1')).toHaveLength(4)
    expect(events.some((event) => event.kind === 'settle' && event.taskRef === 'must-not-pair')).toBe(false)
    const lines = readDshLedgerWindow({ harnessDir }, 'wf-1', 50) ?? []
    const settleIds = lines
      .map((line) => JSON.parse(line) as { kind: string; eventId?: string })
      .filter((event) => event.kind === 'settle')
      .map((event) => event.eventId)
    const secondLines = readDshLedgerWindow({ harnessDir }, 'wf-2', 50) ?? []
    const secondSettleIds = secondLines
      .map((line) => JSON.parse(line) as { kind: string; eventId?: string })
      .filter((event) => event.kind === 'settle')
      .map((event) => event.eventId)
    expect(settleIds).toContain(callIdentity('settle', 'session-1', 'shared-call')?.eventId)
    expect(secondSettleIds).toContain(callIdentity('settle', 'session-2', 'shared-call')?.eventId)
  })
  it('refuses a stale selected generation without pairing or invalidating', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const previousLogger = setAgentFlowLogger(() => { levels.push('warning') })
    const previousInvalidator = setAgentFlowInvalidator(() => { invalidations += 1 })
    const levels: string[] = []
    let invalidations = 0
    try {
      const handle = await openStore({ harnessDir }, 'write')
      try {
        handle.db.prepare('update store_meta set authority_epoch = authority_epoch + 1 where id = 1').run()
      } finally {
        handle.close()
      }
      const pairing: AgentFlowPairing = {
        dispatchByCallId: new Map(),
        dispatchByJobId: new Map(),
        catalogBySession: new WeakMap(),
      }
      recordDispatch({
        harnessDir,
        workflowId: 'wf-1',
        resolvedWorkflowDir: workflowDir,
        selectedGeneration,
        exec: { callId: 'stale-call', name: 'subagent', agent: { id: 'session-1' } },
        pairing,
        prompt: '**Execute as**: fullstack-dev',
        violations: [],
        hard: false,
      })
      expect(readDshLedgerWindow({ harnessDir }, 'wf-1', 10)).toEqual([])
      expect(readFlow(workflowDir)?.events).toEqual([])
      expect(pairing.dispatchByCallId.size).toBe(0)
      expect(invalidations).toBe(0)
      expect(levels).toContain('warning')
    } finally {
      setAgentFlowLogger(previousLogger)
      setAgentFlowInvalidator(previousInvalidator)
    }
  })
  it('returns unavailable without native authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-flow-unavailable-'))
    roots.push(root)
    expect(readFlow(join(root, '.agents', 'workflows', 'wf-1'))).toBeNull()
  })

  it('never settles an activation result at tool return — the open dispatch settles on the child subagent/end', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const exec = { callId: 'activation-call', name: 'subagent', agent: { id: 'session-1' } }
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec,
      pairing,
      prompt: `## Assignment

**Execute as**: fullstack-dev
`,
      violations: [],
      hard: false,
    })
    // Cordis accepts runtime event names beyond its declared event map.
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    // The installed dsh `subagent` return shape: STARTED, not settled. The
    // false-settle signature (a settle row ≈ the tool return while the child
    // is still running) must be gone.
    emitter.emit(SETTLE_SEAM, exec, { isError: false, value: { kind: 'activation', subagentId: 'sub-child-1' } })
    expect(readFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['dispatch'])
    expect(pairing.dispatchByCallId.size).toBe(0)
    expect(pairing.teamDispatchByChildId?.size).toBe(1)
    // The child's real completion settles the still-open dispatch.
    emitLifecycleEnd(ctx, { id: 'sub-child-1', stopReason: 'completed' })
    expect(pairing.teamDispatchByChildId?.size).toBe(0)
    const events = readFlow(workflowDir)?.events ?? []
    expect(events).toContainEqual(expect.objectContaining({ kind: 'settle', outcome: 'ok', childId: 'sub-child-1', role: 'fullstack-dev' }))
    expect(events.filter((event) => event.kind === 'settle')).toHaveLength(1)
  })

  it('maps a failing activation child to the error outcome when its subagent/end arrives (never ok)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const exec = { callId: 'activation-fail-call', name: 'subagent', agent: { id: 'session-1' } }
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec,
      pairing,
      prompt: `## Assignment

**Execute as**: fullstack-dev
`,
      violations: [],
      hard: false,
    })
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    emitter.emit(SETTLE_SEAM, exec, { isError: false, value: { kind: 'activation', subagentId: 'sub-child-fail' } })
    expect(readFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['dispatch'])
    emitLifecycleEnd(ctx, { id: 'sub-child-fail', stopReason: 'error' })
    const settles = (readFlow(workflowDir)?.events ?? []).filter((event) => event.kind === 'settle')
    expect(settles).toContainEqual(expect.objectContaining({ kind: 'settle', outcome: 'error', childId: 'sub-child-fail' }))
    expect(settles.some((event) => event.outcome === 'ok')).toBe(false)
  })

  it('leaves a malformed activation result (no usable subagentId) unsettled and unpaired', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const exec = { callId: 'activation-malformed-call', name: 'subagent', agent: { id: 'session-1' } }
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec,
      pairing,
      prompt: `## Assignment

**Execute as**: fullstack-dev
`,
      violations: [],
      hard: false,
    })
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    emitter.emit(SETTLE_SEAM, exec, { isError: false, value: { kind: 'activation' } })
    // No usable child identity → nothing mappable: honest no-settle, no
    // pairing entry (the dispatch row stands open, never a fabricated ok).
    expect(readFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['dispatch'])
    expect(pairing.teamDispatchByChildId?.size ?? 0).toBe(0)
    expect(pairing.dispatchByCallId.size).toBe(0)
  })

  it('joins the activation child identity through the call-window catalog (subagent-link)', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const source: unknown[] = []
    const parent = { id: 'session-1', seq: 1, eventAt: (seq: number) => source[seq] }
    const ctx = new Context()
    const pairing: AgentFlowPairing = {
      dispatchByCallId: new Map(),
      dispatchByJobId: new Map(),
      catalogBySession: new WeakMap(),
    }
    registerSettleListener(ctx, {}, pairing)
    const exec = {
      callId: 'link-call',
      name: 'subagent',
      agent: { id: 'session-1', session: parent },
      arguments: { description: 'linked' },
    }
    recordDispatch({
      harnessDir,
      workflowId: 'wf-1',
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      exec,
      pairing,
      prompt: `## Assignment

**Execute as**: fullstack-dev
`,
      violations: [],
      hard: false,
    })
    source[1] = {
      type: 'subagent/catalog', seq: 1, time: 2,
      data: { version: 0, childCreatedAt: 2, childId: 'sub-child-link', label: 'linked', mode: 'continuable' },
    }
    parent.seq = 2
    const emitter = ctx as unknown as { emit(event: string, ...args: unknown[]): void }
    // The activation's own subagentId authorizes the identity join: the
    // catalog child must be exactly the returned child.
    emitter.emit(SETTLE_SEAM, exec, { isError: false, value: { kind: 'activation', subagentId: 'sub-child-link' } })
    const events = readFlow(workflowDir)?.events ?? []
    expect(events).toContainEqual(expect.objectContaining({ kind: 'subagent-link', childId: 'sub-child-link', label: 'linked', role: 'fullstack-dev' }))
    expect(events.some((event) => event.kind === 'settle')).toBe(false)
  })
})
