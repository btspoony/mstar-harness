/**
 * Client half of the engine-status channel: the per-session snapshot cache the
 * panel reads and the `/api/mstar/engineStatus` fetch that fills it.
 *
 * WHY a cache outside React: the panel is a browser bundle and the payload
 * lives on the HOST filesystem (the persisted catalog row is only the anchor —
 * its `source` is the frozen three-member first-party arm). The data therefore
 * arrives over the host's shared typert `/api` gateway, asynchronously and
 * repeatedly (every new anchor row asks again). Keeping that state in a small
 * observable store — rather than component state — gives one request per
 * (session, anchor) across re-renders, survives the panel unmounting, and lets
 * the render path read it synchronously.
 *
 * KEYING, not adjacency: entries are keyed by session id, and a response is
 * validated against the session that was REQUESTED
 * ({@link parseEngineStatusResult}) — session A's panel can never render
 * session B's snapshot.
 *
 * GENERATIONS: a new connection generation makes every wire-derived byte
 * suspect, so `invalidate()` bumps a generation counter, drops the cache and
 * clears the in-flight registry; a request answered after the bump is discarded
 * on arrival ({@link MstarEngineStatusClient.write}) and the next render
 * re-issues it. Without the fence an in-flight pre-reconnect answer would
 * repopulate the cache and then suppress the repull the invalidation exists to
 * force.
 *
 * DEADLINES: the gateway is a network hop, so one request is bounded
 * ({@link MstarEngineStatusClientOptions.timeoutMs}) and a request that
 * outlives its budget degrades to the explicit `unavailable('timeout:…')`
 * reason instead of pinning `loading` for a whole turn. A served snapshot is
 * likewise re-pulled on a modest interval
 * ({@link MstarEngineStatusClientOptions.refreshIntervalMs}) — D3's "explicit
 * refresh", never per agent-flow event. A refresh asks for the anchor it saw,
 * so it never overwrites a newer anchor's answer ({@link
 * MstarEngineStatusClient.write}).
 *
 * The store is written ONLY from a response continuation (never during a
 * render), so reading it through `useSyncExternalStore` stays within React's
 * snapshot contract.
 *
 * @module @mstar-harness/dsh/client/panel/engine-status-client
 */

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { ENGINE_STATUS_CHANNEL, ENGINE_STATUS_ENDPOINT } from '../../engine-status-wire.ts'
import { parseEngineStatusResult, type MstarEngineStatusFetch } from './guards.ts'

// The wire address is the SAME declaration the host half builds its descriptor
// from (`../../engine-status-wire.ts`); re-exported here for the panel's own
// consumers and specs.
export { ENGINE_STATUS_CHANNEL, ENGINE_STATUS_ENDPOINT }

/** Deadline for one `/api/mstar/engineStatus` request (a hanging gateway must not pin `loading`). */
export const ENGINE_STATUS_REQUEST_TIMEOUT_MS = 5_000
/** How often a served snapshot is re-pulled (D3's "explicit refresh", modest interval). */
export const ENGINE_STATUS_REFRESH_INTERVAL_MS = 30_000

/**
 * Structural face of the client `connection` service the panel needs — the
 * generic RPC caller of the shared gateway. Declared structurally (not
 * imported) so the bundle stays free of any runtime dependency on the
 * transport package: the host injects `@deepseek-ai/dsh-client-connection`
 * through the client manifest.
 */
export interface MstarEngineStatusConnection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
  /**
   * Connection generations: a new generation means every wire-derived byte is
   * suspect, so the cache is dropped and the panel repulls.
   */
  readonly generation?: { subscribe(listener: () => void): () => void }
}

/** Optional timings (test seams; production uses the two constants above). */
export interface MstarEngineStatusClientOptions {
  /** Per-request deadline in ms (`0` disables the bound). */
  readonly timeoutMs?: number
  /** Refresh interval in ms (`0` disables the interval). */
  readonly refreshIntervalMs?: number
}

/** One session's cached answer, tagged with the anchor row it answers. */
export interface MstarEngineStatusEntry {
  /** Message time of the anchor row this answer belongs to (staleness key). */
  readonly anchorTime: number
  /** The workspace directory the answer was requested for (reused by a refresh). */
  readonly cwd: string
  /** When the answer landed — the refresh clock (never the anchor row's time). */
  readonly fetchedAt: number
  readonly fetch: MstarEngineStatusFetch
}

/** The observable store value: at most one entry per session. */
export interface MstarEngineStatusSnapshot {
  readonly entries: ReadonlyMap<string, MstarEngineStatusEntry>
}

/** Stable empty snapshot — a shared reference keeps `getSnapshot` referentially stable. */
const EMPTY: MstarEngineStatusSnapshot = { entries: new Map() }

/**
 * The panel's engine-status client: one `/api/mstar/engineStatus` request per
 * (session, anchor row), cached per session and observable by React.
 */
export class MstarEngineStatusClient {
  private snapshot: MstarEngineStatusSnapshot = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly abort = new AbortController()
  /** Refreshes in flight, keyed by session (one per session, alongside the anchor requests). */
  private readonly refreshing = new Set<string>()
  private readonly timeoutMs: number
  private readonly refreshIntervalMs: number
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private generationDisposer: (() => void) | null = null
  /** Connection generation: bumped by {@link invalidate}; a mismatched answer is dropped. */
  private generation = 0
  private disposed = false

  /**
   * @param connection - the client `connection` service, or undefined in a
   *   composition without one (the panel then reports `unavailable`).
   * @param options - request deadline / refresh interval (test seams).
   */
  constructor(
    private readonly connection: MstarEngineStatusConnection | null | undefined,
    options: MstarEngineStatusClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? ENGINE_STATUS_REQUEST_TIMEOUT_MS
    this.refreshIntervalMs = options.refreshIntervalMs ?? ENGINE_STATUS_REFRESH_INTERVAL_MS
    try {
      this.generationDisposer = connection?.generation?.subscribe(() => { this.invalidate() }) ?? null
    } catch {
      // A transport that cannot be subscribed is not a reason to lose the
      // panel: the cache simply never repulls on reconnect.
      this.generationDisposer = null
    }
    this.startRefreshTimer()
  }

  /** Current store value (stable reference until a response lands). */
  getSnapshot = (): MstarEngineStatusSnapshot => this.snapshot

  /** Subscribe to store writes (`useSyncExternalStore` face). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Ensure the session's snapshot for ONE anchor row is being fetched. Safe to
   * call on every render: an entry that already answers this anchor, and a
   * request already in flight for it, are both no-ops.
   * @param sessionId - the session the panel is showing.
   * @param cwd - the session's workspace directory (the host cross-checks it
   *   against the session and the stored snapshot; an unknown cwd is not
   *   asserted, the panel degrades explicitly instead).
   * @param anchorTime - message time of the anchor row this request answers.
   */
  ensure(sessionId: string, cwd: string, anchorTime: number): void {
    if (this.disposed) return
    if (this.snapshot.entries.get(sessionId)?.anchorTime === anchorTime) return
    const key = `${sessionId}\u0000${anchorTime}`
    if (this.inFlight.has(key)) return
    const request = this.fetch(sessionId, cwd, anchorTime)
      .finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, request)
  }

  /**
   * Drop every cached answer (a new connection generation invalidates the wire
   * data) and fence off the requests already on the wire: their answers belong
   * to the previous generation and must never repopulate the cache, or the
   * repull this invalidation exists to force would be suppressed by them.
   */
  invalidate(): void {
    if (this.disposed) return
    this.generation += 1
    this.inFlight.clear()
    if (this.snapshot.entries.size === 0) return
    this.snapshot = EMPTY
    this.notify()
  }

  /** Stop accepting writes, abort in-flight requests and end the refresh interval (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.generationDisposer?.()
    this.generationDisposer = null
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.abort.abort()
    this.listeners.clear()
  }

  /**
   * Re-pull every served snapshot on a modest interval: the host keeps emitting
   * on each digest-gated `agent/pre-step`, and a panel left open on an idle
   * session would otherwise never see a newer snapshot. Deliberately NOT tied to
   * agent-flow events, and never in flight twice for one session.
   */
  private startRefreshTimer(): void {
    if (this.disposed || this.refreshIntervalMs <= 0) return
    if (typeof setInterval !== 'function') return
    this.refreshTimer = setInterval(() => { this.refresh() }, this.refreshIntervalMs)
    // A long-lived Node process (SSR / tests) must not be held open by it.
    const timer = this.refreshTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  /**
   * One refresh pass over the cache: every entry older than the refresh
   * interval is re-pulled for the SAME anchor (the anchor only moves when the
   * host appends a newer row, which already triggers its own request). Public
   * as the interval's deterministic test seam; the interval calls it.
   */
  refresh(): void {
    if (this.disposed) return
    const now = Date.now()
    for (const [sessionId, entry] of [...this.snapshot.entries]) {
      if (this.disposed) return
      if (now - entry.fetchedAt < this.refreshIntervalMs) continue
      if (this.refreshing.has(sessionId)) continue
      // The cache moved to a newer anchor while nothing was refreshing: the
      // entry this pass planned to re-pull is superseded, so re-pulling it
      // would cost a request that publishes an older snapshot over a newer one.
      if (this.snapshot.entries.get(sessionId)?.anchorTime !== entry.anchorTime) continue
      this.refreshing.add(sessionId)
      void this.fetch(sessionId, entry.cwd, entry.anchorTime)
        .finally(() => { this.refreshing.delete(sessionId) })
    }
  }

  /**
   * One request → one validated entry. Never throws: a fault, a missing
   * connection and an exceeded deadline are all explicit reasons.
   * @returns the answer (also published through {@link write} when the
   *   generation it was issued under is still current).
   */
  private async fetch(sessionId: string, cwd: string, anchorTime: number): Promise<void> {
    const generation = this.generation
    let answer: MstarEngineStatusFetch
    if (this.connection === null || this.connection === undefined || typeof this.connection.rpc?.call !== 'function') {
      answer = { status: 'unavailable', reason: 'no-connection' }
    } else {
      try {
        // The host's shared typert gateway: exactly one plain-object `args`
        // field, keyed by the endpoint descriptor's declared parameter names
        // (`sessionId`, `cwd`).
        const raw = await this.withDeadline((signal) => this.connection!.rpc.call(
          ENGINE_STATUS_CHANNEL,
          ENGINE_STATUS_ENDPOINT,
          { args: { sessionId, cwd } },
          signal,
        ))
        answer = parseEngineStatusResult(raw, sessionId, cwd)
      } catch (error) {
        answer = { status: 'unavailable', reason: `transport-error:${(error as Error)?.message ?? 'unknown'}` }
      }
    }
    this.write(generation, sessionId, cwd, anchorTime, answer)
  }

  /**
   * Bound one request: the request is aborted at the deadline and the caller
   * gets the explicit timeout reason. A gateway that never answers must not pin
   * `loading` (and with it the panel) for a whole turn.
   */
  private async withDeadline<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0 || typeof setTimeout !== 'function') return await call(this.abort.signal)
    const controller = new AbortController()
    const relay = (): void => { controller.abort() }
    this.abort.signal.addEventListener('abort', relay)
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`timeout:${this.timeoutMs}ms`))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([call(controller.signal), deadline])
    } finally {
      if (timer !== null) clearTimeout(timer)
      this.abort.signal.removeEventListener('abort', relay)
    }
  }

  /**
   * Publish one answer (the only writer — always outside a render).
   *
   * An answer issued under a superseded connection generation is DROPPED: it
   * describes the connection that is gone, and publishing it would both render
   * pre-reconnect data as `ok` and suppress the repull `invalidate()` forces
   * (the stale answer would satisfy `ensure`'s anchor check).
   *
   * An answer for a SUPERSEDED anchor is dropped for the same class of reason:
   * a refresh issues its request for the anchor it saw, and a newer anchor row
   * can be answered in the meantime, so publishing on arrival would overwrite a
   * newer snapshot with an older one under a refreshed cache clock and no
   * staleness marker. `ensure` already refuses an older anchor, which is why
   * this only ever happens through {@link refresh}.
   */
  private write(
    generation: number,
    sessionId: string,
    cwd: string,
    anchorTime: number,
    fetch: MstarEngineStatusFetch,
  ): void {
    if (this.disposed) return
    if (generation !== this.generation) return
    if ((this.snapshot.entries.get(sessionId)?.anchorTime ?? anchorTime) > anchorTime) return
    this.writeEntry(sessionId, { anchorTime, cwd, fetchedAt: Date.now(), fetch })
  }

  /** The store write itself (no generation test — see {@link write}). */
  private writeEntry(sessionId: string, entry: MstarEngineStatusEntry): void {
    const entries = new Map(this.snapshot.entries)
    entries.set(sessionId, entry)
    this.snapshot = { entries }
    this.notify()
  }

  /** Notify subscribers, isolating a throwing listener. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber never breaks the store (the panel's other seats
        // and every later write stay live).
      }
    }
  }
}
