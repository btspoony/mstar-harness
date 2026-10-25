/**
 * The panel's session-digest hook: ONE read when the seat mounts (and on an
 * explicit `reload()`), replacing the retired 5-second poll.
 *
 * NO TIMER and NO VISIBILITY GATE: an unmounted seat is not rendered, so there
 * is nothing to gate; a mounted one asks once per session identity. The subject
 * changes only on a workflow pick, and that path calls `reload()`.
 *
 * A read that cannot start (no client, no session, no workspace directory) is
 * `waiting`: nothing was asked, so nothing failed.
 *
 * @module @mstar-harness/dsh/client/panel/use-mstar-session-digest
 */

import { useState } from 'react'
import type { PanelSnapshotRead } from '../../panel/panel-snapshot.ts'
import type { MstarPanelSnapshotClient } from './panel-snapshot-client.ts'
import { OnceReader, cachedReader, useOnceReader } from './once-reader.ts'

/** The digest's state: a read phase plus the read's own answer kinds. */
export type MstarSessionDigestState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'loading' }
  | PanelSnapshotRead

export interface MstarSessionDigestSeats {
  /** The plugin-bound client (absent in a composition without a transport). */
  readonly client: MstarPanelSnapshotClient | undefined
  /** The wire session identity, or null when none resolved yet. */
  readonly sessionId: string | null
  /** The session's workspace directory (the host cross-checks it). */
  readonly cwd: string | null
}

/**
 * Read the digest once per identity, and expose `reload()` for an explicit
 * re-read (a workflow pick, a retry).
 * @param seats - the transport face and the session identity.
 * @returns the current state and the re-read function.
 */
export function useMstarSessionDigest(seats: MstarSessionDigestSeats): {
  readonly state: MstarSessionDigestState
  readonly reload: () => void
} {
  const { client, sessionId, cwd } = seats
  const key = sessionId === null || cwd === null ? null : `${sessionId}\u0000${cwd}`
  const [reader] = useState(() => cachedReader<PanelSnapshotRead>(
    client,
    key,
    (read) => new OnceReader<PanelSnapshotRead>(read),
    (face) => face.readDigest({ sessionId: sessionId ?? '', cwd: cwd ?? '' }),
  ))
  const { state, reload } = useOnceReader(reader, key, client)
  return { state, reload }
}
