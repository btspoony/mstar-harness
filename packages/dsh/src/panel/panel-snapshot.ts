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

/**
 * Whether the leaf-seat shell marker can reach a CLI process launched from this
 * session (the `DSH_MSTAR_LEAF_SEAT` contributor, #548).
 *
 * SCOPE — read this before widening the prose: `active: false` says exactly ONE
 * thing, the host's `shellEnv` service is absent, so the marker is never
 * injected and the CLI transport degrades to its ungated behaviour. It says
 * NOTHING about the channel's other, separately declared limit: a leaf that
 * strips the variable from its own environment (`env -u`, `sudo`'s
 * `env_reset`) is still indistinguishable, and this field cannot detect it. The
 * missing-service state is disclosed; the strip stays a limit, not a fix.
 */
export interface LeafSignalState {
  /** The `shellEnv` service is present, so a leaf's shell calls carry the marker. */
  readonly active: boolean
  /** The absent service — the one condition disclosed here (absent only when `active`). */
  readonly reason?: string
  /** The operator's route to restore the marker (absent only when `active`). */
  readonly recovery?: string
}

/**
 * The one reason line: the host service is missing, never the marker-strip
 * limit. Worded so a reader cannot take it as "leaving the marker behind is now
 * detected": carrying the variable is a precondition of attesting it.
 */
export const LEAF_SIGNAL_ABSENT_REASON =
  'the host "shellEnv" service is absent, so DSH_MSTAR_LEAF_SEAT is never injected and a CLI launched from this session ' +
  'carries no leaf marker; this reports the missing service only — a leaf that strips the variable from its own ' +
  'environment remains an undetectable limit of the environment channel'

/** The recovery: put the host service back in the composition. */
export const LEAF_SIGNAL_RECOVERY =
  'add "@deepseek-ai/dsh-shell-env" to this host composition (the dsh bundle already carries it; a custom composition is ' +
  'the usual cause) and reload the plugin'

/**
 * Compose the disclosure field from the one probe: is the `shellEnv` service
 * present? Pure so the endpoint owns the probe and the payload stays a value.
 * @param shellEnvPresent - `ctx.get('shellEnv') !== undefined` at read time.
 * @returns the active state, or the absent state with its reason and recovery.
 */
export function leafSignalStateOf(shellEnvPresent: boolean): LeafSignalState {
  return shellEnvPresent
    ? { active: true }
    : { active: false, reason: LEAF_SIGNAL_ABSENT_REASON, recovery: LEAF_SIGNAL_RECOVERY }
}

/** The whole payload: the digest plus the delivery line's fallback member. */
export interface PanelSnapshot extends SessionDigest {
  /**
   * The iteration the workspace addresses, as the store read it — the delivery
   * line's fallback while the per-view read has no answer.
   */
  readonly iteration: PanelWorkspaceView<IterationDTO | null>
  /**
   * The leaf-signal disclosure (#619): whether this host can inject the marker
   * at all. Probed per read, never cached, so a host service that loads later
   * flips it without a restart.
   */
  readonly leafSignal: LeafSignalState
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
