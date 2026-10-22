/**
 * Data-path tests for the workflow panel's snapshot channel: the
 * `useMstarPanelSnapshot({ visible, client, sessionId, cwd })` hook polls
 * `connection.rpc.call('/api', 'mstar/panelSnapshot', { args: { sessionId, cwd } })`
 * while the sidebar tab is visible, and renders the store-backed answer as the
 * closed `MstarPanelView` union.
 *
 * The channel is stubbed (`gateway-stub.ts`) so these specs assert the WIRE
 * contract the host half registers — never a React internal. Renders go
 * through `renderToStaticMarkup`: the first pass starts the poll, the settled
 * pass renders the answer.
 *
 * Coverage (the plan's five T4 bullets, one named case each):
 * 1. no visible tab → no request is issued;
 * 2. a visible tab polls at the declared interval;
 * 3. a slow answer never stacks a second in-flight request;
 * 4. a ledger invalidation refreshes immediately, outside the interval;
 * 5. a failed transport degrades to `unavailable` with a reason while the last
 *    good snapshot stays `previous` — and the hook never throws.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'
import {
  MstarPanelSnapshotClient,
  PANEL_POLL_INTERVAL_MS,
  type MstarPanelSnapshotConnection,
} from '../src/client/panel/panel-snapshot-client.ts'
import {
  useMstarPanelSnapshot,
  type MstarPanelSnapshotSeats,
  type MstarPanelView,
} from '../src/client/panel/use-mstar-panel-snapshot.ts'
import { gatewayError, gatewayOk, SESSION_CWD, SESSION_ID, stubGateway } from './gateway-stub.ts'

/** Every client a spec starts is disposed afterwards (no dangling poll timers). */
const started: MstarPanelSnapshotClient[] = []
afterEach(() => {
  while (started.length > 0) started.pop()!.dispose()
})

function clientOf(
  connection: MstarPanelSnapshotConnection | undefined,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): MstarPanelSnapshotClient {
  const client = new MstarPanelSnapshotClient(connection, options)
  started.push(client)
  return client
}

/** A minimal valid snapshot: the four read states, the retained block, no ledger. */
function snapshot(at: string, over: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    at,
    version: '4.0.4',
    harnessDir: '/proj/.mstar',
    enforcement: { hard: false, source: 'test' },
    workspace: {
      workflow: { state: 'not-applicable', reason: 'no selected workflow' },
      iteration: { state: 'not-applicable', reason: 'no selected iteration' },
      roadmap: { state: 'not-applicable', reason: 'no project resolved' },
      issues: { state: 'ok', data: { items: [], total: 0, storeRevision: 7 } },
      projects: { state: 'ok', data: { items: [], total: 0 } },
    },
    retained: { iterationGate: null, knowledge: null, selection: null },
    ledger: null,
    ...over,
  } as unknown as PanelSnapshot
}

/** The endpoint's `PanelSnapshotRead` answer for one snapshot. */
function readOk(value: PanelSnapshot) {
  return { kind: 'ok', snapshot: value }
}

/** Let the client's microtask + resolved-promise continuations run. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One render pass; the probe records the view the hook returned. */
const captured: { view: MstarPanelView | null } = { view: null }

function Probe({ seats }: { seats: MstarPanelSnapshotSeats }) {
  captured.view = useMstarPanelSnapshot(seats)
  return createElement('span', { 'data-state': captured.view.state })
}

/**
 * ONE render pass of the hook over the given seats.
 *
 * The first pass also starts the poll (the hook's gate), so a spec that wants
 * the SETTLED answer renders once, lets the microtask + interval run, and
 * renders again — exactly what a React re-render does when the client publishes
 * its snapshot.
 */
function render(seats: MstarPanelSnapshotSeats): MstarPanelView {
  captured.view = null
  renderToStaticMarkup(createElement(Probe, { seats }))
  if (captured.view === null) throw new Error('probe rendered no view')
  return captured.view
}

/** Seats over one client, visible by default. */
function seats(
  client: MstarPanelSnapshotClient | undefined,
  over: Partial<MstarPanelSnapshotSeats> = {},
): MstarPanelSnapshotSeats {
  return { visible: true, client, sessionId: SESSION_ID, cwd: SESSION_CWD, ...over }
}

describe('useMstarPanelSnapshot — visibility-gated polling (T4)', () => {
  it('1. no visible tab → no request is issued', async () => {
    const gateway = stubGateway(gatewayOk(readOk(snapshot('2026-10-22T01:00:00.000Z'))))
    const client = clientOf(gateway.connection, { pollIntervalMs: 5 })

    const view = render(seats(client, { visible: false }))
    await settle()

    expect(view.state).toBe('waiting')
    expect(gateway.calls).toHaveLength(0)
  })

  it('2. a visible tab polls at the declared interval', async () => {
    const gateway = stubGateway(gatewayOk(readOk(snapshot('2026-10-22T01:00:00.000Z'))))
    const client = clientOf(gateway.connection, { pollIntervalMs: 5 })

    render(seats(client))
    await settle()
    expect(gateway.calls).toHaveLength(1)
    expect(render(seats(client)).state).toBe('ok')

    // The poll is self-chained on completion: a few intervals produce more reads.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(gateway.calls.length).toBeGreaterThan(1)
    // The request shape: the shared `/api` gateway + the panel-snapshot method.
    expect(gateway.calls[0]!.channel).toBe('/api')
    expect(gateway.calls[0]!.endpoint).toBe('mstar/panelSnapshot')
    expect(gateway.calls[0]!.payload).toEqual({ args: { sessionId: SESSION_ID, cwd: SESSION_CWD } })
    // The production interval is the one named constant.
    expect(PANEL_POLL_INTERVAL_MS).toBe(5_000)
  })

  it('3. a slow answer never stacks a second in-flight request', async () => {
    const gateway = stubGateway()
    gateway.replyWith(() => new Promise(() => {}))
    const client = clientOf(gateway.connection, { pollIntervalMs: 5 })

    render(seats(client))
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(gateway.calls).toHaveLength(1)
    expect(render(seats(client)).state).toBe('loading')
  })

  it('4. a ledger invalidation refreshes immediately, outside the interval', async () => {
    const gateway = stubGateway(gatewayOk(readOk(snapshot('2026-10-22T01:00:00.000Z'))))
    // A one-minute interval: only the invalidation can explain a second read.
    const client = clientOf(gateway.connection, { pollIntervalMs: 60_000 })

    render(seats(client))
    await settle()
    expect(gateway.calls).toHaveLength(1)

    client.invalidate()
    await settle()
    expect(gateway.calls).toHaveLength(2)
  })

  it('5. a failed transport degrades to unavailable while keeping the last snapshot', async () => {
    const good = snapshot('2026-10-22T01:00:00.000Z')
    const gateway = stubGateway(gatewayOk(readOk(good)))
    const client = clientOf(gateway.connection, { pollIntervalMs: 0 })

    render(seats(client))
    await settle()
    expect(render(seats(client)).state).toBe('ok')

    // The next read fails: the refresh in flight keeps the last good snapshot
    // as `previous`, so the render never blanks to an empty panel.
    gateway.replyWith(() => gatewayError('gateway-down', 'the gateway is unreachable'))
    client.invalidate()
    const during = client.getSnapshot()
    expect(during.state).toBe('loading')
    if (during.state !== 'loading') throw new Error('expected loading')
    expect(during.previous?.at).toBe(good.at)

    await settle()
    const after = render(seats(client))
    expect(after.state).toBe('unavailable')
    if (after.state !== 'unavailable') throw new Error('expected unavailable')
    expect(after.reason).toBe('the gateway is unreachable')
    expect(after.snapshot).toBeNull()
  })
})

describe('useMstarPanelSnapshot — total degradation (T4)', () => {
  it('a composition with no client renders waiting, never a throw', () => {
    expect(render(seats(undefined)).state).toBe('waiting')
  })

  it('an unknown workspace directory polls nothing', async () => {
    const gateway = stubGateway(gatewayOk(readOk(snapshot('2026-10-22T01:00:00.000Z'))))
    const client = clientOf(gateway.connection, { pollIntervalMs: 5 })

    expect(render(seats(client, { cwd: null })).state).toBe('waiting')
    await settle()
    expect(gateway.calls).toHaveLength(0)
  })

  it('a throwing transport becomes an unavailable reason, not a crash', async () => {
    const throwing: MstarPanelSnapshotConnection = {
      rpc: {
        call(): Promise<never> {
          throw new Error('socket gone')
        },
      },
    }
    const client = clientOf(throwing, { pollIntervalMs: 0 })

    render(seats(client))
    await settle()
    const view = render(seats(client))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toContain('socket gone')
  })

  it('a valid snapshot that says "empty" is DATA, never unavailable', async () => {
    const empty = snapshot('2026-10-22T01:00:00.000Z')
    const gateway = stubGateway(gatewayOk(readOk(empty)))
    const client = clientOf(gateway.connection, { pollIntervalMs: 0 })

    render(seats(client))
    await settle()
    const view = render(seats(client))
    expect(view.state).toBe('ok')
    if (view.state !== 'ok') throw new Error('expected ok')
    expect(view.snapshot.at).toBe(empty.at)
  })

  it('the host refusal is surfaced verbatim', async () => {
    const gateway = stubGateway(gatewayOk({ kind: 'unavailable', reason: 'store.not-active: store is staged' }))
    const client = clientOf(gateway.connection, { pollIntervalMs: 0 })

    render(seats(client))
    await settle()
    const view = render(seats(client))
    expect(view.state).toBe('unavailable')
    if (view.state !== 'unavailable') throw new Error('expected unavailable')
    expect(view.reason).toBe('store.not-active: store is staged')
  })
})
