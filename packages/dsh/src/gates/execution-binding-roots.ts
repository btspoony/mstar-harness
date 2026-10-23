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
 * restart. The store installs asynchronously, so an adoption may land first;
 * installing then replays this module's overlay into the table, and a cleared
 * tombstone (`null`) is deleted from the table instead of being written back as
 * a root. With no seam — the host service is absent, its open refused, or a
 * bare module instance in a test — the receipt is exactly the per-process map
 * it has always been, and the consumers answer as they did before this module
 * existed (attribution null, clear `no-binding`). That degraded fallback is not
 * silent: the first adoption that finds neither an installed seam nor an `open`
 * in flight warns once with the recovery below, and the bind's wait for a
 * durable acknowledgment is bounded,
 * so a stalled backend is reported and answered from the overlay rather than
 * hanging a committed bind. The named recovery for that
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
  executionBindingRootStoreInstalled,
  executionBindingRootStoreOpening,
  putDurableExecutionBindingRoot,
  registerExecutionBindingRootReplay,
  warnExecutionBindingRoots,
} from './execution-binding-roots-domain.ts'

/**
 * One observed record: the selected root for one exact `(sessionId, cwd)` pair,
 * or `null` for a cleared tombstone (observed-and-cleared, so the durable table
 * is never consulted for that key again in this process).
 */
const observedRoots = new Map<string, string | null>()

/**
 * Bound on the native bind's wait for the durable receipt's acknowledgment.
 * A healthy backend resolves far below it; a stalled backend, or a domain
 * close that never settles its queued writes, must not leave `mstar_plan_bind`
 * unanswered after the engine bind already committed.
 *
 * shortcut: a fixed 250 ms — a healthy backend that occasionally acknowledges
 * slower ages that receipt into the per-process fallback and logs it; upgrade
 * to a configurable bound or a backend-health probe if a supported host
 * reports acknowledgments above it.
 */
const DURABLE_RECEIPT_BOUND_MS = 250

/**
 * The bound in force. Production never changes it; a suite raises it through
 * {@link setDurableReceiptBoundForTests} when its assertion must not race the
 * timer (a starved runner can lose a whole macrotask hop to 250 ms).
 */
let durableReceiptBoundMs = DURABLE_RECEIPT_BOUND_MS

/** Test seam for the receipt wait: raise it, or pass `undefined` to restore the production default. */
export function setDurableReceiptBoundForTests(milliseconds: number | undefined): void {
  durableReceiptBoundMs = milliseconds ?? DURABLE_RECEIPT_BOUND_MS
}

/** One-time diagnostic: this process has no seam AND no `open` in flight (a deployment fact, not a per-call failure). */
const NO_DURABLE_SEAM_WARNING =
  'durable adopted control root unavailable: the host provides no storage-domain seam, so the selected control root stays a per-process receipt that a restart drops — once the host provides the domain, restart so the next apply can install it, then a resume re-bind carrying the original session reference records it durably'

/** Whether the missing-facility warning already fired in this process. */
let warnedNoDurableSeam = false

/**
 * Report a seam absence that carries its own cause and recovery — the plugin's
 * refused `open`. The one-shot latch is spent WITH that report, so the generic
 * "the host provides no seam" line cannot follow it for the same degradation
 * and name a cause that is not true (the facility is provided; only this
 * `open` was refused). A later install resets the latch with the seam.
 */
export function warnExecutionBindingRootStoreUnavailable(message: string): void {
  warnedNoDurableSeam = true
  warnExecutionBindingRoots(message)
}

/** The map key — the session/cwd identity pair, delimiter-joined. */
function keyOf(sessionId: string, cwd: string): string {
  return `${sessionId}\u0000${cwd}`
}

/**
 * Record the harness root a native bind adoption wrote its durable binding
 * into, for the carrying `(sessionId, cwd)` pair. Only a successful adoption
 * records: a refused envelope never rewrites the session's selection. The
 * receipt is synchronous and the returned promise settles once the queued
 * durable write is acknowledged or the wait bound expires — it never rejects,
 * so a store failure cannot reach the bind path.
 *
 * The wait for the backend's acknowledgment is bounded (see
 * `DURABLE_RECEIPT_BOUND_MS`): the overlay already answers, so a stalled
 * backend or a close that never settles its pending writes degrades the
 * receipt to the per-process map instead of leaving the committed bind
 * unanswered.
 */
export async function recordExecutionBindingRoot(sessionId: string, cwd: string, harnessRoot: string): Promise<void> {
  if (sessionId === '' || cwd === '' || harnessRoot === '') return
  const key = keyOf(sessionId, cwd)
  observedRoots.set(key, harnessRoot)
  // The facility is optional, and silence would hide the degraded fallback:
  // say it ONCE, at the first adoption that finds neither a seam nor an `open`
  // in flight (a pending open back-fills this receipt at install, so warning
  // then would name a cause that is not true).
  if (!executionBindingRootStoreInstalled() && !executionBindingRootStoreOpening() && !warnedNoDurableSeam) {
    warnedNoDurableSeam = true
    warnExecutionBindingRoots(NO_DURABLE_SEAM_WARNING)
  }
  const write = putDurableExecutionBindingRoot(key, harnessRoot)
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      warnExecutionBindingRoots(
        `durable adopted control root receipt not acknowledged within ${durableReceiptBoundMs} ms — the native bind answered from the per-process receipt, so a restart may drop it; a resume re-bind records it durably`,
      )
      resolve()
    }, durableReceiptBoundMs)
  })
  try {
    await Promise.race([write, bound])
  } finally {
    clearTimeout(timer)
  }
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
  // A tombstone changes an answer only for a key that could otherwise answer:
  // an overlay entry this process recorded, or a durable record the queued
  // delete has not landed over. An unobserved, durably absent key stays
  // unobserved, so the overlay never grows for keys nothing has ever stored.
  if (observedRoots.has(key) || durableExecutionBindingRootOf(key) !== undefined) observedRoots.set(key, null)
  return deleteDurableExecutionBindingRoot(key)
}

/**
 * Test-only reset: a suite sharing one module instance clears every in-process
 * receipt (and the one-time warning latch) between cases (the durable table is
 * untouched — a fresh seam over the same medium is how the restart shape is
 * modelled).
 */
export function resetExecutionBindingRootsForTests(): void {
  observedRoots.clear()
  warnedNoDurableSeam = false
}

// The store installs asynchronously (the plugin's deferred child), so an
// adoption can precede it: installing replays every observed entry into the
// table — the recorded roots, and the cleared tombstones as deletes rather than
// roots — so no receipt is readable in-process yet absent after a restart.
registerExecutionBindingRootReplay(() => {
  // An installed seam is the facility working: a later absence is a NEW
  // degradation and must be able to warn again.
  warnedNoDurableSeam = false
  for (const [key, root] of observedRoots) {
    if (root === null) void deleteDurableExecutionBindingRoot(key)
    else void putDurableExecutionBindingRoot(key, root)
  }
})
