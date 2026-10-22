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
import type { AgentFlowView, MstarEngineStatusPayload } from '../types.ts'
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
 * One cached catalog payload and the instant it was built — the shape
 * `readCatalogPayload` answers (threaded in from the apply scope, where the
 * cache and its TTL live).
 */
export interface PanelRetainedRead {
  readonly payload: MstarEngineStatusPayload
  /** Epoch millis the payload was built at (the retained members' OWN freshness). */
  readonly builtAt: number
}

/**
 * The apply-scoped catalog reader the plugin threads into this service.
 *
 * WHY injected rather than reached for: the cache, its TTL and the
 * session-keyed invalidation map are created per apply in `index.ts`. Passing
 * the reader keeps ONE catalog implementation (the pre-step's) and leaves this
 * module free of `gates/` imports.
 */
export type PanelRetainedReader = (
  harnessDir: string,
  sessionId: string,
  cwd: string,
) => Promise<PanelRetainedRead>

/**
 * The retained catalog facts, advisory in the same sense as the ledger: no
 * reader, no session identity or an unreadable cache answers `null` (all three
 * members, and their age) and never fails the snapshot. A store or catalog
 * fault must not turn a panel that has five good workspace views into an error.
 */
async function readRetained(
  reader: PanelRetainedReader | undefined,
  harnessDir: string,
  sessionId: string | undefined,
  cwd: string | undefined,
): Promise<PanelRetainedRead | null> {
  if (reader === undefined || sessionId === undefined || cwd === undefined) return null
  try {
    return await reader(harnessDir, sessionId, cwd)
  } catch {
    return null
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
 * @param input - the resolved harness dir, the ids the session addresses, and
 *   the optional catalog reader for the retained facts.
 * @returns the composed snapshot, or the explicit unavailable state with a reason.
 */
export async function readPanelSnapshot(input: {
  harnessDir: string | null
  workflowId?: string
  iterationId?: string
  projectId?: string
  /** The validated session the catalog cache is keyed by (absent ⇒ no retained read). */
  sessionId?: string
  /** The validated session workspace, the cache key's second half. */
  cwd?: string
  /** The apply-scoped catalog reader; absent in a host without the catalog wiring. */
  retained?: PanelRetainedReader
}): Promise<PanelSnapshotRead> {
  const { harnessDir, workflowId, iterationId, projectId, sessionId, cwd, retained } = input
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

  // The catalog facts come LAST: a cache miss rebuilds the payload, which reads
  // the store and can refresh projections, so it must never overlap the views
  // above. Its freshness is its own (`builtAt`), not the store-read `at`.
  const retainedRead = await readRetained(retained, harnessDir, sessionId, cwd)

  const snapshot: PanelSnapshot = {
    at,
    version: panelVersion(),
    harnessDir,
    enforcement: resolveRepoEnforcement(harnessDir),
    workspace,
    // The three facts no dashboard DTO carries are REUSED from the catalog
    // cache, never re-derived here: iteration-gate evaluation and the knowledge
    // digest stay owned by the catalog build.
    retained: {
      iterationGate: retainedRead?.payload.iteration ?? null,
      knowledge: retainedRead?.payload.state?.knowledge ?? null,
      selection: retainedRead?.payload.state?.selection ?? null,
      at: retainedRead === null ? null : new Date(retainedRead.builtAt).toISOString(),
    },
    ledger: readLedger(harnessDir, workflowId),
  }
  return { kind: 'ok', snapshot }
}
