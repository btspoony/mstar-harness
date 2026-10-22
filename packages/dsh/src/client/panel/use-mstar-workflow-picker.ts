/**
 * The picker's data hook: this session's commit state plus a commit function.
 *
 * Deliberately NOT a data path — the panel's read is `useMstarPanelSnapshot`
 * (the polled store-backed snapshot). What the picker contributes is the control
 * feedback for the workflow selection: `pick` (pending / selected / failed, this
 * session only) and `select` (null exactly when no commit can be made: no
 * client, no session, or no known workspace directory).
 *
 * The shown SELECTION is not this hook's business: it rides `PanelSnapshot`
 * (`retained.selection`), which the host rebuilds from the same durable binding
 * the commit writes. The two are bridged in the digest by the acknowledgement
 * state, so a commit is visible before the next snapshot arrives.
 *
 * The hook never throws: a throwing seat degrades to "no picker".
 *
 * @module @mstar-harness/dsh/client/panel/use-mstar-workflow-picker
 */

import { useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MstarSelectionState, MstarWorkflowPickerClient } from './workflow-picker-client.ts'

/** Selector hook over the Host session list (the `useSessions` standard seat). */
export type UseSessions = SnapshotSelectorHook<SessionListState>

/** The seats the picker needs: the session list + the plugin's picker client. */
export interface MstarWorkflowPickerSeats {
  /**
   * Selector hook over the Host session list (the global standard seat). Stays
   * optional here because a program without the ui-session adapter does not see
   * the declaration merge (the panel then offers no picker).
   */
  useSessions: UseSessions | undefined
  /** Current session identity (the strict-session slot's own prop). */
  sessionId: SessionId | undefined
  /** The plugin's picker client (absent in a composition without one). */
  picker: MstarWorkflowPickerClient | undefined
}

/** The picker's result: the local commit state and the commit function. */
export interface MstarWorkflowPickerHook {
  /** This session's commit state, `idle` until a pick is committed. */
  readonly pick: MstarSelectionState
  /** Commit a pick for this session; null when the panel cannot commit one. */
  readonly select: ((workflowId: string) => void) | null
}

/** A session with no recorded pick — one shared reference (stable across renders). */
const IDLE_PICK: MstarSelectionState = { state: 'idle' }
/** Stable empty snapshot — the fallback read face when no client is injected. */
const EMPTY_SNAPSHOT = { selections: new Map() }
/** Stable no-op subscribe — keeps the hook's call order unconditional. */
const NO_SUBSCRIBE = (): (() => void) => () => {}
/** Stable fallback read — same reference as {@link EMPTY_SNAPSHOT}. */
const readEmptySnapshot = () => EMPTY_SNAPSHOT

/** One session's workspace directory from the session list, or null when unknown. */
function sessionCwd(useSessions: UseSessions | undefined, sessionId: SessionId | undefined): string | null {
  try {
    if (useSessions === undefined || sessionId === undefined) return null
    return useSessions((state: SessionListState) => {
      try {
        const cwd = state?.byId?.[sessionId]?.cwd
        return typeof cwd === 'string' && cwd !== '' ? cwd : null
      } catch {
        return null
      }
    })
  } catch {
    return null
  }
}

/**
 * The picker hook.
 * @param seats - the session list seat, the session identity and the client.
 * @returns this session's commit state plus `select` (null when no pick can be
 *   committed).
 */
export function useMstarWorkflowPicker(seats: MstarWorkflowPickerSeats): MstarWorkflowPickerHook {
  const { useSessions, sessionId, picker } = seats
  const session = sessionId === undefined ? null : String(sessionId)
  const cwd = sessionCwd(useSessions, sessionId)
  const snapshot = useSyncExternalStore(
    picker?.subscribe ?? NO_SUBSCRIBE,
    picker?.getSnapshot ?? readEmptySnapshot,
    picker?.getSnapshot ?? readEmptySnapshot,
  )

  // A commit needs a client, a session and a workspace dir — all three or no
  // picker: the host cross-checks the cwd it is given against the live session.
  const target = picker !== undefined && session !== null && cwd !== null
    ? { client: picker, sessionId: session, cwd }
    : null

  return {
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
