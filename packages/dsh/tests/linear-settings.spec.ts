/**
 * Task 2 — the enabled `linear-mcp` row consumes the machine credential.
 *
 * The fixtures are the shipped bundle row (the real YAML text, parsed in the
 * loader's `!!js` dialect), the real `MstarLinearAuth` service against a temp
 * credential file, and an injected fetch/clock for the refresh loop. No live
 * Linear account, no installed host — the "transport" is the row's EVALUATED
 * config, and the reload is observed on a fiber view that records `restart()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import {
  LINEAR_MCP_URL,
  clearLinearCredential,
  readLinearCredential,
  writeLinearCredential,
  type LinearCredential,
} from '@mstar-harness/engine'
import { FakeLoaderRegistry } from './harness.ts'
import { PATCH_PATH, readBundlePatch, type EntryRow } from './bundle-patch.ts'
import {
  MstarLinearAuth,
  setLinearAuthLogger,
  type LinearAuthClock,
  type MstarLinearAuthOptions,
} from '../src/linear-settings.ts'
import type { LoaderEntryView } from '../src/gates/fallbacks-probe.ts'

/* ------------------------------------------------------------------------ *
 * The shipped row
 * ------------------------------------------------------------------------ */

function linearMcpRow(): EntryRow {
  const row = readBundlePatch()[0]?.insert?.find((entry) => entry.id === 'linear-mcp')
  if (row === undefined) throw new Error('the shipped bundle has no linear-mcp row')
  return row
}

/** The `!!js` expression text on the shipped row's `headers` field. */
function headersExpression(row: EntryRow): string {
  const headers = row.config?.headers
  if (typeof headers === 'object' && headers !== null && '__jsExpr' in headers && typeof headers.__jsExpr === 'string') {
    return headers.__jsExpr
  }
  throw new Error('the shipped linear-mcp row has no headers expression')
}

/**
 * The loader's own expression evaluation (`config/utils.ts` `evaluate`): the
 * expression runs against `ctx` as its scope. The sandbox carries the context's
 * own properties plus `ctx` itself, so a `ctx.mstarLinearAuth.…` row resolves
 * exactly as it does under the loader's `with (ctx)`.
 */
const evaluate = (ctx: Context, expr: string): unknown => runInNewContext(expr, { ...ctx, ctx })

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

interface ManualClock extends LinearAuthClock {
  advance(ms: number): void
  pending(): number
  /** Every `schedule` call, cancelled ones included: a re-arm is visible. */
  armed(): number
}

/** Deterministic clock + timer seam: `advance` fires what the service armed. */
function manualClock(start: number): ManualClock {
  let now = start
  let arms = 0
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    schedule(run, delayMs) {
      arms += 1
      const timer = { at: now + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    advance(ms) {
      now += ms
      for (const timer of timers) {
        if (timer.cancelled || timer.at > now) continue
        timer.cancelled = true
        timer.run()
      }
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
    armed: () => arms,
  }
}

const TOKEN_URL = 'https://linear.test/token'
const METADATA_URL = 'https://linear.test/.well-known/oauth-protected-resource'
const AS_METADATA_URL = 'https://linear.test/.well-known/oauth-authorization-server'

type Route = () => Response | Promise<Response>

/** A fetch that fails the test if the service reaches the network. */
const unreachableFetch = (() => {
  throw new Error('unexpected fetch')
}) as unknown as typeof fetch

/** The AuthorizationServer discovery + token endpoint, driven by a fake fetch. */
function providerFetch(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    return await route()
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

function discoveryRoutes(token: Route): Record<string, Route> {
  return {
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
      }),
    [TOKEN_URL]: token,
  }
}

const START = Date.UTC(2026, 10, 2, 12)

/** Fixture token text, built from parts so no credential shape sits in source. */
const tok = (label: string): string => ['tok', label].join('-')
const ref = (label: string): string => ['ref', label].join('-')

function credential(overrides: Partial<LinearCredential> = {}): LinearCredential {
  return {
    accessToken: tok('live'),
    refreshToken: ref('live'),
    clientId: 'client-one',
    expiresAt: START + 3_600_000,
    scope: 'read,issues:create',
    ...overrides,
  }
}

/** One loader row shape; every mcp-client row shares `options.name`. */
function loaderRow(id: string, fiber: unknown, disabled = false): LoaderEntryView {
  return { id, options: { name: '@deepseek-ai/dsh-mcp-client' }, disabled, fiber }
}

/** A fiber view that records restarts (uid null = disposed). */
function recordingFiber(restarts: string[], id: string, uid: number | null = 7) {
  return {
    uid,
    restart: async (): Promise<void> => {
      restarts.push(id)
    },
  }
}

interface Harness {
  ctx: Context
  loader: FakeLoaderRegistry
  restarts: string[]
  row: LoaderEntryView
  clock: ManualClock
  provider: { fetch: typeof fetch; calls: string[] }
  service: MstarLinearAuth
}

function harness(
  options: {
    entry?: LinearCredential
    provider?: { fetch: typeof fetch; calls: string[] }
    disabled?: boolean
  } = {},
): Harness {
  if (options.entry !== undefined) writeLinearCredential(options.entry)
  const ctx = new Context()
  const loader = new FakeLoaderRegistry(ctx)
  const restarts: string[] = []
  const row = loaderRow('linear-mcp', recordingFiber(restarts, 'linear-mcp'), options.disabled ?? false)
  const clock = manualClock(START)
  const provider = options.provider ?? { fetch: unreachableFetch, calls: [] }
  // Two mcp-client rows share `options.name`: the service must pick by id.
  loader.entriesList = [loaderRow('mstar-mcp', recordingFiber(restarts, 'mstar-mcp')), row]
  const service = new MstarLinearAuth(ctx, { clock, fetch: provider.fetch } satisfies MstarLinearAuthOptions)
  return { ctx, loader, restarts, row, clock, provider, service }
}

/* ------------------------------------------------------------------------ *
 * Credential file sandbox + log capture
 * ------------------------------------------------------------------------ */

let root: string
const previousPath = process.env.MSTAR_LINEAR_CREDENTIAL
let finishLogCheck: () => void = () => {}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mstar-linear-auth-'))
  process.env.MSTAR_LINEAR_CREDENTIAL = join(root, 'credential.json')
  const lines: string[] = []
  const restore = setLinearAuthLogger((_level, message) => lines.push(message))
  finishLogCheck = () => {
    setLinearAuthLogger(restore)
    // The one leak this service controls: its own log output.
    for (const line of lines) expect(line).not.toContain('tok-')
  }
})

afterEach(() => {
  finishLogCheck()
  if (previousPath === undefined) delete process.env.MSTAR_LINEAR_CREDENTIAL
  else process.env.MSTAR_LINEAR_CREDENTIAL = previousPath
  rmSync(root, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------ *
 * (a) The row consumes the credential; nothing tracked carries it
 * ------------------------------------------------------------------------ */

describe('the shipped linear-mcp row', () => {
  it('evaluates to the stored bearer while every tracked form keeps the expression', () => {
    const row = linearMcpRow()
    expect(row.disabled).toBe(true)
    expect(row.inject).toEqual(['mstarLinearAuth'])
    const expression = headersExpression(row)
    expect(expression).toBe('ctx.mstarLinearAuth.authorizationHeaders()')

    // The shipped text keeps the expression, not a token.
    const text = readFileSync(PATCH_PATH, 'utf8')
    expect(text).toContain('!!js ctx.mstarLinearAuth.authorizationHeaders()')
    expect(text).not.toContain('tok-live')

    writeLinearCredential(credential())
    const ctx = new Context()
    new MstarLinearAuth(ctx, { clock: manualClock(START) })

    // The row's evaluated transport config carries the bearer…
    expect(evaluate(ctx, expression)).toEqual({ Authorization: 'Bearer tok-live' })
    // …and the tracked / settings-facing form still does not: the evaluated
    // value exists only in the row fiber's config, never in the patch text.
    expect(JSON.stringify(row)).not.toContain('tok-live')
    expect(JSON.stringify(row.config)).not.toContain('tok-live')
  })

  it('hands the transport no header when no credential is stored', () => {
    const ctx = new Context()
    new MstarLinearAuth(ctx, { clock: manualClock(START) })
    expect(evaluate(ctx, headersExpression(linearMcpRow()))).toEqual({})
  })
})

describe('the post-authorize reload', () => {
  it('restarts the enabled row located by id and writes neither options nor the enabled bit', async () => {
    const { service, restarts, row } = harness({ entry: credential() })
    const before = structuredClone({ disabled: row.disabled, options: row.options, id: row.id })

    expect(await service.reloadRow()).toBe(true)
    expect(restarts).toEqual(['linear-mcp'])
    expect(structuredClone({ disabled: row.disabled, options: row.options, id: row.id })).toEqual(before)
  })

  it('is a no-op for a disabled row and for a disposed fiber', async () => {
    const disabled = harness({ entry: credential(), disabled: true })
    expect(await disabled.service.reloadRow()).toBe(false)
    expect(disabled.restarts).toEqual([])
    expect(disabled.row.disabled).toBe(true)

    const disposed = harness({ entry: credential() })
    disposed.loader.entriesList = [loaderRow('linear-mcp', recordingFiber(disposed.restarts, 'linear-mcp', null))]
    expect(await disposed.service.reloadRow()).toBe(false)
    expect(disposed.restarts).toEqual([])

    // A fiber that unloaded between the check and the call does not throw.
    disposed.loader.entriesList = [
      loaderRow('linear-mcp', {
        uid: 9,
        restart: async () => {
          throw new Error('cannot create effect on inactive context')
        },
      }),
    ]
    expect(await disposed.service.reloadRow()).toBe(false)
  })
})

/* ------------------------------------------------------------------------ *
 * (b) Silent refresh — fake clock, one attempt, honest failure
 * ------------------------------------------------------------------------ */

describe('the silent refresh loop', () => {
  it('refreshes a due credential, reloads the row, and the re-evaluated header carries the new token', async () => {
    const provider = providerFetch(
      discoveryRoutes(() =>
        Response.json({ access_token: tok('rotated'), expires_in: 3600, scope: 'read,issues:create' }),
      ),
    )
    const expiresAt = START + 10 * 60_000
    const { service, clock, restarts, ctx } = harness({ entry: credential({ expiresAt }), provider })

    // Let the constructor's startup attempt settle (not due → idle).
    expect((await service.refreshIfDue()).kind).toBe('idle')
    // Not due yet: one timer armed, no network.
    expect(clock.pending()).toBe(1)
    expect(provider.calls).toEqual([])

    clock.advance(5 * 60_000) // now inside the refresh window
    const outcome = await service.refreshIfDue()

    expect(outcome.kind).toBe('refreshed')
    expect(restarts).toEqual(['linear-mcp'])
    expect(provider.calls.filter((call) => call === `POST ${TOKEN_URL}`)).toHaveLength(1)
    // The reloaded row's evaluated header carries the rotated token.
    expect(evaluate(ctx, headersExpression(linearMcpRow()))).toEqual({
      Authorization: 'Bearer tok-rotated',
    })
  })

  it('coalesces concurrent due needs onto one refresh', async () => {
    const provider = providerFetch(
      discoveryRoutes(() => Response.json({ access_token: tok('rotated'), expires_in: 3600 })),
    )
    // Already expired: the constructor's startup attempt is in flight.
    const { service } = harness({ entry: credential({ expiresAt: START - 1_000 }), provider })

    const outcomes = await Promise.all([
      service.refreshIfDue(),
      service.refreshIfDue(),
      service.refreshIfDue(),
    ])

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['refreshed', 'refreshed', 'refreshed'])
    expect(provider.calls.filter((call) => call === `POST ${TOKEN_URL}`)).toHaveLength(1)
  })

  it('never enables or restarts a row disabled while its refresh is in flight', async () => {
    const gate = Promise.withResolvers<Response>()
    const provider = providerFetch(discoveryRoutes(() => gate.promise))
    const { service, row, restarts } = harness({ entry: credential({ expiresAt: START + 60_000 }), provider })

    const attempt = service.refreshIfDue()
    row.disabled = true // the user turns the row off mid-attempt
    gate.resolve(Response.json({ access_token: tok('rotated'), expires_in: 3600 }))
    await attempt

    expect(restarts).toEqual([])
    expect(row.disabled).toBe(true)
  })

  it('reports a refused refresh as the observed linear.reauth-required fact, not an authorization', async () => {
    const provider = providerFetch(discoveryRoutes(() => new Response('denied', { status: 400 })))
    const { service, restarts, clock } = harness({ entry: credential({ expiresAt: START - 1_000 }), provider })

    const outcome = await service.refreshIfDue()

    expect(outcome).toEqual({ kind: 'refused', code: 'linear.reauth-required' })
    expect(service.refreshRefusal()?.code).toBe('linear.reauth-required')
    expect(restarts).toEqual([])
    // The file is untouched: no invented credential, no widened grant.
    expect(readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, 'utf8')).toContain('tok-live')
    // An expired credential is never handed to the transport.
    expect(service.authorizationHeaders()).toEqual({})
    // No retry spin: nothing is armed for an already-due credential.
    expect(clock.pending()).toBe(0)
  })

  it('retries a transiently failed refresh on a bounded backoff instead of stranding the host', async () => {
    let tokenCalls = 0
    const provider = providerFetch(
      discoveryRoutes(() => {
        tokenCalls += 1
        return tokenCalls === 1
          ? new Response('upstream unavailable', { status: 503 })
          : Response.json({ access_token: tok('retried'), expires_in: 3600 })
      }),
    )
    const { service, clock, restarts } = harness({ entry: credential({ expiresAt: START - 1_000 }), provider })

    // The startup attempt reached the provider and was refused transiently —
    // not rejected a grant, which only a new authorization could fix.
    expect((await service.refreshIfDue()).kind).toBe('refused')
    expect(service.refreshRefusal()?.code).toBe('linear.auth-unavailable')
    // The still-due credential is not stranded: one bounded retry is armed.
    expect(clock.pending()).toBe(1)

    clock.advance(30_000)
    expect((await service.refreshIfDue()).kind).toBe('refreshed')
    expect(restarts).toEqual(['linear-mcp'])
    expect(service.refreshRefusal()).toBeNull()
    // The retried grant is live, and its own window replaced the retry slot.
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-retried' })
    expect(clock.pending()).toBe(1)
  })

  it('arms the refresh schedule when a first Settings authorization adopts a credential', async () => {
    const provider = providerFetch(
      discoveryRoutes(() =>
        Response.json({ access_token: tok('rotated'), expires_in: 3600, scope: 'read,issues:create' }),
      ),
    )
    // The host booted with no credential: the constructor's startup attempt
    // armed nothing, and the row's fiber mounted without a bearer.
    const { service, clock, restarts, ctx } = harness({ provider })
    expect(clock.pending()).toBe(0)

    // The Settings gateway completed the first authorization and writes the
    // grant; the adoption must re-evaluate the expiry like any other grant.
    const expiresAt = START + 60 * 60_000
    writeLinearCredential(credential({ accessToken: tok('settings'), expiresAt }))
    expect((await service.adoptCredential()).kind).toBe('idle')

    expect(restarts).toEqual(['linear-mcp'])
    expect(clock.pending()).toBe(1)
    expect(service.refreshPlan()).toEqual({ kind: 'scheduled', at: expiresAt - 5 * 60_000 })

    // The armed tick is the silent refresh the plan promises: one exchange,
    // then the reloaded row carries the rotated bearer.
    clock.advance(55 * 60_000)
    expect((await service.refreshIfDue()).kind).toBe('refreshed')
    expect(provider.calls.filter((call) => call === `POST ${TOKEN_URL}`)).toHaveLength(1)
    expect(restarts).toEqual(['linear-mcp', 'linear-mcp'])
    expect(evaluate(ctx, headersExpression(linearMcpRow()))).toEqual({
      Authorization: 'Bearer tok-rotated',
    })
  })

  it('reports an unknown expiry honestly and never guesses', async () => {
    const provider = providerFetch({})
    const { service, clock } = harness({ entry: credential({ expiresAt: null }), provider })

    expect(service.refreshPlan()).toEqual({
      kind: 'unknown-expiry',
      note: 'expiry unknown; no refresh is scheduled for this credential',
    })
    expect(clock.pending()).toBe(0)
    expect(provider.calls).toEqual([])
    // Unknown is not expired: the usable credential is still exposed.
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-live' })
  })

  it('adopts a newer credential written by another process instead of overwriting it', async () => {
    const gate = Promise.withResolvers<Response>()
    const provider = providerFetch(discoveryRoutes(() => gate.promise))
    const { service, restarts } = harness({ entry: credential({ expiresAt: START + 60_000 }), provider })

    const attempt = service.refreshIfDue()
    // A CLI push/import rotated the file while this refresh was in flight.
    writeLinearCredential(
      credential({ accessToken: tok('newer'), refreshToken: ref('newer'), expiresAt: START + 3_600_000 }),
    )
    gate.resolve(Response.json({ access_token: tok('ours'), expires_in: 60 }))
    const outcome = await attempt

    expect(outcome.kind).toBe('adopted')
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-newer' })
    expect(readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, 'utf8')).toContain('tok-newer')
    // The row still re-mounts, so the connection picks up whichever token is on disk.
    expect(restarts).toEqual(['linear-mcp'])
  })

  it('reloads the row once through the adoption path when a superseded refresh declines to overwrite', async () => {
    const gate = Promise.withResolvers<Response>()
    const provider = providerFetch(discoveryRoutes(() => gate.promise))
    const { service, clock, restarts, ctx } = harness({
      entry: credential({ expiresAt: START + 60_000 }),
      provider,
    })

    // The Settings path (or a host-use header read) routes through
    // `adoptCredential`, which is where the outcome's reload decision lives.
    const adoption = service.adoptCredential()
    // A CLI run rotated the file while that refresh was in flight, so
    // `persist` declines this attempt's older lineage and answers `adopted`.
    writeLinearCredential(
      credential({ accessToken: tok('newer'), refreshToken: ref('newer'), expiresAt: START + 3_600_000 }),
    )
    gate.resolve(Response.json({ access_token: tok('ours'), expires_in: 60 }))
    expect((await adoption).kind).toBe('adopted')

    // One reload, not zero and not two: the mounted client must evaluate the
    // headers expression again to pick up the grant that actually won the race.
    expect(restarts).toEqual(['linear-mcp'])
    expect(evaluate(ctx, headersExpression(linearMcpRow()))).toEqual({ Authorization: 'Bearer tok-newer' })
    // The declined attempt armed the one slot already; the adoption path's own
    // re-read cancels and re-arms it, so there is still exactly one timer.
    expect(clock.pending()).toBe(1)
    expect(service.refreshPlan()).toEqual({ kind: 'scheduled', at: START + 3_600_000 - 5 * 60_000 })
  })

  it('never rewrites a credential the operator deleted while its refresh was in flight', async () => {
    const gate = Promise.withResolvers<Response>()
    const provider = providerFetch(discoveryRoutes(() => gate.promise))
    const { service, clock } = harness({ entry: credential({ expiresAt: START + 60_000 }), provider })

    const attempt = service.refreshIfDue()
    // `mstar linear logout` removes the file mid-refresh.
    expect(clearLinearCredential()).toBe(true)
    gate.resolve(Response.json({ access_token: tok('ours'), expires_in: 3600, scope: 'read,issues:create' }))
    expect((await attempt).kind).toBe('adopted')

    // Deletion is newer intent than the refresh: nothing is written back and
    // the host does not resurrect an authenticated connection.
    expect(readLinearCredential().kind).toBe('absent')
    expect(existsSync(process.env.MSTAR_LINEAR_CREDENTIAL!)).toBe(false)
    expect(service.authorizationHeaders()).toEqual({})
    expect(clock.pending()).toBe(0)
  })
})

/* ------------------------------------------------------------------------ *
 * (c) Host use adopts a credential another process wrote
 * ------------------------------------------------------------------------ */

/** The fire-and-forget adoption settles within one tick; the clock is manual. */
const flush = (): Promise<void> => Bun.sleep(0)

describe('the host-use adoption trigger', () => {
  it('adopts and schedules a credential another process wrote, exactly once', async () => {
    const provider = providerFetch({})
    // The host booted with no credential: nothing was armed, and the row
    // mounted with no bearer.
    const { service, clock, restarts } = harness({ provider })
    expect(service.authorizationHeaders()).toEqual({})
    expect(clock.pending()).toBe(0)

    // `mstar linear auth login` in another process writes the grant.
    const expiresAt = START + 60 * 60_000
    writeLinearCredential(credential({ accessToken: tok('cli'), expiresAt }))

    // The row's headers expression is the host-use seam: reading the bearer
    // adopts the grant, which arms its one silent refresh and reloads the row.
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-cli' })
    await flush()

    expect(restarts).toEqual(['linear-mcp'])
    expect(clock.pending()).toBe(1)
    expect(service.refreshPlan()).toEqual({ kind: 'scheduled', at: expiresAt - 5 * 60_000 })

    // Idempotent: the same credential neither re-arms nor restarts again.
    const arms = clock.armed()
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-cli' })
    await flush()
    expect(restarts).toEqual(['linear-mcp'])
    expect(clock.armed()).toBe(arms)
    expect(clock.pending()).toBe(1)
  })

  it('adopts a grant another process wrote while the refresh is in flight, once', async () => {
    const gate = Promise.withResolvers<Response>()
    const provider = providerFetch(discoveryRoutes(() => gate.promise))
    // A due credential: booting the host starts one attempt, which parks on the
    // gated discovery probe before any token exchange happens.
    const { service, clock, restarts } = harness({ entry: credential({ expiresAt: START + 60_000 }), provider })
    expect(provider.calls).toEqual([`POST ${LINEAR_MCP_URL}`])

    // `mstar linear auth login` writes a newer grant while that attempt is open.
    const expiresAt = START + 60 * 60_000
    writeLinearCredential(credential({ accessToken: tok('foreign'), refreshToken: ref('foreign'), expiresAt }))

    // A burst of header reads from the row while the attempt is still in
    // flight: each one must join that attempt instead of opening a second one.
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-foreign' })
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-foreign' })
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-foreign' })
    gate.resolve(Response.json({ access_token: tok('ours'), expires_in: 3600 }))
    await flush()
    await flush()

    // Exactly one discovery + token exchange for the whole burst.
    expect(provider.calls).toEqual([
      `POST ${LINEAR_MCP_URL}`,
      `GET ${METADATA_URL}`,
      `GET ${AS_METADATA_URL}`,
      `POST ${TOKEN_URL}`,
    ])
    // The attempt declined its older lineage, so the foreign grant survives…
    expect(readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, 'utf8')).toContain('tok-foreign')
    expect(service.authorizationHeaders()).toEqual({ Authorization: 'Bearer tok-foreign' })
    // …and the row restarts once and arms the one slot twice, not once per
    // header read: an adoption recorded after the async path would arm again.
    expect(restarts).toEqual(['linear-mcp'])
    expect(clock.pending()).toBe(1)
    expect(clock.armed()).toBe(2)
    expect(service.refreshPlan()).toEqual({ kind: 'scheduled', at: expiresAt - 5 * 60_000 })
  })
})

describe('the reload failure classification', () => {
  it('logs a genuine restart failure and stays silent for an unloaded fiber', async () => {
    const lines: string[] = []
    const restore = setLinearAuthLogger((level, message) => lines.push(`${level} ${message}`))
    try {
      const h = harness({ entry: credential() })

      h.loader.entriesList = [
        loaderRow('linear-mcp', {
          uid: 9,
          restart: async () => {
            throw new Error('cannot create effect on inactive context')
          },
        }),
      ]
      expect(await h.service.reloadRow()).toBe(false)
      expect(lines).toEqual([])

      h.loader.entriesList = [
        loaderRow('linear-mcp', {
          uid: 9,
          restart: async () => {
            throw new Error('the headers expression threw')
          },
        }),
      ]
      expect(await h.service.reloadRow()).toBe(false)
      // Anything that is not the known unload keeps the stale header and must
      // be visible, not classified as benign.
      expect(lines).toEqual(['warn the linear-mcp row failed to reload: the headers expression threw'])
      // The failure is reported without touching the enable bit: `rowState()`
      // reads it off the live entry, which is the row the reload actually
      // restarted. `h.row` is the fixture replaced out of `entriesList` above and
      // would assert on an object the service never touched.
      expect(h.service.rowState()).toEqual({ rowEnabled: true, fiberPhase: 'live' })
    } finally {
      setLinearAuthLogger(restore)
    }
  })

  it('contains a throwing logger on a failed reload', async () => {
    const h = harness({ entry: credential() })
    h.loader.entriesList = [
      loaderRow('linear-mcp', {
        uid: 9,
        restart: async () => {
          throw new Error('the headers expression threw')
        },
      }),
    ]
    const restore = setLinearAuthLogger(() => {
      throw new Error('the logger threw')
    })
    try {
      // `log()` is the guard: a throwing sink must not turn the reload's
      // answer into a rejection.
      expect(await h.service.reloadRow()).toBe(false)
    } finally {
      setLinearAuthLogger(restore)
    }
    expect(h.service.rowState()).toEqual({ rowEnabled: true, fiberPhase: 'live' })
  })
})

/**
 * The other half of `I-000953`: the service's log lines are the one place a
 * credential could leave the file, so both producers run against a synthetic
 * grant and every line is checked against the material that grant holds.
 */
describe('the credential log safety', () => {
  it('writes no credential material into the refresh or reload lines', async () => {
    const lines: string[] = []
    const restore = setLinearAuthLogger((level, message) => lines.push(`${level} ${message}`))
    try {
      const grant = credential({
        accessToken: tok('leak-access'),
        refreshToken: ref('leak-refresh'),
        clientId: 'client-leak',
        expiresAt: START - 1_000,
      })
      const rotated = { accessToken: tok('leak-rotated'), refreshToken: ref('leak-rotated') }
      const provider = providerFetch(
        discoveryRoutes(() =>
          Response.json({
            access_token: rotated.accessToken,
            refresh_token: rotated.refreshToken,
            expires_in: 3600,
            scope: 'read,issues:create',
          }),
        ),
      )
      const h = harness({ entry: grant, provider })
      // The startup attempt is parked on discovery; this makes the reload it
      // drives after writing the fresh grant fail, so both producers log.
      h.loader.entriesList = [
        loaderRow('linear-mcp', {
          uid: 9,
          restart: async () => {
            throw new Error('the headers expression threw')
          },
        }),
      ]
      expect((await h.service.refreshIfDue()).kind).toBe('refreshed')
      expect(lines.filter((line) => line.includes('linear credential refreshed'))).toHaveLength(1)
      expect(lines.filter((line) => line.includes('failed to reload'))).toHaveLength(1)

      // The forbidden set is structural: every string the credential file holds
      // after the write, plus the rotation this attempt carried. A credential
      // added to the file is covered without naming its field here.
      const stored = JSON.parse(readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, 'utf8')) as Record<string, unknown>
      const forbidden = [
        ...Object.values(stored).filter((value): value is string => typeof value === 'string' && value !== ''),
        grant.accessToken,
        grant.refreshToken!,
        rotated.accessToken,
        rotated.refreshToken,
      ]
      // The fresh grant is what the file holds: the assertion below is live.
      expect(forbidden).toContain(rotated.accessToken)
      for (const line of lines) {
        for (const secret of forbidden) expect(line).not.toContain(secret)
      }
    } finally {
      setLinearAuthLogger(restore)
    }
  })

  it('writes no credential material into the refusal line', async () => {
    const lines: string[] = []
    const restore = setLinearAuthLogger((level, message) => lines.push(`${level} ${message}`))
    try {
      // The refusal producer (`refuse()` → `warn ${code}: ${message}`) is the third
      // writer to this log, and the grant it must never carry is on the same file
      // the service just read. A due grant with no refresh token is the one refusal
      // the service composes itself, so the line is its own words — no upstream
      // message can account for credential material appearing in it.
      const grant = credential({ refreshToken: null, expiresAt: START - 1_000 })
      const h = harness({ entry: grant })
      expect((await h.service.refreshIfDue()).kind).toBe('refused')
      expect(lines).toEqual([
        'warn linear.reauth-required: the stored credential is due and holds no refresh token to renew it',
      ])

      const stored = JSON.parse(readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, 'utf8')) as Record<string, unknown>
      const forbidden = Object.values(stored).filter((value): value is string => typeof value === 'string' && value !== '')
      // The grant is on the file this line's producer can read: the assertion is live.
      expect(forbidden).toContain(grant.accessToken)
      for (const line of lines) {
        for (const secret of forbidden) expect(line).not.toContain(secret)
      }
    } finally {
      setLinearAuthLogger(restore)
    }
  })
})
