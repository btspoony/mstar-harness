/**
 * Task 3 — `subagent_fork` gate coverage + settle pairing (plan
 * `20260814-dsh-fallbacks-integration`; roadmap §9 W-B1).
 *
 * The fork tool is the subagent delegation tool's fork sibling: fork
 * dispatches carry the SAME Assignment-shaped `{ description, prompt }` args
 * and ride the SAME seams — `tools/pre-execute` (dispatch gate),
 * `tools/post-execute` (settle pairing, dispatchTools-matched), and
 * `subagent/start` (persona decoration). This spec proves all three compose
 * on `subagent_fork` once the tool joins `DEFAULT_DISPATCH_TOOLS`:
 *
 * - (a) a fork dispatch with an invalid Assignment under `Enforcement: hard`
 *   → PreToolDecision { kind: 'deny' } — gate coverage on the fork tool;
 * - (b) a valid fork Assignment → allow, silent, and the ledger records the
 *   fork dispatch (verdict ok) — no false positives, fork is recorded;
 * - (c) ledger records fork dispatch + settle: a REAL fork dispatch through
 *   the composed registry (registered `subagent_fork` tool, canonical
 *   background shape) → one dispatch event, then the onJobDone terminal →
 *   one PAIRED settle — the `registerSettleListener` dispatchTools match
 *   covers fork (verify, no code change beyond `DEFAULT_DISPATCH_TOOLS`),
 *   plus the bare-context foreground pairing probe with an EMPTY config
 *   (the DEFAULT tool set alone matches `subagent_fork`);
 * - (d) a fork child (Assignment-seeded, same prompt shape) receiving
 *   `subagent/start` → the `mstar:role-persona` section — decoration composes
 *   on the fork tool through the shared seam (no fork-specific code).
 *
 * Harness: the SAME real-composition boot as dispatch-gate.spec.ts / the
 * agent-flow upstream seam probes; the fork tool is registered like the
 * seam-probe `subagent` fixture (canonical background shape) so the real
 * registry drives the full pre/post-execute waterfalls.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { readAgentFlow, recordDispatch, SETTLE_SEAM } from '../src/index.ts'
import type { AgentFlowView } from '../src/index.ts'
import { registerSettleListener, setAgentFlowLogger } from '../src/gates/agent-flow.ts'
import type { AgentFlowPairing } from '../src/gates/agent-flow.ts'
import { PERSONA_SECTION_NAME } from '../src/gates/fallbacks-decoration.ts'
import { bootApp, FakeJobRegistry, seedV2Tree, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** Fully valid writable Assignment with plan + task identity (ledger derivation target). */
const VALID_FORK = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/20260814-dsh-fallbacks-integration
**Plan Path**: /proj/plans/20260814-fork-gate.md

## Task 3

Fork the assigned work, evidence-first.
`

/** Missing `Execute as` — the opencode consumer's first field-gate case. */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** The mstar role id the fork-child Assignment declares and the persona is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** The configured persona text for `fullstack-dev`. */
const PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

/** One mstar-style Assignment prompt seeded into a fork child session. */
const FORK_ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Fork the assigned work, evidence-first.',
].join('\n')

/* ---------------------------------- helpers ---------------------------------- */

let seq = 0

/** One pending tool call in the registry pipeline shape (dsh-tools 9451be2). */
function toolExec(name: string, args: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** The fork tool call shape: the SAME `{ description, prompt }` as subagent. */
const forkExec = (prompt: string): ToolExecution =>
  toolExec('subagent_fork', { description: 'fork probe', prompt })

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

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
 * workflow (plan `20260819-workflow-dsh-viz` Task 2).
 */
async function tempHarness(prefix: string): Promise<{ root: string; harnessDir: string; workflowDir: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const harnessDir = join(root, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await seedV2Tree(harnessDir)
  return { root, harnessDir, workflowDir: join(harnessDir, 'workflows/wf-1') }
}

/** Emit an event NOT declared on the typed Events surface (runtime-valid). */
function emitUndeclared(ctx: Context, name: string, ...args: unknown[]): void {
  ;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(name, ...args)
}

/** A fresh apply-scoped pairing store (empty maps). */
function pairingOf(): AgentFlowPairing {
  return { dispatchByCallId: new Map(), dispatchByTaskId: new Map() }
}

/** A fork dispatch-tool exec carrying the FULL pairing surface (callId + agent). */
function forkDispatchExec(callId: string, agent: string, prompt: string): ToolExecution {
  return {
    callId: callId as ToolExecution['callId'],
    name: 'subagent_fork',
    arguments: { description: 'fork probe', prompt },
    agent: { id: agent } as never,
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

let childSeq = 0

/** A structural `subagent/start` payload (the plugin's consumed surface). */
function forkStartInfo(id: string): { runId: string; provider: string; id: string; local: boolean } {
  return { runId: `fork-run-${id}`, provider: 'in-process', id, local: true }
}

/** Seed a detached session carrying one `user/message` with `prompt` text. */
function seededSession(id: SessionId, prompt: string): Session {
  return Session.create(id, [{
    type: 'user/message',
    seq: 0,
    time: 1_700_000_000_000,
    data: {
      id: MessageId(`seed-${id}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }])
}

/**
 * Build a fake registered fork child: a REAL session seeded with `prompt`
 * plus an agent-scoped ctx (`createScope`, the dsh-scope primitive the agent
 * runtime uses) with `systemPrompt` injected — the same child shape the
 * `subagent/start` decoration resolves for BOTH tool families.
 */
async function fakeForkChild(ctx: Context, prompt: string): Promise<{ agent: Agent; scopeKey: object }> {
  const id = SessionId(`fork-child-${childSeq++}`)
  const scopeKey = { id }
  let childCtx: Context | undefined
  await ctx.inject(['systemPrompt'], (scoped) => {
    childCtx = createScope(scoped, scopeKey).ctx
  })
  const agent = {
    id,
    ctx: childCtx!,
    session: seededSession(id, prompt),
  } as unknown as Agent
  return { agent, scopeKey }
}

/* ---------------------------------- (a)+(b) gate coverage ---------------------------------- */

describe('fork gate — subagent_fork under Enforcement: hard', () => {
  it('(a) invalid Assignment → PreToolDecision { kind: deny }, downstream never runs', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', seedV2: true })
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const decision = await app.ctx.waterfall('tools/pre-execute', forkExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.missing-execute-as')
    // The veto is the signal — advisory is warn-mode only; the hard deny still
    // lands in the ledger (spec §2.1.1: hard deny samples record too).
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'denied', hard: true })
  })

  it('(b) valid Assignment → allow, silent, fork dispatch ledger-recorded with verdict ok', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', seedV2: true, dispatchBinding: 'qc-specialist' })
    let advisories = 0
    app.ctx.on('mstar/dispatch-gate', () => { advisories += 1 })

    const decision = await app.ctx.waterfall('tools/pre-execute', forkExec(VALID_FORK), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toBe(0) // no violations → no advisory
    const view = flowOf(app)
    expect(view.events).toHaveLength(1)
    expect(view.events[0]).toMatchObject({
      kind: 'dispatch',
      role: 'fullstack-dev',
      planId: '20260814-fork-gate',
      taskId: 'T3',
      taskCategory: 'logic',
      verdict: 'ok',
      hard: true,
    })
  })
})

/* ---------------------------------- (c) settle pairing ---------------------------------- */

describe('fork settle — ledger records fork dispatch + settle (dispatchTools-driven pairing)', () => {
  it('(c1) a REAL fork dispatch through the composed registry pairs through tools/post-execute + onJobDone', async () => {
    const app = booted = await bootApp({ jobsService: 'fake', seedV2: true, dispatchBinding: 'qc-specialist' })
    // The fork tool — the same canonical background shape as the upstream
    // dsh-tool-subagent (the seam-probe fixture), so the post-execute branch
    // stores `taskId → dispatchRef` and the onJobDone terminal settles.
    app.ctx.tools.register(defineTool({
      name: 'subagent_fork',
      description: 'fork a delegation to a subagent',
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
          [{ type: 'text', text: `forked background subagent task ${value.taskId}` }],
      },
      execute: async () => ({ kind: 'background' as const, taskId: 'fork-1' }),
    }))

    const result = await app.ctx.tools.execute({
      callId: 'fork-1' as CallId,
      name: 'subagent_fork',
      arguments: { description: 'fork probe', prompt: VALID_FORK },
      agent: { id: 'fork-session' } as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)

    // Dispatch recorded; background → NO settle yet (the terminal is pending).
    let view = flowOf(app)
    expect(view.events.map((e) => e.kind)).toEqual(['dispatch'])
    expect(view.events[0]).toMatchObject({ kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok' })

    // Fire the terminal through the onJobDone listener the plugin's
    // `ctx.inject(['jobs'])` wiring registered on the fake jobs service.
    const jobs = app.ctx.jobs as unknown as FakeJobRegistry
    jobs.fireDone({
      id: JobId('fork-1'),
      kind: 'subagent',
      label: 'fork probe',
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 2_500,
      reported: true,
    })

    view = flowOf(app)
    expect(view.events).toHaveLength(2)
    expect(view.events[0]).toMatchObject({
      kind: 'settle',
      outcome: 'ok',
      agent: 'fork-session',
      role: 'fullstack-dev',
      planId: '20260814-fork-gate',
      taskId: 'T3',
      durationMs: 1_500,
    })
    expect(view.events[0].paired).toBe(true) // the settle carries the paired identity
  })

  it('(c2) the DEFAULT dispatchTools match subagent_fork — foreground settle with an EMPTY config', async () => {
    // Bare-context pairing probe (agent-flow settle pattern): register the
    // settle listener with an EMPTY config and confirm a fork-tool exec is
    // matched by the DEFAULT tool set — the listener must pick up fork
    // without any deployment Config change.
    const { root, harnessDir, workflowDir } = await tempHarness('dsh-fork-settle-default-')
    const ctx = new Context()
    const pairing = pairingOf()
    const priorSink = setAgentFlowLogger(() => {})
    try {
      registerSettleListener(ctx, {}, pairing)
      // A fork dispatch recorded with the pairing store registers the
      // namespaced call key → dispatchRef (the app path does the same via
      // the adapter's shared `dispatchGate` core).
      recordDispatch({
        harnessDir,
        exec: forkDispatchExec('fork-c1', 'sess-1', VALID_FORK),
        prompt: VALID_FORK,
        violations: [],
        hard: false,
        pairing,
      })
      expect(pairing.dispatchByCallId.get('sess-1\u0000fork-c1')).toBeDefined()

      // The fork post-execute settles with the PAIRED identity — the
      // listener's DEFAULT dispatchTools include `subagent_fork`.
      emitUndeclared(
        ctx, SETTLE_SEAM,
        { callId: 'fork-c1', name: 'subagent_fork', agent: { id: 'sess-1' } },
        { isError: false, value: { kind: 'foreground', runId: 'r1', output: [] } },
      )

      const view = readAgentFlow(workflowDir)!
      expect(view.events.map((e) => e.kind)).toEqual(['settle', 'dispatch'])
      expect(view.events[0]).toMatchObject({ kind: 'settle', outcome: 'ok', role: 'fullstack-dev' })
    } finally {
      setAgentFlowLogger(priorSink)
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

/* ---------------------------------- (d) decoration cross-check ---------------------------------- */

describe('fork decoration — the subagent/start seam composes on fork children', () => {
  it('(d) a fork child seeded with a role-matched Assignment prompt receives the mstar:role-persona section', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const { agent, scopeKey } = await fakeForkChild(booted.ctx, FORK_ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    booted.ctx.events.emit('subagent/start', forkStartInfo(agent.id))

    const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
    const section = assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)
    expect(section).toBeDefined()
    expect(section!.text).toBe(PERSONA)
  })
})
