/**
 * Task 3 — the Linear OAuth card on the `linear-mcp` row.
 *
 * Two halves of one contract, pinned together:
 *
 * - the BROWSER half (`LinearSettingsCard` + `LinearSettingsStore`): the four
 *   r3 states, Authorize absent while the row is disabled, the failed-attempt
 *   recovery, and the closed result objects — which carry an authorization URL,
 *   a scope and an expiry, never a token, verifier, client secret, account or
 *   email;
 * - the HOST half (`MstarLinearSettingsGateway`): one host-owned attempt whose
 *   multi-minute consent never rides a single RPC. `begin` returns while the
 *   browser is still consenting, the loopback callback completes the exchange
 *   on the host, and `status` is how the card learns the outcome.
 *
 * Every request goes through the real `connection.rpc.call` shape against a
 * stub `/api` gateway; the host half drives the REAL loopback listener and the
 * REAL credential writer with an injected fetch (no live Linear account).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { readLinearCredential, LINEAR_MCP_URL, writeLinearCredential } from '@mstar-harness/engine'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply } from '../src/client/index.ts'
import { LinearSettingsCard, LINEAR_SETTINGS_ROW_KEY } from '../src/client/linear-settings-card.tsx'
import {
  LinearSettingsStore,
  type LinearSettingsConnection,
  type LinearSettingsState,
} from '../src/client/linear-settings-store.ts'
import { en, zh, type LinearSettingsKey } from '../src/client/linear-settings-locale.ts'
import {
  LINEAR_AUTHORIZE_BEGIN_ENDPOINT,
  LINEAR_AUTHORIZE_CANCEL_ENDPOINT,
  LINEAR_AUTHORIZE_STATUS_ENDPOINT,
  LINEAR_STATUS_ENDPOINT,
} from '../src/engine-status-wire.ts'
import { MstarLinearAuth } from '../src/linear-settings.ts'
import { MstarLinearSettingsGateway } from '../src/linear-settings.ts'
import type { LoaderEntryView } from '../src/gates/fallbacks-probe.ts'
import { FakeLoaderRegistry } from './harness.ts'

/* ------------------------------------------------------------------------ *
 * Browser-half fixtures
 * ------------------------------------------------------------------------ */

/** Namespace-bound `t` over one shipped dictionary (the renderer supplies it in production). */
function translate(locale: 'en' | 'zh' = 'en'): TranslateNS<'ui-mstar-linear-settings'> {
  const dict = locale === 'zh' ? zh : en
  return (key, params) =>
    String(dict[key as LinearSettingsKey]).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
}

interface StubConnection {
  readonly connection: LinearSettingsConnection
  readonly calls: Array<{ channel: string; endpoint: string; payload: unknown }>
}

/** One `/api` gateway stub: every call answers `handler(endpoint, args, callNumber)`. */
function stubConnection(
  handler: (endpoint: string, args: Record<string, unknown>, call: number) => unknown,
): StubConnection {
  const calls: StubConnection['calls'] = []
  const connection: LinearSettingsConnection = {
    isLoopback: true,
    rpc: {
      call: async (channel, endpoint, payload) => {
        calls.push({ channel, endpoint, payload })
        const args = payload !== null && typeof payload === 'object' && 'args' in payload && payload.args !== null &&
            typeof payload.args === 'object'
          ? payload.args as Record<string, unknown>
          : {}
        return { ok: true, value: handler(endpoint, args, calls.length) }
      },
    },
  }
  return { connection, calls }
}

interface ManualTimer {
  readonly run: () => void
  cancelled: boolean
}

interface ManualTimers {
  schedule(run: () => void, delayMs: number): ManualTimer
  cancel(timer: unknown): void
  fire(): void
  pending(): number
}

/** Deterministic replacement for setTimeout: a test fires the pending poll itself. */
function manualTimers(): ManualTimers {
  const queue: ManualTimer[] = []
  return {
    schedule(run) {
      const timer: ManualTimer = { run, cancelled: false }
      queue.push(timer)
      return timer
    },
    cancel(timer) {
      if (timer !== null && typeof timer === 'object' && 'cancelled' in timer) timer.cancelled = true
    },
    fire() {
      const timer = queue.shift()
      if (timer !== undefined && !timer.cancelled) timer.run()
    },
    pending: () => queue.filter((timer) => !timer.cancelled).length,
  }
}

/** Let the store's promise chain (poll → status → refresh) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
}

function storeFor(
  connection: LinearSettingsConnection | undefined,
  options: ConstructorParameters<typeof LinearSettingsStore>[1] = {},
): LinearSettingsStore {
  return new LinearSettingsStore(connection, options)
}

function render(
  store: LinearSettingsStore,
  view: 'summary' | 'page' = 'page',
  locale: 'en' | 'zh' = 'en',
): string {
  return renderToStaticMarkup(createElement(LinearSettingsCard, {
    view,
    t: translate(locale),
    controller: store,
    useSnapshot: <S,>(selector: (state: LinearSettingsState) => S): S => selector(store.snapshot.getSnapshot()),
  }))
}

const START = Date.UTC(2026, 10, 2, 12)
const READY_ABSENT = {
  status: 'ready',
  rowEnabled: true,
  fiberPhase: 'live',
  credential: { display: 'absent', scope: null, expiresAt: null, canWrite: false },
}
const READY_DISABLED = { ...READY_ABSENT, rowEnabled: false }
const READY_AUTHORIZED = {
  status: 'ready',
  rowEnabled: true,
  fiberPhase: 'live',
  credential: { display: 'authorized', scope: 'read,issues:create', expiresAt: START + 3_600_000, canWrite: true },
}
/** Valid, still inside its expiry, and read-only: authorized but cannot push. */
const READY_READ_ONLY = {
  status: 'ready',
  rowEnabled: true,
  fiberPhase: 'live',
  credential: { display: 'authorized', scope: 'read', expiresAt: START + 3_600_000, canWrite: false },
}

/** The forbidden-material sweep for every result the browser receives. */
function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text).not.toMatch(/access_?token|refresh_?token|client_?secret|verifier|account|email/i)
}

/* ------------------------------------------------------------------------ *
 * (1) The registration: one keyed row card, no fallback surface
 * ------------------------------------------------------------------------ */

interface CapturedRegistration {
  readonly name: string
  readonly key?: string
  readonly locale?: string
  readonly component: unknown
  readonly inject?: () => {
    controller: LinearSettingsStore
    hooks: { snapshot: LinearSettingsStore['snapshot'] }
  }
}

/** A client ctx carrying only the faces the plugin entry touches. */
function pluginContext(connection: unknown): {
  ctx: unknown
  registrations: CapturedRegistration[]
  dicts: Map<string, unknown>
  runDisposers: () => void
} {
  const registrations: CapturedRegistration[] = []
  const dicts = new Map<string, unknown>()
  const disposers: Array<() => void> = []
  const effect = (fn: () => unknown): (() => void) => {
    const result = fn()
    const dispose = typeof result === 'function' ? (result as () => void) : () => {}
    disposers.push(dispose)
    return dispose
  }
  const slots = {
    inject(name: string, callback: () => unknown): () => void {
      const produced = callback()
      if (produced !== null && typeof produced === 'object' && Symbol.iterator in produced) {
        for (const _ of produced as Iterable<unknown>) { /* run the registration generator */ }
      }
      return () => {}
    },
    register(entry: Omit<CapturedRegistration, 'component'>, component: unknown): () => void {
      registrations.push({ ...entry, component })
      return () => {}
    },
  }
  const locale = {
    register(namespace: string, value: unknown): () => void {
      dicts.set(namespace, value)
      return () => {}
    },
    bind: (namespace: string) => (key: string) => `${namespace}:${key}`,
  }
  const ctx = {
    connection,
    slots,
    locale,
    effect,
    on: () => () => {},
    theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
    sidebarRightTabs: { register: () => () => {} },
  }
  return {
    ctx,
    registrations,
    dicts,
    runDisposers: () => {
      for (const dispose of [...disposers].reverse()) dispose()
    },
  }
}

describe('the linear-mcp Settings row card', () => {
  it("the card the plugin registers renders this row's state from what the registration injects", async () => {
    const { connection } = stubConnection(() => READY_DISABLED)
    const { ctx, registrations } = pluginContext(connection)
    apply(ctx as never)

    // One card, on the linear-mcp row: the key is the exported constant the
    // bundle patch declares, not a second copy of the literal.
    const rowCards = registrations.filter((entry) => entry.name === 'plugins.row.config')
    expect(rowCards).toHaveLength(1)
    expect(rowCards[0]!.key).toBe(LINEAR_SETTINGS_ROW_KEY)

    // What the host actually does: render the registered component with the
    // props the registration injects. This is the behaviour; the entry record's
    // remaining fields are the host's to own.
    const registered = rowCards[0]!
    const { controller, hooks } = registered.inject!()
    await controller.refresh()
    const Card = registered.component as typeof LinearSettingsCard
    const html = renderToStaticMarkup(createElement(Card, {
      view: 'page',
      t: translate('en'),
      controller,
      useSnapshot: <S,>(selector: (state: LinearSettingsState) => S): S => selector(hooks.snapshot.getSnapshot()),
    }))

    // The row's own bit reaches the card: disabled explains the toggle and
    // offers no Authorize.
    expect(html).toContain('data-ms-linear-state="disabled"')
    expect(html).toContain(translate('en')('state.disabled.title'))
    expect(html).not.toContain('data-ms-linear-action="authorize"')
  })

  it('the registered card renders every credential state the host reports, through the slot it was registered on', async () => {
    const EXPIRED = {
      status: 'ready',
      rowEnabled: true,
      fiberPhase: 'live',
      credential: { display: 'expired', scope: null, expiresAt: START - 1_000, canWrite: false },
    }
    const cases = [
      { label: 'disabled row', answer: READY_DISABLED, state: 'disabled', push: null, authorize: false },
      { label: 'enabled, no grant', answer: READY_ABSENT, state: 'unauthorized', push: null, authorize: true },
      { label: 'expired grant', answer: EXPIRED, state: 'unauthorized', push: null, authorize: true },
      { label: 'writable grant', answer: READY_AUTHORIZED, state: 'authorized', push: 'ready', authorize: false },
      { label: 'read-only grant', answer: READY_READ_ONLY, state: 'authorized', push: 'scope-insufficient', authorize: true },
    ] as const

    for (const testCase of cases) {
      // The slot contribution the plugin entry makes, then the renderer's own
      // contract: the component with the props the registration injects.
      const { connection } = stubConnection(() => testCase.answer)
      const { ctx, registrations } = pluginContext(connection)
      apply(ctx as never)
      const registered = registrations.filter((entry) => entry.name === 'plugins.row.config')[0]!
      const { controller, hooks } = registered.inject!()
      await controller.refresh()
      const Card = registered.component as typeof LinearSettingsCard
      const html = renderToStaticMarkup(createElement(Card, {
        view: 'page',
        t: translate('en'),
        controller,
        useSnapshot: <S,>(selector: (state: LinearSettingsState) => S): S => selector(hooks.snapshot.getSnapshot()),
      }))

      expect(html, testCase.label).toContain(`data-ms-linear-state="${testCase.state}"`)
      if (testCase.push !== null) expect(html, testCase.label).toContain(`data-ms-linear-push="${testCase.push}"`)
      if (testCase.authorize) expect(html, testCase.label).toContain('data-ms-linear-action="authorize"')
      else expect(html, testCase.label).not.toContain('data-ms-linear-action="authorize"')
      controller.dispose()
    }
  })
})

/* ------------------------------------------------------------------------ *
 * (2) The four r3 states — plus the failure recoveries
 * ------------------------------------------------------------------------ */

describe('the card states', () => {
  it('row disabled: explains the native toggle and offers no Authorize control', async () => {
    const { connection } = stubConnection(() => READY_DISABLED)
    const store = storeFor(connection)
    await store.refresh()
    const html = render(store)

    expect(html).toContain(translate('en')('state.disabled.body').slice(0, 20))
    expect(html).not.toContain('data-ms-linear-action="authorize"')
    expect(html).toContain('data-ms-linear-state="disabled"')
  })

  it('row enabled and unauthorized: Authorize is available and nothing is sent yet', async () => {
    const { connection, calls } = stubConnection(() => READY_ABSENT)
    const store = storeFor(connection)
    await store.refresh()
    const html = render(store)

    expect(html).toContain('data-ms-linear-state="unauthorized"')
    expect(html).toContain('data-ms-linear-action="authorize"')
    // Reading the state is the only traffic — no consent on mount.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.endpoint).toBe(LINEAR_STATUS_ENDPOINT)
    expect(calls[0]!.payload).toEqual({ args: {} })
  })

  it('re-reads the row bit at each card visit, so a toggled row is never judged from a cached one', async () => {
    // One store for the whole client plugin: the fixtures control the host's
    // answers and the render boundary, never a freshness clock (there is none).
    let answer: unknown = READY_DISABLED
    const { connection, calls } = stubConnection(() => answer)
    const store = storeFor(connection)

    // Visit 1: the host booted with the row disabled.
    expect(render(store)).toContain('data-ms-linear-state="loading"')
    await flush()
    expect(render(store)).toContain('data-ms-linear-state="disabled"')
    expect(render(store)).not.toContain('data-ms-linear-action="authorize"')

    // The user enables the native row, then opens the card again.
    answer = READY_ABSENT
    render(store)
    await flush()
    const enabled = render(store)
    expect(enabled).toContain('data-ms-linear-state="unauthorized"')
    expect(enabled).toContain('data-ms-linear-action="authorize"')

    // The reverse direction is the rule the disabled row owns: disabling it
    // takes the authorization action away again, on the same store.
    answer = READY_DISABLED
    render(store)
    await flush()
    const disabled = render(store)
    expect(disabled).toContain('data-ms-linear-state="disabled"')
    expect(disabled).not.toContain('data-ms-linear-action="authorize"')

    // One read per visit — a re-render inside one visit adds none.
    expect(calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT)).toHaveLength(3)
    store.dispose()
  })

  it('a stale render never offers Authorize: the first render after a row toggle is unknown, not the old bit', async () => {
    // The reviewer's first gap. Retain an enabled snapshot, disable the native
    // row, and re-render: the first render of the visit must NOT reuse the
    // retained `rowEnabled: true` while the re-read is in flight.
    let answer: unknown = READY_ABSENT
    const { connection, calls } = stubConnection(() => answer)
    const store = storeFor(connection)
    await store.refresh()
    expect(render(store)).toContain('data-ms-linear-action="authorize"')

    // The user disables the native row. The very next render is a stale one:
    // its facts predate the toggle and this render cycle has verified nothing.
    answer = READY_DISABLED
    const stale = render(store)
    expect(stale).toContain('data-ms-linear-state="loading"')
    expect(stale).not.toContain('data-ms-linear-action="authorize"')
    expect(stale).not.toContain('data-ms-linear-state="unauthorized"')

    await flush()
    const settled = render(store)
    expect(settled).toContain('data-ms-linear-state="disabled"')
    expect(settled).not.toContain('data-ms-linear-action="authorize"')
    store.dispose()
  })

  it('a toggle immediately after a read is picked up on the next render, with no freshness window', async () => {
    // The reviewer's second gap: the former 1 s LINEAR_SETTINGS_FRESH_MS bound
    // skipped the re-read for a toggle inside it. The clock never advances here
    // at all, so only the render boundary can start the read.
    let answer: unknown = READY_ABSENT
    const { connection, calls } = stubConnection(() => answer)
    const store = storeFor(connection)
    await store.refresh()
    expect(render(store)).toContain('data-ms-linear-action="authorize"')
    const readsAfterFirstVisit = calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT).length

    // Same instant: toggle off and visit again.
    answer = READY_DISABLED
    const stale = render(store)
    expect(stale).toContain('data-ms-linear-state="loading"')
    expect(stale).not.toContain('data-ms-linear-action="authorize"')

    await flush()
    expect(render(store)).toContain('data-ms-linear-state="disabled"')
    // The re-read actually happened: a time bound would have skipped it here.
    expect(calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT))
      .toHaveLength(readsAfterFirstVisit + 1)
    store.dispose()
  })

  it('repeated renders during one pending read coalesce into a single request', async () => {
    // The fix must not become a fetch loop: many renders inside one flight ask
    // for the same read once, and the answer is consumed by exactly one render.
    let release: (() => void) | undefined
    let answer: unknown = READY_DISABLED
    const calls: string[] = []
    const connection: LinearSettingsConnection = {
      isLoopback: true,
      rpc: {
        call: async (_channel, endpoint) => {
          calls.push(endpoint)
          if (calls.length > 1) {
            const gate = Promise.withResolvers<void>()
            release = () => gate.resolve()
            await gate.promise
          }
          return { ok: true, value: answer }
        },
      },
    }
    const store = storeFor(connection, {})
    await store.refresh()
    expect(render(store)).toContain('data-ms-linear-state="disabled"')

    answer = READY_ABSENT
    for (let i = 0; i < 5; i += 1) {
      expect(render(store)).toContain('data-ms-linear-state="loading"')
    }
    await flush()
    expect(calls.filter((endpoint) => endpoint === LINEAR_STATUS_ENDPOINT)).toHaveLength(2)

    release?.()
    await flush()
    // One consuming render sees the verified answer; a second render at once
    // starts the next read rather than deciding from the same answer twice.
    const verified = render(store)
    expect(verified).toContain('data-ms-linear-state="unauthorized"')
    expect(verified).toContain('data-ms-linear-action="authorize"')
    store.dispose()
  })

  it('the summary view loads on its own, before the page view was ever opened', async () => {
    const { connection } = stubConnection(() => READY_AUTHORIZED)
    const store = storeFor(connection)

    expect(render(store, 'summary')).toBe(translate('en')('state.loading'))
    await flush()
    expect(render(store, 'summary')).toBe(translate('en')('state.authorized.title'))
    store.dispose()
  })

  it('authorizing: the host holds the attempt, the card cancels and stores no secret', async () => {
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return READY_ABSENT
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return {
          status: 'started',
          attemptId: 'attempt-1',
          url: 'https://linear.test/authorize?client_id=client-one&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2Fcallback&scope=read%2Cissues%3Acreate&state=state-one&code_challenge=challenge-one&code_challenge_method=S256',
          expiresAt: START + 300_000,
        }
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const opened: string[] = []
    const timers = manualTimers()
    const store = storeFor(connection, {
      openBrowser: (url) => opened.push(url),
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
    })
    await store.refresh()
    const begin = await store.begin()
    const html = render(store)

    expect(begin).toEqual({
      status: 'started',
      attemptId: 'attempt-1',
      url: expect.stringContaining('https://linear.test/authorize'),
      expiresAt: START + 300_000,
    })
    if (begin.status !== 'started') throw new Error('begin did not start')
    expectNoSecret(begin)
    expect(Object.keys(begin).sort()).toEqual(['attemptId', 'expiresAt', 'status', 'url'])
    // The browser opens the authorization URL only; the verifier stays on the host.
    expect(opened).toEqual([begin.url])
    expect(calls.map((call) => call.endpoint)).toEqual([
      LINEAR_STATUS_ENDPOINT,
      LINEAR_AUTHORIZE_BEGIN_ENDPOINT,
    ])
    expect(html).toContain('data-ms-linear-state="authorizing"')
    expect(html).toContain('data-ms-linear-action="cancel"')
    expect(html).not.toContain('data-ms-linear-action="authorize"')
    // Cancelling the pending poll is the store's own job, not the browser's.
    expect(timers.pending()).toBe(1)
    store.dispose()
  })

  it('a valid read-only grant stays authorized and still offers Authorize to widen it', async () => {
    const { connection } = stubConnection(() => READY_READ_ONLY)
    const store = storeFor(connection)
    await store.refresh()
    const html = render(store)

    // Valid and push-capable are separate facts: the expiry makes it
    // authorized, and the scope keeps the widening path reachable.
    expect(html).toContain('data-ms-linear-state="authorized"')
    expect(html).toContain('data-ms-linear-push="scope-insufficient"')
    expect(html).toContain(translate('en')('state.scope-insufficient.body'))
    expect(html).toContain('data-ms-linear-action="authorize"')
    expect(html).toContain(new Date(START + 3_600_000).toISOString())
    expectNoSecret(READY_READ_ONLY)
    store.dispose()
  })

  it('an explicit reauthorization of a read-only grant runs the shipped begin/poll flow and widens it', async () => {
    // The grant the host reports also carries credential material it must
    // never hand the browser: the card's view is closed, so these two fields
    // must not reach a payload or a rendered frame.
    const secretAccess = tok('hidden')
    const secretRefresh = ref('hidden')
    const withSecrets = (credential: object): unknown => ({
      status: 'ready',
      rowEnabled: true,
      fiberPhase: 'live',
      credential: { ...credential, accessToken: secretAccess, refreshToken: secretRefresh },
    })
    let widened = false
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) {
        return widened ? withSecrets(READY_AUTHORIZED.credential) : withSecrets(READY_READ_ONLY.credential)
      }
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return {
          status: 'started',
          attemptId: 'attempt-widen',
          url: 'https://linear.test/authorize?client_id=client-one&scope=read%2Cissues%3Acreate&state=state-widen&code_challenge=challenge-widen&code_challenge_method=S256',
          expiresAt: START + 300_000,
        }
      }
      if (endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT) {
        return { status: 'authorized', scope: 'read,issues:create', expiresAt: START + 3_600_000 }
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const opened: string[] = []
    const timers = manualTimers()
    const store = storeFor(connection, {
      openBrowser: (url) => opened.push(url),
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
    })
    await store.refresh()

    // Valid and read-only: the widening control is there, and reading the state
    // is the only traffic — an insufficient scope earns no consent on its own.
    const before = render(store)
    expect(before).toContain('data-ms-linear-state="authorized"')
    expect(before).toContain('data-ms-linear-push="scope-insufficient"')
    expect(before).toContain('data-ms-linear-action="authorize"')
    expect(calls.map((call) => call.endpoint)).toEqual([LINEAR_STATUS_ENDPOINT])

    // The explicit action starts the same host-owned attempt the absent case
    // uses: one begin, and the browser opens the shipped PKCE URL (a verifier
    // never crosses to it).
    const begin = await store.begin()
    expect(begin.status).toBe('started')
    if (begin.status !== 'started') throw new Error('begin did not start')
    expect(opened).toEqual([begin.url])
    const url = new URL(begin.url)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.has('code_verifier')).toBe(false)
    expect(calls.map((call) => call.endpoint)).toEqual([
      LINEAR_STATUS_ENDPOINT,
      LINEAR_AUTHORIZE_BEGIN_ENDPOINT,
    ])

    // The consent completes on the host; the card polls the outcome and then
    // shows the widened grant the host now reports.
    widened = true
    timers.fire()
    await flush()

    const after = render(store)
    expect(after).toContain('data-ms-linear-state="authorized"')
    expect(after).toContain('data-ms-linear-push="ready"')
    expect(after).toContain('read,issues:create')
    expect(after).not.toContain('data-ms-linear-action="authorize"')

    // No secret reached the browser: not in the render, not in any request.
    expect(after).not.toContain(secretAccess)
    expect(after).not.toContain(secretRefresh)
    for (const call of calls) expectNoSecret(call.payload)
    expectNoSecret(begin)
    store.dispose()
  })
})

/* ------------------------------------------------------------------------ *
 * (3) A slow consent survives: the attempt lives on the host, the card polls
 * ------------------------------------------------------------------------ */

describe('the card learns an outcome from a slow consent', () => {
  it('stays authorizing across pending polls, then flips to authorized with scope and expiry only', async () => {
    let statusRead = 0
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) {
        statusRead += 1
        return statusRead === 1 ? READY_ABSENT : READY_AUTHORIZED
      }
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return { status: 'started', attemptId: 'attempt-slow', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
      }
      if (endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT) {
        const poll = calls.filter((call) => call.endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT).length
        return poll < 3
          ? { status: 'pending' }
          : { status: 'authorized', scope: 'read,issues:create', expiresAt: START + 3_600_000 }
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, {
      openBrowser: () => {},
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
    })
    await store.refresh()
    await store.begin()

    // A pending answer schedules the next poll and keeps the same attempt:
    // the consent may take minutes and no RPC was held open for it.
    timers.fire()
    await flush()
    expect(render(store)).toContain('data-ms-linear-state="authorizing"')
    expect(timers.pending()).toBe(1)

    timers.fire()
    await flush()
    expect(timers.pending()).toBe(1)

    timers.fire()
    await flush()

    const html = render(store)
    expect(html).toContain('data-ms-linear-state="authorized"')
    expect(html).toContain('data-ms-linear-push="ready"')
    expect(html).toContain('read,issues:create')
    expect(html).toContain(new Date(START + 3_600_000).toISOString())
    expect(html).not.toContain('data-ms-linear-action="authorize"')
    expect(html).not.toContain('data-ms-linear-action="cancel"')
    // The observed status is the closed, secret-free union.
    const statusCall = calls.filter((call) => call.endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT).at(-1)
    expect(statusCall?.payload).toEqual({ args: { attemptId: 'attempt-slow' } })
    store.dispose()
  })

  it('denied, timeout and cancelled return to an actionable state with Authorize again', async () => {
    for (const terminal of [{ status: 'denied', reason: 'linear.auth-denied' }, { status: 'timeout' }, { status: 'cancelled' }] as const) {
      const { connection } = stubConnection((endpoint) => {
        if (endpoint === LINEAR_STATUS_ENDPOINT) return READY_ABSENT
        if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
          return { status: 'started', attemptId: 'a', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
        }
        if (endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT) return terminal
        throw new Error(`unexpected ${endpoint}`)
      })
      const timers = manualTimers()
      const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
      await store.refresh()
      await store.begin()
      timers.fire()
      await flush()

      // The outcome arrived without a new row bit: the first frame may only
      // report unknown, never Authorize from the pre-attempt bit.
      expect(render(store)).toContain('data-ms-linear-state="loading"')
      await flush()
      const html = render(store)
      expect(html).toContain(`data-ms-linear-outcome="${terminal.status}"`)
      expect(html).toContain('data-ms-linear-action="authorize"')
      expectNoSecret(terminal)
      store.dispose()
    }
  })

  it('an attempt already live on the host renders in-flight, not denied, and keeps observing', async () => {
    let authorized = false
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return authorized ? READY_AUTHORIZED : READY_ABSENT
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) return { status: 'attempt-active' }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()

    // Another tab owns the live attempt: this store gets no id, so the row the
    // host writes on success is the only observable it can watch.
    expect(await store.begin()).toEqual({ status: 'attempt-active' })
    expect(render(store)).toContain('data-ms-linear-state="loading"')
    await flush()
    const pending = render(store)
    expect(pending).toContain('data-ms-linear-state="authorizing"')
    expect(pending).toContain('data-ms-linear-outcome="in-flight"')
    expect(pending).not.toContain('data-ms-linear-outcome="denied"')
    expect(timers.pending()).toBe(1)

    authorized = true
    timers.fire()
    await flush()
    const html = render(store)
    expect(html).toContain('data-ms-linear-state="authorized"')
    expect(html).not.toContain('data-ms-linear-outcome="in-flight"')
    // It never asked the host for another attempt's status (it has no id), and
    // the row it could read is what ended the observation.
    expect(calls.filter((call) => call.endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT)).toHaveLength(0)
    expect(calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT).length).toBeGreaterThanOrEqual(2)
    store.dispose()
  })

  it('stops watching a live attempt that never lands, so Authorize is reachable again', async () => {
    const { connection } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return READY_ABSENT
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) return { status: 'attempt-active' }
      throw new Error(`unexpected ${endpoint}`)
    })
    // Two probes make the host's attempt window at this cadence.
    const timers = manualTimers()
    const store = storeFor(connection, {
      pollMs: 150_000,
      openBrowser: () => {},
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
    })
    await store.refresh()
    await store.begin()

    timers.fire()
    await flush()
    expect(timers.pending()).toBe(1)
    timers.fire()
    await flush()
    expect(timers.pending()).toBe(0)

    const html = render(store)
    expect(html).not.toContain('data-ms-linear-outcome="in-flight"')
    expect(html).toContain('data-ms-linear-state="unauthorized"')
    expect(html).toContain('data-ms-linear-action="authorize"')
    store.dispose()
  })

  it('a failed status read during the in-flight watch keeps observing, then ends unreachable', async () => {
    let wedged = false
    let failedReads = 0
    const { connection } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) {
        if (wedged) {
          failedReads += 1
          throw new Error('transport wedged')
        }
        return READY_ABSENT
      }
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) return { status: 'attempt-active' }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()
    await store.begin()

    // The first render after the in-flight outcome is the loading frame; its
    // queued read is what lands the in-flight section.
    expect(render(store)).toContain('data-ms-linear-state="loading"')
    await flush()
    expect(render(store)).toContain('data-ms-linear-outcome="in-flight"')

    // One no-answer is a transport wedge, not a verdict on the attempt: the
    // watch keeps observing instead of flipping the card to `unavailable`.
    wedged = true
    for (let i = 0; i < 4; i += 1) {
      timers.fire()
      await flush()
    }
    expect(store.snapshot.getSnapshot().outcome?.status).toBe('in-flight')
    expect(timers.pending()).toBe(1)

    // The fifth consecutive no-answer is the limit; the facts re-read that
    // follows it answers, so the bounded end is honest about what happened.
    timers.fire()
    wedged = false
    await flush()

    expect(failedReads).toBe(5)
    expect(store.snapshot.getSnapshot().outcome?.status).toBe('unreachable')
    expect(store.snapshot.getSnapshot().read.status).toBe('ready')
    expect(timers.pending()).toBe(0)
    const html = render(store)
    expect(html).toContain('data-ms-linear-outcome="unreachable"')
    expect(html).toContain('data-ms-linear-action="authorize"')
    // The degenerate `unavailable` alert is not where a transport wedge lands.
    expect(html).not.toContain('data-ms-linear-state="unavailable"')
    store.dispose()
  })

  it('a pre-existing grant neither hides nor ends the in-flight watch, and a landing grant is seen', async () => {
    const cases = [
      // The scope-insufficient card the finding is about, and a full grant
      // whose only change is the replacement token's expiry.
      { before: READY_READ_ONLY, landing: READY_AUTHORIZED },
      {
        before: READY_AUTHORIZED,
        landing: { ...READY_AUTHORIZED, credential: { ...READY_AUTHORIZED.credential, expiresAt: START + 7_200_000 } },
      },
    ] as const
    for (const testCase of cases) {
      let landed = false
      const { connection } = stubConnection((endpoint) => {
        if (endpoint === LINEAR_STATUS_ENDPOINT) return landed ? testCase.landing : testCase.before
        if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) return { status: 'attempt-active' }
        throw new Error(`unexpected ${endpoint}`)
      })
      const timers = manualTimers()
      const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
      await store.refresh()
      // Pre-watch: the grant is on file and the card shows it.
      expect(render(store)).toContain('data-ms-linear-state="authorized"')

      expect(await store.begin()).toEqual({ status: 'attempt-active' })
      expect(render(store)).toContain('data-ms-linear-state="loading"')
      await flush()
      // Pending and visible: the in-flight state outranks the grant it already showed.
      const pending = render(store)
      expect(pending).toContain('data-ms-linear-outcome="in-flight"')
      expect(pending).not.toContain('data-ms-linear-state="authorized"')

      // The very same grant on the next probe is not this attempt's result, so
      // it does not settle the watch.
      timers.fire()
      await flush()
      expect(store.snapshot.getSnapshot().outcome?.status).toBe('in-flight')
      expect(timers.pending()).toBe(1)

      // A changed grant landing on the host ends the watch and renders its facts.
      landed = true
      timers.fire()
      await flush()
      const html = render(store)
      expect(html).toContain('data-ms-linear-state="authorized"')
      expect(html).toContain('data-ms-linear-push="ready"')
      expect(html).toContain(new Date(testCase.landing.credential.expiresAt).toISOString())
      expect(html).toContain(String(testCase.landing.credential.scope))
      expect(html).not.toContain('data-ms-linear-outcome="in-flight"')
      expect(timers.pending()).toBe(0)
      store.dispose()
    }
  })

  it('a transport failure on one status poll keeps observing instead of collapsing into denied', async () => {
    let polls = 0
    const { connection } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return polls < 3 ? READY_ABSENT : READY_AUTHORIZED
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return { status: 'started', attemptId: 'attempt-flaky', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
      }
      if (endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT) {
        polls += 1
        // The host is still consenting; the second poll's transport wedges.
        if (polls === 1) return { status: 'pending' }
        if (polls === 2) throw new Error('transport wedged')
        return { status: 'authorized', scope: 'read,issues:create', expiresAt: START + 3_600_000 }
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()
    await store.begin()

    timers.fire() // pending
    await flush()
    timers.fire() // the failed poll
    await flush()

    // No host answer is not a denial: the attempt is still live and the card
    // still observes, so a consent completing a moment later is seen.
    expect(render(store)).toContain('data-ms-linear-state="authorizing"')
    expect(render(store)).not.toContain('data-ms-linear-outcome="denied"')
    expect(timers.pending()).toBe(1)

    timers.fire()
    await flush()
    const html = render(store)
    expect(html).toContain('data-ms-linear-state="authorized"')
    expect(html).not.toContain('data-ms-linear-outcome="denied"')
    store.dispose()
  })

  it('a host that never answers again ends the attempt as unreachable, never as denied', async () => {
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return READY_ABSENT
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return { status: 'started', attemptId: 'attempt-gone', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
      }
      if (endpoint === LINEAR_AUTHORIZE_STATUS_ENDPOINT) throw new Error('transport wedged')
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()
    await store.begin()

    for (let i = 0; i < 5; i += 1) {
      timers.fire()
      await flush()
    }

    const html = render(store)
    expect(html).toContain('data-ms-linear-outcome="unreachable"')
    expect(html).not.toContain('data-ms-linear-outcome="denied"')
    // The bounded end re-reads the host fact rather than inventing an outcome.
    expect(calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT)).toHaveLength(2)
    expect(timers.pending()).toBe(0)
    store.dispose()
  })

  it('cancel asks the host to close the attempt and offers Authorize again', async () => {
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return READY_ABSENT
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return { status: 'started', attemptId: 'attempt-cancel', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
      }
      if (endpoint === LINEAR_AUTHORIZE_CANCEL_ENDPOINT) return { status: 'cancelled' }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()
    await store.begin()
    await store.cancel()
    await flush()

    // The cancel response is an outcome, not a row bit: the first frame reads.
    expect(render(store)).toContain('data-ms-linear-state="loading"')
    await flush()

    const html = render(store)
    expect(calls.map((call) => call.endpoint)).toContain(LINEAR_AUTHORIZE_CANCEL_ENDPOINT)
    expect(html).toContain('data-ms-linear-outcome="cancelled"')
    expect(html).toContain('data-ms-linear-action="authorize"')
    expect(timers.pending()).toBe(0)
    store.dispose()
  })

  it('cancelling an attempt never blesses the pre-disable row bit', async () => {
    // The reviewer's third gap. A cancel response carries an outcome, not a new
    // row bit; copying the old `read` into that snapshot must not make the
    // pre-disable `rowEnabled: true` usable by the first post-cancel render.
    let statusAnswer: unknown = READY_ABSENT
    const { connection, calls } = stubConnection((endpoint) => {
      if (endpoint === LINEAR_STATUS_ENDPOINT) return statusAnswer
      if (endpoint === LINEAR_AUTHORIZE_BEGIN_ENDPOINT) {
        return { status: 'started', attemptId: 'attempt-stale', url: 'https://linear.test/authorize?state=one', expiresAt: START + 300_000 }
      }
      if (endpoint === LINEAR_AUTHORIZE_CANCEL_ENDPOINT) return { status: 'cancelled' }
      throw new Error(`unexpected ${endpoint}`)
    })
    const timers = manualTimers()
    const store = storeFor(connection, { openBrowser: () => {}, schedule: timers.schedule, cancelSchedule: timers.cancel })
    await store.refresh()
    expect(render(store)).toContain('data-ms-linear-action="authorize"')
    await store.begin()
    expect(render(store)).toContain('data-ms-linear-state="authorizing"')

    // The native row is disabled while the consent is pending.
    statusAnswer = READY_DISABLED
    await store.cancel()

    const firstFrame = render(store)
    expect(firstFrame).toContain('data-ms-linear-state="loading"')
    expect(firstFrame).not.toContain('data-ms-linear-action="authorize"')

    await flush()
    const settled = render(store)
    expect(settled).toContain('data-ms-linear-state="disabled"')
    expect(settled).not.toContain('data-ms-linear-action="authorize"')
    // The settled frame came from a fresh host read, not the copied old bit.
    expect(calls.filter((call) => call.endpoint === LINEAR_STATUS_ENDPOINT)).toHaveLength(2)
    expect(timers.pending()).toBe(0)
    store.dispose()
  })
})

/* ------------------------------------------------------------------------ *
 * (4) Trust boundaries: no secret, no account, no remote-browser lie
 * ------------------------------------------------------------------------ */

describe('the card trust boundary', () => {
  it('a browser that is not on the host machine stays on the recovery text and never shows authorized', async () => {
    const { connection } = stubConnection(() => READY_AUTHORIZED)
    const store = storeFor(connection, { loopback: false })
    await store.refresh()
    const html = render(store)

    expect(html).toContain('data-ms-linear-state="recovery"')
    expect(html).toContain('mstar linear auth')
    expect(html).not.toContain('data-ms-linear-state="authorized"')
    expect(html).not.toContain('data-ms-linear-action="authorize"')
  })

  it('expired shows the expiry fact and recovery, and missing scope renders unknown', async () => {
    const expired = {
      status: 'ready',
      rowEnabled: true,
      fiberPhase: 'live',
      credential: { display: 'expired', scope: null, expiresAt: START - 1_000 },
    }
    const { connection } = stubConnection(() => expired)
    const store = storeFor(connection)
    await store.refresh()
    const html = render(store)

    expect(html).toContain('data-ms-linear-state="unauthorized"')
    expect(html).toContain('data-ms-linear-outcome="expired"')
    expect(html).toContain(translate('en')('scope.unknown'))
    expect(html).toContain(new Date(START - 1_000).toISOString())
    expect(html).toContain('data-ms-linear-action="authorize"')
  })

  it('unreadable is not called authorized and offers Authorize', async () => {
    const unreadable = {
      status: 'ready',
      rowEnabled: true,
      fiberPhase: 'live',
      credential: { display: 'unreadable', scope: null, expiresAt: null },
    }
    const { connection } = stubConnection(() => unreadable)
    const store = storeFor(connection)
    await store.refresh()
    const html = render(store)

    expect(html).toContain('data-ms-linear-state="unauthorized"')
    expect(html).toContain('data-ms-linear-outcome="unreadable"')
    expect(html).toContain('data-ms-linear-action="authorize"')
    expectNoSecret(unreadable)
  })
})

/* ------------------------------------------------------------------------ *
 * (5) The host attempt: begin returns before consent, status reports after
 * ------------------------------------------------------------------------ */

const TOKEN_URL = 'https://linear.test/token'
const REGISTRATION_URL = 'https://linear.test/register'
const METADATA_URL = 'https://linear.test/.well-known/oauth-protected-resource'
const AS_METADATA_URL = 'https://linear.test/.well-known/oauth-authorization-server'

/** Fixture token text, built from parts so no credential shape sits in source. */
const tok = (label: string): string => ['tok', label].join('-')
const ref = (label: string): string => ['ref', label].join('-')

/** The injected provider: discovery, DCR and the code exchange. */
function providerFetch(token: Record<string, unknown> = {}): typeof fetch {
  const routes: Record<string, () => Response> = {
    [LINEAR_MCP_URL]: () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA_URL}"` },
      }),
    [METADATA_URL]: () => Response.json({ authorization_servers: ['https://linear.test'] }),
    [AS_METADATA_URL]: () =>
      Response.json({
        authorization_endpoint: 'https://linear.test/authorize',
        token_endpoint: TOKEN_URL,
        registration_endpoint: REGISTRATION_URL,
      }),
    [REGISTRATION_URL]: () => Response.json({ client_id: 'client-card' }),
    [TOKEN_URL]: () =>
      Response.json({
        access_token: tok('card'),
        refresh_token: ref('card'),
        expires_in: 3600,
        scope: 'read,issues:create',
        ...token,
      }),
  }
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected provider fetch: ${url}`)
    return route()
  }) as unknown as typeof fetch
}

interface HostHarness {
  ctx: Context
  auth: MstarLinearAuth
  gateway: MstarLinearSettingsGateway
  restarts: string[]
  /** Timers the auth service armed (a real schedule, driven by the host path). */
  clock: { pending(): number }
}

/** A clock seam with the real epoch, so token expiry math stays realistic. */
function hostClock(): { now(): number; schedule(task: () => void, delayMs: number): () => void; pending(): number } {
  const armed = new Set<{ cancelled: boolean }>()
  return {
    now: () => Date.now(),
    schedule(task, delayMs) {
      const timer = { cancelled: false }
      armed.add(timer)
      const handle = setTimeout(() => {
        armed.delete(timer)
        if (!timer.cancelled) task()
      }, delayMs)
      handle.unref?.()
      return () => {
        timer.cancelled = true
        armed.delete(timer)
        clearTimeout(handle)
      }
    },
    pending: () => armed.size,
  }
}

function hostHarness(waitTimeoutMs?: number): HostHarness {
  const ctx = new Context()
  const loader = new FakeLoaderRegistry(ctx)
  const restarts: string[] = []
  const row: LoaderEntryView = {
    id: 'linear-mcp',
    options: { name: '@deepseek-ai/dsh-mcp-client' },
    disabled: false,
    fiber: { uid: 1, restart: async (): Promise<void> => { restarts.push('linear-mcp') } },
  }
  loader.entriesList = [row]
  const clock = hostClock()
  const auth = new MstarLinearAuth(ctx, { fetch: providerFetch(), clock })
  const gateway = new MstarLinearSettingsGateway(ctx, {
    auth,
    fetch: providerFetch(),
    ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
  })
  return { ctx, auth, gateway, restarts, clock }
}

async function waitForStatus(
  gateway: MstarLinearSettingsGateway,
  attemptId: string,
  wanted: string,
  timeoutMs = 2_000,
): Promise<{ status: string }> {
  const started = Date.now()
  for (;;) {
    const status = await gateway.linearAuthorizeStatus(attemptId)
    if (status.status === wanted) return status
    if (Date.now() - started > timeoutMs) throw new Error(`status stayed ${status.status}, wanted ${wanted}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let root: string
const previousPath = process.env.MSTAR_LINEAR_CREDENTIAL

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mstar-linear-card-'))
  process.env.MSTAR_LINEAR_CREDENTIAL = join(root, 'credential.json')
})

afterEach(() => {
  if (previousPath === undefined) delete process.env.MSTAR_LINEAR_CREDENTIAL
  else process.env.MSTAR_LINEAR_CREDENTIAL = previousPath
  rmSync(root, { recursive: true, force: true })
})

describe('the host-owned authorization attempt', () => {
  it('begin returns while consent is still pending, then the callback completes and status reports authorized', async () => {
    const { gateway, restarts, auth, clock } = hostHarness()
    const begin = await gateway.linearAuthorizeBegin()
    expect(begin.status).toBe('started')
    if (begin.status !== 'started') return
    expectNoSecret(begin)
    expect(Object.keys(begin).sort()).toEqual(['attemptId', 'expiresAt', 'status', 'url'])

    // The browser has not consented yet: the attempt is alive on the host and
    // the short RPC already returned.
    expect(await gateway.linearAuthorizeStatus(begin.attemptId)).toEqual({ status: 'pending' })
    expect(readLinearCredential().kind).toBe('absent')

    // A second begin never forks the PKCE state.
    expect(await gateway.linearAuthorizeBegin()).toEqual({ status: 'attempt-active' })

    const url = new URL(begin.url)
    expect(url.origin).toBe('https://linear.test')
    expect(url.searchParams.get('scope')).toBe('read,issues:create')
    expect(url.searchParams.has('code_verifier')).toBe(false)
    const redirect = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    expect(redirect).not.toBeNull()
    expect(state).not.toBeNull()
    expect(redirect!).toStartWith('http://127.0.0.1:')
    expect(redirect).toEndWith('/callback')

    // The loopback callback arrives (the browser leg's only return path).
    await fetch(`${redirect}?code=code-card&state=${encodeURIComponent(state!)}`)
    const authorized = await waitForStatus(gateway, begin.attemptId, 'authorized') as {
      status: string
      scope: string | null
      expiresAt: number | null
    }
    expectNoSecret(authorized)
    expect(authorized.scope).toBe('read,issues:create')
    expect(typeof authorized.expiresAt).toBe('number')

    // The credential is on the host file and the enabled row was reloaded by
    // the public restart seam (no enable-bit write involved).
    const stored = readLinearCredential()
    expect(stored.kind).toBe('present')
    if (stored.kind !== 'present') return
    expect(stored.credential.accessToken).toBe('tok-card')
    expect(stored.credential.scope).toBe('read,issues:create')
    expect(restarts).toEqual(['linear-mcp'])
    // The first-authorization path also started the silent refresh: the host
    // booted with no credential (nothing was armed at startup), so this grant
    // is the only thing that could have scheduled it — exactly once.
    expect(clock.pending()).toBe(1)
    expect(auth.refreshPlan()).toEqual({
      kind: 'scheduled',
      at: stored.credential.expiresAt! - 5 * 60_000,
    })

    // Terminal attempts drop after their answer is observed.
    expect(await gateway.linearAuthorizeStatus(begin.attemptId)).toEqual({ status: 'not-found' })
  })

  it('a cancel closes the host attempt and the next status reports cancelled once, then not-found', async () => {
    const { gateway } = hostHarness()
    const begin = await gateway.linearAuthorizeBegin()
    if (begin.status !== 'started') throw new Error('begin did not start')

    expect(await gateway.linearAuthorizeCancel(begin.attemptId)).toEqual({ status: 'cancelled' })
    expect(await gateway.linearAuthorizeStatus(begin.attemptId)).toEqual({ status: 'cancelled' })
    expect(await gateway.linearAuthorizeStatus(begin.attemptId)).toEqual({ status: 'not-found' })
    expect(readLinearCredential().kind).toBe('absent')
  })

  it('a consent that never arrives is bounded by the host deadline and reports timeout', async () => {
    const { gateway } = hostHarness(40)
    const begin = await gateway.linearAuthorizeBegin()
    if (begin.status !== 'started') throw new Error('begin did not start')
    expect(await waitForStatus(gateway, begin.attemptId, 'timeout')).toEqual({ status: 'timeout' })
    expect(readLinearCredential().kind).toBe('absent')
  })

  it('linearStatus reports the row bit and the credential words without a path or secret', async () => {
    const { gateway } = hostHarness()
    const status = await gateway.linearStatus()
    expect(status).toEqual({
      status: 'ready',
      rowEnabled: true,
      fiberPhase: 'live',
      credential: { display: 'absent', scope: null, expiresAt: null, canWrite: false },
    })
    expect(JSON.stringify(status)).not.toContain(root)
    expectNoSecret(status)
  })

  it('linearStatus keeps "valid" and "can push" separate for a read-only grant', async () => {
    writeLinearCredential({
      accessToken: tok('read-only'),
      refreshToken: ref('read-only'),
      clientId: 'client-one',
      expiresAt: Date.now() + 3_600_000,
      scope: 'read',
    })
    const { gateway } = hostHarness()
    const status = await gateway.linearStatus()
    expect(status.status).toBe('ready')
    if (status.status !== 'ready') return
    // Expiry says the grant is usable; the scope says it cannot write. The
    // card needs both to offer the widening path.
    expect(status.credential.display).toBe('authorized')
    expect(status.credential.canWrite).toBe(false)
    expectNoSecret(status)
  })
})
