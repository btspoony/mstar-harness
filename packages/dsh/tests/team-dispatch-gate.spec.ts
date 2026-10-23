/**
 * Task 3 — the SAME dispatch gate covers the dsh Agent Teams tools.
 *
 * The installed tool surface (`@deepseek-ai/dsh-experimental-tool-agent-team`
 * 0.2.1-rc.2) carries the Assignment-shaped text in other fields than
 * `subagent`'s `{ description, prompt }`:
 *
 * - `spawn_teammate`     → `prompt`
 * - `team_task_create`   → `description`
 * - `team_task_update`   → `description` (absent on a status-only update)
 * - `send_message`       → `message`
 *
 * The gate must route these carriers into the SAME core
 * (`assignmentHeaderRegion` → `isAssignmentShaped` → `resolveDispatchHard` →
 * `adapter.dispatchGate` → `applyEnforcement`) with the same violation set,
 * the same advisory emission and the same veto vocabulary — and must never
 * fire on ordinary team coordination text.
 *
 * Harness approach: the shared real-composition boot (`bootApp`) plus the
 * `tools/pre-execute` waterfall dispatch the real ToolRegistry performs (the
 * same fixture the dispatch-gate spec uses). The refusal channel is the
 * `PreToolDecision` value: a deny returned WITHOUT `next()` vetoes the call.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bootApp, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import { DEFAULT_DISPATCH_TOOLS, TEAM_DISPATCH_TOOLS } from '../src/gates/dispatch.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/**
 * Assignment-shaped with a field-gate violation (`Execute as` missing), so the
 * verdict is non-empty under warn and vetoes under hard — the same fixture the
 * dispatch-gate spec uses for its `subagent` matrix.
 */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** Fully valid writable Assignment — the unchanged-pass positive control. */
const VALID_WRITABLE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/dsh-package-core
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`

/** Ordinary team coordination text — never Assignment-shaped. */
const COORDINATION_MESSAGE = `Please re-run the failing test and paste the log; I will take the diff review after that.
`

/* ---------------------------------- helpers ---------------------------------- */

let seq = 0

/** One pending tool call in the registry pipeline shape. */
function toolExec(name: string, args: unknown, agent?: unknown): ToolExecution {
  return {
    callId: `c${++seq}` as ToolExecution['callId'],
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent: agent as ToolExecution['agent'] }),
    signal: new AbortController().signal,
    token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
  } as unknown as ToolExecution
}

/** ROOT calling session (no `header.parentSession`) — the only session whose configured `dispatchBinding` is read. */
const rootAgent = { session: { header: {} } }

/** The `subagent` call shape: `{ description, prompt }`. */
const subagentExec = (prompt: string): ToolExecution => toolExec('subagent', { description: 'probe', prompt })

/** The `subagent_fork` sibling — same args, own tool name. */
const forkExec = (prompt: string): ToolExecution => toolExec('subagent_fork', { description: 'probe', prompt })

/** `spawn_teammate` args (`name`, `description`, `prompt`, `context`). */
const spawnTeammateExec = (args: { description?: string; prompt?: string }): ToolExecution =>
  toolExec('spawn_teammate', { name: 'reviewer', description: args.description ?? 'Review the diff.', context: 'fresh', ...(args.prompt === undefined ? {} : { prompt: args.prompt }) })

/** `team_task_create` args (`subject`, `description`, optional lists). */
const teamTaskCreateExec = (description: string): ToolExecution =>
  toolExec('team_task_create', { subject: 'Review the change', description })

/** `team_task_update` edit args (the `description` replacement carrier). */
const teamTaskUpdateEditExec = (description: string): ToolExecution =>
  toolExec('team_task_update', { task_id: 'T-1', expected_revision: 2, action: 'edit', description })

/** `team_task_update` status-only args — no `description` carrier at all. */
const teamTaskUpdateClaimExec = (): ToolExecution =>
  toolExec('team_task_update', { task_id: 'T-1', expected_revision: 2, action: 'claim' })

/** `send_message` args (`target`, `message`). */
const sendMessageExec = (message: string): ToolExecution => toolExec('send_message', { target: 'lead', message })

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/** Collect dispatch-gate advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const advisories: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { advisories.push(payload) })
  return advisories
}

/** Sorted violation codes of one captured advisory. */
const codesOf = (advisory: DispatchGateAdvisory | undefined): string[] =>
  advisory?.result.violations.map((v) => v.code).sort() ?? []

/* ---------------------------------- carrier map ---------------------------------- */

describe('team dispatch gate — the exported carrier contract', () => {
  it('TEAM_DISPATCH_TOOLS maps the four fixed Agent Teams carriers; DEFAULT_DISPATCH_TOOLS stays exactly the subagent pair', () => {
    expect(TEAM_DISPATCH_TOOLS).toEqual({
      spawn_teammate: 'prompt',
      team_task_create: 'description',
      team_task_update: 'description',
      send_message: 'message',
    })
    expect([...DEFAULT_DISPATCH_TOOLS]).toEqual(['subagent', 'subagent_fork'])
  })
})

/* ---------------------------------- spawn_teammate ---------------------------------- */

describe('team dispatch gate — spawn_teammate (prompt carrier)', () => {
  it('an Assignment-shaped prompt yields the SAME violation set as subagent (warn mode)', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    expect(await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)).toEqual({ kind: 'allow' })
    expect(await app.ctx.waterfall('tools/pre-execute', spawnTeammateExec({ prompt: MISSING_EXECUTE_AS }), defaultAllow)).toEqual({ kind: 'allow' })

    expect(advisories).toHaveLength(2)
    expect(advisories[0]!.tool).toBe('subagent')
    expect(advisories[1]!.tool).toBe('spawn_teammate')
    expect(codesOf(advisories[1])).toEqual(codesOf(advisories[0]))
    expect(codesOf(advisories[1])).toContain('assignment.field.missing-execute-as')
  })

  it('an Assignment-shaped prompt vetoes identically under Enforcement: hard, naming the actual carrier tool', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    let secondRan = false
    app.ctx.on('tools/pre-execute', () => {
      secondRan = true
      return Promise.resolve<PreToolDecision>({ kind: 'allow' })
    })

    const subagent = await app.ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
    const spawn = await app.ctx.waterfall('tools/pre-execute', spawnTeammateExec({ prompt: MISSING_EXECUTE_AS }), defaultAllow)

    expect(secondRan).toBe(false) // deny without next() short-circuits the waterfall
    expect(subagent.kind).toBe('deny')
    expect(spawn.kind).toBe('deny')
    expect(spawn.kind === 'deny' && spawn.reason).toContain('assignment.field.missing-execute-as')
    // The deny reason names the tool that carried the prompt, not `subagent`.
    expect(spawn.kind === 'deny' && spawn.reason).toContain('(spawn_teammate)')
  })

  it('the carrier is `prompt`, not `description`: an Assignment-shaped description with an ordinary prompt stays silent', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      spawnTeammateExec({ description: MISSING_EXECUTE_AS, prompt: COORDINATION_MESSAGE }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('a non-Assignment prompt produces no decision and no advisory (no false positive)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', spawnTeammateExec({ prompt: COORDINATION_MESSAGE }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('a missing prompt produces no decision (missing carrier = no gate decision)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', spawnTeammateExec({}), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- task board ---------------------------------- */

describe('team dispatch gate — task board (description carrier)', () => {
  it('team_task_create with an Assignment-shaped description is gated', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', teamTaskCreateExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('team_task_create')
    expect(codesOf(advisories[0])).toContain('assignment.field.missing-execute-as')
  })

  it('team_task_update with an Assignment-shaped description is gated', async () => {
    const app = booted = await bootApp()
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', teamTaskUpdateEditExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('team_task_update')
    expect(codesOf(advisories[0])).toContain('assignment.field.missing-execute-as')
  })

  it('team_task_update WITHOUT description (status-only) produces no decision', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', teamTaskUpdateClaimExec(), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('an ordinary task-board description stays silent', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      teamTaskCreateExec('Review the delegation-channel diff and report findings with file:line evidence.'),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- send_message ---------------------------------- */

describe('team dispatch gate — send_message (message carrier)', () => {
  it('an Assignment-shaped message is gated and vetoes under hard', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', sendMessageExec(MISSING_EXECUTE_AS), defaultAllow)

    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('assignment.field.missing-execute-as')
    expect(decision.kind === 'deny' && decision.reason).toContain('(send_message)')
    expect(advisories).toHaveLength(0) // the veto is the signal; advisory is warn-mode only
  })

  it('an ordinary coordination message produces no decision', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', sendMessageExec(COORDINATION_MESSAGE), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- unchanged subagent verdicts ---------------------------------- */

describe('team dispatch gate — the subagent/subagent_fork verdicts are unchanged by the team branch', () => {
  it('a valid Assignment still passes under hard with a configured binding', async () => {
    const app = booted = await bootApp({ enforcement: 'hard', dispatchBinding: 'qc-specialist' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      toolExec('subagent', { description: 'probe', prompt: VALID_WRITABLE }, rootAgent),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('a violating Assignment still vetoes on subagent and subagent_fork', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    for (const exec of [subagentExec(MISSING_EXECUTE_AS), forkExec(MISSING_EXECUTE_AS)]) {
      const decision = await app.ctx.waterfall('tools/pre-execute', exec, defaultAllow)
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' && decision.reason).toContain(`(${exec.name})`)
    }
  })
})

/* ---------------------------------- renamed instances ---------------------------------- */

describe('team dispatch gate — renamed team tools are out of reach (documented caveat)', () => {
  it('a renamed team tool is NOT matched by the fixed name map — even with an Assignment-shaped prompt', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      // A renamed instance (e.g. a second mounted Agent Teams row with a
      // deployment-specific toolName) keeps the same args shape but not the
      // fixed default name. Like the `DEFAULT_DISPATCH_TOOLS` list, the team
      // carrier map is fixed-name keyed: a renamed tool stays ungated until
      // its name is added (there is no Config key for team names — deliberate).
      toolExec('spawn_teammate_renamed', { name: 'reviewer', description: 'Review.', prompt: MISSING_EXECUTE_AS }),
      defaultAllow,
    )

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})

/* ---------------------------------- terminal ownership ---------------------------------- */

describe('team dispatch gate — the team branch is TERMINAL for the names it owns', () => {
  it('a team name also configured in Config.dispatchTools is gated ONCE (no fall-through double gate)', async () => {
    // `spawn_teammate` also carries `args.prompt`, so without a terminal team
    // branch the warn-mode pass used to fall through into the subagent match
    // and run the whole core a second time — two decisions, two advisories and
    // (on an ACTIVE workflow) two dispatch rows for one call.
    const app = booted = await bootApp({ dispatchTools: ['subagent', 'spawn_teammate'] })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', spawnTeammateExec({ prompt: MISSING_EXECUTE_AS }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.tool).toBe('spawn_teammate')
    expect(codesOf(advisories[0])).toContain('assignment.field.missing-execute-as')
  })
})

/* ---------------------------------- non-string / empty carriers ---------------------------------- */

describe('team dispatch gate — non-string and empty carriers produce no decision and never throw', () => {
  it('spawn_teammate with a non-string prompt (42) is a silent pass-through', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('spawn_teammate', {
      name: 'reviewer', description: 'Review.', context: 'fresh', prompt: 42,
    }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('team_task_create with a null description is a silent pass-through', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('team_task_create', {
      subject: 'Review the change', description: null,
    }), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('send_message with an empty message is a silent pass-through', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', sendMessageExec(''), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('team_task_update without a description carrier is a silent pass-through', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', teamTaskUpdateClaimExec(), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })

  it('a non-object arguments payload is a silent pass-through and never throws', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)

    const decision = await app.ctx.waterfall('tools/pre-execute', toolExec('spawn_teammate', null), defaultAllow)

    expect(decision).toEqual({ kind: 'allow' })
    expect(advisories).toHaveLength(0)
  })
})
