/**
 * Task 2 — role-based subagent decoration at the `subagent/start` seam (plan
 * `20260814-dsh-fallbacks-integration`): the synchronous listener resolves the
 * published child via `ctx.get('agents')?.get(info.id)` and registers the
 * configured persona as the child's `mstar:role-persona` system-prompt
 * section — the hooks-claude-code pattern (agent-scoped on `Agent.ctx`;
 * contributions are agent-local and unwind on disposal by the Agent.ctx
 * contract — the per-agent systemPrompt realm composition is the host's,
 * not this plugin's).
 *
 * The seam is driven directly (the hooks-claude-code coverage pattern): the
 * child is fake-registered on the harness `FakeAgentRegistry`, its session is
 * a REAL `@deepseek-ai/dsh-session` seeded with the Assignment prompt (the
 * extraction reads the same event log the real child carries at
 * `subagent/start` emit time), and the child ctx is a REAL agent-scoped
 * context with `systemPrompt` injected. Composition case (e) applies the REAL
 * registry `dsh-llm-fallbacks` and asserts the interop log carries the
 * service version.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import * as fallbacks from 'dsh-llm-fallbacks'
import { bootApp, type BootResult } from './harness.ts'
import { fallbacksMounted } from '../src/gates/fallbacks-probe.ts'
import {
  PERSONA_SECTION_NAME,
  PERSONA_SECTION_ORDER,
  setDecorationLogger,
  type DecorationLogLevel,
  type SubagentRunInfoView,
} from '../src/gates/fallbacks-decoration.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The mstar role id the test Assignment declares and the persona is keyed by. */
const EXECUTE_AS = 'fullstack-dev'

/** The configured persona text for `fullstack-dev`. */
const PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

/** One mstar-style Assignment prompt seeded into a child session. */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** A non-Assignment task prompt (no header fields). */
const PLAIN_PROMPT = 'Summarize the attached file.'

let childSeq = 0

/** A structural `subagent/start` payload (the plugin's consumed surface). */
function startInfo(id: string, provider = 'in-process'): SubagentRunInfoView {
  return { runId: `run-${id}`, provider, id, local: true }
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
 * Build a fake registered child: a REAL session seeded with `prompt` plus an
 * agent-scoped ctx (`createScope`, the dsh-scope primitive the agent runtime
 * uses) with `systemPrompt` injected. Returns the assembled child and the
 * scope key the child's prompt assembly views through.
 */
async function fakeChild(ctx: Context, prompt: string): Promise<{ agent: Agent; scopeKey: object }> {
  const id = SessionId(`child-${childSeq++}`)
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

/** Capture decoration logs through the module sink (agent-flow test pattern). */
function captureLogs(): { captured: Array<[DecorationLogLevel, string]>; restore: () => void } {
  const captured: Array<[DecorationLogLevel, string]> = []
  const prior = setDecorationLogger((level, message) => { captured.push([level, message]) })
  return { captured, restore: () => setDecorationLogger(prior) }
}

describe('subagent/start decoration — mstar:role-persona injection', () => {
  it('(a) Assignment with a configured Execute as → the child system prompt carries the mstar:role-persona section', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      const section = assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)
      expect(section).toBeDefined()
      expect(section!.text).toBe(PERSONA)
      // Order 1 renders right after the deployment persona slot (order 0).
      expect(PERSONA_SECTION_ORDER).toBe(1)
    } finally {
      restore()
    }
  })

  it('(b) role-unmatched or non-Assignment prompt → no section, no log spam', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    // Role-unmatched: an Assignment whose Execute as has NO configured persona.
    const unmatched = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT.replace(EXECUTE_AS, 'product-manager'))
    booted.ctx.get('agents')!.register(unmatched.agent)
    // Non-Assignment: a plain task prompt with no header fields.
    const plain = await fakeChild(booted.ctx, PLAIN_PROMPT)
    booted.ctx.get('agents')!.register(plain.agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(unmatched.agent.id))
      booted.ctx.events.emit('subagent/start', startInfo(plain.agent.id))

      const unmatchedAssembly = await unmatched.agent.ctx.systemPrompt.assemble({ scope: unmatched.scopeKey })
      const plainAssembly = await plain.agent.ctx.systemPrompt.assemble({ scope: plain.scopeKey })
      expect(unmatchedAssembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
      expect(plainAssembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)).toBeUndefined()
      expect(captured).toHaveLength(0) // no-op is silent
    } finally {
      restore()
    }
  })

  it('(c) fallbacks unmounted → persona still injected from Config + exactly one debug log', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    expect(fallbacksMounted(booted.ctx)).toBe(false) // no fallbacks row applied
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
      // Exactly one log line, at debug level (same-channel degradation).
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('debug')
    } finally {
      restore()
    }
  })

  it('(d) agents service absent → skip + one debug log; child unresolved → silent no-op; never throws', async () => {
    // No agents service in the composition (the real app always composes
    // dsh-agent, but a minimal composition must not crash the dispatch).
    const noAgents = booted = await bootApp({ rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const absent = captureLogs()
    try {
      expect(() => noAgents.ctx.events.emit('subagent/start', startInfo('child-unknown'))).not.toThrow()
      expect(absent.captured).toHaveLength(1)
      expect(absent.captured[0]![0]).toBe('debug')
      expect(absent.captured[0]![1]).toContain('agents')
    } finally {
      absent.restore()
    }

    // Agents service present but the child id is not registered → silent no-op.
    const withAgents = booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    const unresolved = captureLogs()
    try {
      expect(() => withAgents.ctx.events.emit('subagent/start', startInfo('child-not-registered'))).not.toThrow()
      expect(unresolved.captured).toHaveLength(0)
    } finally {
      unresolved.restore()
    }
  })

  it('(e) composition with dsh-llm-fallbacks applied → persona injected + one info interop log carrying service.version', async () => {
    booted = await bootApp({ agentsService: 'fake', rolePersonas: { [EXECUTE_AS]: PERSONA } })
    // The real registry plugin applied as a row (same entry-shape cast the
    // Task 1 probe test applies).
    const fallbacksPlugin = fallbacks as unknown as Parameters<Context['plugin']>[0]
    await booted.ctx.plugin(fallbacksPlugin)
    expect(fallbacksMounted(booted.ctx)).toBe(true)
    const { agent, scopeKey } = await fakeChild(booted.ctx, ASSIGNMENT_PROMPT)
    booted.ctx.get('agents')!.register(agent)

    const { captured, restore } = captureLogs()
    try {
      booted.ctx.events.emit('subagent/start', startInfo(agent.id))

      const assembly = await agent.ctx.systemPrompt.assemble({ scope: scopeKey })
      expect(assembly.sections.find((s) => s.name === PERSONA_SECTION_NAME)?.text).toBe(PERSONA)
      // One info-level interop log carrying the service version.
      expect(captured).toHaveLength(1)
      expect(captured[0]![0]).toBe('info')
      expect(captured[0]![1]).toContain('0.1.0-alpha.4')
    } finally {
      restore()
    }
  })
})
