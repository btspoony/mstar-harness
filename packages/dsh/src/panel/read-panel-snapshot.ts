/**
 * The panel's host-side read service: one `PanelSnapshot` composed from the
 * control-root `store.db` authorities.
 *
 * WHY: the panel used to render whatever the model last saw (an emitted
 * catalog payload), so it was empty before the first emission, frozen while
 * the model was idle, and bounded by a 60 s cache. The store already holds
 * every authority the panel needs, and the engine's dashboard view layer
 * serves them to both the CLI dashboard and this plugin.
 *
 * SEQUENTIAL BY CONSTRUCTION: the views are read one `await` at a time, never
 * with `Promise.all`. `withStoreRead` may refresh the execution/roadmap
 * projections — a WRITE — so two concurrent views would race on the same
 * derived rows.
 *
 * DEGRADATION IS EXPLICIT: a member that refuses becomes
 * `{ state: 'unavailable', reason }` (the store's own message) and never
 * aborts the rest; the snapshot is `unavailable` only when nothing could be
 * read at all. A store fault never throws out of here.
 *
 * @module @mstar-harness/dsh/panel/read-panel-snapshot
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readDashboardView,
  resolveRepoEnforcement,
  type DashboardView,
  type DashboardViewData,
  type ReadEnvelope,
  type StoreContext,
} from '@mstar-harness/engine'
import { AGENT_FLOW_DEFAULT_LIMIT, readAgentFlow } from '../gates/agent-flow.ts'
import type { AgentFlowView } from '../types.ts'
import type { PanelSnapshot, PanelSnapshotRead, PanelWorkspaceView } from './panel-snapshot.ts'

/**
 * The plugin's own manifest version (single-version invariant; own manifest
 * first). Same two-depth probe as the catalog's: the source layout is one
 * level below the package root, the bundled `dist/index.js` the other.
 */
function panelVersion(): string {
  for (const rel of ['../package.json', '../../package.json'] as const) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    } catch {
      // no manifest at this depth — try the next
    }
  }
  return '0.0.0'
}

/** The store's own failure text, verbatim; a non-Error carries its string form. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** Read ONE dashboard view; a refusal is a member state, never a throw. */
async function readView<V extends DashboardView>(
  context: StoreContext,
  view: V,
  params: Record<string, string | undefined> = {},
  id?: string,
): Promise<PanelWorkspaceView<DashboardViewData[V]>> {
  try {
    // The engine's own return type is the union over every view; the caller
    // names the view, so the per-view projection holds at this boundary.
    const envelope = (await readDashboardView({ context, view, params, id })) as ReadEnvelope<DashboardViewData[V]>
    return { state: 'ok', data: envelope.data }
  } catch (error) {
    return { state: 'unavailable', reason: reasonOf(error) }
  }
}

/**
 * The dsh ledger window for the selected workflow. Advisory: a missing or
 * unreadable ledger answers `null` and never fails the snapshot.
 */
function readLedger(harnessDir: string, workflowId: string | undefined): AgentFlowView | null {
  if (workflowId === undefined) return null
  try {
    return readAgentFlow(join(harnessDir, 'workflows', workflowId), workflowId, AGENT_FLOW_DEFAULT_LIMIT, harnessDir)
  } catch {
    return null
  }
}

/**
 * Compose one panel snapshot from the store authorities.
 *
 * `harnessDir === null` (no workspace harness) is the whole-snapshot
 * unavailable state — never a fabricated empty workspace.
 * @param input - the resolved harness dir plus the ids the session currently addresses.
 * @returns the composed snapshot, or the explicit unavailable state with a reason.
 */
export async function readPanelSnapshot(input: {
  harnessDir: string | null
  workflowId?: string
  iterationId?: string
  projectId?: string
}): Promise<PanelSnapshotRead> {
  const { harnessDir, workflowId, iterationId, projectId } = input
  if (harnessDir === null || harnessDir === '') return { kind: 'unavailable', reason: 'no-harness-dir' }

  const context: StoreContext = { harnessDir }
  // One `await` per view, in dependency order (detail → roadmap → workspace):
  // `withStoreRead` refreshes projections, so these must not overlap.
  const workflow = workflowId === undefined
    ? { state: 'not-applicable', reason: 'no workflow selected' } as const
    : await readView(context, 'workflow-detail', {}, workflowId)
  const iteration = iterationId === undefined
    ? { state: 'not-applicable', reason: 'no iteration selected' } as const
    : await readView(context, 'iteration-detail', {}, iterationId)
  // The roadmap view needs a project identity; without one nothing is read
  // (`dashboardFilters` refuses a roadmap read without it, and a refusal is
  // not what "no project resolved" means).
  const roadmap = projectId === undefined
    ? { state: 'not-applicable', reason: 'no project resolved' } as const
    : await readView(context, 'roadmap', { project: projectId })
  const issues = await readView(context, 'issues', projectId === undefined ? {} : { project: projectId })
  const projects = await readView(context, 'projects')

  // Stamped once, after the last read: the panel's freshness is the instant the
  // whole snapshot was assembled.
  const at = new Date().toISOString()
  const workspace = { workflow, iteration, roadmap, issues, projects }

  const members = Object.values(workspace)
  const attempted = members.filter((member) => member.state !== 'not-applicable')
  if (attempted.length > 0 && attempted.every((member) => member.state === 'unavailable')) {
    // Nothing was read: the store is the failure (absent, staged, corrupt), and
    // its own message is the answer — a snapshot of five degraded members would
    // read as a workspace that answered.
    return { kind: 'unavailable', reason: (members.find((member) => member.state === 'unavailable') as { reason: string }).reason }
  }

  const snapshot: PanelSnapshot = {
    at,
    version: panelVersion(),
    harnessDir,
    enforcement: resolveRepoEnforcement(harnessDir),
    workspace,
    // The four facts no dashboard DTO carries come from the catalog cache; the
    // read service takes no cache handle, so they stay explicitly absent until
    // that wiring lands rather than being re-derived here (iteration-gate
    // evaluation and the knowledge digest are NOT re-implemented in the panel).
    retained: { iterationGate: null, knowledge: null, selection: null },
    ledger: readLedger(harnessDir, workflowId),
  }
  return { kind: 'ok', snapshot }
}
