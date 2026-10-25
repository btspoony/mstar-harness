/**
 * The panel's per-view read hook (plan dsh-panel-unification Task 4a): ONE read
 * per view identity, plus an explicit `reload()`.
 *
 * NO interval, NO visibility gate, NO shared store: the answer belongs to the
 * component that asked, so two screens reading different views cannot overwrite
 * each other, and the read is scheduled exactly once per identity (see
 * `once-reader.ts` for why this is render-safe).
 *
 * @module @mstar-harness/dsh/client/panel/use-mstar-dashboard-view
 */

import { useState } from 'react'
import type { DashboardViewRead } from '../../panel/panel-snapshot-endpoint.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import { OnceReader, cachedReader, useOnceReader } from './once-reader.ts'

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
  const key = sessionId === null || cwd === null || view === null
    ? null
    : `${sessionId}\u0000${cwd}\u0000${view}\u0000${id ?? ''}\u0000${paramsKey}`
  const [reader] = useState(() => cachedReader<DashboardViewRead>(
    client,
    key,
    (read) => new OnceReader<DashboardViewRead>(read),
    (face) => face.readView({
      sessionId: sessionId ?? '',
      cwd: cwd ?? '',
      view: view ?? '',
      ...(paramsKey === '' ? {} : { params: JSON.parse(paramsKey) as Record<string, string | undefined> }),
      ...(id === undefined ? {} : { id }),
    }),
  ))
  return useOnceReader(reader, key, client)
}
