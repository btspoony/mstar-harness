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
import { HarnessResolver } from '../src/gates/_shared.ts'
import { bootApp, seedStore, type BootResult } from './harness.ts'
import {
  PANEL_SNAPSHOT_SERVICE,
  installPanelSnapshotEndpoint,
  mstarPanelSnapshotContribution,
  type PanelSnapshotEndpointOptions,
} from '../src/panel/panel-snapshot-endpoint.ts'
import { MSTAR_PANEL_SNAPSHOT_METHOD, MSTAR_PANEL_SNAPSHOT_NAMESPACE } from '../src/engine-status-wire.ts'
import type { PanelSnapshotRead } from '../src/panel/panel-snapshot.ts'

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

/** An absolute workspace with no `.mstarc`: nothing resolves a harness for it. */
async function bareWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-panel-bare-'))
  extraRoots.push(root)
  return root
}

/** The apply-scoped options the plugin passes: per-workspace resolution, no configured root. */
function endpointOptions(): PanelSnapshotEndpointOptions {
  return { resolver: new HarnessResolver(undefined), bootHarnessDir: null }
}

/** Install the unit on the app's context — the wiring `apply` performs. */
async function installEndpoint(app: BootResult): Promise<void> {
  await app.ctx.plugin((rowCtx: Context) => {
    installPanelSnapshotEndpoint(rowCtx, endpointOptions())
  })
}

describe('panelSnapshot endpoint — registration on the shared /api gateway', () => {
  it('contributes mstar/panelSnapshot with the five declared argument wires', async () => {
    // A FRESH context: the plugin's own apply already registers the
    // `@mstar-harness/dsh#host` package face (the engine-status contribution),
    // and typert admits one contribution per package face — so the descriptor
    // shape is pinned here, on a registry where this unit is the only host
    // contributor.
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin((rowCtx: Context) => {
      installPanelSnapshotEndpoint(rowCtx, endpointOptions())
    })

    const registry = ctx.get('typert') as { local: { get(endpoint: string): unknown } }
    const descriptor = registry.local.get(`${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_PANEL_SNAPSHOT_METHOD}`) as
      | Record<string, unknown>
      | undefined
    expect(descriptor).toBeDefined()
    expect(descriptor).toMatchObject({
      service: PANEL_SNAPSHOT_SERVICE,
      namespace: MSTAR_PANEL_SNAPSHOT_NAMESPACE,
      method: MSTAR_PANEL_SNAPSHOT_METHOD,
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })
    expect((descriptor?.parameters as Array<{ wire: string }>).map((parameter) => parameter.wire)).toEqual([
      'sessionId',
      'cwd',
      'workflowId',
      'iterationId',
      'projectId',
    ])
  })
})

describe('panelSnapshot endpoint — argument shape precedes every store access', () => {
  it('refuses empty ids, a relative cwd and traversal before reading the store', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await installEndpoint(app)
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
    await installEndpoint(app)
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
    await installEndpoint(app)
    await seedStore(app.harnessDir)
    liveSession(app, 'ses_alpha', app.root)

    const result = await endpointOf(app).panelSnapshot('ses_alpha', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.snapshot.harnessDir).toBe(app.harnessDir)
    expect(result.snapshot.workspace.projects).toMatchObject({ state: 'ok' })
    expect(Number.isNaN(Date.parse(result.snapshot.at))).toBe(false)
  })

  it('answers no-harness-dir for a session whose workspace declares none', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await installEndpoint(app)
    const bare = await bareWorkspace()
    liveSession(app, 'ses_bare', bare)

    // The client's `cwd` cannot supply what the workspace does not declare.
    expect(await endpointOf(app).panelSnapshot('ses_bare', bare)).toEqual({
      kind: 'unavailable',
      reason: 'no-harness-dir',
    })
  })

  it('resolves a cold session through the persisted controller read', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await installEndpoint(app)
    await app.ctx.plugin(FakeSessionController)
    const controller = app.ctx.get('sessionController') as FakeSessionController
    controller.handler = async (sessionId: string) =>
      sessionId === 'ses_persisted' ? { header: { cwd: app.root } } : { header: {} }
    await seedStore(app.harnessDir)

    const result = await endpointOf(app).panelSnapshot('ses_persisted', app.root)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.snapshot.harnessDir).toBe(app.harnessDir)
  })
})

describe('panelSnapshot endpoint — store degradation is a value, not a throw', () => {
  it('answers unavailable with the store reason when the store refuses', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake', harnessDir: null }))
    await installEndpoint(app)
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
    await installEndpoint(app)
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
    await installEndpoint(app)
    const options: PanelSnapshotEndpointOptions = {
      resolver: { forWorkspace: () => null },
      bootHarnessDir: null,
    }
    // A second apply must not construct a second service (the provider name is
    // taken): it logs and keeps the existing one.
    installPanelSnapshotEndpoint(app.ctx, options)
    expect(typeof endpointOf(app).panelSnapshot).toBe('function')
    expect(mstarPanelSnapshotContribution().invocations).toHaveLength(1)
  })
})
