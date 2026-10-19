/**
 * The in-process receipt of the harness a native bind adopted into (the
 * round-6 must-fix review finding).
 *
 * A native `mstar_plan_bind` call carrying an explicit per-call `harness`
 * adopts its durable execution binding into THAT control root (I-000765) — a
 * store the workspace harness's own store knows nothing about. The durable
 * binding itself records `harnessRoot`, but the consumers that must FIND the
 * binding (the workflow-ledger attribution resolver and the native
 * `mstar_execution_clear` tool) only hold the carrying session's
 * `(sessionId, cwd)` — reading the workspace harness there answers "no row",
 * because the slot was never written there and MUST NOT be written there
 * (the round-5 two-root regression pins root A untouched).
 *
 * This module is that missing discovery channel: the adoption records the
 * session's selected harness root at adopt time, and the consumers read it
 * back — binding-first — instead of re-deriving the root from the workspace.
 * The existing session/cwd identity pair is the key, so a record is never
 * addressable for another session or workspace, and the workspace-root path
 * (no explicit `harness`) is unchanged: no record, workspace resolution.
 *
 * Scope note: this is a per-host-process receipt, not a durable channel. A
 * host restart (or a plugin-fiber reload) drops it, and the consumers then
 * answer exactly as they did before this module existed (attribution null,
 * clear `no-binding`) — the named recovery for both is re-running the native
 * bind, which re-adopts (the engine coordinator seat stays bound, so the
 * re-bind recovers) and re-records the root here.
 */

/** One record: the selected root for one exact `(sessionId, cwd)` pair. */
const selectedRoots = new Map<string, string>()

/** The map key — the session/cwd identity pair, delimiter-joined. */
function keyOf(sessionId: string, cwd: string): string {
  return `${sessionId}\u0000${cwd}`
}

/**
 * Record the harness root a native bind adoption wrote its durable binding
 * into, for the carrying `(sessionId, cwd)` pair. Only a successful adoption
 * records: a refused envelope never rewrites the session's selection.
 */
export function recordExecutionBindingRoot(sessionId: string, cwd: string, harnessRoot: string): void {
  if (sessionId === '' || cwd === '' || harnessRoot === '') return
  selectedRoots.set(keyOf(sessionId, cwd), harnessRoot)
}

/**
 * The harness root this session's native bind selected, or `undefined` when
 * the session has no in-process adoption receipt (a bind without an explicit
 * `harness`, a fresh host process after a restart, a reload) — the caller
 * resolves the workspace harness, the unchanged pre-existing path.
 */
export function executionBindingRootOf(sessionId: string, cwd: string): string | undefined {
  if (sessionId === '' || cwd === '') return undefined
  return selectedRoots.get(keyOf(sessionId, cwd))
}

/**
 * Drop the receipt — the native clear calls this after it actually cleared
 * the binding in the selected root, so a later clear answers `no-binding`
 * against the workspace root instead of re-resolving a cleared slot.
 */
export function clearExecutionBindingRoot(sessionId: string, cwd: string): void {
  if (sessionId === '' || cwd === '') return
  selectedRoots.delete(keyOf(sessionId, cwd))
}

/**
 * Test-only reset: a suite sharing one module instance clears every receipt
 * between cases (production callers never need this — records are keyed by
 * the session/cwd pair and expire with the host process).
 */
export function resetExecutionBindingRootsForTests(): void {
  selectedRoots.clear()
}
