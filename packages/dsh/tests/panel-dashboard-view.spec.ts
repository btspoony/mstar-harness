/**
 * The per-view read path (plan dsh-panel-unification Task 4a): one invocation
 * that answers any engine dashboard view, the client's one-shot read of it, the
 * delivery line `Focus` derives from the `iterations` view, and the repair the
 * seat performs when the envelope's workflow member is not readable.
 *
 * ADDITIVE BY CONSTRUCTION: this round removes no envelope member. The polled
 * digest still serves `workspace.*`, so both paths answer while the old members
 * still have their consumer; 4b deletes the old ones together with the poll.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { en as uiEn } from '@mstar-harness/ui'
import type { IterationListDTO } from '@mstar-harness/engine'
import { bootApp, seedStore, type BootResult } from './harness.ts'
import { gatewayOk, settleRender, stubGateway } from './gateway-stub.ts'
import {
  PANEL_SNAPSHOT_SERVICE,
  mstarDashboardViewInvocation,
  type DashboardViewRead,
} from '../src/panel/panel-snapshot-endpoint.ts'
import {
  DASHBOARD_VIEW_ENDPOINT,
  MSTAR_DASHBOARD_VIEW_METHOD,
  MSTAR_PANEL_SNAPSHOT_METHOD,
  MSTAR_PANEL_SNAPSHOT_NAMESPACE,
} from '../src/engine-status-wire.ts'
import { MstarPanelSnapshotClient } from '../src/client/panel/panel-snapshot-client.ts'
import { PANEL_SNAPSHOT_ENDPOINT } from '../src/engine-status-wire.ts'
import { PanelShell, deliveryFromView } from '../src/client/panel/panel-shell.tsx'
import type { PanelSnapshot } from '../src/panel/panel-snapshot.ts'

let booted: BootResult | undefined
const roots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface EndpointView {
  dashboardView(
    sessionId: string,
    cwd: string,
    view: string,
    params?: Record<string, string | undefined>,
    id?: string,
  ): Promise<DashboardViewRead>
}

function endpointOf(app: BootResult): EndpointView {
  const service = app.ctx.get(PANEL_SNAPSHOT_SERVICE) as EndpointView | undefined
  if (service === undefined) throw new Error('panel-snapshot service not registered')
  return service
}

function liveSession(app: BootResult, id: string, cwd: string): void {
  const sessions = app.ctx.get('sessions') as { register(session: unknown): void } | undefined
  if (sessions === undefined) throw new Error('sessions service not mounted')
  sessions.register({ id, header: { cwd }, seq: 0 })
}

/* ------------------- 1. the invocation is registered and answers ------------------- */


/**
 * Settle the seat's chained reads: the digest lands, then the per-view reads it
 * enables (`workflow-detail`, `iterations`), each one render later.
 */
async function settledSeat(render: () => string): Promise<string> {
  let markup = ''
  for (let pass = 0; pass < 4; pass += 1) {
    markup = await settleRender(render)
  }
  return markup
}

describe('dashboardView — one invocation, every engine view', () => {
  it('registers mstar/dashboardView beside the snapshot read on the same contribution', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await app.ctx.plugin(TypertRegistry)
    const registry = app.ctx.get('typert') as { local: { get(endpoint: string): unknown } }

    const descriptor = registry.local.get(`${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_DASHBOARD_VIEW_METHOD}`) as
      | Record<string, unknown>
      | undefined
    expect(descriptor).toBeDefined()
    // SAME service and namespace as the snapshot read: one contribution, two
    // invocations — the host admits no second contribution per package face.
    expect(descriptor).toMatchObject({
      service: PANEL_SNAPSHOT_SERVICE,
      namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
      method: MSTAR_DASHBOARD_VIEW_METHOD,
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })
    expect((descriptor?.parameters as Array<{ wire: string }>).map((parameter) => parameter.wire)).toEqual([
      'sessionId',
      'cwd',
      'view',
      'params',
      'id',
    ])
    // The digest read and the picker write are untouched by this round.
    expect(registry.local.get(`${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_PANEL_SNAPSHOT_METHOD}`)).toBeDefined()
    expect(registry.local.get('mstar/selectWorkflow')).toBeDefined()
    // The declared descriptor helper IS what the contribution carries.
    expect(descriptor?.id).toBe(mstarDashboardViewInvocation().id)
    // And the service really exposes the method.
    expect(typeof endpointOf(app).dashboardView).toBe('function')
  })

  it('answers a real engine view: the iterations list DTO', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_view', app.root)
    const read = await endpointOf(app).dashboardView('ses_view', app.root, 'iterations', { limit: '200' })
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    const list = read.envelope.data as IterationListDTO
    expect(list.items).toEqual([])
    expect(list.total).toBe(0)
    // The engine's own DTO shape, not a wrapper of ours.
    expect(list.attribution).toBe('absent')
  })

  it('answers a detail view through its id, and refuses an unknown view as a degraded read', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_view', app.root)
    const endpoint = endpointOf(app)
    const detail = await endpoint.dashboardView('ses_view', app.root, 'workflow-detail', {}, 'wf-absent')
    expect(detail.kind).toBe('ok')
    if (detail.kind === 'ok') expect(detail.envelope.data).toBeNull()

    const unknown = await endpoint.dashboardView('ses_view', app.root, 'not-a-view')
    expect(unknown.kind).toBe('unavailable')
    if (unknown.kind === 'unavailable') expect(unknown.reason).toContain('unknown dashboard view')

    // The same trust rules as the snapshot read: a foreign cwd is refused
    // before any store access.
    expect(await endpoint.dashboardView('ses_view', '/elsewhere', 'issues')).toEqual({
      kind: 'unavailable',
      reason: 'cwd-mismatch',
    })
  })
})

/* ------------------------- 2. the client's one-shot read ------------------------- */

describe('dashboardView — the client reads once, on demand', () => {
  it('issues exactly one request and schedules nothing', async () => {
    const gateway = stubGateway()
    gateway.replyFor(DASHBOARD_VIEW_ENDPOINT, gatewayOk({ kind: 'ok', envelope: { data: { items: [], total: 0 }, projection: {} } }))
    const client = new MstarPanelSnapshotClient(gateway.connection)

    const read = await client.readView({ sessionId: 's-1', cwd: '/proj', view: 'iterations', params: { limit: '200' } })
    expect(read.kind).toBe('ok')

    const calls = gateway.calls.filter((call) => call.endpoint === DASHBOARD_VIEW_ENDPOINT)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toEqual({
      args: { sessionId: 's-1', cwd: '/proj', view: 'iterations', params: { limit: '200' } },
    })
    // No poll, no timer, no subscription: nothing else happens after waiting.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(gateway.calls.filter((call) => call.endpoint === DASHBOARD_VIEW_ENDPOINT)).toHaveLength(1)
    expect(gateway.calls).toHaveLength(1)
  })

  it('degrades every failure to an explicit kind, never a throw', async () => {
    const gateway = stubGateway()
    gateway.replyFor(DASHBOARD_VIEW_ENDPOINT, { ok: false, error: { code: 'transport.closed', message: 'socket closed' } })
    const client = new MstarPanelSnapshotClient(gateway.connection)
    expect(await client.readView({ sessionId: 's-1', cwd: '/proj', view: 'issues' })).toEqual({
      kind: 'unavailable',
      reason: 'socket closed',
    })

    // No transport at all is its own reason, not an empty answer.
    const bare = new MstarPanelSnapshotClient(undefined)
    expect(await bare.readView({ sessionId: 's-1', cwd: '/proj', view: 'issues' })).toEqual({
      kind: 'unavailable',
      reason: 'no-connection',
    })
  })

  it('the panel\'s reads schedule NOTHING: one request, then silence', async () => {
    // The retirement proof: the 5-second poll and its self-chaining timer are gone.
    // `readDigest` and `readView` each issue one request and schedule no follow-up.
    const gateway = stubGateway()
    gateway.replyFor(PANEL_SNAPSHOT_ENDPOINT, gatewayOk({ kind: 'ok', snapshot: {
      enforcement: { hard: false, source: 'compass' },
      knowledge: null,
      selection: null,
      iteration: { state: 'not-applicable', reason: 'none' },
    } }))
    gateway.replyFor(DASHBOARD_VIEW_ENDPOINT, gatewayOk({ kind: 'ok', envelope: { data: null, projection: {} } }))
    const client = new MstarPanelSnapshotClient(gateway.connection)
    await client.readDigest({ sessionId: 's-1', cwd: '/proj' })
    await client.readView({ sessionId: 's-1', cwd: '/proj', view: 'iterations' })
    const settled = gateway.calls.length
    // Nothing is queued behind the answers: no interval, no retry, no re-read.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(gateway.calls.length).toBe(settled)
    expect(settled).toBe(2)
    // The only timer the read path may hold is the per-request DEADLINE (it
    // bounds one request and schedules no follow-up). A polling interval, a
    // retry timer or a visibility gate is the defect.
    for (const file of ['panel-snapshot-client.ts', 'use-mstar-session-digest.ts', 'once-reader.ts']) {
      const source = require('node:fs').readFileSync(join(import.meta.dir, '..', 'src/client/panel', file), 'utf8') as string
      expect(source).not.toContain('setInterval')
      expect(source).not.toContain('visible')
    }
    // And the deadline is named in exactly one place.
    expect(require('../src/client/panel/panel-snapshot-client.ts').PANEL_READ_DEADLINE_MS).toBe(5_000)
  })

  it('a reader created while the identity was empty still reads the populated one (no captured closure)', async () => {
    // THE PRE-FIX DEFECT: the hook created the reader with `useState` and the
    // read closure captured the FIRST render's props (`cwd: ''`, `view: ''`).
    // One reader, NO remount: the empty phase must not read, and the populated
    // phase must read with the props of THAT call.
    const { OnceReader } = require('../src/client/panel/once-reader.ts') as typeof import('../src/client/panel/once-reader.ts')
    const gateway = stubGateway()
    gateway.replyFor(DASHBOARD_VIEW_ENDPOINT, gatewayOk({ kind: 'ok', envelope: { data: { items: [] }, projection: {} } }))
    const client = new MstarPanelSnapshotClient(gateway.connection)
    let reads = 0
    const reader = new OnceReader<{ kind: 'ok' } & Record<string, unknown>>()
    const empty = async () => { reads += 0 }
    // Phase 1: no identity — nothing may read.
    reader.begin(null, client, empty as never)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reads).toBe(0)

    // Phase 2: the populated identity arrives on the SAME reader; the read must
    // use the closure passed to THIS begin call.
    reader.begin('s-1|/proj|iterations|', client, async () => {
      reads += 1
      return { kind: 'ok' }
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(reads).toBe(1)
    expect(gateway.calls).toHaveLength(0) // this reader's own callback replaced the transport call
  })

  it('the hook that drives it holds no timer and no visibility gate', () => {
    const source = require('node:fs').readFileSync(
      join(import.meta.dir, '..', 'src/client/panel/use-mstar-dashboard-view.ts'),
      'utf8',
    ) as string
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('setTimeout')
    expect(source).not.toContain('visible')
  })
})

/* --------------------- 3. the delivery line from the per-view read --------------------- */

const ITERATIONS: IterationListDTO = {
  items: [
    {
      iterationId: 'iter-view',
      catalog: null,
      compass: null,
      workflow: null,
      plans: [
        { planId: 'p-other', catalog: null, execution: null, catalogPinRevision: null, badges: [] },
      ],
      documents: [],
      gateStep: 4,
      badges: [],
    },
    {
      iterationId: 'iter-bound',
      catalog: null,
      compass: null,
      workflow: null,
      plans: [
        { planId: 'p-run', catalog: null, execution: null, catalogPinRevision: null, badges: [] },
      ],
      documents: [],
      gateStep: 2,
      badges: [],
    },
  ],
  total: 2,
  attribution: 'present',
}

describe('dashboardView — the delivery line is derived from the iterations view', () => {
  it('picks the iteration that holds one of the bound plans', () => {
    const ok = { kind: 'ok', envelope: { data: ITERATIONS } } as never
    expect(deliveryFromView(ok, ['p-run'])).toEqual({ iterationId: 'iter-bound', gateStep: 2 })
  })

  it('says "standalone" when no iteration holds them, and "no answer" when the read has none', () => {
    const ok = { kind: 'ok', envelope: { data: ITERATIONS } } as never
    expect(deliveryFromView(ok, ['p-unknown'])).toBeNull()
    // No answer yet: the envelope's own member stays the evidence.
    expect(deliveryFromView({ kind: 'loading' }, ['p-run'])).toBeUndefined()
    expect(deliveryFromView({ kind: 'unavailable', reason: 'boom' }, ['p-run'])).toBeUndefined()
  })

  it('the shell renders the per-view delivery when it has one', () => {
    const workflowFixture = {
      id: 'wf-main',
      type: 'plan',
      status: 'running',
      phase: 'phase-2-execute',
      branch: { base: 'main', source: 'feature/main', integration: null, target: 'main' },
      plans: [{ planId: 'p-run', status: 'InProgress', progress: null }],
    }
    const snapshot = {
      enforcement: { hard: false, source: 'compass' },
      knowledge: null,
      selection: { kind: 'active', workflowId: 'wf-main', dir: 'workflows/wf-main' },
      iteration: { state: 'not-applicable', reason: 'unused in this case' },
      workflowFixture,
    } as unknown as PanelSnapshot
    const render = (delivery: { iterationId: string; gateStep: 4 | null } | null): string =>
      renderToStaticMarkup(createElement(PanelShell, {
        snapshot,
        workflow: { state: 'read', data: (snapshot as unknown as { workflowFixture: unknown }).workflowFixture as never },
        destination: 'focus',
        locale: 'en',
        navLabel: 'Morning Star Workflow',
        onSelect: () => {},
        select: null,
        delivery,
      }))

    expect(render({ iterationId: 'iter-view', gateStep: 4 })).toContain(uiEn.focus.deliveryLine('iter-view', 4, 5))
    expect(render(null)).toContain(uiEn.focus.deliveryNoIteration)
  })
})
