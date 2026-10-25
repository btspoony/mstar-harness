/**
 * The panel's snapshot contract (`readPanelSnapshot` produces it).
 *
 * SHRUNK BY DECISION (plan dsh-panel-unification Task 4; compass D23): the
 * transport carries only the facts no dashboard DTO owns. Everything an engine
 * `DashboardView` answers — workflows, iterations, issues, projects, the
 * roadmap — is read per view through `mstar/dashboardView` by the screen that
 * needs it, so this payload cannot go stale behind a poll or duplicate a DTO.
 *
 * - `enforcement` — harness state. The dashboard has none to read.
 * - `knowledge` — a catalog rollup that is CARRIED and never rendered (IA §8,
 *   D30 rule 3). A screen that draws it is the defect.
 * - `selection` — this session's workflow binding, the picker's read face.
 * - `iteration` — the ONE envelope read the per-view path does not replace:
 *   the delivery line's no-answer fallback. The per-view `iterations` read has
 *   no arm for "could not answer yet", and `Focus` must never print
 *   "No iteration" for a read that has not happened, so this member stays while
 *   it has that consumer.
 */

import type { EnforcementFlag, IterationDTO } from '@mstar-harness/engine'
import type { MstarHarnessState, WorkflowSelectionView } from '../types.ts'

/**
 * One workspace read: three states, never a flattened null.
 * - `ok`            the authority answered. `data` may still be `null` when the
 *                   authority itself says "nothing here".
 * - `not-applicable` nothing was read because no target resolved. Not an error.
 * - `unavailable`   a read was attempted and failed; `reason` is the store's own
 *                   message, verbatim.
 */
export type PanelWorkspaceView<T> =
  | { readonly state: 'ok'; readonly data: T }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unavailable'; readonly reason: string }

/** The session-scoped facts the dashboard has no DTO for. */
export interface SessionDigest {
  /** The harness flag, or null when the read failed (never a guessed `soft`). */
  readonly enforcement: EnforcementFlag | null
  /** Carried, never rendered (D30 rule 3). */
  readonly knowledge: MstarHarnessState['knowledge'] | null
  /** This session's workflow binding, or null when nothing is bound. */
  readonly selection: WorkflowSelectionView | null
}

/** The whole payload: the digest plus the delivery line's fallback member. */
export interface PanelSnapshot extends SessionDigest {
  /**
   * The iteration the workspace addresses, as the store read it — the delivery
   * line's fallback while the per-view read has no answer.
   */
  readonly iteration: PanelWorkspaceView<IterationDTO | null>
}

/**
 * The whole-read answer.
 * - `ok`          the digest composed (the iteration member still degrades on its own).
 * - `no-harness`  no `{HARNESS_DIR}` resolves for this workspace: there is
 *                 nothing to read and nothing failed. Distinct from
 *                 `unavailable` on purpose.
 * - `unavailable` the read was attempted and failed; `reason` is explicit.
 */
export type PanelSnapshotRead =
  | { readonly kind: 'ok'; readonly snapshot: PanelSnapshot }
  | { readonly kind: 'no-harness' }
  | { readonly kind: 'unavailable'; readonly reason: string }
