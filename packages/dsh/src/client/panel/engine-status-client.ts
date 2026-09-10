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

/** One session's cached answer, tagged with the anchor row it answers. */
export interface MstarEngineStatusEntry {
  /** Message time of the anchor row this answer belongs to (staleness key). */
  readonly anchorTime: number
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
  private generationDisposer: (() => void) | null = null
  private disposed = false

  /**
   * @param connection - the client `connection` service, or undefined in a
   *   composition without one (the panel then reports `unavailable`).
   */
  constructor(private readonly connection: MstarEngineStatusConnection | null | undefined) {
    try {
      this.generationDisposer = connection?.generation?.subscribe(() => { this.invalidate() }) ?? null
    } catch {
      // A transport that cannot be subscribed is not a reason to lose the
      // panel: the cache simply never repulls on reconnect.
      this.generationDisposer = null
    }
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

  /** Drop every cached answer (a new connection generation invalidates the wire data). */
  invalidate(): void {
    if (this.disposed || this.snapshot.entries.size === 0) return
    this.snapshot = EMPTY
    this.notify()
  }

  /** Stop accepting writes and abort in-flight requests (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.generationDisposer?.()
    this.generationDisposer = null
    this.abort.abort()
    this.listeners.clear()
  }

  /** One request → one validated entry. Never throws: a fault is an explicit reason. */
  private async fetch(sessionId: string, cwd: string, anchorTime: number): Promise<void> {
    let answer: MstarEngineStatusFetch
    if (this.connection === null || this.connection === undefined || typeof this.connection.rpc?.call !== 'function') {
      answer = { status: 'unavailable', reason: 'no-connection' }
    } else {
      try {
        // The host's shared typert gateway: exactly one plain-object `args`
        // field, keyed by the endpoint descriptor's declared parameter names
        // (`sessionId`, `cwd`).
        const raw = await this.connection.rpc.call(
          ENGINE_STATUS_CHANNEL,
          ENGINE_STATUS_ENDPOINT,
          { args: { sessionId, cwd } },
          this.abort.signal,
        )
        answer = parseEngineStatusResult(raw, sessionId)
      } catch (error) {
        answer = { status: 'unavailable', reason: `transport-error:${(error as Error)?.message ?? 'unknown'}` }
      }
    }
    this.write(sessionId, anchorTime, answer)
  }

  /** Publish one answer (the only writer — always outside a render). */
  private write(sessionId: string, anchorTime: number, fetch: MstarEngineStatusFetch): void {
    if (this.disposed) return
    const entries = new Map(this.snapshot.entries)
    entries.set(sessionId, { anchorTime, fetch })
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
