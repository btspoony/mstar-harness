/**
 * Browser half of the panel-snapshot channel: one `/api/mstar/panelSnapshot`
 * request, cached as an explicit {@link MstarPanelView} and observable by
 * React.
 *
 * WHY a store outside React: the snapshot is read from the control-root
 * `store.db` on the HOST and arrives over the host's shared typert `/api`
 * gateway, asynchronously and repeatedly. Keeping that state here gives one
 * request at a time across re-renders, survives the panel unmounting, and lets
 * the render path read a total, synchronous view.
 *
 * THE POLL CONTRACT (this is the panel's ONE refresh mechanism):
 * - a request is issued only while the panel is VISIBLE (`start()` /
 *   `stop()` are the visibility gate the hook drives);
 * - at most ONE request is in flight — a tick during a slow answer never stacks
 *   a queue of reads, but it is NOT dropped either: the demand is remembered
 *   and served the moment the request settles (a collapse→expand or a session
 *   switch must not dead-end on a slow gateway);
 * - every answer REPLACES the view, and a failed fetch degrades to
 *   `unavailable` with a reason while the last good snapshot stays available
 *   as `loading`'s `previous` (the render keeps painting it — no flicker);
 * - `invalidate()` (a new connection generation) drops the cached freshness
 *   and refetches immediately, outside the interval;
 * - nothing here throws: every transport, parse and timeout fault becomes an
 *   `unavailable` reason.
 *
 * The store is written from the request continuation and from `start()`'s
 * scheduled microtask — never synchronously during a render.
 *
 * @module @mstar-harness/dsh/client/panel/panel-snapshot-client
 */

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { PanelSnapshot, PanelSnapshotRead } from '../../panel/panel-snapshot.ts'
import type { ReadEnvelope } from '@mstar-harness/engine'
import type { DashboardViewRead } from '../../panel/panel-snapshot-endpoint.ts'
import { DASHBOARD_VIEW_ENDPOINT, ENGINE_STATUS_CHANNEL, PANEL_SNAPSHOT_ENDPOINT } from '../../engine-status-wire.ts'

/**
 * The endpoint path the client calls — the `mstar` namespace (shared with the
 * engine-status channel) plus the method the host descriptor registers.
 */
export { DASHBOARD_VIEW_ENDPOINT, PANEL_SNAPSHOT_ENDPOINT }

/**
 * The panel's view: a closed set — no shape can be both data and empty.
 * `loading` carries the last good snapshot so a refresh never blanks the panel.
 *
 * `no-harness` is ITS OWN state, not a failure: the workspace declares no
 * resolvable `{HARNESS_DIR}`, so there is nothing to read. It renders the
 * dedicated "no harness" card instead of a wire reason token.
 */
export type MstarPanelView =
  | { readonly state: 'waiting'; readonly reason: null; readonly snapshot: null }
  | { readonly state: 'loading'; readonly previous: PanelSnapshot | null; readonly snapshot: null }
  | { readonly state: 'ok'; readonly snapshot: PanelSnapshot }
  | { readonly state: 'no-harness'; readonly snapshot: null }
  | { readonly state: 'unavailable'; readonly reason: string; readonly snapshot: null }

/** Stable `waiting` reference (referentially stable across renders). */
const WAITING: MstarPanelView = { state: 'waiting', reason: null, snapshot: null }

/** Deadline for one `/api/mstar/panelSnapshot` request (a hanging gateway must not pin `loading`). */
export const PANEL_SNAPSHOT_REQUEST_TIMEOUT_MS = 5_000

/**
 * The poll interval.
 *
 * TRADE-OFF: 5 s is the shortest interval that keeps a `store.db` read of five
 * dashboard views cheap enough to ride a visible sidebar (the host serializes
 * reads and refreshes projections), while still looking "current" to an
 * operator; shortening it multiplies store reads per open panel, lengthening it
 * makes a finished plan look stuck. One named constant is the ONLY place this
 * decision lives.
 */
export const PANEL_POLL_INTERVAL_MS = 5_000

/**
 * Structural face of the client `connection` service the panel needs — the
 * generic RPC caller of the shared gateway. Declared structurally (not
 * imported as a value) so the bundle stays free of a runtime dependency on the
 * transport package.
 */
export interface MstarPanelSnapshotConnection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
  /** Connection generations: a new generation makes the cached read suspect. */
  readonly generation?: { subscribe(listener: () => void): () => void }
}

/** Optional timings (test seams; production uses the two constants above). */
export interface MstarPanelSnapshotClientOptions {
  /** Per-request deadline in ms (`0` disables the bound). */
  readonly timeoutMs?: number
  /** Poll interval in ms (`0` disables the interval and leaves only explicit refresh). */
  readonly pollIntervalMs?: number
}

/** The workspace read target: what the host needs to resolve the `{HARNESS_DIR}`. */
export interface PanelSnapshotTarget {
  readonly sessionId: string
  readonly cwd: string
  readonly workflowId?: string
  readonly iterationId?: string
  readonly projectId?: string
}

/** Guarded string (missing/illegal → null). */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The five workspace reads an `ok` answer must carry. */
const WORKSPACE_KEYS = ['workflow', 'iteration', 'roadmap', 'issues', 'projects'] as const

/** A workspace read is one of the three declared states. */
function isWorkspaceView(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const state = (value as { state?: unknown }).state
  return state === 'ok' || state === 'not-applicable' || state === 'unavailable'
}

/**
 * Is this the complete envelope the panel reads UNGUARDED? Every member the
 * seat's adapter dereferences must be here, or the whole panel throws on a
 * version-skewed or truncated answer. A `null` ledger is legal (advisory read
 * failed); a present one must carry the events array — Task 4 retires the
 * ledger member with the read path that produces it.
 */
function isSnapshotEnvelope(value: unknown): value is PanelSnapshot {
  if (value === null || typeof value !== 'object') return false
  const row = value as { at?: unknown; workspace?: unknown; retained?: unknown; ledger?: unknown }
  if (str(row.at) === null) return false
  if (row.retained === null || typeof row.retained !== 'object') return false
  const workspace = row.workspace
  if (workspace === null || typeof workspace !== 'object') return false
  if (!WORKSPACE_KEYS.every((key) => isWorkspaceView((workspace as Record<string, unknown>)[key]))) return false
  const ledger = row.ledger as { events?: unknown } | null | undefined
  if (ledger === null) return true
  return typeof ledger === 'object' && Array.isArray(ledger.events)
}

/**
 * Validate one endpoint answer into the closed `PanelSnapshotRead` union.
 * Total: an unreadable answer degrades to `unavailable`, never a half-parsed
 * snapshot.
 *
 * This is the ONLY place unknown bytes become the contract, so it also enforces
 * the envelope the rest of the client reads without guards — `at`, the five
 * workspace members, `retained` and `ledger`'s `events`. A member-less `ok`
 * answer is `unavailable`, not a thrown render.
 */
export function parsePanelSnapshotRead(value: unknown): PanelSnapshotRead {
  const row = value as { kind?: unknown; snapshot?: unknown; reason?: unknown } | null | undefined
  if (row === null || typeof row !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
  if (row.kind === 'ok') {
    return isSnapshotEnvelope(row.snapshot)
      ? { kind: 'ok', snapshot: row.snapshot }
      : { kind: 'unavailable', reason: 'malformed-answer' }
  }
  // No harness root resolved: its OWN kind, so the client renders the
  // dedicated card rather than leaking a wire reason token into the UI.
  if (row.kind === 'no-harness') return { kind: 'no-harness' }
  if (row.kind === 'unavailable') return { kind: 'unavailable', reason: str(row.reason) ?? 'malformed-answer' }
  return { kind: 'unavailable', reason: 'malformed-answer' }
}

/**
 * Validate one per-view answer into the closed {@link DashboardViewRead} union.
 * The envelope is passed through as the engine produced it; only the two
 * non-answers are decoded here.
 */
export function parseDashboardViewRead(value: unknown): DashboardViewRead {
  const row = value as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } | null | undefined
  if (row === null || typeof row !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
  if (row.ok !== true) {
    return { kind: 'unavailable', reason: str(row.error?.message) ?? str(row.error?.code) ?? 'transport-error' }
  }
  const payload = row.value as { kind?: unknown; envelope?: unknown; reason?: unknown } | null | undefined
  if (payload === null || typeof payload !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
  if (payload.kind === 'ok') {
    const envelope = payload.envelope as { data?: unknown } | null | undefined
    return envelope !== null && typeof envelope === 'object' && 'data' in envelope
      ? { kind: 'ok', envelope: envelope as ReadEnvelope<unknown> }
      : { kind: 'unavailable', reason: 'malformed-answer' }
  }
  if (payload.kind === 'no-harness') return { kind: 'no-harness' }
  if (payload.kind === 'unavailable') return { kind: 'unavailable', reason: str(payload.reason) ?? 'malformed-answer' }
  return { kind: 'unavailable', reason: 'malformed-answer' }
}

/** The observable store value. */
export interface MstarPanelSnapshotState {
  readonly view: MstarPanelView
}

/**
 * The panel's snapshot client: at most one request in flight, one self-chained
 * poll timer, and an explicit view for every outcome.
 */
export class MstarPanelSnapshotClient {
  private view: MstarPanelView = WAITING
  private readonly listeners = new Set<() => void>()
  private target: PanelSnapshotTarget | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  /** A refresh was demanded while a request was in flight — served on settle. */
  private pending = false
  private disposed = false
  /** The last `ok` snapshot — the `previous` a refresh keeps painting. */
  private lastOk: PanelSnapshot | null = null
  private readonly stopGeneration: (() => void) | null
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number

  constructor(
    private readonly connection: MstarPanelSnapshotConnection | undefined,
    options: MstarPanelSnapshotClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? PANEL_SNAPSHOT_REQUEST_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? PANEL_POLL_INTERVAL_MS
    // A new connection generation invalidates every wire-derived byte: refetch
    // immediately rather than waiting out the interval.
    this.stopGeneration = connection?.generation?.subscribe(() => this.invalidate()) ?? null
  }

  readonly getSnapshot = (): MstarPanelView => this.view

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Begin polling `target` — idempotent, and a NO-OP for an unchanged target
   * (a re-render must not restart the interval). Called from the render path,
   * so it schedules its store write as a microtask instead of writing here.
   *
   * A target CHANGE drops the stored view before the read starts: the old
   * snapshot is another session's workspace (or another session's selection)
   * and must not stay renderable while the new read is out.
   */
  start(target: PanelSnapshotTarget): void {
    if (this.disposed || this.sameTarget(target)) return
    this.target = target
    this.lastOk = null
    this.clearTimer()
    void Promise.resolve().then(() => {
      if (this.disposed || this.target !== target) return
      this.write({ state: 'loading', previous: null, snapshot: null })
      void this.refresh()
    })
  }

  /** Is `target` the one already being polled? */
  private sameTarget(target: PanelSnapshotTarget): boolean {
    return this.target !== null
      && this.target.sessionId === target.sessionId
      && this.target.cwd === target.cwd
      && this.target.workflowId === target.workflowId
      && this.target.iterationId === target.iterationId
      && this.target.projectId === target.projectId
  }

  /** Stop polling (the panel left the viewport). In-flight answers still land. */
  stop(): void {
    this.target = null
    this.pending = false
    this.clearTimer()
  }

  /**
   * Refetch NOW (outside the interval) — the ledger-invalidation hook. The last
   * good snapshot is KEPT: the refresh renders it as `loading.previous`, so an
   * invalidation never blanks the panel.
   */
  invalidate(): void {
    if (this.disposed || this.target === null) return
    this.clearTimer()
    void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.stopGeneration?.()
    this.listeners.clear()
  }

  /** One poll tick / explicit refresh. Never stacks, never throws. */
  async refresh(): Promise<void> {
    if (this.disposed || this.target === null) return
    if (this.inFlight) {
      // The request already out may be the last one the transport gives us
      // (a slow store, a hung gateway): REMEMBER the demand and serve it on
      // settle instead of dropping it. Dropping it is what froze the panel
      // after a collapse→expand, because the settle path then found a
      // different target and rescheduled nothing.
      this.pending = true
      return
    }
    this.inFlight = true
    const target = this.target
    this.write(this.lastOk === null
      ? { state: 'loading', previous: null, snapshot: null }
      : { state: 'loading', previous: this.lastOk, snapshot: null })
    try {
      const read = await this.request(target)
      if (this.disposed || this.target !== target) return
      if (read.kind === 'ok') {
        this.lastOk = read.snapshot
        this.write({ state: 'ok', snapshot: read.snapshot })
      } else if (read.kind === 'no-harness') {
        this.write({ state: 'no-harness', snapshot: null })
      } else {
        this.write({ state: 'unavailable', reason: read.reason, snapshot: null })
      }
    } catch (error) {
      // Belt-and-suspenders: `request` already maps faults to a reason.
      if (this.disposed || this.target !== target) return
      this.write({ state: 'unavailable', reason: `transport-error: ${String(error)}`, snapshot: null })
    } finally {
      this.inFlight = false
      if (this.disposed) return
      if (this.pending) {
        // A demand that arrived mid-flight (a target change, a collapse→expand,
        // an invalidation) is answered NOW — for whatever target is current.
        this.pending = false
        void this.refresh()
        return
      }
      // Only the CURRENT target may keep the interval alive; a stale target's
      // answer already returned above.
      if (this.target === target) this.schedule()
    }
  }

  /**
   * Read ONE engine dashboard view — the per-view path (Task 4a).
   *
   * ONE request per call and NOTHING else: no state write, no subscription, no
   * visibility gate, and NO TIMER of any kind (not even a deadline) — the caller
   * owns the cadence, and 4b deletes the polling loop this client still runs for
   * the digest. Every failure mode is still an explicit kind, never a throw.
   */
  async readView(input: {
    sessionId: string
    cwd: string
    view: string
    params?: Record<string, string | undefined>
    id?: string
  }): Promise<DashboardViewRead> {
    if (this.connection === undefined) return { kind: 'unavailable', reason: 'no-connection' }
    const args: Record<string, unknown> = { sessionId: input.sessionId, cwd: input.cwd, view: input.view }
    if (input.params !== undefined) args.params = input.params
    if (input.id !== undefined) args.id = input.id
    try {
      const result = await this.connection.rpc.call(ENGINE_STATUS_CHANNEL, DASHBOARD_VIEW_ENDPOINT, { args })
      return parseDashboardViewRead(result)
    } catch (error) {
      return { kind: 'unavailable', reason: `transport-error: ${String(error)}` }
    }
  }

  /** One bounded request; every failure mode becomes a reason. */
  private async request(target: PanelSnapshotTarget): Promise<PanelSnapshotRead> {
    if (this.connection === undefined) return { kind: 'unavailable', reason: 'no-connection' }
    const controller = this.timeoutMs > 0 ? new AbortController() : null
    const timer = controller === null
      ? null
      : setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const args: Record<string, string> = { sessionId: target.sessionId, cwd: target.cwd }
      if (target.workflowId !== undefined) args.workflowId = target.workflowId
      if (target.iterationId !== undefined) args.iterationId = target.iterationId
      if (target.projectId !== undefined) args.projectId = target.projectId
      const result = await this.connection.rpc.call(
        ENGINE_STATUS_CHANNEL,
        PANEL_SNAPSHOT_ENDPOINT,
        { args },
        controller?.signal,
      )
      if (result === null || typeof result !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
      if (result.ok !== true) {
        const error = result.error as { code?: unknown; message?: unknown } | null | undefined
        return { kind: 'unavailable', reason: str(error?.message) ?? str(error?.code) ?? 'transport-error' }
      }
      return parsePanelSnapshotRead(result.value)
    } catch (error) {
      const aborted = controller !== null && controller.signal.aborted
      return { kind: 'unavailable', reason: aborted ? `timeout: no answer in ${this.timeoutMs}ms` : `transport-error: ${String(error)}` }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  private schedule(): void {
    this.clearTimer()
    if (this.pollIntervalMs <= 0) return
    this.timer = setTimeout(() => { void this.refresh() }, this.pollIntervalMs)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private write(next: MstarPanelView): void {
    this.view = next
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A faulting listener must not break the store.
      }
    }
  }
}
