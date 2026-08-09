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
 * `mstar-engine-status` whose content is the unified mstar version
 * (own manifest, single-version invariant with the bundled engine), the
 * compass enforcement mode (`resolveCompassEnforcement`), the harness dir,
 * — so the model-visible row is reconstructable from the session log
 * (MessageSource form; model-visible ⟺ logged). The watermark is
 * boot/workspace-resolved (qc3 W-002) and the append is error-contained
 * (qc3 W-003); an aborted step returns the delegated decision unchanged
 * (qc2 S-001). Fiber disposal removes the listener (HMR-safe).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The plugin's own manifest version (the catalog's `version` field). */
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
      version: PLUGIN_VERSION,
      harnessDir: app.harnessDir,
      enforcement: { hard: false, source: 'none' },
    })
    // The composed session log carries the model-facing text.
    expect(catalog?.content[0]?.type).toBe('text')
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain(`mstar version: ${PLUGIN_VERSION}`)
    expect(text).toContain(`harness dir: ${app.harnessDir}`)
    expect(text).toContain('enforcement: soft')
  })

  it('renders the compass enforcement mode as the watermark (active hard compass → hard)', async () => {
    // The watermark is boot-resolved (qc3 W-002) — the compass must exist
    // before apply() runs.
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-compass-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': [
        '---',
        'status: active',
        'enforcement: hard',
        '---',
        '',
        'body text must not count',
      ].join('\n'),
    })

    const app = booted = await bootApp({ root })

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

  it('keeps the watermark process-stable — a compass appearing after boot does not re-watermark (qc3 W-002)', async () => {
    const app = booted = await bootApp()
    // Enforcement is boot-resolved; a compass that appears mid-session does
    // not change the catalog row until a config reload re-runs apply() (the
    // documented staleness tradeoff for keeping disk I/O off the hot path).
    await seedHarness(app.harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ enforcement: { hard: false, source: 'none' } })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('enforcement: soft')
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

  it('observes the step abort signal — an aborted step publishes no catalog and returns the delegated decision (qc2 S-001)', async () => {
    const app = booted = await bootApp()
    const controller = new AbortController()
    controller.abort()

    // Narrowed abort race: an abort after delegation returns the delegated
    // decision unchanged (clean abort semantics) instead of surfacing an
    // AbortError as a turn failure; the catalog simply is not appended.
    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([], controller.signal), defaultEnter([]))

    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('contains a third-party decider with non-iterable messages — the step still delegates unchanged (qc3 W-003)', async () => {
    const app = booted = await bootApp()
    // A downstream (third-party) pre-step decider returns an enter decision
    // whose messages are not iterable (cordis waterfalls do not validate
    // listener return values). The catalog append must not abort the step:
    // the delegated decision is returned unchanged after an error log.
    const broken = 42 as unknown as UserMessage[]
    app.ctx.on('agent/pre-step', async (_payload, _next): Promise<PreStepDecision> => {
      return { kind: 'enter', messages: broken }
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    expect(decision).toEqual({ kind: 'enter', messages: broken })
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
