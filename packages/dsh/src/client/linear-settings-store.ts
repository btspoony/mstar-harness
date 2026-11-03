/**
 * Browser half of the Linear Settings card: the four `/api/mstar` calls and
 * the card's closed state machine.
 *
 * Why a store instead of component state: the authorization attempt outlives
 * a render (consent can take minutes) and the renderer may remount the card.
 * The attempt id, the pending poll and the observed outcome live here.
 *
 * Two deadlines are deliberate and separate:
 * - each RPC is capped at {@link LINEAR_SETTINGS_READ_DEADLINE_MS}; the
 *   multi-minute consent is NEVER held inside one call;
 * - the host owns the attempt deadline (`begin` returns its `expiresAt`), and
 *   this store merely polls `linearAuthorizeStatus` until a terminal answer.
 *
 * The browser receives an authorization URL, a scope and an expiry. It never
 * receives the PKCE verifier, an access token, a refresh token, a client
 * secret, an account or an email — and it forwards none of them anywhere.
 */

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import {
  ENGINE_STATUS_CHANNEL,
  LINEAR_AUTHORIZE_BEGIN_ENDPOINT,
  LINEAR_AUTHORIZE_CANCEL_ENDPOINT,
  LINEAR_AUTHORIZE_STATUS_ENDPOINT,
  LINEAR_STATUS_ENDPOINT,
} from '../engine-status-wire.ts'

/** Per-request deadline. A wedged gateway must not leave a call pending forever. */
export const LINEAR_SETTINGS_READ_DEADLINE_MS = 5_000

/** Poll cadence while the host attempt is pending. */
export const LINEAR_SETTINGS_POLL_MS = 1_000

/** Consecutive polls without a host answer before the attempt stops observing. */
export const LINEAR_SETTINGS_POLL_FAILURE_LIMIT = 5

/**
 * How long a live attempt this store did not start stays watched through the
 * host row. The host's own attempt deadline, so a consent that is still open
 * has time to land before the card offers Authorize again.
 */
export const LINEAR_SETTINGS_IN_FLIGHT_WINDOW_MS = 300_000

/** The display words the host derives from the credential file (Task 4's shared vocabulary). */
export type LinearCredentialDisplay = 'authorized' | 'expired' | 'absent' | 'unreadable'

/** The only credential facts the card may see. */
export interface LinearCredentialView {
  readonly display: LinearCredentialDisplay
  readonly scope: string | null
  readonly expiresAt: number | null
  /** Whether the grant can create or update issues; `display` says whether it is valid. */
  readonly canWrite: boolean
}

/** What `linearStatus` answered: the row's own bit plus non-secret credential facts. */
export type LinearStatusRead =
  | {
    readonly status: 'ready'
    readonly rowEnabled: boolean
    readonly fiberPhase: string
    readonly credential: LinearCredentialView
  }
  | { readonly status: 'unavailable'; readonly reason: string }

/** The closed answer union of one authorization attempt. */
export type LinearAuthorizeStatus =
  | { readonly status: 'pending' }
  | { readonly status: 'authorized'; readonly scope: string | null; readonly expiresAt: number | null }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'not-found' }

/** What `linearAuthorizeBegin` answered. */
export type LinearAuthorizeBegin =
  | { readonly status: 'started'; readonly attemptId: string; readonly url: string; readonly expiresAt: number }
  | { readonly status: 'attempt-active' }
  | { readonly status: 'unavailable'; readonly reason: string }

/** The card's own outcome vocabulary (the RPC unions plus a transport failure). */
export type LinearSettingsOutcome =
  /**
   * Another attempt is live on the host and this store holds no id for it, so
   * nothing failed: the card watches the row that attempt writes on success.
   */
  | { readonly status: 'in-flight'; readonly reason: 'attempt-active' }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unavailable'; readonly reason: string }
  /** The host stopped answering the status RPC: no outcome was observed, not a denial. */
  | { readonly status: 'unreachable' }

/** One render snapshot. `read: idle` is what triggers the card's first load. */
export interface LinearSettingsState {
  readonly read: LinearStatusRead | { readonly status: 'idle' } | { readonly status: 'loading' }
  readonly attempt: { readonly id: string } | null
  readonly outcome: LinearSettingsOutcome | null
}

/** The client `connection` face this store consumes (structural, no host value import). */
export interface LinearSettingsConnection {
  /** Whether the page authority is the host itself (the loopback callback's precondition). */
  readonly isLoopback?: boolean
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
}

/** Test/production seams: browser opening, poll cadence, loopback knowledge. */
export interface LinearSettingsOptions {
  /** `false` when the page is served for a browser that is not on the host. */
  readonly loopback?: boolean
  /** How the consent URL reaches the browser (default: `window.open`). */
  readonly openBrowser?: (url: string) => void
  readonly schedule?: (run: () => void, delayMs: number) => unknown
  readonly cancelSchedule?: (timer: unknown) => void
  readonly pollMs?: number
}

/** A guarded object read at the RPC boundary (malformed answers degrade explicitly). */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function displayOf(value: unknown): LinearCredentialDisplay | null {
  return value === 'authorized' || value === 'expired' || value === 'absent' || value === 'unreadable' ? value : null
}

/** Validate one `linearStatus` answer into the closed union (total). */
export function parseLinearStatusRead(value: unknown): LinearStatusRead {
  const record = recordOf(value)
  if (record?.status === 'unavailable') {
    return { status: 'unavailable', reason: textOf(record.reason) ?? 'unknown' }
  }
  const credential = recordOf(record?.credential)
  const display = displayOf(credential?.display)
  if (record?.status !== 'ready' || typeof record.rowEnabled !== 'boolean' || display === null) {
    return { status: 'unavailable', reason: 'malformed-answer' }
  }
  const scope = credential?.scope
  const expiresAt = credential?.expiresAt
  return {
    status: 'ready',
    rowEnabled: record.rowEnabled,
    fiberPhase: textOf(record.fiberPhase) ?? 'unknown',
    credential: {
      display,
      scope: typeof scope === 'string' ? scope : null,
      expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null,
      // Fail closed: an answer that does not state the capability never earns
      // an Authorize-suppressing render.
      canWrite: credential?.canWrite === true,
    },
  }
}

/** Validate one `linearAuthorizeBegin` answer into the closed union (total). */
export function parseLinearAuthorizeBegin(value: unknown): LinearAuthorizeBegin {
  const record = recordOf(value)
  if (record?.status === 'attempt-active') return { status: 'attempt-active' }
  if (record?.status === 'unavailable') {
    return { status: 'unavailable', reason: textOf(record.reason) ?? 'unknown' }
  }
  const attemptId = textOf(record?.attemptId)
  const url = textOf(record?.url)
  const expiresAt = record?.expiresAt
  if (record?.status !== 'started' || attemptId === null || url === null || typeof expiresAt !== 'number') {
    return { status: 'unavailable', reason: 'malformed-answer' }
  }
  return { status: 'started', attemptId, url, expiresAt }
}

/**
 * Validate one `linearAuthorizeStatus` answer into the closed union (total).
 * `null` means the call produced no host answer at all (a transport failure,
 * a deadline abort, or a shape no gateway emits) — never a `denied`, which is
 * reserved for what the host itself reported.
 */
export function parseLinearAuthorizeStatus(value: unknown): LinearAuthorizeStatus | null {
  const record = recordOf(value)
  switch (record?.status) {
    case 'pending':
      return { status: 'pending' }
    case 'authorized': {
      const scope = record.scope
      const expiresAt = record.expiresAt
      return {
        status: 'authorized',
        scope: typeof scope === 'string' ? scope : null,
        expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null,
      }
    }
    case 'denied':
      return { status: 'denied', reason: textOf(record.reason) ?? 'unknown' }
    case 'timeout':
      return { status: 'timeout' }
    case 'cancelled':
      return { status: 'cancelled' }
    case 'not-found':
      return { status: 'not-found' }
    default:
      return null
  }
}

/**
 * Whether the row's grant differs from the one the watch began with. No
 * baseline means this card showed no grant when the watch began, so the first
 * authorized row is the live attempt's result.
 */
function credentialChangedSince(before: LinearCredentialView | null, now: LinearCredentialView): boolean {
  return before === null ||
    before.display !== now.display ||
    before.scope !== now.scope ||
    before.expiresAt !== now.expiresAt
}

/** The card's transport: four one-shot calls, one pending poll, no other scheduling. */
export class LinearSettingsStore {
  private state: LinearSettingsState = { read: { status: 'idle' }, attempt: null, outcome: null }
  private readonly listeners = new Set<() => void>()
  private timer: unknown
  private disposed = false
  /** Consecutive polls that produced no host answer (reset by any real answer). */
  private pollFailures = 0
  /** Polls still owed to a live attempt this store does not own. */
  private inFlightProbesLeft = 0
  /** Consecutive in-flight probes that produced no usable host facts. */
  private inFlightProbeFailures = 0
  /** The credential the row already showed when the watch began. */
  private inFlightBaseline: LinearCredentialView | null = null
  /** The observation budget for one such attempt, derived from the poll cadence. */
  private readonly inFlightProbeLimit: number
  /**
   * The snapshot no render has consumed yet. A render may decide from the
   * current facts only while it is this snapshot: facts the host re-renders
   * unchanged were not verified in this render cycle, so the card treats them
   * as unknown and reads them again.
   */
  private unverified: LinearSettingsState | null = null
  /** Whether the read the current render needs is already queued. */
  private readQueued = false
  private readonly openBrowser: (url: string) => void
  private readonly schedule: (run: () => void, delayMs: number) => unknown
  private readonly cancelSchedule: (timer: unknown) => void
  private readonly pollMs: number
  /** Whether this browser may complete a loopback authorization at all. */
  readonly loopback: boolean

  /** The renderer binds this as the card's `useSnapshot` selector hook. */
  readonly snapshot = {
    getSnapshot: (): LinearSettingsState => this.state,
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  constructor(
    private readonly connection: LinearSettingsConnection | undefined,
    options: LinearSettingsOptions = {},
  ) {
    this.loopback = options.loopback ?? (connection?.isLoopback !== false)
    this.openBrowser = options.openBrowser ?? ((url) => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    })
    this.schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs))
    this.cancelSchedule = options.cancelSchedule ?? ((timer) => {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0])
    })
    this.pollMs = options.pollMs ?? LINEAR_SETTINGS_POLL_MS
    this.inFlightProbeLimit = Math.max(1, Math.ceil(LINEAR_SETTINGS_IN_FLIGHT_WINDOW_MS / this.pollMs))
  }

  /**
   * The host's render boundary: the Plugins page calls this on every card
   * render. The slot contract exposes no row-change event (owner props carry
   * `view` and a config form only), so a render is the only boundary at which
   * a row toggle can be re-read.
   *
   * A render may decide from facts only when it consumes the very snapshot the
   * answer landed in; facts it inherited were not verified in this render
   * cycle, so they answer `null` (unknown) and the read is queued. The read is
   * skipped while one is in flight or an attempt owns the state, which is what
   * keeps this from becoming a fetch loop.
   *
   * shortcut: one read per render body call, so a host that renders twice per
   * commit (StrictMode) adds a read — re-verify if the host enables it.
   * @returns the facts this render cycle may decide from, or null when unknown.
   */
  factsForRender(): LinearStatusRead | null {
    if (this.disposed) return null
    const verified = this.unverified === this.state
    this.unverified = null
    const read = this.state.read
    if (read.status !== 'ready' && read.status !== 'unavailable') {
      // `idle` is the first render's request; `loading` is that request in
      // flight, and `queueRead` drops the renders that land inside it.
      if (read.status === 'idle') this.queueRead()
      return null
    }
    if (verified) return read
    // An attempt owns the state: it replaces the facts itself, so the card
    // waits for it instead of re-reading underneath it.
    if (this.state.attempt !== null) return read
    this.queueRead()
    return null
  }

  /** Queue one read for the renders that asked for it: never two, none while one is in flight. */
  private queueRead(): void {
    if (this.readQueued || this.state.read.status === 'loading') return
    this.readQueued = true
    // A microtask, not a call: the read never writes to the store during render.
    queueMicrotask(() => {
      this.readQueued = false
      if (this.disposed) return
      void this.refresh()
    })
  }

  /** Read the host's credential/row facts. A first call flips `idle → loading` synchronously (no render loop). */
  async refresh(): Promise<void> {
    if (this.state.read.status === 'loading') return
    this.update({ ...this.state, read: { status: 'loading' } })
    const read = await this.call(LINEAR_STATUS_ENDPOINT, {})
    if (this.disposed) return
    this.update({ ...this.state, read: parseLinearStatusRead(read) })
  }

  /**
   * Start the host-owned attempt, open the consent page and begin observing.
   * Returns the transport answer for callers that need it (tests assert the
   * closed result carries no secret).
   */
  async begin(): Promise<LinearAuthorizeBegin> {
    this.clearTimer()
    this.pollFailures = 0
    this.inFlightProbesLeft = 0
    this.inFlightProbeFailures = 0
    this.inFlightBaseline = null
    const answer = parseLinearAuthorizeBegin(await this.call(LINEAR_AUTHORIZE_BEGIN_ENDPOINT, {}))
    if (this.disposed) return answer
    if (answer.status === 'attempt-active' && this.state.attempt !== null) {
      // A second click raced this store's own begin: the attempt it already
      // observes is the live one, so keep polling it instead of replacing it.
      this.schedulePoll()
      return answer
    }
    if (answer.status !== 'started') {
      this.update({
        ...this.state,
        attempt: null,
        outcome: answer.status === 'attempt-active'
          ? { status: 'in-flight', reason: 'attempt-active' }
          : { status: 'unavailable', reason: answer.reason },
      })
      if (answer.status === 'attempt-active') {
        // No id came back, so the host row is the only observable: keep
        // reading it while that attempt may still complete. The grant this
        // card already showed is not that attempt's result, so only a grant
        // that changed from here ends the watch.
        this.inFlightBaseline = this.state.read.status === 'ready' ? this.state.read.credential : null
        this.inFlightProbesLeft = this.inFlightProbeLimit
        this.scheduleInFlightProbe()
      }
      return answer
    }
    this.update({ ...this.state, attempt: { id: answer.attemptId }, outcome: null })
    // The browser receives the authorization URL only; the verifier, state and
    // listener stay on the host.
    this.openBrowser(answer.url)
    this.schedulePoll()
    return answer
  }

  /** Ask the host to close the pending attempt (the card's own cancel control). */
  async cancel(): Promise<void> {
    const attempt = this.state.attempt
    if (attempt === null) return
    this.clearTimer()
    const answer = recordOf(await this.call(LINEAR_AUTHORIZE_CANCEL_ENDPOINT, { attemptId: attempt.id }))
    if (this.disposed) return
    const status = answer?.status
    this.update({
      ...this.state,
      attempt: null,
      outcome: status === 'cancelled'
        ? { status: 'cancelled' }
        : status === 'not-found'
          ? { status: 'not-found' }
          : { status: 'unavailable', reason: 'cancel-failed' },
    })
  }

  /** Stop polling and ignore late answers (the plugin fiber's unload path). */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.listeners.clear()
  }

  private schedulePoll(): void {
    this.clearTimer()
    if (this.disposed) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.poll()
    }, this.pollMs)
  }

  /**
   * A live attempt this store did not start carries no id here, so the row the
   * host writes on success is the only observable. The probe reads the facts
   * directly (no `loading` flip under the pending card) and ends at a grant
   * that changed since the watch began, at a row that can no longer complete,
   * at the host's attempt window, or after a bounded run of no answers.
   */
  private scheduleInFlightProbe(): void {
    this.clearTimer()
    if (this.disposed) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.probeInFlight()
    }, this.pollMs)
  }

  private async probeInFlight(): Promise<void> {
    if (this.disposed || this.state.outcome?.status !== 'in-flight') return
    const read = parseLinearStatusRead(await this.call(LINEAR_STATUS_ENDPOINT, {}))
    if (this.disposed || this.state.outcome?.status !== 'in-flight') return
    this.inFlightProbesLeft -= 1
    if (read.status !== 'ready') {
      // No usable answer (transport wedge, deadline, malformed) is NOT a
      // verdict on the attempt: the consent may still be completing on the
      // host, so keep observing — bounded, then end honestly at `unreachable`
      // and re-read the facts, the same shape `poll()` uses. Writing the
      // degraded read here would flip the card into an `unavailable` alert.
      this.inFlightProbeFailures += 1
      if (this.inFlightProbeFailures < LINEAR_SETTINGS_POLL_FAILURE_LIMIT && this.inFlightProbesLeft > 0) {
        this.scheduleInFlightProbe()
        return
      }
      this.inFlightProbeFailures = 0
      this.update({ ...this.state, outcome: { status: 'unreachable' } })
      await this.refresh()
      return
    }
    this.inFlightProbeFailures = 0
    const settled =
      !read.rowEnabled ||
      (read.credential.display === 'authorized' &&
        credentialChangedSince(this.inFlightBaseline, read.credential)) ||
      this.inFlightProbesLeft <= 0
    this.update({ ...this.state, read, ...(settled ? { outcome: null } : {}) })
    if (!settled) this.scheduleInFlightProbe()
  }

  private async poll(): Promise<void> {
    const attempt = this.state.attempt
    if (attempt === null || this.disposed) return
    const status = parseLinearAuthorizeStatus(
      await this.call(LINEAR_AUTHORIZE_STATUS_ENDPOINT, { attemptId: attempt.id }),
    )
    if (this.disposed || this.state.attempt?.id !== attempt.id) return
    if (status === null) {
      // No host answer (transport wedge or deadline). That is NOT a denial:
      // the consent may still be completing on the host, so keep observing —
      // bounded, and the bounded end re-reads the host facts rather than
      // inventing an outcome.
      this.pollFailures += 1
      if (this.pollFailures < LINEAR_SETTINGS_POLL_FAILURE_LIMIT) {
        this.schedulePoll()
        return
      }
      this.pollFailures = 0
      this.clearTimer()
      this.update({ ...this.state, attempt: null, outcome: { status: 'unreachable' } })
      await this.refresh()
      return
    }
    this.pollFailures = 0
    if (status.status === 'pending') {
      this.schedulePoll()
      return
    }
    this.clearTimer()
    if (status.status === 'authorized') {
      this.update({ ...this.state, attempt: null, outcome: null })
      // Re-read the host facts instead of trusting the attempt's echo: the
      // card then shows the same scope/expiry the file now holds.
      await this.refresh()
      return
    }
    this.update({ ...this.state, attempt: null, outcome: status })
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.cancelSchedule(this.timer)
    this.timer = undefined
  }

  private update(next: LinearSettingsState): void {
    // Only a snapshot that carries a new host-facts answer becomes the one a
    // render may consume. A state-only change (attempt start/end, outcome)
    // inherits the previous answer without a new observation, so it must not
    // bless that answer: the marker stays as it was, and the next render treats
    // the inherited bit as unknown and reads the host.
    const carriesFacts = next.read !== this.state.read
    this.state = next
    if (carriesFacts) this.unverified = next
    for (const listener of this.listeners) listener()
  }

  /** One closed-deadline RPC; a transport failure answers `undefined`. */
  private async call(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.connection === undefined) return undefined
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), LINEAR_SETTINGS_READ_DEADLINE_MS)
    try {
      const result = await this.connection.rpc.call(ENGINE_STATUS_CHANNEL, endpoint, { args }, controller.signal)
      return result.ok === true ? result.value : undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(deadline)
    }
  }
}
