import { afterEach, describe, expect, it } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDshScanBound } from '@mstar-harness/engine'
import { readAgentFlow, digestOfLedgerLine, recordWorkflowEvent, workflowEventId } from '../src/gates/agent-flow.ts'
import type { AgentFlowWorkflowEvent } from '../src/gates/agent-flow.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { awaitWorkflowLedgerIdle, registerWorkflowLedger } from '../src/gates/workflow-ledger.ts'
import { resolveExecutionLedgerTarget } from '../src/gates/workflow-selection.ts'
import { seedActiveWorkflow, selectedGenerationFor } from './harness.ts'
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

  it('does not read, rewrite, or remove retained legacy event bytes', async () => {
    const { harnessDir, workflowDir } = await activeFixture()
    const legacyPath = join(workflowDir, 'agent-flow.jsonl')
    await mkdir(join(harnessDir, 'workflows', 'wf-1'), { recursive: true })
    const legacy = '{"v":1,"ts":1,"kind":"dispatch","role":"fullstack-dev","verdict":"ok","hard":false}\n'
    await writeFile(legacyPath, legacy)
    const before = await Bun.file(legacyPath).arrayBuffer()
    const event: AgentFlowWorkflowEvent = { v: 1, ts: 10, kind: 'workflow-run', runId: 'run-1', name: 'audit' }
    const line = JSON.stringify(event)
    const eventId = workflowEventId(event, { sessionId: 'session-1', streamId: 'stream-a', seq: 0 })
    expect(digestOfLedgerLine(line)).toHaveLength(32)
    expect(recordWorkflowEvent({ harnessDir, workflowDir, event, source: { sessionId: 'session-1', streamId: 'stream-a', seq: 0 }, selectedGeneration: selectedGenerationFor(harnessDir) })).toBe(true)
    expect(Buffer.from(await Bun.file(legacyPath).arrayBuffer())).toEqual(Buffer.from(before))
    expect(eventId).toContain('wfe1:workflow-run:session-1:stream-a:0')
  })
})
