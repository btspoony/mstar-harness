/**
 * The Agent Teams capability probe on the rc.3 surface.
 *
 * rc.3 removed the roster AND the team-only composition: a teammate is an
 * ordinary continuable `subagent` / `subagent_fork` child, so there is no
 * "team tools but no subagent tools" surface left to describe. What remains is
 * two independent structural probes plus the fixed carrier names:
 *
 * - `ctx.get('agentTeams')` is the Team-layer presence probe (the task board);
 *   rc.3 exposes the board only — there is no member/roster read to consult;
 * - `ctx.get('subagents')` owns member identity (`namesOf` / `resolveName` /
 *   `listDescendants`): a service missing any of the three is not a surface,
 *   so nothing can be resolved through it — never a guessed id;
 * - the dispatch gate is NAME-keyed on the three Team carriers, and
 *   `tools/pre-execute` runs BEFORE the registry resolves a tool, so an
 *   unmounted carrier is still gated (only what happens AFTER an allowed call
 *   changes).
 *
 * Nothing here covers a live rc.3 deployment: that stays with the operator.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bootApp, executeToolCall, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'
import {
  agentNameOf,
  resolveMemberId,
  subagentSurfaceOf,
  teamServicePresent,
} from '../src/gates/team-identity.ts'

let booted: BootResult | undefined
let seq = 0

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/* ---------------------------------- fixtures ---------------------------------- */

/** Assignment-shaped with a field-gate violation (`Execute as` missing): vetoes under hard. */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/team-only-fixture

Do the thing.
`

/** Fully valid writable Assignment — the allow control on the same surface. */
const VALID_WRITABLE = `## Assignment

**Execute as**: fullstack-dev
**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/team-only-fixture
**Task budget (implement / ops rounds)**: S — one focused implementer round

Do the thing, evidence-first.
`

/** The ROOT calling session (no `header.parentSession`) — the one the gate reads. */
const rootAgent = { session: { header: {} } }

/** One complete subagent surface, as the ledger's structural probe sees it. */
const completeSurface = {
  namesOf: () => ({ self: 'reviewer/checker' }),
  resolveName: (_caller: unknown, name: string) => `child-${name}`,
  listDescendants: () => [],
}

let bodyRan = 0

/** Register the real-named Team carrier the gate matches; its body only counts a run. */
function registerBoardTool(app: BootResult): void {
  app.ctx.tools.register(defineTool({
    name: 'team_task_create',
    description: 'create a task-board row',
    parameters: {
      subject: { type: 'string', required: true },
      description: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: () => [{ type: 'text', text: 'task created' }],
    },
    execute: async () => {
      bodyRan += 1
      return { id: 'T-1' }
    },
  }))
}

/** One real registry call through the full pre-execute → body pipeline. */
function callTool(app: BootResult, name: string, args: Record<string, unknown>) {
  return executeToolCall(app.ctx, {
    callId: `cap-${++seq}` as ToolCallId,
    name,
    arguments: args,
    agent: rootAgent as never,
    signal: new AbortController().signal,
  })
}

/** The whole model-facing text of one settled result. */
function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('\n')
}

/** Collect dispatch-gate advisories the plugin emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx']): DispatchGateAdvisory[] {
  const advisories: DispatchGateAdvisory[] = []
  ctx.on('mstar/dispatch-gate', (payload) => { advisories.push(payload) })
  return advisories
}

/* ---------------------------------- presence probes ---------------------------------- */

describe('team presence — the Team layer is a service probe, never a roster read', () => {
  it('any agentTeams object is presence; a missing service or a throwing read is not', () => {
    expect(teamServicePresent({ get: () => ({}) })).toBe(true)
    expect(teamServicePresent({ get: () => undefined })).toBe(false)
    expect(teamServicePresent({ get: () => { throw new Error('boom') } })).toBe(false)
  })

  it('the subagent surface needs ALL three subagent-tree reads — a partial service is no surface', () => {
    expect(subagentSurfaceOf({ get: () => completeSurface })).toBe(completeSurface)
    expect(subagentSurfaceOf({ get: () => ({ namesOf: completeSurface.namesOf, resolveName: completeSurface.resolveName }) })).toBeUndefined()
    expect(subagentSurfaceOf({ get: () => ({}) })).toBeUndefined()
    expect(subagentSurfaceOf({ get: () => { throw new Error('boom') } })).toBeUndefined()
    expect(subagentSurfaceOf({ get: () => undefined })).toBeUndefined()
  })

  it('member identity: namesOf names the live agent, resolveName maps a member name onto its child id', async () => {
    const surface = subagentSurfaceOf({ get: () => completeSurface })
    expect(agentNameOf(surface, { id: 'live' })).toBe('reviewer/checker')
    expect(await resolveMemberId(surface, { id: 'lead' }, 'reviewer')).toBe('child-reviewer')
  })

  it('an unresolvable, throwing or empty name yields undefined — never a guessed id', async () => {
    const surface = subagentSurfaceOf({ get: () => completeSurface })
    expect(await resolveMemberId(surface, {}, '')).toBeUndefined()
    expect(await resolveMemberId(undefined, {}, 'reviewer')).toBeUndefined()
    const absent = subagentSurfaceOf({ get: () => ({ ...completeSurface, resolveName: () => undefined }) })
    expect(await resolveMemberId(absent, {}, 'reviewer')).toBeUndefined()
    const throwing = subagentSurfaceOf({ get: () => ({ ...completeSurface, resolveName: () => { throw new Error('boom') } }) })
    expect(await resolveMemberId(throwing, {}, 'reviewer')).toBeUndefined()
  })
})

/* ---------------------------------- name-keyed gate ---------------------------------- */

describe('team dispatch gate — name-keyed before tool resolution, so absence is no bypass', () => {
  it('an unmounted board carrier is still vetoed by policy, naming the carrier', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    expect(app.ctx.tools.get('team_task_create')).toBeUndefined()

    const denied = await callTool(app, 'team_task_create', { subject: 'Review the change', description: MISSING_EXECUTE_AS })

    // `tools/pre-execute` runs BEFORE resolution and the branch is keyed on the
    // CALL NAME, so an absent carrier is refused by policy — naming the
    // carrier, never the registry's unknown-tool error.
    if (!denied.isError) throw new Error('expected the dispatch gate to deny the call')
    expect(denied.error.message).toContain('assignment.field.missing-execute-as')
    expect(denied.error.message).toContain('(team_task_create)')
    expect(advisories).toHaveLength(0)
  })

  it('a valid Assignment passes the gate and only then fails as the registry unknown tool', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })

    const refused = await callTool(app, 'team_task_create', { subject: 'Review the change', description: VALID_WRITABLE })

    // The gate has no objection (the Assignment is valid); the composition does,
    // and the refusal is the registry's own — no silent success, no dispatch.
    if (!refused.isError) throw new Error('expected the registry to refuse the unregistered tool')
    expect(refused.error.message.toLowerCase()).toContain('unknown tool')
    expect(refused.error.message).toContain('team_task_create')
  })

  it('a registered board tool runs a valid call exactly once and never a malformed one', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    registerBoardTool(app)

    bodyRan = 0
    const denied = await callTool(app, 'team_task_create', { subject: 'Review the change', description: MISSING_EXECUTE_AS })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('assignment.field.missing-execute-as')
    expect(textOf(denied)).toContain('(team_task_create)')
    expect(bodyRan).toBe(0)

    const allowed = await callTool(app, 'team_task_create', { subject: 'Review the change', description: VALID_WRITABLE })
    expect(allowed.isError).toBe(false)
    expect(bodyRan).toBe(1)
    expect(advisories).toHaveLength(0)
  })
})
