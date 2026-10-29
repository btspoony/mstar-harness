/**
 * The panel's host-side digest read: the session-scoped facts no dashboard DTO
 * carries — `enforcement`, `knowledge`, `selection` — plus the ONE envelope read
 * the per-view path does not replace (`iteration`, the delivery line's
 * no-answer fallback).
 *
 * WHY the shrink (plan dsh-panel-unification Task 4, compass D23): the panel
 * used to compose FIVE dashboard views on every poll tick. Each of those views
 * is a `DashboardView` the dashboard already serves, so every screen now reads
 * its own view through `mstar/dashboardView` when it mounts and nothing polls.
 * What is left here is what no view answers.
 *
 * SEQUENTIAL BY CONSTRUCTION: the iteration fallback may refresh the execution
 * projections (a WRITE), so reads never overlap.
 *
 * DEGRADATION IS EXPLICIT: a member that refuses becomes
 * `{ state: 'unavailable', reason }` (the store's own message); the digest is
 * `unavailable` only when the store itself could not answer. A store fault
 * never throws out of here.
 *
 * @module @mstar-harness/dsh/panel/read-panel-snapshot
 */

import {
  readDashboardView,
  resolveRepoEnforcement,
  type DashboardView,
  type DashboardViewData,
  type EnforcementFlag,
  type IterationDTO,
  type IterationListDTO,
  type ReadEnvelope,
  type StoreContext,
} from '@mstar-harness/engine'
import { readExecutionWorkflowSource, type SessionHint } from '../gates/workflow-selection.ts'
import { readWorkflowSessionBinding } from '../engine-status-store.ts'
import type { MstarEngineStatusPayload } from '../types.ts'
import type { LeafSignalState, PanelSnapshot, PanelSnapshotRead, PanelWorkspaceView } from './panel-snapshot.ts'

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
function enforcementOf(harnessDir: string): EnforcementFlag | null {
  try {
    return resolveRepoEnforcement(harnessDir)
  } catch {
    // NOT `{ hard: false }`: a failed read is not a genuine soft flag, and the
    // product would say "soft" for a store it could not read.
    return null
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
  /**
   * The leaf-signal disclosure the caller probed (#619). REQUIRED: this module
   * has no host context and must never guess the fact; the endpoint owns the
   * `shellEnv` probe and passes its answer here.
   */
  leafSignal: LeafSignalState
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

    // The selected workflow comes from the session's durable pick (server-side),
    // never from the browser: the client asserts only `{ sessionId, cwd }`.
    const workflowId = scope.workflowId ?? (sessionId !== undefined && cwd !== undefined
      ? await resolveWorkflowId(root, sessionId, cwd)
      : undefined)

    // The delivery fallback: the iteration whose own lifecycle IS the selected
    // workflow, else the single registered one. Reading the list is the only
    // honest join (a plan row carries no iteration back-reference).
    let iterationId = scope.iterationId
    if (iterationId === undefined) {
      const list = await readView(context, 'iterations', {}, undefined, scope.signal)
      if (list.state === 'unavailable') {
        // The store refused the only read that could answer: that IS the whole
        // answer, and its own message travels verbatim.
        return { kind: 'unavailable', reason: list.reason }
      }
      iterationId = list.state === 'ok' ? pickIterationId(list.data, workflowId) : undefined
    }
    const iteration: PanelWorkspaceView<IterationDTO | null> = iterationId === undefined
      ? { state: 'not-applicable', reason: 'no iteration selected' }
      : await readView(context, 'iteration-detail', {}, iterationId, scope.signal)

    // The catalog facts come LAST: a cache miss rebuilds the payload, which
    // reads the store and can refresh projections, so it must never overlap a
    // view read above.
    assertLive(scope.signal)
    const retainedRead = await readRetained(scope.retained, root, sessionId, cwd)

    // The three facts no dashboard DTO carries are REUSED from the catalog
    // cache, never re-derived here: the knowledge digest and the session
    // selection stay owned by the catalog build.
    const snapshot: PanelSnapshot = {
      enforcement: enforcementOf(root),
      knowledge: retainedRead?.payload.state?.knowledge ?? null,
      selection: retainedRead?.payload.state?.selection ?? null,
      iteration,
      leafSignal: scope.leafSignal,
    }
    return { kind: 'ok', snapshot }
  }
}
