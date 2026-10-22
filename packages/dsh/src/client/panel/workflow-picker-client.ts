/**
 * Client half of the panel's workflow PICKER: the durable `selectWorkflow`
 * write and this session's commit state.
 *
 * WHY its own module: the panel's READ is the polled store-backed snapshot
 * (`mstar/panelSnapshot`, `panel-snapshot-client.ts`). What survives the retired
 * emission read is the picker's WRITE — committing one session's workflow
 * choice — so it keeps exactly that surface here and nothing else: no cached
 * payload, no anchor row, no refresh interval.
 *
 * NEVER OPTIMISTIC: a pick is `pending` until the host acknowledges, then
 * `selected` (with the acknowledged id) or `failed` (with the host's reason).
 * The acknowledged id is a CONTROL state, not a data source: the panel's
 * rendered selection comes from the next snapshot's `retained.selection`, which
 * the host rebuilds from the same durable binding this write commits.
 *
 * ONE SUBMISSION PER SESSION: a second pick while the first is on the wire would
 * race two acknowledgements for one binding, so it answers
 * `unavailable('selection-pending')` instead of stacking.
 *
 * NOTHING HERE THROWS: every transport, parse and timeout fault becomes a
 * reason the panel renders. The store is written only from a response
 * continuation, never during a render.
 *
 * @module @mstar-harness/dsh/client/panel/workflow-picker-client
 */

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { ENGINE_STATUS_CHANNEL, SELECT_WORKFLOW_ENDPOINT } from '../../engine-status-wire.ts'
import { parseSelectWorkflowResult, type MstarSelectWorkflowFetch } from './guards.ts'

/** Deadline for one `/api/mstar/selectWorkflow` request (a hanging gateway must not pin `pending`). */
export const WORKFLOW_PICK_TIMEOUT_MS = 5_000

/**
 * Structural face of the client `connection` service the picker needs — the
 * generic RPC caller of the shared gateway. Declared structurally (not imported
 * as a value) so the bundle stays free of a runtime dependency on the transport
 * package.
 */
export interface MstarWorkflowPickerConnection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
}

/** Optional timings (test seams; production uses the constant above). */
export interface MstarWorkflowPickerClientOptions {
  /** Per-request deadline in ms (`0` disables the bound). */
  readonly timeoutMs?: number
}

/**
 * This session's commit state — control feedback only, never a selection source.
 * `idle` is the shared reference a session with no recorded pick reads.
 */
export type MstarSelectionState =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'selected'; readonly workflowId: string }
  | { readonly state: 'failed'; readonly reason: string }

/** The observable store value: one commit state per session. */
export interface MstarWorkflowPickerSnapshot {
  readonly selections: ReadonlyMap<string, MstarSelectionState>
}

/** The panel's picker client: one write at a time per session, no cached reads. */
export class MstarWorkflowPickerClient {
  private snapshot: MstarWorkflowPickerSnapshot = { selections: new Map() }
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private readonly timeoutMs: number

  constructor(
    private readonly connection: MstarWorkflowPickerConnection | undefined,
    options: MstarWorkflowPickerClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? WORKFLOW_PICK_TIMEOUT_MS
  }

  readonly getSnapshot = (): MstarWorkflowPickerSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Commit this session's workflow pick over the host's shared gateway.
   * @param sessionId - the session the panel is showing.
   * @param cwd - the session's workspace directory (the host cross-checks it).
   * @param workflowId - the chosen ACTIVE workflow id.
   * @returns the host's acknowledgement, or the explicit unavailable state.
   */
  async selectWorkflow(sessionId: string, cwd: string, workflowId: string): Promise<MstarSelectWorkflowFetch> {
    if (this.disposed) return { status: 'unavailable', reason: 'disposed' }
    // One submission per session: a second one while the first is on the wire
    // would race two acknowledgements for the same binding.
    if (this.snapshot.selections.get(sessionId)?.state === 'pending') {
      return { status: 'unavailable', reason: 'selection-pending' }
    }
    this.setSelection(sessionId, { state: 'pending' })
    const answer = await this.call(sessionId, cwd, workflowId)
    if (answer.status === 'selected') this.setSelection(sessionId, { state: 'selected', workflowId: answer.workflowId })
    else this.setSelection(sessionId, { state: 'failed', reason: answer.reason })
    return answer
  }

  /** Stop accepting writes and end in-flight requests (plugin teardown). */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  /** One `selectWorkflow` round trip (never throws — every fault is a reason). */
  private async call(
    sessionId: string,
    cwd: string,
    workflowId: string,
  ): Promise<MstarSelectWorkflowFetch> {
    if (this.connection === undefined || typeof this.connection.rpc?.call !== 'function') {
      return { status: 'unavailable', reason: 'no-connection' }
    }
    const controller = this.timeoutMs > 0 ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const raw = await this.connection.rpc.call(
        ENGINE_STATUS_CHANNEL,
        SELECT_WORKFLOW_ENDPOINT,
        { args: { sessionId, cwd, workflowId } },
        controller?.signal,
      )
      return parseSelectWorkflowResult(raw, sessionId, workflowId)
    } catch (error) {
      const aborted = controller !== null && controller.signal.aborted
      return {
        status: 'unavailable',
        reason: aborted
          ? `timeout: no answer in ${this.timeoutMs}ms`
          : `transport-error:${(error as Error)?.message ?? 'unknown'}`,
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /** Publish one session's commit state (store write outside a render). */
  private setSelection(sessionId: string, state: MstarSelectionState): void {
    const selections = new Map(this.snapshot.selections)
    selections.set(sessionId, state)
    this.snapshot = { selections }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A faulting listener must not break the store.
      }
    }
  }
}
