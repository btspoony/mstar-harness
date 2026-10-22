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
    // Under a loaded event loop the 5 ms interval can already have ticked again,
    // so this counts "at least the first read", not "exactly one".
    expect(gateway.calls.length).toBeGreaterThanOrEqual(1)
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

/**
 * The in-flight guard (QC round 1, F2): a refresh demanded DURING a request
 * must survive it. Dropping the demand left the panel with no timer and no
 * request — frozen on a snapshot it should no longer show.
 */
describe('useMstarPanelSnapshot — the in-flight guard never swallows a refresh (F2)', () => {
  /** A gateway whose FIRST answer hangs until the spec releases it. */
  function heldGateway(firstAnswer: { resolve(value: unknown): void }): ReturnType<typeof stubGateway> {
    const gateway = stubGateway()
    let calls = 0
    gateway.replyWith(() => {
      calls += 1
      return calls === 1
        ? new Promise((resolve) => { firstAnswer.resolve = resolve })
        : gatewayOk(readOk(snapshot('2026-10-22T02:00:00.000Z')))
    })
    return gateway
  }

  it('(a) a refresh demanded during a read is served on settle (collapse → expand)', async () => {
    const hold: { resolve(value: unknown): void } = { resolve: () => {} }
    const gateway = heldGateway(hold)
    const client = clientOf(gateway.connection, { pollIntervalMs: 60_000 })

    // Read #1 goes out and stays in flight.
    render(seats(client))
    await settle()
    expect(gateway.calls).toHaveLength(1)

    // The sidebar collapses and expands in one tap: stop() → start().
    client.stop()
    render(seats(client, { visible: false }))
    render(seats(client))
    await settle()
    // The guard kept the second demand from stacking a request…
    expect(gateway.calls).toHaveLength(1)

    // …and read #1 now lands on a STALE target: discarded, but it must not
    // take the demanded refresh with it.
    hold.resolve(gatewayOk(readOk(snapshot('2026-10-22T02:00:00.000Z'))))
    await settle()
    expect(gateway.calls).toHaveLength(2)

    // And the panel is live again: the new answer is rendered.
    const view = render(seats(client))
    expect(view.state).toBe('ok')
    if (view.state !== 'ok') throw new Error('expected ok')
    expect(view.snapshot.at).toBe('2026-10-22T02:00:00.000Z')
  })

  it('(b) a session switch mid-read asks for the NEW target and never renders the old data', async () => {
    const mine = snapshot('2026-10-22T01:00:00.000Z')
    const other = snapshot('2026-10-22T02:00:00.000Z')
    const hold: { resolve(value: unknown): void } = { resolve: () => {} }
    const gateway = stubGateway()
    let phase = 0
    gateway.replyWith(() => {
      phase += 1
      if (phase === 1) return gatewayOk(readOk(mine))
      if (phase === 2) return new Promise((resolve) => { hold.resolve = resolve })
      return gatewayOk(readOk(other))
    })
    const client = clientOf(gateway.connection, { pollIntervalMs: 60_000 })

    // Session A's workspace renders.
    render(seats(client))
    await settle()
    expect(render(seats(client)).state).toBe('ok')

    // A second read (session A) hangs.
    client.invalidate()
    await settle()
    expect(gateway.calls).toHaveLength(2)

    // The tab now belongs to session B while read #2 is still out.
    render(seats(client, { sessionId: 's-2' }))
    await settle()
    // The previous session's snapshot is NOT renderable: the view was reset.
    const during = client.getSnapshot()
    expect(during.state).toBe('loading')
    if (during.state !== 'loading') throw new Error('expected loading')
    expect(during.previous).toBeNull()

    // Read #2 lands for the OLD target: discarded, and the refresh it blocked
    // is issued for session B.
    hold.resolve(gatewayOk(readOk(mine)))
    await settle()

    expect(gateway.calls).toHaveLength(3)
    expect(gateway.calls[2]!.payload).toEqual({ args: { sessionId: 's-2', cwd: SESSION_CWD } })
    const view = render(seats(client, { sessionId: 's-2' }))
    expect(view.state).toBe('ok')
    if (view.state !== 'ok') throw new Error('expected ok')
    expect(view.snapshot.at).toBe(other.at)
  })
})

describe('useMstarPanelSnapshot — no harness is its own state (F3)', () => {
  it('a no-harness answer renders no-harness, never an unavailable reason token', async () => {
    const gateway = stubGateway(gatewayOk({ kind: 'no-harness' }))
    const client = clientOf(gateway.connection, { pollIntervalMs: 0 })

    render(seats(client))
    await settle()
    const view = render(seats(client))
    expect(view.state).toBe('no-harness')
    expect(view.snapshot).toBeNull()
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
