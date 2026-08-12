/**
 * Task 1 — server-side dispatch ledger + catalog `state.agentFlow` evidence
 * (plan `20260810-agent-flow-catalog-graph`, spec §2.1 / §2.2) — extended by
 * plan `20260811-panel-f4-timeliness` Task 1: REAL settle pairing (real
 * completion signals instead of host-emission best-effort).
 *
 * Coverage (AC-3 / AC-5 anchors + the T1 pairing chain):
 * - ledger unit: recordDispatch / recordSettle / readAgentFlow — verdict
 *   derivation (ok / advisory / denied incl. hard deny), header/body identity
 *   derivation (role / planId / taskId / taskCategory), latest-first bound
 *   (limit 50), truncation (AGENT_FLOW_MAX_EVENTS 500), malformed-line
 *   tolerance, missing-file degrade → null, summary (role × outcome, count
 *   desc), and the never-throw advisory contract;
 * - dispatch smoke: REAL-composition boot + `ctx.waterfall('tools/pre-execute', …)`
 *   lands one event per Assignment-shaped dispatch (clean / advisory / hard
 *   deny), the host-hook path (`beforeDispatch`, exec-less) records too, and
 *   non-Assignment / non-subagent-tool / no-harness-dir calls stay silent;
 * - settle pairing (plan `20260811-panel-f4-timeliness` T1): the
 *   `tools/post-execute` listener — dispatch-tool matching, the VERIFIED
 *   three-shape branch (background → taskId store / continuable → honest
 *   no-settle / foreground+other → settle ok, isError → error), unpaired →
 *   no settle + one warn, non-dispatch tool → no record, and the settle
 *   carries the PAIRED dispatch identity (role/planId/taskId — schema +
 *   view `paired` marker + JSONL round-trip); `recordTaskSettle` maps the
 *   three onTaskDone terminal statuses (completed→ok / killed→denied /
 *   failed→error) + durationMs and stays silent for unpaired task ids;
 *   the catalog-invalidation hook fires after successful records (Task 2
 *   seam); the upstream seam probes prove the REAL registry emits
 *   `tools/post-execute` and the `ctx.inject(['tasks'])` onTaskDone wiring
 *   registers + receives terminals (Step 1 — 先证后写);
 * - catalog integration: `state.agentFlow` surfaces the ledger (events ≤ 50 +
 *   summary), the model text gains ONE compact line only when events > 0, and
 *   the view carries no undefined-valued keys (Session.append lossless JSON).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { TaskId } from '@deepseek-ai/dsh-tasks'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  AGENT_FLOW_FILE,
  AGENT_FLOW_MAX_EVENTS,
  SETTLE_SEAM,
  readAgentFlow,
  recordDispatch,
  recordSettle,
} from '../src/index.ts'
import {
  AGENT_FLOW_SIZE_GATE_BYTES,
  registerSettleListener,
  recordTaskSettle,
  setAgentFlowInvalidator,
  setAgentFlowLogger,
  SETTLE_SEAM_PAIRING_NOTE,
  taskIdOf,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowPairing } from '../src/gates/agent-flow.ts'
import type { AgentFlowView, MstarEngineStatusSource } from '../src/index.ts'
import { bootApp, seedHarness, FakeTaskService, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** A fully valid writable Assignment WITH plan + task identity (ledger derivation target). */
const VALID_PLANNED = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/agent-flow
**Plan Path**: /proj/plans/20260810-agent-flow.md

## Task 2

Implement the ledger, evidence-first.
`

/** Writable assignment with NO branch form → one advisory violation (verdict advisory). */
const MISSING_BRANCH = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic

Do the thing.
`

/** Missing `Execute as` — a hard-mode deny sample (verdict denied must also land). */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** Not an Assignment at all — must stay silent (no record). */
const GARBAGE_PROMPT = `This is not an assignment at all.

Just do some work.
`

/** A ledger event line (v1 dispatch, seeded directly into agent-flow.jsonl). */
const dispatchLine = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  ts: 1_700_000_000_000,
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

/** A ledger event line (v1 settle). */
const settleLine = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  ts: 1_700_000_001_000,
  kind: 'settle',
  agent: 'a1',
  outcome: 'ok',
  durationMs: 1500,
  ...overrides,
})

/* ---------------------------------- helpers ---------------------------------- */

/** One pending subagent tool call in the registry pipeline shape. */
let seq = 0
function subagentExec(prompt: string): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description: 'probe', prompt },
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/** Emit an event NOT declared on the typed Events surface (runtime-valid). */
function emitUndeclared(ctx: Context, name: string, ...args: unknown[]): void {
  ;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(name, ...args)
}

/** Read the ledger view for a booted app (or fail loudly when absent). */
function flowOf(app: BootResult): AgentFlowView {
  const view = readAgentFlow(app.harnessDir)
  expect(view).not.toBeNull()
  return view!
}

/** Create a temp harness dir (bare-context tests — no Loader boot). */
async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  return { root, harnessDir }
}

/* ===========================================================================
 * 1. Ledger unit — record / read / truncate / summary / degrade
 * ========================================================================== */

describe('agent-flow ledger — recordDispatch / readAgentFlow', () => {
  it('records a v1 dispatch event; readAgentFlow returns the catalog view (verdict ok)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-record-')
    try {
      recordDispatch({ harnessDir, exec: { agent: { id: 'sess-1' } }, prompt: VALID_PLANNED, violations: [], hard: false })

      const view = readAgentFlow(harnessDir)
      expect(view).not.toBeNull()
      expect(view!.events).toHaveLength(1)
      expect(view!.events[0]).toMatchObject({
        kind: 'dispatch',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '20260810-agent-flow',
        taskId: 'T2',
        taskCategory: 'logic',
        verdict: 'ok',
        hard: false,
      })
      // The serialized line is the v1 schema (optional fields omitted — no undefined keys).
      const line = readFileSync(join(harnessDir, AGENT_FLOW_FILE), 'utf8').trim()
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed).toMatchObject({ v: 1, kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })
      expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true)
      // Regression (qc2 F-7): the serialized line must NEVER carry prompt
      // body text — the record persists only derived fields.
      expect(line).not.toContain('Implement the ledger')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('verdict derivation: no violations → ok; hard + violations → denied; else advisory', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-verdict-')
    try {
      const violation = { ok: false, severity: 'high', code: 'assignment.field.branch-missing', message: 'x' }
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_BRANCH, violations: [violation], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_EXECUTE_AS, violations: [violation], hard: true })

      const view = readAgentFlow(harnessDir)
      expect(view!.events.map((e) => e.verdict)).toEqual(['denied', 'advisory', 'ok']) // latest first
      expect(view!.events.map((e) => e.hard)).toEqual([true, false, false])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('agent is omitted when the exec carries none (host-hook shape) and when role is missing', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-agent-')
    try {
      recordDispatch({ harnessDir, exec: undefined, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, exec: { agent: { id: '' } }, prompt: VALID_PLANNED, violations: [], hard: false })

      const view = readAgentFlow(harnessDir)
      expect(view!.events.every((e) => e.agent === null)).toBe(true)
      // The JSONL lines carry NO agent key (omit discipline at the record).
      const lines = readFileSync(join(harnessDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      for (const line of lines) {
        expect((JSON.parse(line) as Record<string, unknown>).agent).toBeUndefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('planId derives from Plan Path basename; body-quoted Plan Path never resolves (header-region scoping)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-planid-')
    try {
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      const view = readAgentFlow(harnessDir)
      expect(view!.events[0]!.planId).toBe('20260810-agent-flow')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recordSettle writes outcome + durationMs (omitted when absent)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-')
    try {
      recordSettle({ harnessDir, agent: 'sess-1', outcome: 'ok', durationMs: 1234 })
      recordSettle({ harnessDir, outcome: 'error' })

      const view = readAgentFlow(harnessDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['settle', 'settle'])
      expect(view!.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: null })
      expect(view!.events[1]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-1', durationMs: 1234 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('readAgentFlow is latest-first and bounded by the limit (default 50); limit 0 → the empty window (qc2 F-6)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-limit-')
    try {
      for (let i = 0; i < 60; i += 1) {
        recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      }
      const defaultView = readAgentFlow(harnessDir)
      expect(defaultView!.events).toHaveLength(50)
      expect(defaultView!.events[0]!.ts).toBeGreaterThanOrEqual(defaultView!.events[49]!.ts)
      const small = readAgentFlow(harnessDir, 10)
      expect(small!.events).toHaveLength(10)
      // Explicit semantics: 0 requests the EMPTY window (not a silent
      // fallback to the default).
      expect(readAgentFlow(harnessDir, 0)).toEqual({ events: [], summary: [] })
      // Negative/NaN-like values floor to 0 → the empty window too.
      expect(readAgentFlow(harnessDir, -3)).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('truncates the file to the most recent AGENT_FLOW_MAX_EVENTS lines after many appends', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-truncate-')
    try {
      const total = AGENT_FLOW_MAX_EVENTS + 25
      for (let i = 0; i < total; i += 1) {
        recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      }
      const file = join(harnessDir, AGENT_FLOW_FILE)
      const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(AGENT_FLOW_MAX_EVENTS)
      // The view reflects the truncated tail (the first recorded event is gone).
      const view = readAgentFlow(harnessDir, 500)
      expect(view!.events).toHaveLength(AGENT_FLOW_MAX_EVENTS)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('size gate (qc2 F-1 / qc3 F-001/003): a tiny-line ledger below the threshold keeps >500 lines (append-only fast path); the truncating read-modify-write still runs once the file crosses the gate', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-sizegate-')
    try {
      const file = join(harnessDir, AGENT_FLOW_FILE)
      // ~60 B settle lines: 600 of them ≈ 36 KiB stay BELOW the 64 KiB gate,
      // so the append path must NOT read-modify-write — all 600 lines persist
      // even though they exceed AGENT_FLOW_MAX_EVENTS (the documented
      // approximate bound under the size gate).
      for (let i = 0; i < 600; i += 1) recordSettle({ harnessDir, outcome: 'error' })
      expect(statSync(file).size).toBeLessThan(AGENT_FLOW_SIZE_GATE_BYTES)
      let lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(600)
      expect(readAgentFlow(harnessDir, 700)!.events).toHaveLength(600)
      // Now push the file past the gate with normal-size dispatch lines
      // (~163 B × 525 ≈ 86 KiB > 64 KiB): the read-modify-write resumes and
      // truncates back to the most recent 500 events.
      for (let i = 0; i < 525; i += 1) {
        recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      }
      lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(AGENT_FLOW_MAX_EVENTS)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips malformed lines — never fatal; empty/malformed-only files yield an empty view', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-malformed-')
    try {
      const file = join(harnessDir, AGENT_FLOW_FILE)
      await writeFile(file, [
        'not json at all {{{',
        dispatchLine(),
        '{ broken json',
        settleLine({ outcome: 'error' }),
        '',
      ].join('\n') + '\n')

      const view = readAgentFlow(harnessDir)
      expect(view!.events).toHaveLength(2)
      expect(view!.events.map((e) => e.kind)).toEqual(['settle', 'dispatch']) // latest first

      await writeFile(file, 'garbage\nalso garbage\n')
      const empty = readAgentFlow(harnessDir)
      expect(empty).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('missing file → EMPTY view (the panel empty state); ONLY an unreadable ledger → null (qc1 F-001 fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-missing-')
    try {
      // Missing ledger = recording hasn't started (it begins at plan merge) —
      // the empty view, never an evidence-missing degrade.
      expect(readAgentFlow(harnessDir)).toEqual({ events: [], summary: [] })
      expect(readAgentFlow(join(root, 'does-not-exist'))).toEqual({ events: [], summary: [] })
      // Unreadable (a DIRECTORY at the ledger path — readFileSync throws
      // EISDIR while existsSync reports presence) → null: only genuine
      // unreadability degrades.
      await mkdir(join(harnessDir, AGENT_FLOW_FILE))
      expect(readAgentFlow(harnessDir)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('summary: role × outcome counts over the same window, count desc', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-summary-')
    try {
      const violation = { ok: false, severity: 'high', code: 'x', message: 'x' }
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_BRANCH, violations: [violation], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_EXECUTE_AS, violations: [violation], hard: true })
      recordSettle({ harnessDir, outcome: 'ok' })

      const view = readAgentFlow(harnessDir)
      expect(view!.summary).toEqual([
        { role: 'fullstack-dev', outcome: 'ok', count: 2 },
        { role: '', outcome: 'denied', count: 1 },
        { role: '', outcome: 'ok', count: 1 },
        { role: 'fullstack-dev', outcome: 'advisory', count: 1 },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recordDispatch / recordSettle never throw — a failing record logs and is contained (advisory)', async () => {
    const { root } = await tempHarness('dsh-agentflow-nothrow-')
    const blocked = join(root, 'blocked') // a regular FILE — appending under it must fail
    await writeFile(blocked, 'i am a file, not a directory')
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      expect(() => recordDispatch({ harnessDir: blocked, prompt: VALID_PLANNED, violations: [], hard: false })).not.toThrow()
      expect(() => recordSettle({ harnessDir: blocked, outcome: 'ok' })).not.toThrow()
      expect(captured.length).toBe(2)
      expect(captured[0]).toContain('dispatch record failed')
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 2. taskIdOf — best-effort body Task N extraction
 * ========================================================================== */

describe('taskIdOf — body `Task N` best-effort extraction (level-2 headings only, qc2 F-8)', () => {
  it('extracts the first LEVEL-2 numbered Task heading from the BODY, normalized to T<n>', () => {
    expect(taskIdOf(VALID_PLANNED)).toBe('T2')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n## Task 7\n\nwork`)).toBe('T7')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\nDo the thing.`)).toBeUndefined()
  })

  it('a non-level-2 task heading in the body does NOT resolve (qc2 F-8: narrower false-hit surface)', () => {
    // Level-1, level-3+ headings (or an indented example) are not the
    // assignment's task heading — only `^## Task N` matches.
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n### Task 7\n\nwork`)).toBeUndefined()
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n# Task 7\n\nwork`)).toBeUndefined()
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n  ## Task 7\n\nwork`)).toBeUndefined()
  })

  it('a `## Task N` quoted in the HEADER region never resolves (header-region scoping)', () => {
    // The header region ends at the FIRST `# Task`-style heading; a body-quoted
    // example AFTER the boundary is a legitimate task heading, but a line that
    // would only ever be part of the header (before the boundary) cannot leak.
    const headerQuoted = `## Assignment

**Execute as**: fullstack-dev
**Example Task**: ## Task 2 quoted in header

Do the thing.
`
    expect(taskIdOf(headerQuoted)).toBeUndefined()
  })
})

/* ===========================================================================
 * 3. Dispatch smoke — REAL-composition boot + tools/pre-execute waterfall
 * ========================================================================== */

describe('agent-flow dispatch smoke — bootApp + tools/pre-execute', () => {
  it('a valid Assignment lands one dispatch event (verdict ok, plan/task derived)', async () => {
    const app = booted = await bootApp()

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({
      kind: 'dispatch',
      role: 'fullstack-dev',
      planId: '20260810-agent-flow',
      taskId: 'T2',
      taskCategory: 'logic',
      verdict: 'ok',
      hard: false,
    })
  })

  it('a warn-mode advisory (missing branch form) lands a verdict-advisory event', async () => {
    const app = booted = await bootApp()

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'advisory', hard: false })
  })

  it('a hard deny lands a verdict-denied event (spec: hard deny samples record too)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision.kind).toBe('deny')
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'denied', hard: true })
  })

  it('the host-hook path (beforeDispatch, exec-less) records too — agent omitted', async () => {
    const app = booted = await bootApp()

    const result = await app.ctx.dshHostAdapter.beforeDispatch(VALID_PLANNED)

    expect(result.ok).toBe(true)
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', agent: null })
  })

  it('non-Assignment prompts and non-subagent tools record nothing', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    await app.ctx.waterfall('tools/pre-execute', subagentExec(GARBAGE_PROMPT), defaultAllow)
    await app.ctx.waterfall(
      'tools/pre-execute',
      { ...subagentExec(MISSING_EXECUTE_AS), name: 'read_file', arguments: { path: '/tmp/note.md' } },
      defaultAllow,
    )

    // No ledger file was ever created — the missing file now reads as the
    // EMPTY view (qc1 F-001), still proving "nothing recorded".
    expect(readAgentFlow(app.harnessDir)).toEqual({ events: [], summary: [] })
  })

  it('the host-hook path stays silent for non-Assignment text (qc2 F-2: shape guard at the shared core)', async () => {
    const app = booted = await bootApp()

    const result = await app.ctx.dshHostAdapter.beforeDispatch(GARBAGE_PROMPT)

    // The gate still validates (ok, no violations for non-assignment text),
    // but no phantom dispatch event lands — same semantics as the listener
    // path (spec §2.1.1 "非 Assignment 不记录" now holds for BOTH surfaces).
    expect(result.ok).toBe(true)
    expect(readAgentFlow(app.harnessDir)).toEqual({ events: [], summary: [] })
  })

  it('no harness dir → no record, gate unchanged (degrade is silent)', async () => {
    const app = booted = await bootApp({ harnessDir: null })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    // No harness dir → no ledger location; nothing crashed (advisory degrade).
  })
})

/* ===========================================================================
 * 4. Settle pairing — post-execute three-shape branch + onTaskDone terminal
 *    (plan `20260811-panel-f4-timeliness` Task 1) + verification-gate trace
 * ========================================================================== */

/** A fresh apply-scoped pairing store (empty maps). */
function pairingOf(): AgentFlowPairing {
  return { dispatchByCallId: new Map(), dispatchByTaskId: new Map() }
}

/** A dispatch-tool exec carrying the FULL pairing surface (callId + agent). */
function dispatchExec(callId: string, agent: string, prompt: string): ToolExecution {
  return {
    callId: callId as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description: 'probe', prompt },
    agent: { id: agent } as never,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** Record a dispatch with the pairing store (registers `callId → dispatchRef`). */
function pairedDispatch(harnessDir: string, pairing: AgentFlowPairing, callId: string, prompt: string, agent = 'sess-1'): void {
  recordDispatch({ harnessDir, exec: dispatchExec(callId, agent, prompt), prompt, violations: [], hard: false, pairing })
}

describe('agent-flow settle — real completion pairing (plan 20260811-panel-f4-timeliness T1)', () => {
  it('registration logs the pairing trace once (verification gate)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-trace-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, {}, pairingOf())

      expect(captured).toHaveLength(1)
      expect(captured[0]).toBe(SETTLE_SEAM_PAIRING_NOTE)
      expect(SETTLE_SEAM).toBe('tools/post-execute')
      expect(SETTLE_SEAM_PAIRING_NOTE).toContain(SETTLE_SEAM)
      expect(SETTLE_SEAM_PAIRING_NOTE).toContain('IS part of the verified dsh-tools registry surface')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recordDispatch with an exec registers the agent-namespaced call key → dispatchRef (qc1 F-101 fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-pairing-register-')
    try {
      const pairing = pairingOf()
      pairedDispatch(harnessDir, pairing, 'c-1', VALID_PLANNED, 'sess-1')
      // The key is `${sessionId}\u0000${callId}` — a raw callId alone would
      // collide across sessions in one process.
      const ref = pairing.dispatchByCallId.get('sess-1\u0000c-1')
      expect(ref).toMatchObject({
        harnessDir,
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '20260810-agent-flow',
        taskId: 'T2',
      })
      expect(pairing.dispatchByCallId.get('c-1')).toBeUndefined() // un-namespaced key never exists
      // An exec-less record (host-hook path) never pairs.
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false, pairing })
      expect(pairing.dispatchByCallId.size).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a foreground dispatch result settles immediately with the PAIRED identity (schema + view + JSONL)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-foreground-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-fg', VALID_PLANNED)

      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'c-fg', name: 'subagent', agent: { id: 'sess-1' } },
        { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } },
      )

      const view = readAgentFlow(harnessDir)!
      expect(view.events).toHaveLength(2) // dispatch + settle
      expect(view.events[0]).toMatchObject({
        kind: 'settle',
        outcome: 'ok',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '20260810-agent-flow',
        taskId: 'T2',
      })
      // The view carries the paired-identity presence marker.
      expect(view.events[0].paired).toBe(true)
      // The serialized JSONL line carries the identity fields (no undefined keys).
      const line = readFileSync(join(harnessDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n').at(-1)!
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed).toMatchObject({ kind: 'settle', outcome: 'ok', role: 'fullstack-dev', planId: '20260810-agent-flow', taskId: 'T2' })
      expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true)
      // A plain-string foreground value settles too (foreground/other success).
      pairing.dispatchByCallId.clear()
      pairedDispatch(harnessDir, pairing, 'c-fg2', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-fg2', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: 'plain result' })
      const after = readAgentFlow(harnessDir)!
      expect(after.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-2', role: 'fullstack-dev' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a FAILED dispatch result settles error with the paired identity', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-error-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-err', VALID_PLANNED)
      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'c-err', name: 'subagent', agent: { id: 'sess-1' } },
        { isError: true, error: { message: 'boom' } },
      )
      const view = readAgentFlow(harnessDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: 'sess-1', role: 'fullstack-dev' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('two agents sharing the same callId never cross-pair — each settle lands on its own dispatch (qc1 F-101 fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-pairing-namespace-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // The SAME callId 'c-shared' from two different sessions — a realistic
      // cross-session interleave (upstream callIds are per-message).
      pairedDispatch(harnessDir, pairing, 'c-shared', VALID_PLANNED, 'sess-A')
      pairedDispatch(harnessDir, pairing, 'c-shared', VALID_PLANNED, 'sess-B')
      expect(pairing.dispatchByCallId.size).toBe(2) // distinct namespaced keys

      // Session A's completion pairs to A's dispatch only.
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-shared', name: 'subagent', agent: { id: 'sess-A' } }, { isError: false, value: { kind: 'foreground', runId: 'rA', output: [] } })
      let view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', agent: 'sess-A', role: 'fullstack-dev', planId: '20260810-agent-flow', taskId: 'T2' })

      // Session B's completion pairs to B's dispatch — the settle identities
      // never crossed (no mis-pair into the other session's dispatchRef).
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-shared', name: 'subagent', agent: { id: 'sess-B' } }, { isError: false, value: { kind: 'foreground', runId: 'rB', output: [] } })
      view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'settle', 'dispatch', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', agent: 'sess-B', role: 'fullstack-dev' })
      expect(view.events[1]).toMatchObject({ kind: 'settle', agent: 'sess-A', role: 'fullstack-dev' })
      // Both calls were consumed (map pruning) — nothing stays paired.
      expect(pairing.dispatchByCallId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a result carrying `error` WITHOUT `isError: true` settles error — never a fabricated ok (qc2 F-001 / qc3 F-003a fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-error-key-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-err2', VALID_PLANNED, 'sess-1')
      // Failed envelope WITHOUT the canonical `isError` flag: `error` present.
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-err2', name: 'subagent', agent: { id: 'sess-1' } }, { error: { message: 'boom without the flag' } })
      let view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: 'sess-1', role: 'fullstack-dev' })
      // `error` + `value` (both present, no isError) is still a failure.
      pairedDispatch(harnessDir, pairing, 'c-err3', VALID_PLANNED, 'sess-1')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-err3', name: 'subagent', agent: { id: 'sess-1' } }, { error: { message: 'x' }, value: 'partial' })
      view = readAgentFlow(harnessDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a background result WITHOUT a valid taskId records nothing — never a fabricated ok (qc3 F-003b fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-background-notask-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-bg0', VALID_PLANNED)
      // `kind: 'background'` with a MISSING taskId → nothing mappable.
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-bg0', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'background' } })
      let view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch']) // no settle
      expect(pairing.dispatchByTaskId.size).toBe(0)
      // `kind: 'background'` with an EMPTY taskId → nothing mappable too.
      pairedDispatch(harnessDir, pairing, 'c-bg0b', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-bg0b', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: { kind: 'background', taskId: '' } })
      view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch', 'dispatch']) // still no settle
      expect(pairing.dispatchByTaskId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the dispatchByCallId entry is pruned once the post-execute branch resolves the call (qc1 F-102 / qc2 F-002 / qc3 F-002 fix-wave)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-prune-callid-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // A foreground settle consumes the call entry — the map holds only
      // in-flight calls.
      pairedDispatch(harnessDir, pairing, 'c-prune', VALID_PLANNED)
      expect(pairing.dispatchByCallId.size).toBe(1)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-prune', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } })
      expect(pairing.dispatchByCallId.size).toBe(0)
      // A SECOND post-execute for the same call is not a real event — it
      // finds no pairing (honest no-settle; the warn fires at most once).
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-prune', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } })
      const view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a background result stores taskId → dispatchRef and records NO settle until the onTaskDone terminal', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-background-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-bg', VALID_PLANNED)
      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'c-bg', name: 'subagent', agent: { id: 'sess-1' } },
        { isError: false, value: { kind: 'background', taskId: 'subagent-7' } },
      )

      // The pairing store now maps the registry task id → the dispatch.
      expect(pairing.dispatchByTaskId.get('subagent-7')).toMatchObject({ role: 'fullstack-dev', planId: '20260810-agent-flow' })
      // No settle yet — the ledger stays dispatch-only (honest).
      let view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])

      // The terminal arrives → recordTaskSettle pairs and settles.
      recordTaskSettle({ id: 'subagent-7', status: 'completed', startedAt: 1_000, finishedAt: 4_000 }, pairing)
      view = readAgentFlow(harnessDir)!
      expect(view.events).toHaveLength(2)
      expect(view.events[0]).toMatchObject({
        kind: 'settle',
        outcome: 'ok',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '20260810-agent-flow',
        taskId: 'T2',
        durationMs: 3_000,
      })
      // The consumed task entry is pruned — the map holds only in-flight tasks
      // (qc1 F-102 / qc2 F-002 / qc3 F-002 fix-wave).
      expect(pairing.dispatchByTaskId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a continuable result records nothing (no terminal signal this round — documented limit)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-continuable-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-cont', VALID_PLANNED)
      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'c-cont', name: 'subagent', agent: { id: 'sess-1' } },
        { isError: false, value: { kind: 'continuable', subagentId: 'child-1' } },
      )
      const view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch']) // dispatch only
      expect(pairing.dispatchByTaskId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('non-dispatch tool calls record nothing (even with a paired callId)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-nondispatch-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // A callId that IS paired, but the tool name is not a dispatch tool.
      pairedDispatch(harnessDir, pairing, 'c-read', VALID_PLANNED)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-read', name: 'read_file', agent: { id: 'sess-1' } }, { isError: false, value: 'file content' })
      const view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an UNPAIRED dispatch-tool post-execute records nothing and warns once (honest degrade)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-unpaired-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, {}, pairingOf())
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-nope', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: 'x' })
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-nope-2', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: 'y' })

      expect(readAgentFlow(harnessDir)).toEqual({ events: [], summary: [] }) // no record
      expect(captured).toHaveLength(2) // registration note + ONE unpaired warning
      expect(captured[1]).toContain('had no paired call key')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the pairing trace logs ONCE per logger binding, not per registration (qc1 F-006)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-once-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, {}, pairingOf())
      registerSettleListener(ctx, {}, pairingOf())

      // Two registrations under ONE binding → the ~300-char note is emitted
      // exactly once (a second apply would rebind the sink and log again).
      expect(captured).toHaveLength(1)
      expect(captured[0]).toBe(SETTLE_SEAM_PAIRING_NOTE)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agent-flow settle — recordTaskSettle terminal mapping (onTaskDone)', () => {
  /** Seed one taskId → dispatchRef pairing directly. */
  function seededPairing(harnessDir: string, taskId: string, role = 'fullstack-dev'): AgentFlowPairing {
    const pairing = pairingOf()
    pairing.dispatchByTaskId.set(taskId, { harnessDir, agent: 'sess-1', role, planId: 'plan-x', taskId: 'T2' })
    return pairing
  }

  it('completed → ok, killed → denied, failed → error; durationMs = finishedAt − startedAt when available', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-taskdone-map-')
    try {
      recordTaskSettle({ id: 'subagent-1', status: 'completed', startedAt: 100, finishedAt: 700 }, seededPairing(harnessDir, 'subagent-1'))
      recordTaskSettle({ id: 'subagent-2', status: 'killed' }, seededPairing(harnessDir, 'subagent-2'))
      recordTaskSettle({ id: 'subagent-3', status: 'failed', startedAt: 10, finishedAt: 20 }, seededPairing(harnessDir, 'subagent-3'))

      const view = readAgentFlow(harnessDir)!
      expect(view.events.map((e) => e.outcome)).toEqual(['error', 'denied', 'ok']) // latest first
      expect(view.events[2]).toMatchObject({ outcome: 'ok', durationMs: 600 })
      expect(view.events[1]).toMatchObject({ outcome: 'denied' })
      expect(view.events[1].durationMs).toBeUndefined() // no timestamps → no duration
      expect(view.events[0]).toMatchObject({ outcome: 'error', durationMs: 10 })
      // The settle carries the paired identity (same fields as the dispatch).
      expect(view.events[2]).toMatchObject({ role: 'fullstack-dev', planId: 'plan-x', taskId: 'T2', agent: 'sess-1' })
      expect(view.events[2].paired).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an UNPAIRED task id records nothing (honest — no fabricated settlement)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-taskdone-unpaired-')
    try {
      recordTaskSettle({ id: 'subagent-99', status: 'completed' }, pairingOf())
      expect(readAgentFlow(harnessDir)).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agent-flow — catalog-invalidation hook (Task 2 seam)', () => {
  it('a bound invalidator fires with the harness dir after successful records; a FAILING record does not', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-invalidator-')
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'i am a file, not a directory')
    const seen: string[] = []
    const prior = setAgentFlowInvalidator((dir) => { seen.push(dir) })
    try {
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordSettle({ harnessDir, outcome: 'ok' })
      expect(seen).toEqual([harnessDir, harnessDir])
      // A failing record (append throws) never fires the hook.
      recordDispatch({ harnessDir: blocked, prompt: VALID_PLANNED, violations: [], hard: false })
      expect(seen).toEqual([harnessDir, harnessDir])
    } finally {
      setAgentFlowInvalidator(prior)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a dispatch through the real composition invalidates the catalog cache — the event is visible at the next pre-step within the REAL TTL (apply-bound wiring, Task 2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-invalidator-wiring-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    // REAL TTL (default 60000): the event can only be visible at the first
    // pre-step if the record invalidated the boot-seeded cache entry.
    const app = booted = await bootApp({ root })
    // Dispatch BEFORE any pre-step: only the apply-time pre-registration of
    // the explicit-config reverse map makes the boot-seeded entry
    // invalidatable here — a no-op binding (Task 1 state) or a missing
    // pre-registration would leave the stale boot build visible within the TTL.
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })

    const step = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { source } = catalogRowOf(step)
    expect(source.state!.agentFlow!.events).toHaveLength(1)
    expect(source.state!.agentFlow!.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok' })
  })
})

/* ===========================================================================
 * 4b. Upstream seam probes (plan `20260811-panel-f4-timeliness` T1 Step 1 —
 *     prove the seams BEFORE writing the pairing): the REAL dsh-tools
 *     registry emits `tools/post-execute` for every tool call
 *     (`runPostExecute` pipeline), and `ctx.tasks.onTaskDone` is registrable
 *     via `ctx.inject(['tasks'])` and receives terminal snapshots.
 * ========================================================================== */

describe('upstream seam probe — real dsh-tools registry emits tools/post-execute (T1 Step 1)', () => {
  it('a real tool call through the composed registry dispatches the post-execute waterfall with (exec, result)', async () => {
    const app = booted = await bootApp()
    const seen: Array<{ callId: string; name: string; value: unknown }> = []
    app.ctx.on(SETTLE_SEAM as never, ((exec: unknown, result: unknown, next?: () => unknown): unknown => {
      const execRec = exec as { callId?: string; name?: string }
      const resultRec = result as { isError?: boolean; value?: unknown }
      seen.push({ callId: execRec.callId ?? '', name: execRec.name ?? '', value: resultRec.value })
      return next === undefined ? undefined : next()
    }) as never)

    app.ctx.tools.register(defineTool({
      name: 'probe-tool',
      description: 'seam probe',
      parameters: { input: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async () => 'probe result',
    }))
    const result = await app.ctx.tools.execute({
      callId: 'probe-1' as CallId,
      name: 'probe-tool',
      arguments: { input: 'x' },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    // The real registry dispatched `tools/post-execute` once with the exec's
    // callId/name and the canonical result value (the pre-execute waterfall
    // also ran first — the mstar dispatch gate is registered prepend).
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ callId: 'probe-1', name: 'probe-tool' })
    expect(seen[0].value).toBe('probe result')
  })
})

describe('upstream seam probe — ctx.inject([\'tasks\']) onTaskDone wiring (T1 Step 1)', () => {
  it('registers against a provided tasks service and receives a terminal snapshot — full chain dispatch → background → terminal → settle', async () => {
    const app = booted = await bootApp({ tasksService: 'fake' })
    // A dispatch tool returning the VERIFIED background shape (canonical
    // `{ kind: 'background', taskId }` — the upstream dsh-tool-subagent
    // output schema) so the post-execute branch stores taskId → dispatchRef.
    app.ctx.tools.register(defineTool({
      name: 'subagent',
      description: 'delegate a task to a subagent',
      parameters: {
        description: { type: 'string' },
        prompt: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'background' },
            taskId: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: { kind: 'background'; taskId: string }) =>
          [{ type: 'text', text: `started background subagent task ${value.taskId}` }],
      },
      execute: async () => ({ kind: 'background' as const, taskId: 'subagent-1' }),
    }))

    const result = await app.ctx.tools.execute({
      callId: 'bg-1' as CallId,
      name: 'subagent',
      arguments: { description: 'probe', prompt: VALID_PLANNED },
      agent: { id: 'probe-agent' } as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)

    // Dispatch recorded; background → NO settle yet (the terminal is pending).
    let view = readAgentFlow(app.harnessDir)!
    expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])

    // Fire the terminal through the onTaskDone listener the plugin's
    // `ctx.inject(['tasks'])` wiring registered on the fake tasks service.
    const tasks = app.ctx.tasks as unknown as FakeTaskService
    tasks.fireDone({
      id: TaskId('subagent-1'),
      kind: 'subagent',
      label: 'probe',
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 2_500,
      reported: true,
    })

    view = readAgentFlow(app.harnessDir)!
    expect(view.events).toHaveLength(2)
    expect(view.events[0]).toMatchObject({
      kind: 'settle',
      outcome: 'ok',
      agent: 'probe-agent',
      role: 'fullstack-dev',
      planId: '20260810-agent-flow',
      taskId: 'T2',
      durationMs: 1_500,
    })
  })

  it('the inject wiring is INERT without a tasks service (the plugin boots fine)', async () => {
    // bootApp WITHOUT tasksService: the deferred `ctx.inject(['tasks'])` child
    // fiber simply never activates — the plugin apply and the dispatch gate
    // work normally (no top-level `'tasks'` inject blocking boot).
    const app = booted = await bootApp()
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })
    const view = readAgentFlow(app.harnessDir)!
    expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])
  })
})

/* ---------------------------------- shared payload helpers ---------------------------------- */

/** One pre-existing user message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage => createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hello from the inbox' }],
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** A `agent/pre-step` payload the agent loop would dispatch. */
function stepPayload(messages: UserMessage[], signal = new AbortController().signal) {
  // The real agent/pre-step payload type demands a full Agent — the tests
  // emit a minimal stand-in (the plugin reads only the fields it needs).
  return { agent: {}, messages, turn: 1, step: 1, signal } as never
}

/** Narrow an enter decision to its appended engine-status catalog row. */
function catalogRowOf(decision: PreStepDecision): { row: UserMessage; source: MstarEngineStatusSource } {
  if (decision.kind !== 'enter') throw new Error('expected enter')
  const row = decision.messages.at(-1)
  if (row === undefined) throw new Error('missing catalog row')
  const source = row.source
  if (source.kind !== 'mstar-engine-status') throw new Error('missing catalog row')
  return { row, source }
}

/** The model-facing text of a catalog row. */
function textOf(row: UserMessage): string {
  return row.content[0]?.type === 'text' ? row.content[0].text : ''
}

/* ===========================================================================
 * 5. Catalog integration — state.agentFlow + compact model line
 * ========================================================================== */

describe('agent-flow catalog — state.agentFlow evidence + render', () => {
  it('ledger events surface as state.agentFlow; the model text gains ONE compact line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // Seeded BEFORE boot: the explicit-config catalog cache is pre-built at
    // apply(), so the boot-time source carries the ledger (spec §2.2 TTL cycle).
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      [AGENT_FLOW_FILE]: `${dispatchLine()}\n${settleLine()}\n`,
    })
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const { row, source } = catalogRowOf(decision)

    // Structured evidence: events (latest first) + summary over the window.
    expect(source.state).not.toBeNull()
    const flow = source.state!.agentFlow!
    expect(flow.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
    expect(flow.events[1]).toMatchObject({
      kind: 'dispatch',
      agent: 'a1',
      role: 'fullstack-dev',
      planId: '20260810-x',
      taskId: 'T2',
      verdict: 'ok',
    })
    expect(flow.summary).toEqual([
      { role: '', outcome: 'ok', count: 1 },
      { role: 'fullstack-dev', outcome: 'ok', count: 1 },
    ])

    // Compact model line (the event detail lives in the structured source only).
    const text = textOf(row)
    expect(text).toContain('agent flow: 2 events; by role: fullstack-dev 1; latest: fullstack-dev→20260810-x#T2 ')
    expect(text.split('\n').filter((l) => l.startsWith('agent flow:')).length).toBe(1)
  })

  it('no ledger → state.agentFlow is the EMPTY view and NO agent-flow line (qc1 F-001 fix-wave: missing file reads as empty, not null)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-none-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // state is gated on status.json — seed it so the state section exists
    // with an absent ledger (the missing-file empty view under test).
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const { row, source } = catalogRowOf(decision)

    expect(source.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
  })

  it('a full 50-event window renders the model-line window marker (qc3 F-004: "N events (latest 50)")', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-window-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    const lines: string[] = []
    for (let i = 0; i < 55; i += 1) lines.push(dispatchLine({ ts: 1_700_000_000_000 + i }))
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      [AGENT_FLOW_FILE]: `${lines.join('\n')}\n`,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    expect(source.state!.agentFlow!.events).toHaveLength(50)
    expect(textOf(row)).toContain('agent flow: 50 events (latest 50)')
  })

  it('zero events (malformed-only ledger) → no agent-flow line, state stays present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-empty-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      [AGENT_FLOW_FILE]: 'not json\n{{{ broken\n',
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(decision)

    expect(source.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
  })

  it('the agentFlow view carries no undefined-valued keys (Session.append lossless JSON)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-omit-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      [AGENT_FLOW_FILE]: `${dispatchLine()}\n${settleLine({ durationMs: undefined })}\n`,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { source } = catalogRowOf(decision)

    const sourceRecord = source as unknown as Record<string, unknown>
    expect(Object.values(sourceRecord).every((v) => v !== undefined)).toBe(true)
    const state = source.state as unknown as Record<string, unknown>
    expect(Object.values(state).every((v) => v !== undefined)).toBe(true)
    const flow = state.agentFlow as { events: Array<Record<string, unknown>> }
    for (const event of flow.events) {
      expect(Object.values(event).every((v) => v !== undefined)).toBe(true)
    }
  })

  it('a mid-session dispatch lands in the catalog within one TTL (catalogTtlMs: 0 → immediate refresh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-ttl-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    const app = booted = await bootApp({ root, catalogTtlMs: 0 })
    // First pre-step: no events yet.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    catalogRowOf(first)
    // Dispatch one event.
    await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    // Second pre-step: TTL 0 forces a rebuild → the event is visible.
    const second = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row, source } = catalogRowOf(second)

    expect(source.state!.agentFlow?.events).toHaveLength(1)
    expect(source.state!.agentFlow?.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok' })
    expect(textOf(row)).toContain('agent flow: 1 events')
  })
})
