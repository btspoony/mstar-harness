/**
 * The panel's ONE data hook: a visibility-gated poll of
 * `/api/mstar/panelSnapshot`, rendered as the closed {@link MstarPanelView}
 * union.
 *
 * Every degraded path is an EXPLICIT state: `waiting` (no transport/session/
 * workspace directory resolved yet — nothing was asked), `loading` (a read is
 * out, carrying the last good snapshot as `previous` so the render keeps
 * painting it), `ok` (the store answered — an answer that says "empty" is
 * still data), `unavailable` (a reason: transport failure, timeout, a malformed
 * answer, or the store's own refusal). None of them renders an empty plan list
 * or a zeroed counter as if it were data.
 *
 * Freshness is the snapshot's own `at`, never "live".
 *
 * The hook never throws: a throwing seat or a missing client degrades to
 * `waiting`/`unavailable` instead of bubbling a crash.
 *
 * @module @mstar-harness/dsh/client/panel/use-mstar-panel-snapshot
 */

import { useSyncExternalStore } from 'react'
import type { PanelSnapshot } from '../../panel/panel-snapshot.ts'
import type { MstarPanelSnapshotClient, MstarPanelView } from './panel-snapshot-client.ts'

export type { MstarPanelView } from './panel-snapshot-client.ts'
export type { PanelSnapshot }

/** The seats the poll needs: the visibility gate, the client and the read target. */
export interface MstarPanelSnapshotSeats {
  /** `useTabInfo().tab.visible` — a collapsed sidebar column polls nothing. */
  readonly visible: boolean
  /** The plugin-bound client (absent in a composition without a transport). */
  readonly client: MstarPanelSnapshotClient | undefined
  /** Session identity as a plain string (the wire argument). */
  readonly sessionId: string | null
  /** The session's workspace directory (the host cross-checks it). */
  readonly cwd: string | null
}

/** Stable empty view for a missing client. */
const WAITING = { state: 'waiting', reason: null, snapshot: null } as const

/** Stable fallback read — the same reference every call (snapshot stability). */
const readWaiting = () => WAITING

/** Stable no-op subscribe — keeps the hook's call order unconditional. */
const NO_SUBSCRIBE = (): (() => void) => () => {}

/**
 * Start/stop the poll from the render path.
 *
 * The client dedupes an unchanged target and schedules its own store write, so
 * calling `start()` during a render starts a request without mutating the
 * snapshot React is reading (the same discipline as the retired anchor-row
 * fetch). A throwing client is contained: the render below reports what it has.
 */
function gate(
  seats: MstarPanelSnapshotSeats,
): MstarPanelSnapshotClient | undefined {
  const { visible, client, sessionId, cwd } = seats
  if (client === undefined) return undefined
  try {
    if (visible && sessionId !== null && cwd !== null) client.start({ sessionId, cwd })
    else client.stop()
  } catch {
    // A faulting client must not take the panel down.
  }
  return client
}

export function useMstarPanelSnapshot(seats: MstarPanelSnapshotSeats): MstarPanelView {
  const client = gate(seats)
  return useSyncExternalStore(
    client?.subscribe ?? NO_SUBSCRIBE,
    client?.getSnapshot ?? readWaiting,
    client?.getSnapshot ?? readWaiting,
  )
}
