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
 * authorization, never a widened grant (a refresh sends no scope), and never a
 * retry spin.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  LINEAR_MCP_URL,
  REFRESH_WINDOW_MS,
  discoverAuthorizationServer,
  readLinearCredential,
  refreshToken,
  writeLinearCredential,
  type LinearCredential,
  type LinearCredentialState,
  type TokenSet,
} from '@mstar-harness/engine'
import type { LoaderEntryView } from './gates/fallbacks-probe.ts'

/** The one Linear provider row this service feeds. */
export const LINEAR_MCP_ENTRY_ID = 'linear-mcp'

/** The service name the row's `inject` and headers expression use. */
export const LINEAR_AUTH_SERVICE = 'mstarLinearAuth'

/** Refresh exchanges carry no redirect; the flow still takes one. */
const REFRESH_REDIRECT = 'http://localhost:0/callback'

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
 * Whether the file changed under an in-flight refresh AND the change is newer
 * — another process (a CLI push/import) stored a credential this process must
 * adopt instead of overwriting with older data.
 */
function supersededBy(state: LinearCredentialState, base: LinearCredential): boolean {
  if (state.kind !== 'present') return false
  const candidate = state.credential
  if (candidate.accessToken === base.accessToken) return false
  if (candidate.clientId !== base.clientId) return true
  return candidate.expiresAt !== null && (base.expiresAt === null || candidate.expiresAt > base.expiresAt)
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
      return { kind: 'unknown-expiry', note: 'expiry unknown; refresh is attempted on the next observed need' }
    }
    return { kind: 'scheduled', at: state.credential.expiresAt - REFRESH_WINDOW_MS }
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
    } catch {
      // A fiber that unloaded between the check and the call is not a failure:
      // nothing was connected any more.
      return false
    }
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
      this.schedule(before)
      return { kind: 'idle' }
    }
    const { credential } = before
    if (credential.refreshToken === null || credential.clientId === null) {
      this.refuse('linear.reauth-required', 'the stored credential is due and holds no refresh token to renew it')
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: 'refused', code: 'linear.reauth-required' }
    }
    try {
      const server = await discoverAuthorizationServer(LINEAR_MCP_URL, this.fetchImpl)
      const fresh = await refreshToken(
        server,
        { clientId: credential.clientId, redirectUri: REFRESH_REDIRECT },
        credential.refreshToken,
        this.fetchImpl,
      )
      if (this.disposed) return { kind: 'skipped' }
      const outcome = this.persist(before, fresh)
      this.refusal = null
      this.log('info', `linear credential refreshed (${outcome}); reloading the ${LINEAR_MCP_ENTRY_ID} row`)
      await this.reloadRow()
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: outcome }
    } catch (error) {
      const code = errorCodeOf(error) ?? 'linear.auth-unavailable'
      this.refuse(code, messageOf(error))
      // No retry spin: this attempt answered the tick. The next one waits for
      // the following window or the next observed need.
      this.schedule(readLinearCredential(this.clock.now()))
      return { kind: 'refused', code }
    }
  }

  private persist(
    before: Extract<LinearCredentialState, { kind: 'present' }>,
    fresh: TokenSet,
  ): 'refreshed' | 'adopted' {
    const current = readLinearCredential(this.clock.now())
    if (supersededBy(current, before.credential)) return 'adopted'
    writeLinearCredential({
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? before.credential.refreshToken,
      clientId: fresh.clientId ?? before.credential.clientId,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope ?? before.credential.scope,
    })
    return 'refreshed'
  }

  private schedule(state: LinearCredentialState): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    if (this.disposed || state.kind !== 'present' || state.credential.expiresAt === null) return
    const delay = state.credential.expiresAt - REFRESH_WINDOW_MS - this.clock.now()
    // Already due: this tick just ran. Re-arming at zero would spin.
    if (delay <= 0) return
    this.cancelTimer = this.clock.schedule(() => {
      this.cancelTimer = undefined
      void this.refreshIfDue()
    }, delay)
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
