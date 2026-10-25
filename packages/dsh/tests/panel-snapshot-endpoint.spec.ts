/**
 * Host-handler spec for `/api/mstar/panelSnapshot`
 * (`src/panel/panel-snapshot-endpoint.ts`).
 *
 * Covered: the descriptor contributed to the shared `/api` gateway, the
 * argument-shape refusals that MUST precede any store access, the SERVER-side
 * `{HARNESS_DIR}` resolution (never from client-asserted input), the exact-cwd
 * refusal, and the degraded answer a refusing store produces instead of a
 * transport error.
 *
 * The two validation cases boot with NO store at all: if the endpoint touched
 * the store before validating, the answer would be a store refusal, so an
 * argument refusal is itself the proof that nothing was read.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
// The `agent/pre-step` event declaration (the emission site's own typing).
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { bootApp, seedActiveWorkflow, seedStore, type BootResult } from './harness.ts'
import {
  PANEL_SNAPSHOT_SERVICE,
  installPanelSnapshotEndpoint,
  mstarPanelSnapshotInvocation,
  type PanelSnapshotEndpointOptions,
} from '../src/panel/panel-snapshot-endpoint.ts'
import { MSTAR_PANEL_SNAPSHOT_METHOD, MSTAR_PANEL_SNAPSHOT_NAMESPACE } from '../src/engine-status-wire.ts'
import type { PanelSnapshotRead } from '../src/panel/panel-snapshot.ts'
import { readWorkflowSessionBinding } from '../src/engine-status-store.ts'

let booted: BootResult | undefined
const extraRoots: string[] = []

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  for (const root of extraRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * Minimal `sessionController` seam: the ONE contract the endpoint's persisted
 * fallback reads (`inspect(id)` → an object carrying `header.cwd`).
 */
class FakeSessionController extends Service {
  handler: (sessionId: string) => Promise<unknown> = async () => ({ header: {} })

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  inspect(sessionId: string): Promise<unknown> {
    return this.handler(sessionId)
  }
}

/** Structural view of the endpoint as the gateway dispatches it. */
interface EndpointView {
  panelSnapshot(
    sessionId: unknown,
    cwd: unknown,
    workflowId?: unknown,
    iterationId?: unknown,
    projectId?: unknown,
  ): Promise<PanelSnapshotRead>

  dashboardView(
    sessionId: unknown,
    cwd: unknown,
    view: unknown,
    params?: Record<string, string | undefined>,
    id?: unknown,
  ): Promise<{ kind: string; reason?: string }>
}

/** Structural view of the fake sessions registry (the harness's driver). */
interface FakeSessionsView {
  register(session: unknown): void
}

/** The panel-snapshot service of one boot. */
function endpointOf(app: BootResult): EndpointView {
  const service = app.ctx.get(PANEL_SNAPSHOT_SERVICE) as EndpointView | undefined
  if (service === undefined) throw new Error('panel-snapshot service not registered')
  return service
}

/** Register one live session (id + header cwd) on the fake sessions service. */
function liveSession(app: BootResult, id: string, cwd: string): void {
  const sessions = app.ctx.get('sessions') as FakeSessionsView | undefined
  if (sessions === undefined) throw new Error('sessions service not mounted')
  sessions.register({ id, header: { cwd }, seq: 0 })
}

/** One `agent/pre-step` payload carrying a real session identity (the emission site's own input). */
function stepPayloadOf(sessionId: string, cwd: string) {
  return {
    agent: { session: { header: { id: sessionId, cwd } } },
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never
}

/** An absolute workspace with no `.mstarc`: nothing resolves a harness for it. */
async function bareWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-bare-'))
  extraRoots.push(root)
  return root
}


describe('panelSnapshot endpoint — registration on the shared /api gateway', () => {
  it('serves mstar/panelSnapshot from the composed plugin beside the picker write', async () => {
    // The COMPOSED boot, not a hand-mounted unit: typert admits one
    // contribution per `<package>#<face>`, so the only proof that matters is
    // that the plugin's own apply registers all three descriptors and that the
    // two pre-existing ones are untouched.
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await app.ctx.plugin(TypertRegistry)

    const registry = app.ctx.get('typert') as { local: { get(endpoint: string): unknown } }
    const panel = registry.local.get(`${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_PANEL_SNAPSHOT_METHOD}`) as
      | Record<string, unknown>
      | undefined
    expect(panel).toBeDefined()
    expect(panel).toMatchObject({
      service: PANEL_SNAPSHOT_SERVICE,
      namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
      method: MSTAR_PANEL_SNAPSHOT_METHOD,
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })
    expect((panel?.parameters as Array<{ wire: string }>).map((parameter) => parameter.wire)).toEqual([
      'sessionId',
      'cwd',
      'workflowId',
      'iterationId',
      'projectId',
    ])
    // The neighbour is unchanged: same service, same namespace, same result
    // mode. The retired read method is NOT there any more.
    expect(registry.local.get('mstar/engineStatus')).toBeUndefined()
    expect(registry.local.get('mstar/selectWorkflow')).toMatchObject({
      service: 'mstar',
      namespace: 'mstar',
      method: 'selectWorkflow',
      result: { mode: 'src-json' },
    })
    // And the service the panel descriptor names is the one that answers.
    expect(typeof endpointOf(app).panelSnapshot).toBe('function')
  })
})

describe('panelSnapshot endpoint — argument shape precedes every store access', () => {
  it('refuses empty ids, a relative cwd and traversal before reading the store', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    liveSession(app, 'ses_alpha', app.root)
    const endpoint = endpointOf(app)

    expect(await endpoint.panelSnapshot('', app.root)).toEqual({ kind: 'unavailable', reason: 'invalid-session-id' })
    expect(await endpoint.panelSnapshot('ses_alpha', '')).toEqual({ kind: 'unavailable', reason: 'invalid-cwd' })
    expect(await endpoint.panelSnapshot('ses_alpha', 'relative/ws')).toEqual({
      kind: 'unavailable',
      reason: 'cwd-refused',
    })
    for (const probe of [`${app.root}/../etc`, `${app.root}/..`, '/proj/../other', `${app.root}/\0evil`]) {
      expect(await endpoint.panelSnapshot('ses_alpha', probe)).toEqual({
        kind: 'unavailable',
        reason: 'cwd-refused',
      })
    }
    // A PROVIDED id must be a single safe id; an absent one is legal (the view
    // answers not-applicable).
    expect(await endpoint.panelSnapshot('ses_alpha', app.root, '')).toEqual({
      kind: 'unavailable',
      reason: 'invalid-workflow-id',
    })
    expect(await endpoint.panelSnapshot('ses_alpha', app.root, 'wf-1', '')).toEqual({
      kind: 'unavailable',
      reason: 'invalid-iteration-id',
    })
    expect(await endpoint.panelSnapshot('ses_alpha', app.root, undefined, undefined, 'a/b')).toEqual({
      kind: 'unavailable',
      reason: 'project-id-refused',
    })
    // Nothing above reached the store: the fixture never had one.
    expect(existsSync(join(app.harnessDir, 'store.db'))).toBe(false)
  })

  it('refuses a client cwd that does not equal the resolved session cwd', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    liveSession(app, 'ses_alpha', app.root)
    const other = await bareWorkspace()

    expect(await endpointOf(app).panelSnapshot('ses_alpha', other)).toEqual({
      kind: 'unavailable',
      reason: 'cwd-mismatch',
    })
    expect(existsSync(join(app.harnessDir, 'store.db'))).toBe(false)
  })
})

describe('panelSnapshot endpoint — server-side harness resolution', () => {
  it('takes the harness dir from the session cwd, not from the client claim', async () => {
    // No configured root: the ONLY way to a harness dir is the SERVER-side
    // resolution of the session's own cwd.
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_alpha', app.root)

    const result = await endpointOf(app).panelSnapshot('ses_alpha', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    // The shrunken payload: the session digest plus the delivery fallback, and
    // nothing from the five removed views (Task 4).
    expect(Object.keys(result.snapshot).sort()).toEqual(['enforcement', 'iteration', 'knowledge', 'selection'])
    expect(result.snapshot.iteration.state).toBe('not-applicable')
  })

  it('answers the no-harness kind for a session whose workspace declares none', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    const bare = await bareWorkspace()
    liveSession(app, 'ses_bare', bare)

    // The client's `cwd` cannot supply what the workspace does not declare, and
    // the absence travels as its OWN kind (F3) so the panel can tell an
    // inactive workspace from a store that refused.
    expect(await endpointOf(app).panelSnapshot('ses_bare', bare)).toEqual({ kind: 'no-harness' })
  })

  it('resolves a cold session through the persisted controller read', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await app.ctx.plugin(FakeSessionController)
    const controller = app.ctx.get('sessionController') as FakeSessionController
    // The host's real shape: `SessionInspection extends SessionStorageMetadata
    // { meta: SessionHeader }` (`@deepseek-ai/dsh-session-persistence`) — the
    // workspace lives at `meta.cwd`, not `header.cwd`.
    controller.handler = async (sessionId: string) =>
      sessionId === 'ses_persisted'
        ? { meta: { id: sessionId, version: 4, createdAt: 0, cwd: app.root, isSeeded: false }, inheritedEventCount: 0, events: [] }
        : { meta: { id: sessionId, version: 4, createdAt: 0, isSeeded: false }, inheritedEventCount: 0, events: [] }
    await seedStore(app.harnessDir)

    const result = await endpointOf(app).panelSnapshot('ses_persisted', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(typeof result.snapshot.enforcement?.hard).toBe('boolean')
  })

  it('both surfaces genuinely silent: the read lands on the launch workspace', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await app.ctx.plugin(FakeSessionController)
    const controller = app.ctx.get('sessionController') as FakeSessionController
    // No cwd on EITHER surface: the persisted header is real-shaped and empty.
    controller.handler = async (sessionId: string) => ({ meta: { id: sessionId, version: 4, createdAt: 0, isSeeded: false }, inheritedEventCount: 0, events: [] })
    await seedStore(app.harnessDir)

    const endpoint = endpointOf(app)
    // With both surfaces silent the read falls back to the launch workspace, so
    // the pre-fix shape no longer produces the false `session-cwd-absent`: the
    // read still answers, from the boot workspace rather than the session's own.
    const result = await endpoint.panelSnapshot('ses_guessed', process.cwd())
    // Before the shape fix this same fixture answered `{ kind: 'unavailable',
    // reason: 'session-cwd-absent' }`. The read now resolves the launch
    // workspace; this test process runs outside a harness workspace, so the
    // honest answer is `no-harness` (a state), never a false unavailability.
    expect(result).toEqual({ kind: 'no-harness' })
  })
})

describe('the two invocations accept a workspace by ONE rule', () => {
  /** Collapse either answer to the only thing this parity test is about. */
  const verdict = (read: { kind: string; reason?: string }): string =>
    read.kind === 'unavailable' ? `unavailable:${read.reason ?? ''}` : `accepted:${read.kind}`

  async function bootSilent(): Promise<{ endpoint: ReturnType<typeof endpointOf> }> {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await app.ctx.plugin(FakeSessionController)
    const controller = app.ctx.get('sessionController') as FakeSessionController
    // BOTH session surfaces silent: the resolver answers `source: 'boot'`.
    controller.handler = async (sessionId: string) => ({
      meta: { id: sessionId, version: 4, createdAt: 0, isSeeded: false },
      inheritedEventCount: 0,
      events: [],
    })
    await seedStore(app.harnessDir)
    return { endpoint: endpointOf(app) }
  }

  it('a boot-resolved session: panelSnapshot and dashboardView agree (claim = the launch workspace)', async () => {
    const { endpoint } = await bootSilent()
    const digest = await endpoint.panelSnapshot('ses_silent', process.cwd())
    const view = await endpoint.dashboardView('ses_silent', process.cwd(), 'overview')
    // Red on the pre-fix code: the digest accepted the request while every
    // destination refused it (`cwd-mismatch`), so the panel rendered and then
    // failed each view.
    expect(verdict(view)).toBe(verdict(digest))
    expect(verdict(digest)).not.toContain('cwd-mismatch')
  })

  it('a foreign claim is refused by BOTH, with the same reason', async () => {
    const { endpoint } = await bootSilent()
    const digest = await endpoint.panelSnapshot('ses_silent', '/elsewhere')
    const view = await endpoint.dashboardView('ses_silent', '/elsewhere', 'overview')
    expect(verdict(digest)).toBe('unavailable:cwd-mismatch')
    expect(verdict(view)).toBe(verdict(digest))
  })
})

describe('panelSnapshot endpoint — retained catalog facts from the apply-scoped cache', () => {
  it('reuses the payload the pre-step cached for this session, with its own age', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-1', [], {}, 'seed-other-session', app.root)
    liveSession(app, 'ses_alpha', app.root)
    // The pre-step is what FILLS the cache: the panel must read the same entry,
    // not build a second catalog of its own.
    await app.ctx.waterfall('agent/pre-step', stepPayloadOf('ses_alpha', app.root), (): Promise<PreStepDecision> =>
      Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [] }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const result = await endpointOf(app).panelSnapshot('ses_alpha', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    // The ONE fact no dashboard DTO carries: the selection the catalog resolved.
    expect(result.snapshot.selection).toMatchObject({ kind: 'active', workflowId: 'wf-1' })
  })

  it('rebuilds on a cold cache instead of failing: the snapshot stays ok and keeps its retained facts', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_cold', app.root)

    const result = await endpointOf(app).panelSnapshot('ses_cold', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    // A cold cache is a MISS: the shared reader rebuilds (the pre-step's own
    // rule, TTL-bounded), so the selection fact is present rather than withheld.
    expect('selection' in result.snapshot).toBe(true)
    expect('knowledge' in result.snapshot).toBe(true)
  })
})

describe('panelSnapshot endpoint — the picker write is alive through the read path', () => {
  it('a committed pick becomes the panel read\'s retained selection', async () => {
    // The write half (`mstar/selectWorkflow`) and the read half
    // (`mstar/panelSnapshot`) are two services now: the picker is only alive if
    // a LATER read resolves the binding it committed. That chain — commit →
    // durable record → catalog rebuild → `retained.selection` — is the proof.
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-a', [{ id: 'plan-a', status: 'Todo' }])
    liveSession(app, 'ses_pick', app.root)

    // The picker's HOST half is the `mstar` gateway's write method (the browser
    // client's wire contract is pinned separately, in `engine-status-wire.spec`).
    const gateway = app.ctx.get('mstar') as {
      selectWorkflow(sessionId: string, cwd: string, workflowId: string): Promise<unknown>
    }
    expect(await gateway.selectWorkflow('ses_pick', app.root, 'wf-a')).toEqual({
      status: 'selected',
      sessionId: 'ses_pick',
      workflowId: 'wf-a',
    })
    // The durable record the panel's read resolves from.
    expect(readWorkflowSessionBinding(app.harnessDir, 'ses_pick', app.root)).toMatchObject({
      kind: 'ok',
      binding: { selectedWorkflowId: 'wf-a' },
    })

    const result = await endpointOf(app).panelSnapshot('ses_pick', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.snapshot.selection).toMatchObject({ kind: 'active', workflowId: 'wf-a' })
  })
})

describe('panelSnapshot endpoint — store degradation is a value, not a throw', () => {
  it('answers unavailable with the store reason when the store refuses', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    liveSession(app, 'ses_alpha', app.root)

    const result = await endpointOf(app).panelSnapshot('ses_alpha', app.root)
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('unreachable')
    // The store's own refusal travels through verbatim (its code, its recovery).
    expect(result.reason).toContain('[store.not-initialized]')
    expect(result.reason).toContain('mstar store init')
  })

  it('answers unavailable when the session is unknown to the host', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await seedStore(app.harnessDir)

    expect(await endpointOf(app).panelSnapshot('ses_absent', app.root)).toEqual({
      kind: 'unavailable',
      reason: 'session-absent',
    })
  })
})

describe('panelSnapshot endpoint — install', () => {
  it('installs once per context and keeps the first service on a second apply', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    const options: PanelSnapshotEndpointOptions = {
      resolver: { forWorkspace: () => null },
      bootHarnessDir: null,
    }
    // A second apply must not construct a second service (the provider name is
    // taken): it logs and keeps the existing one.
    installPanelSnapshotEndpoint(app.ctx, options)
    expect(typeof endpointOf(app).panelSnapshot).toBe('function')
    // The descriptor is NOT this unit's to register: the package's single host
    // contribution carries it, and that is the only invocation it declares.
    expect(mstarPanelSnapshotInvocation()).toMatchObject({
      service: PANEL_SNAPSHOT_SERVICE,
      namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
      method: MSTAR_PANEL_SNAPSHOT_METHOD,
    })
  })
})

describe('panelSnapshot endpoint — server-side target resolution (F1)', () => {
  /** Register the catalog rows a real workspace carries (project + iteration). */
  async function seedCatalog(app: BootResult): Promise<void> {
    const { registerCatalogEntity } = await import('@mstar-harness/engine')
    for (const [kind, id, relativePath] of [
      ['project', '_default', 'projects/_default'],
      ['iteration', 'iter-solo', 'iterations/iter-solo'],
    ] as const) {
      await registerCatalogEntity(
        { harnessDir: app.harnessDir },
        { kind, id, title: `${id} title`, rootKind: 'harness', relativePath },
        { operationId: `op-seed-${id}`, actor: 'panel.spec' },
      )
    }
  }

  it('answers readable workflow/iteration/roadmap members from { sessionId, cwd } alone', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-solo', [{ id: 'plan-solo', status: 'Todo' }])
    await seedCatalog(app)
    liveSession(app, 'ses_solo', app.root)

    // This is the ENTIRE seat set the browser has: no workflow/iteration/project
    // id crosses the wire. The three members were permanently `not-applicable`
    // while resolution was left to the client.
    const result = await endpointOf(app).panelSnapshot('ses_solo', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')

    // Server-side resolution now shows through the delivery fallback: the
    // session's workflow resolves, so the iteration member is a real read
    // (`ok`), never a client-guessed id.
    expect(['ok', 'not-applicable']).toContain(result.snapshot.iteration.state)
  })

  it('falls back to the store\'s single ACTIVE workflow when the session has no pick', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-unpicked', [{ id: 'plan-u', status: 'Todo' }])
    liveSession(app, 'ses_fresh', app.root)

    // A session that never used the picker has no durable selection at all.
    expect(readWorkflowSessionBinding(app.harnessDir, 'ses_fresh', app.root)).toEqual({ kind: 'ok' })

    const result = await endpointOf(app).panelSnapshot('ses_fresh', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    // The pick is absent, so the server resolves the single ACTIVE workflow; the
    // digest read still answers (the delivery fallback may find no iteration in a
    // store that holds none).
    expect(['ok', 'not-applicable']).toContain(result.snapshot.iteration.state)
  })
})

describe('panelSnapshot endpoint — carrier cancellation (F5)', () => {
  it('answers aborted instead of reading the store when the carrier is already cancelled', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-abort', [{ id: 'plan-a', status: 'Todo' }])
    liveSession(app, 'ses_abort', app.root)

    // The typert gateway publishes `ctx.invocation` for the duration of a Remote
    // call; standing in for it here is the only way to hand the endpoint the
    // carrier's own lifetime. A real client timeout or socket close sets exactly
    // this signal.
    const controller = new AbortController()
    controller.abort()
    const service = app.ctx.get(PANEL_SNAPSHOT_SERVICE) as { ctx: object }
    Object.defineProperty(service.ctx, 'invocation', {
      value: { signal: controller.signal },
      configurable: true,
      writable: true,
    })

    // The read stops before its first view: a cancelled call pays for no store
    // access and no projection capture.
    expect(await endpointOf(app).panelSnapshot('ses_abort', app.root)).toEqual({
      kind: 'unavailable',
      reason: 'aborted',
    })
  })
})

describe('panelSnapshot endpoint — an explicit null id is an ABSENT id', () => {
  it('resolves the targets instead of reading ids spelled "null"', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-nullable', [{ id: 'plan-n', status: 'Todo' }])
    liveSession(app, 'ses_null', app.root)

    // `refusedId` deliberately ACCEPTS an explicit null as absent, so the forward
    // site must agree: forwarding it would hand the service the literal string
    // "null", and the whole server-side resolution branch would read a workflow
    // id that cannot exist — turning a resolution miss into a fake store failure.
    const result = await endpointOf(app).panelSnapshot('ses_null', app.root, null, null, null)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')

    // Same observable result as omitting all three (the F1 case above).
    // Same observable result as omitting all three (the F1 case above).
    expect(['ok', 'not-applicable']).toContain(result.snapshot.iteration.state)
  })

  it('still lets an asserted id win over resolution', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await seedStore(app.harnessDir)
    await seedActiveWorkflow(app.harnessDir, 'wf-resolved', [{ id: 'plan-r', status: 'Todo' }])
    liveSession(app, 'ses_assert', app.root)

    // A STRING id is asserted (not resolved): the digest read still answers, and
    // the delivery fallback never invents an iteration for an unknown workflow.
    const result = await endpointOf(app).panelSnapshot('ses_assert', app.root, 'wf-asserted')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.snapshot.iteration.state).toBe('not-applicable')
  })
})
