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

/** The display words the host derives from the credential file (Task 4's shared vocabulary). */
export type LinearCredentialDisplay = 'authorized' | 'expired' | 'absent' | 'unreadable'

/** The only credential facts the card may see. */
export interface LinearCredentialView {
  readonly display: LinearCredentialDisplay
  readonly scope: string | null
  readonly expiresAt: number | null
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

/** The card's own failure vocabulary (the RPC unions plus a transport failure). */
export type LinearSettingsOutcome =
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unavailable'; readonly reason: string }

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

/** Validate one `linearAuthorizeStatus` answer into the closed union (total). */
export function parseLinearAuthorizeStatus(value: unknown): LinearAuthorizeStatus {
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
      return { status: 'denied', reason: 'malformed-answer' }
  }
}

/** The card's transport: four one-shot calls, one pending poll, no other scheduling. */
export class LinearSettingsStore {
  private state: LinearSettingsState = { read: { status: 'idle' }, attempt: null, outcome: null }
  private readonly listeners = new Set<() => void>()
  private timer: unknown
  private disposed = false
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
    const answer = parseLinearAuthorizeBegin(await this.call(LINEAR_AUTHORIZE_BEGIN_ENDPOINT, {}))
    if (this.disposed) return answer
    if (answer.status !== 'started') {
      this.update({
        ...this.state,
        attempt: null,
        outcome: answer.status === 'attempt-active'
          ? { status: 'denied', reason: 'attempt-active' }
          : { status: 'unavailable', reason: answer.reason },
      })
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

  private async poll(): Promise<void> {
    const attempt = this.state.attempt
    if (attempt === null || this.disposed) return
    const status = parseLinearAuthorizeStatus(
      await this.call(LINEAR_AUTHORIZE_STATUS_ENDPOINT, { attemptId: attempt.id }),
    )
    if (this.disposed || this.state.attempt?.id !== attempt.id) return
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
    this.state = next
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
