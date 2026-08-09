/**
 * Data hook for the workflow panel (spec §5): subscribes to the active
 * session's conversation snapshot through the session standard kit
 * (`useSession`, a uSES selector hook) and scans the log for the latest
 * `mstar-engine-status` catalog row.
 *
 * Node discriminator (spec §2.4): `kind === 'context'` + `form === 'catalog'`
 * + `source.kind === 'mstar-engine-status'`; the LATEST row wins (snapshot
 * order tail). Refresh = snapshot subscription: a digest/TTL re-emission on
 * the server only produces a new log line, whose snapshot bump re-runs this
 * selection — no manual reload, no polling.
 *
 * Contract: `{ source: MstarEngineStatusSource | null; lastUpdated: number |
 * null }` — `source` null while no catalog row is logged yet (waiting empty
 * state); `lastUpdated` carries the catalog message node `time` (Unix ms) for
 * the freshness marker. The hook never throws: a snapshot the selector cannot
 * read, or an absent session face, degrades to the explicit empty signal
 * instead of bubbling a crash (spec §5 degradation path; the strict-session
 * slot normally guarantees a session — the guard is belt-and-suspenders).
 */

import type { ConversationNode, ConversationSnapshot, ContextMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { MstarEngineStatusSource } from '../../types.ts'

/** The hook result: the latest catalog row plus its message time (spec §5). */
export interface MstarEngineStatusView {
  source: MstarEngineStatusSource | null
  /** Unix ms of the catalog message node; null while no row is present. */
  lastUpdated: number | null
}

/** Stable empty view — a shared reference keeps the selector result referentially stable. */
const EMPTY: MstarEngineStatusView = { source: null, lastUpdated: null }

/** Latest `mstar-engine-status` catalog row in snapshot order, or null (spec §2.4). */
function latestEngineStatusRow(nodes: readonly ConversationNode[]): ContextMessageNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node.kind !== 'context' || node.form !== 'catalog') continue
    const source = node.source as { kind?: unknown } | null
    if (source?.kind === 'mstar-engine-status') return node
  }
  return null
}

/** Selector-result equality: only a NEW row (new source reference + new time) triggers a re-render. */
function sameView(a: MstarEngineStatusView, b: MstarEngineStatusView): boolean {
  return a.source === b.source && a.lastUpdated === b.lastUpdated
}

/**
 * Select the latest engine-status catalog row from a conversation snapshot.
 * Degradation: any snapshot the selection cannot read yields the empty view
 * (never a throw — spec §5).
 */
function selectEngineStatus(snapshot: ConversationSnapshot): MstarEngineStatusView {
  try {
    const row = latestEngineStatusRow(snapshot.nodes)
    if (row === null) return EMPTY
    // `kind` discrimination is the only narrowing the client does; field-level
    // degradation happens at render time (spec §2.4).
    return { source: row.source as MstarEngineStatusSource, lastUpdated: row.time }
  } catch {
    return EMPTY
  }
}

/**
 * `useMstarEngineStatus(useSession): MstarEngineStatusView` — the panel's data
 * hook (spec §5). The session standard kit's `useSession` is passed in (the
 * view ring hands it to every `conversation.view` entry); the hook rides it as
 * a selector over the conversation snapshot, so a snapshot bump (new catalog
 * row) re-runs the selection and refreshes the panel.
 *
 * The hook never throws (spec §5 degradation path; Task 3 contract): a
 * throwing session face or an absent one degrades to the explicit empty
 * signal instead of bubbling a crash — the strict-session slot normally
 * guarantees a session, the guard is belt-and-suspenders.
 */
export function useMstarEngineStatus(useSession: SnapshotSelectorHook<ConversationSnapshot>): MstarEngineStatusView {
  try {
    const view = useSession(selectEngineStatus, sameView)
    // Absent session face → explicit empty signal (spec §3 maps the no-session
    // case to the shell; this guard keeps the panel from crashing regardless).
    return view ?? EMPTY
  } catch {
    // Throwing session face → same explicit empty signal (never a crash).
    return EMPTY
  }
}
