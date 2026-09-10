/**
 * Host-handler spec for `/api/mstar/engineStatus`
 * (`src/engine-status-endpoint.ts`).
 *
 * Covered: the descriptor + registration path on the host's shared typert
 * gateway, the validation chain (accept / reject with an explicit reason),
 * NO cross-session answer, traversal refusal, and the boot of a composition
 * WITHOUT a typert registry (the endpoint is an optional unit — the row must
 * still activate).
 *
 * The end-to-end case drives the REAL emission path first (the pre-step
 * waterfall persists the snapshot) and only then calls the endpoint, so the
 * served payload is proven to be the emitted one.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as entry from '../src/index.ts'
import { writeEngineStatusSnapshot } from '../src/engine-status-store.ts'
import {
  MSTAR_ENGINE_STATUS_METHOD,
  MSTAR_ENGINE_STATUS_NAMESPACE,
  type MstarEngineStatusResult,
} from '../src/engine-status-endpoint.ts'
import { bootApp, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/**
 * Minimal `sessionController` seam: the ONE contract the endpoint's persisted
 * fallback reads (`inspect(id)` → an object carrying `header.cwd`). Mounted as
 * a cordis service row so the endpoint's structural `ctx.get(...)` sees a real
 * provided service (a bare `ctx.set` is rejected without a `provide`).
 */
class FakeSessionController extends Service {
  /** Test-drivable cold read (the persisted-session fallback). */
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
  engineStatus(sessionId: unknown, cwd: unknown): Promise<MstarEngineStatusResult>
}

/** Structural view of the fake sessions registry (the harness's driver). */
interface FakeSessionsView {
  register(session: unknown): void
}

/** The `mstar` service of one boot (the endpoint owner). */
function endpointOf(app: BootResult): EndpointView {
  const service = app.ctx.get('mstar') as EndpointView | undefined
  if (service === undefined) throw new Error('mstar service not registered')
  return service
}

/** Register one live session (id + header cwd) on the fake sessions service. */
function liveSession(app: BootResult, id: string, cwd: string): void {
  const sessions = app.ctx.get('sessions') as FakeSessionsView | undefined
  if (sessions === undefined) throw new Error('sessions service not mounted')
  sessions.register({ id, header: { cwd } })
}

/** Seed one stored snapshot through the store's own writer. */
function seed(app: BootResult, sessionId: string, cwd: string, marker: number): void {
  const result = writeEngineStatusSnapshot(app.harnessDir, {
    sessionId,
    cwd,
    turn: marker,
    payload: { version: '9.9.9', marker },
    now: new Date('2026-09-10T12:00:00.000Z'),
  })
  if (result.kind !== 'written') throw new Error(`seed failed: ${result.reason}`)
}

describe('engineStatus endpoint — registration on the shared /api gateway', () => {
  it('contributes mstar/engineStatus to the typert registry when the service appears', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    // No typert registry in this composition: the optional unit simply does not
    // fire, and the service itself is still registered.
    expect(app.ctx.get('typert')).toBeUndefined()
    expect(typeof endpointOf(app).engineStatus).toBe('function')

    // The registry arrivals later (the real host composes it as its own row) —
    // the conditional inject child fires and the endpoint is contributed.
    await app.ctx.plugin(TypertRegistry)
    const registry = app.ctx.get('typert') as { local: { get(endpoint: string): unknown } }
    const descriptor = registry.local.get(`${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_ENGINE_STATUS_METHOD}`) as
      | Record<string, unknown>
      | undefined
    expect(descriptor).toBeDefined()
    expect(descriptor).toMatchObject({
      service: MSTAR_ENGINE_STATUS_NAMESPACE,
      namespace: MSTAR_ENGINE_STATUS_NAMESPACE,
      method: MSTAR_ENGINE_STATUS_METHOD,
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })
    expect((descriptor?.parameters as Array<{ wire: string }>).map((parameter) => parameter.wire)).toEqual([
      'sessionId',
      'cwd',
    ])
  })

  it('serves the emitted snapshot end to end: pre-step emission → stored → endpoint', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    const inbox: UserMessage[] = [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inbox' }] }),
    ]
    const decision = await app.ctx.waterfall(
      'agent/pre-step',
      {
        agent: { session: { header: { id: 'ses_alpha', cwd: app.root } } },
        messages: inbox,
        turn: 3,
        step: 1,
        signal: new AbortController().signal,
      } as never,
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: inbox }),
    )
    expect(decision.kind).toBe('enter')

    const result = await endpointOf(app).engineStatus('ses_alpha', app.root)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.sessionId).toBe('ses_alpha')
    expect(result.cwd).toBe(app.root)
    expect(result.turn).toBe(3)
    // The served payload is the emitted one (the rendered row's own facts).
    expect(result.payload).toMatchObject({ version: expect.any(String), harnessDir: app.harnessDir })
  })
})

describe('engineStatus endpoint — validation chain', () => {
  it('accepts a matching session + asserted cwd', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    seed(app, 'ses_alpha', app.root, 11)
    const result = await endpointOf(app).engineStatus('ses_alpha', app.root)
    expect(result).toMatchObject({ status: 'ok', sessionId: 'ses_alpha', cwd: app.root, turn: 11 })
  })

  it('rejects a malformed or relative cwd without touching the store', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    seed(app, 'ses_alpha', app.root, 11)
    const endpoint = endpointOf(app)
    expect(await endpoint.engineStatus('ses_alpha', '')).toEqual({ status: 'unavailable', reason: 'invalid-cwd' })
    expect(await endpoint.engineStatus('ses_alpha', 'relative/ws')).toEqual({
      status: 'unavailable',
      reason: 'cwd-refused',
    })
    expect(await endpoint.engineStatus('', app.root)).toEqual({
      status: 'unavailable',
      reason: 'invalid-session-id',
    })
  })

  it('refuses traversal in the asserted path', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    seed(app, 'ses_alpha', app.root, 11)
    const endpoint = endpointOf(app)
    const probes = [
      `${app.root}/../../etc`,
      `${app.root}/..`,
      '/proj/../other',
      `${app.root}/\0evil`,
    ]
    for (const probe of probes) {
      expect(await endpoint.engineStatus('ses_alpha', probe)).toEqual({
        status: 'unavailable',
        reason: 'cwd-refused',
      })
    }
  })

  it('answers unavailable when the session is unknown to the host', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    seed(app, 'ses_alpha', app.root, 11)
    // The snapshot exists, but the session does not: the endpoint never serves
    // a store row it cannot tie to a real session.
    expect(await endpointOf(app).engineStatus('ses_alpha', app.root)).toEqual({
      status: 'unavailable',
      reason: 'session-absent',
    })
  })

  it('answers unavailable when no snapshot was ever emitted for the session', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    expect(await endpointOf(app).engineStatus('ses_alpha', app.root)).toEqual({
      status: 'unavailable',
      reason: 'store-absent',
    })
  })

  it('never answers with another session data (cross-session probes)', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', app.root)
    liveSession(app, 'ses_beta', '/proj/other')
    seed(app, 'ses_alpha', app.root, 11)
    seed(app, 'ses_beta', '/proj/other', 22)
    const endpoint = endpointOf(app)

    // Both sessions are real and both have snapshots: each read is its own.
    const alpha = await endpoint.engineStatus('ses_alpha', app.root)
    const beta = await endpoint.engineStatus('ses_beta', '/proj/other')
    expect(alpha).toMatchObject({ status: 'ok', turn: 11 })
    expect(beta).toMatchObject({ status: 'ok', turn: 22 })

    // A session id swapped onto another session's workspace is refused — never
    // a silently-close match pointing at alpha's row.
    expect(await endpoint.engineStatus('ses_beta', app.root)).toEqual({
      status: 'unavailable',
      reason: 'cwd-mismatch',
    })
    // An unknown session id with a valid workspace of another live session.
    expect(await endpoint.engineStatus('ses_gamma', app.root)).toEqual({
      status: 'unavailable',
      reason: 'session-absent',
    })
  })

  it('refuses a session whose live cwd no longer matches the stored record', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    liveSession(app, 'ses_alpha', '/proj/moved')
    seed(app, 'ses_alpha', '/proj/original', 11)
    // The stored row belongs to the session's PREVIOUS workspace: a stale read
    // is refused rather than served as current.
    expect(await endpointOf(app).engineStatus('ses_alpha', '/proj/original')).toEqual({
      status: 'unavailable',
      reason: 'session-cwd-mismatch',
    })
  })

  it('falls back to the session controller persisted read for a non-attached session', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    const inspected: string[] = []
    await app.ctx.plugin(FakeSessionController)
    const service = app.ctx.get('sessionController') as FakeSessionController
    service.handler = async (sessionId: string) => {
      inspected.push(sessionId)
      return { header: { cwd: app.root } }
    }
    seed(app, 'ses_persisted', app.root, 7)
    const result = await endpointOf(app).engineStatus('ses_persisted', app.root)
    expect(result).toMatchObject({ status: 'ok', sessionId: 'ses_persisted', turn: 7 })
    expect(inspected).toEqual(['ses_persisted'])
  })

  it('answers unavailable when the persisted read throws or has no cwd', async () => {
    const app = (booted = await bootApp({ sessionsService: 'fake' }))
    await app.ctx.plugin(FakeSessionController)
    const service = app.ctx.get('sessionController') as FakeSessionController
    service.handler = async () => {
      throw new Error('persistence offline')
    }
    seed(app, 'ses_persisted', app.root, 7)
    expect(await endpointOf(app).engineStatus('ses_persisted', app.root)).toEqual({
      status: 'unavailable',
      reason: 'session-inspect-failed',
    })
    service.handler = async () => ({ header: {} })
    expect(await endpointOf(app).engineStatus('ses_persisted', app.root)).toEqual({
      status: 'unavailable',
      reason: 'session-cwd-absent',
    })
  })
})

describe('engineStatus endpoint — optional-unit boot', () => {
  it('boots a composition with no typert registry, no sessions and no controller', async () => {
    // A base-only profile shape: the endpoint registers nothing web-only, the
    // boot settles (the harness awaits each row — a pended row would hang it),
    // and the plugin surface is still present.
    const app = (booted = await bootApp())
    expect(app.ctx.get('typert')).toBeUndefined()
    expect(app.ctx.get('sessions')).toBeUndefined()
    expect(typeof endpointOf(app).engineStatus).toBe('function')
    // Degrades with an explicit reason instead of throwing at the caller.
    expect(await endpointOf(app).engineStatus('ses_alpha', '/proj')).toEqual({
      status: 'unavailable',
      reason: 'session-absent',
    })
  })

  it('does not name connection or webServer in the host row static inject', () => {
    // The HARD headless constraint, asserted at the source of truth rather than
    // inferred from a passing boot: the plugin's declared inject list must stay
    // free of the web-only services.
    expect(entry.inject).not.toContain('connection')
    expect(entry.inject).not.toContain('webServer')
    expect(entry.inject).toEqual(['loader'])
  })
})
