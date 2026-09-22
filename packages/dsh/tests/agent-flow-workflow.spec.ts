/**
 * Task 2  — W-B2 ledger schema extension:
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
  AGENT_FLOW_HISTORY_DIR,
  AGENT_FLOW_INDEX_FILE,
  AGENT_FLOW_SIZE_GATE_BYTES,
  advanceWatermark,
  agentFlowLedgerCacheDirCounts,
  digestOfLedgerLine,
  listAgentFlowHistoryChunks,
  recordWorkflowEvent,
  setAgentFlowLogger,
  WORKFLOW_LEDGER_LOCKDIR,
  WORKFLOW_LEDGER_MAX_ID_LENGTH,
  WORKFLOW_LEDGER_MAX_LABEL_LENGTH,
  WORKFLOW_LEDGER_MAX_NAME_LENGTH,
  WORKFLOW_LEDGER_TRUNCATION_MARKER,
  WORKFLOW_LEDGER_WATERMARK_FILE,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowEventSource } from '../src/gates/agent-flow.ts'
import { HarnessResolver } from '../src/gates/_shared.ts'
import {
  awaitWorkflowLedgerIdle,
  registerWorkflowLedger,
  setWorkflowLedgerLogger,
} from '../src/gates/workflow-ledger.ts'
import type { WorkflowLedgerTarget } from '../src/gates/workflow-ledger.ts'
import { seedHarness, seedV2Tree, v2Root, v2Snapshot, v2WorkflowEntry } from './harness.ts'
import { readWorkflowSessionBinding, updateWorkflowSessionBinding } from '../src/engine-status-store.ts'
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
**Plan Path**: /proj/plans/00000810-agent-flow.md

## Task 2

Implement the ledger, evidence-first.
`

/* ---------------------------------- helpers ---------------------------------- */

/**
 * One durable source position for `recordWorkflowEvent` — the record identity
 * transport. The defaults put every row of a block on ONE stream (the common
 * shape); a test proving stream separation passes an explicit `streamId`.
 */
const src = (seq: number, sessionId = 'sess-1', streamId = sessionId): AgentFlowEventSource => ({ sessionId, streamId, seq })

/** One session's durable scan bound (v2 cursor sidecar), or undefined. */
function cursorEntry(workflowDir: string, sessionId: string): { next: number; stream?: string } | undefined {
  const raw = readFileSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), 'utf8')
  const parsed = JSON.parse(raw) as { v: number; cursors: Record<string, { next: number; stream?: string }> }
  return parsed.cursors[sessionId]
}

/** The durable accepted-identity index rows of one workflow dir (`{id, d}` lines). */
function indexRows(workflowDir: string): Array<{ id: string; d: string }> {
  return readFileSync(join(workflowDir, AGENT_FLOW_INDEX_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; d: string })
}

/** A verified-shaped stream id as the consumer derives it (`s1-<32 hex>`). */
const STREAM_SHAPE = /^s1-[0-9a-f]{32}$/

/** A ledger event line (v1 dispatch — seeded directly into agent-flow.jsonl). */
const dispatchLine = (ts: number, overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  ts,
  kind: 'dispatch',
  agent: 'a1',
  role: 'fullstack-dev',
  planId: '00000810-x',
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
 * to an ACTIVE workflow .
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
        source: src(0, 'sess-0'),
        event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })
      recordWorkflowEvent({
        harnessDir,
        source: src(1, 'sess-0'),
        event: { v: 1, ts: T0 + 1, kind: 'workflow-run', runId: 'run-2', name: 'audit', agent: 'sess-1' },
      })
      recordWorkflowEvent({
        harnessDir,
        source: src(2, 'sess-0'),
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
        source: src(3, 'sess-0'),
        event: { v: 1, ts: T0 + 3, kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'child-2' },
      })
      recordWorkflowEvent({
        harnessDir,
        source: src(4, 'sess-0'),
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
        // base guard: v === 1 + numeric ts are REQUIRED ( interface)
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
              source: src(i),
              event: { v: 1, ts, kind: 'workflow-run', runId: `run-${i}`, name: 'audit' },
            })
            break
          case 2:
            recordWorkflowEvent({
              harnessDir,
              source: src(i),
              event: { v: 1, ts, kind: 'workflow-agent', runId: `run-${i}`, seq: 1, label: 'worker', childId: `child-${i}` },
            })
            break
          case 3:
            recordSettle({ harnessDir, outcome: 'ok' })
            break
          case 4:
            recordWorkflowEvent({
              harnessDir,
              source: src(i),
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
 *    
 * ========================================================================== */

/** Deterministic envelope timestamps (epoch ms — the consumer's `ts` source). */
const SESSION_T0 = 1_700_000_000_000

/**
 * One structural fake session on the INSTALLED Session surface the consumer
 * reads: the identity header (`header.id` / `header.cwd`), the `seq`
 * log-length contract, and `eventAt(seq)` for one exact envelope. The real
 * `Session` has NO `events` member (`'events' in session === false` — the old
 * `.events` snapshot read was structurally dead against it), so the fixture
 * keeps its append log under `log` — a fixture-only driver field the consumer
 * never reads.
 */
interface FakeSession {
  header: { id: string; cwd?: string; delegationDepth?: number }
  /**
   * The installed `Session`'s durable fork-lineage cut
   * (`inheritedEventCount`): the leading events a conversation fork copied
   * from its parent. `0` for every unseeded session — the real constructor
   * enforces that default, and the fixture mirrors it.
   */
  inheritedEventCount: number
  /** The next event's sequence number — the real `Session`'s `seq ≡ log.length` contract. */
  readonly seq: number
  eventAt(seq: number): FakeSessionEvent | undefined
  log: FakeSessionEvent[]
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
function fakeSession(
  seed: Array<{ type: string; data: object }>,
  init: { id?: string; header?: Omit<FakeSession['header'], 'id'>; inheritedEventCount?: number } = {},
): FakeSession {
  const log: FakeSessionEvent[] = seed.map((e, i) => ({ type: e.type, seq: i, time: SESSION_T0 + i, data: e.data }))
  return {
    header: { id: init.id ?? `sess-${fakeSessionSeq++}`, ...init.header },
    inheritedEventCount: init.inheritedEventCount ?? 0,
    log,
    get seq(): number { return log.length },
    eventAt(seq: number): FakeSessionEvent | undefined { return log[seq] },
  }
}

/**
 * Minimal in-memory `sessions` service for the workflow-ledger consumer tests
 *  implements the ONE contract
 * the consumer reads — `get(id)` / `list()` over live sessions — plus the
 * append+emit drivers the real SessionStore owns. Sessions are STRUCTURAL
 * FAKES (plain objects): `@deepseek-ai/dsh-session` cannot construct under
 * Bun/JSC (`Session.create` rejects non-lossless-JSON headers — Task 1
 * review reproduced the throw), and the consumer reads only `header.id` /
 * `header.cwd` / `header.delegationDepth` / `seq` / `eventAt(seq)`
 * structurally.
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
    this.live.set(session.header.id, session)
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
    this.live.set(session.header.id, session)
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
    const event: FakeSessionEvent = { type, seq: session.log.length, time: SESSION_T0 + session.log.length, data }
    session.log.push(event)
    this.app.events.emit({}, 'session/event', session, event)
    return event
  }

  /** Re-emit an already-logged envelope on the firehose (cold+live overlap replay). */
  replay(session: FakeSession, event: FakeSessionEvent): void {
    this.app.events.emit({}, 'session/event', session, event)
  }
}

/**
 * Minimal in-memory `agents` service for the workflow-ledger lease tests:
 * the ONE contract the consumer reads — `get(sessionId)` → the session's live
 * Agent (a structural fake: `{ id, session: { header } }`, the shape
 * `agentIdOf` / `sessionHeaderIdOf` / `sessionCwdOf` read).
 */
class FakeAgentRegistry extends Service {
  private readonly live = new Map<string, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  /** Record the live Agent of one session (the registry is keyed by `SessionId`). */
  register(sessionId: string, agent: unknown): void {
    this.live.set(sessionId, agent)
  }

  /** The session's live Agent (the consumer's lease-holder read). */
  get(id: string): unknown {
    return this.live.get(id)
  }
}

/** One live Agent handle for one session (the lease holder `Agent.id`). */
function fakeAgent(id: string, sessionId: string, cwd: string): Record<string, unknown> {
  return { id, session: { header: { id: sessionId, cwd } } }
}

describe('workflow-ledger consumer — cold scan over session event snapshots ()', () => {
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
      for (const event of parent.log) sessions.replay(parent, event)
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
    // …and a hostile session whose log-length read THROWS mid-scan.
    sessions.register({
      header: { id: 'parent-hostile' },
      inheritedEventCount: 0,
      log: [],
      get seq(): number {
        throw new Error('snapshot exploded')
      },
      eventAt: () => undefined,
    })
    // A child whose header depth getter throws at advisory-read time.
    sessions.register({
      header: {
        id: 'child-hostile',
        get delegationDepth(): never {
          throw new Error('header exploded')
        },
      },
      inheritedEventCount: 0,
      log: [],
      get seq(): number { return 0 },
      eventAt: () => undefined,
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

  it('a throwing header.id is contained — the cold scan survives and other sessions still record', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-idthrows-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // A hostile session whose IDENTITY read throws. The cold scan extracts
    // `header.id` BEFORE the per-session containment, so the throw escaped
    // `registerWorkflowLedger` and broke plugin apply.
    const hostile = fakeSession([], { id: 'parent-hostile' })
    sessions.register(hostile)
    Object.defineProperty(hostile.header, 'id', {
      get(): never {
        throw new Error('header exploded')
      },
      configurable: true,
    })
    // A valid session whose run must still be recorded.
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-ok' }) },
    ], { id: 'parent-ok', header: { cwd: root } }))
    const captured: Array<{ level: string; message: string }> = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { captured.push({ level, message }) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.runId)).toEqual(['run-ok'])
      // One contained warn; the id IS the throwing read, so the message falls
      // back to a placeholder instead of re-reading the hostile header.
      expect(captured.filter((c) => c.level === 'warn' && c.message.includes('cold scan failed for session unknown'))).toHaveLength(1)
      expect(captured.filter((c) => c.level === 'warn')).toHaveLength(1)
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
    sessions.register(fakeSession([], { id: 'child-deep', header: { delegationDepth: 2 } }))
    sessions.register(fakeSession([], { id: 'child-mid', header: { delegationDepth: 1 } }))
    sessions.register(fakeSession([], { id: 'child-deeper', header: { delegationDepth: 3 } }))
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
      // The durable cursor sidecar was written into the ACTIVE WORKFLOW dir
      // (v3 layout — `workflows/<id>/workflow-ledger-cursors.json`) as the v2
      // entry form: the next expected envelope seq plus the VERIFIED log
      // incarnation the bound belongs to. The ROOT cursor file is never
      // written (no read fallback after migration).
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(true)
      expect(existsSync(join(harnessDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
      const cursor = cursorEntry(workflowDir, 'parent-1')!
      expect(cursor.next).toBe(4)
      expect(cursor.stream).toMatch(STREAM_SHAPE)
      // The accepted-identity index carries one durable entry per accepted row
      // (the dedup authority that survives compaction and cursor eviction).
      expect(indexRows(workflowDir)).toHaveLength(3)
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
      // The seeded log is the installed surface (no `.events`), and the
      // fixture's `create` announces the session WITHOUT emitting a single
      // `session/event` — the rows below can only come from the backfill.
      expect('events' in parent).toBe(false)
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

  it('a FORKED child does not re-record its parent-inherited tool-workflow prefix into the same workflow dir', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-fork-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // The parent ran a workflow BEFORE the fork: three durable rows that are
    // the PARENT's, already recorded by its own scan.
    const prefix = [
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-parent' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-parent', childId: 'child-parent' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-parent' }) },
    ]
    sessions.register(fakeSession(prefix, { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(3)

      // `SessionStore.fork()` copies the parent's log into the child and
      // stamps the durable lineage cut (`inheritedEventCount` = seed length);
      // the child then appends its OWN run. The child has no watermark cursor
      // of its own, so the `session/created` backfill's walk must start at the
      // cut — from 0 the parent's rows enter the SAME workflow dir a second
      // time, attributed to the child, breaking the
      // one-row-per-(runId, kind, envelope seq) invariant the sibling suite
      // pins and inflating the run's member count.
      const child = fakeSession([
        ...prefix,
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-child' }) },
      ], { id: 'child-1', header: { cwd: root }, inheritedEventCount: prefix.length })
      sessions.create(child)

      const view = readAgentFlow(workflowDir)!
      // Newest first: the child's own row, then the parent's three.
      expect(view.events.map((e) => e.kind)).toEqual(['workflow-run', 'workflow-run-end', 'workflow-agent', 'workflow-run'])
      // Each run-start row is recorded ONCE, under the session that produced
      // it — the child contributes only its own events.
      expect(view.events.filter((e) => e.kind === 'workflow-run').map((e) => [e.runId, e.agent])).toEqual([
        ['run-child', 'child-1'],
        ['run-parent', 'parent-1'],
      ])
      expect(readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')).toHaveLength(4)
      // Idempotent across a re-apply: the cut bounds the walk while the
      // watermark still advances for the child's OWN row.
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(4)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a cwd-less FORKED child still honors the lineage cut — its inherited prefix is never re-recorded', async () => {
    // The explicit `{HARNESS_DIR}` (the resolver's config arm) means `consume`
    // resolves a write target for a session with NO `header.cwd`, so the walk
    // itself is the only bound on what the child may record. An early `0` in
    // `scanStartSeq` (the old no-cwd branch) re-walked the inherited prefix and
    // re-appended the parent's three rows under the child.
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-fork-nocwd-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const prefix = [
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-parent' }) },
      { type: 'tool-workflow/agent-start', data: agentStart({ runId: 'run-parent', childId: 'child-parent' }) },
      { type: 'tool-workflow/run-end', data: runEnd({ runId: 'run-parent' }) },
    ]
    sessions.register(fakeSession(prefix, { id: 'parent-1', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(3)

      // The fork's child carries NO workspace (`header.cwd` absent) — the
      // dispatch still ran under the explicitly configured harness, so its own
      // row must record, and only it.
      const child = fakeSession([
        ...prefix,
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-child' }) },
      ], { id: 'child-1', header: {}, inheritedEventCount: prefix.length })
      sessions.create(child)

      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['workflow-run', 'workflow-run-end', 'workflow-agent', 'workflow-run'])
      expect(view.events.filter((e) => e.kind === 'workflow-run').map((e) => [e.runId, e.agent])).toEqual([
        ['run-child', 'child-1'],
        ['run-parent', 'parent-1'],
      ])
      expect(readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')).toHaveLength(4)
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
    // Built from the shared fixture (not a bespoke object): the log-length
    // contract holds and ONE envelope is patched to the hostile fractional
    // seq. A permissive `Number.isFinite` guard would accept it, advance the
    // cursor to 2.5, and silently drop every later integer envelope (seq 2,
    // 3, …) — the W-2 corruption mode.
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
      { type: 'tool-workflow/agent-start', data: agentStart() },
      { type: 'tool-workflow/agent-start', data: agentStart({ seq: 2, label: 'reviewer', childId: 'child-2' }) },
      { type: 'tool-workflow/run-end', data: runEnd() },
    ], { id: 'parent-1', header: { cwd: root } })
    parent.log[1] = { ...parent.log[1]!, seq: 1.5 }
    sessions.register(parent)
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
      // A failing append never turns into a durable exclusion either: the row
      // is attributed to the bound workflow, so no exclusion floor is
      // recorded for the session — the re-apply below is free to re-attempt.
      expect(readWorkflowSessionBinding(harnessDir, 'parent-1', root)).toEqual({ kind: 'ok' })
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

  it('the module-level ledger caches stay bounded across many workflow dirs — the oldest dir is evicted at the cap and re-read on revisit ', async () => {
    const { root, harnessDir } = await tempHarness('dsh-workflow-consumer-cachecap-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([], { id: 'parent-1', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // Walk past the dir cap: each new active workflow id caches its own scan
      // bound and identity index (wf-2 … the cap + 2 — the caches must never
      // grow unbounded in a long-lived process).
      for (let i = 2; i <= 66; i += 1) {
        await seedHarness(harnessDir, {
          'status.json': v2Root([v2WorkflowEntry(`wf-${i}`)]),
          [`workflows/wf-${i}/snapshot.json`]: v2Snapshot(`wf-${i}`),
        })
        sessions.append(parent, 'tool-workflow/run-start', { runId: `run-${i}`, name: 'audit' })
      }
      const counts = agentFlowLedgerCacheDirCounts()
      // Every append reads the durable cursor fresh, so 65 distinct dirs went
      // through the module cache — it must have evicted down to the cap.
      expect(counts.cursors).toBeLessThanOrEqual(64)
      // The FIRST cached dir (wf-2) was evicted at the cap — but the FILES are
      // the durable stores: revisiting wf-2 re-reads them and keeps advancing
      // (65 appended events; cursor = next expected seq 66).
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-2')]),
        'workflows/wf-2/snapshot.json': v2Snapshot('wf-2'),
      })
      sessions.append(parent, 'tool-workflow/run-start', { runId: 'run-2-revisited', name: 'audit' })
      const wf2Cursor = cursorEntry(join(harnessDir, 'workflows/wf-2'), 'parent-1')!
      expect(wf2Cursor.next).toBe(66)
      expect(wf2Cursor.stream).toMatch(STREAM_SHAPE)
      // The revisited row landed in wf-2's ledger exactly once (no duplicate
      // from the re-read — the fresh load replaced the stale view), and every
      // accepted row of that dir is indexed.
      const wf2Flow = readAgentFlow(join(harnessDir, 'workflows/wf-2'))!
      expect(wf2Flow.events.map((e) => e.kind)).toEqual(['workflow-run', 'workflow-run'])
      expect(wf2Flow.events.map((e) => e.runId)).toEqual(['run-2-revisited', 'run-2'])
      expect(indexRows(join(harnessDir, 'workflows/wf-2'))).toHaveLength(2)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a held workflow lock refuses the record: nothing durable moves, and a later retry advances once', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-lockheld-')
    const captured: string[] = []
    const priorAgentFlowSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      // A foreign lockdir = a peer holding the workflow lock (crashed or stuck
      // mid-write). The whole transaction is refused: no row, no identity
      // index entry, no scan bound.
      const lockDir = join(workflowDir, WORKFLOW_LEDGER_LOCKDIR)
      await mkdir(lockDir, { recursive: true })
      expect(advanceWatermark(workflowDir, 'parent-1', 1, 's1-stalled', () => false, { timeoutMs: 120 })).toBe(false)
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
      expect(captured.some((m) => m.includes('cursor advance refused'))).toBe(true)

      // The peer recovers: the refusal cost a retry, never a lost or a
      // duplicated record.
      await rm(lockDir, { recursive: true, force: true })
      expect(advanceWatermark(workflowDir, 'parent-1', 1, 's1-stalled', () => false)).toBe(true)
      expect(cursorEntry(workflowDir, 'parent-1')).toEqual({ next: 1, stream: 's1-stalled' })
    } finally {
      setAgentFlowLogger(priorAgentFlowSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('crash after append/before cursor: a FRESH process replays into the recorded event id and only advances the bound (no duplicate)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-lockrestart-')
    let script = ''
    try {
      // Build the degraded state through the REAL consumer (same identity
      // derivation as the restarting process): the cold scan records all three
      // rows, then the durable cursor is rewound to the LEGACY v1 form holding
      // the checkpoint that preceded seq 2 — the state a crash between the
      // append and the cursor save leaves behind.
      const ctx = new Context()
      const sessions = new FakeSessionRegistry(ctx)
      sessions.register(fakeSession([
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-3' }) },
      ], { id: 'parent-1', header: { cwd: root } }))
      const priorSink = setWorkflowLedgerLogger(() => {})
      try {
        registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      } finally {
        setWorkflowLedgerLogger(priorSink)
        await ctx.fiber.dispose().catch(() => {})
      }
      await writeFile(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), JSON.stringify({ v: 1, cursors: { 'parent-1': 2 } }))
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(3)

      // "Restart": a FRESH process (empty module cache) re-reads the stale
      // durable cursor and re-walks the same session log — seq 2 is FOUND by
      // its stable event id with identical bytes, so it is NOT appended a
      // second time; the cursor catches up durably.
      const pkgRoot = join(import.meta.dir, '..')
      script = join(pkgRoot, `.tmp-restart-recovery-${process.pid}-${Date.now()}.ts`)
      await writeFile(script, [
        "import { Context, Service } from '@deepseek-ai/cordis'",
        "import { registerWorkflowLedger } from './src/gates/workflow-ledger.ts'",
        "import { HarnessResolver } from './src/gates/_shared.ts'",
        "import { readAgentFlow } from './src/gates/agent-flow.ts'",
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'interface SessionFixture {',
        '  header: { id: string; cwd: string }',
        '  log: Array<{ type: string; seq: number; time: number; data: object }>',
        '  readonly seq: number',
        '  eventAt(seq: number): unknown',
        '}',
        'class FakeSession {',
        "  constructor(id, cwd) { this.header = { id, cwd }; this.log = [] }",
        '  get seq() { return this.log.length }',
        '  eventAt(seq) { return this.log[seq] }',
        '}',
        'class Registry extends Service {',
        "  constructor(ctx: Context) { super(ctx, 'sessions') }",
        '  sessions = new Map<string, SessionFixture>()',
        '  list(): SessionFixture[] { return [...this.sessions.values()] }',
        '  get(id: string): SessionFixture | undefined { return this.sessions.get(id) }',
        '}',
        'const harnessDir = process.argv[2]',
        'const workflowDir = process.argv[3]',
        'const ctx = new Context()',
        'const reg = new Registry(ctx)',
        'const session = new FakeSession("parent-1", harnessDir)',
        'session.log.push(',
        "  { type: 'tool-workflow/run-start', seq: 0, time: 1700000000000, data: { runId: 'run-1', name: 'audit' } },",
        "  { type: 'tool-workflow/run-start', seq: 1, time: 1700000000001, data: { runId: 'run-2', name: 'audit' } },",
        "  { type: 'tool-workflow/run-start', seq: 2, time: 1700000000002, data: { runId: 'run-3', name: 'audit' } },",
        ')',
        'reg.sessions.set(session.header.id, session)',
        'registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))',
        "const view = readAgentFlow(workflowDir)",
        "const cursor = JSON.parse(readFileSync(join(workflowDir, 'workflow-ledger-cursors.json'), 'utf8'))",
        'console.log(JSON.stringify({ runIds: view?.events.map((e) => e.runId) ?? [], cursor: { v: cursor.v, entry: cursor.cursors["parent-1"] } }))',
      ].join('\n'))
      const proc = Bun.spawn(['bun', script, harnessDir, workflowDir], { cwd: pkgRoot, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const exit = await proc.exited
      const stderr = await new Response(proc.stderr).text()
      expect(stderr).toBe('')
      expect(exit).toBe(0)
      const result = JSON.parse(await new Response(proc.stdout).text()) as { runIds: string[]; cursor: { v: number; entry: { next: number; stream?: string } } }
      // Exactly one row per accepted event — the replay recognized seq 2 by
      // its stable event id and advanced the bound without re-appending.
      expect([...result.runIds].sort()).toEqual(['run-1', 'run-2', 'run-3'])
      expect(result.cursor.v).toBe(2)
      expect(result.cursor.entry.next).toBe(3)
      // The legacy v1 bound was adopted once and re-stamped with the VERIFIED
      // incarnation the restarting process derived for this log.
      expect(result.cursor.entry.stream).toMatch(/^s1-[0-9a-f]{32}$/)
    } finally {
      await rm(script, { force: true }).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('concurrent process watermark advances serialize under the per-workflow lock — no cursor clobber, both sessions persist ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-cursorrace-')
    let script = ''
    try {
      // Each child runs the REAL consumer in its own process: a fake
      // sessions service holding ONE session (distinct ids), and appends 5
      // run-starts on the live firehose. Without the inter-process lock +
      // fresh read, each process's whole-map save would clobber the other's
      // cursor (the duplicate-on-restart regression mode W-1 closes).
      const pkgRoot = join(import.meta.dir, '..')
      script = join(pkgRoot, `.tmp-concurrent-cursors-${process.pid}-${Date.now()}.ts`)
      await writeFile(script, [
        "import { Context, Service } from '@deepseek-ai/cordis'",
        "import { registerWorkflowLedger } from './src/gates/workflow-ledger.ts'",
        "import { HarnessResolver } from './src/gates/_shared.ts'",
        'interface SessionFixture {',
        '  header: { id: string; cwd: string }',
        '  log: Array<{ type: string; seq: number; time: number; data: object }>',
        '  readonly seq: number',
        '  eventAt(seq: number): unknown',
        '}',
        'class FakeSession {',
        '  constructor(id, cwd) { this.header = { id, cwd }; this.log = [] }',
        '  get seq() { return this.log.length }',
        '  eventAt(seq) { return this.log[seq] }',
        '}',
        'class Registry extends Service {',
        '  constructor(ctx: Context) { super(ctx, \'sessions\') }',
        '  sessions = new Map<string, SessionFixture>()',
        '  list(): SessionFixture[] { return [...this.sessions.values()] }',
        '  get(id: string): SessionFixture | undefined { return this.sessions.get(id) }',
        '  register(s: SessionFixture): void { this.sessions.set(s.header.id, s) }',
        '}',
        'const harnessDir = process.argv[2]',
        'const sid = process.argv[3]',
        'const count = Number(process.argv[4])',
        'const ctx = new Context()',
        'const reg = new Registry(ctx)',
        'const session = new FakeSession(sid, harnessDir)',
        'reg.register(session)',
        'registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))',
        'for (let i = 0; i < count; i += 1) {',
        "  const event = { type: 'tool-workflow/run-start', seq: i, time: Date.now() + i, data: { runId: `${sid}-${i}`, name: 'audit' } }",
        '  session.log.push(event)',
        "  ctx.events.emit({}, 'session/event', session, event)",
        '}',
      ].join('\n'))

      const spawnChild = (sid: string) =>
        Bun.spawn(['bun', script, harnessDir, sid, '5'], { cwd: pkgRoot, stdin: 'ignore', stderr: 'pipe' })
      const a = spawnChild('proc-a')
      const b = spawnChild('proc-b')
      const [aExit, bExit] = [await a.exited, await b.exited]
      expect(aExit).toBe(0)
      expect(bExit).toBe(0)

      // BOTH sessions' bounds survived the whole-map saves — the last writer's
      // file carries both (the lock + fresh read made the read-modify-write
      // atomic across processes), each stamped with the incarnation that
      // process derived for its own session log.
      const entryA = cursorEntry(workflowDir, 'proc-a')!
      const entryB = cursorEntry(workflowDir, 'proc-b')!
      expect(entryA.next).toBe(5)
      expect(entryB.next).toBe(5)
      expect(entryA.stream).toMatch(STREAM_SHAPE)
      expect(entryB.stream).toMatch(STREAM_SHAPE)
      expect(entryA.stream).not.toBe(entryB.stream)
      // The ledger holds all 10 rows (5 per process) — nothing lost.
      const flow = readAgentFlow(workflowDir)!
      expect(flow.events).toHaveLength(10)
      expect(flow.events.map((e) => e.kind)).toEqual([
        'workflow-run', 'workflow-run', 'workflow-run', 'workflow-run', 'workflow-run',
        'workflow-run', 'workflow-run', 'workflow-run', 'workflow-run', 'workflow-run',
      ])
    } finally {
      await rm(script, { force: true }).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 4a. D3 cold scan over the INSTALLED Session surface — `seq` + `eventAt`
 *     (the real `Session` has no `events` member; the `.events` snapshot
 *     read was structurally dead against it)
 * ========================================================================== */

describe('workflow-ledger consumer — installed Session surface (seq + eventAt)', () => {
  it('cold-scans a bound session through seq + eventAt — no .events member (D3 red-first pin)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-surface-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStart() },
    ], { id: 'parent-1', header: { cwd: root } })
    // The pin: the fixture IS the installed surface (`'events' in session ===
    // false` — T0 live evidence). The old `scanSession` read `.events`, so it
    // returned immediately and recorded nothing.
    expect('events' in parent).toBe(false)
    expect(parent.seq).toBe(1)
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      const view = readAgentFlow(workflowDir)
      expect(view).not.toBeNull()
      expect(view!.events.map((e) => e.kind)).toEqual(['workflow-run'])
      expect(view!.events[0]).toMatchObject({ kind: 'workflow-run', runId: 'run-1', name: 'audit', agent: 'parent-1' })
      // The scan captured the end seq once: an event appended AFTER the scan
      // is the live firehose's responsibility, never re-read by the cold walk.
      expect(parent.seq).toBe(1)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a session without the installed surface (no seq / no eventAt) is skipped, not crashed on', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-workflow-consumer-surface-absent-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const noSeq = fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-no-seq' }) }], {
      id: 'parent-no-seq',
      header: { cwd: root },
    })
    // A structurally incomplete session — the installed surface is validated,
    // not assumed: an absent `seq` never enters the scan (no crash, no row).
    Reflect.deleteProperty(noSeq, 'seq')
    const noEventAt = fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-no-eventat' }) }], {
      id: 'parent-no-eventat',
      header: { cwd: root },
    })
    Reflect.deleteProperty(noEventAt, 'eventAt')
    sessions.register(noSeq)
    sessions.register(noEventAt)
    const observed: string[] = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { observed.push(`${level}: ${message}`) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // Neither incomplete session is readable → nothing recorded anywhere,
      // and the structural rejection is silent (an absent surface is not a
      // fault the operator owns).
      expect(observed).toEqual([])
      expect(readAgentFlow(workflowDir)!.events).toEqual([])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 4b. D4 session binding + the no-backfill exclusion floor
 * ========================================================================== */

describe('workflow-ledger consumer — D4 session binding + exclusion floor', () => {
  /** A temp harness with TWO active lifecycles (the concurrent-active registry). */
  async function tempMultiHarness(
    prefix: string,
    snapshots: { 'wf-a'?: Record<string, unknown>; 'wf-b'?: Record<string, unknown> } = {},
  ): Promise<{ root: string; harnessDir: string; dirs: Record<string, string> }> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-a'), v2WorkflowEntry('wf-b')]),
      'workflows/wf-a/snapshot.json': v2Snapshot('wf-a', snapshots['wf-a']),
      'workflows/wf-b/snapshot.json': v2Snapshot('wf-b', snapshots['wf-b']),
    })
    return { root, harnessDir, dirs: { 'wf-a': join(harnessDir, 'workflows/wf-a'), 'wf-b': join(harnessDir, 'workflows/wf-b') } }
  }

  /** One engine-valid `execution_lease` row (the resolver's lease rung). */
  function lease(holder: string, worktreePath: string): Record<string, unknown> {
    return { holder, claimed_at: '2026-09-11', worktree_path: worktreePath, working_branch: `feature/${holder}` }
  }

  /**
   * Two active lifecycles on ONE shared control worktree, where only a lease
   * HOLDER can decide: the cwd rung matches both entries, and `wf-b`'s lease
   * worktree sits OUTSIDE the control tree, so the lease rung matches neither
   * by path. The session's workspace is a real directory under the shared
   * control worktree (the containment rule compares realpaths).
   */
  async function sharedControlHarness(): Promise<{
    root: string
    leaseRoot: string
    harnessDir: string
    dirs: Record<string, string>
    workspace: string
  }> {
    const leaseRoot = await mkdtemp(join(tmpdir(), 'dsh-ledger-lease-holder-root-'))
    const control = join(leaseRoot, 'repo')
    await mkdir(join(control, 'src'), { recursive: true })
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-lease-holder-', {
      'wf-a': { control_worktree_path: control },
      'wf-b': {
        control_worktree_path: control,
        plans: [{ id: 'p-b', status: 'InProgress', execution_lease: lease('agent-b', join(leaseRoot, 'worktrees/wf-b')) }],
      },
    })
    return { root, leaseRoot, harnessDir, dirs, workspace: join(control, 'src') }
  }

  it('a session whose cwd rung is ambiguous records under the lifecycle its VERIFIED lease holder owns', async () => {
    const { root, leaseRoot, harnessDir, dirs, workspace } = await sharedControlHarness()
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const agents = new FakeAgentRegistry(ctx)
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-b' }) }], { id: 'sess-shared', header: { cwd: workspace } }))
    agents.register('sess-shared', fakeAgent('agent-b', 'sess-shared', workspace))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-b'])!.events.map((e) => e.runId)).toEqual(['run-b'])
      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      // Bound, not excluded: the resolver's lease rung decided, so no
      // exclusion floor was ever observed for this session.
      expect(readWorkflowSessionBinding(harnessDir, 'sess-shared', workspace)).toEqual({ kind: 'ok' })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
      await rm(leaseRoot, { recursive: true, force: true })
    }
  })

  it('an Agent whose own session header names another session never supplies a lease holder', async () => {
    const { root, leaseRoot, harnessDir, dirs, workspace } = await sharedControlHarness()
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const agents = new FakeAgentRegistry(ctx)
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-weird' }) }], { id: 'sess-shared', header: { cwd: workspace } }))
    // SAME workspace (so only the identity check can reject it) but the handle
    // belongs to a different session: an unverified holder must never bind the
    // row — the session stays unbound and the row is excluded.
    agents.register('sess-shared', fakeAgent('agent-b', 'sess-other', workspace))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      expect(readWorkflowSessionBinding(harnessDir, 'sess-shared', workspace)).toEqual({
        kind: 'ok',
        binding: { cwd: workspace, excludedBeforeSeq: 1 },
      })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
      await rm(leaseRoot, { recursive: true, force: true })
    }
  })

  it('two sessions in one harness record into the lifecycle each is bound to', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-bound-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-a' }) }], { id: 'sess-a', header: { cwd: root } }))
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-b' }) }], { id: 'sess-b', header: { cwd: root } }))
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-a', root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-b', root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-b' }).kind).toBe('written')
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-a'])
      expect(readAgentFlow(dirs['wf-b'])!.events.map((e) => e.runId)).toEqual(['run-b'])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a bound session keeps floor 0 — a pre-apply row is still recoverable', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-floor-zero-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-pre' }) }], { id: 'sess-a', header: { cwd: root } }))
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-a', root, { excludedBeforeSeq: 0, selectedWorkflowId: 'wf-a' }).kind).toBe('written')
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      // Recovery semantics for a BOUND session: with no exclusion history the
      // floor stays 0, so the pre-apply run-start is still recorded.
      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-pre'])
      expect(readWorkflowSessionBinding(harnessDir, 'sess-a', root)).toEqual({
        kind: 'ok',
        binding: { cwd: root, selectedWorkflowId: 'wf-a', excludedBeforeSeq: 0 },
      })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an unbound row is skipped with ZERO workflow-dir writes and persists n+1 as the exclusion floor, so a later pick never backfills it', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-unbound-floor-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-excluded' }) }], { id: 'sess-unbound', header: { cwd: root } })
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      // Nothing was written anywhere; the observation advanced the floor.
      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      expect(readWorkflowSessionBinding(harnessDir, 'sess-unbound', root)).toEqual({
        kind: 'ok',
        binding: { cwd: root, excludedBeforeSeq: 1 },
      })

      // The operator picks wf-a. The picker commits `max(oldFloor, seq)` —
      // the already-persisted floor stands (an older observation never walks
      // the exclusion window back).
      expect(updateWorkflowSessionBinding(harnessDir, 'sess-unbound', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 0 }).kind).toBe('written')

      // A re-apply (restart) re-scans the same log: the pre-pick row stays
      // excluded, and a NEW row records normally.
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-after' }))
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-after'])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an unreadable binding record pauses attribution — no rows anywhere and the store bytes are untouched', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-store-broken-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([{ type: 'tool-workflow/run-start', data: runStart({ runId: 'run-x' }) }], { id: 'sess-x', header: { cwd: root } }))
    const storePath = join(harnessDir, 'snapshots', 'engine-status.json')
    await seedHarness(harnessDir, { 'snapshots/engine-status.json': '{ "sv": 1, "entries": ' })
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((_level, message) => { captured.push(message) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      // The corrupt store is REPORTED and left byte-identical (never reset).
      expect(captured.some((m) => m.includes('store-invalid-json'))).toBe(true)
      expect(readFileSync(storePath, 'utf8')).toBe('{ "sv": 1, "entries": ')
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('coalesces a multi-row unbound scan into ONE floor value — the maximum row seq + 1', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-floor-coalesce-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-3' }) },
    ], { id: 'sess-unbound', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      // The scan still converges on the row-max floor (nothing is lost by the
      // per-scan batching) and writes NO workflow dir.
      expect(readWorkflowSessionBinding(harnessDir, 'sess-unbound', root)).toEqual({
        kind: 'ok',
        binding: { cwd: root, excludedBeforeSeq: 3 },
      })
      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reaches the durable floor with ONE store write per scan, not one per row', async () => {
    const { root, harnessDir } = await tempMultiHarness('dsh-ledger-floor-one-write-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-3' }) },
    ], { id: 'sess-unbound', header: { cwd: root } }))
    // Hold the snapshot-dir lock: every floor write degrades, and the module's
    // warn IS the write — one warn ⇒ one lock/read-modify-write for the scan
    // (a per-row writer would report three).
    const lockDir = join(harnessDir, 'snapshots', WORKFLOW_LEDGER_LOCKDIR)
    await mkdir(lockDir, { recursive: true })
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((_level, message) => { captured.push(message) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(captured.filter((m) => m.includes('exclusion floor not persisted'))).toHaveLength(1)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await rm(lockDir, { recursive: true, force: true })
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the scan starts at max(success cursor, exclusion floor) — the excluded prefix is never even read', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-scan-start-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-old-1' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-old-2' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-new' }) },
    ], { id: 'sess-start', header: { cwd: root } })
    const reads: number[] = []
    parent.eventAt = (seq: number) => {
      reads.push(seq)
      return parent.log[seq]
    }
    sessions.register(parent)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      // The operator picked wf-a when the log already held two rows: the pick
      // commits `excludedBeforeSeq = seq`, so those rows are intentional
      // exclusions — not "history the scan happens to filter out".
      expect(updateWorkflowSessionBinding(harnessDir, 'sess-start', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 2 }).kind).toBe('written')
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(reads).toEqual([2])
      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-new'])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      // The success cursor now sits at the captured end (3): a re-apply has
      // nothing left to read at all — the floor and the cursor agree.
      reads.length = 0
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      expect(reads).toEqual([])
      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-new'])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a floor past the log end is reported as identity drift — scan skipped, exclusion record preserved', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-floor-drift-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-behind-floor' }) },
    ], { id: 'sess-drift', header: { cwd: root } }))
    // An exclusion floor ahead of the log can only be a rebuilt/reused session
    // identity (the floor is durable, the log is not). Resetting it would
    // replay rows the operator already excluded — report and skip instead.
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-drift', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 5 }).kind).toBe('written')
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((_level, message) => { captured.push(message) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(captured.some((m) => m.includes('drift'))).toBe(true)
      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      // The intentional exclusion record is untouched — never reset to zero.
      expect(readWorkflowSessionBinding(harnessDir, 'sess-drift', root)).toEqual({
        kind: 'ok',
        binding: { cwd: root, selectedWorkflowId: 'wf-a', excludedBeforeSeq: 5 },
      })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an EMPTY rebuilt log with a floor ahead of zero still reports identity drift — the zero-length fast return must not skip the diagnostic', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-floor-drift-empty-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // The same identity drift as the non-empty case, but on a rebuilt session
    // whose log is EMPTY (`seq === 0`): the durable floor is ahead of the log,
    // so the contract's report-and-preserve path must still run.
    sessions.register(fakeSession([], { id: 'sess-empty-drift', header: { cwd: root } }))
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-empty-drift', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 5 }).kind).toBe('written')
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((_level, message) => { captured.push(message) })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(captured.some((m) => m.includes('drift'))).toBe(true)
      expect(readAgentFlow(dirs['wf-a'])!.events).toEqual([])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      // The intentional exclusion record is preserved, never reset to zero.
      expect(readWorkflowSessionBinding(harnessDir, 'sess-empty-drift', root)).toEqual({
        kind: 'ok',
        binding: { cwd: root, selectedWorkflowId: 'wf-a', excludedBeforeSeq: 5 },
      })
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a log shorter than the recorded success cursor is re-walked, never skipped by the stale cursor', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-ledger-log-rebuild-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
    ], { id: 'sess-rebuilt', header: { cwd: root } }))
    expect(updateWorkflowSessionBinding(harnessDir, 'sess-rebuilt', root, { selectedWorkflowId: 'wf-a', excludedBeforeSeq: 0 }).kind).toBe('written')
    // The durable cursor names a position PAST this log: id reuse after
    // disposal / a rebuilt session. The scan must re-walk from the floor so
    // the new log's rows are recorded (the rebuild guard), not skip them all.
    await writeFile(join(dirs['wf-a']!, WORKFLOW_LEDGER_WATERMARK_FILE), JSON.stringify({ v: 1, cursors: { 'sess-rebuilt': 9 } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.runId)).toEqual(['run-2', 'run-1'])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 5. Catalog view — workflow rows + the DISTINCT summary bucket
 *    
 * ========================================================================== */

describe('catalog view — workflow rows + distinct summary bucket (plan W-B2 Task 4)', () => {
  it('summary counts workflow runs as a DISTINCT bucket — never folded into dispatch-role counts', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-workflow-summary-')
    try {
      const T0 = 1_700_000_000_000
      recordWorkflowEvent({ harnessDir, source: src(0), event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'fan-out' } })
      recordWorkflowEvent({ harnessDir, source: src(1), event: { v: 1, ts: T0 + 1, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'child-1' } })
      recordWorkflowEvent({ harnessDir, source: src(2), event: { v: 1, ts: T0 + 2, kind: 'workflow-run-end', runId: 'run-1', stopReason: 'completed' } })
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
      recordWorkflowEvent({ harnessDir, source: src(0), event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-1', name: 'fan-out' } })
      recordWorkflowEvent({ harnessDir, source: src(1), event: { v: 1, ts: T0 + 1, kind: 'workflow-agent', runId: 'run-1', seq: 1, label: 'worker', childId: 'c1' } })
      recordWorkflowEvent({ harnessDir, source: src(2), event: { v: 1, ts: T0 + 2, kind: 'workflow-agent', runId: 'run-1', seq: 2, label: 'worker', childId: 'c2' } })
      recordWorkflowEvent({ harnessDir, source: src(3), event: { v: 1, ts: T0 + 3, kind: 'workflow-run', runId: 'run-2', name: 'audit' } })
      recordWorkflowEvent({ harnessDir, source: src(4), event: { v: 1, ts: T0 + 4, kind: 'workflow-run-end', runId: 'run-2', stopReason: 'error' } })

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

/* ===========================================================================
 * 6. F2 record identity, bounded history compaction and the explicit target
 * ========================================================================== */

/** One raw ledger line carrying a durable identity (the transport a real writer emits). */
function sourcedLine(ts: number, runId: string, sessionId: string, streamId: string, seq: number, pad: string): string {
  return JSON.stringify({
    v: 1,
    ts,
    kind: 'workflow-run',
    runId,
    name: pad,
    eventId: `wfe1:workflow-run:${sessionId}:${streamId}:${seq}`,
    source: { sessionId, streamId, seq },
  })
}

/** The identity index entry of one raw ledger line (the durable dedup record of an accepted row). */
function indexLineOf(line: string): string {
  const eventId = parseLine(line)!.eventId
  return `${JSON.stringify({ id: eventId, d: digestOfLedgerLine(line) })}\n`
}

/** Seed the durable accepted-identity index for the given raw ledger lines. */
async function seedIdentityIndex(workflowDir: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(workflowDir, AGENT_FLOW_INDEX_FILE), lines.map(indexLineOf).join(''))
}

describe('agent-flow — record identity + bounded history (F2)', () => {
  it('a compacted display tail archives the evicted lines byte-exact, in order, and keeps the newest 500', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-history-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const T0 = 1_700_000_000_000
      // 510 accepted rows above the size gate (≈ 220 B each ≈ 112 KiB), every
      // one of them durably indexed — the state a real accepted history has.
      const pad = 'x'.repeat(180)
      const seeded = Array.from({ length: AGENT_FLOW_MAX_EVENTS + 10 }, (_, i) => sourcedLine(T0 + i, `run-${i}`, 'sess-seed', 'sess-seed', i, pad))
      await writeFile(file, `${seeded.join('\n')}\n`)
      await seedIdentityIndex(workflowDir, seeded)
      expect(statSync(file).size).toBeGreaterThan(AGENT_FLOW_SIZE_GATE_BYTES)

      // ONE live append crosses the gate and compacts the oldest 11 rows.
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-live'),
        event: { v: 1, ts: T0 + 1000, kind: 'workflow-run', runId: 'run-live', name: 'audit' },
      })).toBe(true)

      const tail = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(tail).toHaveLength(AGENT_FLOW_MAX_EVENTS)
      // The newest row is the live append; the oldest surviving row is the
      // 12th seeded line (the first 11 left the display window).
      expect(parseLine(tail[tail.length - 1])!.runId).toBe('run-live')
      expect(parseLine(tail[0])!.runId).toBe('run-11')

      const chunks = listAgentFlowHistoryChunks(workflowDir)
      expect(chunks).toEqual(['chunk-000001.jsonl'])
      const archived = readFileSync(join(workflowDir, AGENT_FLOW_HISTORY_DIR, chunks[0]!), 'utf8')
      // BYTE-EXACT, in original order — the accepted history is preserved.
      expect(archived).toBe(`${seeded.slice(0, 11).join('\n')}\n`)
      // Every accepted identity is still durable after the eviction.
      expect(indexRows(workflowDir).map((row) => row.id)).toContain(parseLine(seeded[0]!)!.eventId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an UNINDEXED accepted row (the crash window) stays in the display tail while indexed rows are archived', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-history-pending-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const T0 = 1_700_000_000_000
      const pad = 'y'.repeat(180)
      // The covered row and every filler row are durably indexed; the pending
      // row is NOT (appended, its identity commit still missing — the crash
      // window). All three sit in the evictable prefix.
      const covered = sourcedLine(T0, 'run-covered', 'sess-pending', 'sess-pending', 0, pad)
      const pending = sourcedLine(T0 + 1, 'run-pending', 'sess-pending', 'sess-pending', 1, pad)
      const filler = Array.from({ length: AGENT_FLOW_MAX_EVENTS }, (_, i) => sourcedLine(T0 + 2 + i, `run-fill-${i}`, 'sess-fill', 'sess-fill', i, pad))
      await writeFile(file, `${[covered, pending, ...filler].join('\n')}\n`)
      await seedIdentityIndex(workflowDir, [covered, ...filler])

      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-live'),
        event: { v: 1, ts: T0 + 9000, kind: 'workflow-run', runId: 'run-live', name: 'audit' },
      })).toBe(true)

      const tail = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      const runIds = tail.map((line) => parseLine(line)!.runId)
      // The unindexed row is STILL in the live tail (its dedup window) and the
      // indexed row left it — archived into history.
      expect(runIds).toContain('run-pending')
      expect(runIds).not.toContain('run-covered')
      expect(runIds[runIds.length - 1]).toBe('run-live')
      const archived = listAgentFlowHistoryChunks(workflowDir)
        .map((name) => readFileSync(join(workflowDir, AGENT_FLOW_HISTORY_DIR, name), 'utf8'))
        .join('')
      expect(archived).toContain('run-covered')
      expect(archived).not.toContain('run-pending')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('archive-plus-tail compaction is crash-idempotent — a retried batch is never archived twice', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-history-idempotent-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const T0 = 1_700_000_000_000
      const pad = 'z'.repeat(180)
      const seeded = Array.from({ length: AGENT_FLOW_MAX_EVENTS + 10 }, (_, i) => sourcedLine(T0 + i, `run-${i}`, 'sess-crash', 'sess-crash', i, pad))
      await writeFile(file, `${seeded.join('\n')}\n`)
      await seedIdentityIndex(workflowDir, seeded)
      // The exact state a crash between the chunk `fsync` and the tail rename
      // leaves behind: the batch is ALREADY archived and still in the tail.
      const dir = join(workflowDir, AGENT_FLOW_HISTORY_DIR)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'chunk-000001.jsonl'), `${seeded.slice(0, 11).join('\n')}\n`)

      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-live'),
        event: { v: 1, ts: T0 + 1000, kind: 'workflow-run', runId: 'run-live', name: 'audit' },
      })).toBe(true)

      // The retry archived nothing new and the tail compacted normally: one
      // accepted occurrence, one archive copy.
      const chunks = listAgentFlowHistoryChunks(workflowDir)
      expect(chunks).toEqual(['chunk-000001.jsonl'])
      const archived = readFileSync(join(dir, chunks[0]!), 'utf8')
      expect(archived).toBe(`${seeded.slice(0, 11).join('\n')}\n`)
      const tail = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(tail).toHaveLength(AGENT_FLOW_MAX_EVENTS)
      expect(tail.some((line) => line.includes('"runId":"run-0"'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an archived accepted row is still deduplicated after the scan bound is lost — no duplicate append', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-history-dedup-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const T0 = 1_700_000_000_000
      const pad = 'w'.repeat(180)
      const seeded = Array.from({ length: AGENT_FLOW_MAX_EVENTS + 10 }, (_, i) => sourcedLine(T0 + i, `run-${i}`, 'sess-dedup', 'sess-dedup', i, pad))
      await writeFile(file, `${seeded.join('\n')}\n`)
      await seedIdentityIndex(workflowDir, seeded)
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-live'),
        event: { v: 1, ts: T0 + 1000, kind: 'workflow-run', runId: 'run-live', name: 'audit' },
      })).toBe(true)
      // The archived row left the display tail…
      expect(readFileSync(file, 'utf8')).not.toContain('"runId":"run-0"')
      // …and the scan bound is gone (evicted / lost sidecar).
      await writeFile(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), JSON.stringify({ v: 2, cursors: {} }))
      const before = readFileSync(file, 'utf8').trim().split('\n').length

      // Replaying the ARCHIVED event must be recognized as already accepted:
      // no second copy, and the accepted identity is unchanged.
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-dedup', 'sess-dedup'),
        event: { v: 1, ts: T0, kind: 'workflow-run', runId: 'run-0', name: pad },
      })).toBe(true)
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(before)
      expect(indexRows(workflowDir).filter((row) => row.id === 'wfe1:workflow-run:sess-dedup:sess-dedup:0')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an already-recorded event id with DIFFERENT bytes is refused — no append, no bound advance', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-refuse-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      const event = { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' } as const
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a'), event })).toBe(true)
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)

      // Same source position, DIFFERENT payload — a reused log identity.
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a'),
        event: { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-other', name: 'audit' },
      })).toBe(false)
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)
      expect(captured.some((m) => m.includes('already recorded with different bytes'))).toBe(true)
      // The durable bound still names the next position after the accepted row.
      expect(cursorEntry(workflowDir, 'sess-a')).toEqual({ next: 1, stream: 'sess-a' })
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a torn record that could be this event id is refused — an unknown outcome is never accepted success', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-torn-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      // A partial write of the very row we are about to record (crash mid-append).
      const eventId = 'wfe1:workflow-run:sess-a:sess-a:0'
      await writeFile(file, `{"v":1,"ts":1700000000000,"kind":"workflow-run","runId":"run-1","name":"audit","eventId":"${eventId}"`)
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a'),
        event: { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })).toBe(false)
      expect(captured.some((m) => m.includes('torn ledger record'))).toBe(true)
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
      expect(existsSync(join(workflowDir, AGENT_FLOW_INDEX_FILE))).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(`{"v":1,"ts":1700000000000,"kind":"workflow-run","runId":"run-1","name":"audit","eventId":"${eventId}"`)
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('separate log incarnations keep separate identities: the same seq on two streams is two rows', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-stream-')
    try {
      const ts = 1_700_000_000_000
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a', 'stream-1'),
        event: { v: 1, ts, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })).toBe(true)
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a', 'stream-2'),
        event: { v: 1, ts, kind: 'workflow-run', runId: 'run-2', name: 'audit' },
      })).toBe(true)
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines.map((line) => parseLine(line)!.eventId)).toEqual([
        'wfe1:workflow-run:sess-a:stream-1:0',
        'wfe1:workflow-run:sess-a:stream-2:0',
      ])
      // The bound follows the LAST accepted incarnation.
      expect(cursorEntry(workflowDir, 'sess-a')).toEqual({ next: 1, stream: 'stream-2' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a separate SESSION at the same position is a distinct record (the id carries the session too)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-session-')
    try {
      const ts = 1_700_000_000_000
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a', 'log-1'), event: { v: 1, ts, kind: 'workflow-run', runId: 'run-a', name: 'audit' } })).toBe(true)
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-b', 'log-1'), event: { v: 1, ts, kind: 'workflow-run', runId: 'run-b', name: 'audit' } })).toBe(true)
      const ids = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n').map((line) => parseLine(line)!.eventId)
      expect(ids).toEqual([
        'wfe1:workflow-run:sess-a:log-1:0',
        'wfe1:workflow-run:sess-b:log-1:0',
      ])
      expect(cursorEntry(workflowDir, 'sess-a')!.next).toBe(1)
      expect(cursorEntry(workflowDir, 'sess-b')!.next).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agent-flow — durable authority read/write failures are refusals (F2)', () => {
  it('a PRESENT-but-unreadable cursor refuses the record: no row, no index, no success observation', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-cursor-unreadable-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      await writeFile(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE), JSON.stringify({ v: 9, cursors: 'nope' }))
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a'),
        event: { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })).toBe(false)
      expect(captured.some((m) => m.includes('durable cursor is unreadable'))).toBe(true)
      expect(existsSync(join(workflowDir, AGENT_FLOW_FILE))).toBe(false)
      expect(existsSync(join(workflowDir, AGENT_FLOW_INDEX_FILE))).toBe(false)
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an unreadable identity index refuses the record — the dedup authority is never assumed empty', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-index-unreadable-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      await mkdir(join(workflowDir, AGENT_FLOW_INDEX_FILE), { recursive: true })
      expect(recordWorkflowEvent({
        harnessDir,
        workflowDir,
        source: src(0, 'sess-a'),
        event: { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' },
      })).toBe(false)
      expect(captured.some((m) => m.includes('accepted-identity index is unreadable'))).toBe(true)
      expect(existsSync(join(workflowDir, AGENT_FLOW_FILE))).toBe(false)
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a failed identity-index commit refuses the record even though the row reached the ledger — the retry heals it', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-index-write-fail-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    const event = { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' } as const
    try {
      // A DIRECTORY at the index slot makes the append fail while the ledger
      // slot stays writable.
      await mkdir(join(workflowDir, AGENT_FLOW_INDEX_FILE), { recursive: true })
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a'), event })).toBe(false)
      expect(captured.some((m) => m.includes('accepted-identity index write failed'))).toBe(true)
      // The row IS in the ledger (the append cannot be taken back)…
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)

      // …and the retry recognizes it by identity and indexes it: ONE row.
      await rm(join(workflowDir, AGENT_FLOW_INDEX_FILE), { recursive: true, force: true })
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a'), event })).toBe(true)
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)
      expect(indexRows(workflowDir)).toHaveLength(1)
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a failed cursor write refuses the record (row + identity durable) and the retry does not duplicate it', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-cursor-write-fail-')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((level, message) => { if (level === 'warn') captured.push(message) })
    const event = { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' } as const
    try {
      // A DIRECTORY at the atomic-write temp slot makes the cursor rename fail
      // while the read still sees "no cursor yet".
      const tmp = join(workflowDir, `${WORKFLOW_LEDGER_WATERMARK_FILE}.tmp`)
      await mkdir(tmp, { recursive: true })
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a'), event })).toBe(false)
      expect(captured.some((m) => m.includes('cursor write failed'))).toBe(true)
      // The row and its identity ARE durable — only the scan bound did not commit.
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)
      expect(indexRows(workflowDir)).toHaveLength(1)

      await rm(tmp, { recursive: true, force: true })
      expect(recordWorkflowEvent({ harnessDir, workflowDir, source: src(0, 'sess-a'), event })).toBe(true)
      expect(readAgentFlow(workflowDir)!.events).toHaveLength(1)
      expect(cursorEntry(workflowDir, 'sess-a')!.next).toBe(1)
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('workflow-ledger — verified log incarnation (F2 identity)', () => {
  /** A session whose log head is unreadable (a trimmed/malformed stored log). */
  function headlessSession(id: string, cwd: string, event: unknown): unknown {
    const log: unknown[] = [undefined, event]
    return {
      header: { id, cwd },
      log,
      get seq(): number { return log.length },
      eventAt(seq: number): unknown { return log[seq] },
    }
  }

  it('a session without a readable log head records nothing — no fabricated incarnation', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-no-incarnation-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const captured: string[] = []
    const priorSink = setWorkflowLedgerLogger((level, message) => { if (level === 'warn') captured.push(message) })
    try {
      sessions.register(headlessSession('sess-nohead', root, { type: 'tool-workflow/run-start', seq: 1, time: SESSION_T0 + 1, data: runStart({ runId: 'run-x' }) }))
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      expect(captured.some((m) => m.includes('identity unavailable'))).toBe(true)
      expect(existsSync(join(workflowDir, AGENT_FLOW_FILE))).toBe(false)
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a rebuilt log is NOT skipped by a stale bound: the walk restarts at the floor and the bound follows the new incarnation', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-rebuild-skip-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    // A bound from a DIFFERENT incarnation sits ahead of the current log end.
    await writeFile(
      join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE),
      JSON.stringify({ v: 2, cursors: { 'sess-rb': { next: 9, stream: 's1-00000000000000000000000000000000' } } }),
    )
    sessions.register(fakeSession([
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-1' }) },
      { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-2' }) },
    ], { id: 'sess-rb', header: { cwd: root } }))
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.runId).sort()).toEqual(['run-1', 'run-2'])
      const entry = cursorEntry(workflowDir, 'sess-rb')!
      expect(entry.next).toBe(2)
      expect(entry.stream).toMatch(STREAM_SHAPE)
      expect(entry.stream).not.toBe('s1-00000000000000000000000000000000')
      // Both rows carry the SAME verified incarnation the bound was stamped with.
      const streamIds = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const source: unknown = parseLine(line)?.source
          if (typeof source === 'object' && source !== null && 'streamId' in source && typeof source.streamId === 'string') return source.streamId
          return ''
        })
      expect(streamIds).toEqual([entry.stream, entry.stream])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the same session id with a DIFFERENT log is a new incarnation: recorded, never falsely refused', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-incarnation-distinct-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const priorSink = setWorkflowLedgerLogger(() => {})
    try {
      sessions.register(fakeSession([
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-old' }) },
      ], { id: 'sess-same', header: { cwd: root } }))
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))
      // ID reuse: the same session id now holds a DIFFERENT log (new head).
      sessions.register(fakeSession([
        { type: 'tool-workflow/run-start', data: runStart({ runId: 'run-new' }) },
      ], { id: 'sess-same', header: { cwd: root } }))
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir))

      const rows = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n').map((line) => parseLine(line)!)
      expect(rows.map((row) => row.runId)).toEqual(['run-old', 'run-new'])
      const streamIds = rows.map((row) => {
        const source: unknown = row.source
        if (typeof source === 'object' && source !== null && 'streamId' in source && typeof source.streamId === 'string') return source.streamId
        return ''
      })
      // Distinct incarnations → distinct identities, and the bound follows the
      // CURRENT log instead of being pinned to the previous one.
      expect(streamIds[0]).not.toBe(streamIds[1])
      expect(cursorEntry(workflowDir, 'sess-same')!.stream).toBe(streamIds[1])
    } finally {
      setWorkflowLedgerLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('workflow-ledger — explicit awaited target (F2 resolver route)', () => {
  /** Drain the consumer's queued stream tasks (the resolver route is asynchronous). */
  const idle = async (): Promise<void> => {
    await awaitWorkflowLedgerIdle()
  }

  it('awaits the supplied resolver per boundary and records ONLY into the returned target', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-target-explicit-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([], { id: 'sess-a', header: { cwd: root } })
    sessions.register(parent)
    const seen: Array<{ sessionId: string; cwd: string }> = []
    const targets: WorkflowLedgerTarget[] = [
      { workflowId: 'wf-1', workflowDir: workflowDir, sessionId: 'sess-a', source: 'execution', epoch: 3 },
    ]
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, async (sessionId, cwd) => {
        seen.push({ sessionId, cwd })
        return targets.shift() ?? null
      })
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-targeted' }))
      await idle()

      expect(seen).toEqual([{ sessionId: 'sess-a', cwd: root }])
      expect(readAgentFlow(workflowDir)!.events.map((e) => e.runId)).toEqual(['run-targeted'])
      expect(cursorEntry(workflowDir, 'sess-a')!.next).toBe(1)
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a null or inconsistent target records NOTHING and never falls back to the file-based active set', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-target-refuse-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([], { id: 'sess-a', header: { cwd: root } })
    sessions.register(parent)
    let call = 0
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, async () => {
        call += 1
        // Call 1: no active writer. Call 2: a target naming ANOTHER session.
        if (call === 1) return null
        return { workflowId: 'wf-1', workflowDir, sessionId: 'sess-other', source: 'execution', epoch: 1 }
      })
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-none' }))
      await idle()
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-foreign' }))
      await idle()

      // The harness HAS an active workflow (wf-1) — a file-based fallback
      // would have written both rows. The explicit route wrote neither.
      expect(readAgentFlow(workflowDir)!.events).toEqual([])
      expect(existsSync(join(workflowDir, WORKFLOW_LEDGER_WATERMARK_FILE))).toBe(false)
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes per source stream: a delayed lookup for the first row cannot let the second row overtake it', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-target-order-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const parent = fakeSession([], { id: 'sess-a', header: { cwd: root } })
    sessions.register(parent)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, async () => {
        call += 1
        // The FIRST lookup is delayed past the second row's arrival.
        if (call === 1) await gate
        return { workflowId: 'wf-1', workflowDir, sessionId: 'sess-a', source: 'legacy', epoch: null }
      })
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-first' }))
      sessions.append(parent, 'tool-workflow/run-start', runStart({ runId: 'run-second' }))
      release?.()
      await idle()

      // Ledger order is ARRIVAL order — the delayed first lookup did not let
      // the second row advance the stream's cursor first.
      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.runId)).toEqual(['run-second', 'run-first'])
      expect(cursorEntry(workflowDir, 'sess-a')!.next).toBe(2)
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a delayed lookup for one session never advances ANOTHER session cursor', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-ledger-target-cross-')
    const ctx = new Context()
    const sessions = new FakeSessionRegistry(ctx)
    const a = fakeSession([], { id: 'sess-a', header: { cwd: root } })
    const b = fakeSession([], { id: 'sess-b', header: { cwd: root } })
    sessions.register(a)
    sessions.register(b)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      registerWorkflowLedger(ctx, new HarnessResolver(harnessDir), undefined, async (sessionId) => {
        if (sessionId === 'sess-a') await gate
        return { workflowId: 'wf-1', workflowDir, sessionId, source: 'execution', epoch: 7 }
      })
      sessions.append(a, 'tool-workflow/run-start', runStart({ runId: 'run-a' }))
      sessions.append(b, 'tool-workflow/run-start', runStart({ runId: 'run-b' }))
      release?.()
      await idle()

      // Each row advanced only its OWN session's bound.
      const entryA = cursorEntry(workflowDir, 'sess-a')!
      const entryB = cursorEntry(workflowDir, 'sess-b')!
      expect(entryA.next).toBe(1)
      expect(entryB.next).toBe(1)
      expect(entryA.stream).not.toBe(entryB.stream)
      expect(readAgentFlow(workflowDir)!.events.map((e) => e.runId).sort()).toEqual(['run-a', 'run-b'])
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
