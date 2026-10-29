/**
 * The ONE declaration of the panel's wire addresses, shared by both halves of
 * every channel: the host half composes the `/api` typert endpoint descriptors
 * from these literals, and the browser half calls the same addresses through
 * `connection.rpc.call(...)`.
 *
 * WHY a separate module: the two halves live in two bundle graphs (the host
 * runs from `dist/index.js`, the panel from the closure-factory
 * `dist/client.js`), and a rename on either side used to leave both suites
 * green while the panel silently degraded to `transport-error` — each half's
 * spec pinned only its own copy of the literals. Importing one module makes the
 * rename impossible to land half-done, and `engine-status-wire.spec.ts` pins the
 * descriptor the host registers against the address the client calls.
 *
 * CLIENT-SAFE BY CONSTRUCTION: no imports, no `node:` builtins, no side effects
 * — only string literals and types. The client bundle's purity gate rejects
 * non-inline-safe `@deepseek-ai/*` value imports; this module has nothing to
 * inline but the two constants.
 *
 * @module @mstar-harness/dsh/engine-status-wire
 */

/** The gateway channel every endpoint is served on (the host's shared `/api`). */
export const ENGINE_STATUS_CHANNEL = '/api'
/**
 * Wire namespace of the plugin's invocations — the `mstar` family. The
 * engine-status service's cordis key mirrors it (it is the wire namespace's
 * service), while `mstar/panelSnapshot` is served from its own service key.
 */
export const MSTAR_ENGINE_STATUS_NAMESPACE = 'mstar'
/**
 * Wire method of the panel's workflow-selection control → `/api/mstar/selectWorkflow`.
 * A session-scoped UI control (never a model workflow-execution tool): the host
 * commits the pick durably, and the next panel read rebuilds its selection from
 * the acknowledged binding.
 */
export const MSTAR_SELECT_WORKFLOW_METHOD = 'selectWorkflow'
/** The endpoint path the client calls for a workflow pick. */
export const SELECT_WORKFLOW_ENDPOINT = `${MSTAR_ENGINE_STATUS_NAMESPACE}/${MSTAR_SELECT_WORKFLOW_METHOD}`
/**
 * Wire namespace of the panel-snapshot read. The panel keeps the `mstar`
 * namespace (one plugin, one address family) while serving the snapshot from
 * its own host service, so the retired engine-status read path could not
 * withdraw it.
 */
export const MSTAR_PANEL_SNAPSHOT_NAMESPACE = 'mstar'
/** Wire method of the store-backed panel read → `/api/mstar/panelSnapshot`. */
export const MSTAR_PANEL_SNAPSHOT_METHOD = 'panelSnapshot'
/** The endpoint path the panel calls on every poll tick. */
export const PANEL_SNAPSHOT_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_PANEL_SNAPSHOT_METHOD}`
/**
 * Wire method of the per-view read → `/api/mstar/dashboardView`.
 *
 * One invocation answers every engine `DashboardView` (`workflow-detail`, the
 * `iterations` list, …), exactly as `/api/<view>` answers the dashboard: the
 * screens read the same engine views through their own transport, and the
 * plugin re-reads no store state the dashboard cannot. It rides the SAME typert
 * contribution as `panelSnapshot` (one contribution per package face).
 */
export const MSTAR_DASHBOARD_VIEW_METHOD = 'dashboardView'
/** The endpoint path a screen calls for its own view (one request per read). */
export const DASHBOARD_VIEW_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_DASHBOARD_VIEW_METHOD}`

/**
 * Wire methods of the milestone write channel (plan 20261029-dashboard-alignment
 * Task 4, contract C1): one endpoint per engine verb, riding the SAME typert
 * service and namespace as the reads. `milestoneAssign` covers unassign — the
 * engine's `assignIssueMilestone` takes `milestoneId: null`. There is no
 * `milestoneRemove` yet: the engine's `removeMilestone` verb is landing on the
 * engine track and the remove action ships after it merges.
 */
export const MSTAR_MILESTONE_ADD_METHOD = 'milestoneAdd'
export const MSTAR_MILESTONE_UPDATE_METHOD = 'milestoneUpdate'
export const MSTAR_MILESTONE_ASSIGN_METHOD = 'milestoneAssign'
export const MSTAR_MILESTONE_REMOVE_METHOD = 'milestoneRemove'
/** The endpoint paths the client calls for the milestone writes. */
export const MILESTONE_ADD_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_ADD_METHOD}`
export const MILESTONE_UPDATE_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_UPDATE_METHOD}`
export const MILESTONE_ASSIGN_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_ASSIGN_METHOD}`
export const MILESTONE_REMOVE_ENDPOINT = `${MSTAR_PANEL_SNAPSHOT_NAMESPACE}/${MSTAR_MILESTONE_REMOVE_METHOD}`
