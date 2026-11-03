/**
 * `mstarLinearAuth` — the Linear credential the enabled `linear-mcp` row
 * consumes.
 *
 * Two facts shape this file:
 *
 * - The row's transport config is a `!!js` expression
 *   (`ctx.mstarLinearAuth.authorizationHeaders()`, see
 *   `bundle/cordis.patch.yml`), so the bearer exists only in the row's
 *   evaluated config — never in a profile patch, a settings payload or a log.
 *   `authorizationHeaders()` therefore reads the credential file on every
 *   call: no cache, no second authority.
 * - The dsh MCP client takes its headers at mount time and passes the
 *   transport no `authProvider`, so a token written after the row mounted (an
 *   explicit Authorize, or a refresh) changes nothing until the row
 *   re-mounts. The public `Fiber.restart()` seam is that re-mount, and this
 *   service owns both triggers: the post-authorize reload and the silent
 *   refresh loop.
 *
 * Silent refresh is required behavior, not a later toggle: a credential inside
 * the persisted refresh window is refreshed on one bounded attempt, and the
 * enabled row is reloaded so the re-evaluated header carries the new token
 * with no human toggle. A refresh refusal is the observed
 * `linear.reauth-required` fact and nothing else — never an inferred
 * authorization, never a widened grant (a refresh sends no scope). A refused
 * grant is not retried; a transient attempt failure is, on a bounded backoff,
 * so one bad round trip cannot leave the host unauthenticated.
 *
 * This module also serves the row's Settings card: `MstarLinearSettingsGateway`
 * answers the card's four `mstar` operations, and owns the one authorization
 * attempt. The attempt, its PKCE verifier and the loopback listener stay on
 * the host; `linearAuthorizeBegin` answers with the attempt id and URL
 * immediately, and the card polls `linearAuthorizeStatus` until a terminal
 * answer. One begin while an attempt is live is refused (`attempt-active`),
 * never forked.
 */
import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import {
  LINEAR_MCP_URL,
  REFRESH_WINDOW_MS,
  beginAuthorization,
  commitLinearCredential,
  discoverAuthorizationServer,
  exchangeCode,
  linearScopeCanWrite,
  readLinearCredential,
  refreshToken,
  registerClient,
  supersededBy,
  writeLinearCredential,
  type AuthorizationServer,
  type LinearCredentialState,
  type PendingAuthorization,
  type TokenSet,
} from '@mstar-harness/engine'
import type { LoaderEntryView } from './gates/fallbacks-probe.ts'
import {
  MSTAR_CONTRIBUTING_PACKAGE,
  MSTAR_ENGINE_STATUS_NAMESPACE,
  MSTAR_LINEAR_AUTHORIZE_BEGIN_METHOD,
  MSTAR_LINEAR_AUTHORIZE_CANCEL_METHOD,
  MSTAR_LINEAR_AUTHORIZE_STATUS_METHOD,
  MSTAR_LINEAR_STATUS_METHOD,
} from './engine-status-wire.ts'

/** The one Linear provider row this service feeds. */
export const LINEAR_MCP_ENTRY_ID = 'linear-mcp'

/** The service name the row's `inject` and headers expression use. */
export const LINEAR_AUTH_SERVICE = 'mstarLinearAuth'

/** The typert service key the Settings card's four calls are served from. */
export const LINEAR_SETTINGS_SERVICE = 'linear-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Linear credential service consumed by the `linear-mcp` row. */
    mstarLinearAuth: MstarLinearAuth
  }
}

/** Clock and timer seam — tests drive the schedule without real waiting. */
export interface LinearAuthClock {
  now(): number
  /** Run `task` after `delayMs`; the return value cancels it. */
  schedule(task: () => void, delayMs: number): () => void
}

/** Options for the service (the host passes none; tests inject seams). */
export interface MstarLinearAuthOptions {
  /** Network seam for discovery + the refresh exchange. */
  fetch?: typeof fetch
  /** Clock/timer seam. */
  clock?: LinearAuthClock
}

/** What one scheduled attempt concluded. */
export type LinearRefreshOutcome =
  | { kind: 'idle' }
  | { kind: 'refreshed' }
  | { kind: 'adopted' }
  | { kind: 'refused'; code: string }
  | { kind: 'skipped' }

/** What this service knows about the next refresh, without guessing. */
export type LinearRefreshPlan =
  | { kind: 'none'; reason: 'absent' | 'unreadable' }
  | { kind: 'unknown-expiry'; note: string }
  | { kind: 'scheduled'; at: number }

export type LinearAuthLogLevel = 'info' | 'warn'
export type LinearAuthLogSink = (level: LinearAuthLogLevel, message: string) => void

/** What the `linear-mcp` row's fiber is doing (the card renders only the enable bit). */
export type LinearFiberPhase = 'absent' | 'disabled' | 'stopped' | 'live'

let logSink: LinearAuthLogSink | undefined

/** Redirect the service's own lines (tests capture them; the host keeps its logger). */
export function setLinearAuthLogger(sink?: LinearAuthLogSink): LinearAuthLogSink | undefined {
  const previous = logSink
  logSink = sink
  return previous
}

/** Production seam: a pending refresh is not a reason to keep the host alive. */
const systemClock: LinearAuthClock = {
  now: () => Date.now(),
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/**
 * Retry backoff after an attempt ended without a fresh grant: the first delay
 * doubles per consecutive failure up to the ceiling, so one failed attempt
 * cannot strand the host and a persistent failure cannot spin.
 */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 15 * 60_000

/** The parts of a live `Fiber` this service drives. */
interface ReloadableFiber {
  readonly uid?: number | null
  restart(): Promise<void>
}

/** The cordis loader service, narrowed onto the consumed surface. */
interface LoaderView {
  entries(): Iterable<LoaderEntryView>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The stable code an engine failure carries (bracketed message or `.code`). */
function errorCodeOf(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = error.code
    if (typeof code === 'string' && code !== '') return code
  }
  return /\[([a-z][a-z0-9.-]*)\]/.exec(messageOf(error))?.[1] ?? null
}

/**
 * The host Linear credential service.
 *
 * Constructed by the plugin's `apply`; the loader mounts the `linear-mcp` row
 * after this service is provided (the row injects it), so the row's headers
 * expression can never resolve against a missing service.
 */
export class MstarLinearAuth extends Service {
  private readonly fetchImpl: typeof fetch
  private readonly clock: LinearAuthClock
  private inflight: Promise<LinearRefreshOutcome> | undefined
  private cancelTimer: (() => void) | undefined
  /** Consecutive attempts that ended without a fresh grant; drives the retry backoff. */
  private failures = 0
  private refusal: { code: string; message: string } | null = null
  private disposed = false

  constructor(ctx: Context, options: MstarLinearAuthOptions = {}) {
    super(ctx, LINEAR_AUTH_SERVICE)
    this.fetchImpl = options.fetch ?? fetch
    this.clock = options.clock ?? systemClock
    ctx.effect(
      () => () => {
        this.disposed = true
        this.cancelTimer?.()
        this.cancelTimer = undefined
      },
      'mstar:linear auth refresh loop',
    )
    // Startup: run the due check now, before the row's fiber evaluates the
    // headers expression for its first mount (the loader waits on this
    // service). If the refresh lands later, the reload below still replaces
    // the header.
    void this.refreshIfDue()
  }

  /**
   * The row's transport headers. A fresh read of the credential file on every
   * call — the file is the single authority, and the value exists only in the
   * caller's (the row fiber's) evaluated config.
   *
   * A credential past its expiry is never handed out: an expired bearer only
   * produces an access-denied that names nothing, while the refresh loop is
   * already replacing it. A credential merely inside the refresh window is
   * still usable and is returned.
   */
  authorizationHeaders(): Record<string, string> {
    const now = this.clock.now()
    const state = readLinearCredential(now)
    if (state.kind !== 'present') return {}
    const { accessToken, expiresAt } = state.credential
    if (expiresAt !== null && now >= expiresAt) return {}
    return { Authorization: `Bearer ${accessToken}` }
  }

  /** The observed refresh refusal (`linear.reauth-required`), or null. */
  refreshRefusal(): { code: string; message: string } | null {
    return this.refusal
  }

  /** The next refresh this host will attempt, stated without guessing. */
  refreshPlan(): LinearRefreshPlan {
    const state = readLinearCredential(this.clock.now())
    if (state.kind !== 'present') return { kind: 'none', reason: state.kind }
    if (state.credential.expiresAt === null) {
      // No expiry was recorded, so there is no instant to schedule and no
      // expiry to compare: the host never invents one, and nothing else
      // triggers a refresh for this credential.
      return { kind: 'unknown-expiry', note: 'expiry unknown; no refresh is scheduled for this credential' }
    }
    return { kind: 'scheduled', at: state.credential.expiresAt - REFRESH_WINDOW_MS }
  }

  /**
   * The row facts the Settings card may see: whether the host's native toggle
   * is on, and what its fiber is doing. Point-in-time and by id — the card
   * never writes the enable bit.
   */
  rowState(): { rowEnabled: boolean; fiberPhase: LinearFiberPhase } {
    const entry = this.linearMcpEntry()
    if (entry === undefined) return { rowEnabled: false, fiberPhase: 'absent' }
    if (entry.disabled) return { rowEnabled: false, fiberPhase: 'disabled' }
    const fiber = entry.fiber as ReloadableFiber | undefined
    const live = fiber !== undefined && fiber !== null && fiber.uid !== null
    return { rowEnabled: true, fiberPhase: live ? 'live' : 'stopped' }
  }

  /**
   * Reload the enabled row after a credential was granted (the post-authorize
   * hook) or rotated. Disabled or disposed rows are skipped explicitly: there
   * is no live connection to refresh, the next user enable mounts fresh, and
   * the row's enabled bit is never written by this service.
   *
   * @returns whether a live row fiber was restarted.
   */
  async reloadRow(): Promise<boolean> {
    const entry = this.linearMcpEntry()
    if (entry === undefined || entry.disabled) return false
    // Structural view of cordis's Fiber (this plugin imports none): only
    // `uid` and `restart()` are consumed.
    const fiber = entry.fiber as ReloadableFiber | undefined
    if (fiber === undefined || fiber === null || fiber.uid === null) return false
    try {
      await fiber.restart()
      return true
    } catch (error) {
      const message = messageOf(error)
      // The one benign case: the fiber unloaded between the check and the call,
      // so nothing was connected any more. Anything else keeps the stale
      // header while authorization and refresh both claim success — it must be
      // visible, never classified as an unload.
      if (!message.includes('inactive context')) {
        this.log('warn', `the ${LINEAR_MCP_ENTRY_ID} row failed to reload: ${message}`)
      }
      return false
    }
  }

  /**
   * Adopt a credential that just landed in the file: a first Settings
   * authorization, a reauthorization, or a newer grant another process wrote.
   *
   * Every adoption goes through the refresh path, so the persisted expiry is
   * re-evaluated and exactly one schedule is armed — a host that booted with
   * no credential armed nothing at startup, and without this the grant it
   * just received would never be refreshed. A grant already inside the window
   * rotates here instead, which is why the row reload below is only the
   * not-yet-due case: the attempt reloads the row itself once it rotates.
   */
  async adoptCredential(): Promise<LinearRefreshOutcome> {
    const outcome = await this.refreshIfDue()
    // Re-read the file, not the attempt's snapshot: a grant that landed while
    // the attempt was in flight still gets its expiry evaluated and its one
    // timer armed (a cancelled re-arm is the same single slot).
    this.schedule(readLinearCredential(this.clock.now()))
    // A rotated/adopted grant was already reloaded by the attempt; anything
    // else (a fresh grant, a refusal) still needs the row re-mounted once.
    if (outcome.kind !== 'refreshed' && outcome.kind !== 'adopted') await this.reloadRow()
    return outcome
  }

  /**
   * One refresh attempt, coalescing concurrent needs onto the in-flight one.
   * Never rejects — a refusal is reported as a value.
   */
  refreshIfDue(): Promise<LinearRefreshOutcome> {
    if (this.inflight !== undefined) return this.inflight
    const attempt = this.attempt()
    this.inflight = attempt
    void attempt.finally(() => {
      if (this.inflight === attempt) this.inflight = undefined
    })
    return attempt
  }

  private async attempt(): Promise<LinearRefreshOutcome> {
    if (this.disposed) return { kind: 'skipped' }
    const before = readLinearCredential(this.clock.now())
    if (before.kind !== 'present' || !before.refreshDue) {
      this.failures = 0
      this.schedule(before)
      return { kind: 'idle' }
    }
    const { credential } = before
    if (credential.refreshToken === null || credential.clientId === null) {
      this.refuse('linear.reauth-required', 'the stored credential is due and holds no refresh token to renew it')
      this.failures = 0
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: 'refused', code: 'linear.reauth-required' }
    }
    try {
      const server = await discoverAuthorizationServer(LINEAR_MCP_URL, this.fetchImpl)
      const fresh = await refreshToken(server, credential.clientId, credential.refreshToken, this.fetchImpl)
      if (this.disposed) return { kind: 'skipped' }
      const outcome = this.persist(before, fresh)
      this.refusal = null
      this.failures = 0
      this.log('info', `linear credential refreshed (${outcome}); reloading the ${LINEAR_MCP_ENTRY_ID} row`)
      await this.reloadRow()
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: outcome }
    } catch (error) {
      const code = errorCodeOf(error) ?? 'linear.auth-unavailable'
      this.refuse(code, messageOf(error))
      // A rejected grant is not retried: only a new authorization can change
      // it. Everything else — discovery, transport, a provider 5xx — is
      // transient, so the still-due credential is retried on a bounded
      // backoff instead of leaving the host unauthenticated after one attempt.
      if (code === 'linear.reauth-required') this.failures = 0
      else this.failures += 1
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: 'refused', code }
    }
  }

  private persist(
    before: Extract<LinearCredentialState, { kind: 'present' }>,
    fresh: TokenSet,
  ): 'refreshed' | 'adopted' {
    // The superseded check sees a `mstar linear logout` or a newer grant that
    // landed during the refresh's round trip, so this attempt's older lineage
    // is declined. A write landing inside the final read→rename window is
    // accepted (see `commitLinearCredential`).
    const written = commitLinearCredential((current) => {
      if (supersededBy(current, before.credential)) return null
      return {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken ?? before.credential.refreshToken,
        clientId: fresh.clientId ?? before.credential.clientId,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope ?? before.credential.scope,
      }
    }, this.clock.now())
    return written === null ? 'adopted' : 'refreshed'
  }

  /**
   * Arm the one refresh slot. A credential due now normally arms nothing: this
   * tick just ran, and re-arming at zero would spin. After a transient attempt
   * failure it is retried on the bounded backoff instead, so a still-due
   * credential is never left without a timer.
   */
  private schedule(state: LinearCredentialState): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    if (this.disposed || state.kind !== 'present' || state.credential.expiresAt === null) {
      this.failures = 0
      return
    }
    const due = state.credential.expiresAt - REFRESH_WINDOW_MS - this.clock.now()
    const delay = due > 0 ? due : this.retryDelay()
    if (delay <= 0) return
    this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined
      void this.refreshIfDue()
    }, delay)
  }

  /** Doubling backoff for the next retry, capped at the ceiling; 0 when quiet. */
  private retryDelay(): number {
    if (this.failures === 0) return 0
    return Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS)
  }

  private linearMcpEntry(): LoaderEntryView | undefined {
    // `ctx.get('loader')` is the untyped string overload — narrowed onto the
    // consumed structural surface (no loader-plugin dependency).
    const loader = this.ctx.get('loader') as LoaderView | undefined
    if (loader === undefined) return undefined
    for (const entry of loader.entries()) {
      // By id, never by `options.name`: every mcp-client row shares one name.
      if (entry.id === LINEAR_MCP_ENTRY_ID) return entry
    }
    return undefined
  }

  private refuse(code: string, message: string): void {
    this.refusal = { code, message }
    this.log('warn', `${code}: ${message}`)
  }

  private log(level: LinearAuthLogLevel, message: string): void {
    // A throwing sink/logger must never abort a refresh attempt (cordis calls
    // exporters unguarded; the house rule is to contain, not propagate).
    try {
      if (logSink !== undefined) {
        logSink(level, message)
        return
      }
      this.ctx.logger('mstar/linear-auth')[level](message)
    } catch {
      // Logging is diagnostics; the attempt's outcome is unaffected.
    }
  }
}

/* ------------------------------------------------------------------------ *
 * The Settings card's host RPC (`linear-settings` service)
 * ------------------------------------------------------------------------ */

/** The display words derived from the credential file (one vocabulary with the CLI). */
export type LinearCredentialDisplay = 'authorized' | 'expired' | 'absent' | 'unreadable'

/** The only credential facts the browser may receive. */
export interface LinearCredentialView {
  display: LinearCredentialDisplay
  scope: string | null
  expiresAt: number | null
  /** Whether this grant's scope can create or update issues (`display` is validity). */
  canWrite: boolean
}

/** `linearStatus`: the row's enable bit + non-secret credential facts, or an explicit reason. */
export type MstarLinearStatusResult =
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; rowEnabled: boolean; fiberPhase: LinearFiberPhase; credential: LinearCredentialView }

/** `linearAuthorizeBegin`: the URL is the only thing that reaches the browser. */
export type MstarLinearAuthorizeBeginResult =
  | { status: 'started'; attemptId: string; url: string; expiresAt: number }
  | { status: 'attempt-active' }
  | { status: 'unavailable'; reason: string }

/** `linearAuthorizeStatus`: the closed product union the card polls. */
export type MstarLinearAuthorizeStatus =
  | { status: 'pending' }
  | { status: 'authorized'; scope: string | null; expiresAt: number | null }
  | { status: 'denied'; reason: string }
  | { status: 'timeout' }
  | { status: 'cancelled' }
  | { status: 'not-found' }

/** `linearAuthorizeCancel`: the attempt is closed on the host. */
export type MstarLinearAuthorizeCancelResult = { status: 'cancelled' } | { status: 'not-found' }

/** Options the gateway needs from the plugin's apply scope (tests inject seams). */
export interface MstarLinearSettingsOptions {
  readonly auth: MstarLinearAuth
  /** Network seam for discovery, registration and the code exchange. */
  readonly fetch?: typeof fetch
  readonly clock?: { now(): number }
  /** Browser-consent bound. The shared flow's own default is five minutes. */
  readonly waitTimeoutMs?: number
}

/** One live attempt: its PKCE state and listener never leave this object. */
interface LinearAuthorizeAttempt {
  readonly id: string
  readonly pending: PendingAuthorization
  readonly server: AuthorizationServer
  result: MstarLinearAuthorizeStatus
  cancelled: boolean
}

/** Derive the display word from the file facts (never from a bare 401 or `refreshDue`). */
function credentialView(state: LinearCredentialState, now: number): LinearCredentialView {
  if (state.kind === 'absent') return { display: 'absent', scope: null, expiresAt: null, canWrite: false }
  if (state.kind === 'unreadable') return { display: 'unreadable', scope: null, expiresAt: null, canWrite: false }
  const { scope, expiresAt } = state.credential
  return {
    display: expiresAt === null || now < expiresAt ? 'authorized' : 'expired',
    scope,
    expiresAt,
    // Valid and push-capable are separate facts: a read-only grant is
    // authorized, and only an explicit reauthorization can widen it.
    canWrite: linearScopeCanWrite(scope),
  }
}

/**
 * Host-side `linear-settings` gateway: the card's one root-scope surface.
 *
 * The attempt lives HERE, not inside an RPC: `linearAuthorizeBegin` starts the
 * loopback listener and the code exchange in the background and answers with
 * the attempt id and URL at once, so a slow consent never holds a request
 * open. `linearAuthorizeStatus` is polled under the client's own short
 * deadline until a terminal answer, then the attempt is dropped.
 */
export class MstarLinearSettingsGateway extends TypertRemoteService {
  private readonly auth: MstarLinearAuth
  private readonly fetchImpl: typeof fetch
  private readonly clock: { now(): number }
  private readonly waitTimeoutMs: number
  private attempt: LinearAuthorizeAttempt | undefined
  private beginInflight = false
  private disposed = false

  constructor(ctx: Context, options: MstarLinearSettingsOptions) {
    super(ctx, LINEAR_SETTINGS_SERVICE, { namespace: MSTAR_ENGINE_STATUS_NAMESPACE })
    this.auth = options.auth
    this.fetchImpl = options.fetch ?? fetch
    this.clock = options.clock ?? { now: () => Date.now() }
    this.waitTimeoutMs = options.waitTimeoutMs ?? 300_000
    ctx.effect(
      () => () => {
        this.disposed = true
        const attempt = this.attempt
        this.attempt = undefined
        attempt?.pending.close()
      },
      'mstar:linear settings attempt',
    )
  }

  private now(): number {
    return this.clock.now()
  }

  /** The card's status read. Never returns a path, token, account or email. */
  async linearStatus(): Promise<MstarLinearStatusResult> {
    try {
      const now = this.now()
      const row = this.auth.rowState()
      return {
        status: 'ready',
        rowEnabled: row.rowEnabled,
        fiberPhase: row.fiberPhase,
        credential: credentialView(readLinearCredential(now), now),
      }
    } catch {
      return { status: 'unavailable', reason: 'internal-error' }
    }
  }

  /**
   * Start one attempt. The PKCE verifier, `state` and the loopback listener
   * stay on the host; the browser receives only the authorization URL.
   */
  async linearAuthorizeBegin(): Promise<MstarLinearAuthorizeBeginResult> {
    // A terminal answer the card never observed (it closed, or the browser
    // tab is gone) must not lock the host out of a fresh attempt.
    if (this.attempt !== undefined && this.attempt.result.status !== 'pending') {
      this.attempt.pending.close()
      this.attempt = undefined
    }
    // The synchronous guard (plus the in-flight flag) means a second click
    // never forks a second PKCE state while discovery/registration is running.
    if (this.attempt !== undefined || this.beginInflight) return { status: 'attempt-active' }
    this.beginInflight = true
    try {
      const server = await discoverAuthorizationServer(LINEAR_MCP_URL, this.fetchImpl)
      const pending = await beginAuthorization(server, (redirectUri) =>
        registerClient(server, redirectUri, this.fetchImpl))
      if (this.disposed) {
        pending.close()
        return { status: 'unavailable', reason: 'disposed' }
      }
      const attempt: LinearAuthorizeAttempt = {
        id: randomUUID(),
        pending,
        server,
        result: { status: 'pending' },
        cancelled: false,
      }
      this.attempt = attempt
      // Background completion: the exchange and the credential write happen
      // after this call already answered. The card learns the outcome by
      // polling `linearAuthorizeStatus`.
      void this.settle(attempt)
      return {
        status: 'started',
        attemptId: attempt.id,
        url: pending.url,
        expiresAt: this.now() + this.waitTimeoutMs,
      }
    } catch (error) {
      return { status: 'unavailable', reason: errorCodeOf(error) ?? 'linear.auth-unavailable' }
    } finally {
      this.beginInflight = false
    }
  }

  /** Answer the attempt's current state; a terminal answer is observed once. */
  async linearAuthorizeStatus(attemptId: string): Promise<MstarLinearAuthorizeStatus> {
    const attempt = this.attempt
    if (attempt === undefined || attempt.id !== attemptId) return { status: 'not-found' }
    if (attempt.result.status === 'pending') return attempt.result
    this.attempt = undefined
    attempt.pending.close()
    return attempt.result
  }

  /** Close the live attempt (the card's cancel control). */
  async linearAuthorizeCancel(attemptId: string): Promise<MstarLinearAuthorizeCancelResult> {
    const attempt = this.attempt
    if (attempt === undefined || attempt.id !== attemptId) return { status: 'not-found' }
    attempt.cancelled = true
    attempt.result = { status: 'cancelled' }
    attempt.pending.close()
    return { status: 'cancelled' }
  }

  /** The background leg: callback → exchange → credential write → row reload → terminal answer. */
  private async settle(attempt: LinearAuthorizeAttempt): Promise<void> {
    try {
      const code = await attempt.pending.wait(this.waitTimeoutMs)
      const tokens = await exchangeCode(
        attempt.server,
        { clientId: attempt.pending.clientId, redirectUri: attempt.pending.redirectUri },
        code,
        attempt.pending.verifier,
        this.fetchImpl,
      )
      if (this.disposed || attempt.cancelled) return
      writeLinearCredential({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        clientId: tokens.clientId,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      })
      // Adoption, not a bare reload: the service re-evaluates the persisted
      // expiry, arms exactly one schedule and reloads the row once. A host
      // that booted with no credential armed nothing, so this is the only
      // place a first grant can start its silent refresh.
      await this.auth.adoptCredential()
      if (this.disposed || attempt.cancelled) return
      attempt.result = { status: 'authorized', scope: tokens.scope, expiresAt: tokens.expiresAt }
    } catch (error) {
      if (this.disposed || attempt.cancelled) return
      const code = errorCodeOf(error)
      attempt.result = code === 'linear.auth-timeout'
        ? { status: 'timeout' }
        : { status: 'denied', reason: code ?? 'linear.auth-unavailable' }
    } finally {
      attempt.pending.close()
    }
  }
}

/** One generated-style invocation descriptor (all four ride the card's service). */
function linearInvocation(
  method: string,
  parameters: TypertContribution['invocations'][number]['parameters'],
): TypertContribution['invocations'][number] {
  return {
    id: `${MSTAR_CONTRIBUTING_PACKAGE}#${MSTAR_ENGINE_STATUS_NAMESPACE}/${method}`,
    service: LINEAR_SETTINGS_SERVICE,
    namespace: MSTAR_ENGINE_STATUS_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
  }
}

/** `mstar/linearStatus` — no arguments. */
export function mstarLinearStatusInvocation(): TypertContribution['invocations'][number] {
  return linearInvocation(MSTAR_LINEAR_STATUS_METHOD, [])
}

/** `mstar/linearAuthorizeBegin` — no arguments. */
export function mstarLinearAuthorizeBeginInvocation(): TypertContribution['invocations'][number] {
  return linearInvocation(MSTAR_LINEAR_AUTHORIZE_BEGIN_METHOD, [])
}

/** `mstar/linearAuthorizeStatus` — the attempt id. */
export function mstarLinearAuthorizeStatusInvocation(): TypertContribution['invocations'][number] {
  return linearInvocation(MSTAR_LINEAR_AUTHORIZE_STATUS_METHOD, [
    { name: 'attemptId', wire: 'attemptId', source: 'json', codec: { mode: 'src-json' } },
  ])
}

/** `mstar/linearAuthorizeCancel` — the attempt id. */
export function mstarLinearAuthorizeCancelInvocation(): TypertContribution['invocations'][number] {
  return linearInvocation(MSTAR_LINEAR_AUTHORIZE_CANCEL_METHOD, [
    { name: 'attemptId', wire: 'attemptId', source: 'json', codec: { mode: 'src-json' } },
  ])
}

/**
 * Install the card's host service on one apply scope. Deduped like the other
 * mstar gateways: the first instance keeps serving on a sibling apply.
 * The invocation descriptors are carried by `mstarEngineStatusContribution()`
 * (typert admits one contribution per package face) — this function only
 * provides the service they name.
 */
export function installLinearSettingsEndpoint(ctx: Context, options: MstarLinearSettingsOptions): void {
  let present = false
  try {
    present = ctx.get(LINEAR_SETTINGS_SERVICE) !== undefined
  } catch {
    present = false
  }
  if (present) {
    ctx.logger('mstar/linear-settings').debug('linear-settings gateway already registered — kept as-is (multi-fiber dedupe)')
    return
  }
  try {
    void new MstarLinearSettingsGateway(ctx, options)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('has been registered')) throw error
    ctx.logger('mstar/linear-settings').debug('linear-settings gateway registered concurrently — kept the first (multi-fiber dedupe)')
  }
}
