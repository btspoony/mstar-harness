/**
 * Shared workflow selection resolvers (compass v3.0.0 § Catalog selection
 * rule; D4 binding order — locked 2026-09-11).
 *
 * The ACTIVE-SET resolver (`resolveActiveWorkflow`) picks the lifecycle a
 * session writes under, from ONE registry (`status.json` `workflows[]`) by
 * the locked order: lease (an `execution_lease` whose opaque `holder` equals
 * the hint's, or whose `worktree_path` contains its cwd) → cwd (a
 * `control_worktree_path` containing it) → the session's durable
 * `selectedWorkflowId` → the only active entry. Each automatic rung needs
 * EXACTLY ONE distinct match; zero or several fall through, and nothing
 * falls back to the registry's first entry. With N>1 and no binding the
 * resolver fails loud (`workflow.selection.unbound-multi-active` + the
 * active ids) — the write path skips and the read path shows the picker.
 *
 * READ path (catalog/panel): the same binding order → latest terminal
 * snapshot by mtime (history, reachable ONLY for an empty active set) →
 * clear error. WRITE path (agent-flow writer / ledger): active-set only —
 * the terminal-mtime fallback is catalog-read-only and MUST NOT be imported
 * by the writer. Both resolvers live in ONE module so the selection rule
 * cannot drift between the two consumers; the write side imports only
 * `resolveActiveWorkflow`.
 *
 * Module boundary: no barrel — consumers import by explicit relative path.
 * This module reads engine/fs + structural types only: the durable picker
 * store is loaded by the COMPOSITION EDGES (adapter / catalog /
 * workflow-ledger) and reaches the resolver as a plain `SessionHint`.
 *
 * TWO AUTHORITY ROUTES (primary spec §2.1/§5, plan S4). The binding order
 * above is the FILE route's rule and stays byte-identical on
 * `resolveActiveWorkflow`. While a control harness's EXECUTION authority is
 * ACTIVE the root `status.json` registry is retired as a source, so a source
 * consumer asks {@link readExecutionWorkflowSource} instead: it probes the ONE
 * route and, on the active route, reads the registry/plan state through
 * `readExecutionAuthority` and normalizes it into the SAME active-set input —
 * so the two routes share one binding rule and one identity discipline, and a
 * selector can never derive an answer from retired bytes or guess the
 * newest/only lifecycle.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import {
  assertCatalogExecutionCommitted,
  readExecutionAuthority,
  readJson,
  resolveExecutionReadRoute,
  resolveWorkflowDir,
  validateExecutionLease,
  validateWorkflowEntry,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
} from '@mstar-harness/engine'
import type { ExecutionPlanView, ExecutionRead, ExecutionState, StoreContext } from '@mstar-harness/engine'
import type { WorkflowSelectionView } from '../types.ts'
import { STATUS_FILE, asRecord } from './_shared.ts'

/** The active-set resolver result: the session's active lifecycle or a clear error. */
export type ActiveWorkflowSelection = WorkflowSelectionView

/**
 * What the carrying session can tell the resolver (structural — no
 * dsh-session import, so cold/raw Session consumers can build one too).
 * `sessionId` is the durable picker key (`session.header.id`), NEVER a
 * holder fallback; `leaseHolder` is the dispatching dsh `Agent.id` when an
 * Agent exists; `selectedWorkflowId` is the session's durable pick (loaded
 * by the caller from the engine-status store). Every field is optional —
 * an omitted hint just misses the corresponding rung.
 */
export interface SessionHint {
  cwd?: string
  sessionId?: string
  leaseHolder?: string
  selectedWorkflowId?: string
}

/**
 * Cache-entry cap for the terminal-status cache  — a
 * long-lived process across many workflow ids never grows it unbounded.
 */
const TERMINAL_STATUS_CACHE_MAX = 64

/**
 * Module-level terminal-status cache (the mtime-first
 * fast path): snapshot path → `{ mtimeMs, terminal }` — the parsed
 * terminal-status verdict for that file's mtime. The terminal fallback
 * re-walks every workflow dir per catalog refresh; when a snapshot's mtime
 * is unchanged since the last scan, the cached verdict is reused and the
 * full JSON parse is SKIPPED (the steady state: terminal snapshots never
 * change, so the per-TTL reparse is pure waste). The stat is the cheap
 * read; the parse only happens on a real change. Unreadable snapshots are
 * never cached (skipped advisory, as before). A same-mtime in-place
 * rewrite would be served stale until the file is touched — the
 * documented mtime-first tradeoff the finding asks for; terminal
 * snapshots are written once via temp-file + rename (mtime always
 * changes). Deleted snapshots are EVICTED : a dead key must not hold the cap.
 */
const terminalStatusCache = new Map<string, { mtimeMs: number; terminal: boolean }>()

/**
 * Test-only observability hook :
 * whether a snapshot path is still cached. Production code never calls
 * this — the eviction contract (delete → key gone) is asserted by the
 * workflow-selection spec.
 */
export function _terminalStatusCacheHas(snapshotPath: string): boolean {
  return terminalStatusCache.has(snapshotPath)
}

/**
 * One snapshot's terminal-status verdict, mtime-first :
 * stat the file, reuse the cached verdict when the mtime is unchanged,
 * else parse `status` and cache the verdict for the new mtime. Unreadable
 * snapshots → `undefined` (skipped — advisory, same as the caller's old
 * try/catch skip) and never cached.
 * @returns `{ terminal, mtimeMs }` on a readable snapshot, `undefined` when
 *   the file vanished or its JSON is unreadable.
 */
function terminalStatusOf(snapshotPath: string): { terminal: boolean; mtimeMs: number } | undefined {
  let mtimeMs: number
  try {
    mtimeMs = statSync(snapshotPath).mtimeMs
  } catch {
    // The target vanished — evict the dead key so the cap is not held by
    // a workflow that no longer exists (f12; the caller's `existsSync`
    // short-circuit never reaches this function, so the read loop evicts
    // there too).
    terminalStatusCache.delete(snapshotPath)
    return undefined
  }
  const cached = terminalStatusCache.get(snapshotPath)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached
  let terminal = false
  try {
    // `readJson` casts arbitrary parsed JSON — a bare `null`/array/primitive
    // snapshot has no `status` field: no evidence, exactly like an
    // unreadable snapshot (skip, never cache a verdict).
    const snapshot = asRecord(readJson(snapshotPath))
    if (snapshot === undefined) return undefined
    const status = snapshot.status
    terminal = typeof status === 'string' && (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status)
  } catch {
    return undefined // unreadable snapshot — skip (advisory), never cached
  }
  const verdict = { mtimeMs, terminal }
  terminalStatusCache.set(snapshotPath, verdict)
  while (terminalStatusCache.size > TERMINAL_STATUS_CACHE_MAX) {
    const oldest = terminalStatusCache.keys().next().value
    if (oldest === undefined) break
    terminalStatusCache.delete(oldest)
  }
  return verdict
}

/** One `engine`-validated `workflows[]` registry row (the only fields the resolver uses). */
interface ActiveEntry {
  readonly id: string
  readonly dir: string
}

/** Strip trailing separators (except the root itself) from an absolute path. */
function stripTrailingSeparators(path: string): string {
  let out = path
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1)
  return out
}

/** Normalized absolute lexical form (`.` / `..` / trailing separators collapsed). */
function lexical(path: string): string {
  return stripTrailingSeparators(normalize(path))
}

/**
 * One side of a containment comparison: the realpath when the path exists,
 * else its normalized absolute lexical form (`path`), or `error` for a
 * realpath failure that is not a plain absence (ELOOP, EACCES, …) — such a
 * pair is nonmatching, never guessed.
 */
type CanonicalPath =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'error' }

function canonicalPath(path: string): CanonicalPath {
  const fallback = lexical(path)
  try {
    return { kind: 'ok', path: lexical(realpathSync(path)) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing', path: fallback }
      : { kind: 'error' }
  }
}

/**
 * Canonical containment (spec § Binding order): does `root` contain `cwd`?
 *
 * Absolute, nonempty paths only. When BOTH sides exist their `realpathSync`
 * values are compared (a symlink out of the root therefore escapes it);
 * when either side is absent both sides fall back to their normalized
 * absolute lexical form — one real path against one lexical path is never
 * mixed. `root` contains `cwd` when they are equal or `relative` yields a
 * non-absolute result that is neither `..` nor starts with `..<sep>`, so
 * `/repo` contains `/repo/.worktrees/a/src` but not `/repo-other`. No
 * filesystem walk, process-cwd fallback, case folding or prefix
 * arbitration.
 */
function within(root: string, cwd: string): boolean {
  if (root === '' || cwd === '' || !isAbsolute(root) || !isAbsolute(cwd)) return false
  const rootCanonical = canonicalPath(root)
  if (rootCanonical.kind === 'error') return false
  const cwdCanonical = canonicalPath(cwd)
  if (cwdCanonical.kind === 'error') return false
  const bothExist = rootCanonical.kind === 'ok' && cwdCanonical.kind === 'ok'
  const rootPath = bothExist ? rootCanonical.path : lexical(root)
  const cwdPath = bothExist ? cwdCanonical.path : lexical(cwd)
  if (rootPath === cwdPath) return true
  const rel = relative(rootPath, cwdPath)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** The structurally valid `execution_lease` rows of one snapshot (invalid ones are no evidence). */
function validLeases(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(snapshot.plans)) return []
  const leases: Record<string, unknown>[] = []
  for (const row of snapshot.plans) {
    const lease = asRecord(asRecord(row)?.execution_lease)
    if (lease === undefined || !validateExecutionLease(lease).ok) continue
    leases.push(lease)
  }
  return leases
}

/**
 * One active registry entry's snapshot (`undefined` — no automatic evidence —
 * when it is absent, unreadable, or not a JSON object: `readJson` casts
 * arbitrary JSON, so a `null`/array/primitive document is rejected here rather
 * than dereferenced as a record).
 */
function readSnapshot(harnessDir: string, entry: ActiveEntry): Record<string, unknown> | undefined {
  const snapshotPath = join(harnessDir, entry.dir, WORKFLOW_SNAPSHOT_FILE)
  if (!existsSync(snapshotPath)) return undefined
  try {
    const snapshot = asRecord(readJson(snapshotPath))
    if (snapshot === undefined) return undefined
    if ('control_worktree_path' in snapshot && 'integration_worktree_path' in snapshot) return undefined
    if ('control_worktree_path' in snapshot) {
      const { control_worktree_path, ...rest } = snapshot
      return { ...rest, integration_worktree_path: control_worktree_path }
    }
    return snapshot
  } catch {
    return undefined
  }
}

/** The first (only) entry of a single-match map. */
function soleEntry(matches: Map<string, ActiveEntry>): ActiveEntry | undefined {
  return matches.size === 1 ? matches.values().next().value : undefined
}

/**
 * The two automatic rungs (lease → cwd), each requiring EXACTLY ONE distinct
 * workflow: `undefined` means the rung did not decide (zero or several
 * matches, an omitted hint field, or no automatic evidence) and the caller
 * proceeds to explicit/unique. The two candidate sets are collected
 * independently in ONE pass: an entry that matched the lease rung is still
 * evaluated for the cwd rung, so an ambiguous lease rung (two holders, or a
 * holder plus a lease-worktree match) can still be decided by a unique
 * `integration_worktree_path`. Each entry's snapshot is read at most once per
 * call, and only when a hint field could actually use it.
 */
function automaticBinding(source: ActiveSetSource, hint: SessionHint): ActiveWorkflowSelection | undefined {
  const cwd = hint.cwd === '' ? undefined : hint.cwd
  const holder = hint.leaseHolder === '' ? undefined : hint.leaseHolder
  if (cwd === undefined && holder === undefined) return undefined
  const leaseMatches = new Map<string, ActiveEntry>()
  const cwdMatches = new Map<string, ActiveEntry>()
  for (const entry of source.entries) {
    const snapshot = source.snapshotOf(entry)
    if (snapshot === undefined) continue
    const leases = validLeases(snapshot)
    if (
      (holder !== undefined && leases.some((lease) => lease.holder === holder)) ||
      (cwd !== undefined && leases.some((lease) => within(String(lease.worktree_path), cwd)))
    ) {
      leaseMatches.set(entry.id, entry)
    }
    // Rung 2 is collected independently: a lease match never removes the
    // entry from the cwd candidate set.
    const integrationWorktree = snapshot.integration_worktree_path
    if (cwd !== undefined && typeof integrationWorktree === 'string' && within(integrationWorktree, cwd)) {
      cwdMatches.set(entry.id, entry)
    }
  }
  // Several matches at a rung are ambiguous — never arbitrated by array
  // order or the longest prefix; the next rung decides.
  const byLease = soleEntry(leaseMatches)
  if (byLease !== undefined) return { kind: 'active', workflowId: byLease.id, dir: byLease.dir }
  const byCwd = soleEntry(cwdMatches)
  return byCwd === undefined ? undefined : { kind: 'active', workflowId: byCwd.id, dir: byCwd.dir }
}

/**
 * The normalized ACTIVE-SET source the binding order below runs on: the
 * validated registry rows plus each entry's materialized state (the plan rows
 * with their `execution_lease` and the lifecycle's integration topology). The
 * FILE route assembles it from `status.json` + the workflow snapshots; the
 * execution DB route normalizes `readExecutionAuthority`'s state into the SAME
 * shape (primary spec §5: source consumers normalize into the existing pure
 * gate input through an explicit adapter). The binding rule therefore exists
 * once and cannot drift between the two authority routes.
 */
interface ActiveSetSource {
  readonly entries: readonly ActiveEntry[]
  snapshotOf(entry: ActiveEntry): Record<string, unknown> | undefined
}

/** The registry rows of one v2 root document, validated entry by entry
 * (engine `validateWorkflowEntry` + duplicate rejection) — the SAME
 * acceptance for the file route and the DB route, so a bad row is an error
 * rather than a smaller active set on either (never a path outside the
 * harness). */
function activeEntriesOf(registry: readonly unknown[]): { entries: ActiveEntry[] } | { error: ActiveWorkflowSelection } {
  if (registry.length === 0) {
    return {
      error: {
        kind: 'error',
        code: 'workflow.selection.no-active',
        message: 'no active lifecycle in status.json workflows[] — the agent-flow writer appends only to an active lifecycle',
      },
    }
  }
  const entries: ActiveEntry[] = []
  const seen = new Set<string>()
  for (const raw of registry) {
    // Engine contract for one `workflows[]` row: `id`/`type`/`started_at`,
    // and a harness-relative `dir` with no absolute path or `..` segment
    // (so a snapshot read can never be pointed outside the harness). Every
    // entry is validated before N or the candidates are exposed.
    const gate = validateWorkflowEntry(raw)
    if (!gate.ok) {
      return {
        error: {
          kind: 'error',
          code: 'workflow.selection.invalid-entry',
          message: `workflows[] entry fails the v2 workflow-entry contract: ${gate.violations
            .map((violation) => violation.message)
            .join('; ')}`,
        },
      }
    }
    const entry = raw as { id: string; dir: string }
    if (seen.has(entry.id)) {
      return {
        error: {
          kind: 'error',
          code: 'workflow.selection.invalid-registry',
          message: `duplicate workflow id in status.json workflows[]: ${entry.id} — the registry must be keyed by unique active lifecycles`,
        },
      }
    }
    seen.add(entry.id)
    entries.push({ id: entry.id, dir: entry.dir })
  }
  return { entries }
}

/**
 * The selection tail over an already-normalized active set (D4 binding
 * order): the two automatic rungs → the session's durable
 * `selectedWorkflowId` → the only active entry. Explicit identity is
 * preserved at every rung — an id is either named by the session's own
 * evidence or the set is a single entry; a multi-active set with no binding
 * is `workflow.selection.unbound-multi-active` and NOTHING falls back to the
 * registry's first (or newest) entry.
 */
function selectActiveWorkflow(source: ActiveSetSource, hint?: SessionHint): ActiveWorkflowSelection {
  if (hint !== undefined) {
    const automatic = automaticBinding(source, hint)
    if (automatic !== undefined) return automatic
    const selected = hint.selectedWorkflowId
    if (selected !== undefined && selected !== '') {
      const picked = source.entries.find((entry) => entry.id === selected)
      if (picked !== undefined) return { kind: 'active', workflowId: picked.id, dir: picked.dir }
    }
  }
  if (source.entries.length === 1) {
    const only = source.entries[0] as ActiveEntry
    return { kind: 'active', workflowId: only.id, dir: only.dir }
  }
  return {
    kind: 'error',
    code: 'workflow.selection.unbound-multi-active',
    message: `${source.entries.length} active lifecycles in status.json workflows[] — this session has no lease, is not inside a workflow worktree and has no stored selection; pick one for this session (writes pause until then)`,
    activeWorkflowIds: source.entries.map((entry) => entry.id),
  }
}

/**
 * The file-route active set: the root v2 `status.json` registry plus each
 * entry's snapshot, or the document's own error view (missing / unreadable /
 * v1 / non-array registry). Each entry's snapshot is read at most once per
 * call, and only when the binding rule needs it.
 */
function fileActiveSet(harnessDir: string): { source: ActiveSetSource } | { error: ActiveWorkflowSelection } {
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) {
    return {
      error: {
        kind: 'error',
        code: 'status.missing',
        message: `no ${STATUS_FILE} at ${harnessDir} — the root v2 document is required`,
      },
    }
  }
  let doc: Record<string, unknown>
  try {
    // `readJson` casts arbitrary parsed JSON: a bare `null`/array/primitive
    // root has no `version`, so it is rejected as unreadable rather than
    // dereferenced (the resolver NEVER throws out of a ledger/dispatch
    // listener).
    const parsed = asRecord(readJson(statusPath))
    if (parsed === undefined) {
      return { error: { kind: 'error', code: 'status.unreadable', message: `cannot read ${statusPath}` } }
    }
    doc = parsed
  } catch {
    return { error: { kind: 'error', code: 'status.unreadable', message: `cannot read ${statusPath}` } }
  }
  if (doc.version !== 2) {
    return {
      error: {
        kind: 'error',
        code: 'status.migration-required',
        message: `status.json schema version 2 required — got ${JSON.stringify(doc.version)} (v1 or unknown version); run \`mstar migrate\` to convert the tree`,
      },
    }
  }
  const registry = doc.workflows
  if (!Array.isArray(registry)) {
    return {
      error: {
        kind: 'error',
        code: 'workflow.selection.invalid-registry',
        message: `status.json workflows[] is not an array: ${JSON.stringify(registry)} — the registry cannot be validated`,
      },
    }
  }
  const validated = activeEntriesOf(registry)
  if ('error' in validated) return { error: validated.error }
  const snapshots = new Map<string, Record<string, unknown> | undefined>()
  return {
    source: {
      entries: validated.entries,
      snapshotOf: (entry: ActiveEntry): Record<string, unknown> | undefined => {
        const cached = snapshots.get(entry.dir)
        if (cached !== undefined || snapshots.has(entry.dir)) return cached
        const snapshot = readSnapshot(harnessDir, entry)
        snapshots.set(entry.dir, snapshot)
        return snapshot
      },
    },
  }
}

/**
 * Resolve the ACTIVE lifecycle this session writes under (root v2
 * `status.json` `workflows[]` — the list holds non-terminal lifecycles
 * only, removal-at-terminal). This is the ONLY resolver the agent-flow
 * writer / ledger may use: no bound entry → a clear error, never a terminal
 * snapshot, never the root v1 file, and never the registry's first entry.
 *
 * This is the FILE route (primary spec §2.1): the root v2 document is the
 * pre-activation registry. While the harness's execution authority is ACTIVE
 * that registry is retired, so a source consumer asks the route first
 * ({@link readExecutionWorkflowSource}) instead of calling this resolver.
 *
 * EVERY registry entry is validated before N or the candidates are exposed
 * (see {@link activeEntriesOf}). Active-set definition: membership in
 * `workflows[]` — the engine lifecycle enum's non-terminal states are
 * `running` AND `paused`, so a PAUSED lifecycle stays in the active set (it
 * is still the operator's current lifecycle; only a TERMINAL lifecycle is
 * never a write target).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param hint - the carrying session's structural identity, when it has one
 *   (omitted ⇒ the automatic rungs and the durable pick miss; unique-active
 *   still works).
 */
export function resolveActiveWorkflow(harnessDir: string, hint?: SessionHint): ActiveWorkflowSelection {
  const read = fileActiveSet(harnessDir)
  return 'error' in read ? read.error : selectActiveWorkflow(read.source, hint)
}

/**
 * §5 the execution-authority source read of the active-set rule: the ONE
 * place a source consumer decides between the two authority routes.
 *
 * - `files` — the store predates migration 4, records `legacy`/`staged`, or no
 *   store file exists. The caller keeps its unchanged file readers
 *   ({@link resolveActiveWorkflow}); absence of a store is not an authority
 *   verdict (§2.1), so the pre-activation route is untouched.
 * - `active` — the execution authority is ACTIVE. The state comes from
 *   `readExecutionAuthority` in ONE read transaction and is normalized into
 *   the SAME active-set input the file route builds (registry rows, plan rows
 *   with their `execution_lease`, integration topology), so the binding order
 *   is shared and can never disagree between the routes. The retired
 *   `status.json` / snapshots are NOT read: the DB registry is the whole
 *   active set, its ids are addressed exactly (no newest/unique guess), and a
 *   `workflow.selection.unbound-multi-active` set stays an error.
 * - `unavailable` — the authority exists and cannot be read (corrupt, drifted,
 *   busy, below-floor runtime, missing `node:sqlite` capability). A refusal,
 *   never a fallback to the retired files (§5).
 *
 * The selected lifecycle's materialized state travels with the verdict, so a
 * caller never re-reads a document to find out what it selected.
 */
export type ExecutionWorkflowSourceRead =
  | { readonly kind: 'files' }
  | {
      readonly kind: 'active'
      readonly workflowId: string
      readonly dir: string
      readonly snapshot: Record<string, unknown>
    }
  | { readonly kind: 'error'; readonly selection: ActiveWorkflowSelection }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string }

/**
 * Stable code + message of a thrown store refusal (engine `StoreError` /
 * `StoreReadError` carry `code`; anything else is reported as itself).
 *
 * Exported for the sibling gate module: a caller that must convert a store
 * refusal into a GATE VIOLATION (the sync dispatch gate's authority check,
 * which cannot await the route read) reports the same stable code — one
 * extraction rule for the whole plugin, never a second sniffing copy.
 */
export function refusalOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  return { code: code === '' ? 'store.authority-unreadable' : code, message }
}

/** One DB plan view as the plan-row shape the binding rule and the gate
 * readers consume (`id`/`status`/`metadata` + the row's `execution_lease`).
 * The DB stores the lease beside the row, never inside it (§2.2), so the
 * adapter re-joins them here — the normalization §5 asks for. */
function planRowOf(view: ExecutionPlanView): Record<string, unknown> {
  return { ...(view.plan as Record<string, unknown>), execution_lease: view.executionLease }
}

/** One DB lifecycle's materialized state as the snapshot shape the file route
 * produces: the workflow header fields plus its plan rows. §2.2/§E keeps
 * `plans` and the merge lease OUT of the header (they are
 * `execution_plans` / `execution_integration_leases` rows), so BOTH are
 * re-joined here — the lease under the file route's own key and semantics
 * (PRESENT only while a merge is claimed; a released or never-claimed lease is
 * the file route's absent key), exactly as `workflowSnapshotOf` does for the
 * engine's own rules. A consumer that read the materialized snapshot without
 * it would treat a held merge reservation as unclaimed. */
function executionSnapshotOf(state: ExecutionState, workflowId: string): Record<string, unknown> | undefined {
  const workflow = state.workflows.find((candidate) => candidate.state.id === workflowId)
  if (workflow === undefined) return undefined
  return {
    ...(workflow.state as Record<string, unknown>),
    ...(workflow.integrationLease === null ? {} : { integration_merge_lease: workflow.integrationLease }),
    plans: workflow.plans.map(planRowOf),
  }
}

/**
 * §5 read the active-set source through the authoritative adapter.
 * @param context - the control harness `StoreContext` (its `harnessDir` is the
 *   one root the route is probed on — never a cwd-local or worktree store).
 * @param hint - the carrying session's structural identity + durable pick,
 *   forwarded verbatim to the shared binding rule.
 */
export async function readExecutionWorkflowSource(
  context: StoreContext,
  hint?: SessionHint,
): Promise<ExecutionWorkflowSourceRead> {
  let route: 'execution' | 'files'
  try {
    route = await resolveExecutionReadRoute(context)
  } catch (error) {
    return { kind: 'unavailable', ...refusalOf(error) }
  }
  if (route === 'files') return { kind: 'files' }

  let read: ExecutionRead<ExecutionState | ExecutionPlanView>
  try {
    read = await readExecutionAuthority(context)
  } catch (error) {
    return { kind: 'unavailable', ...refusalOf(error) }
  }
  // The no-selection arm answers with the whole state and the root token
  // (§5): the registry membership the active set is built from is the root's
  // own content.
  const state = read.data as ExecutionState
  if (!Array.isArray(state.root?.workflows) || !Array.isArray(state.workflows)) {
    return {
      kind: 'unavailable',
      code: 'coordination.invalid-input',
      message: 'the execution authority answered a scoped view for an unscoped selection — the active set cannot be read',
    }
  }
  const validated = activeEntriesOf(state.root.workflows)
  if ('error' in validated) return { kind: 'error', selection: validated.error }
  const source: ActiveSetSource = {
    entries: validated.entries,
    snapshotOf: (entry: ActiveEntry) => executionSnapshotOf(state, entry.id),
  }
  const selection = selectActiveWorkflow(source, hint)
  if (selection.kind !== 'active') return { kind: 'error', selection }
  const snapshot = source.snapshotOf({ id: selection.workflowId, dir: selection.dir })
  if (snapshot === undefined) {
    return {
      kind: 'error',
      selection: {
        kind: 'error',
        code: 'workflow.selection.snapshot-unreadable',
        message: `the execution authority registers ${selection.workflowId} but holds no state for it`,
      },
    }
  }
  return { kind: 'active', workflowId: selection.workflowId, dir: selection.dir, snapshot }
}

/** The plan rows of one materialized snapshot ([] when the doc has no plans
 * array) — the gate readers' own view of {@link ExecutionWorkflowSourceRead}. */
export function activeRowsOf(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(snapshot.plans)) return []
  return snapshot.plans
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== undefined)
}


/**
 * Resolve the workflow the catalog/panel READ path aggregates (compass
 * v3.0.0 § Catalog selection rule): the SAME binding order as the write
 * path, else the latest terminal snapshot by mtime (history view — only
 * when the active registry is EMPTY), else a clear error. Never reads the
 * root v1 `plans[]` / root `agent-flow.jsonl` as primary or as a quiet
 * fallback, and never substitutes history for an unbound active set.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param hint - forwarded verbatim to the active-set resolver.
 */
export function resolveReadWorkflow(harnessDir: string, hint?: SessionHint): WorkflowSelectionView {
  const active = resolveActiveWorkflow(harnessDir, hint)
  if (active.kind === 'active') return active
  // A non-`no-active` error (missing/v1 root, invalid entry, unbound
  // multi-active) is terminal for the read path too — only the
  // empty-active-set case falls through to the terminal-snapshot history
  // view.
  if (active.kind === 'error' && active.code !== 'workflow.selection.no-active') return active

  const workflowsDir = resolveWorkflowDir(harnessDir, { harnessDir })
  if (!existsSync(workflowsDir)) {
    return {
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: `no workflow snapshots under ${workflowsDir} — run \`mstar migrate\` or start a lifecycle`,
    }
  }
  let entries
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true })
  } catch {
    return {
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: `cannot read ${workflowsDir} — no workflow snapshot selected`,
    }
  }
  let best: { workflowId: string; dir: string; mtimeMs: number } | undefined
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const snapshotPath = join(workflowsDir, entry.name, WORKFLOW_SNAPSHOT_FILE)
    if (!existsSync(snapshotPath)) {
      // Deleted snapshot (or the whole workflow dir) — evict the stale
      // cache key (f12): this short-circuit never reaches `terminalStatusOf`,
      // so the dead entry would otherwise hold the cache cap forever while
      // the workflow stays invisible.
      terminalStatusCache.delete(snapshotPath)
      continue
    }
    // mtime-first fast path : stat + cache-hit reuse the
    // terminal verdict without parsing the snapshot JSON (the steady state
    // for terminal snapshots — the per-TTL reparse was pure waste).
    const verdict = terminalStatusOf(snapshotPath)
    if (verdict === undefined || !verdict.terminal) continue
    if (best === undefined || verdict.mtimeMs > best.mtimeMs) {
      best = { workflowId: entry.name, dir: join(relative(harnessDir, workflowsDir), entry.name), mtimeMs: verdict.mtimeMs }
    }
  }
  // The dir itself can be deleted (not just the snapshot) — the walk above
  // never sees a vanished dir, so prune any cached key whose parent dir is
  // gone (f12; cap semantics unchanged).
  for (const cachedPath of terminalStatusCache.keys()) {
    if (!existsSync(join(dirname(cachedPath), WORKFLOW_SNAPSHOT_FILE))) {
      terminalStatusCache.delete(cachedPath)
    }
  }
  if (best === undefined) {
    return {
      kind: 'error',
      code: 'workflow.selection.no-snapshot',
      message: `no terminal workflow snapshot under ${workflowsDir} — run \`mstar migrate\` or start a lifecycle`,
    }
  }
  return { kind: 'terminal', workflowId: best.workflowId, dir: best.dir }
}

/* ---------------------------------- catalog registration ---------------------------------- */

/** One catalog-registration refusal: the stable code + its actionable message. */
export interface CatalogRegistrationRefusal {
  readonly code: string
  readonly message: string
}

/**
 * The catalog-registration gate for a root-visible workflow (state-projection
 * contract §3 step 3; issue contract §7): a workflow whose registration
 * operation is still `prepared`/`execution-written` is HALF-registered — the
 * snapshot and the root `workflows[]` entry are visible while the catalog
 * journal has not published its delta — so it must not be dispatched against
 * until it is reconciled.
 *
 * Root workflow ROUTING stays JSON-owned: this guard never selects a
 * lifecycle, never reads a selection from the store, and never invents one;
 * the caller passes the workflow id its OWN JSON selection produced. What the
 * guard adds is the registration verdict, which lives only in the store's
 * journal, through the engine's own `assertCatalogExecutionCommitted` (the
 * single registration authority — no second journal reader here).
 *
 * Pre-activation exclusion (issue contract §7, engine `coordination.ts`
 * parity): a MISSING store (`store.not-initialized`) or a STAGED one
 * (`store.not-active`) is not a catalog verdict — the legacy authority is
 * still in force and the workflow is never retro-refused. Every other failure
 * (corrupt store, below-floor/missing-capability runtime, schema drift, a
 * conflict) is returned as a refusal rather than swallowed: a dispatch that
 * cannot prove the registration is never allowed to proceed on a guess.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param workflowId - the workflow the caller's JSON selection resolved.
 * @returns the refusal, or `null` when the registration is committed (or the
 *   store makes no catalog claim yet).
 */
export async function catalogRegistrationRefusal(
  harnessDir: string,
  workflowId: string,
): Promise<CatalogRegistrationRefusal | null> {
  const context: StoreContext = { harnessDir }
  try {
    await assertCatalogExecutionCommitted(context, workflowId)
    return null
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code
    if (code === 'store.not-initialized' || code === 'store.not-active') return null
    return {
      code: typeof code === 'string' && code !== '' ? code : 'catalog.registration-unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
