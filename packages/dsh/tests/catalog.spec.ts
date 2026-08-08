/**
 * Task 5 — mstar-engine-status catalog at agent/pre-step (plan
 * 20260808-dsh-host-adapter).
 *
 * Dev-time reality (brief): the llm/agent seams are dev-time STUBS (no real
 * runtime), so the pre-step waterfall is simulated with the typed harness —
 * the exact `ctx.waterfall('agent/pre-step', payload, next)` dispatch the
 * real dsh agent loop performs (core/agent/types.ts, dsh-private 9451be2) —
 * with the terminal `next()` standing in for the loop's default step decision
 * (`{ kind: 'enter', messages: payload.messages }`).
 *
 * Contract under test (brief + plan Task 5): the listener is advisory — it
 * MUST call `next()` and build on the delegated decision; it never returns
 * `reject` (would block the step) and never replaces the delegated messages
 * (would drop them). It appends one `catalog`-form MessageSource named
 * `mstar-engine-status` whose content is the engine version
 * (`readHarnessVersion`), the compass enforcement mode
 * (`resolveCompassEnforcement`), the harness dir, and the plugin package
 * version — so the model-visible row is reconstructable from the session log
 * (MessageSource form; model-visible ⟺ logged). Fiber disposal removes the
 * listener (HMR-safe).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { readHarnessVersion } from '@mstar-harness/engine'
import * as plugin from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The plugin's own manifest version (the catalog's `pluginVersion` field). */
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** One pre-existing user message the loop pulled from the inbox. */
const inboxMessage = (): UserMessage => createUserMessage({
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'hello from the inbox' }],
})

/** The loop's default pre-step decision: enter the step with the inbox messages. */
const defaultEnter = (messages: UserMessage[]): (() => Promise<PreStepDecision>) =>
  () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages })

/** A `agent/pre-step` payload the agent loop would dispatch. */
const stepPayload = (messages: UserMessage[], signal = new AbortController().signal) => ({
  agent: {},
  messages,
  turn: 1,
  step: 1,
  signal,
})

/** The last message of an enter decision (the appended catalog when present). */
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

describe('mstar-engine-status catalog — pre-step composition (real Loader boot)', () => {
  it('appends the catalog MessageSource; the text appears in the composed session log', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    // Advisory: the delegated decision wins — enter, with every inbox message preserved.
    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.length).toBe(inbox.length + 1)
    expect(decision.kind === 'enter' && decision.messages.slice(0, -1)).toEqual(inbox)

    // The appended row is the durable catalog MessageSource (model-visible ⟺ logged).
    const catalog = lastMessage(decision)
    expect(catalog?.role).toBe('user')
    expect(catalog?.source).toMatchObject({
      kind: 'mstar-engine-status',
      form: 'catalog',
      engineVersion: readHarnessVersion(),
      pluginVersion: PLUGIN_VERSION,
      harnessDir: app.harnessDir,
      enforcement: { hard: false, source: 'none' },
    })
    // The composed session log carries the model-facing text.
    expect(catalog?.content[0]?.type).toBe('text')
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain(`engine version: ${readHarnessVersion()}`)
    expect(text).toContain(`plugin version: ${PLUGIN_VERSION}`)
    expect(text).toContain(`harness dir: ${app.harnessDir}`)
    expect(text).toContain('enforcement: soft')
  })

  it('renders the compass enforcement mode as the watermark (active hard compass → hard)', async () => {
    const app = booted = await bootApp()
    await seedHarness(app.harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': [
        '---',
        'status: active',
        'enforcement: hard',
        '---',
        '',
        'body text must not count',
      ].join('\n'),
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({
      kind: 'mstar-engine-status',
      form: 'catalog',
      enforcement: { hard: true, source: 'compass' },
    })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('enforcement: hard (compass)')
  })

  it('delegates a rejected step without appending (advisory — never vetoes, never publishes on a blocked step)', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]

    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      stepPayload(inbox),
      () => Promise.resolve<PreStepDecision>({ kind: 'reject' }),
    )

    expect(decision).toEqual({ kind: 'reject' })
  })

  it('composes with later deciders — appends to the final delegated decision, not a fabricated one', async () => {
    const app = booted = await bootApp()
    const inbox = [inboxMessage()]
    // A later-mounted listener (e.g. another catalog) replaces the message set
    // with its own enter decision; the mstar listener must build on THAT.
    const replaced = [inboxMessage()]
    app.ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
      return next()
    }, { prepend: false })
    app.ctx.on('agent/pre-step', async (_payload, _next): Promise<PreStepDecision> => {
      return { kind: 'enter', messages: replaced }
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))

    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' && decision.messages.slice(0, -1)).toEqual(replaced)
    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ kind: 'mstar-engine-status' })
  })

  it('observes the step abort signal — an aborted step publishes no catalog', async () => {
    const app = booted = await bootApp()
    const controller = new AbortController()
    controller.abort()

    await expect(
      app.ctx.waterfall('agent/pre-step', stepPayload([], controller.signal), defaultEnter([])),
    ).rejects.toThrow()
  })
})

describe('catalog teardown — fiber.dispose removes the pre-step listener (HMR-safe)', () => {
  it('disposes the listener on fiber.dispose and a reloaded fiber restores it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-'))
    const harnessDir = join(root, 'harness')
    const ctx = new Context()
    const inbox = [inboxMessage()]
    try {
      // Mount 1 — the catalog is appended on pre-step.
      const fiber = await ctx.plugin(plugin, { harnessDir })
      const live = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(live)?.source).toMatchObject({ kind: 'mstar-engine-status' })

      // Dispose — the listener is unwound: the terminal decision passes through unchanged.
      await fiber.dispose()
      const after = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(after).toEqual({ kind: 'enter', messages: inbox })

      // HMR reload — a fresh fiber restores the catalog contribution.
      const reloaded = await ctx.plugin(plugin, { harnessDir })
      const again = await ctx.waterfall('agent/pre-step', stepPayload(inbox), defaultEnter(inbox))
      expect(lastMessage(again)?.source).toMatchObject({ kind: 'mstar-engine-status' })
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
