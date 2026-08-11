/**
 * Task 5 — mstar-engine-status catalog at agent/pre-step (plan
 * 20260808-dsh-host-adapter), extended by plan
 * `20260811-panel-f4-timeliness` Task 2: the catalog TTL invalidation — a
 * ledger change (recordDispatch) deletes the workspace cache entry so the
 * next pre-step rebuilds fresh sources and the digest re-emits the changed
 * row within the REAL TTL (AC-2); a non-record out-of-band ledger write
 * stays TTL-bounded (cache-hit behavior unchanged — only the record path
 * invalidates).
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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as plugin from '../src/index.ts'
import type { MstarEngineStatusSource } from '../src/index.ts'
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
} as never)

/** The last message of an enter decision (the appended catalog when present). */
const lastMessage = (decision: PreStepDecision): UserMessage | undefined =>
  decision.kind === 'enter' ? decision.messages.at(-1) : undefined

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
    // The watermark is built at boot for the explicit config (the cache is
    // pre-seeded at apply) — the compass must exist before apply() runs to
    // be seen by the boot build.
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

  it('keeps the watermark stable within the catalog TTL — a compass appearing after boot does not re-watermark immediately (qc3 W-002, TTL-bounded)', async () => {
    const app = booted = await bootApp()
    // The cache is built at boot for the explicit config; a compass that
    // appears after boot does not change the catalog row until the catalog
    // TTL expires (Config `catalogTtlMs`, default 60000 — the documented
    // staleness tradeoff for keeping disk I/O off the hot path).
    await seedHarness(app.harnessDir, {
      'iterations/20260808-catalog-test/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    expect(catalog?.source).toMatchObject({ enforcement: { hard: false, source: 'none' } })
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).toContain('enforcement: soft')
  })

  it('omits the iteration section when the iteration-gate row cannot be built — the appended message stays losslessly JSON-serializable (Session.append boundary)', async () => {
    // Default boot fixture: explicit harnessDir but NO status.json and NO
    // steering compass, so `iterationGateSource` cannot build its row. The
    // unified source must then carry the optional `iteration` key ABSENT —
    // never `iteration: undefined`: the agent loop appends the composed
    // message to the real session, whose `Session.append` rejects event
    // data with undefined-valued object properties as non-lossless JSON
    // (round failure: `session event "user/message" carries
    // non-JSON-serializable data`).
    const app = booted = await bootApp()

    const decision = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))

    const catalog = lastMessage(decision)
    const source = catalog?.source as Record<string, unknown>
    expect(source).toMatchObject({ kind: 'mstar-engine-status' })
    expect(Object.keys(source).every((key) => source[key] !== undefined)).toBe(true)
    expect('iteration' in source).toBe(false)
    const text = catalog?.content[0]?.type === 'text' ? catalog.content[0].text : ''
    expect(text).not.toContain('iteration:')
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

describe('catalog TTL invalidation — ledger change refreshes within the TTL (plan 20260811-panel-f4-timeliness Task 2)', () => {
  /** A minimal Assignment for the ledger record (role derives to `fullstack-dev`). */
  const ASSIGNMENT = `## Assignment

**Execute as**: fullstack-dev

## Task 2

Implement the invalidation.
`

  it('a ledger change within the TTL invalidates the cache — the next pre-step rebuilds fresh sources and the digest re-emits the changed row (AC-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-invalidate-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    // REAL TTL (default 60000): a refresh at the second pre-step can only
    // come from the ledger-change invalidation — never from a TTL expiry.
    const app = booted = await bootApp({ root })

    // Pre-step 1 (turn 1): no ledger events yet — the row is injected once.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    const { source: firstSource } = catalogRowOf(first)
    expect(firstSource.state!.agentFlow).toEqual({ events: [], summary: [] })

    // One successful ledger record — the apply-bound invalidator deletes the
    // workspace's catalog cache entry (the TTL itself is untouched).
    plugin.recordDispatch({ harnessDir: app.harnessDir, prompt: ASSIGNMENT, violations: [], hard: false })

    // Pre-step 2 — SAME turn (step 2): the digest gate suppresses an
    // UNCHANGED row, so this re-injection can only be the digest text change
    // from the invalidation-triggered rebuild (the sources now carry the new
    // dispatch event).
    const second = await app.ctx.waterfall('agent/pre-step', {
      agent: {},
      messages: [],
      turn: 1,
      step: 2,
      signal: new AbortController().signal,
    } as never, defaultEnter([]))
    const { row, source } = catalogRowOf(second)
    expect(source.state!.agentFlow!.events).toHaveLength(1)
    expect(source.state!.agentFlow!.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', role: 'fullstack-dev' })
    expect(textOf(row)).toContain('agent flow: 1 events')
    expect(textOf(row)).toContain('by role: fullstack-dev 1')
  })

  it('cross-workspace isolation: a ledger record in workspace A invalidates ONLY A — B\'s cached entry survives within the TTL (qc1 F-103 / qc2 F-003 / qc3 F-004 fix-wave)', async () => {
    // Two workspaces, each with its OWN probed harness root — no explicit
    // config, so each session cwd resolves its own `{HARNESS_DIR}` and its own
    // cache key (the session cwd) + reverse-map entry (D3: per-workspace
    // invalidation — a record deletes EXACTLY the affected workspace's entry,
    // never a global clear).
    const wsA = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-a-'))
    const wsB = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-isolate-b-'))
    for (const ws of [wsA, wsB]) {
      await seedHarness(join(ws, '.mstar'), {
        'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
      })
    }
    const stepFor = (cwd: string, turn: number) => ({
      agent: { session: { header: { cwd } } },
      messages: [],
      turn,
      step: 1,
      signal: new AbortController().signal,
    } as never)
    const app = booted = await bootApp({ harnessDir: null })

    // Register BOTH workspace keys with one pre-step each (the cache is built
    // on first use + the reverse map registers on build).
    const sourceA1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 1), defaultEnter([]))).source
    const sourceB1 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 1), defaultEnter([]))).source
    expect(sourceA1.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(sourceB1.state!.agentFlow).toEqual({ events: [], summary: [] })

    // An OUT-OF-BAND ledger line in B (direct write, bypassing recordDispatch
    // → NO invalidation fires for B): if B's cache entry survives, the line
    // stays INVISIBLE within the REAL TTL (cache hit — no rebuild). This is
    // the observable for "B's cached entry survives": the dsh-llm message
    // envelope deep-clones its source (`createMessage` → `freezeMessage` →
    // `structuredClone`), so cache-hit identity cannot be asserted by
    // reference equality through the message — the direct-write invisibility
    // is the equivalent (and stronger) cache-hit proof.
    await writeFile(
      join(wsB, '.mstar', plugin.AGENT_FLOW_FILE),
      `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })}\n`,
    )

    // A ledger record for workspace A ONLY — the apply-bound invalidator
    // fires with A's harness dir → deletes exactly A's cache entry.
    plugin.recordDispatch({ harnessDir: join(wsA, '.mstar'), prompt: ASSIGNMENT, violations: [], hard: false })

    // Next pre-step for A (new turn): the entry was invalidated → REBUILT (a
    // fresh source carrying the new dispatch event).
    const sourceA2 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsA, 2), defaultEnter([]))).source
    expect(sourceA2.state!.agentFlow!.events).toHaveLength(1)
    expect(sourceA2.state!.agentFlow!.events[0]).toMatchObject({ kind: 'dispatch', verdict: 'ok', role: 'fullstack-dev' })

    // Next pre-step for B (new turn): B's entry was NOT invalidated → the
    // cache HIT serves the cached build — the out-of-band B line stays
    // invisible within the TTL (no global clear; a multi-workspace deployment
    // does not rebuild every workspace per record).
    const sourceB2 = catalogRowOf(await app.ctx.waterfall('agent/pre-step', stepFor(wsB, 2), defaultEnter([]))).source
    expect(sourceB2.state!.agentFlow).toEqual({ events: [], summary: [] }) // cached build — the direct line is NOT visible
  })

  it('without a ledger change the cache-hit behavior is unchanged — a directly-written ledger line stays invisible within the TTL (only the record path invalidates)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-catalog-cachehit-'))
    const harnessDir = join(root, 'harness')
    await mkdir(harnessDir, { recursive: true })
    await seedHarness(harnessDir, {
      'status.json': JSON.stringify({ version: 1, updated_at: '2026-08-08', plans: [], residual_findings: {}, metadata: {} }),
    })
    const app = booted = await bootApp({ root })

    // Pre-step 1 (turn 1): no events → no agent-flow line.
    const first = await app.ctx.waterfall('agent/pre-step', stepPayload([]), defaultEnter([]))
    expect(textOf(lastMessage(first)!)).not.toContain('agent flow:')

    // Write a ledger line DIRECTLY (bypassing recordDispatch → NO
    // invalidation fires): the disk now differs from the cached build.
    await writeFile(
      join(app.harnessDir, plugin.AGENT_FLOW_FILE),
      `${JSON.stringify({ v: 1, ts: Date.now(), kind: 'dispatch', role: 'fullstack-dev', verdict: 'ok', hard: false })}\n`,
    )

    // Pre-step 2 (turn 2, within the REAL TTL): the cache entry was NOT
    // invalidated → the cached build is reused (stale) — the 60s TTL
    // fallback still bounds an out-of-band ledger change.
    const second = await app.ctx.waterfall('agent/pre-step', {
      agent: {},
      messages: [],
      turn: 2,
      step: 1,
      signal: new AbortController().signal,
    } as never, defaultEnter([]))
    const { row, source } = catalogRowOf(second)
    expect(source.state!.agentFlow).toEqual({ events: [], summary: [] })
    expect(textOf(row)).not.toContain('agent flow:')
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
