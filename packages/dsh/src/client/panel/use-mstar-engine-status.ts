/**
 * Data hook for the workflow panel (spec §5): the panel's ONE data path.
 *
 * The persisted catalog row is an ANCHOR, not a data source: rows are emitted
 * as `{ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' }`, and the
 * structured payload lives in the host's per-session snapshot store. So the
 * hook
 *
 * 1. finds the LATEST anchor row in the active session's conversation log
 *    (`kind === 'context'` + `form === 'catalog'` + the first-party `plugin`
 *    arm with one of this plugin's anchor identities) and takes its message
 *    time as the refresh key — a re-emission appends a new row, the snapshot
 *    bump re-runs this selection, and the newest anchor asks for the newest
 *    snapshot;
 * 2. reads the session's workspace directory from the session standard kit's
 *    session feed (the host cross-checks the asserted `cwd` against the
 *    session AND the stored snapshot, so it must be the real one);
 * 3. asks {@link MstarEngineStatusClient} for that session's snapshot over the
 *    host's shared `/api` typert gateway, and renders the validated result.
 *
 * Every degraded path is an EXPLICIT state (spec §5): `waiting` (no anchor row
 * — the plugin never ran on this session), `loading` (anchor seen, no answer
 * for it yet), `unavailable` (a reason: transport failure, an unknown session
 * directory, no connection, a malformed answer, or the host's own reason).
 * None of them renders an empty plans list, an empty event log or a zeroed
 * counter as if it were data. A VALID snapshot that says "empty" still renders
 * as data — the distinction between "no snapshot" and "a snapshot that says
 * empty" survives.
 *
 * Freshness is the served snapshot's own `at`, never "live".
 *
 * The hook never throws: a throwing seat or a missing client degrades to an
 * explicit state instead of bubbling a crash (spec §5 degradation path).
 */

import { useSyncExternalStore } from 'react'
import type { ConversationNode, ContextMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MstarEngineStatusPayload, WorkflowSelectionView } from '../../types.ts'
import type {
  MstarEngineStatusClient,
  MstarEngineStatusSnapshot,
  MstarSelectionState,
} from './engine-status-client.ts'

/** Selector hook over the Host session list (the `useSessions` standard seat). */
export type UseSessions = SnapshotSelectorHook<SessionListState>

/** The panel's render state — a closed set: no shape can be both data and empty. */
export type MstarEngineStatusView =
  /** No anchor row: this session never ran the plugin (today's empty state). */
  | { readonly state: 'waiting'; readonly anchorTime: null; readonly payload: null; readonly at: null; readonly turn: null; readonly reason: null }
  /** Anchor row seen, no answer for it yet — pending, never rendered as data. */
  | { readonly state: 'loading'; readonly anchorTime: number; readonly payload: null; readonly at: null; readonly turn: null; readonly reason: null }
  /**
   * The validated snapshot: the payload plus the snapshot's OWN emission
   * identity (`at` timestamp and the agent turn it was written for). Both are
   * the host's records of the stored entry, so the panel can name which
   * emission it is showing rather than implying it is the newest one.
   *
   * `binding` is the host's CURRENT control-state selection for this session
   * (`null` when it served none), deliberately separate from
   * `payload.state.selection` — which keeps recording the last MODEL EMISSION,
   * so the picker's acknowledgement shows immediately while plans / Event Log
   * stay on the last emitted snapshot.
   */
  | { readonly state: 'ok'; readonly anchorTime: number; readonly payload: MstarEngineStatusPayload; readonly at: string; readonly turn: number; readonly binding: WorkflowSelectionView | null; readonly reason: null }
  /** An explicit degraded answer — always WITH a reason, never silently empty. */
  | { readonly state: 'unavailable'; readonly anchorTime: number; readonly payload: null; readonly at: null; readonly turn: null; readonly reason: string }

/** The seats the hook needs: the session standard kit + the plugin's client. */
export interface MstarEngineStatusSeats {
  /** Selector hook over the chat target snapshot (the session standard kit's chat face). */
  useChat: SnapshotSelectorHook<ChatSnapshot>
  /**
   * Selector hook over the Host session list (the global standard seat). The
   * session-scope slot dispatch always hands it to the panel; it stays
   * optional here because a program without the ui-session adapter does not
   * see the declaration merge (the panel then reports `session-cwd-unknown`).
   */
  useSessions: UseSessions | undefined
  /** Current session identity (the strict-session slot's own prop). */
  sessionId: SessionId | undefined
  /** The plugin's engine-status client (absent in a composition without one). */
  engineStatus: MstarEngineStatusClient | undefined
}

/**
 * The panel hook's result: the render state plus this session's picker seat.
 * `selection` is the served binding (absent until an `ok` render); `pick` is the
 * local commit state for THIS session only; `select` is null exactly when no
 * commit can be made (no client, no session, or unknown cwd).
 */
export interface MstarEngineStatusHook {
  readonly view: MstarEngineStatusView
  /** The served selection of the rendered payload (null unless `view.state === 'ok'`). */
  readonly selection: WorkflowSelectionView | null
  /** This session's picker state, `idle` until a pick is committed. */
  readonly pick: MstarSelectionState
  /** Commit a pick for this session; null when the panel cannot commit one. */
  readonly select: ((workflowId: string) => void) | null
}

/** Stable empty snapshot — the fallback read face when no client is injected. */
const EMPTY_SNAPSHOT: MstarEngineStatusSnapshot = { entries: new Map(), selections: new Map() }
/** Stable no-op subscribe — keeps the hook's call order unconditional. */
const NO_SUBSCRIBE = (): (() => void) => () => {}
/** Stable fallback read — same reference as {@link EMPTY_SNAPSHOT}. */
const readEmptySnapshot = (): MstarEngineStatusSnapshot => EMPTY_SNAPSHOT

/** The anchor identity this plugin emits (the catalog source maker's literal). */
const ANCHOR_PLUGIN = 'mstar-engine'

/**
 * Legacy anchor identity: rows emitted by shipped builds before 2026-09-11
 * persist `mstar-engine-status` in their session logs. Those rows keep
 * anchoring their sessions — data compat for persisted session logs, not a
 * code-compat layer. Any other `plugin` value is NOT an anchor.
 */
const LEGACY_ANCHOR_PLUGIN = 'mstar-engine-status'

/** Latest engine-status anchor row (either accepted identity) in snapshot order, or null. */
export function latestEngineStatusRow(nodes: readonly ConversationNode[]): ContextMessageNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!
    if (node.kind !== 'context' || node.form !== 'catalog') continue
    const source = node.source as { kind?: unknown; plugin?: unknown } | null
    if (
      source?.kind === 'plugin' &&
      (source.plugin === ANCHOR_PLUGIN || source.plugin === LEGACY_ANCHOR_PLUGIN)
    ) {
      return node
    }
  }
  return null
}

/** Anchor row message time, or null when the log carries no anchor row. */
export function selectAnchorTime(snapshot: ChatSnapshot): number | null {
  try {
    const row = latestEngineStatusRow(snapshot?.legacy?.nodes ?? [])
    return row === null ? null : row.time
  } catch {
    return null
  }
}

/** One session's workspace directory from the session list, or null when unknown. */
export function selectSessionCwd(sessionId: SessionId | undefined) {
  return (state: SessionListState): string | null => {
    try {
      if (sessionId === undefined) return null
      const cwd = state?.byId?.[sessionId]?.cwd
      return typeof cwd === 'string' && cwd !== '' ? cwd : null
    } catch {
      return null
    }
  }
}

/** `waiting` — one shared reference (stable across renders). */
const WAITING: MstarEngineStatusView = { state: 'waiting', anchorTime: null, payload: null, at: null, turn: null, reason: null }

/** A session with no recorded pick — one shared reference (stable across renders). */
const IDLE_PICK: MstarSelectionState = { state: 'idle' }

/** `unavailable` — one shape, always with a reason. */
function unavailable(anchorTime: number, reason: string): MstarEngineStatusView {
  return { state: 'unavailable', anchorTime, payload: null, at: null, turn: null, reason }
}

/**
 * The panel's data hook (spec §5).
 *
 * @param seats - the session standard kit + the plugin's engine-status client.
 * @returns the explicit render state (never a throw, never a half-parsed view)
 *   plus this session's picker triple: the served `selection`, the local commit
 *   `pick`, and `select` (null when no pick can be committed).
 */
export function useMstarEngineStatus(seats: MstarEngineStatusSeats): MstarEngineStatusHook {
  const { useChat, useSessions, sessionId, engineStatus } = seats
  const session = sessionId === undefined ? null : String(sessionId)

  // Both seats are selector hooks; a throwing seat degrades to the explicit
  // empty signal (the strict-session slot normally guarantees a session — the
  // guard is belt-and-suspenders). Called unconditionally either way: the
  // hook's call order is fixed whether or not a client is injected.
  let anchorTime: number | null = null
  let cwd: string | null = null
  try {
    anchorTime = useChat(selectAnchorTime)
  } catch {
    anchorTime = null
  }
  try {
    cwd = useSessions === undefined ? null : useSessions(selectSessionCwd(sessionId))
  } catch {
    cwd = null
  }
  const snapshot = useSyncExternalStore(
    engineStatus?.subscribe ?? NO_SUBSCRIBE,
    engineStatus?.getSnapshot ?? readEmptySnapshot,
    engineStatus?.getSnapshot ?? readEmptySnapshot,
  )

  // The picker needs a client, a session and a workspace dir — all three or no
  // picker: the host cross-checks the cwd it is given against the live session.
  const target = engineStatus !== undefined && session !== null && cwd !== null
    ? { client: engineStatus, sessionId: session, cwd }
    : null

  let view: MstarEngineStatusView
  // No anchor row → the plugin never ran on this session (today's empty state).
  if (anchorTime === null) {
    view = WAITING
  } else {
    if (target !== null) {
      // Idempotent: one request per (session, anchor row), deduped in the
      // client. Called during render on purpose — the store is written only
      // from the response continuation, so this starts a request without
      // mutating the snapshot React is reading, and an SSR render issues the
      // same call the browser's next render does.
      try {
        target.client.ensure(target.sessionId, target.cwd, anchorTime)
      } catch {
        // A faulting client must not take the panel down; the render below
        // reports `unavailable` for the answer that never arrives.
      }
    }

    const entry = session === null ? undefined : snapshot.entries.get(session)
    if (entry === undefined) {
      if (engineStatus === undefined) view = unavailable(anchorTime, 'no-connection')
      else if (session === null) view = unavailable(anchorTime, 'session-unknown')
      else if (cwd === null) view = unavailable(anchorTime, 'session-cwd-unknown')
      else view = { state: 'loading', anchorTime, payload: null, at: null, turn: null, reason: null }
    } else if (entry.fetch.status === 'unavailable') {
      view = unavailable(anchorTime, entry.fetch.reason)
    } else {
      // A superseded snapshot keeps rendering with its OWN `at` until the answer
      // for the newest anchor lands: a panel that blinked to a loading card on
      // every catalog re-emission would misreport a healthy refresh as a failure.
      view = { state: 'ok', anchorTime, payload: entry.fetch.payload, at: entry.fetch.at, turn: entry.fetch.turn, binding: entry.fetch.binding, reason: null }
    }
  }

  return {
    view,
    // The host's CURRENT control state wins over the payload's last-emission
    // record: after a pick the panel shows the acknowledged id immediately,
    // while plans / Event Log stay on the last emitted snapshot until the next
    // real emission replaces it.
    selection: view.state === 'ok' ? view.binding ?? view.payload.state?.selection ?? null : null,
    pick: session === null ? IDLE_PICK : snapshot.selections.get(session) ?? IDLE_PICK,
    select: target === null ? null : (workflowId: string): void => {
      // Fire-and-forget on purpose: the acknowledgement, refusal and any fault
      // land in the store as this session's `pick`, and the store notifies a
      // re-render. A synchronous throw from a broken client is contained.
      try {
        void target.client.selectWorkflow(target.sessionId, target.cwd, workflowId)
      } catch {
        // The pick stays `idle`/unchanged and the picker stays clickable.
      }
    },
  }
}
