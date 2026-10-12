import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, readDshScanBound } from '@mstar-harness/engine'
import { readAgentFlow, recordDispatch, recordWorkflowEvent } from '../src/gates/agent-flow.ts'
import type { AgentFlowWorkflowEvent } from '../src/gates/agent-flow.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { awaitWorkflowLedgerIdle, registerWorkflowLedger, setWorkflowLedgerLogger } from '../src/gates/workflow-ledger.ts'
import { resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
import { seedActiveWorkflow, selectedGenerationFor } from './harness.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
process.env.MSTAR_STORE_TEST_RUNNER ??= '1'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function activeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-events-native-'))
  roots.push(root)
  const harnessDir = join(root, '.agents')
  await seedActiveWorkflow(harnessDir, 'wf-1', [], {}, 'session-1', root)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows', 'wf-1'), selectedGeneration: selectedGenerationFor(harnessDir) }
}

describe('workflow event native acceptance and scan bound', () => {
  it('consumes real-shaped native session rows through the ordered workflow ledger route', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_000 },
      seq: 2,
      inheritedEventCount: 0,
      eventAt: (seq: number) => {
        if (seq === 0) return {
          type: 'tool-workflow/agent-end',
          seq: 0,
          time: 1_700_000_000_000,
          data: { runId: 'run-1', seq: 1, outcome: 'completed' },
        }
        if (seq === 1) return {
          type: 'tool-workflow/run-start',
          seq: 1,
          time: 1_700_000_000_001,
          data: { runId: 'run-1', name: 'audit' },
        }
        return undefined
      },
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: (id: string) => id === 'session-1' ? session : undefined } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events).toMatchObject([{ kind: 'workflow-run', runId: 'run-1', name: 'audit' }])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 2 })
  })
  it('serializes cold source rows ahead of a concurrent live event on the verified stream', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_010 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? {
        type: 'tool-workflow/run-start',
        seq: 0,
        time: 1_700_000_000_011,
        data: { runId: 'cold-run', name: 'cold' },
      } : undefined,
    }
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let isFirstResolution = true
    const resolveTarget = async (sessionId: string, cwd: string) => {
      if (isFirstResolution) {
        isFirstResolution = false
        markStarted()
        await blocked
      }
      return resolveExecutionLedgerTarget(sessionId, cwd)
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: () => session } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveTarget)
    await started
    ctx.events.emit({}, 'session/event', session, {
      type: 'tool-workflow/run-start',
      seq: 1,
      time: 1_700_000_000_012,
      data: { runId: 'live-run', name: 'live' },
    })
    release()
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual(['live-run', 'cold-run'])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 2 })
  })
  it('refuses a source event when the resolved original generation is superseded before commit', async () => {
    const { root, harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_020 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? {
        type: 'tool-workflow/run-start',
        seq: 0,
        time: 1_700_000_000_021,
        data: { runId: 'stale-run', name: 'stale' },
      } : undefined,
    }
    let changed = false
    const resolveThenSupersede = async (sessionId: string, cwd: string) => {
      const selected = await resolveExecutionLedgerTarget(sessionId, cwd)
      if (selected !== null && !changed) {
        changed = true
        const handle = await openStore({ harnessDir }, 'write')
        try {
          handle.db.prepare('update store_meta set authority_epoch = authority_epoch + 1 where id = 1').run()
        } finally {
          handle.close()
        }
      }
      return selected
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: () => session } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveThenSupersede)
    await awaitWorkflowLedgerIdle()
    expect(changed).toBe(true)
    expect(readAgentFlow(workflowDir)?.events).toEqual([])
    const restore = await openStore({ harnessDir }, 'write')
    try {
      restore.db.prepare('update store_meta set authority_epoch = ? where id = 1').run(selectedGeneration.epoch)
    } finally {
      restore.close()
    }
    ctx.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events.filter((event) => event.kind === 'workflow-run' && event.runId === 'stale-run')).toHaveLength(1)
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 1 })
    ctx.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events.filter((event) => event.kind === 'workflow-run' && event.runId === 'stale-run')).toHaveLength(1)
  })
  it('keeps a bound row eligible across transient target refusal and retries the same log exactly once', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_029 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? {
        type: 'tool-workflow/run-start',
        seq: 0,
        time: 1_700_000_000_029,
        data: { runId: 'transient-run', name: 'retry' },
      } : undefined,
    }
    const initial = readWorkflowSessionBinding(harnessDir, 'session-1', root)
    expect(initial.kind).toBe('ok')
    const floorBefore = ('binding' in initial ? initial.binding?.excludedBeforeSeq : undefined) ?? 0
    let firstResolution = true
    const resolveTransiently = async (sessionId: string, cwd: string) => {
      if (firstResolution) {
        firstResolution = false
        return null
      }
      return resolveExecutionLedgerTarget(sessionId, cwd)
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: () => session } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveTransiently)
    await awaitWorkflowLedgerIdle()
    const afterRefusal = readWorkflowSessionBinding(harnessDir, 'session-1', root)
    expect(('binding' in afterRefusal ? afterRefusal.binding?.excludedBeforeSeq : undefined) ?? 0).toBe(floorBefore)
    expect(readAgentFlow(workflowDir)?.events).toEqual([])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toBeUndefined()

    ctx.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    ctx.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events.filter((event) => event.kind === 'workflow-run' && event.runId === 'transient-run')).toHaveLength(1)
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 1 })
    const afterRecovery = readWorkflowSessionBinding(harnessDir, 'session-1', root)
    expect(('binding' in afterRecovery ? afterRecovery.binding?.excludedBeforeSeq : undefined) ?? 0).toBe(floorBefore)
  })
  it('leaves a valid source row eligible when native target resolution returns no target', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const session = {
      header: { id: 'unbound-session', cwd: root, createdAt: 1_700_000_000_030 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? {
        type: 'tool-workflow/run-start',
        seq: 0,
        time: 1_700_000_000_031,
        data: { runId: 'unbound-run', name: 'unbound' },
      } : undefined,
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: () => session } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events).toEqual([])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'unbound-session')).toBeUndefined()
  })
  it('advances an isolated valid agent-end without a display row and refuses malformed agent-end positions', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const source = (createdAt: number, envelope: unknown) => ({
      header: { id: 'session-1', cwd: root, createdAt },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? envelope : undefined,
    })
    const invalid = [
      source(1_700_000_000_090, {
        type: 'tool-workflow/agent-end', seq: 0.5, time: 10,
        data: { runId: 'bad-source', seq: 1, outcome: 'completed' },
      }),
      source(1_700_000_000_091, {
        type: 'tool-workflow/agent-end', seq: 0, time: 11,
        data: { runId: 'bad-member-seq', seq: 1.5, outcome: 'completed' },
      }),
      source(1_700_000_000_092, {
        type: 'tool-workflow/agent-end', seq: 0, time: 12,
        data: { runId: 'bad-outcome', seq: 1, outcome: 'unknown' },
      }),
    ]
    const ctx = new Context()
    ctx.provide('sessions', { list: () => invalid, get: () => invalid[0] } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toBeUndefined()
    expect(readAgentFlow(workflowDir)?.events).toEqual([])

    const valid = source(1_700_000_000_093, {
      type: 'tool-workflow/agent-end', seq: 0, time: 13,
      data: { runId: 'isolated-end', seq: 1, outcome: 'completed' },
    })
    const validContext = new Context()
    validContext.provide('sessions', { list: () => [valid], get: () => valid } as never)
    registerWorkflowLedger(validContext, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events).toEqual([])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 1 })
  })
  it('re-registers created-session backfill idempotently and keeps live intake healthy after list/read failures', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_040 },
      seq: 2,
      inheritedEventCount: 0,
      eventAt: (seq: number) => {
        if (seq === 0) throw new Error('fixture read failure')
        if (seq === 1) return {
          type: 'tool-workflow/run-start',
          seq: 1,
          time: 1_700_000_000_041,
          data: { runId: 'replayed-run', name: 'healthy-after-read-error' },
        }
        return undefined
      },
    }
    const provideSessions = (ctx: Context, list: () => unknown[]) => ctx.provide('sessions', {
      list,
      get: (id: string) => id === 'session-1' ? session : undefined,
    } as never)
    const first = new Context()
    provideSessions(first, () => [session])
    registerWorkflowLedger(first, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflowDir)?.events.filter((event) => event.kind === 'workflow-run')).toHaveLength(1)
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 2 })

    const replay = new Context()
    provideSessions(replay, () => [session])
    registerWorkflowLedger(replay, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    replay.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()

    const degraded = new Context()
    provideSessions(degraded, () => { throw new Error('fixture service list failure') })
    registerWorkflowLedger(degraded, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    degraded.events.emit({}, 'session/created', session)
    await awaitWorkflowLedgerIdle()
    degraded.events.emit({}, 'session/event', session, {
      type: 'tool-workflow/run-end',
      seq: 2,
      time: 1_700_000_000_042,
      data: { runId: 'replayed-run', stopReason: 'completed' },
    })
    await awaitWorkflowLedgerIdle()
    const events = readAgentFlow(workflowDir)?.events ?? []
    expect(events.map((event) => event.kind)).toEqual(['workflow-run-end', 'workflow-run'])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 3 })
  })
  it('accepts an empty session first event, then rescans a shorter rebuilt incarnation from its creation stamp', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const empty = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_050 },
      seq: 0,
      inheritedEventCount: 0,
      eventAt: () => undefined,
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [empty], get: () => empty } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    ctx.events.emit({}, 'session/event', empty, {
      type: 'tool-workflow/run-start',
      seq: 0,
      time: 1_700_000_000_051,
      data: { runId: 'first-run', name: 'first' },
    })
    await awaitWorkflowLedgerIdle()
    ctx.events.emit({}, 'session/event', empty, {
      type: 'tool-workflow/run-end',
      seq: 1,
      time: 1_700_000_000_052,
      data: { runId: 'first-run', stopReason: 'completed' },
    })
    await awaitWorkflowLedgerIdle()
    const oldBound = readDshScanBound({ harnessDir }, 'wf-1', 'session-1')
    expect(oldBound).toMatchObject({ next: 2 })

    const rebuilt = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_052 },
      seq: 1,
      inheritedEventCount: 0,
      eventAt: (seq: number) => seq === 0 ? {
        type: 'tool-workflow/run-start',
        seq: 0,
        time: 1_700_000_000_053,
        data: { runId: 'rebuilt-run', name: 'rebuilt' },
      } : undefined,
    }
    ctx.events.emit({}, 'session/created', rebuilt)
    await awaitWorkflowLedgerIdle()
    const rebuiltBound = readDshScanBound({ harnessDir }, 'wf-1', 'session-1')
    expect(rebuiltBound).toMatchObject({ next: 1 })
    expect(rebuiltBound?.stream).not.toBe(oldBound?.stream)
    expect(readAgentFlow(workflowDir)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual([
      'rebuilt-run',
      'workflow-run-end',
      'first-run',
    ])

    const missingStamp = { header: { id: 'session-1', cwd: root }, seq: 2 }
    ctx.events.emit({}, 'session/event', missingStamp, {
      type: 'tool-workflow/run-start',
      seq: 1,
      time: 1_700_000_000_054,
      data: { runId: 'unverified-run', name: 'unverified' },
    })
    await awaitWorkflowLedgerIdle()
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toEqual(rebuiltBound)
    expect(readAgentFlow(workflowDir)?.events).toHaveLength(3)
  })

  it('isolates two bound workflows while an unbound fork and foreign-session target remain ineligible', async () => {
    const { root, harnessDir } = await activeFixture()
    await seedActiveWorkflow(harnessDir, 'wf-2', [], {}, 'session-2', root)
    const workflows = {
      first: join(harnessDir, 'workflows', 'wf-1'),
      second: join(harnessDir, 'workflows', 'wf-2'),
    }
    const session = (id: string, createdAt: number, rows: unknown[], inheritedEventCount = 0) => ({
      header: { id, cwd: root, createdAt },
      seq: rows.length,
      inheritedEventCount,
      eventAt: (seq: number) => rows[seq],
    })
    const first = session('session-1', 1_700_000_000_060, [{
      type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_061,
      data: { runId: 'only-first', name: 'first' },
    }])
    const second = session('session-2', 1_700_000_000_062, [{
      type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_063,
      data: { runId: 'only-second', name: 'second' },
    }])
    const fork = session('unbound-fork', 1_700_000_000_064, [
      { type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_065, data: { runId: 'inherited', name: 'inherited' } },
      { type: 'tool-workflow/run-start', seq: 1, time: 1_700_000_000_066, data: { runId: 'unbound-own', name: 'own' } },
    ], 1)
    const foreign = session('foreign-session', 1_700_000_000_067, [{
      type: 'tool-workflow/run-start', seq: 0, time: 1_700_000_000_068,
      data: { runId: 'foreign-run', name: 'foreign' },
    }])
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    let markSecondResolved!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondResolved = new Promise<void>((resolve) => { markSecondResolved = resolve })
    const resolveTarget = async (sessionId: string, cwd: string) => {
      if (sessionId === 'session-1') {
        markFirstStarted()
        await firstGate
      }
      if (sessionId === 'foreign-session') {
        const target = await resolveExecutionLedgerTarget('session-2', cwd)
        return target === null ? null : { ...target, sessionId: 'not-the-carrying-session' }
      }
      const target = await resolveExecutionLedgerTarget(sessionId, cwd)
      if (sessionId === 'session-2') markSecondResolved()
      return target
    }
    const ctx = new Context()
    const sessions = [first, second, fork, foreign]
    ctx.provide('sessions', {
      list: () => sessions,
      get: (id: string) => sessions.find((entry) => entry.header.id === id),
    } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveTarget)
    await firstStarted
    await secondResolved
    for (let attempt = 0; attempt < 20 && readDshScanBound({ harnessDir }, 'wf-2', 'session-2') === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(readDshScanBound({ harnessDir }, 'wf-2', 'session-2')).toMatchObject({ next: 1 })
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toBeUndefined()
    expect(readAgentFlow(workflows.second)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual(['only-second'])
    releaseFirst()
    await awaitWorkflowLedgerIdle()
    expect(readAgentFlow(workflows.first)?.events.map((event) => event.kind === 'workflow-run' ? event.runId : event.kind)).toEqual(['only-first'])
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 1 })
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'unbound-fork')).toBeUndefined()
    expect(readDshScanBound({ harnessDir }, 'wf-2', 'foreign-session')).toBeUndefined()
  })
  it('deduplicates depth advisories per run without blocking rows when child metadata fails', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const rows = [
      { type: 'tool-workflow/run-start', seq: 0, time: 1, data: { runId: 'depth-a', name: 'depth-a' } },
      { type: 'tool-workflow/agent-start', seq: 1, time: 2, data: { runId: 'depth-a', seq: 1, label: 'below', childId: 'below' } },
      { type: 'tool-workflow/agent-start', seq: 2, time: 3, data: { runId: 'depth-a', seq: 2, label: 'first-high', childId: 'high-a' } },
      { type: 'tool-workflow/agent-start', seq: 3, time: 4, data: { runId: 'depth-a', seq: 3, label: 'duplicate-high', childId: 'high-a2' } },
      { type: 'tool-workflow/run-start', seq: 4, time: 5, data: { runId: 'depth-b', name: 'depth-b' } },
      { type: 'tool-workflow/agent-start', seq: 5, time: 6, data: { runId: 'depth-b', seq: 1, label: 'throwing-read', childId: 'throw' } },
      { type: 'tool-workflow/agent-start', seq: 6, time: 7, data: { runId: 'depth-b', seq: 2, label: 'healthy-high', childId: 'high-b' } },
    ]
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_070 },
      seq: rows.length,
      inheritedEventCount: 0,
      eventAt: (seq: number) => rows[seq],
    }
    const warnings: string[] = []
    const previousLogger = setWorkflowLedgerLogger((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
    try {
      const ctx = new Context()
      ctx.provide('sessions', {
        list: () => [session],
        get: (id: string) => {
          if (id === 'throw') throw new Error('fixture child lookup failure')
          return { header: { delegationDepth: id === 'below' ? 1 : 2 } }
        },
      } as never)
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
      await awaitWorkflowLedgerIdle()
      expect(warnings).toHaveLength(3)
      expect(readAgentFlow(workflowDir)?.events).toHaveLength(7)
      expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 7 })
    } finally {
      setWorkflowLedgerLogger(previousLogger)
    }
  })
  it('classifies, validates, bounds, and sanitizes mixed native workflow events', async () => {
    const { root, harnessDir, workflowDir } = await activeFixture()
    const long = '🧭'.repeat(1_300)
    const rows = [
      { type: 'tool-workflow/run-start', seq: 0, time: 10, data: { runId: 'control-only', name: '\u0007' } },
      { type: 'tool-workflow/run-start', seq: 1, time: 11, data: { runId: 'run-a', name: 'pre\u0007sanitized' } },
      { type: 'tool-workflow/agent-start', seq: 2, time: 12, data: { runId: 'run-a', seq: 1.5, label: 'invalid-member-seq', childId: 'bad-child' } },
      { type: 'tool-workflow/agent-start', seq: 3, time: 13, data: { runId: 'run-a', seq: 1, label: 'plain-member', childId: 'child-a' } },
      { type: 'tool-workflow/agent-start', seq: 4, time: 14, data: { runId: 'run-a', seq: 2, label: long, phase: long, childId: 'child-b' } },
      { type: 'tool-workflow/run-end', seq: 5, time: 15, data: { runId: 'run-a', stopReason: 'unknown' } },
      { type: 'tool-workflow/run-end', seq: 6, time: 16, data: { runId: 'run-a', stopReason: 'cancelled' } },
      { type: 'tool-workflow/run-start', seq: 7.5, time: 17, data: { runId: 'fractional-envelope', name: 'invalid' } },
      { type: 'tool-workflow/run-start', seq: 8, time: 18, data: { runId: 'run-b', name: long } },
      { type: 'tool-workflow/run-start', seq: 9, time: 19, data: { runId: '', name: 'missing-identity' } },
      { type: 'tool-workflow/agent-start', seq: 10, time: 20, data: { runId: 'run-b', seq: 1, label: 'invalid-child', childId: 'c'.repeat(4_100) } },
      { type: 'tool-workflow/run-end', seq: 11, time: 21, data: { runId: 'run-b', stopReason: 'error' } },
    ]
    const session = {
      header: { id: 'session-1', cwd: root, createdAt: 1_700_000_000_080 },
      seq: rows.length,
      inheritedEventCount: 0,
      eventAt: (seq: number) => rows[seq],
    }
    const ctx = new Context()
    ctx.provide('sessions', { list: () => [session], get: () => session } as never)
    registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, resolveExecutionLedgerTarget)
    await awaitWorkflowLedgerIdle()
    const view = readAgentFlow(workflowDir)
    expect(view?.events.map((event) => event.kind)).toEqual([
      'workflow-run-end', 'workflow-run', 'workflow-run-end', 'workflow-agent', 'workflow-agent', 'workflow-run',
    ])
    expect(view?.events).toContainEqual(expect.objectContaining({ kind: 'workflow-run', runId: 'run-a', name: 'presanitized' }))
    expect(view?.events).toContainEqual(expect.objectContaining({ kind: 'workflow-agent', label: 'plain-member', childId: 'child-a' }))
    expect(view?.events).toContainEqual(expect.objectContaining({ kind: 'workflow-agent', seq: 2, childId: 'child-b' }))
    const longMember = view?.events.find((event) => event.kind === 'workflow-agent' && event.childId === 'child-b')
    expect(longMember?.kind).toBe('workflow-agent')
    if (longMember?.kind === 'workflow-agent') {
      expect(longMember.label).toBeDefined()
      expect(longMember.phase).toBeDefined()
      expect(Array.from(longMember.label ?? '').length).toBeLessThanOrEqual(512)
      expect(Array.from(longMember.phase ?? '').length).toBeLessThanOrEqual(512)
      expect(longMember.label).toContain('🧭')
      expect(longMember.phase).toContain('🧭')
    }
    const longRun = view?.events.find((event) => event.kind === 'workflow-run' && event.runId === 'run-b')
    expect(longRun?.kind).toBe('workflow-run')
    if (longRun?.kind === 'workflow-run') {
      expect(Array.from(longRun.name ?? '').length).toBeLessThanOrEqual(1_024)
      expect(longRun.name).toContain('🧭')
    }
    expect(view?.summary.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(6)
    expect(view?.summary.map((bucket) => bucket.outcome)).toEqual(expect.arrayContaining([
      'workflow-run', 'workflow-agent', 'workflow-run-end',
    ]))
    expect(readAgentFlow(workflowDir, 0)?.events).toEqual([])
    expect(readAgentFlow(workflowDir, 4)?.events).toHaveLength(4)
    expect(readAgentFlow(workflowDir, 4)?.summary.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4)
    ctx.events.emit({}, 'session/event', session, {
      type: 'tool-workflow/run-start',
      seq: 12.5,
      time: 22,
      data: { runId: 'invalid-live', name: 'invalid' },
    })
    await awaitWorkflowLedgerIdle()
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toMatchObject({ next: 12 })
    expect(readAgentFlow(workflowDir)?.events).toHaveLength(6)
    recordDispatch({
      harnessDir,
      resolvedWorkflowDir: workflowDir,
      selectedGeneration: selectedGenerationFor(harnessDir),
      prompt: `## Assignment

**Execute as**: @fullstack-dev
`,
      violations: [],
      hard: false,
    })
    const mixed = readAgentFlow(workflowDir, 7)
    expect(mixed?.events).toHaveLength(7)
    expect(mixed?.summary.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(7)
    expect(mixed?.summary).toContainEqual({ role: 'fullstack-dev', outcome: 'ok', count: 1 })
    expect(mixed?.summary).toContainEqual({ role: 'workflow', outcome: 'workflow-run', count: 2 })
    expect(readAgentFlow(workflowDir, 1)?.summary).toEqual([{ role: 'fullstack-dev', outcome: 'ok', count: 1 }])
  })

  it('accepts, replays, and refuses conflicting source identity atomically', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const source = { sessionId: 'session-1', streamId: 'stream-a', seq: 4 }
    const event: AgentFlowWorkflowEvent = { v: 1, ts: 10, kind: 'workflow-run', runId: 'run-1', name: 'audit' }
    const first = { harnessDir, workflowDir, event, source, selectedGeneration }
    expect(recordWorkflowEvent(first)).toBe(true)
    expect(recordWorkflowEvent(first)).toBe(true)
    expect(recordWorkflowEvent({ ...first, event: { ...event, name: 'different' } })).toBe(false)
    expect(readDshScanBound({ harnessDir }, 'wf-1', source.sessionId)).toEqual({ next: 5, stream: 'stream-a' })
  })

  it('replaces a bound when the verified stream incarnation changes', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const event: AgentFlowWorkflowEvent = { v: 1, ts: 10, kind: 'workflow-run', runId: 'run-1', name: 'audit' }
    expect(recordWorkflowEvent({ harnessDir, workflowDir, event, source: { sessionId: 'session-1', streamId: 'old', seq: 20 }, selectedGeneration })).toBe(true)
    expect(recordWorkflowEvent({ harnessDir, workflowDir, event, source: { sessionId: 'session-1', streamId: 'new', seq: 2 }, selectedGeneration })).toBe(true)
    expect(readDshScanBound({ harnessDir }, 'wf-1', 'session-1')).toEqual({ next: 3, stream: 'new' })
  })

  it('does not fabricate an event projection when native authority is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-events-unavailable-'))
    roots.push(root)
    expect(readAgentFlow(join(root, '.agents', 'workflows', 'wf-1'))).toBeNull()
  })
})
