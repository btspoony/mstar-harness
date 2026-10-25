/**
 * The panel's per-view read hook (plan dsh-panel-unification Task 4a): ONE read
 * when the view identity changes, plus an explicit `reload()`.
 *
 * Deliberately unlike `useMstarPanelSnapshot`:
 * - NO interval and no self-chaining timer — the caller decides when to read;
 * - NO visibility gating — a screen that mounts asks once, and 4b removes the
 *   polling loop the digest hook still runs; building a second reactive path
 *   here would have to be deleted again;
 * - NO store: the answer belongs to the component that asked for it, so two
 *   screens reading different views cannot overwrite each other.
 *
 * A read that cannot start (no client, no session, no workspace directory, no
 * view) is `waiting`: nothing was asked, so nothing failed.
 *
 * @module @mstar-harness/dsh/client/panel/use-mstar-dashboard-view
 */

import { useCallback, useEffect, useState } from 'react'
import type { DashboardViewRead } from '../../panel/panel-snapshot-endpoint.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'

/** The hook's state: a read phase plus the read's own answer kinds. */
export type MstarDashboardViewState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'loading' }
  | DashboardViewRead

export interface MstarDashboardViewSeats {
  /** The plugin-bound client (absent in a composition without a transport). */
  readonly client: MstarPanelSnapshotClient | undefined
  /** The wire session identity, or null when none resolved yet. */
  readonly sessionId: string | null
  /** The session's workspace directory (the host cross-checks it). */
  readonly cwd: string | null
  /** The engine view to read; null asks for nothing (an unbound session). */
  readonly view: string | null
  readonly params?: Record<string, string | undefined>
  readonly id?: string
}

/**
 * Read one engine view once per identity, and expose `reload()` for an explicit
 * retry (the product's only retry trigger).
 * @param seats - the transport face and the view identity.
 * @returns the current state and the retry function.
 */
export function useMstarDashboardView(seats: MstarDashboardViewSeats): {
  readonly state: MstarDashboardViewState
  readonly reload: () => void
} {
  const { client, sessionId, cwd, view, id } = seats
  const paramsKey = seats.params === undefined ? '' : JSON.stringify(seats.params)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<MstarDashboardViewState>({ kind: 'waiting' })
  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    if (client === undefined || sessionId === null || cwd === null || view === null) {
      setState({ kind: 'waiting' })
      return
    }
    let live = true
    setState({ kind: 'loading' })
    void client
      .readView({
        sessionId,
        cwd,
        view,
        ...(paramsKey === '' ? {} : { params: JSON.parse(paramsKey) as Record<string, string | undefined> }),
        ...(id === undefined ? {} : { id }),
      })
      .then((read) => {
        if (live) setState(read)
      })
    return () => {
      live = false
    }
    // The identity is the whole key: a new identity is a new read.
  }, [client, sessionId, cwd, view, paramsKey, id, nonce])

  return { state, reload }
}
