/**
 * The panel's store-backed snapshot contract (`readPanelSnapshot` produces it).
 *
 * WHY a separate module: the host read service, the browser hook, the
 * projection and the panel pages all speak this ONE shape, so a member rename
 * cannot land on one half of the plugin only.
 *
 * CLIENT-SAFE BY CONSTRUCTION: type-only imports, no `node:` builtins, no side
 * effects — the browser bundle imports this module for its types.
 *
 * @module @mstar-harness/dsh/panel/panel-snapshot
 */

import type {
  EnforcementFlag,
  IssuePage,
  IterationDTO,
  ProjectListDTO,
  RoadmapDTO,
  WorkflowDTO,
} from '@mstar-harness/engine'
import type {
  AgentFlowView,
  MstarHarnessState,
  MstarIterationGateView,
  WorkflowSelectionView,
} from '../types.ts'

/**
 * One workspace read: three states, never a flattened null.
 * - `ok`            the authority answered. `data` may still be `null` when the
 *                   authority itself says "nothing here" (e.g. no roadmap row).
 * - `not-applicable` nothing was read because no target resolved (no project id,
 *                   no selected workflow). Not an error.
 * - `unavailable`   a read was attempted and failed; `reason` is the store's own
 *                   message, verbatim.
 */
export type PanelWorkspaceView<T> =
  | { readonly state: 'ok'; readonly data: T }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unavailable'; readonly reason: string }

export interface PanelSnapshot {
  readonly at: string // read instant, ISO — the panel's freshness
  readonly version: string // plugin package version
  readonly harnessDir: string | null
  readonly enforcement: EnforcementFlag
  readonly workspace: {
    readonly workflow: PanelWorkspaceView<WorkflowDTO | null> // "workflow-detail"
    readonly iteration: PanelWorkspaceView<IterationDTO | null> // "iteration-detail"
    readonly roadmap: PanelWorkspaceView<RoadmapDTO | null> // "roadmap"
    readonly issues: PanelWorkspaceView<IssuePage> // "issues"
    readonly projects: PanelWorkspaceView<ProjectListDTO> // "projects"
  }
  readonly retained: {
    readonly iterationGate: MstarIterationGateView | null // catalog cache
    readonly knowledge: MstarHarnessState['knowledge'] // catalog cache
    readonly selection: WorkflowSelectionView | null // catalog cache
  }
  readonly ledger: AgentFlowView | null // readAgentFlow
}

export type PanelSnapshotRead =
  | { readonly kind: 'ok'; readonly snapshot: PanelSnapshot }
  | { readonly kind: 'unavailable'; readonly reason: string }
