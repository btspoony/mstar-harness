/**
 * Task 1 — server-side dispatch ledger + catalog `state.agentFlow` evidence
 * (spec §2.1 / §2.2) — extended by
 *: REAL settle pairing (real
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
 * - settle pairing (plan  T1): the
 *   `tools/post-execute` listener — dispatch-tool matching, the VERIFIED
 *   three-shape branch (background → jobId store / continuable → honest
 *   no-settle / foreground+other → settle ok, isError → error), unpaired →
 *   no settle + one warn, non-dispatch tool → no record, and the settle
 *   carries the PAIRED dispatch identity (role/planId/taskId — schema +
 *   view `paired` marker + JSONL round-trip); `recordJobSettle` maps the
 *   three onJobDone terminal statuses (completed→ok / killed→denied /
 *   failed→error) + durationMs and stays silent for unpaired job ids;
 *   the catalog-invalidation hook fires after successful records (Task 2
 *   seam); the upstream seam probes prove the REAL registry emits
 *   `tools/post-execute` and the `ctx.inject(['jobs'])` onJobDone wiring
 *   registers + receives terminals (Step 1 — 先证后写);
 * - catalog integration: `state.agentFlow` surfaces the ledger (events ≤ 50 +
 *   summary), the model text gains ONE compact line only when events > 0, and
 *   the view carries no undefined-valued keys (Session.append lossless JSON).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
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
  registerSubagentCatalogListener,
  recordJobSettle,
  recordSubagentLink,
  recordWorkflowEvent,
  recordWorkflowVerdict,
  setAgentFlowInvalidator,
  setAgentFlowLogger,
  SETTLE_SEAM_PAIRING_NOTE,
  taskIdOf,
  truncateLedgerField,
  WORKFLOW_LEDGER_TRUNCATION_MARKER,
} from '../src/gates/agent-flow.ts'
import type { AgentFlowCatalogJoin, AgentFlowPairing } from '../src/gates/agent-flow.ts'
import type { SessionHint } from '../src/gates/workflow-selection.ts'
import type { AgentFlowView, MstarEngineStatusSource } from '../src/index.ts'
import { buildCatalogPayload } from '../src/gates/catalog.ts'
import { bootApp, seedHarness, seedV2Tree, FakeJobRegistry, v2Root, v2Snapshot, v2WorkflowEntry, type BootResult } from './harness.ts'

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
**Plan Path**: /proj/plans/00000810-agent-flow.md

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
  planId: '00000810-x',
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

/** A ledger event line (v1 subagent-link identity row — no verdict/outcome). */
const linkLine = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1,
  ts: 1_700_000_002_000,
  kind: 'subagent-link',
  agent: 'a1',
  childId: 'child-read',
  label: 'read it back',
  role: 'fullstack-dev',
  planId: '00000810-x',
  taskId: 'T3',
  taskRef: 'subagent-11',
  ...overrides,
})

/**
 * A v1 dispatch line padded to ~2 KiB via an ignored display field — the
 * LARGE-ledger fixture line  200 of
 * these ≈ 400 KiB, deterministically above the 64 KiB read byte gate, and
 * each line is large enough that the FIRST 64 KiB tail window holds fewer
 * than `AGENT_FLOW_DEFAULT_LIMIT` complete lines — forcing the tail window
 * to double backward (the growth step is exercised too). The `pad` field is
 * ignored by the parse funnel (structural narrowing), so a padded line
 * carries the SAME logical event as its unpadded sibling.
 */
const paddedDispatchLine = (ts: number): string =>
  JSON.stringify({
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
    pad: 'x'.repeat(2048),
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
  // v3 layout: the ledger lives in the ACTIVE workflow dir (the boot's
  // seeded v2 tree — `seedV2` — has one active workflow `wf-1`).
  const view = readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))
  expect(view).not.toBeNull()
  return view!
}

/**
 * Create a temp harness dir seeded with a minimal v2 tree (root status.json
 * + one active workflow `wf-1` + its snapshot) — the v3 write-path
 * precondition: the agent-flow writer / ledger append only to an ACTIVE
 * workflow .
 */
async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string; workflowDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await seedV2Tree(harnessDir)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows/wf-1') }
}

/* ===========================================================================
 * 1. Ledger unit — record / read / truncate / summary / degrade
 * ========================================================================== */

describe('agent-flow ledger — recordDispatch / readAgentFlow', () => {
  it('records a v1 dispatch event; readAgentFlow returns the catalog view (verdict ok)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-record-')
    try {
      recordDispatch({ harnessDir, exec: { agent: { id: 'sess-1' } }, prompt: VALID_PLANNED, violations: [], hard: false })

      const view = readAgentFlow(workflowDir)
      expect(view).not.toBeNull()
      expect(view!.events).toHaveLength(1)
      expect(view!.events[0]).toMatchObject({
        kind: 'dispatch',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '00000810-agent-flow',
        taskId: 'T2',
        taskCategory: 'logic',
        verdict: 'ok',
        hard: false,
      })
      // The serialized line is the v1 schema (optional fields omitted — no undefined keys).
      // v3 layout: the ledger lives in the ACTIVE workflow dir, never the root.
      const line = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim()
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed).toMatchObject({ v: 1, kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })
      expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true)
      // Regression : the serialized line must NEVER carry prompt
      // body text — the record persists only derived fields.
      expect(line).not.toContain('Implement the ledger')
      // The ROOT ledger is never written (the writer appends only to the
      // active workflow dir).
      expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('verdict derivation: no violations → ok; hard + violations → denied; else advisory', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-verdict-')
    try {
      const violation = { ok: false, severity: 'high', code: 'assignment.field.branch-missing', message: 'x' }
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_BRANCH, violations: [violation], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_EXECUTE_AS, violations: [violation], hard: true })

      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.verdict)).toEqual(['denied', 'advisory', 'ok']) // latest first
      expect(view!.events.map((e) => e.hard)).toEqual([true, false, false])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('agent is omitted when the exec carries none (host-hook shape) and when role is missing', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-agent-')
    try {
      recordDispatch({ harnessDir, exec: undefined, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, exec: { agent: { id: '' } }, prompt: VALID_PLANNED, violations: [], hard: false })

      const view = readAgentFlow(workflowDir)
      expect(view!.events.every((e) => e.agent === null)).toBe(true)
      // The JSONL lines carry NO agent key (omit discipline at the record).
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      for (const line of lines) {
        expect((JSON.parse(line) as Record<string, unknown>).agent).toBeUndefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('planId derives from Plan Path basename; body-quoted Plan Path never resolves (header-region scoping)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-planid-')
    try {
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      const view = readAgentFlow(workflowDir)
      expect(view!.events[0]!.planId).toBe('00000810-agent-flow')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recordSettle writes outcome + durationMs + the optional child identity (all omitted when absent)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-')
    try {
      recordSettle({ harnessDir, agent: 'sess-1', outcome: 'ok', durationMs: 1234 })
      recordSettle({ harnessDir, outcome: 'error' })
      // A supplied child identity is written verbatim; an empty/oversized one
      // is OMITTED (never truncated, never an undefined-valued key).
      recordSettle({ harnessDir, outcome: 'denied', childId: 'child-direct', taskRef: 'job-9' })
      recordSettle({ harnessDir, outcome: 'ok', childId: '', taskRef: 'j'.repeat(513) })

      const view = readAgentFlow(workflowDir)
      expect(view!.events.map((e) => e.kind)).toEqual(['settle', 'settle', 'settle', 'settle'])
      expect(view!.events[3]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-1', durationMs: 1234 })
      expect(view!.events[2]).toMatchObject({ kind: 'settle', outcome: 'error', agent: null })
      expect(view!.events[1]).toMatchObject({ kind: 'settle', outcome: 'denied', childId: 'child-direct', taskRef: 'job-9' })
      expect(view!.events[0].childId).toBeUndefined()
      expect(view!.events[0].taskRef).toBeUndefined()
      // The invalid-identity row reached the file WITHOUT either key.
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n')
      const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>
      expect('childId' in last).toBe(false)
      expect('taskRef' in last).toBe(false)
      expect(Object.values(last).every((v) => v !== undefined)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('readAgentFlow is latest-first and bounded by the limit (default 50); limit 0 → the empty window ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-limit-')
    try {
      for (let i = 0; i < 60; i += 1) {
        recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      }
      const defaultView = readAgentFlow(workflowDir)
      expect(defaultView!.events).toHaveLength(50)
      expect(defaultView!.events[0]!.ts).toBeGreaterThanOrEqual(defaultView!.events[49]!.ts)
      const small = readAgentFlow(workflowDir, 10)
      expect(small!.events).toHaveLength(10)
      // Explicit semantics: 0 requests the EMPTY window (not a silent
      // fallback to the default).
      expect(readAgentFlow(workflowDir, 0)).toEqual({ events: [], summary: [] })
      // Negative/NaN-like values floor to 0 → the empty window too.
      expect(readAgentFlow(workflowDir, -3)).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('truncates the file to the most recent AGENT_FLOW_MAX_EVENTS lines after many appends', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-truncate-')
    try {
      const total = AGENT_FLOW_MAX_EVENTS + 25
      for (let i = 0; i < total; i += 1) {
        recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      }
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(AGENT_FLOW_MAX_EVENTS)
      // The view reflects the truncated tail (the first recorded event is gone).
      const view = readAgentFlow(workflowDir, 500)
      expect(view!.events).toHaveLength(AGENT_FLOW_MAX_EVENTS)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('size gate: a tiny-line ledger below the threshold keeps >500 lines (append-only fast path); the truncating read-modify-write still runs once the file crosses the gate', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-sizegate-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      // ~60 B settle lines: 600 of them ≈ 36 KiB stay BELOW the 64 KiB gate,
      // so the append path must NOT read-modify-write — all 600 lines persist
      // even though they exceed AGENT_FLOW_MAX_EVENTS (the documented
      // approximate bound under the size gate).
      for (let i = 0; i < 600; i += 1) recordSettle({ harnessDir, outcome: 'error' })
      expect(statSync(file).size).toBeLessThan(AGENT_FLOW_SIZE_GATE_BYTES)
      let lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')
      expect(lines.length).toBe(600)
      expect(readAgentFlow(workflowDir, 700)!.events).toHaveLength(600)
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

  it('concurrent process appends serialize behind the per-workflow write lock — the truncating read-modify-write never drops the other process rows ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-concurrent-')
    let script = ''
    try {
      // Seed the ledger PAST the size gate with ~500 lines so EVERY append
      // takes the truncating read-modify-write path — the exact window
      // W-1 closes (interleaved truncate reads would drop the other
      // process's just-appended lines without the lock).
      const seedLines: string[] = []
      for (let i = 0; i < AGENT_FLOW_MAX_EVENTS + 20; i += 1) {
        seedLines.push(dispatchLine({ ts: 1_700_000_000_000 + i }))
      }
      await writeFile(join(workflowDir, AGENT_FLOW_FILE), seedLines.join('\n') + '\n')
      expect(statSync(join(workflowDir, AGENT_FLOW_FILE)).size).toBeGreaterThan(AGENT_FLOW_SIZE_GATE_BYTES)

      // The child script drives the REAL record path in a separate process.
      // It lives INSIDE the package root (tmp-named, removed in finally) so
      // bare + relative imports resolve exactly like the package's own code.
      const pkgRoot = join(import.meta.dir, '..')
      script = join(pkgRoot, `.tmp-concurrent-append-${process.pid}-${Date.now()}.ts`)
      await writeFile(script, [
        `import { recordWorkflowEvent } from './src/gates/agent-flow.ts'`,
        'const harnessDir = process.argv[2]',
        'const tag = process.argv[3]',
        'for (let i = 0; i < 10; i += 1) {',
        "  recordWorkflowEvent({ harnessDir, event: { v: 1, ts: Date.now(), kind: 'workflow-run', runId: `${tag}-${i}`, name: 'concurrent-append' } })",
        '}',
      ].join('\n'))

      const spawnChild = (tag: string) =>
        Bun.spawn(['bun', script, harnessDir, tag], { cwd: pkgRoot, stdin: 'ignore', stderr: 'pipe' })
      const a = spawnChild('proc-a')
      const b = spawnChild('proc-b')
      const [aExit, bExit] = [await a.exited, await b.exited]
      expect(aExit).toBe(0)
      expect(bExit).toBe(0)

      // Serialized appends: the ledger stays at the truncation bound and
      // ALL 20 concurrent runs survived — none lost to a racing truncate.
      const lines = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').replace(/\n$/, '').split('\n')
      expect(lines).toHaveLength(AGENT_FLOW_MAX_EVENTS)
      for (let i = 0; i < 10; i += 1) {
        expect(lines.some((line) => line.includes(`proc-a-${i}`))).toBe(true)
        expect(lines.some((line) => line.includes(`proc-b-${i}`))).toBe(true)
      }
      // The lockdir is transient — nothing leaks after the critical sections.
      expect(existsSync(join(workflowDir, '.ledger-write.lockdir'))).toBe(false)
    } finally {
      await rm(script, { force: true }).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips malformed lines — never fatal; empty/malformed-only files yield an empty view', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-malformed-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      await writeFile(file, [
        'not json at all {{{',
        dispatchLine(),
        '{ broken json',
        settleLine({ outcome: 'error' }),
        '',
      ].join('\n') + '\n')

      const view = readAgentFlow(workflowDir)
      expect(view!.events).toHaveLength(2)
      expect(view!.events.map((e) => e.kind)).toEqual(['settle', 'dispatch']) // latest first

      await writeFile(file, 'garbage\nalso garbage\n')
      const empty = readAgentFlow(workflowDir)
      expect(empty).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('missing file → EMPTY view (the panel empty state); ONLY an unreadable ledger → null ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-missing-')
    try {
      // Missing ledger = recording hasn't started (it begins at plan merge) —
      // the empty view, never an evidence-missing degrade.
      expect(readAgentFlow(workflowDir)).toEqual({ events: [], summary: [] })
      expect(readAgentFlow(join(root, 'does-not-exist'))).toEqual({ events: [], summary: [] })
      // Unreadable (a DIRECTORY at the ledger path — readFileSync throws
      // EISDIR while existsSync reports presence) → null: only genuine
      // unreadability degrades.
      await mkdir(join(workflowDir, AGENT_FLOW_FILE))
      expect(readAgentFlow(workflowDir)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('summary: role × outcome counts over the same window, count desc', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-summary-')
    try {
      const violation = { ok: false, severity: 'high', code: 'x', message: 'x' }
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_BRANCH, violations: [violation], hard: false })
      recordDispatch({ harnessDir, prompt: MISSING_EXECUTE_AS, violations: [violation], hard: true })
      recordSettle({ harnessDir, outcome: 'ok' })

      const view = readAgentFlow(workflowDir)
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
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-nothrow-')
    // Make the ledger append fail: a DIRECTORY at the workflow-dir ledger
    // slot (EISDIR) while the active-workflow resolution succeeds — the
    // failing-record containment path (the record itself never throws).
    await mkdir(join(workflowDir, AGENT_FLOW_FILE), { recursive: true })
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      expect(() => recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })).not.toThrow()
      expect(() => recordSettle({ harnessDir, outcome: 'ok' })).not.toThrow()
      expect(captured.length).toBe(2)
      expect(captured[0]).toContain('dispatch record failed')
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('no active lifecycle → the record is SKIPPED with a one-time warn — never a root v1 write (Task 2 writer contract)', async () => {
    // A bare harness dir WITHOUT a v2 root (no status.json at all): the
    // active-set resolver returns a clear error → the record is skipped.
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-noactive-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordSettle({ harnessDir, outcome: 'ok' })
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      // Nothing was written — no root ledger, no workflow dir.
      expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
      expect(readAgentFlow(harnessDir)).toEqual({ events: [], summary: [] })
      // Exactly ONE warn for the whole binding (the skip is not re-logged
      // per record — same once-per-apply discipline as the settle trace).
      expect(captured).toHaveLength(1)
      expect(captured[0]).toContain('agent-flow record skipped')
      expect(captured[0]).toContain('root v2 document is required')
    } finally {
      setAgentFlowLogger(priorSink)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a PAUSED lifecycle stays in the active set — the writer appends to its workflow dir (active = workflows[] membership, running|paused)', async () => {
    // Explicit decision: the
    // active set is defined by root `workflows[]` MEMBERSHIP — the engine
    // lifecycle enum's non-terminal states are `running` AND `paused`
    // (terminal lifecycles are removed at terminal). A paused lifecycle is
    // still the operator's current lifecycle — its ledger keeps recording.
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-paused-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-paused')]),
      'workflows/wf-paused/snapshot.json': v2Snapshot('wf-paused', { status: 'paused' }),
    })
    try {
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false })
      recordSettle({ harnessDir, outcome: 'ok' })
      const view = readAgentFlow(join(harnessDir, 'workflows/wf-paused'))
      expect(view!.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      // The root ledger is never written.
      expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ===========================================================================
 * 1b. D4 session-bound write routing — two concurrent active lifecycles
 * ========================================================================== */

/** The workflow ledger event this block records through `recordWorkflowEvent`. */
const RUN_START = { v: 1, ts: 1_700_000_000_000, kind: 'workflow-run', runId: 'run-1', name: 'audit' } as const

/**
 * A temp harness with TWO active lifecycles (`wf-a` / `wf-b`) — the
 * concurrent-active registry the D4 cutover routes through. `order` flips the
 * registry array: array order must never decide a write target.
 */
async function tempMultiHarness(prefix: string, order: readonly string[] = ['wf-a', 'wf-b']): Promise<{ root: string; harnessDir: string; dirs: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await seedHarness(harnessDir, {
    'status.json': v2Root(order.map((id) => v2WorkflowEntry(id))),
    'workflows/wf-a/snapshot.json': v2Snapshot('wf-a'),
    'workflows/wf-b/snapshot.json': v2Snapshot('wf-b'),
  })
  return { root, harnessDir, dirs: { 'wf-a': join(harnessDir, 'workflows/wf-a'), 'wf-b': join(harnessDir, 'workflows/wf-b') } }
}

/** A session hint at one cwd with an explicit durable pick (the same-cwd selection case). */
const picked = (sessionId: string, cwd: string, selectedWorkflowId: string): SessionHint =>
  ({ sessionId, cwd, selectedWorkflowId })

describe('agent-flow — session-bound write routing (two concurrent actives)', () => {
  it('two sessions in the SAME cwd with different picks write into their OWN workflow dirs (no array-order pick)', async () => {
    for (const order of [['wf-a', 'wf-b'], ['wf-b', 'wf-a']] as const) {
      const { root, harnessDir, dirs } = await tempMultiHarness('dsh-agentflow-multi-pick-', order)
      try {
        const cwd = '/srv/workspace/shared'
        recordDispatch({ harnessDir, exec: { agent: { id: 'sess-a' } }, prompt: VALID_PLANNED, violations: [], hard: false, hint: picked('sess-a', cwd, 'wf-a') })
        recordDispatch({ harnessDir, exec: { agent: { id: 'sess-b' } }, prompt: VALID_PLANNED, violations: [], hard: false, hint: picked('sess-b', cwd, 'wf-b') })
        recordSettle({ harnessDir, agent: 'sess-b', outcome: 'ok', hint: picked('sess-b', cwd, 'wf-b') })
        recordWorkflowEvent({ harnessDir, event: RUN_START, hint: picked('sess-a', cwd, 'wf-a') })
        recordWorkflowVerdict({ harnessDir, exec: { agent: { id: 'sess-a' } }, tool: 'workflow', workflow: 'audit', mode: 'warn', verdict: 'ok', hint: picked('sess-a', cwd, 'wf-a') })

        const a = readAgentFlow(dirs['wf-a'])!
        const b = readAgentFlow(dirs['wf-b'])!
        expect(a.events.map((e) => e.kind)).toEqual(['workflow-verdict', 'workflow-run', 'dispatch'])
        expect(b.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
        // Cross-check the identity columns: no row leaked into the sibling.
        expect(a.events.every((e) => e.agent === 'sess-a' || e.agent === null)).toBe(true)
        expect(b.events.map((e) => e.agent)).toEqual(['sess-b', 'sess-b'])
        // The root ledger is never a target.
        expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('an UNBOUND session writes nothing into ANY workflow dir — every writer path skips', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-agentflow-multi-unbound-')
    try {
      recordDispatch({ harnessDir, exec: { agent: { id: 'sess-x' } }, prompt: VALID_PLANNED, violations: [], hard: false })
      recordSettle({ harnessDir, agent: 'sess-x', outcome: 'ok' })
      recordWorkflowEvent({ harnessDir, event: RUN_START })
      recordWorkflowVerdict({ harnessDir, exec: { agent: { id: 'sess-x' } }, tool: 'workflow', workflow: 'audit', mode: 'warn', verdict: 'ok' })
      // A hint that names an id which is NOT in the active registry is just
      // as unbound (a terminal/foreign pick is never revived).
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false, hint: picked('sess-x', '/srv/workspace', 'wf-gone') })

      for (const dir of Object.values(dirs)) {
        expect(existsSync(join(dir, AGENT_FLOW_FILE))).toBe(false)
        expect(readAgentFlow(dir)!.events).toEqual([])
      }
      expect(existsSync(join(harnessDir, AGENT_FLOW_FILE))).toBe(false)
      // The boolean-returning writer reports the skip (the ledger's cursor
      // discipline depends on it: no advance without an append).
      expect(recordWorkflowEvent({ harnessDir, event: RUN_START })).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a pinned workflowDir stays FIRST CHOICE for settle/event even when the session is unbound or picked elsewhere', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-agentflow-multi-pinned-')
    try {
      // Pinned to wf-b while the session is UNBOUND (two actives, no pick).
      recordSettle({ harnessDir, workflowDir: dirs['wf-b'], agent: 'sess-x', outcome: 'ok' })
      recordWorkflowEvent({ harnessDir, workflowDir: dirs['wf-b'], event: RUN_START })
      // Pinned to wf-a while the session's pick says wf-b.
      recordDispatch({ harnessDir, prompt: VALID_PLANNED, violations: [], hard: false, hint: picked('sess-x', '/srv/workspace', 'wf-b') })
      recordSettle({ harnessDir, workflowDir: dirs['wf-a'], agent: 'sess-x', outcome: 'ok', hint: picked('sess-x', '/srv/workspace', 'wf-b') })

      // wf-b holds the two PINNED rows plus the row the session's own pick
      // routed there; wf-a holds ONLY the settle whose dir was pinned to it —
      // the pin beats the wf-b hint.
      expect(readAgentFlow(dirs['wf-b'])!.events.map((e) => e.kind)).toEqual(['dispatch', 'workflow-run', 'settle'])
      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.kind)).toEqual(['settle'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an unbound dispatch creates NO pairing — a later settle for the same call writes nowhere', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-agentflow-multi-nopair-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      const exec = dispatchExec('c-unbound', 'sess-x', VALID_PLANNED)
      recordDispatch({ harnessDir, exec, prompt: VALID_PLANNED, violations: [], hard: false, pairing })
      expect(pairing.dispatchByCallId.size).toBe(0)

      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-unbound', name: 'subagent', agent: { id: 'sess-x' } }, { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } })
      for (const dir of Object.values(dirs)) expect(readAgentFlow(dir)!.events).toEqual([])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a PAIRED settle stays in its dispatch workflow dir after the session re-picks the other lifecycle', async () => {
    const { root, harnessDir, dirs } = await tempMultiHarness('dsh-agentflow-multi-repick-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      const cwd = '/srv/workspace/shared'
      const exec = dispatchExec('c-repick', 'sess-x', VALID_PLANNED)
      recordDispatch({ harnessDir, exec, prompt: VALID_PLANNED, violations: [], hard: false, pairing, hint: picked('sess-x', cwd, 'wf-a') })
      expect(pairing.dispatchByCallId.get('sess-x\u0000c-repick')).toMatchObject({ workflowDir: dirs['wf-a'] })

      // The session re-picks wf-b BEFORE the completion arrives: the settle
      // must still land next to its dispatch (the pairing ref pins the dir).
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-repick', name: 'subagent', agent: { id: 'sess-x' } }, { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } })

      expect(readAgentFlow(dirs['wf-a'])!.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      expect(readAgentFlow(dirs['wf-b'])!.events).toEqual([])
      expect(pairing.dispatchByCallId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
/* ===========================================================================
 * 1b. Role text — ONE canonical `role` column at the write boundary
 * ========================================================================== */

describe('agent-flow — role text is canonicalized at the write boundary', () => {
  /** The same valid Assignment with a different `Execute as` spelling. */
  const promptWithRole = (executeAs: string): string => VALID_PLANNED.replace('**Execute as**: fullstack-dev', `**Execute as**: ${executeAs}`)

  it('`@explore` and `explore` write the SAME role — one actor, never two ledger roles', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-role-at-')
    try {
      recordDispatch({ harnessDir, prompt: promptWithRole('@explore'), violations: [], hard: false })
      recordDispatch({ harnessDir, prompt: promptWithRole('explore'), violations: [], hard: false })

      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((event) => event.role)).toEqual(['explore', 'explore'])
      // The summary groups them as ONE role (the consumer-visible effect).
      expect(view.summary).toEqual([{ role: 'explore', outcome: 'ok', count: 2 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the direct recordSettle / recordSubagentLink boundaries normalize an independent caller\'s raw value', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-role-direct-')
    try {
      recordSettle({ harnessDir, outcome: 'ok', role: '@explore' })
      recordSettle({ harnessDir, outcome: 'ok', role: '  Architect  ' })
      recordSettle({ harnessDir, outcome: 'ok', role: 'full stack' })
      recordSettle({ harnessDir, outcome: 'ok', role: '' })
      recordSettle({ harnessDir, outcome: 'ok', role: '@@explore' })
      recordSettle({ harnessDir, outcome: 'ok' })
      recordSubagentLink({ ref: { harnessDir, workflowDir, role: '@code-reviewer' }, childId: 'child-direct', label: 'direct link' })

      // Latest-first: the link, then the settles newest-first.
      const view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'subagent-link', role: 'code-reviewer', childId: 'child-direct' })
      expect(view.events[1].role).toBe('') // role absent → no key at all, never a re-spelled ''
      expect(view.events[2].role).toBe('@explore') // exactly ONE leading @ removed, never both
      expect(view.events[3].role).toBe('') // a missing `Execute as` stays ''
      expect(view.events[4].role).toBe('full stack') // interior whitespace is NOT rewritten
      expect(view.events[5].role).toBe('Architect') // case is PRESERVED (no folding)
      expect(view.events[6].role).toBe('explore')

      // The role-less settle omitted the key entirely (omit discipline, not `role: ''`).
      const rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['settle', 'settle', 'settle', 'settle', 'settle', 'settle', 'subagent-link'])
      expect('role' in rows[5]!).toBe(false)
      expect(rows.slice(0, 5).map((row) => row.role)).toEqual(['explore', 'Architect', 'full stack', '', '@explore'])
      expect(rows[6]).toMatchObject({ role: 'code-reviewer' })
      expect(rows.every((row) => Object.values(row).every((value) => value !== undefined))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('dispatch, settle, and link rows carry the SAME canonical role for one `Execute as`', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-role-rows-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const prompt = promptWithRole('@explore')

      // (a) continuable child → the nonterminal link row (its role comes from
      // the retained dispatch ref).
      const linkSession = catalogSession('sess-role-link')
      recordDispatch({ harnessDir, exec: catalogExec('c-role-link', 'sess-role-link', linkSession, 'label one'), prompt, violations: [], hard: false, pairing })
      linkSession.append('subagent/catalog', catalogPayload('child-role-link', 'label one'))
      emitPostExecute(ctx, linkSession, 'c-role-link', 'sess-role-link', { isError: false, value: { kind: 'continuable', subagentId: 'child-role-link' } })

      // (b) foreground child → the paired settle row.
      const settleSession = catalogSession('sess-role-settle')
      recordDispatch({ harnessDir, exec: catalogExec('c-role-settle', 'sess-role-settle', settleSession, 'label two'), prompt, violations: [], hard: false, pairing })
      emitPostExecute(ctx, settleSession, 'c-role-settle', 'sess-role-settle', { isError: false, value: { kind: 'foreground', runId: 'run-role' } })

      const rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'subagent-link', 'dispatch', 'settle'])
      expect(rows.map((row) => row.role)).toEqual(['explore', 'explore', 'explore', 'explore'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('historical rows are read as written — never rewritten or renormalized', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-role-historical-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      await writeFile(file, `${dispatchLine({ role: '@explore' })}\n`)
      const legacy = readFileSync(file, 'utf8')

      // A read of a row written before normalization does not re-spell it …
      expect(readAgentFlow(workflowDir)!.events[0]!.role).toBe('@explore')
      expect(readFileSync(file, 'utf8')).toBe(legacy)

      // … and a later normalized record only APPENDS: the legacy line survives byte-identical.
      recordDispatch({ harnessDir, prompt: promptWithRole('@explore'), violations: [], hard: false })
      const after = readFileSync(file, 'utf8')
      expect(after.startsWith(legacy)).toBe(true)
      expect(after.trim().split('\n')).toHaveLength(2)
      expect(ledgerRows(workflowDir).map((row) => row.role)).toEqual(['@explore', 'explore'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agent-flow tail read — bounded latest-first window ', () => {
  it('P2-AC-1: a large padded ledger (200 × ~2 KiB lines) reads its latest 50 events latest-first via the bounded tail', async () => {
    const { root, workflowDir } = await tempHarness('dsh-agentflow-tail-large-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const lines: string[] = []
      for (let i = 0; i < 200; i += 1) lines.push(paddedDispatchLine(1_700_000_000_000 + i))
      await writeFile(file, lines.join('\n') + '\n')
      // Fixture regime: ~2 KiB/line × 200 ≈ 400 KiB — deterministically above
      // the 64 KiB read gate (the test never depends on the gate's exact value).
      expect(statSync(file).size).toBeGreaterThan(256 * 1024)

      const view = readAgentFlow(workflowDir, 50)
      expect(view).not.toBeNull()
      // Latest 50 events, latest-first (the newest line is the first event).
      expect(view!.events).toHaveLength(50)
      expect(view!.events[0]!.ts).toBe(1_700_000_000_199)
      expect(view!.events[49]!.ts).toBe(1_700_000_000_150)
      for (let i = 1; i < view!.events.length; i += 1) {
        expect(view!.events[i]!.ts).toBeLessThanOrEqual(view!.events[i - 1]!.ts)
      }
      // The summary covers the SAME 50-event window (role × verdict counts).
      expect(view!.summary).toEqual([{ role: 'fullstack-dev', outcome: 'ok', count: 50 }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('P2-AC-3 parity: the padded-large tail window equals the unpadded-small full window (same logical events)', async () => {
    const { root, workflowDir } = await tempHarness('dsh-agentflow-tail-parity-large-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const padded: string[] = []
      for (let i = 0; i < 200; i += 1) padded.push(paddedDispatchLine(1_700_000_000_000 + i))
      await writeFile(file, padded.join('\n') + '\n')
      const largeView = readAgentFlow(workflowDir, 50)
      expect(largeView).not.toBeNull()
      expect(statSync(file).size).toBeGreaterThan(256 * 1024)

      const { root: rootSmall, workflowDir: workflowDirSmall } = await tempHarness('dsh-agentflow-tail-parity-small-')
      try {
        const fileSmall = join(workflowDirSmall, AGENT_FLOW_FILE)
        const small: string[] = []
        for (let i = 0; i < 200; i += 1) small.push(dispatchLine({ ts: 1_700_000_000_000 + i }))
        await writeFile(fileSmall, small.join('\n') + '\n')
        const smallView = readAgentFlow(workflowDirSmall, 50)
        expect(smallView).not.toBeNull()
        // Fixture regime: ~160 B/line × 200 ≈ 32 KiB — below the 64 KiB gate.
        expect(statSync(fileSmall).size).toBeLessThan(64 * 1024)

        // The two read paths yield the SAME latest-first window + summary
        // (single parse funnel — parity is structural).
        expect(largeView!.events).toEqual(smallView!.events)
        expect(largeView!.summary).toEqual(smallView!.summary)
      } finally {
        await rm(rootSmall, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('P2-AC-2: an incomplete trailing line on the large path does not throw — the partial line is skipped at the newline boundary', async () => {
    const { root, workflowDir } = await tempHarness('dsh-agentflow-tail-trunc-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      const lines: string[] = []
      for (let i = 0; i < 200; i += 1) lines.push(paddedDispatchLine(1_700_000_000_000 + i))
      // Append a TORN final line: a valid JSON prefix cut off mid-write, with
      // NO trailing newline — the tail window ends at EOF on the partial line.
      await writeFile(file, lines.join('\n') + '\n' + '{"v":1,"ts":1700000000200,"kind":"dis')
      const view = readAgentFlow(workflowDir)
      expect(view).not.toBeNull()
      // No throw: the incomplete line is skipped (malformed → funnel skip);
      // the latest COMPLETE events still come back latest-first.
      expect(view!.events).toHaveLength(50)
      expect(view!.events[0]!.ts).toBe(1_700_000_000_199)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('truncateLedgerField — code-point-safe truncation ', () => {
  it('slices by CODE POINTS, never splitting a surrogate pair at the cap boundary', () => {
    // 510 ASCII + the 2-unit emoji + 2 more = 513 CODE POINTS (515 UTF-16
    // units) > 512, so the code-point gate trips. The cap boundary (511
    // kept code points) lands on the emoji: a UTF-16 `slice(0, 511)` would
    // cut INSIDE its surrogate pair and leave a lone high surrogate
    // (rendered as U+FFFD in the log line). The code-point slice keeps the
    // whole emoji.
    const value = 'a'.repeat(510) + '😀' + 'bc'
    const truncated = truncateLedgerField(value, 512)
    expect(truncated.endsWith(WORKFLOW_LEDGER_TRUNCATION_MARKER)).toBe(true)
    expect(truncated).toContain('😀')
    // No lone surrogate in the result: no high unit without a following low,
    // no low unit without a preceding high.
    expect(truncated.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)).toBeNull()
    expect(truncated.match(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)).toBeNull()
  })

  it('astral-dense values gate and slice by CODE POINTS — UTF-16 width never trips the cap (PR #97 finding 2)', () => {
    // 300 emoji = 600 UTF-16 units but 300 code points: under the cap in
    // code points, over it in UTF-16 units. A UTF-16 `.length` gate would
    // false-positive truncate this (and re-inflate the result to cap code
    // points — up to ~2× the cap in the unit the gate measured). The
    // code-point gate passes it through untouched.
    expect(truncateLedgerField('😀'.repeat(300), 512)).toBe('😀'.repeat(300))
    // Exactly at the cap in code points (2× the cap in UTF-16 units).
    expect(truncateLedgerField('😀'.repeat(512), 512)).toBe('😀'.repeat(512))
    // Above the cap in code points: the result stays at or under cap code
    // points with the visible marker intact.
    const truncated = truncateLedgerField('😀'.repeat(600), 512)
    expect(Array.from(truncated).length).toBeLessThanOrEqual(512)
    expect(truncated).toBe('😀'.repeat(511) + WORKFLOW_LEDGER_TRUNCATION_MARKER)
  })

  it('ASCII values still truncate to cap − marker chars with the visible marker (regression)', () => {
    expect(truncateLedgerField('x'.repeat(600), 512)).toBe('x'.repeat(511) + WORKFLOW_LEDGER_TRUNCATION_MARKER)
  })

  it('values at or under the cap pass through unchanged', () => {
    expect(truncateLedgerField('short', 512)).toBe('short')
    expect(truncateLedgerField('x'.repeat(512), 512)).toBe('x'.repeat(512))
  })
})

/* ===========================================================================
 * 2. taskIdOf — best-effort body Task N extraction
 * ========================================================================== */

describe('taskIdOf — body `Task N` best-effort extraction (level-2 headings only)', () => {
  it('extracts the first LEVEL-2 numbered Task heading from the BODY, normalized to T<n>', () => {
    expect(taskIdOf(VALID_PLANNED)).toBe('T2')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\n## Task 7\n\nwork`)).toBe('T7')
    expect(taskIdOf(`## Assignment\n\n**Execute as**: fullstack-dev\n\nDo the thing.`)).toBeUndefined()
  })

  it('a non-level-2 task heading in the body does NOT resolve (narrower false-hit surface)', () => {
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
    const app = booted = await bootApp({ seedV2: true, dispatchBinding: 'qc-specialist' })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({
      kind: 'dispatch',
      role: 'fullstack-dev',
      planId: '00000810-agent-flow',
      taskId: 'T2',
      taskCategory: 'logic',
      verdict: 'ok',
      hard: false,
    })
  })

  it('a warn-mode advisory (missing branch form) lands a verdict-advisory event', async () => {
    const app = booted = await bootApp({ seedV2: true })

    await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_BRANCH), defaultAllow)

    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'advisory', hard: false })
  })

  it('a hard deny lands a verdict-denied event (spec: hard deny samples record too)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', seedV2: true })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision.kind).toBe('deny')
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'denied', hard: true })
  })

  it('the host-hook path (beforeDispatch, exec-less) records too — agent omitted', async () => {
    const app = booted = await bootApp({ seedV2: true, dispatchBinding: 'qc-specialist' })

    const result = await app.ctx.dshHostAdapter.beforeDispatch(VALID_PLANNED)

    expect(result.ok).toBe(true)
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', agent: null })
  })

  it('non-Assignment prompts and non-subagent tools record nothing', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', seedV2: true })

    await app.ctx.waterfall('tools/pre-execute', subagentExec(GARBAGE_PROMPT), defaultAllow)
    await app.ctx.waterfall(
      'tools/pre-execute',
      { ...subagentExec(MISSING_EXECUTE_AS), name: 'read_file', arguments: { path: '/tmp/note.md' } },
      defaultAllow,
    )

    // No ledger file was ever created — the missing file now reads as the
    // EMPTY view , still proving "nothing recorded".
    expect(readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))).toEqual({ events: [], summary: [] })
  })

  it('the host-hook path stays silent for non-Assignment text (shape guard at the shared core)', async () => {
    const app = booted = await bootApp({ seedV2: true })

    const result = await app.ctx.dshHostAdapter.beforeDispatch(GARBAGE_PROMPT)

    // The gate still validates (ok, no violations for non-assignment text),
    // but no phantom dispatch event lands — same semantics as the listener
    // path (spec §2.1.1 "非 Assignment 不记录" now holds for BOTH surfaces).
    expect(result.ok).toBe(true)
    expect(readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))).toEqual({ events: [], summary: [] })
  })

  it('no harness dir → no record, gate unchanged (degrade is silent)', async () => {
    const app = booted = await bootApp({ harnessDir: null })

    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    // No harness dir → no ledger location; nothing crashed (advisory degrade).
  })
})

/* ===========================================================================
 * 4. Settle pairing — post-execute three-shape branch + onJobDone terminal
 *     + verification-gate trace
 * ========================================================================== */

/** A fresh apply-scoped pairing store (empty maps + slot map). */
function pairingOf(): AgentFlowPairing {
  return { dispatchByCallId: new Map(), dispatchByJobId: new Map(), catalogBySession: new WeakMap() }
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

describe('agent-flow settle — real completion pairing ', () => {
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

  it('recordDispatch with an exec registers the agent-namespaced call key → dispatchRef ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-pairing-register-')
    try {
      const pairing = pairingOf()
      pairedDispatch(harnessDir, pairing, 'c-1', VALID_PLANNED, 'sess-1')
      // The key is `${sessionId}\u0000${callId}` — a raw callId alone would
      // collide across sessions in one process.
      const ref = pairing.dispatchByCallId.get('sess-1\u0000c-1')
      expect(ref).toMatchObject({
        harnessDir,
        // The ref carries the ACTIVE workflow dir the dispatch landed in —
        // the later settle appends to the SAME file (Task 2 writer contract).
        workflowDir,
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '00000810-agent-flow',
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
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-foreground-')
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

      const view = readAgentFlow(workflowDir)!
      expect(view.events).toHaveLength(2) // dispatch + settle
      expect(view.events[0]).toMatchObject({
        kind: 'settle',
        outcome: 'ok',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '00000810-agent-flow',
        taskId: 'T2',
        // The returned child session id rides along as the settle's childId.
        childId: 'r1',
      })
      // The view carries the paired-identity presence marker.
      expect(view.events[0].paired).toBe(true)
      // The serialized JSONL line carries the identity fields (no undefined keys).
      const line = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n').at(-1)!
      const parsed = JSON.parse(line) as Record<string, unknown>
      expect(parsed).toMatchObject({ kind: 'settle', outcome: 'ok', role: 'fullstack-dev', planId: '00000810-agent-flow', taskId: 'T2', childId: 'r1' })
      expect(Object.values(parsed).every((v) => v !== undefined)).toBe(true)
      // A plain-string foreground value settles too (foreground/other success) —
      // with no child identity to record (honest omission, never invented).
      pairing.dispatchByCallId.clear()
      pairedDispatch(harnessDir, pairing, 'c-fg2', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-fg2', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: 'plain result' })
      const after = readAgentFlow(workflowDir)!
      expect(after.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-2', role: 'fullstack-dev' })
      expect(after.events[0].childId).toBeUndefined()
      expect(after.events[0].taskRef).toBeUndefined()
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a FAILED dispatch result settles error with the paired identity', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-error-')
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
      const view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: 'sess-1', role: 'fullstack-dev' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('two agents sharing the same callId never cross-pair — each settle lands on its own dispatch ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-pairing-namespace-')
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
      let view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', agent: 'sess-A', role: 'fullstack-dev', planId: '00000810-agent-flow', taskId: 'T2' })

      // Session B's completion pairs to B's dispatch — the settle identities
      // never crossed (no mis-pair into the other session's dispatchRef).
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-shared', name: 'subagent', agent: { id: 'sess-B' } }, { isError: false, value: { kind: 'foreground', runId: 'rB', output: [] } })
      view = readAgentFlow(workflowDir)!
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

  it('the active set moves between dispatch and settle — the paired settle lands in the DISPATCH workflow dir, never the new one (T2 M4)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-move-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // Dispatch while wf-1 is active — the pairing ref captures wf-1's dir.
      pairedDispatch(harnessDir, pairing, 'c-move', VALID_PLANNED)
      expect(pairing.dispatchByCallId.get('sess-1\u0000c-move')).toMatchObject({ workflowDir })
      // The active set moves to wf-2 BEFORE the completion arrives.
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-2')]),
        'workflows/wf-2/snapshot.json': v2Snapshot('wf-2'),
      })
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-move', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'foreground', runId: 'r-move', output: [] } })
      // The settle landed in wf-1 (the dispatch's file) with the paired
      // identity — wf-2 (the NEW active dir) holds NO rows.
      const wf1 = readAgentFlow(workflowDir)!
      expect(wf1.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      expect(wf1.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-1', role: 'fullstack-dev', planId: '00000810-agent-flow', taskId: 'T2' })
      expect(readAgentFlow(join(harnessDir, 'workflows/wf-2'))!.events).toEqual([])
      // The call was consumed (map pruning).
      expect(pairing.dispatchByCallId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a result carrying `error` WITHOUT `isError: true` settles error — never a fabricated ok ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-error-key-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-err2', VALID_PLANNED, 'sess-1')
      // Failed envelope WITHOUT the canonical `isError` flag: `error` present.
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-err2', name: 'subagent', agent: { id: 'sess-1' } }, { error: { message: 'boom without the flag' } })
      let view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', agent: 'sess-1', role: 'fullstack-dev' })
      // `error` + `value` (both present, no isError) is still a failure.
      pairedDispatch(harnessDir, pairing, 'c-err3', VALID_PLANNED, 'sess-1')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-err3', name: 'subagent', agent: { id: 'sess-1' } }, { error: { message: 'x' }, value: 'partial' })
      view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error' })
      // A FAILED result carrying a SUCCESS-shaped background value still
      // settles error and never stores a job pairing (failure precedence).
      pairedDispatch(harnessDir, pairing, 'c-err4', VALID_PLANNED, 'sess-1')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-err4', name: 'subagent', agent: { id: 'sess-1' } }, { isError: true, value: { kind: 'background', jobId: 'subagent-shadow' } })
      view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error' })
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a background result WITHOUT a valid jobId records nothing — never a fabricated ok ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-background-notask-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-bg0', VALID_PLANNED)
      // `kind: 'background'` with a MISSING jobId → nothing mappable.
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-bg0', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'background' } })
      let view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch']) // no settle
      expect(pairing.dispatchByJobId.size).toBe(0)
      // `kind: 'background'` with an EMPTY jobId → nothing mappable too.
      pairedDispatch(harnessDir, pairing, 'c-bg0b', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-bg0b', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: { kind: 'background', jobId: '' } })
      view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch', 'dispatch']) // still no settle
      expect(pairing.dispatchByJobId.size).toBe(0)
      // The RETIRED upstream field name `taskId` must never key a pairing —
      // a background value carrying ONLY the old field settles nothing
      // (regression guard for the dead branch).
      pairedDispatch(harnessDir, pairing, 'c-bg0c', VALID_PLANNED, 'sess-3')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-bg0c', name: 'subagent', agent: { id: 'sess-3' } }, { isError: false, value: { kind: 'background', taskId: 'subagent-stale' } })
      view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch', 'dispatch', 'dispatch'])
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the dispatchByCallId entry is pruned once the post-execute branch resolves the call ', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-prune-callid-')
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
      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a background result stores jobId → dispatchRef and records NO settle until the onJobDone terminal', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-background-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      pairedDispatch(harnessDir, pairing, 'c-bg', VALID_PLANNED)
      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'c-bg', name: 'subagent', agent: { id: 'sess-1' } },
        { isError: false, value: { kind: 'background', jobId: 'subagent-7' } },
      )

      // The pairing store now maps the registry job id → the dispatch, and the
      // ref carries that job id as its future settle's `taskRef`.
      expect(pairing.dispatchByJobId.get('subagent-7')).toMatchObject({ role: 'fullstack-dev', planId: '00000810-agent-flow', taskRef: 'subagent-7' })
      // No settle yet — the ledger stays dispatch-only (honest).
      let view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])

      // The terminal arrives → recordJobSettle pairs and settles.
      recordJobSettle({ id: 'subagent-7', status: 'completed', startedAt: 1_000, finishedAt: 4_000 }, pairing)
      view = readAgentFlow(workflowDir)!
      expect(view.events).toHaveLength(2)
      expect(view.events[0]).toMatchObject({
        kind: 'settle',
        outcome: 'ok',
        agent: 'sess-1',
        role: 'fullstack-dev',
        planId: '00000810-agent-flow',
        taskId: 'T2',
        durationMs: 3_000,
        // The registry job id the settle paired on — a JOB key, not a child id.
        taskRef: 'subagent-7',
      })
      // No catalog join supplied a child id → the settle omits `childId`
      // (never fabricated from the job id).
      expect(view.events[0].childId).toBeUndefined()
      // The consumed job entry is pruned — the map holds only in-flight jobs.
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a continuable result records nothing (no terminal signal this round — documented limit)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-continuable-')
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
      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch']) // dispatch only
      expect(pairing.dispatchByJobId.size).toBe(0)
      // The continuable's `subagentId` is never copied onto a row: the single
      // ledger line is the dispatch, with no child identity and no task ref.
      const line = JSON.parse(readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim()) as Record<string, unknown>
      expect(line).toMatchObject({ kind: 'dispatch' })
      expect('childId' in line).toBe(false)
      expect('taskRef' in line).toBe(false)
      // The call was consumed by the branch — nothing stays paired for a settle.
      expect(pairing.dispatchByCallId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('non-dispatch tool calls record nothing (even with a paired callId)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-nondispatch-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // A callId that IS paired, but the tool name is not a dispatch tool.
      pairedDispatch(harnessDir, pairing, 'c-read', VALID_PLANNED)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-read', name: 'read_file', agent: { id: 'sess-1' } }, { isError: false, value: 'file content' })
      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an UNPAIRED dispatch-tool post-execute records nothing and warns once (honest degrade)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-settle-unpaired-')
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, {}, pairingOf())
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-nope', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: 'x' })
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-nope-2', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: 'y' })

      expect(readAgentFlow(workflowDir)).toEqual({ events: [], summary: [] }) // no record
      expect(captured).toHaveLength(2) // registration note + ONE unpaired warning
      expect(captured[1]).toContain('had no paired call key')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the pairing trace logs ONCE per logger binding, not per registration ', async () => {
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

describe('agent-flow settle — recordJobSettle terminal mapping (onJobDone)', () => {
  /** Seed one jobId → dispatchRef pairing directly. */
  function seededPairing(harnessDir: string, workflowDir: string, jobId: string, role = 'fullstack-dev'): AgentFlowPairing {
    const pairing = pairingOf()
    pairing.dispatchByJobId.set(jobId, { harnessDir, workflowDir, agent: 'sess-1', role, planId: 'plan-x', taskId: 'T2' })
    return pairing
  }

  it('completed → ok, killed → denied, failed → error; durationMs = finishedAt − startedAt when available', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-taskdone-map-')
    try {
      recordJobSettle({ id: 'subagent-1', status: 'completed', startedAt: 100, finishedAt: 700 }, seededPairing(harnessDir, workflowDir, 'subagent-1'))
      recordJobSettle({ id: 'subagent-2', status: 'killed' }, seededPairing(harnessDir, workflowDir, 'subagent-2'))
      recordJobSettle({ id: 'subagent-3', status: 'failed', startedAt: 10, finishedAt: 20 }, seededPairing(harnessDir, workflowDir, 'subagent-3'))

      const view = readAgentFlow(workflowDir)!
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

  it('an UNPAIRED job id records nothing (honest — no fabricated settlement)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-taskdone-unpaired-')
    try {
      recordJobSettle({ id: 'subagent-99', status: 'completed' }, pairingOf())
      expect(readAgentFlow(workflowDir)).toEqual({ events: [], summary: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a NON-terminal snapshot records nothing and KEEPS the pairing for the real terminal', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-taskdone-nonterminal-')
    try {
      const pairing = seededPairing(harnessDir, workflowDir, 'subagent-5')
      recordJobSettle({ id: 'subagent-5', status: 'running' }, pairing)
      expect(readAgentFlow(workflowDir)).toEqual({ events: [], summary: [] }) // no settle
      expect(pairing.dispatchByJobId.size).toBe(1) // the pairing survives
      // The later REAL terminal still settles (consumed once).
      recordJobSettle({ id: 'subagent-5', status: 'completed' }, pairing)
      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.outcome)).toEqual(['ok'])
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('agent-flow settle — child session identity (childId / taskRef)', () => {
  it('a background settle carries taskRef = the registry jobId, plus the childId the catalog join supplied', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-background-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // (a) Before any catalog join: the settle carries the registry job id as
      // `taskRef` and NO childId — the job id is a job key, never re-labelled
      // as a child session id.
      pairedDispatch(harnessDir, pairing, 'c-id-bg1', VALID_PLANNED)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-id-bg1', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'background', jobId: 'subagent-41' } })
      expect(pairing.dispatchByJobId.get('subagent-41')).toMatchObject({ taskRef: 'subagent-41' })
      recordJobSettle({ id: 'subagent-41', status: 'completed' }, pairing)
      let view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-1', taskRef: 'subagent-41' })
      expect(view.events[0].childId).toBeUndefined()

      // (b) The catalog join copies the observed catalog childId onto the SAME
      // retained ref (that seam's documented contract; simulated at the ref
      // itself, so nothing here depends on the join's own task being landed) —
      // the terminal settle then carries both identities.
      pairedDispatch(harnessDir, pairing, 'c-id-bg2', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-id-bg2', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: { kind: 'background', jobId: 'subagent-42' } })
      const ref = pairing.dispatchByJobId.get('subagent-42')!
      ref.childId = 'child-42'
      recordJobSettle({ id: 'subagent-42', status: 'completed' }, pairing)
      view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-2', taskRef: 'subagent-42', childId: 'child-42' })
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an error settle keeps a returned foreground runId (identity extraction is independent of the outcome)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-error-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // A failed call whose value still carries the foreground shape: the
      // identity is recorded, and the outcome stays `error` (never `ok`).
      pairedDispatch(harnessDir, pairing, 'c-id-err', VALID_PLANNED)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-id-err', name: 'subagent', agent: { id: 'sess-1' } }, { isError: true, error: { message: 'boom' }, value: { kind: 'foreground', runId: 'child-err', output: [] } })
      const view = readAgentFlow(workflowDir)!
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'error', childId: 'child-err' })
      // A failed value of ANOTHER shape supplies no identity (and no job pairing).
      pairedDispatch(harnessDir, pairing, 'c-id-err2', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-id-err2', name: 'subagent', agent: { id: 'sess-2' } }, { isError: true, error: { message: 'x' }, value: { kind: 'background', jobId: 'subagent-shadow' } })
      const after = readAgentFlow(workflowDir)!
      expect(after.events[0]).toMatchObject({ kind: 'settle', outcome: 'error' })
      expect(after.events[0].childId).toBeUndefined()
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the 512/513 id boundary: a 512-unit id records in full; a 513-unit id is omitted — never truncated, never re-keyed', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-length-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    const at512 = 'r'.repeat(512)
    const at513 = 'r'.repeat(513)
    const bigJob = 'j'.repeat(513)
    try {
      registerSettleListener(ctx, {}, pairing)
      // 512 (inclusive) records verbatim ...
      pairedDispatch(harnessDir, pairing, 'c-len1', VALID_PLANNED)
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-len1', name: 'subagent', agent: { id: 'sess-1' } }, { isError: false, value: { kind: 'foreground', runId: at512, output: [] } })
      // ... 513 omits the FIELD while the real completion still records.
      pairedDispatch(harnessDir, pairing, 'c-len2', VALID_PLANNED, 'sess-2')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-len2', name: 'subagent', agent: { id: 'sess-2' } }, { isError: false, value: { kind: 'foreground', runId: at513, output: [] } })
      // An over-cap background job id still KEYS the pairing by the original id
      // (nothing re-keyed) and the terminal still settles — only the
      // serialized `taskRef` is dropped.
      pairedDispatch(harnessDir, pairing, 'c-len3', VALID_PLANNED, 'sess-3')
      emitUndeclared(ctx, SETTLE_SEAM, { callId: 'c-len3', name: 'subagent', agent: { id: 'sess-3' } }, { isError: false, value: { kind: 'background', jobId: bigJob } })
      expect(pairing.dispatchByJobId.has(bigJob)).toBe(true)
      expect(pairing.dispatchByJobId.get(bigJob)!.taskRef).toBeUndefined()
      recordJobSettle({ id: bigJob, status: 'completed' }, pairing)

      const view = readAgentFlow(workflowDir)!
      // Latest first, with each dispatch row interleaved before its settle:
      // [0] settle sess-3, [1] dispatch, [2] settle sess-2, [3] dispatch,
      // [4] settle sess-1, [5] dispatch.
      expect(view.events[4]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-1', childId: at512 })
      expect(view.events[2]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-2' })
      expect(view.events[2].childId).toBeUndefined()
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', agent: 'sess-3' })
      expect(view.events[0].taskRef).toBeUndefined()
      expect(pairing.dispatchByJobId.size).toBe(0)

      // The serialized rows prove it: the 512-unit id is byte-exact, the
      // 513-unit ids produced NO key at all (a truncated copy would differ
      // from the source id).
      const parsed = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8').trim().split('\n').map((row) => JSON.parse(row) as Record<string, unknown>)
      expect(parsed).toHaveLength(6) // dispatch+settle × 3
      expect(parsed[1].childId).toBe(at512)
      expect('childId' in parsed[3]).toBe(false)
      expect('childId' in parsed[5]).toBe(false)
      expect('taskRef' in parsed[5]).toBe(false)
      const raw = readFileSync(join(workflowDir, AGENT_FLOW_FILE), 'utf8')
      expect(raw).not.toContain(at513)
      expect(raw).not.toContain(bigJob)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('malformed / legacy v1 settle rows read back with the new fields omitted — never a throw', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-identity-legacy-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      await writeFile(file, [
        // A legacy v1 settle written before either field existed.
        settleLine(),
        // Malformed optionals: empty string + non-string.
        settleLine({ outcome: 'error', childId: '', taskRef: 42 }),
        // Oversized optionals — dropped as fields, never truncated.
        settleLine({ outcome: 'denied', childId: 'c'.repeat(513), taskRef: 't'.repeat(513) }),
        // Valid identities plus an UNKNOWN key (ignored by the narrowing).
        settleLine({ outcome: 'ok', childId: 'child-ok', taskRef: 'job-1', futureKey: { nested: true } }),
      ].join('\n') + '\n')

      const view = readAgentFlow(workflowDir)
      expect(view!.events).toHaveLength(4) // every row stayed readable
      const [valid, oversized, malformed, legacy] = view!.events // latest first
      expect(valid).toMatchObject({ kind: 'settle', outcome: 'ok', childId: 'child-ok', taskRef: 'job-1' })
      // A child id is NOT the pairing identity: these rows carry no `role`, so
      // they stay unpaired even with a childId present.
      expect(valid.paired).toBeUndefined()
      expect(oversized.childId).toBeUndefined()
      expect(oversized.taskRef).toBeUndefined()
      expect(malformed.childId).toBeUndefined()
      expect(malformed.taskRef).toBeUndefined()
      expect(legacy.childId).toBeUndefined()
      expect(legacy.taskRef).toBeUndefined()
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

  it('a dispatch through the real composition invalidates the catalog cache — the workflow-dir ledger change is visible at the next pre-step within the REAL TTL (apply-bound wiring, Task 2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-invalidator-wiring-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    // REAL TTL (default 60000): the event can only be visible at the first
    // pre-step if the record invalidated the boot-seeded cache entry.
    const app = booted = await bootApp({ root, dispatchBinding: 'qc-specialist' })
    // Dispatch BEFORE any pre-step: only the apply-time pre-registration of
    // the explicit-config reverse map makes the boot-seeded entry
    // invalidatable here — a no-op binding (Task 1 state) or a missing
    // pre-registration would leave the stale boot build visible within the TTL.
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })

    // Final-state (Task 2 writer cutover): the dispatch record itself lands
    // in the ACTIVE workflow dir — the catalog reads the SAME file, so the
    // invalidation observable is the record's own line (no out-of-band write).
    const step = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(step)
    // The payload is not persisted on the row, so the row's OWN rendered text
    // — produced from the payload the listener used — is the invalidation
    // observable (a stale boot build would render no agent-flow line).
    expect(textOf(row)).toContain('agent flow: 1 events')
    expect(textOf(row)).toContain('by role: fullstack-dev 1')
  })
})

/* ===========================================================================
 * 4b. Upstream seam probes (plan  T1 Step 1 —
 *     prove the seams BEFORE writing the pairing): the REAL dsh-tools
 *     registry emits `tools/post-execute` for every tool call
 *     (`runPostExecute` pipeline), and `ctx.jobs.onJobDone` is registrable
 *     via `ctx.inject(['jobs'])` and receives terminal snapshots.
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
      callId: 'probe-1' as ToolCallId,
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

describe('upstream seam probe — ctx.inject([\'jobs\']) onJobDone wiring (T1 Step 1)', () => {
  it('registers against a provided jobs service and receives a terminal snapshot — full chain dispatch → background → terminal → settle', async () => {
    const app = booted = await bootApp({ jobsService: 'fake', seedV2: true })
    // A dispatch tool returning the VERIFIED background shape (canonical
    // `{ kind: 'background', jobId }` — the upstream dsh-tool-subagent
    // output schema) so the post-execute branch stores jobId → dispatchRef.
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
            jobId: { type: 'string', required: true },
          },
        },
        render: (_args: unknown, value: { kind: 'background'; jobId: string }) =>
          [{ type: 'text', text: `started background subagent job ${value.jobId}` }],
      },
      execute: async () => ({ kind: 'background' as const, jobId: 'subagent-1' }),
    }))

    const result = await app.ctx.tools.execute({
      callId: 'bg-1' as ToolCallId,
      name: 'subagent',
      arguments: { description: 'probe', prompt: VALID_PLANNED },
      agent: { id: 'probe-agent' } as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)

    // Dispatch recorded; background → NO settle yet (the terminal is pending).
    let view = readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))!
    expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])

    // Fire the terminal through the onJobDone listener the plugin's
    // `ctx.inject(['jobs'])` wiring registered on the fake jobs service.
    const jobs = app.ctx.jobs as unknown as FakeJobRegistry
    jobs.fireDone({
      id: JobId('subagent-1'),
      kind: 'subagent',
      label: 'probe',
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 2_500,
      reported: true,
    })

    view = readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))!
    expect(view.events).toHaveLength(2)
    expect(view.events[0]).toMatchObject({
      kind: 'settle',
      outcome: 'ok',
      agent: 'probe-agent',
      role: 'fullstack-dev',
      planId: '00000810-agent-flow',
      taskId: 'T2',
      durationMs: 1_500,
    })
  })

  it('the inject wiring is INERT without a jobs service (the plugin boots fine)', async () => {
    // bootApp WITHOUT jobsService: the deferred `ctx.inject(['jobs'])` child
    // fiber simply never activates — the plugin apply and the dispatch gate
    // work normally (no top-level `'jobs'` inject blocking boot).
    const app = booted = await bootApp({ seedV2: true })
    const decision = await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    expect(decision).toEqual({ kind: 'allow' })
    const view = readAgentFlow(join(app.harnessDir, 'workflows/wf-1'))!
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
  if (source.kind !== 'plugin' || source.plugin !== 'mstar-engine') throw new Error('missing catalog row')
  return { row, source: source as MstarEngineStatusSource }
}

/** The model-facing text of a catalog row. */
function textOf(row: UserMessage): string {
  return row.content[0]?.type === 'text' ? row.content[0].text : ''
}

/* ===========================================================================
 * 5. Catalog integration — state.agentFlow + compact model line
 * ========================================================================== */

describe('agent-flow catalog — state.agentFlow evidence + render', () => {
  /** Seed a v2 tree with one active workflow (`wf-1`) and return the harness dir. */
  async function seedV2Tree(root: string): Promise<string> {
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': v2Root([v2WorkflowEntry('wf-1')]),
      'workflows/wf-1/snapshot.json': v2Snapshot('wf-1'),
    })
    return harnessDir
  }

  it('ledger events surface as state.agentFlow; the model text gains ONE compact line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-'))
    const harnessDir = await seedV2Tree(root)
    // Seeded BEFORE boot: the explicit-config catalog cache is pre-built at
    // apply(), so the boot-time source carries the ledger (spec §2.2 TTL
    // cycle). v3: the ledger lives in the SELECTED workflow dir.
    await seedHarness(harnessDir, {
      'workflows/wf-1/agent-flow.jsonl': `${dispatchLine()}\n${settleLine()}\n`,
    })
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const { row } = catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    // Structured evidence: events (latest first) + summary over the window.
    expect(payload.state).not.toBeNull()
    const flow = payload.state!.agentFlow!
    expect(flow.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
    expect(flow.events[1]).toMatchObject({
      kind: 'dispatch',
      agent: 'a1',
      role: 'fullstack-dev',
      planId: '00000810-x',
      taskId: 'T2',
      verdict: 'ok',
    })
    expect(flow.summary).toEqual([
      { role: '', outcome: 'ok', count: 1 },
      { role: 'fullstack-dev', outcome: 'ok', count: 1 },
    ])

    // Compact model line (the event detail lives in the structured source only).
    const text = textOf(row)
    expect(text).toContain('agent flow: 2 events; by role: fullstack-dev 1; latest: fullstack-dev→00000810-x#T2 ')
    expect(text.split('\n').filter((l) => l.startsWith('agent flow:')).length).toBe(1)
  })

  it('the model line reports dispatch ACTIVITY only — a subagent-link identity row never inflates the by-role totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-link-role-'))
    const harnessDir = await seedV2Tree(root)
    await seedHarness(harnessDir, {
      'workflows/wf-1/agent-flow.jsonl': `${dispatchLine()}\n${linkLine()}\n${settleLine()}\n`,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    // The structured source KEEPS the link as its own role×outcome bucket
    // (the identity evidence stays available to machine consumers)…
    expect(payload.state!.agentFlow!.summary).toEqual([
      { role: '', outcome: 'ok', count: 1 },
      { role: 'fullstack-dev', outcome: 'ok', count: 1 },
      { role: 'fullstack-dev', outcome: 'subagent-link', count: 1 },
    ])
    // …while the model-facing role totals count the one dispatch (and the one
    // settle) only — the link row is identity, not dispatch activity.
    const text = textOf(row)
    expect(text).toContain('agent flow: 3 events')
    expect(text).toContain('by role: fullstack-dev 1')
    expect(text).not.toContain('fullstack-dev 2')
  })

  it('no ledger → state.agentFlow is the EMPTY view and NO agent-flow line (missing file reads as empty, not null)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-none-'))
    const harnessDir = await seedV2Tree(root)
    // state is gated on status.json — seed it so the state section exists
    // with an absent workflow-dir ledger (the missing-file empty view under
    // test).
    const app = booted = await bootApp({ root })
    const inbox = [inboxMessage()]
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
    const { row } = catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    expect(payload.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
  })

  it('a full 50-event window renders the model-line window marker ("N events (latest 50)")', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-window-'))
    const harnessDir = await seedV2Tree(root)
    const lines: string[] = []
    for (let i = 0; i < 55; i += 1) lines.push(dispatchLine({ ts: 1_700_000_000_000 + i }))
    await seedHarness(harnessDir, {
      'workflows/wf-1/agent-flow.jsonl': `${lines.join('\n')}\n`,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    expect(payload.state!.agentFlow!.events).toHaveLength(50)
    expect(textOf(row)).toContain('agent flow: 50 events (latest 50)')
  })

  it('zero events (malformed-only ledger) → no agent-flow line, state stays present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-empty-'))
    const harnessDir = await seedV2Tree(root)
    await seedHarness(harnessDir, {
      'workflows/wf-1/agent-flow.jsonl': 'not json\n{{{ broken\n',
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    expect(payload.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
  })

  it('the agentFlow view carries no undefined-valued keys (Session.append lossless JSON)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-omit-'))
    const harnessDir = await seedV2Tree(root)
    await seedHarness(harnessDir, {
      'workflows/wf-1/agent-flow.jsonl': `${dispatchLine()}\n${settleLine({ durationMs: undefined })}\n`,
    })
    const app = booted = await bootApp({ root })
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    catalogRowOf(decision)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    const payloadRecord = payload as unknown as Record<string, unknown>
    expect(Object.values(payloadRecord).every((v) => v !== undefined)).toBe(true)
    const state = payload.state as unknown as Record<string, unknown>
    expect(Object.values(state).every((v) => v !== undefined)).toBe(true)
    const flow = state.agentFlow as { events: Array<Record<string, unknown>> }
    for (const event of flow.events) {
      expect(Object.values(event).every((v) => v !== undefined)).toBe(true)
    }
  })

  it('a mid-session dispatch lands in the catalog within one TTL (catalogTtlMs: 0 → immediate refresh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-agentflow-catalog-ttl-'))
    const harnessDir = await seedV2Tree(root)
    const app = booted = await bootApp({ root, catalogTtlMs: 0, dispatchBinding: 'qc-specialist' })
    // First pre-step: no events yet.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    catalogRowOf(first)
    // Dispatch one event through the real composition (the record path fires
    // the apply-bound invalidator AND lands the event in the ACTIVE workflow
    // dir — the catalog reads the SAME file, final-state Task 2 writer).
    await app.ctx.waterfall('tools/pre-execute', subagentExec(VALID_PLANNED), defaultAllow)
    // Second pre-step: TTL 0 forces a rebuild → the event is visible.
    const second = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { row } = catalogRowOf(second)
    const payload = buildCatalogPayload(app.ctx, harnessDir)

    expect(payload.state!.agentFlow?.events).toHaveLength(1)
    expect(payload.state!.agentFlow?.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok' })
    expect(textOf(row)).toContain('agent flow: 1 events')
  })
})

/* ===========================================================================
 * 6. Call-window catalog join — the nonterminal `subagent-link` row
 *    (child session identity: reserve → eligibility → catch-up/live → consume)
 * ========================================================================== */

/**
 * One structural live-Session stand-in exposing EXACTLY the verified surface
 * the join reads (`id` / `seq` / `eventAt`) — never an `.events` member,
 * which a real Session does not have (the reason the join walks
 * `eventAt(seq)` over a bounded window instead of copying a log).
 */
interface CatalogSessionStub {
  readonly id: string
  readonly seq: number
  /** The verified append contract: the envelope's `seq` is the log length BEFORE the push. */
  append(type: string, data: unknown): CatalogEnvelopeStub
  eventAt(seq: number): unknown
}

/** One structural session-log envelope (`{type, seq, time, data}`). */
interface CatalogEnvelopeStub {
  type: string
  seq: number
  time: number
  data: unknown
}

/**
 * Build one such stand-in. `seed` events are placed at the log positions
 * they occupy BEFORE any live append — a constructor-seeded log (they are
 * never replayed on the firehose, exactly like a real seeded Session).
 */
function catalogSession(id: string, seed: CatalogEnvelopeStub[] = []): CatalogSessionStub {
  const log: CatalogEnvelopeStub[] = [...seed]
  return {
    id,
    get seq(): number {
      return log.length
    },
    append(type: string, data: unknown): CatalogEnvelopeStub {
      const envelope: CatalogEnvelopeStub = { type, seq: log.length, time: Date.now(), data }
      log.push(envelope)
      return envelope
    },
    eventAt(seq: number): unknown {
      return log[seq]
    },
  }
}

/** Epoch ms the catalog payload reports as the child's creation time (validated, never a ledger clock). */
const CATALOG_CHILD_CREATED_AT = 1_780_000_000_001

/** One verified v0 `subagent/catalog` payload (`label` = the delegation description). */
function catalogPayload(childId: string, label: string, mode: 'one-shot' | 'continuable' = 'continuable'): Record<string, unknown> {
  return { version: 0, childId, childCreatedAt: CATALOG_CHILD_CREATED_AT, mode, label }
}

/** A dispatch exec carrying the live parent Session + the raw delegation label (the join's step-1 seam). */
function catalogExec(callId: string, agent: string, session: CatalogSessionStub, description: string): ToolExecution {
  return {
    callId: callId as ToolExecution['callId'],
    name: 'subagent',
    arguments: { description, prompt: VALID_PLANNED },
    agent: { id: agent, session } as never,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** Record one dispatch whose exec carries the live Session + raw label (reserving its catalog slot). */
function catalogDispatch(harnessDir: string, pairing: AgentFlowPairing, callId: string, agent: string, session: CatalogSessionStub, description: string): void {
  recordDispatch({ harnessDir, exec: catalogExec(callId, agent, session, description), prompt: VALID_PLANNED, violations: [], hard: false, pairing })
}

/** Post-execute one catalog-capable dispatch call (the eligibility seam). */
function emitPostExecute(ctx: Context, session: CatalogSessionStub, callId: string, agent: string, result: unknown): void {
  emitUndeclared(ctx, SETTLE_SEAM, { callId, name: 'subagent', agent: { id: agent, session } }, result)
}

/** Emit one live `session/event` firehose envelope (carrier-first — the real store's dispatch shape). */
function emitSessionEvent(ctx: Context, session: CatalogSessionStub, envelope: unknown): void {
  ctx.events.emit({}, 'session/event', session, envelope)
}

/** The raw ledger rows of one workflow dir, oldest first (parsed JSONL). */
function ledgerRows(workflowDir: string): Array<Record<string, unknown>> {
  const file = join(workflowDir, AGENT_FLOW_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The `subagent-link` rows of one workflow dir, oldest first. */
function linkRows(workflowDir: string): Array<Record<string, unknown>> {
  return ledgerRows(workflowDir).filter((row) => row.kind === 'subagent-link')
}

describe('agent-flow subagent-link — call-window catalog join', () => {
  it('links a continuable child whose catalog was appended BEFORE post-execute (the required call-window catch-up)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-early-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-early')
      catalogDispatch(harnessDir, pairing, 'c-early', 'sess-early', session, 'ship the widget')

      // The tool body appends the catalog and only THEN returns — the
      // continuable path necessarily does (the append precedes the return).
      session.append('subagent/catalog', catalogPayload('child-early', 'ship the widget'))

      emitPostExecute(ctx, session, 'c-early', 'sess-early', { isError: false, value: { kind: 'continuable', subagentId: 'child-early' } })

      const rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'subagent-link'])
      const link = rows[1]!
      expect(link).toMatchObject({
        v: 1,
        kind: 'subagent-link',
        childId: 'child-early',
        label: 'ship the widget',
        role: 'fullstack-dev',
        planId: '00000810-agent-flow',
        taskId: 'T2',
      })
      // A link is NOT a completion: no outcome/verdict/paired marker, and a
      // continuable link carries no registry job reference.
      expect('outcome' in link).toBe(false)
      expect('verdict' in link).toBe(false)
      expect('paired' in link).toBe(false)
      expect('taskRef' in link).toBe(false)
      expect(Object.values(link).every((value) => value !== undefined)).toBe(true)
      // The observed child id was copied onto the retained dispatch ref.
      expect(pairing.dispatchByCallId.size).toBe(0) // the call was consumed
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('links a LATE live catalog (background one-shot) and the later job terminal carries the child id into its settle', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-late-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-late')
      catalogDispatch(harnessDir, pairing, 'c-late', 'sess-late', session, 'run the batch job')

      emitPostExecute(ctx, session, 'c-late', 'sess-late', { isError: false, value: { kind: 'background', jobId: 'subagent-9' } })
      // Eligible but no catalog yet — nothing is fabricated at eligibility.
      expect(ledgerRows(workflowDir).map((row) => row.kind)).toEqual(['dispatch'])

      // The one-shot catalog arrives later, on the live firehose.
      const envelope = session.append('subagent/catalog', catalogPayload('child-bg', 'run the batch job', 'one-shot'))
      emitSessionEvent(ctx, session, envelope)

      let rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'subagent-link'])
      expect(rows[1]).toMatchObject({ kind: 'subagent-link', childId: 'child-bg', label: 'run the batch job', taskRef: 'subagent-9' })

      // The SAME ref object was in flight for the job: the terminal settle
      // now carries the child identity the link supplied.
      recordJobSettle({ id: 'subagent-9', status: 'completed', startedAt: 10, finishedAt: 30 }, pairing)
      rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'subagent-link', 'settle'])
      expect(rows[2]).toMatchObject({ kind: 'settle', outcome: 'ok', childId: 'child-bg', taskRef: 'subagent-9', role: 'fullstack-dev' })
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminal-before-link: a settle that already consumed the job entry still gets its link, and keeps no fabricated childId', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-reverse-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-reverse')
      catalogDispatch(harnessDir, pairing, 'c-rev', 'sess-reverse', session, 'reverse order')

      emitPostExecute(ctx, session, 'c-rev', 'sess-reverse', { isError: false, value: { kind: 'background', jobId: 'subagent-rev' } })
      // The terminal lands BEFORE any catalog: the settle records the real
      // completion and consumes the job pairing.
      recordJobSettle({ id: 'subagent-rev', status: 'completed' }, pairing)
      let rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'settle'])
      expect('childId' in rows[1]!).toBe(false)

      // The catalog arrives afterwards — the pending candidate still owns the
      // ref and writes the identity independently.
      const envelope = session.append('subagent/catalog', catalogPayload('child-rev', 'reverse order', 'one-shot'))
      emitSessionEvent(ctx, session, envelope)
      rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'settle', 'subagent-link'])
      expect(rows[2]).toMatchObject({ kind: 'subagent-link', childId: 'child-rev', label: 'reverse order', taskRef: 'subagent-rev' })
      expect(pairing.dispatchByJobId.size).toBe(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a duplicate label never marks a different dispatch eligible — the FIRST reserved dispatch owns the slot', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-duplicate-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-dup')
      catalogDispatch(harnessDir, pairing, 'c-first', 'sess-dup', session, 'shared description')
      catalogDispatch(harnessDir, pairing, 'c-second', 'sess-dup', session, 'shared description')
      expect(pairing.catalogBySession.get(session)!.size).toBe(1)

      // The FIRST dispatch is the background one; the second is continuable.
      emitPostExecute(ctx, session, 'c-first', 'sess-dup', { isError: false, value: { kind: 'background', jobId: 'subagent-dup' } })
      emitPostExecute(ctx, session, 'c-second', 'sess-dup', { isError: false, value: { kind: 'continuable', subagentId: 'child-second' } })

      // A continuable catalog naming the SECOND dispatch's child matches no
      // slot: the first dispatch owns the label and expects a one-shot.
      const wrongMode = session.append('subagent/catalog', catalogPayload('child-second', 'shared description', 'continuable'))
      emitSessionEvent(ctx, session, wrongMode)
      expect(linkRows(workflowDir)).toHaveLength(0)

      // The first dispatch's own one-shot catalog links, carrying its job ref.
      const right = session.append('subagent/catalog', catalogPayload('child-first', 'shared description', 'one-shot'))
      emitSessionEvent(ctx, session, right)
      const links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ childId: 'child-first', label: 'shared description', taskRef: 'subagent-dup' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cross-session isolation: one label on two live sessions links each session its own dispatch', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-crosssession-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const sessionA = catalogSession('sess-A')
      const sessionB = catalogSession('sess-B')
      catalogDispatch(harnessDir, pairing, 'c-A', 'sess-A', sessionA, 'parallel work')
      catalogDispatch(harnessDir, pairing, 'c-B', 'sess-B', sessionB, 'parallel work')
      expect(pairing.catalogBySession.get(sessionA)!.size).toBe(1)
      expect(pairing.catalogBySession.get(sessionB)!.size).toBe(1)

      emitPostExecute(ctx, sessionA, 'c-A', 'sess-A', { isError: false, value: { kind: 'continuable', subagentId: 'child-A' } })
      emitPostExecute(ctx, sessionB, 'c-B', 'sess-B', { isError: false, value: { kind: 'continuable', subagentId: 'child-B' } })

      const envelopeB = sessionB.append('subagent/catalog', catalogPayload('child-B', 'parallel work'))
      emitSessionEvent(ctx, sessionB, envelopeB)
      let links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ childId: 'child-B', agent: 'sess-B' })

      const envelopeA = sessionA.append('subagent/catalog', catalogPayload('child-A', 'parallel work'))
      emitSessionEvent(ctx, sessionA, envelopeA)
      links = linkRows(workflowDir)
      expect(links).toHaveLength(2)
      expect(links.map((row) => row.agent)).toEqual(['sess-B', 'sess-A'])
      expect(links.map((row) => row.childId)).toEqual(['child-B', 'child-A'])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects every malformed / out-of-window / mismatched catalog, then still links the valid one (the matcher stays live)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-matcher-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      // One pre-existing (seeded) log entry puts the window start at seq 1.
      const seeded: CatalogEnvelopeStub = { type: 'session/start-seed', seq: 0, time: 1, data: { inherited: true } }
      const session = catalogSession('sess-matcher', [seeded])
      catalogDispatch(harnessDir, pairing, 'c-match', 'sess-matcher', session, 'matcher drill')
      emitPostExecute(ctx, session, 'c-match', 'sess-matcher', { isError: false, value: { kind: 'continuable', subagentId: 'child-ok' } })

      const label = 'matcher drill'
      const payload = catalogPayload('child-ok', label)
      const fire = (overrides: Partial<CatalogEnvelopeStub>): void => {
        emitSessionEvent(ctx, session, { type: 'subagent/catalog', seq: 1, time: 1, data: payload, ...overrides })
      }
      fire({ type: 'session/other' }) // wrong event type
      fire({ data: { ...payload, version: 1 } }) // wrong payload version
      fire({ time: Number.NaN }) // non-finite envelope time
      fire({ data: { ...payload, childCreatedAt: -1 } }) // negative creation time
      fire({ data: { ...payload, childCreatedAt: 1.5 } }) // non-integer creation time
      fire({ data: { ...payload, childId: 'x'.repeat(513) } }) // oversized child id
      fire({ data: { ...payload, childId: 'child-other' } }) // returned-child mismatch
      fire({ data: { ...payload, label: 'another description' } }) // label mismatch
      fire({ data: { ...payload, mode: 'one-shot' } }) // wrong mode for a continuable result
      fire({ seq: 0 }) // below the captured window start
      fire({ seq: session.seq + 4 }) // beyond the live session bound
      expect(linkRows(workflowDir)).toHaveLength(0)

      // The capability control: the same matcher path still links the valid
      // catalog appended by the tool body (recovered by the catch-up walk).
      const good = session.append('subagent/catalog', catalogPayload('child-ok', label))
      emitSessionEvent(ctx, session, good)
      const links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ childId: 'child-ok', label })
      // Consumed once — a repeated delivery of the same envelope adds nothing.
      emitSessionEvent(ctx, session, good)
      expect(linkRows(workflowDir)).toHaveLength(1)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a catalog that predates the apply window (a constructor seed) never owns a same-label dispatch — a live append on that session does', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-seed-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      // The seed carries the SAME label and the SAME child id the dispatch
      // will report, so only provenance can explain a negative.
      const seed: CatalogEnvelopeStub = { type: 'subagent/catalog', seq: 0, time: 5, data: catalogPayload('child-seed', 'seeded delegation') }
      const session = catalogSession('sess-seeded', [seed])
      expect(session.seq).toBe(1) // the seed sits below the live frontier
      catalogDispatch(harnessDir, pairing, 'c-seed', 'sess-seeded', session, 'seeded delegation')
      emitPostExecute(ctx, session, 'c-seed', 'sess-seeded', { isError: false, value: { kind: 'continuable', subagentId: 'child-seed' } })

      // The catch-up window is [1, 1) — the seeded catalog is unreachable.
      expect(linkRows(workflowDir)).toHaveLength(0)
      expect(pairing.catalogBySession.get(session)!.get('seeded delegation')?.result).toEqual({ kind: 'continuable', subagentId: 'child-seed' })

      // Positive control: a genuine live append on the SAME session with the
      // SAME label reaches the live observer and is consumed.
      const live = session.append('subagent/catalog', catalogPayload('child-seed', 'seeded delegation'))
      emitSessionEvent(ctx, session, live)
      const links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ childId: 'child-seed', label: 'seeded delegation' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits no candidate for a label that sanitizes to nothing or is oversized (the key is never truncated)', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-label-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-label')

      // Control-char-only label: no identity → no slot.
      catalogDispatch(harnessDir, pairing, 'c-sani', 'sess-label', session, '\u0000\u001f\u007f')
      expect(pairing.catalogBySession.has(session)).toBe(false)

      // Oversized label: never truncated into a different key → no slot.
      const oversized = 'd'.repeat(1025)
      catalogDispatch(harnessDir, pairing, 'c-long', 'sess-label', session, oversized)
      expect(pairing.catalogBySession.has(session)).toBe(false)

      // A 1024-unit label IS admitted, and its row carries the capped DISPLAY
      // label while the join compared the raw one.
      const long = `${'d'.repeat(600)}!`
      catalogDispatch(harnessDir, pairing, 'c-display', 'sess-label', session, long)
      emitPostExecute(ctx, session, 'c-display', 'sess-label', { isError: false, value: { kind: 'continuable', subagentId: 'child-display' } })
      const envelope = session.append('subagent/catalog', catalogPayload('child-display', long))
      emitSessionEvent(ctx, session, envelope)
      const links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      const written = links[0]!.label as string
      expect(written).toBe(`${'d'.repeat(511)}${WORKFLOW_LEDGER_TRUNCATION_MARKER}`)
      expect(links[0]!.childId).toBe('child-display')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses NEW labels at capacity (500 slots per Session) while existing labels keep working — the refusal warns once', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-cap-')
    const pairing = pairingOf()
    const ctx = new Context()
    const captured: Array<{ level: string; message: string }> = []
    const priorSink = setAgentFlowLogger((level, message) => { captured.push({ level, message }) })
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)

      const full = new Map<string, AgentFlowCatalogJoin | null>()
      for (let i = 0; i < AGENT_FLOW_MAX_EVENTS; i += 1) full.set(`filler-${i}`, null)
      const sessionFull = catalogSession('sess-full')
      pairing.catalogBySession.set(sessionFull, full)
      catalogDispatch(harnessDir, pairing, 'c-full', 'sess-full', sessionFull, 'one too many')
      emitPostExecute(ctx, sessionFull, 'c-full', 'sess-full', { isError: false, value: { kind: 'continuable', subagentId: 'child-full' } })
      const envelopeFull = sessionFull.append('subagent/catalog', catalogPayload('child-full', 'one too many'))
      emitSessionEvent(ctx, sessionFull, envelopeFull)
      expect(linkRows(workflowDir)).toHaveLength(0)

      // The saturated refusal announces itself: ONE bounded warn carrying the
      // parent session identity and the cap — the silent-degradation defect.
      const capacityWarnings = captured.filter((entry) => entry.level === 'warn' && entry.message.includes('catalog slot'))
      expect(capacityWarnings).toHaveLength(1)
      expect(capacityWarnings[0]!.message).toContain('sess-full')
      expect(capacityWarnings[0]!.message).toContain(String(AGENT_FLOW_MAX_EVENTS))

      // A SECOND distinct label on the same saturated session is refused too —
      // the warn is latched (one line per apply, not one per refusal).
      catalogDispatch(harnessDir, pairing, 'c-full-2', 'sess-full', sessionFull, 'another one too many')
      expect(captured.filter((entry) => entry.level === 'warn' && entry.message.includes('catalog slot'))).toHaveLength(1)
      expect(pairing.catalogBySession.get(sessionFull)!.size).toBe(AGENT_FLOW_MAX_EVENTS)

      // One slot below the cap, the same flow links — the refusal is the
      // capacity rule, not a broken join. The retained tombstones stay put.
      const roomy = new Map<string, AgentFlowCatalogJoin | null>()
      for (let i = 0; i < AGENT_FLOW_MAX_EVENTS - 1; i += 1) roomy.set(`filler-${i}`, null)
      const sessionRoomy = catalogSession('sess-roomy')
      pairing.catalogBySession.set(sessionRoomy, roomy)
      catalogDispatch(harnessDir, pairing, 'c-roomy', 'sess-roomy', sessionRoomy, 'one too many')
      emitPostExecute(ctx, sessionRoomy, 'c-roomy', 'sess-roomy', { isError: false, value: { kind: 'continuable', subagentId: 'child-roomy' } })
      const envelopeRoomy = sessionRoomy.append('subagent/catalog', catalogPayload('child-roomy', 'one too many'))
      emitSessionEvent(ctx, sessionRoomy, envelopeRoomy)
      const links = linkRows(workflowDir)
      expect(links).toHaveLength(1)
      expect(links[0]).toMatchObject({ childId: 'child-roomy' })
      expect(pairing.catalogBySession.get(sessionFull)!.size).toBe(AGENT_FLOW_MAX_EVENTS)
      // The roomy session did NOT saturate — no second warn.
      expect(captured.filter((entry) => entry.level === 'warn' && entry.message.includes('catalog slot'))).toHaveLength(1)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a failed call, a foreground call, and an unpaired call each admit no link — never a fabricated identity', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-negative-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-neg')

      // Failed call → error settle, candidate retired.
      catalogDispatch(harnessDir, pairing, 'c-fail', 'sess-neg', session, 'fails outright')
      emitPostExecute(ctx, session, 'c-fail', 'sess-neg', { isError: true, error: { message: 'boom' } })
      const failedEnvelope = session.append('subagent/catalog', catalogPayload('child-fail', 'fails outright'))
      emitSessionEvent(ctx, session, failedEnvelope)
      expect(linkRows(workflowDir)).toHaveLength(0)
      expect(ledgerRows(workflowDir).map((row) => row.kind)).toEqual(['dispatch', 'settle'])

      // Foreground call → immediate settle, no join (its own runId is the identity).
      catalogDispatch(harnessDir, pairing, 'c-fg', 'sess-neg', session, 'synchronous work')
      emitPostExecute(ctx, session, 'c-fg', 'sess-neg', { isError: false, value: { kind: 'foreground', runId: 'run-fg', output: [] } })
      const fgEnvelope = session.append('subagent/catalog', catalogPayload('child-fg', 'synchronous work'))
      emitSessionEvent(ctx, session, fgEnvelope)
      expect(linkRows(workflowDir)).toHaveLength(0)
      const fgSettle = ledgerRows(workflowDir).filter((row) => row.kind === 'settle').at(-1)!
      expect(fgSettle).toMatchObject({ outcome: 'ok', childId: 'run-fg' })

      // Unpaired post-execute (no recorded call) → nothing, and no throw.
      expect(() => emitPostExecute(ctx, session, 'c-unknown', 'sess-neg', { isError: false, value: { kind: 'continuable', subagentId: 'child-x' } })).not.toThrow()
      expect(linkRows(workflowDir)).toHaveLength(0)

      // A malformed result payload (no `value` at all) retires too.
      catalogDispatch(harnessDir, pairing, 'c-noval', 'sess-neg', session, 'no payload')
      emitPostExecute(ctx, session, 'c-noval', 'sess-neg', { isError: false })
      const noValEnvelope = session.append('subagent/catalog', catalogPayload('child-noval', 'no payload'))
      emitSessionEvent(ctx, session, noValEnvelope)
      expect(linkRows(workflowDir)).toHaveLength(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains a failing link append (logged, never thrown) and never retries the consumed candidate', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-contained-')
    const pairing = pairingOf()
    const ctx = new Context()
    const captured: string[] = []
    const priorSink = setAgentFlowLogger((_level, message) => { captured.push(message) })
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-contained')
      catalogDispatch(harnessDir, pairing, 'c-cnt', 'sess-contained', session, 'unwritable ledger')
      emitPostExecute(ctx, session, 'c-cnt', 'sess-contained', { isError: false, value: { kind: 'continuable', subagentId: 'child-cnt' } })

      // Break the ledger slot AFTER the dispatch row landed: a DIRECTORY at
      // the file path makes the link append fail (EISDIR).
      const file = join(workflowDir, AGENT_FLOW_FILE)
      await rm(file)
      await mkdir(file)
      const envelope = session.append('subagent/catalog', catalogPayload('child-cnt', 'unwritable ledger'))
      expect(() => emitSessionEvent(ctx, session, envelope)).not.toThrow()
      expect(captured.some((message) => message.includes('subagent-link record failed (contained)'))).toBe(true)

      // The candidate was consumed BEFORE the append attempt: restoring the
      // file and re-delivering the same catalog writes no second row.
      await rm(file, { recursive: true })
      await writeFile(file, '')
      emitSessionEvent(ctx, session, envelope)
      expect(linkRows(workflowDir)).toHaveLength(0)
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a throwing catch-up eventAt is contained, logged once as warn, and later readable positions still link', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-unread-')
    const pairing = pairingOf()
    const ctx = new Context()
    const captured: Array<{ level: string; message: string }> = []
    const priorSink = setAgentFlowLogger((level, message) => { captured.push({ level, message }) })
    try {
      registerSettleListener(ctx, {}, pairing)
      const session = catalogSession('sess-unread')
      const eventAt = session.eventAt.bind(session)
      session.eventAt = (seq: number): unknown => {
        if (seq === 0 || seq === 1) throw new Error(`unreadable catalog position ${seq}`)
        return eventAt(seq)
      }
      catalogDispatch(harnessDir, pairing, 'c-unread', 'sess-unread', session, 'unreadable window')

      // Two unreadable positions, then a valid catalog — the walk must
      // continue past the throws and still consume the later match.
      session.append('session/noise', { noise: true })
      session.append('session/noise', { noise: true })
      session.append('subagent/catalog', catalogPayload('child-unread', 'unreadable window'))

      expect(() => emitPostExecute(ctx, session, 'c-unread', 'sess-unread', { isError: false, value: { kind: 'continuable', subagentId: 'child-unread' } })).not.toThrow()

      const rows = ledgerRows(workflowDir)
      expect(rows.map((row) => row.kind)).toEqual(['dispatch', 'subagent-link'])
      expect(rows[1]).toMatchObject({ kind: 'subagent-link', childId: 'child-unread', label: 'unreadable window' })
      expect(pairing.catalogBySession.get(session)!.get('unreadable window')).toBeNull()

      const warnings = captured.filter((entry) => entry.level === 'warn' && entry.message.includes('unreadable'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.message).toContain('sess-unread')
      expect(warnings[0]!.message).toContain('seq 0')
      expect(warnings[0]!.message).toContain('2 unreadable')
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('attributes the link to the DISPATCH workflow dir even after the active set moved', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-move-')
    const pairing = pairingOf()
    const ctx = new Context()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      registerSubagentCatalogListener(ctx, pairing)
      const session = catalogSession('sess-move')
      catalogDispatch(harnessDir, pairing, 'c-mv', 'sess-move', session, 'moved active set')
      emitPostExecute(ctx, session, 'c-mv', 'sess-move', { isError: false, value: { kind: 'continuable', subagentId: 'child-mv' } })
      // The active set moves to wf-2 BEFORE the catalog arrives.
      await seedHarness(harnessDir, {
        'status.json': v2Root([v2WorkflowEntry('wf-2')]),
        'workflows/wf-2/snapshot.json': v2Snapshot('wf-2'),
      })
      const envelope = session.append('subagent/catalog', catalogPayload('child-mv', 'moved active set'))
      emitSessionEvent(ctx, session, envelope)

      expect(ledgerRows(workflowDir).map((row) => row.kind)).toEqual(['dispatch', 'subagent-link'])
      expect(readAgentFlow(join(harnessDir, 'workflows/wf-2'))!.events).toEqual([])
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects a link without completion markers, buckets it separately, and still reads legacy rows', async () => {
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-agentflow-link-read-')
    try {
      const file = join(workflowDir, AGENT_FLOW_FILE)
      // Legacy v1 rows stay readable, and every REQUIRED-identity violation
      // skips only that link row (unknown version included).
      await writeFile(file, [
        dispatchLine(),
        settleLine({ role: 'fullstack-dev', childId: 'run-1', taskRef: 'subagent-7' }),
        linkLine({ childId: undefined }),
        linkLine({ childId: 'x'.repeat(513) }),
        linkLine({ role: undefined }),
        linkLine({ v: 2 }),
        'not json at all',
        '',
      ].join('\n'))

      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((event) => event.kind)).toEqual(['settle', 'dispatch']) // legacy only, latest first
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', childId: 'run-1', taskRef: 'subagent-7', paired: true })
      expect(view.summary.some((row) => row.outcome === 'subagent-link')).toBe(false)

      // ONE real link next to the legacy rows.
      recordSubagentLink({
        ref: { harnessDir, workflowDir, agent: 'a1', role: 'fullstack-dev', planId: '00000810-x', taskId: 'T3', taskRef: 'subagent-11' },
        childId: 'child-read',
        label: 'read it back',
      })
      const after = readAgentFlow(workflowDir)!
      const linkView = after.events[0]!
      expect(linkView).toMatchObject({
        kind: 'subagent-link',
        agent: 'a1',
        role: 'fullstack-dev',
        planId: '00000810-x',
        taskId: 'T3',
        taskCategory: null,
        label: 'read it back',
        childId: 'child-read',
        taskRef: 'subagent-11',
      })
      // A link is not a completion: no settle markers on the view.
      expect(linkView.paired).toBeUndefined()
      expect(linkView.outcome).toBeUndefined()
      expect(linkView.verdict).toBeUndefined()
      expect(Object.values(linkView).every((value) => value !== undefined)).toBe(true)
      // Summary buckets: the link is its own outcome (never counted as a
      // dispatch or a settle) and keeps the dispatch's role.
      expect(after.summary.find((row) => row.outcome === 'subagent-link')).toEqual({ role: 'fullstack-dev', outcome: 'subagent-link', count: 1 })
      expect(after.summary.reduce((total, row) => total + row.count, 0)).toBe(after.events.length)

      // A link whose REQUIRED identity is invalid skips just that row.
      recordSubagentLink({
        ref: { harnessDir, workflowDir, agent: 'a1', role: 'fullstack-dev' },
        childId: 'x'.repeat(513),
        label: 'oversized identity',
      })
      const last = readAgentFlow(workflowDir)!
      expect(last.events.filter((event) => event.kind === 'subagent-link')).toHaveLength(1)
      expect(last.events.map((event) => event.kind)).toEqual(['subagent-link', 'settle', 'dispatch'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('apply wiring: the entry registers the live observer — a background dispatch through the real waterfalls links its child', async () => {
    const app = booted = await bootApp({ seedV2: true, dispatchBinding: 'qc-specialist' })
    const session = catalogSession('sess-apply')
    const exec = catalogExec('c-apply', 'sess-apply', session, 'apply-wired delegation')

    // The REAL pre-execute waterfall records the dispatch and reserves the
    // slot; the REAL post-execute waterfall marks it eligible.
    await app.ctx.waterfall('tools/pre-execute', exec, defaultAllow)
    emitUndeclared(app.ctx, SETTLE_SEAM, exec, { isError: false, value: { kind: 'background', jobId: 'subagent-42' } })

    // The live half is the observer `apply` registered on the root context.
    const envelope = session.append('subagent/catalog', catalogPayload('child-apply', 'apply-wired delegation', 'one-shot'))
    app.ctx.events.emit({}, 'session/event', session, envelope)

    const view = flowOf(app)
    expect(view.events.map((event) => event.kind)).toEqual(['subagent-link', 'dispatch'])
    expect(view.events[0]).toMatchObject({
      kind: 'subagent-link',
      childId: 'child-apply',
      label: 'apply-wired delegation',
      role: 'fullstack-dev',
      planId: '00000810-agent-flow',
      taskId: 'T2',
      taskRef: 'subagent-42',
    })
  })
})
