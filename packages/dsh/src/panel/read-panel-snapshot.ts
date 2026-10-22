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
 * MEASURED projection cost (three `needsProjection` views per snapshot:
 * `iterations`, `workflow-detail`, `iteration-detail`): the refresh does NOT
 * rewrite derived rows when nothing changed. `refreshProjections` captures the
 * sources, and `publishGeneration` short-circuits on an unchanged source-set
 * hash plus an unchanged render digest (`packages/engine/src/projection.ts:1162`
 * — no delete, no insert, no generation bump; only a `checked_at`/health row
 * move when a retained stale health row must clear). The paid cost is therefore
 * one source capture plus one empty write transaction per bearing view, not a
 * projection rewrite; the structure is left alone deliberately.
 *
 * TARGETS ARE RESOLVED SERVER-SIDE: the browser supplies only
 * `{ sessionId, cwd }`, so the workflow/iteration/project ids are resolved here
 * from the session's durable picker record and the harness catalog — never
 * required from the client, and never taken over by a client claim (an asserted
 * id wins only because it is first choice, and it is still read against the
 * server-resolved harness root).
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
  _DEFAULT_PROJECT,
  readDashboardView,
  resolveRepoEnforcement,
  type DashboardView,
  type DashboardViewData,
  type EnforcementFlag,
  type IterationListDTO,
  type ProjectListDTO,
  type ReadEnvelope,
  type StoreContext,
} from '@mstar-harness/engine'
import { AGENT_FLOW_DEFAULT_LIMIT, readAgentFlow } from '../gates/agent-flow.ts'
import { readExecutionWorkflowSource, type SessionHint } from '../gates/workflow-selection.ts'
import { readWorkflowSessionBinding } from '../engine-status-store.ts'
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

/** The engine's documented page ceiling (`paging()` refuses >200). */
const ISSUE_PAGE_LIMIT = '200'

/** The store's own failure text, verbatim; a non-Error carries its string form. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** Cancelled carrier lifetime inside this module (translated at the boundary). */
class PanelReadAborted extends Error {
  constructor() {
    super('aborted')
  }
}

/**
 * Stop before the next read when the caller's carrier already cancelled. The
 * point is the VIEW LOOP: a client timeout must not leave this read (plus its
 * projection capture) running server-side after nobody is waiting for it.
 */
function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new PanelReadAborted()
}

/** Read ONE dashboard view; a refusal is a member state, never a throw. */
async function readView<V extends DashboardView>(
  context: StoreContext,
  view: V,
  params: Record<string, string | undefined> = {},
  id?: string,
  signal?: AbortSignal,
): Promise<PanelWorkspaceView<DashboardViewData[V]>> {
  assertLive(signal)
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
 * The workflow the session is addressing, server-side: the durable picker
 * record folded with the session's structural identity, exactly as the retired
 * emission read answered it (`selectActiveWorkflow` is the same fold, so an
 * unbound session with ONE active lifecycle resolves that one and a stale pick
 * falls back to it too). Advisory: no pick, an unreadable record or a
 * multi-active registry answers undefined and the member stays
 * `not-applicable` instead of guessing a lifecycle.
 */
async function resolveWorkflowId(
  harnessDir: string,
  sessionId: string,
  cwd: string,
): Promise<string | undefined> {
  try {
    const stored = readWorkflowSessionBinding(harnessDir, sessionId, cwd)
    const selected = stored.kind === 'ok' ? stored.binding?.selectedWorkflowId : undefined
    const hint: SessionHint = {
      cwd,
      sessionId,
      ...(selected === undefined ? {} : { selectedWorkflowId: selected }),
    }
    const source = await readExecutionWorkflowSource({ harnessDir }, hint)
    return source.kind === 'active' ? source.workflowId : undefined
  } catch {
    return undefined
  }
}

/**
 * The project the roadmap is scoped to: the catalog's `_default` row (the
 * fallback identity every project-less flow uses), else the single resolvable
 * project. Several projects with no `_default` answer undefined — the roadmap
 * member then says `not-applicable` rather than picking one.
 */
function pickProjectId(list: ProjectListDTO): string | undefined {
  const ids = list.items.map((item) => item.project.id)
  return ids.includes(_DEFAULT_PROJECT) ? _DEFAULT_PROJECT : ids.length === 1 ? ids[0] : undefined
}

/**
 * The iteration the workspace is addressing: the one whose own lifecycle IS the
 * selected workflow (an iteration IS a lifecycle), else the single registered
 * iteration. Several unrelated iterations answer undefined — the stepper stays
 * `not-applicable` instead of showing another iteration's phase.
 */
function pickIterationId(list: IterationListDTO, workflowId: string | undefined): string | undefined {
  if (workflowId !== undefined) {
    const own = list.items.find((item) => item.workflow?.id === workflowId)
    if (own !== undefined) return own.iterationId
  }
  return list.items.length === 1 ? list.items[0].iterationId : undefined
}

/**
 * The repository enforcement flag, degraded in place: an unreadable `.mstarc`
 * or compass is its own absent signal, never a reason to drop a workspace whose
 * five store views all answered.
 */
function enforcementOf(harnessDir: string): EnforcementFlag {
  try {
    return resolveRepoEnforcement(harnessDir)
  } catch {
    return { hard: false, source: 'none' }
  }
}

/**
 * Compose one panel snapshot from the store authorities.
 *
 * `harnessDir === null` (no workspace harness) is the `no-harness` state — an
 * inactive workspace, never a fabricated empty one and never a store error.
 * @param input - the resolved harness dir, the optional client-asserted ids,
 *   the validated session the catalog cache is keyed by, the apply-scoped
 *   catalog reader, and the carrier signal.
 * @returns the composed snapshot, `no-harness`, or the explicit unavailable
 *   state with a reason (`aborted` when the carrier cancelled mid-read).
 */
export async function readPanelSnapshot(input: {
  harnessDir: string | null
  /** A client-asserted workflow id; the resolved session's pick is used when absent. */
  workflowId?: string
  /** A client-asserted iteration id; the harness catalog resolves one when absent. */
  iterationId?: string
  /** A client-asserted project id; the harness catalog resolves one when absent. */
  projectId?: string
  /** The validated session the catalog cache is keyed by (absent ⇒ no retained read). */
  sessionId?: string
  /** The validated session workspace, the cache key's second half. */
  cwd?: string
  /** The apply-scoped catalog reader; absent in a host without the catalog wiring. */
  retained?: PanelRetainedReader
  /** Carrier lifetime: checked before every read so a cancelled call stops paying. */
  signal?: AbortSignal
}): Promise<PanelSnapshotRead> {
  if (input.harnessDir === null || input.harnessDir === '') return { kind: 'no-harness' }

  try {
    return await compose(input, input.harnessDir)
  } catch (error) {
    if (error instanceof PanelReadAborted) return { kind: 'unavailable', reason: 'aborted' }
    throw error
  }

  /**
   * The read itself. Split out only so the abort translation above stays a
   * single boundary instead of a try/catch around every view.
   */
  async function compose(scope: typeof input, root: string): Promise<PanelSnapshotRead> {
    const context: StoreContext = { harnessDir: root }
    const { sessionId, cwd } = scope

    // The projects view is read FIRST and reused twice: it names the roadmap's
    // project and it is a snapshot member. Nothing else can resolve a project
    // identity, and it bears no projection.
    const projectsView = await readView(context, 'projects', {}, undefined, scope.signal)
    const projectId = scope.projectId ?? (projectsView.state === 'ok' ? pickProjectId(projectsView.data) : undefined)

    // The selected workflow comes from the session's durable pick (server-side),
    // never from the browser: the panel only ever asserts `{ sessionId, cwd }`.
    const workflowId = scope.workflowId ?? (sessionId !== undefined && cwd !== undefined
      ? await resolveWorkflowId(root, sessionId, cwd)
      : undefined)

    // The iteration is a catalog identity too. Reading the list is the only
    // honest join (a plan row carries no iteration back-reference), so it is
    // read only when the caller did not name one.
    let iterationId = scope.iterationId
    if (iterationId === undefined) {
      // Deliberately unscoped by project: iteration membership is a catalog
      // relation, and a filtered page would hide the very iteration this read
      // is trying to resolve.
      const list = await readView(context, 'iterations', {}, undefined, scope.signal)
      iterationId = list.state === 'ok' ? pickIterationId(list.data, workflowId) : undefined
    }

    // One `await` per view, in dependency order (detail → roadmap → workspace):
    // `withStoreRead` refreshes projections, so these must not overlap.
    const workflow = workflowId === undefined
      ? { state: 'not-applicable', reason: 'no workflow selected' } as const
      : await readView(context, 'workflow-detail', {}, workflowId, scope.signal)
    const iteration = iterationId === undefined
      ? { state: 'not-applicable', reason: 'no iteration selected' } as const
      : await readView(context, 'iteration-detail', {}, iterationId, scope.signal)
    // The roadmap view needs a project identity; without one nothing is read
    // (`dashboardFilters` refuses a roadmap read without it, and a refusal is
    // not what "no project resolved" means).
    const roadmap = projectId === undefined
      ? { state: 'not-applicable', reason: 'no project resolved' } as const
      : await readView(context, 'roadmap', { project: projectId }, undefined, scope.signal)
    // The issue page feeds the roadmap's milestone↔issue severity join, so it
    // asks for the engine's full page (200, the documented ceiling) instead of
    // the default 50 — beyond that the join would render as unknown.
    const issues = await readView(
      context,
      'issues',
      projectId === undefined ? { limit: ISSUE_PAGE_LIMIT } : { project: projectId, limit: ISSUE_PAGE_LIMIT },
      undefined,
      scope.signal,
    )

    // Stamped once, after the last read: the panel's freshness is the instant
    // the whole snapshot was assembled.
    const at = new Date().toISOString()
    const views = { workflow, iteration, roadmap, issues, projects: projectsView }

    const members = Object.values(views)
    const attempted = members.filter((member) => member.state !== 'not-applicable')
    if (attempted.length > 0 && attempted.every((member) => member.state === 'unavailable')) {
      // Nothing was read: the store is the failure (absent, staged, corrupt), and
      // its own message is the answer — a snapshot of five degraded members would
      // read as a workspace that answered.
      return { kind: 'unavailable', reason: (members.find((member) => member.state === 'unavailable') as { reason: string }).reason }
    }

    // The catalog facts come LAST: a cache miss rebuilds the payload, which
    // reads the store and can refresh projections, so it must never overlap the
    // views above. Its freshness is its own (`builtAt`), not the store-read `at`.
    assertLive(scope.signal)
    const retainedRead = await readRetained(scope.retained, root, sessionId, cwd)

    const snapshot: PanelSnapshot = {
      at,
      version: panelVersion(),
      harnessDir: root,
      enforcement: enforcementOf(root),
      workspace: views,
      // The three facts no dashboard DTO carries are REUSED from the catalog
      // cache, never re-derived here: iteration-gate evaluation and the knowledge
      // digest stay owned by the catalog build.
      retained: {
        iterationGate: retainedRead?.payload.iteration ?? null,
        knowledge: retainedRead?.payload.state?.knowledge ?? null,
        selection: retainedRead?.payload.state?.selection ?? null,
        at: retainedRead === null ? null : new Date(retainedRead.builtAt).toISOString(),
      },
      ledger: readLedger(root, workflowId),
    }
    return { kind: 'ok', snapshot }
  }
}
