/**
 * Task 6 — HMR-safety disposal test (dsh packages/AGENTS.md: "Registry
 * contributions prove disposal through the HMR-safety test ... dispose the
 * fiber and observe removal"; docs/testing.md unit tier: "Every registry gets
 * an HMR-safety test (dispose the contributing fiber, assert cleanup)").
 *
 * The dsh function plugin registers every contribution on the apply fiber's
 * context: the fs intent waterfall listeners (prepended), the
 * `tools/pre-execute` waterfall listener, and the `ctx.dshMstar` service
 * (Service self-registration). Disposing the fiber must unwind ALL of them —
 * a hot reload never leaves a stale gate vetoing or advising on the reloaded
 * module's behalf. Teardown-order guarantee under test: the registrations are
 * fiber-scoped effects, so disposal unwinds them (tool-facing waterfall
 * listeners and the service) before any registry/catalog consumer can observe
 * the reloaded app — no half-removed contribution survives.
 *
 * Mount form: `ctx.plugin(plugin, config)` (Plugin.Object shape — the same
 * mount `ctx.plugin` performs for a function plugin, dsh-private compact
 * HMR-safety pattern); the REAL-composition boot is covered by the
 * status/dispatch/lease suites.
 */
import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntimePlugin, { type SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import type { SkillLintAdvisory, StatusGateAdvisory } from '../src/index.ts'
import { FakeAgentRegistry, FakeLoaderRegistry, FakeSubagentProvider, INVALID_STATUS, seedHarness } from './harness.ts'

/** Violating writable Assignment (missing Execute as — the field-gate case). */
const MISSING_EXECUTE_AS = `## Assignment

**Delegation**: forbidden
**Task category**: logic
**Working branch**: feature/x

Do the thing.
`

/** The mstar role id the decoration test Assignment declares + persona key. */
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

/** FsTarget for `{HARNESS_DIR}/status.json` (local-backend shape). */
const statusTarget = (harnessDir: string): FsTarget => ({
  targetKey: join(harnessDir, 'status.json') as FsTarget['targetKey'],
  displayPath: join(harnessDir, 'status.json'),
})

/** One pending subagent tool call in the registry pipeline shape. */
const subagentExec = (prompt: string): ToolExecution => ({
  callId: 'c1' as ToolExecution['callId'],
  name: 'subagent',
  arguments: { description: 'probe', prompt },
  signal: new AbortController().signal,
  token: Symbol('dsh.tool.execution') as unknown as ToolExecutionToken,
} as unknown as ToolExecution)

/** The registry's bare default decision (the waterfall's terminal `next()`). */
const defaultAllow = (): Promise<PreToolDecision> => Promise.resolve<PreToolDecision>({ kind: 'allow' })

/** Invalid skill document (missing description — the frontmatter trigger contract). */
const INVALID_SKILL = `---
name: broken-skill
---

# Body
`

/** FsTarget for `<root>/<name>/SKILL.md` (local-backend shape). */
const skillTarget = (root: string, name: string): FsTarget => ({
  targetKey: join(root, name, 'SKILL.md') as FsTarget['targetKey'],
  displayPath: join(root, name, 'SKILL.md'),
})

/** One pre-existing user message the agent loop pulled from the inbox. */
const inboxMessage = (): UserMessage =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'probe' }] })

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[]): never => ({
  agent: {},
  messages,
  turn: 1,
  step: 1,
  signal: new AbortController().signal,
} as never)

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** The last message of an enter decision (the appended catalog when present). */
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

describe('HMR safety — fiber.dispose removes every gate contribution', () => {
  it('disposes the gates + service on fiber.dispose and a reloaded fiber restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-hmr-'))
    const harnessDir = join(root, 'harness')
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    // Advisory capture proves listener liveness: the status gate never throws
    // (repair-escape design, qc3 F-1), so a live mount with an invalid on-disk
    // document emits a repair advisory on BOTH intent slots; a disposed mount
    // emits nothing.
    const advisories: StatusGateAdvisory[] = []
    ctx.on('mstar/status-gate', (payload) => { advisories.push(payload) })
    try {
      await seedHarness(harnessDir, { 'status.json': JSON.stringify(INVALID_STATUS) })

      // Mount 1 — every gate is live on the new fiber.
      const fiber = await ctx.plugin(plugin, { enforcement: 'hard', harnessDir })
      expect(ctx.dshMstar).toBeDefined()
      const writeLive = await ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(writeLive).toBeUndefined() // repair escape: allowed, advisory emitted
      const editLive = await ctx.waterfall('fs/edit-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(editLive).toBeUndefined()
      expect(advisories.map((a) => a.operation)).toEqual(['write', 'edit'])
      expect(advisories.every((a) => a.hard === true && a.repair === true)).toBe(true)
      const denied = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(denied).toMatchObject({ kind: 'deny' })

      // Dispose — the status listeners (BOTH slots), the dispatch listener and
      // the service are all unwound: no advisory, no deny, no service.
      await fiber.dispose()
      expect(ctx.dshMstar).toBeUndefined()
      const before = advisories.length
      const writeAfter = await ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(writeAfter).toBeUndefined()
      const editAfter = await ctx.waterfall('fs/edit-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(editAfter).toBeUndefined()
      expect(advisories.length).toBe(before) // edit-intent post-dispose: no advisory (qc1 S-003 / qc3 F-6)
      const dispatchAfter = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(dispatchAfter).toEqual({ kind: 'allow' })

      // HMR reload — a fresh fiber restores the full gate set.
      const reloaded = await ctx.plugin(plugin, { enforcement: 'hard', harnessDir })
      expect(ctx.dshMstar).toBeDefined()
      await ctx.waterfall('fs/write-intent', statusTarget(harnessDir), {}, () => undefined)
      await ctx.waterfall('fs/edit-intent', statusTarget(harnessDir), {}, () => undefined)
      expect(advisories.length).toBe(before + 2)
      const deniedAgain = await ctx.waterfall('tools/pre-execute', subagentExec(MISSING_EXECUTE_AS), defaultAllow)
      expect(deniedAgain).toMatchObject({ kind: 'deny' })
      await reloaded.dispose()
      expect(ctx.dshMstar).toBeUndefined()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disposes the skill-lint and catalog listeners on fiber.dispose; a reloaded fiber restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-hmr-'))
    const harnessDir = join(root, 'harness')
    const skillRoot = join(root, 'skills')
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    await mkdir(join(skillRoot, 'broken-skill'), { recursive: true })
    await writeFile(join(skillRoot, 'broken-skill', 'SKILL.md'), INVALID_SKILL)
    const skillAdvisories: SkillLintAdvisory[] = []
    ctx.on('mstar/skill-lint', (payload) => { skillAdvisories.push(payload) })
    const inbox = [inboxMessage()]
    try {
      // Mount 1 — the skill-lint advisory and the catalog append are live.
      const fiber = await ctx.plugin(plugin, { harnessDir, skillRoots: [skillRoot] })
      await ctx.waterfall('fs/write-intent', skillTarget(skillRoot, 'broken-skill'), {}, () => undefined)
      expect(skillAdvisories).toHaveLength(1)
      const live = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(live)?.source).toMatchObject({ kind: 'mstar-engine-status' })

      // Dispose — both contributions are unwound: no advisory, no catalog row.
      await fiber.dispose()
      const before = skillAdvisories.length
      await ctx.waterfall('fs/write-intent', skillTarget(skillRoot, 'broken-skill'), {}, () => undefined)
      expect(skillAdvisories.length).toBe(before)
      const after = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(after).toEqual({ kind: 'enter', messages: inbox })

      // HMR reload — a fresh fiber restores both.
      const reloaded = await ctx.plugin(plugin, { harnessDir, skillRoots: [skillRoot] })
      await ctx.waterfall('fs/write-intent', skillTarget(skillRoot, 'broken-skill'), {}, () => undefined)
      expect(skillAdvisories.length).toBe(before + 1)
      const again = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(again)?.source).toMatchObject({ kind: 'mstar-engine-status' })
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  it('disposes the native persona channel on fiber.dispose; a reloaded fiber restores it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-hmr-'))
    const harnessDir = join(root, 'harness')
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    // The REAL subagents runtime + a recording provider — the channel's
    // target surface (`ctx.subagents.start` reads go through the
    // `internal/get` wrapper; the runtime injects `agents`, so the fake
    // agents row must mount first).
    new FakeAgentRegistry(ctx)
    await ctx.plugin(SubagentRuntimePlugin as Parameters<Context['plugin']>[0])
    const provider = new FakeSubagentProvider('fake-spawn', { personaCapability: true })
    ;(ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)
    const startOnce = async (): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      void ctx.inject(['subagents'], (sctx) => {
        ;(sctx.subagents as unknown as SubagentRuntime)
          .start('fake-spawn', {
            prompt: [{ type: 'text', text: ASSIGNMENT_PROMPT }],
            parent: { id: 'parent-fake', session: { id: 'parent-fake' } },
            signal: new AbortController().signal,
          } as unknown as Parameters<SubagentRuntime['start']>[1])
          .then(() => resolve(), reject)
      })
      return promise
    }
    try {
      // Mount 1 — the channel is live: a role-matched start merges the
      // persona into the request.
      const fiber = await ctx.plugin(plugin, { harnessDir, rolePersonas: { [EXECUTE_AS]: PERSONA } })
      await startOnce()
      expect(provider.starts[0]!.request.persona).toBe(PERSONA)

      // Dispose — the `internal/get` listener is unwound: a NEW start after
      // dispose is NOT merged (the channel is gone, not merely silent).
      await fiber.dispose()
      await startOnce()
      expect(provider.starts[1]!.request.persona).toBeUndefined()

      // HMR reload — a fresh fiber restores the channel.
      const reloaded = await ctx.plugin(plugin, { harnessDir, rolePersonas: { [EXECUTE_AS]: PERSONA } })
      await startOnce()
      expect(provider.starts[2]!.request.persona).toBe(PERSONA)
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
