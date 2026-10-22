/**
 * The receipt of the control root that a native `mstar_plan_bind` call carrying
 * an explicit per-call `harness` adopts its durable execution binding into. The
 * consumers (the workflow-ledger attribution resolver and the native
 * `mstar_execution_clear` tool) hold only the carrying session's
 * `(sessionId, cwd)` and must not re-derive the root from the workspace.
 *
 * A native `mstar_plan_bind` call carrying an explicit per-call `harness`
 * adopts its durable execution binding into THAT control root — a
 * store the workspace harness's own store knows nothing about. The durable
 * binding itself records `harnessRoot`, but the consumers that must FIND the
 * binding (the workflow-ledger attribution resolver and the native
 * `mstar_execution_clear` tool) only hold the carrying session's
 * `(sessionId, cwd)` — reading the workspace harness there answers "no row",
 * because the slot was never written there and MUST NOT be written there
 * (a cross-root bind must leave the workspace root untouched).
 *
 * This module is that missing discovery channel: the adoption records the
 * session's selected harness root at adopt time, and the consumers read it
 * back — binding-first — instead of re-deriving the root from the workspace.
 * The existing session/cwd identity pair is the key, so a record is never
 * addressable for another session or workspace, and the workspace-root path
 * (no explicit `harness`) is unchanged: no record, workspace resolution.
 *
 * Durability: when the plugin's storage-domain seam is installed (see
 * `execution-binding-roots-domain.ts`), every record and clear is mirrored into
 * a durable table under the same `keyOf` key, so the receipt survives a host
 * restart. With no seam — the host service is absent, its open refused, or a
 * bare module instance in a test — the receipt is exactly the per-process map
 * it has always been, and the consumers answer as they did before this module
 * existed (attribution null, clear `no-binding`). The named recovery for that
 * degraded case is a RESUME re-bind: re-run the native bind carrying the
 * ORIGINAL session reference (the `resumeRef` the first bind's receipt minted —
 * still durable in the binding slot's `executionBinding.session`) and the SAME
 * `harness` selection; the engine resumes the still-bound coordinator seat and
 * the adoption re-records the root here. When the ADOPTION itself failed after
 * the engine bind committed, the slot never received that reference: the
 * refusal then carries it as `data.resumeRef` (with the workflow id and the
 * adoption's `harness` root), so the same resume re-bind stays performable.
 * A plain re-execution bind is NOT a recovery: a live holder's row is never
 * replaced by a bind — the bind is refused (`coordination.identity-mismatch`
 * for a live current-epoch holder, `execution.session-unavailable` once the
 * row's epoch is behind the store's) and adopts nothing.
 *
 * Read order: the in-process overlay is FIRST. A key this process has observed
 * answers from the overlay — the recorded root, or the cleared tombstone — and
 * only a key never observed is read from the durable table. Durable-first would
 * resurrect a just-cleared root: the domain mutates its memory only after the
 * backend write lands, so the delete is still queued when the read happens.
 */
import {
  deleteDurableExecutionBindingRoot,
  durableExecutionBindingRootOf,
  putDurableExecutionBindingRoot,
} from './execution-binding-roots-domain.ts'

/**
 * One observed record: the selected root for one exact `(sessionId, cwd)` pair,
 * or `null` for a cleared tombstone (observed-and-cleared, so the durable table
 * is never consulted for that key again in this process).
 */
const observedRoots = new Map<string, string | null>()

/** The map key — the session/cwd identity pair, delimiter-joined. */
function keyOf(sessionId: string, cwd: string): string {
  return `${sessionId}\u0000${cwd}`
}

/**
 * Record the harness root a native bind adoption wrote its durable binding
 * into, for the carrying `(sessionId, cwd)` pair. Only a successful adoption
 * records: a refused envelope never rewrites the session's selection. The
 * receipt is synchronous and the returned promise is the queued durable
 * write — it never rejects, so a store failure cannot reach the bind path.
 */
export function recordExecutionBindingRoot(sessionId: string, cwd: string, harnessRoot: string): Promise<void> {
  if (sessionId === '' || cwd === '' || harnessRoot === '') return Promise.resolve()
  const key = keyOf(sessionId, cwd)
  observedRoots.set(key, harnessRoot)
  return putDurableExecutionBindingRoot(key, harnessRoot)
}

/**
 * The harness root this session's native bind selected, or `undefined` when
 * the session has no adoption receipt (a bind without an explicit `harness`, a
 * cleared receipt, a failed durable read) — the caller resolves the workspace
 * harness, the unchanged pre-existing path. Synchronous: a key this process
 * never observed reads the open domain table's in-memory state.
 */
export function executionBindingRootOf(sessionId: string, cwd: string): string | undefined {
  if (sessionId === '' || cwd === '') return undefined
  const key = keyOf(sessionId, cwd)
  if (observedRoots.has(key)) return observedRoots.get(key) ?? undefined
  return durableExecutionBindingRootOf(key)
}

/**
 * Drop the receipt — the native clear calls this after it actually cleared
 * the binding in the selected root, so a later clear resolves the workspace
 * root instead of re-resolving a cleared slot: it answers `no-binding` when
 * the workspace declares a harness there, and the named no-harness refusal
 * otherwise. The tombstone is synchronous (a read before the durable delete
 * lands answers `undefined`) and the returned promise is the queued durable
 * delete; like the record, it never rejects.
 */
export function clearExecutionBindingRoot(sessionId: string, cwd: string): Promise<void> {
  if (sessionId === '' || cwd === '') return Promise.resolve()
  const key = keyOf(sessionId, cwd)
  observedRoots.set(key, null)
  return deleteDurableExecutionBindingRoot(key)
}

/**
 * Test-only reset: a suite sharing one module instance clears every in-process
 * receipt between cases (the durable table is untouched — a fresh seam over the
 * same medium is how the restart shape is modelled).
 */
export function resetExecutionBindingRootsForTests(): void {
  observedRoots.clear()
}
