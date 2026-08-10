/**
 * Task 1 — server-side dispatch ledger + catalog `state.agentFlow` evidence
 * (plan `20260810-agent-flow-catalog-graph`, spec §2.1 / §2.2).
 *
 * Coverage (AC-3 / AC-5 anchors):
 * - ledger unit: recordDispatch / recordSettle / readAgentFlow — verdict
 *   derivation (ok / advisory / denied incl. hard deny), header/body identity
 *   derivation (role / planId / taskId / taskCategory), latest-first bound
 *   (limit 50), truncation (AGENT_FLOW_MAX_EVENTS 500), malformed-line
 *   tolerance, missing-file degrade → null, summary (role × outcome, count
 *   desc), and the never-throw advisory contract;
 * - dispatch smoke: REAL Loader boot + `ctx.waterfall('tools/pre-execute', …)`
 *   lands one event per Assignment-shaped dispatch (clean / advisory / hard
 *   deny), the host-hook path (`beforeDispatch`, exec-less) records too, and
 *   non-Assignment / non-subagent-tool / no-harness-dir calls stay silent;
 * - settle Tier-2: the defensive `tools/post-execute` listener — the
 *   settle-unavailable trace is logged once at registration (spec §2.1.2
 *   verification gate), a simulated host emission records a settle (pair and
 *   single-object payload forms), and an unmapped payload logs once without
 *   recording (never fabricate settlement);
 * - catalog integration: `state.agentFlow` surfaces the ledger (events ≤ 50 +
 *   summary), the model text gains ONE compact line only when events > 0, and
 *   the view carries no undefined-valued keys (Session.append lossless JSON).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  AGENT_FLOW_FILE,
  AGENT_FLOW_MAX_EVENTS,
  SETTLE_SEAM,
  readAgentFlow,
  recordDispatch,
  recordSettle,
} from '../src/index.ts'
import { registerSettleListener, setAgentFlowLogger, SETTLE_SEAM_UNAVAILABLE_NOTE, taskIdOf } from '../src/gates/agent-flow.ts'
import type { AgentFlowView, MstarEngineStatusSource } from '../src/index.ts'
import { HarnessResolver } from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

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
    token: Symbol('dsh.tool.execution'),
  }
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

  it('readAgentFlow is latest-first and bounded by the limit (default 50)', async () => {
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

  it('missing file / missing harness dir → null (advisory degrade)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-missing-')
    try {
      expect(readAgentFlow(harnessDir)).toBeNull()
      expect(readAgentFlow(join(root, 'does-not-exist'))).toBeNull()
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

describe('taskIdOf — body `Task N` best-effort extraction', () => {
  it('extracts the first numbered Task heading from the BODY, normalized to T<n>', () => {
    expect(taskIdOf(VALID_PLANNED)).toBe('T2')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n### Task 7\n\nwork`)).toBe('T7')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\nDo the thing.`)).toBeUndefined()
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
 * 3. Dispatch smoke — REAL Loader boot + tools/pre-execute waterfall
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

    expect(readAgentFlow(app.harnessDir)).toBeNull()
  })

  it('no harness dir → no record, gate unchanged (degrade is silent)', async () => {
    const app = booted = await bootApp({ harnessDir: null })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    // No harness dir → no ledger location; nothing crashed (advisory degrade).
  })
})

/* ===========================================================================
 * 4. Settle Tier-2 — defensive listener + verification-gate trace
 * ========================================================================== */

describe('agent-flow settle — defensive tools/post-execute listener (Tier-2)', () => {
  it('registration logs the settle-unavailable trace once (spec §2.1.2 verification gate)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-trace-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, new HarnessResolver(harnessDir))

      expect(captured).toHaveLength(1)
      expect(captured[0]).toBe(SETTLE_SEAM_UNAVAILABLE_NOTE)
      expect(SETTLE_SEAM).toBe('tools/post-execute')
      expect(SETTLE_SEAM_UNAVAILABLE_NOTE).toContain(SETTLE_SEAM)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a simulated host emission (pair form: exec, result) records a settle event', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-pair-')
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, new HarnessResolver(harnessDir))

      emitUndeclared(ctx, SETTLE_SEAM, { agent: { id: 'settled-1' }, name: 'subagent' }, { isError: false })

      const view = readAgentFlow(harnessDir)
      expect(view!.events).toHaveLength(1)
      expect(view!.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'settled-1' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a single-object payload form ({ exec, result }) records a settle with error outcome', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-single-')
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, new HarnessResolver(harnessDir))

      emitUndeclared(ctx, SETTLE_SEAM, {
        exec: { agent: { id: 'settled-2' }, name: 'subagent' },
        result: { isError: true, error: { message: 'boom' } },
        durationMs: 42,
      })

      const view = readAgentFlow(harnessDir)
      expect(view!.events).toHaveLength(1)
      expect(view!.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: 'settled-2', durationMs: 42 })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an unmapped payload logs once and records nothing (never fabricate settlement)', async () => {
    const { root, harnessDir } = await tempHarness('dsh-agentflow-settle-unmapped-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, new HarnessResolver(harnessDir))

      emitUndeclared(ctx, SETTLE_SEAM, { something: 'unrelated' })

      expect(readAgentFlow(harnessDir)).toBeNull()
      expect(captured).toHaveLength(2) // registration note + unmapped warning
      expect(captured[1]).toContain('did not map to a settle event')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
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
  return { agent: {}, messages, turn: 1, step: 1, signal }
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

  it('no ledger → state.agentFlow null and NO agent-flow line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-none-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    // state is gated on status.json — seed it so the state section exists
    // with an absent ledger (the degrade under test).
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const { row, source } = catalogRowOf(decision)

    expect(source.state!.agentFlow).toBeNull()
    expect(textOf(row)).not.toContain('agent flow:')
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
