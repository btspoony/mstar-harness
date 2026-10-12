import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendDshLedgerRow, readDshLedgerWindow } from '@mstar-harness/engine'
import { readAgentFlow, recordDispatch, recordSettle, registerSettleListener, SETTLE_SEAM } from '../src/gates/agent-flow.ts'
import type { AgentFlowPairing } from '../src/gates/agent-flow.ts'
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

describe('agent-flow native event rows', () => {
  it('records dispatch and settle attribution in the selected workflow store', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    recordDispatch({
      harnessDir,
      resolvedWorkflowDir: workflowDir,
      selectedGeneration,
      prompt: '## Assignment\n\n**Execute as**: fullstack-dev\n**Task category**: logic\n',
      violations: [],
      hard: false,
    })
    recordSettle({ harnessDir, workflowDir, selectedGeneration, agent: 'session-1', outcome: 'ok', role: 'fullstack-dev' })

    expect(readAgentFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['settle', 'dispatch'])
    expect(readAgentFlow(workflowDir)?.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', role: 'fullstack-dev' })
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
    expect(readAgentFlow(workflowDir)?.events.map((event) => event.kind)).toEqual(['settle', 'dispatch'])
    expect(readAgentFlow(workflowDir)?.events[0]).toMatchObject({ kind: 'settle', role: 'fullstack-dev', childId: 'child-session' })
    expect(pairing.dispatchByCallId.size).toBe(0)
  })

  it('preserves duplicate live evidence rows and refuses writes against a replaced generation', async () => {
    const { harnessDir, workflowDir, selectedGeneration } = await activeFixture()
    const row = JSON.stringify({ v: 1, ts: 1, kind: 'settle', outcome: 'ok' })
    expect(appendDshLedgerRow({ harnessDir }, 'wf-1', row, undefined, selectedGeneration).kind).toBe('written')
    expect(appendDshLedgerRow({ harnessDir }, 'wf-1', row, undefined, selectedGeneration).kind).toBe('written')
    expect(appendDshLedgerRow({ harnessDir }, 'wf-1', row, undefined, { ...selectedGeneration, epoch: selectedGeneration.epoch + 1 }).kind).toBe('degraded')
    expect(readAgentFlow(workflowDir)?.events).toHaveLength(2)
  })

  it('returns unavailable rather than reading legacy machine files without an active store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agent-flow-unavailable-'))
    roots.push(root)
    const harnessDir = join(root, '.agents')
    await mkdir(join(harnessDir, 'workflows', 'wf-1'), { recursive: true })
    await writeFile(join(harnessDir, 'workflows', 'wf-1', 'agent-flow.jsonl'), '{"v":1,"ts":1,"kind":"dispatch","role":"fullstack-dev","verdict":"ok","hard":false}\n')
    expect(readAgentFlow(join(harnessDir, 'workflows', 'wf-1'))).toBeNull()
  })
})
