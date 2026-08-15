/**
 * Task 2 (plan `20260815-dsh-workflow-ledger`) — W-B2 ledger schema extension:
 * the three workflow event kinds (`workflow-run`, `workflow-agent`,
 * `workflow-run-end`) narrow in `eventFromUnknown`, map through `eventView`,
 * and honor the same ledger discipline as the dispatch/settle kinds —
 * `AGENT_FLOW_MAX_EVENTS` truncation + size gate, malformed lines narrow to
 * `undefined` (never re-serialized). No producer is wired here (Task 3); the
 * tests drive the record function (`recordWorkflowEvent`) and seeded JSONL
 * lines directly.
 *
 * Ledger discipline pinned by the plan's Global Constraints: positional
 * invariants (post-end updates, duplicate member seq) are the upstream
 * consumer's job — the ledger persists what it sees; only SHAPE-malformed
 * lines (missing/wrong-typed fields, out-of-vocabulary values, bad v/ts)
 * narrow to `undefined`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_FLOW_FILE, AGENT_FLOW_MAX_EVENTS, readAgentFlow, recordDispatch, recordSettle } from '../src/index.ts'
import { AGENT_FLOW_SIZE_GATE_BYTES, recordWorkflowEvent } from '../src/gates/agent-flow.ts'
import type { AgentFlowWorkflowEvent } from '../src/gates/agent-flow.ts'
import {
  agentStartMissingRunId,
  runEndMissingRunId,
  runStartMissingRunId,
} from './fixtures/session-events.ts'

/* ---------------------------------- fixtures ---------------------------------- */

/** A fully valid writable Assignment (dispatch-record fixture — mirrors agent-flow.spec.ts). */
const VALID_PLANNED = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/agent-flow
**Plan Path**: /proj/plans/20260810-agent-flow.md

## Task 2

Implement the ledger, evidence-first.
`

/* ---------------------------------- helpers ---------------------------------- */

/** A ledger event line (v1 dispatch — seeded directly into agent-flow.jsonl). */
const dispatchLine = (ts: number, overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  ts,
  kind: 'dispatch',
  agent: 'a1',
  role: 'fullstack-dev',
  planId: '20260810-x',
  taskId: 'T2',
  taskCategory: 'logic',
  verdict: 'ok',
  hard: false,
  ...overrides,
})

/** Create a temp harness dir (bare-context tests — no Loader boot). */
async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  return { root, harnessDir }
}

/**
 * Parse one JSONL line to a record (validated boundary read — mirrors the
 * ledger's own `asRecord` guard; malformed → undefined). Test reads only.
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/* ===========================================================================
 * 1. Schema round-trip — recordWorkflowEvent → readAgentFlow
 * ========================================================================== */

describe('agent-flow workflow kinds — record / read round-trip', () => {
  it('recordWorkflowEvent appends v1 workflow events; readAgentFlow returns the rows with the workflow view fields', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-workflow-')
    try {
      const T0 = 1_700_000_000_000
      recordWorkflowEvent({
        harnessDir,
        event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })
      recordWorkflowEvent({
        harnessDir,
        event: { v: 1, ts: T0 + 1, kind: 'workflow-run', runId: 'run-2', name: 'audit', agent: 'sess-1' },
      })
      recordWorkflowEvent({
        harnessDir,
        event: {
          v: 1,
          ts: T0 + 2,
          kind: 'workflow-agent',
          runId: 'run-1',
          seq: 1,
          label: 'worker',
          phase: 'implement',
          childId: 'child-1',
        },
      })
      recordWorkflowEvent({
        harnessDir,
        event: { v: 1, ts: T0 + 3, kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'child-2' },
      })
      recordWorkflowEvent({
        harnessDir,
        event: { v: 1, ts: T0 + 4, kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' },
      })

      const view = readAgentFlow(harnessDir)
      expect(view).not.toBeNull()
      // Latest first — all three kinds survive the read path.
      expect(view!.events.map((e) => e.kind)).toEqual([
        'workflow-run-end',
        'workflow-agent',
        'workflow-agent',
        'workflow-run',
        'workflow-run',
      ])
      const [end, agent2, agent1, run2, run1v] = view!.events
      expect(run1v).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: null })
      expect(run2).toMatchObject({ kind: 'workflow-run', runId: 'run-2', name: 'audit', agent: 'sess-1' })
      expect(agent1).toMatchObject({
        kind: 'workflow-agent',
        runId: 'run-1',
        seq: 1,
        label: 'worker',
        phase: 'implement',
        childId: 'child-1',
      })
      expect(agent2).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'child-2' })
      // phase is OMITTED from the view when the event carried none.
      expect(agent2).not.toHaveProperty('phase')
      expect(end).toMatchObject({ kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' })

      // Serialized lines are v1 + lossless (no undefined-valued keys).
      const lines = readFileSync(join(harnessDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(5)
      const parsedLines = lines.map((l) => parseLine(l))
      for (const parsed of parsedLines) {
        expect(parsed?.v).toBe(1)
        expect(parsed !== undefined && Object.values(parsed).every((v) => v !== undefined)).toBe(true)
      }
      // Optional fields are OMITTED at the record boundary: `agent` on run-1's
      // run (line 0), `phase` on child-2's agent (line 3).
      expect(parsedLines[0]).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit' })
      expect(parsedLines[0]?.agent).toBeUndefined()
      expect(parsedLines[1]).toMatchObject({ kind: 'workflow-run', agent: 'sess-1' })
      expect(parsedLines[2]).toMatchObject({ kind: 'workflow-agent', phase: 'implement' })
      expect(parsedLines[3]?.phase).toBeUndefined()
      expect(parsedLines[4]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 2. Malformed narrowing — shape-malformed lines → undefined, never re-serialized
 * ========================================================================== */

describe('agent-flow workflow kinds — malformed lines narrow to undefined', () => {
  it('missing runId / wrong types / out-of-vocabulary stopReason / bad v-ts → skipped; valid + post-end rows persist', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-workflow-malformed-')
    try {
      const file = join(harnessDir, AGENT_FLOW_FILE)
      const T = 1_700_000_000_000
      const seed = [
        // missing runId (upstream stringId violation) per kind — fixture payloads
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run', ...runStartMissingRunId() }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', ...agentStartMissingRunId() }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run-end', ...runEndMissingRunId() }),
        // wrong types
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run', runId: 'r', name: 42 }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', runId: 'r', seq: '1', label: 'w', childId: 'c' }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', runId: 'r', seq: 1, label: 42, childId: 'c' }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', runId: 'r', seq: 1, label: 'w', childId: 42 }),
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run-end', runId: 'r', stopReason: 'bogus' }),
        // base guard: v === 1 + numeric ts are REQUIRED (plan Task 2 interface)
        JSON.stringify({ ts: T, kind: 'workflow-run', runId: 'r', name: 'a' }),
        JSON.stringify({ v: 1, kind: 'workflow-run', runId: 'r', name: 'a' }),
        JSON.stringify({ v: 1, ts: `${T}`, kind: 'workflow-run', runId: 'r', name: 'a' }),
        // valid workflow lines (agent carried on the run; phase absent)
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: 'sess-1' }),
        JSON.stringify({ v: 1, ts: T + 1, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' }),
        JSON.stringify({ v: 1, ts: T + 2, kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' }),
        // post-end update: shape-valid but POSITIONALLY invalid upstream — the
        // ledger persists what it sees (positional invariants are the
        // consumer's; plan Global Constraints).
        JSON.stringify({ v: 1, ts: T + 3, kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'child-2' }),
        '',
      ].join('\n') + '\n'
      await writeFile(file, seed)

      const before = readFileSync(file, 'utf8')
      const view = readAgentFlow(harnessDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-agent', 'workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'child-2' })
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' })
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' })
      expect(view!.events[3]).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: 'sess-1' })
      // Read NEVER rewrites the file — malformed lines narrow, not repair.
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 3. Ledger discipline — truncation across ALL kinds mixed
 * ========================================================================== */

describe('agent-flow workflow kinds — truncation keeps the most recent across all kinds', () => {
  it('truncates to the most recent AGENT_FLOW_MAX_EVENTS lines with workflow + dispatch + settle mixed', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-workflow-truncate-')
    try {
      const file = join(harnessDir, AGENT_FLOW_FILE)
      const T0 = 1_700_000_000_000
      // Seed the ledger with 480 dispatch lines (~164 B each ≈ 78.7 KiB) —
      // already ABOVE the 64 KiB size gate, so every appended line takes the
      // read-modify-write truncation path (no small-file append-only fast path).
      const seed = Array.from({ length: 480 }, (_, i) => dispatchLine(T0 + i)).join('\n') + '\n'
      await writeFile(file, seed)
      // Append 40 mixed events: 8 cycles of [dispatch, workflow-run,
      // workflow-agent, settle, workflow-run-end]. The appended lines are the
      // NEWEST 40 — after truncation to the most recent 500, ALL of them must
      // survive alongside the newest 460 seed lines (the oldest 20 seed
      // dispatch lines are dropped).
      for (let i = 0; i < 40; i += 1) {
        const ts = T0 + 1000 + i
        switch (i % 5) {
          case 0:
            recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
            break
          case 1:
            recordWorkflowEvent({
              harnessDir,
              event: { v: 1, ts, kind: 'workflow-run', runId: `run-${i}`, name: 'audit' },
            })
            break
          case 2:
            recordWorkflowEvent({
              harnessDir,
              event: { v: 1, ts, kind: 'workflow-agent', runId: `run-${i}`, seq: 1, label: 'worker', childId: `child-${i}` },
            })
            break
          case 3:
            recordSettle({ harnessDir, outcome: 'ok' })
            break
          case 4:
            recordWorkflowEvent({
              harnessDir,
              event: { v: 1, ts, kind: 'workflow-run-end', runId: `run-${i}`, stopReason: 'completed' },
            })
            break
        }
      }

      // The file stays above the size gate post-truncation (500 lines ≈ 79 KiB)
      // — the truncating read-modify-write ran on every appended line.
      expect(statSync(file).size).toBeGreaterThan(AGENT_FLOW_SIZE_GATE_BYTES)
      const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(AGENT_FLOW_MAX_EVENTS)
      // The 40 appended mixed events are the newest — ALL survive (8 of each
      // kind), alongside 460 kept seed dispatch lines (oldest 20 seed lines
      // dropped): dispatch 468, workflow kinds 8 each, settle 8.
      const kindCount = new Map<string, number>()
      const seedTs: number[] = []
      const tailKinds: string[] = []
      for (const [idx, line] of lines.entries()) {
        const rec = parseLine(line)
        if (rec === undefined) continue
        if (typeof rec.kind === 'string') kindCount.set(rec.kind, (kindCount.get(rec.kind) ?? 0) + 1)
        if (typeof rec.ts === 'number') {
          if (rec.ts < T0 + 1000) seedTs.push(rec.ts)
          else tailKinds.push(rec.kind as string)
        }
      }
      for (const [kind, count] of Object.entries({ dispatch: 468, 'workflow-run': 8, 'workflow-agent': 8, settle: 8, 'workflow-run-end': 8 })) {
        expect(kindCount.get(kind)).toBe(count)
      }
      // Only the most recent seed lines survive (oldest 20 dropped).
      expect(Math.min(...seedTs)).toBe(T0 + 20)
      // The tail is EXACTLY the appended cycle order — all kinds mixed, newest
      // kept: [dispatch, workflow-run, workflow-agent, settle, workflow-run-end] × 8.
      expect(tailKinds).toHaveLength(40)
      for (let i = 0; i < 40; i += 1) {
        const expected = ['dispatch', 'workflow-run', 'workflow-agent', 'settle', 'workflow-run-end'][i % 5]
        expect(tailKinds[i]).toBe(expected)
      }
      // The read view reflects the mixed tail (latest first — the last appended
      // workflow-run-end row is the newest event).
      const view = readAgentFlow(harnessDir, 500)
      expect(view!.events).toHaveLength(AGENT_FLOW_MAX_EVENTS)
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-39', ts: T0 + 1039 })
      const viewCounts = new Map<string, number>()
      for (const e of view!.events) viewCounts.set(e.kind, (viewCounts.get(e.kind) ?? 0) + 1)
      expect(viewCounts.get('dispatch')).toBe(468)
      expect(viewCounts.get('workflow-run')).toBe(8)
      expect(viewCounts.get('workflow-agent')).toBe(8)
      expect(viewCounts.get('settle')).toBe(8)
      expect(viewCounts.get('workflow-run-end')).toBe(8)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
