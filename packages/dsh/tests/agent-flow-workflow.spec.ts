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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { AGENT_FLOW_FILE, AGENT_FLOW_MAX_EVENTS, readAgentFlow, recordDispatch, recordSettle } from '../src/index.ts'
import {
  AGENT_FLOW_SIZE_GATE_BYTES,
  recordWorkflowEvent,
  setAgentFlowLogger,
  WORKFLOW_LEDGER_MAX_ID_LENGTH,
  WORKFLOW_LEDGER_MAX_LABEL_LENGTH,
  WORKFLOW_LEDGER_MAX_NAME_LENGTH,
  WORKFLOW_LEDGER_TRUNCATION_MARKER,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowWorkflowEvent } from '../src/gates/agent-flow.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import { registerWorkflowLedger, setWorkflowLedgerLogger, WORKFLOW_LEDGER_WATERMARK_FILE } from '../src/gates/workflow-ledger.ts'
import { seedHarness, seedV2Tree, v2Root, v2Snapshot, v2WorkflowEntry } from './harness.ts'
import {
  agentEnd,
  agentEndMissingRunId,
  agentStart,
  agentStartMissingRunId,
  runEnd,
  runEndMissingRunId,
  runStart,
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

/**
 * Create a temp harness dir seeded with a minimal v2 tree (root status.json
 * + one active workflow `wf-1` + its snapshot) — the v3 write-path
 * precondition: the agent-flow writer / workflow-ledger consumer append only
 * to an ACTIVE workflow (plan `20260819-workflow-dsh-viz` Task 2).
 */
async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string; workflowDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await seedV2Tree(harnessDir)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows/wf-1') }
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
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-')
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

      const view = readAgentFlow(workflowDir)
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

      // Serialized lines are v1 + lossless (no undefined-valued keys). v3
      // layout: the ledger lives in the ACTIVE workflow dir, never the root.
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
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
      // The ROOT ledger is never written.
      expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
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
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-malformed-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
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
      const view = readAgentFlow(workflowDir)
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

  it('fractional / non-positive member seq and oversized fields narrow at the read boundary too (W-2 / W-3)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-caps-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const T = 1_700_000_000_000
      const seed = [
        // fractional member seq → narrows to undefined
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', runId: 'r', seq: 1.5, label: 'w', childId: 'c' }),
        // non-positive member seq → narrows to undefined
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-agent', runId: 'r', seq: 0, label: 'w', childId: 'c' }),
        // oversized runId → narrows to undefined (id fields are never
        // silently truncated into collisions at the panel boundary either)
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run', runId: 'x'.repeat(WORKFLOW_LEDGER_MAX_ID_LENGTH + 100), name: 'a' }),
        // oversized name (display) → the VIEW carries the capped name
        JSON.stringify({ v: 1, ts: T, kind: 'workflow-run', runId: 'r', name: 'n'.repeat(WORKFLOW_LEDGER_MAX_NAME_LENGTH + 100) }),
      ].join('\n') + '\n'
      await writeFile(file, seed)

      const view = readAgentFlow(workflowDir)
      expect(view!.events).toHaveLength(1)
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run', runId: 'r' })
      expect(view!.events[0].name!).toHaveLength(WORKFLOW_LEDGER_MAX_NAME_LENGTH)
      expect(view!.events[0].name!.endsWith(WORKFLOW_LEDGER_TRUNCATION_MARKER)).toBe(true)
      // Read NEVER rewrites the file.
      expect(readFileSync(file, 'utf8')).toBe(seed)
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
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-truncate-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
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
      const view = readAgentFlow(workflowDir, 500)
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

/* ===========================================================================
 * 4. Session-event consumer — cold scan + live firehose → ledger rows
 *    (plan `20260815-dsh-workflow-ledger` Task 3)
 * ========================================================================== */

/** Deterministic envelope timestamps (epoch ms — the consumer's `ts` source). */
const SESSION_T0 = 1_700_000_000_000

/** One structural fake session (the consumer's consumed surface: id + events + header). */
interface FakeSession {
  id: string
  events: FakeSessionEvent[]
  header?: { cwd?: string; delegationDepth?: number }
}

/** One structural fake `session/event` envelope (`{type, seq, time, data}` — `seq` = session-log position). */
interface FakeSessionEvent {
  type: string
  seq: number
  time: number
  // `object` (not `Record<string, unknown>`): the fixture payload interfaces
  // (e.g. `ToolWorkflowRunStartData`) have no index signature; the consumer
  // reads the payload structurally via `asRecord` anyway.
  data: object
}

let fakeSessionSeq = 0

/** Compose a fake session whose log carries the given event data payloads (envelope seq/time assigned). */
function fakeSession(events: Array<{ type: string; data: object }>, init: { id?: string; header?: FakeSession['header'] } = {}): FakeSession {
  return {
    id: init.id ?? `sess-${fakeSessionSeq++}`,
    events: events.map((e, i) => ({ type: e.type, seq: i, time: SESSION_T0 + i, data: e.data })),
    header: init.header,
  }
}

/**
 * Minimal in-memory `sessions` service for the workflow-ledger consumer tests
 * (plan `20260815-dsh-workflow-ledger` Task 3): implements the ONE contract
 * the consumer reads — `get(id)` / `list()` over live sessions — plus the
 * append+emit drivers the real SessionStore owns. Sessions are STRUCTURAL
 * FAKES (plain objects): `@deepseek-ai/dsh-session` cannot construct under
 * Bun/JSC (`Session.create` rejects non-lossless-JSON headers — Task 1
 * review reproduced the throw), and the consumer reads only `id` / `events`
 * / `header.cwd` / `header.delegationDepth` structurally.
 */
class FakeSessionRegistry extends Service {
  private readonly app: Context
  private readonly live = new Map<string, FakeSession>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    this.app = ctx
  }

  /** Record one live session (the real store's `create`/`enter` contract). */
  register(session: FakeSession): void {
    this.live.set(session.id, session)
  }

  /**
   * Drive a full session creation — register + `session/created` announce —
   * the real store's `create()` = prepare → enter → announce contract
   * (upstream `session/src/index.ts:822-844`; the seed events enter the log
   * in the constructor, BEFORE the announce, so the created listener sees
   * the seeded snapshot). Emitted with the carrier FIRST, like the
   * `session/event` driver.
   */
  create(session: FakeSession): void {
    this.live.set(session.id, session)
    this.app.events.emit({}, 'session/created', session)
  }

  /** Look up a live session by id (the consumer's depth-advisory read). */
  get(id: string): FakeSession | undefined {
    return this.live.get(id)
  }

  /** All live sessions, in registration order (the consumer's cold-scan read). */
  list(): FakeSession[] {
    return [...this.live.values()]
  }

  /**
   * Drive one append + `session/event` firehose emit — the real store's
   * append+emit contract (`seq = log.length`, push, then post-commit emit).
   * The CARRIER comes FIRST — the real store dispatches
   * `[carrier, 'session/event', session, event]`, and cordis `dispatch`
   * shifts the leading object as `this` before the event name, so a
   * name-first emit would deliver `(carrier, session, event)` to listeners.
   * A carrier without a scope filter admits every listener — the same
   * admission a root-context listener gets from the real store (Task 1 seam
   * notes §2).
   */
  append(session: FakeSession, type: string, data: object): FakeSessionEvent {
    const event: FakeSessionEvent = { type, seq: session.events.length, time: SESSION_T0 + session.events.length, data }
    session.events.push(event)
    this.app.events.emit({}, 'session/event', session, event)
    return event
  }

  /** Re-emit an already-logged envelope on the firehose (cold+live overlap replay). */
  replay(session: FakeSession, event: FakeSessionEvent): void {
    this.app.events.emit({}, 'session/event', session, event)
  }
}

describe('workflow-ledger consumer — cold scan over session event snapshots (plan Task 3)', () => {
  it('records run + members + end with childId preserved; agent-end carries no ledger row', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-cold-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      { type: 'tool-workflow/agent-start', data: agentStart({ childId: 'child-1' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 2, label: 'reviewer', phase: 'review', childId: 'child-2' }) },
      { type: 'tool-workflow/agent-end', data: agentEnd({ seq: 1 }) },
      { type: 'tool-workflow/agent-end', data: agentEnd({ seq: 2 }) },
      { type: 'tool-workflow/run-end', data: runEnd() },
    ], { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view).not.toBeNull()
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-agent', 'workflow-run'])
      const [end, agent2, agent1, run] = view!.events
      expect(run).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: 'parent-1', ts: SESSION_T0 })
      expect(agent1).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1', ts: SESSION_T0 + 1 })
      expect(agent1).not.toHaveProperty('phase')
      expect(agent2).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'reviewer', phase: 'review', childId: 'child-2', ts: SESSION_T0 + 2 })
      expect(end).toMatchObject({ kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed', ts: SESSION_T0 + 5 })
      // The agent-end envelopes are filtered — they never become ledger rows.
      expect(view!.events.filter((e) => e.kind === 'workflow-agent')).toHaveLength(2)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cold-load + live append overlap produces ONE row per (runId, kind, seq)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-overlap-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      { type: 'tool-workflow/agent-start', data: agentStart() },
      { type: 'tool-workflow/agent-end', data: agentEnd() },
      { type: 'tool-workflow/run-end', data: runEnd() },
    ], { id: 'parent-1', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // The cold scan recorded 3 rows (agent-end filtered) and the cursor sits
      // at the snapshot length. Re-emitting the SAME envelopes on the firehose
      // (replay) must not append anything — one row per (runId, kind, seq).
      for (const event of parent.events) sessions.replay(parent, event)
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(3)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('live session/event appends record rows for a session created after registration', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-live-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([], { id: 'parent-live', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-live' }))
      sessions.append(parent, 'tool-workflow/agent-start', agentStart({ runId: 'run-live', childId: 'child-live' }))
      sessions.append(parent, 'tool-workflow/run-end', runEnd({ runId: 'run-live' }))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-live', stopReason: 'completed' })
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-live', childId: 'child-live', ts: SESSION_T0 + 1 })
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-run', runId: 'run-live', name: 'audit', agent: 'parent-live' })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing session read is contained — one warn, the run and other sessions unaffected', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-crash-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // A valid session whose run must be recorded…
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-ok' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-ok' }) },
    ], { id: 'parent-ok', header: { cwd: root } }))
    // …and a hostile session whose events snapshot getter THROWS mid-scan.
    sessions.register({
      id: 'parent-hostile',
      get events(): never {
        throw new Error('snapshot exploded')
      },
    })
    // A child whose header depth getter throws at advisory-read time.
    sessions.register({
      id: 'child-hostile',
      events: [],
      header: {
        get delegationDepth(): never {
          throw new Error('header exploded')
        },
      },
    })
    const captured: Array<{ level: string; message: string }> = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { captured.push({ level, message }) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // The valid session's rows were recorded despite the hostile neighbor.
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-run'])
      // The hostile cold-scan read produced exactly one warn.
      expect(captured.filter((c) => c.level === 'warn' && c.message.includes('cold scan failed for session parent-hostile'))).toHaveLength(1)
      // A live event whose depth advisory reads a throwing child header still
      // records the agent row; the advisory degrades with one contained warn.
      const parent = fakeSession([], { id: 'parent-live', header: { cwd: root } })
      sessions.register(parent)
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-live' }))
      sessions.append(parent, 'tool-workflow/agent-start', agentStart({ runId: 'run-live', childId: 'child-hostile' }))
      sessions.append(parent, 'tool-workflow/run-end', runEnd({ runId: 'run-live' }))
      const after = readAgentFlow(workflowDir)
      expect(after!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run', 'workflow-run-end', 'workflow-run'])
      expect(after!.events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-live', childId: 'child-hostile' })
      expect(captured.filter((c) => c.level === 'warn' && c.message.includes('depth advisory degraded'))).toHaveLength(1)
      // No other warns escaped — the consumer stayed contained throughout.
      expect(captured.filter((c) => c.level === 'warn')).toHaveLength(2)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sessions service absent → one debug log + consumer disabled (composition without dsh-session)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-degrade-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { captured.push(`${level}: ${message}`) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(captured).toHaveLength(1)
      expect(captured[0]).toBe('debug: sessions service absent — workflow-ledger consumer disabled (composition without dsh-session)')
      // No listener was registered — a firehose emit is a no-op, never a throw.
      ctx.events.emit({}, 'session/event', { id: 'x' }, { type: 'tool-workflow/run-start', seq: 0, time: SESSION_T0, data: runStart() })
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(0)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('depth advisory warns once per run at depth >= 2 and never at depth 1', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-depth-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register({ id: 'child-deep', events: [], header: { delegationDepth: 2 } })
    sessions.register({ id: 'child-mid', events: [], header: { delegationDepth: 1 } })
    sessions.register({ id: 'child-deeper', events: [], header: { delegationDepth: 3 } })
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      // Two deep members + one shallow member in run-1: ONE warn for the run.
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 1, childId: 'child-deep' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 2, childId: 'child-mid' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 3, childId: 'child-deep' }) },
      { type: 'tool-workflow/run-end', data: runEnd() },
      // run-2 starts fresh: its own deep member gets its own warn.
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-2', seq: 1, childId: 'child-deeper' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-2' }) },
    ], { id: 'parent-1', header: { cwd: root } }))
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // Exactly TWO warns — one per run at depth >= 2, never per member, never at depth 1.
      expect(captured).toHaveLength(2)
      expect(captured[0]).toContain('run-1')
      expect(captured[0]).toContain('child-deep')
      expect(captured[0]).toContain('depth 2')
      expect(captured[1]).toContain('run-2')
      expect(captured[1]).toContain('child-deeper')
      expect(captured[1]).toContain('depth 3')
      // All rows still landed — the advisory never alters recording.
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual([
        'workflow-run-end',
        'workflow-agent',
        'workflow-run',
        'workflow-run-end',
        'workflow-agent',
        'workflow-agent',
        'workflow-agent',
        'workflow-run',
      ])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('malformed session events (missing runId) are skipped without aborting the pass', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-malformed-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStartMissingRunId() },
      { type: 'tool-workflow/agent-start', data: agentStartMissingRunId() },
      { type: 'tool-workflow/agent-end', data: agentEndMissingRunId() },
      { type: 'tool-workflow/run-end', data: runEndMissingRunId() },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-ok' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-ok', childId: 'child-ok' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-ok' }) },
    ], { id: 'parent-1', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // A live malformed event after registration is skipped too — no abort.
      sessions.append(parent, 'tool-workflow/run-start', runStartMissingRunId())
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-run', runId: 'run-ok', agent: 'parent-1' })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-apply (second registration) does NOT duplicate rows — the durable watermark survives registrations (W-1b / F-301)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-reapply-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      { type: 'tool-workflow/agent-start', data: agentStart() },
      { type: 'tool-workflow/agent-end', data: agentEnd() },
      { type: 'tool-workflow/run-end', data: runEnd() },
    ], { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      // FIRST registration: the cold scan records 3 rows (agent-end filtered).
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // SECOND registration on the same context (HMR reload / config re-mount):
      // a fresh registration used to start with EMPTY cursors and re-record
      // every row of the same live session — the durable watermark must
      // suppress the already-recorded envelopes.
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(3)
      // The durable watermark sidecar was written into the ACTIVE WORKFLOW
      // dir (v3 layout — `workflows/<id>/workflow-ledger-cursors.json`, the
      // exact format a fresh process reads on restart; the cross-restart
      // dedupe contract): session id → next expected envelope seq (4 = the
      // snapshot length; the seq-2 agent-end envelope was filtered, so the
      // cursor advanced only past the three mapped rows). The ROOT cursor
      // file is never written (no read fallback after migration).
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(true)
      expect(existsSync(join(harnessDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
      const watermark = JSON.parse(readFileSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), 'utf8'))
      expect(watermark).toEqual({ v: 1, cursors: { 'parent-1': 4 } })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cursor watermark is PER WORKFLOW — a new active workflow id starts a fresh cursor in its own dir (the cache keys the workflow dir, not the harness dir)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-workflow-consumer-perwf-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
    ], { id: 'parent-1', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // wf-1's ledger + watermark hold the row.
      expect(readAgentFlow(join(harnessDir, 'workflows/wf-1'))!.events).toHaveLength(1)
      expect(existsSync(join(harnessDir, 'workflows/wf-1', WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(true)
      // The active set moves to a NEW workflow (wf-2): the same session's
      // NEXT envelope records into wf-2's dir with a FRESH cursor — the
      // wf-1 cursors never leak into wf-2 (the module cache keys the
      // WORKFLOW DIR, so a new active workflow id means a new sidecar).
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-2')]),
        'workflows/wf-2/snapshot.json': v2Snapshot('wf-2'),
      })
      sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-2', name: 'audit' })
      const wf2 = readAgentFlow(join(harnessDir, 'workflows/wf-2'))!
      expect(wf2.events).toHaveLength(1)
      expect(wf2.events[0]).toMatchObject({ kind: 'workflow-run', runId: 'run-2', name: 'audit' })
      expect(existsSync(join(harnessDir, 'workflows/wf-2', WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(true)
      // wf-1's ledger is untouched by the wf-2 rows (one row each).
      expect(readAgentFlow(join(harnessDir, 'workflows/wf-1'))!.events).toHaveLength(1)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a session created AFTER apply with constructor-seeded events is cold-scanned once on session/created (W-1a / S-304)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-created-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // The session is created AFTER apply with a constructor-seeded log
      // (replay/resume/fork — seeded events NEVER publish on the firehose,
      // `firstLiveSeq`), so only the `session/created` backfill can see them.
      const parent = fakeSession([
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-seeded' }) },
        { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-seeded', childId: 'child-seeded' }) },
        { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-seeded' }) },
      ], { id: 'parent-seeded', header: { cwd: root } })
      sessions.create(parent)
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-run', runId: 'run-seeded', agent: 'parent-seeded' })
      // A second apply re-walks the same live session — the durable watermark
      // keeps the backfill idempotent (no duplicates, no re-record).
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const after = readAgentFlow(workflowDir)
      expect(after!.events).toHaveLength(3)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fractional envelope seq is skipped WITHOUT corrupting the cursor — later integer envelopes still record (W-2)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-fracseq-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // Built manually (not via fakeSession): a hostile envelope with seq 1.5
    // between valid integer envelopes. A permissive `Number.isFinite` guard
    // would accept it, advance the cursor to 2.5, and silently drop every
    // later integer envelope (seq 2, 3, …) — the W-2 corruption mode.
    sessions.register({
      id: 'parent-1',
      header: { cwd: root },
      events: [
        { type: 'tool-workflow/run-start', seq: 0, time: SESSION_T0, data: runStart() },
        { type: 'tool-workflow/agent-start', seq: 1.5, time: SESSION_T0 + 1, data: agentStart() },
        { type: 'tool-workflow/agent-start', seq: 2, time: SESSION_T0 + 2, data: agentStart({ seq: 2, label: 'reviewer', childId: 'child-2' }) },
        { type: 'tool-workflow/run-end', seq: 3, time: SESSION_T0 + 3, data: runEnd() },
      ],
    })
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      // The fractional envelope is skipped; the integer envelopes AFTER it
      // are NOT dropped (the cursor never advanced past them).
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'reviewer', childId: 'child-2' })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fractional / non-positive member seq skips the agent row (W-2)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-fracmember-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 1.5 }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 1, childId: 'child-1' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 0 }) },
      { type: 'tool-workflow/run-end', data: runEnd() },
    ], { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 1, childId: 'child-1' })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('oversized id fields skip the row; oversized display fields truncate with a suffix marker (W-3)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-caps-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const longId = 'x'.repeat(WORKFLOW_LEDGER_MAX_ID_LENGTH + 100)
    const longName = 'n'.repeat(WORKFLOW_LEDGER_MAX_NAME_LENGTH + 100)
    const longLabel = 'l'.repeat(WORKFLOW_LEDGER_MAX_LABEL_LENGTH + 100)
    sessions.register(fakeSession([
      // run-start with an oversized runId → SKIPPED (id fields must never be
      // silently truncated into collisions).
      { type: 'tool-workflow/run-start', data: runStart({ runId: longId }) },
      // run-start with an oversized NAME (display) → truncated deterministically.
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-ok', name: longName }) },
      // agent-start with an oversized childId → SKIPPED.
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-ok', seq: 1, label: 'worker', childId: longId }) },
      // agent-start with oversized LABEL + PHASE (display) → both truncated.
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-ok', seq: 2, label: longLabel, phase: longLabel, childId: 'child-2' }) },
      // run-end with an oversized runId → SKIPPED.
      { type: 'tool-workflow/run-end', data: runEnd({ runId: longId }) },
    ], { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      // Only the two shape-valid rows survive; every oversized-id row is gone.
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-agent', 'workflow-run'])
      const run = view!.events[1]
      expect(run).toMatchObject({ kind: 'workflow-run', runId: 'run-ok' })
      expect(run.name!).toHaveLength(WORKFLOW_LEDGER_MAX_NAME_LENGTH)
      expect(run.name!.endsWith(WORKFLOW_LEDGER_TRUNCATION_MARKER)).toBe(true)
      expect(run.name!.startsWith('n'.repeat(WORKFLOW_LEDGER_MAX_NAME_LENGTH - WORKFLOW_LEDGER_TRUNCATION_MARKER.length))).toBe(true)
      const agent = view!.events[0]
      expect(agent).toMatchObject({ kind: 'workflow-agent', runId: 'run-ok', seq: 2, childId: 'child-2' })
      expect(agent.label!).toHaveLength(WORKFLOW_LEDGER_MAX_LABEL_LENGTH)
      expect(agent.label!.endsWith(WORKFLOW_LEDGER_TRUNCATION_MARKER)).toBe(true)
      expect(agent.phase!).toHaveLength(WORKFLOW_LEDGER_MAX_LABEL_LENGTH)
      expect(agent.phase!.endsWith(WORKFLOW_LEDGER_TRUNCATION_MARKER)).toBe(true)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a failing ledger append does NOT advance the watermark — a re-apply re-attempts the row (R-401)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-appendfail-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
    ], { id: 'parent-1', header: { cwd: root } }))
    // Corrupt the ledger FILE SLOT: a DIRECTORY named agent-flow.jsonl makes
    // every append fail (EISDIR) while the same-dir watermark sidecar path
    // stays writable — the exact failure asymmetry R-401 describes.
    const ledgerFile = join(workflowDir, AGENT_FLOW_FILE)
    await mkdir(ledgerFile, { recursive: true })
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger(() => {})
    const priorAgentFlowSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      // FIRST registration: the append fails (contained — one warn), the
      // durable watermark must NOT advance; advanceWatermark is the only
      // writer of the sidecar, so no watermark file exists.
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(captured.some((m) => m.includes('workflow record failed'))).toBe(true)
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
      // Repair the ledger slot, then re-apply: the cold scan re-walks the
      // same envelope (cursor still 0) and RE-ATTEMPTS the row — bounded
      // re-attempt, NOT permanent loss.
      await rm(ledgerFile, { recursive: true, force: true })
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run'])
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: 'parent-1' })
      // The watermark now covers the row — a THIRD registration must not
      // duplicate it (the success path is unaffected by the ordering swap).
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)
    } finally {
      setAgentFlowLogger(priorAgentFlowSink)
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing sessions.list() is contained — one warn, the cold scan skipped, the consumer stays live (S7)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-listthrows-')
    const ctx = new Context()
    class ThrowingListRegistry extends FakeSessionRegistry {
      override list(): FakeSession[] {
        throw new Error('list exploded')
      }
    }
    const sessions = new ThrowingListRegistry(ctx)
    const captured: Array<{ level: string; message: string }> = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { captured.push({ level, message }) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // Exactly one warn for the failed list(); the cold scan is skipped —
      // the registration must NOT throw (a service-level list() failure can
      // no longer fail plugin apply).
      expect(captured.filter((c) => c.level === 'warn' && c.message.includes('could not list sessions'))).toHaveLength(1)
      // The consumer is still live: a session appended AFTER the registration
      // records through the firehose (S7 skips the COLD SCAN only).
      const parent = fakeSession([], { id: 'parent-live', header: { cwd: root } })
      sessions.register(parent)
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-live' }))
      sessions.append(parent, 'tool-workflow/agent-start', agentStart({ runId: 'run-live', childId: 'child-live' }))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-agent', 'workflow-run'])
      // No other warns escaped — the consumer stayed contained throughout.
      expect(captured.filter((c) => c.level === 'warn')).toHaveLength(1)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('control characters are stripped from display fields at the consumer boundary — no log/line forging (S1)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-controlchars-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      // A hostile run name carrying newline/tab/CR → sanitized, row recorded.
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-clean', name: 'audit\nSECOND' }) },
      // A hostile member label + phase → both sanitized.
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-clean', seq: 1, label: 'worker\rX', phase: 'review\t1', childId: 'child-1' }) },
      // A display field that is ONLY control characters → the row is skipped
      // (stripped to '' — the same empty-display rule the read boundary
      // applies, so write and read stay consistent).
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-empty', name: '\n\t' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-clean' }) },
    ], { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-run', runId: 'run-clean', name: 'auditSECOND' })
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-agent', runId: 'run-clean', seq: 1, label: 'workerX', phase: 'review1', childId: 'child-1' })
      // Only run-clean recorded; the all-controls run-empty row was skipped.
      expect(view!.events.filter((e) => e.kind === 'workflow-run').map((e) => e.runId)).toEqual(['run-clean'])
      // The JSONL file holds exactly the mapped rows and no raw control
      // characters anywhere.
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(3)
      expect(lines.every((line) => !/[\u0000-\u001F\u007F]/.test(line))).toBe(true)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 5. Catalog view — workflow rows + the DISTINCT summary bucket
 *    (plan `20260815-dsh-workflow-ledger` Task 4)
 * ========================================================================== */

describe('catalog view — workflow rows + distinct summary bucket (plan W-B2 Task 4)', () => {
  it('summary counts workflow runs as a DISTINCT bucket — never folded into dispatch-role counts', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-summary-')
    try {
      const T0 = 1_700_000_000_000
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'fan-out' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 1, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 2, kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' } })
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })

      const view = readAgentFlow(workflowDir)
      expect(view).not.toBeNull()
      // The workflow rows classify with their STABLE catalog field names
      // (runId/name/seq/label/childId/stopReason — the panel contract).
      // Latest first: the dispatch (recorded at wall-clock NOW, after the T0
      // workflow rows) is the newest event.
      expect(view!.events.map((e) => e.kind)).toEqual(['dispatch', 'workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view!.events[1]).toMatchObject({ kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' })
      expect(view!.events[2]).toMatchObject({ kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' })
      expect(view!.events[3]).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'fan-out' })
      // Summary: workflow rows sit in a DISTINCT 'workflow' pseudo-role bucket
      // (outcome = the stable kind name); the dispatch-role counts stay
      // untouched — the Task-2 stopgap role='' kind-bucket is replaced.
      expect(view!.summary).toEqual([
        { role: 'fullstack-dev', outcome: 'ok', count: 1 },
        { role: 'workflow', outcome: 'workflow-agent', count: 1 },
        { role: 'workflow', outcome: 'workflow-run', count: 1 },
        { role: 'workflow', outcome: 'workflow-run-end', count: 1 },
      ])
      // No workflow row hides under an empty role (stopgap behavior) and no
      // dispatch-role row absorbs a workflow count.
      expect(view!.summary.filter((r) => r.role === '')).toEqual([])
      expect(view!.summary.filter((r) => r.role === 'fullstack-dev')).toEqual([{ role: 'fullstack-dev', outcome: 'ok', count: 1 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('multiple runs + repeated members aggregate into the SAME distinct workflow buckets', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-summary2-')
    try {
      const T0 = 1_700_000_000_000
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'fan-out' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 1, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'c1' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 2, kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'c2' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 3, kind: 'workflow-run', runId: 'run-2', name: 'audit' } })
      recordWorkflowEvent({ harnessDir, event: { v: 1, ts: T0 + 4, kind: 'workflow-run-end', runId: 'run-2', stopReason: 'error' } })

      const view = readAgentFlow(workflowDir)
      expect(view!.summary).toEqual([
        { role: 'workflow', outcome: 'workflow-agent', count: 2 },
        { role: 'workflow', outcome: 'workflow-run', count: 2 },
        { role: 'workflow', outcome: 'workflow-run-end', count: 1 },
      ])
      // The sum of the summary counts = the window's event count (every event
      // lands in exactly one bucket — the role×outcome invariant).
      expect(view!.summary.reduce((sum, r) => sum + r.count, 0)).toBe(view!.events.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
