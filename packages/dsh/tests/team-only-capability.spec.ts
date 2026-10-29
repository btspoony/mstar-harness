/**
 * Issue #545 item ① — the Agent Teams dispatch arm on a TEAM-ONLY surface.
 *
 * ## What the code actually decides (read before trusting the issue's wording)
 *
 * Channel selection is **name-keyed, not capability-keyed**. `gateDispatch`
 * (`src/gates/dispatch.ts`) runs the workflow branch, then the Agent Teams
 * branch on the FIXED tool name:
 *
 *   `isTeamDispatchTool(exec.name)` → `gateTeamDispatch(...)`   (dispatch.ts:131-150, branch at :1148)
 *   else `config.dispatchTools ?? DEFAULT_DISPATCH_TOOLS` → `gateAssignmentText(...)`
 *
 * There is no `ctx.tools.get('subagent')` (or any other mounted-surface probe)
 * anywhere on that path: the presence or absence of the `subagent` tool does
 * not choose the branch, and cannot. The registry pipeline is what bounds the
 * question — `tools/pre-execute` fires only for a tool the caller can actually
 * name, so on a surface where the team tools are absent a `spawn_teammate`
 * call never reaches any gate at all (`UNKNOWN_TOOL`).
 *
 * This fixture therefore pins the truthful pair — and the registry ORDER is
 * part of the truth, not an implementation detail: `tools/pre-execute` runs
 * BEFORE the registry resolves the tool, so a team-name CALL is gated even on a
 * composition that never mounted the team tool. Absence of the tool is not a
 * way around the Assignment gate; it only changes what happens AFTER an allowed
 * call (the registry's own `unknown tool` refusal instead of a dispatch).
 *
 * - **team-only** — the team tools are registered, `subagent` is not: the team
 *   branch is selected on the real registered tool, allows a valid Assignment,
 *   and vetoes a malformed one under `Enforcement: hard` (the gate does not
 *   need `subagent` to exist to enforce its own arm);
 * - **subagent-only** — `subagent` is registered, no team tool is: a
 *   `spawn_teammate`-shaped call with a malformed Assignment is still vetoed by
 *   the team branch (naming the carrier); with a valid Assignment it passes the
 *   gate and is then refused as an unknown tool — no silent success, no
 *   dispatch record. The `subagent` arm on the same composition still vetoes,
 *   proving the difference is tool presence, not a capability switch.
 *
 * The fixture uses `ctx.tools.execute(...)` (the real registry pipeline:
 * pre-execute waterfall → resolution → body), so "mounted / not mounted" is the
 * registry's own fact, not a test-fiction.
 *
 * Nothing ② (live ledger observation) or ③ (team-only plan run) covers here:
 * both need a real team-only deployment and stay recorded as limits.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { bootApp, type BootResult } from './harness.ts'
import type { DispatchGateAdvisory } from '../src/index.ts'

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

let bodyRan = 0

/**
 * Register the real-named team tool the gate matches. Its body only counts a
 * run: the fixture asserts policy, never the upstream tool's own behaviour.
 */
function registerTeamTool(app: BootResult): void {
  app.ctx.tools.register(defineTool({
    name: 'spawn_teammate',
    description: 'spawn an Agent Teams teammate',
    parameters: {
      name: { type: 'string', required: true },
      description: { type: 'string', required: true },
      prompt: { type: 'string' },
      context: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { type: 'string', required: true, const: 'team' } },
      },
      render: () => [{ type: 'text', text: 'teammate spawned' }],
    },
    execute: async () => {
      bodyRan += 1
      return { kind: 'team' as const }
    },
  }))
}

/** Register the `subagent` name (the mixed-surface control on a subagent-only composition). */
function registerSubagentTool(app: BootResult): void {
  app.ctx.tools.register(defineTool({
    name: 'subagent',
    description: 'delegate to a subagent',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { type: 'string', required: true, const: 'subagent' } },
      },
      render: () => [{ type: 'text', text: 'subagent ran' }],
    },
    execute: async () => ({ kind: 'subagent' as const }),
  }))
}

/** One real registry call through the full pre-execute → body pipeline. */
function callTool(app: BootResult, name: string, args: Record<string, unknown>) {
  return app.ctx.tools.execute({
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

/* ---------------------------------- team-only ---------------------------------- */

describe('team-only surface — no `subagent` tool, the team arm is selected and enforced', () => {
  it('registers no subagent, still vetoes a malformed Assignment through spawn_teammate', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    registerTeamTool(app)

    // The capability fact this fixture exists for: the composition has the team
    // tool and NOT the subagent tool.
    expect(app.ctx.tools.get('subagent')).toBeUndefined()
    expect(app.ctx.tools.get('spawn_teammate')).toBeDefined()

    bodyRan = 0
    const denied = await callTool(app, 'spawn_teammate', {
      name: 'reviewer',
      description: 'Review the diff.',
      prompt: MISSING_EXECUTE_AS,
      context: 'fresh',
    })

    expect(denied.isError).toBe(true)
    const text = textOf(denied)
    expect(text).toContain('assignment.field.missing-execute-as')
    // The refusal names the carrier tool that actually ran the gate.
    expect(text).toContain('(spawn_teammate)')
    expect(bodyRan).toBe(0)
  })

  it('allows a valid writable Assignment on the same surface, with no advisory', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    registerTeamTool(app)

    bodyRan = 0
    const allowed = await callTool(app, 'spawn_teammate', {
      name: 'reviewer',
      description: 'Review the diff.',
      prompt: VALID_WRITABLE,
      context: 'fresh',
    })

    expect(allowed.isError).toBe(false)
    expect(bodyRan).toBe(1)
    expect(advisories).toHaveLength(0)
  })

  it('the pre-execute decision itself is the team branch, not a subagent fall-through', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    // Dispatch the waterfall exactly as the registry does, on a surface without
    // `subagent`: a deny here can only come from the team branch (the subagent
    // branch needs a `prompt` carrier on a name in DEFAULT_DISPATCH_TOOLS).
    const decision = await app.ctx.waterfall(
      'tools/pre-execute',
      {
        callId: `cap-${++seq}`,
        name: 'spawn_teammate',
        arguments: { name: 'reviewer', description: 'Review the diff.', prompt: MISSING_EXECUTE_AS },
        agent: rootAgent,
        signal: new AbortController().signal,
      } as never,
      () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('(spawn_teammate)')
  })
})

/* ---------------------------------- subagent-only ---------------------------------- */

describe('subagent-only surface — the gate runs BEFORE tool resolution, so absence is no bypass', () => {
  it('a spawn_teammate-shaped call is still gated by the team branch without the tool being mounted', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(app.ctx)
    registerSubagentTool(app)

    // The team tool is genuinely absent from this composition.
    expect(app.ctx.tools.get('spawn_teammate')).toBeUndefined()
    expect(app.ctx.tools.get('subagent')).toBeDefined()

    const denied = await callTool(app, 'spawn_teammate', {
      name: 'reviewer',
      description: 'Review the diff.',
      prompt: MISSING_EXECUTE_AS,
      context: 'fresh',
    })

    // Truthful behaviour: `tools/pre-execute` runs BEFORE the registry resolves
    // the tool, and the team branch is keyed on the CALL NAME — so an absent
    // team tool is not a way around the Assignment gate. The call is refused by
    // policy, naming the carrier, not with an unknown-tool error.
    if (!denied.isError) throw new Error('expected the dispatch gate to deny the call')
    expect(denied.error.message).toContain('assignment.field.missing-execute-as')
    expect(denied.error.message).toContain('(spawn_teammate)')
    expect(advisories).toHaveLength(0)
  })

  it('a VALID Assignment passes the gate and only then fails as the registry\'s unknown tool', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    registerSubagentTool(app)

    const refused = await callTool(app, 'spawn_teammate', {
      name: 'reviewer',
      description: 'Review the diff.',
      prompt: VALID_WRITABLE,
      context: 'fresh',
    })

    // The gate has no objection (the Assignment is valid); the composition does,
    // and the refusal is the registry's own — no silent success, no dispatch.
    if (!refused.isError) throw new Error('expected the registry to refuse the unregistered tool')
    expect(refused.error.message.toLowerCase()).toContain('unknown tool')
    expect(refused.error.message).toContain('spawn_teammate')
  })

  it('the same composition still vetoes its OWN subagent arm (the difference is tool presence)', async () => {
    const app = booted = await bootApp({ enforcement: 'hard' })
    registerSubagentTool(app)

    const denied = await callTool(app, 'subagent', {
      description: 'delegate',
      prompt: MISSING_EXECUTE_AS,
    })

    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('assignment.field.missing-execute-as')
    expect(textOf(denied)).toContain('(subagent)')
  })
})
