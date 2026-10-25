/**
 * Browser half of the panel's data channel: TWO one-shot reads on the host's
 * shared `/api` typert gateway.
 *
 * - `readDigest(...)` — the session digest (`enforcement`, `knowledge`,
 *   `selection`, plus the delivery fallback member). It replaces the retired
 *   5-second poll: the panel reads it when it mounts and after an explicit
 *   action, and nothing here schedules anything.
 * - `readView(...)` — one engine `DashboardView` (plan dsh-panel-unification
 *   Task 4a). A screen reads its own view; the dashboard and this host see the
 *   same DTOs.
 *
 * NO STATE, NO TIMER, NO SUBSCRIPTION: this class is an RPC face, not a store.
 * Keeping the reads app-local means two screens reading different views cannot
 * overwrite each other, and a collapsed or unmounted seat costs nothing.
 *
 * Every failure mode is an explicit kind (`no-harness`, `unavailable` with a
 * reason); nothing here throws, and an unreadable answer is never a half-parsed
 * payload.
 *
 * @module @mstar-harness/dsh/client/panel/panel-snapshot-client
 */

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { ReadEnvelope } from '@mstar-harness/engine'
import type { PanelSnapshotRead } from '../../panel/panel-snapshot.ts'
import type { DashboardViewRead } from '../../panel/panel-snapshot-endpoint.ts'
import { DASHBOARD_VIEW_ENDPOINT, ENGINE_STATUS_CHANNEL, PANEL_SNAPSHOT_ENDPOINT } from '../../engine-status-wire.ts'

export { DASHBOARD_VIEW_ENDPOINT, PANEL_SNAPSHOT_ENDPOINT }

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
}

/** The digest read's target: what the host needs to resolve the `{HARNESS_DIR}`. */
export interface PanelSnapshotTarget {
  readonly sessionId: string
  readonly cwd: string
  readonly workflowId?: string
  readonly iterationId?: string
  readonly projectId?: string
}

/**
 * Per-request deadline. A wedged gateway must not leave a read pending forever:
 * the request is aborted at this bound and the caller gets an explicit
 * `unavailable` reason. This is the ONLY timer in the read path — it bounds one
 * request and schedules no follow-up (no poll, no retry).
 */
export const PANEL_READ_DEADLINE_MS = 5_000

/** Guarded string (missing/illegal → null). */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Is this the digest envelope the seat reads UNGUARDED? Every member the adapter
 * dereferences must be here, or the whole panel throws on a version-skewed or
 * truncated answer.
 */
function isDigestEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const row = value as { enforcement?: unknown; selection?: unknown; iteration?: unknown }
  const enforcement = row.enforcement as { hard?: unknown } | null | undefined
  if (enforcement === null || typeof enforcement !== 'object' || typeof enforcement.hard !== 'boolean') return false
  const selection = row.selection
  if (selection !== null && typeof selection !== 'object') return false
  const iteration = row.iteration as { state?: unknown } | null | undefined
  if (iteration === null || typeof iteration !== 'object') return false
  return iteration.state === 'ok' || iteration.state === 'not-applicable' || iteration.state === 'unavailable'
}

/**
 * Validate one digest answer into the closed {@link PanelSnapshotRead} union.
 * Total: an unreadable answer degrades to `unavailable`, never a half-parsed
 * payload.
 */
export function parsePanelSnapshotRead(value: unknown): PanelSnapshotRead {
  const row = value as { kind?: unknown; snapshot?: unknown; reason?: unknown } | null | undefined
  if (row === null || typeof row !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
  if (row.kind === 'ok') {
    return isDigestEnvelope(row.snapshot)
      ? { kind: 'ok', snapshot: row.snapshot as never }
      : { kind: 'unavailable', reason: 'malformed-answer' }
  }
  // No harness root resolved: its OWN kind, so the client renders the dedicated
  // card rather than leaking a wire reason token into the UI.
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

/** The panel's transport client: two one-shot reads, no scheduling, no state. */
export class MstarPanelSnapshotClient {
  constructor(private readonly connection: MstarPanelSnapshotConnection | undefined) {}

  /**
   * Read the session digest once.
   * @param target - the asserted session/workspace (ids are server-resolved).
   * @returns the digest, `no-harness`, or an explicit reason.
   */
  async readDigest(target: PanelSnapshotTarget): Promise<PanelSnapshotRead> {
    if (this.connection === undefined) return { kind: 'unavailable', reason: 'no-connection' }
    const args: Record<string, string> = { sessionId: target.sessionId, cwd: target.cwd }
    if (target.workflowId !== undefined) args.workflowId = target.workflowId
    if (target.iterationId !== undefined) args.iterationId = target.iterationId
    if (target.projectId !== undefined) args.projectId = target.projectId
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), PANEL_READ_DEADLINE_MS)
    try {
      const result = await this.connection.rpc.call(ENGINE_STATUS_CHANNEL, PANEL_SNAPSHOT_ENDPOINT, { args }, controller.signal)
      if (result === null || typeof result !== 'object') return { kind: 'unavailable', reason: 'malformed-answer' }
      if (result.ok !== true) {
        const error = result.error as { code?: unknown; message?: unknown } | null | undefined
        return { kind: 'unavailable', reason: str(error?.message) ?? str(error?.code) ?? 'transport-error' }
      }
      return parsePanelSnapshotRead(result.value)
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: controller.signal.aborted ? `timeout: no answer in ${PANEL_READ_DEADLINE_MS}ms` : `transport-error: ${String(error)}`,
      }
    } finally {
      clearTimeout(deadline)
    }
  }

  /**
   * Read ONE engine dashboard view — the per-view path.
   *
   * ONE request per call and NOTHING else: no state write, no subscription, no
   * visibility gate, and NO TIMER of any kind. Every failure mode is an explicit
   * kind, never a throw.
   * @param input - the session/workspace assertion plus the view identity.
   * @returns the engine envelope, `no-harness`, or an explicit reason.
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
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), PANEL_READ_DEADLINE_MS)
    try {
      const result = await this.connection.rpc.call(ENGINE_STATUS_CHANNEL, DASHBOARD_VIEW_ENDPOINT, { args }, controller.signal)
      return parseDashboardViewRead(result)
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: controller.signal.aborted ? `timeout: no answer in ${PANEL_READ_DEADLINE_MS}ms` : `transport-error: ${String(error)}`,
      }
    } finally {
      clearTimeout(deadline)
    }
  }
}
