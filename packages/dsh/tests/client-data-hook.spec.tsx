/**
 * Data-path tests for the workflow-viz panel (spec §5): the
 * `useMstarEngineStatus({ useChat, useSessions, sessionId, engineStatus })`
 * hook finds the latest `mstar-engine-status` ANCHOR row
 * (`kind === 'context'` + `form === 'catalog'` + the first-party
 * `source.kind === 'plugin' && source.plugin === 'mstar-engine-status'`), reads
 * the session's workspace directory from the session standard kit, and pulls
 * that session's snapshot from the host's shared `/api` typert gateway.
 *
 * The anchor row does not carry the payload (the persisted source is the
 * locked three-member arm), so these specs stub THE CHANNEL: a gateway stub
 * records the literal `connection.rpc.call('/api', 'mstar/engineStatus',
 * { args: { sessionId, cwd } })` request and answers with the transport
 * envelope the host produces. The hook runs through real renders
 * (`renderToStaticMarkup`) — a first pass issues the call, the settled pass
 * renders the validated answer.
 *
 * Coverage:
 * - the anchor discriminator (latest row wins; other plugin kinds skipped);
 * - the request shape: exactly one `/api` + `mstar/engineStatus` call per
 *   (session, anchor row), carrying the session id and the session's cwd;
 * - a new anchor row (snapshot bump = refresh signal) asks again and serves
 *   the newer snapshot;
 * - every degraded path is EXPLICIT: no anchor row → `waiting`, no answer yet
 *   → `loading`, transport failure / malformed envelope / foreign session id /
 *   unknown cwd / no connection → `unavailable` WITH a reason (never a
 *   silently-empty payload);
 * - session A's request can never render session B's data;
 * - a valid snapshot that says "empty" still renders as data;
 * - the client store's own mechanics (dedupe, per-anchor refetch, generation
 *   invalidation, teardown, listener isolation).
 */

import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { MstarEngineStatusClient } from '../src/client/panel/engine-status-client'
import { useMstarEngineStatus, type MstarEngineStatusView } from '../src/client/panel/use-mstar-engine-status'
import type { MstarEngineStatusPayload } from '../src/types'
import {
  anchorSnapshot,
  anchorStore,
  bindUseChat,
  bindUseSessions,
  chatSnapshot,
  gatewayError,
  gatewayOk,
  otherKindCatalogRow,
  SESSION,
  SESSION_CWD,
  SESSION_ID,
  servedSnapshot,
  stubGateway,
  unavailableResult,
  userNode,
} from './gateway-stub.ts'

/** A distinguishable payload fixture (the panel renders `version` in the meta dock). */
function payload(version: string): MstarEngineStatusPayload {
  return {
    version,
    harnessDir: '/proj/.mstar',
    enforcement: { hard: false, source: 'iteration compass' },
    state: null,
  } as unknown as MstarEngineStatusPayload
}

/** The seats under test, over one anchor store + one gateway stub. */
function seats(
  store: { getSnapshot(): ChatSnapshot },
  gateway: ReturnType<typeof stubGateway>,
  over: {
    sessionId?: SessionId | undefined
    cwd?: string | null
    engineStatus?: MstarEngineStatusClient | undefined
  } = {},
) {
  return {
    useChat: bindUseChat(store),
    useSessions: bindUseSessions(String(over.sessionId ?? SESSION_ID), over.cwd === undefined ? SESSION_CWD : over.cwd),
    sessionId: 'sessionId' in over ? over.sessionId : SESSION,
    engineStatus: 'engineStatus' in over ? over.engineStatus : new MstarEngineStatusClient(gateway.connection),
  }
}

/** One render pass of the hook through a probe component (the hook's real consumer). */
function renderHook(seatsUnderTest: ReturnType<typeof seats>): MstarEngineStatusView {
  let captured: MstarEngineStatusView | null = null
  const Probe = (): null => {
    captured = useMstarEngineStatus(seatsUnderTest)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return captured as unknown as MstarEngineStatusView
}

/** Issue the request (first pass), let the answer land, then read the settled view. */
async function settleView(seatsUnderTest: ReturnType<typeof seats>): Promise<MstarEngineStatusView> {
  renderHook(seatsUnderTest)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return renderHook(seatsUnderTest)
}

describe('useMstarEngineStatus — anchor row selection (spec §2.4, §5)', () => {
  it('reads the LATEST anchor row and serves that session snapshot over the /api gateway', async () => {
    const store = anchorStore(1_720_001_000_000)
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const view = await settleView(seats(store, gateway))
    expect(view.state).toBe('ok')
    expect(view.anchorTime).toBe(1_720_001_000_000)
    expect(gateway.calls).toHaveLength(1)
  })

  it('calls exactly /api + mstar/engineStatus with one args object keyed by the declared parameters', async () => {
    const store = anchorStore(1_720_001_000_000)
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    await settleView(seats(store, gateway))
    expect(gateway.calls).toHaveLength(1)
    expect(gateway.calls[0]!.channel).toBe('/api')
    expect(gateway.calls[0]!.endpoint).toBe('mstar/engineStatus')
    expect(gateway.calls[0]!.payload).toEqual({ args: { sessionId: SESSION_ID, cwd: SESSION_CWD } })
  })

  it('serves the snapshot shape: payload + the served `at` (the freshness marker), never the row time', async () => {
    const store = anchorStore(1_720_001_000_000)
    const gateway = stubGateway(servedSnapshot(payload('2.0.4'), { at: '2024-07-03T09:23:20.000Z' }))
    const view = await settleView(seats(store, gateway))
    expect(view.state).toBe('ok')
    if (view.state !== 'ok') throw new Error('expected ok')
    expect(view.at).toBe('2024-07-03T09:23:20.000Z')
    expect(view.at).not.toBe(new Date(1_720_001_000_000).toISOString())
    expect(view.payload.version).toBe('2.0.4')
  })

  it('a new anchor row (snapshot bump = refresh signal) asks again and serves the newer snapshot', async () => {
    const store = anchorStore(1_720_001_000_000)
    const gateway = stubGateway(
      servedSnapshot(payload('2.0.4'), { at: '2024-07-03T09:23:20.000Z' }),
      servedSnapshot(payload('2.0.5'), { at: '2024-07-03T09:24:20.000Z' }),
    )
    expect((await settleView(seats(store, gateway))).state).toBe('ok')

    // Server re-emission appends a newer anchor row → snapshot bump → re-scan
    // → the newest anchor asks for the newest snapshot.
    store.set(anchorSnapshot(1_720_002_000_000))
    const after = await settleView(seats(store, gateway))
    expect(gateway.calls).toHaveLength(2)
    expect(after.state).toBe('ok')
    if (after.state !== 'ok') throw new Error('expected ok')
    expect(after.payload.version).toBe('2.0.5')
    expect(after.at).toBe('2024-07-03T09:24:20.000Z')
  })
})

describe('useMstarEngineStatus — explicit empty and degraded states (spec §3, §5)', () => {
  it('no anchor row → waiting, and NO gateway call is made', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const view = await settleView(seats(anchorStore(null), gateway))
    expect(view).toEqual({ state: 'waiting', anchorTime: null, payload: null, at: null, reason: null })
    expect(gateway.calls).toHaveLength(0)
  })

  it('catalog rows of other plugin kinds → waiting (the anchor discriminator is the plugin identity)', async () => {
    const store = { getSnapshot: () => chatSnapshot([userNode(), otherKindCatalogRow()]) }
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    expect((await settleView(seats(store, gateway))).state).toBe('waiting')
    expect(gateway.calls).toHaveLength(0)
  })

  it('anchor seen but no answer yet → loading (pending is never rendered as data)', () => {
    const store = anchorStore(1_720_001_000_000)
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    // First pass only: the request is in flight and nothing is rendered yet.
    const view = renderHook(seats(store, gateway))
    expect(view.state).toBe('loading')
    if (view.state !== 'loading') throw new Error('expected loading')
    expect(view.payload).toBeNull()
    expect(view.at).toBeNull()
    // The call WAS issued by that same render (the hook's own trigger).
    expect(gateway.calls).toHaveLength(1)
  })

  it('transport failure → unavailable with the transport reason, never silently empty', async () => {
    const gateway = stubGateway(gatewayError('timeout', 'gateway unreachable'))
    const view = await settleView(seats(anchorStore(), gateway))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('transport-error:timeout')
    expect(view.payload).toBeNull()
    expect(view.at).toBeNull()
  })

  it('the host reason is surfaced verbatim (no snapshot for the session / unknown sv)', async () => {
    const gateway = stubGateway(gatewayOk(unavailableResult('store-unknown-sv')))
    const view = await settleView(seats(anchorStore(), gateway))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('store-unknown-sv')
  })

  it('a malformed envelope degrades to unavailable — never a half-parsed view', async () => {
    const cases: readonly unknown[] = [
      undefined,
      'not-an-envelope',
      { ok: true },
      { ok: true, value: 'not-a-result' },
      { ok: true, value: { status: 'weird' } },
      gatewayOk({ status: 'ok', sessionId: SESSION_ID, cwd: SESSION_CWD, turn: 1, payload: {} }), // no `at`
      gatewayOk({ status: 'ok', sessionId: SESSION_ID, cwd: SESSION_CWD, at: 'x', turn: 1, payload: 'nope' }),
    ]
    for (const raw of cases) {
      const gateway = stubGateway(raw)
      const view = await settleView(seats(anchorStore(), gateway))
      expect(view.state).toBe('unavailable')
      if (view.state !== 'unavailable') throw new Error('expected unavailable')
      expect(view.reason.length).toBeGreaterThan(0)
    }
  })

  it('an unknown session workspace directory → unavailable (the cwd is never guessed), and nothing is called', () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const view = renderHook(seats(anchorStore(), gateway, { cwd: null }))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('session-cwd-unknown')
    expect(gateway.calls).toHaveLength(0)
  })

  it('a composition with no connection → unavailable(no-connection), never a crash', () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const view = renderHook(seats(anchorStore(), gateway, { engineStatus: undefined }))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('no-connection')
  })

  it('a throwing session seat → waiting, never a crash (the hook never throws)', () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const throwing = (() => { throw new Error('session exploded') }) as unknown as SnapshotSelectorHook<ChatSnapshot>
    const view = renderHook({ ...seats(anchorStore(), gateway), useChat: throwing })
    expect(view.state).toBe('waiting')
  })
})

describe('useMstarEngineStatus — per-session answer isolation (spec §5)', () => {
  it("session A's request can never render session B's snapshot", async () => {
    // The gateway answers with B's snapshot for A's request (a foreign answer).
    const gateway = stubGateway(servedSnapshot(payload('B-version'), { sessionId: 's-B' }))
    const view = await settleView(seats(anchorStore(), gateway))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('session-mismatch')
    // …and B's payload is nowhere in A's render state (no half-parsed view).
    expect(view.payload).toBeNull()
    expect(JSON.stringify(view)).not.toContain('B-version')
  })

  it('two sessions keep separate entries: one client serves each its own answer', async () => {
    const gateway = stubGateway()
    const client = new MstarEngineStatusClient(gateway.connection)
    gateway.replyWith((sessionId) => servedSnapshot(payload(`${sessionId}-version`), { sessionId }))

    for (const id of ['s-A', 's-B']) {
      await settleView(seats(anchorStore(), gateway, { sessionId: id as SessionId, engineStatus: client }))
    }
    const entries = client.getSnapshot().entries
    expect([...entries.keys()].sort()).toEqual(['s-A', 's-B'])
    for (const id of ['s-A', 's-B']) {
      const fetch = entries.get(id)!.fetch
      expect(fetch.status).toBe('ok')
      if (fetch.status !== 'ok') throw new Error('expected ok')
      expect(fetch.payload.version).toBe(`${id}-version`)
    }
  })

  it('a valid snapshot that says "empty" is DATA (distinct from "no snapshot")', async () => {
    const empty = payload('2.0.4')
    const gateway = stubGateway(servedSnapshot(empty))
    const view = await settleView(seats(anchorStore(), gateway))
    expect(view.state).toBe('ok')
    if (view.state !== 'ok') throw new Error('expected ok')
    expect(view.payload).toBe(empty)
    // The no-anchor case stays a DIFFERENT state — the distinction survives.
    expect((await settleView(seats(anchorStore(null), gateway))).state).toBe('waiting')
  })
})

describe('MstarEngineStatusClient — store mechanics', () => {
  it('dedupes one in-flight request per (session, anchor row)', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const client = new MstarEngineStatusClient(gateway.connection)
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    expect(gateway.calls).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getSnapshot().entries.get(SESSION_ID)?.anchorTime).toBe(1)
  })

  it('a new anchor row asks again; an already-answered anchor does not', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')), servedSnapshot(payload('2.0.5')))
    const client = new MstarEngineStatusClient(gateway.connection)
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.ensure(SESSION_ID, SESSION_CWD, 1) // already answered → no second call
    expect(gateway.calls).toHaveLength(1)
    client.ensure(SESSION_ID, SESSION_CWD, 2) // newer anchor → one more call
    expect(gateway.calls).toHaveLength(2)
  })

  it('a new connection generation invalidates the cache (wire data is repulled)', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    let onGeneration: (() => void) | null = null
    const client = new MstarEngineStatusClient({
      ...gateway.connection,
      generation: { subscribe: (listener: () => void) => { onGeneration = listener; return () => {} } },
    })
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getSnapshot().entries.size).toBe(1)
    expect(onGeneration).not.toBeNull()
    ;(onGeneration as unknown as () => void)()
    expect(client.getSnapshot().entries.size).toBe(0)
    // …and the panel asks again after the generation change.
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    expect(gateway.calls).toHaveLength(2)
  })

  it('a disposed client stops accepting answers (plugin teardown)', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const client = new MstarEngineStatusClient(gateway.connection)
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getSnapshot().entries.size).toBe(0)
  })

  it('a listener that throws never breaks the store', async () => {
    const gateway = stubGateway(servedSnapshot(payload('2.0.4')))
    const client = new MstarEngineStatusClient(gateway.connection)
    client.subscribe(() => { throw new Error('broken subscriber') })
    let notifications = 0
    client.subscribe(() => { notifications += 1 })
    client.ensure(SESSION_ID, SESSION_CWD, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notifications).toBeGreaterThan(0)
    // The throwing listener did not stop the write.
    expect(client.getSnapshot().entries.size).toBe(1)
  })
})
