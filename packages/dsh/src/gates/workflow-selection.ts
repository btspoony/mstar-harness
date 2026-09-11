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
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import {
  readJson,
  resolveWorkflowDir,
  validateExecutionLease,
  validateWorkflowEntry,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
} from '@mstar-harness/engine'
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
    const snapshot = readJson(snapshotPath)
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
    return asRecord(readJson(snapshotPath))
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
 * `control_worktree_path`. Each entry's snapshot is read at most once per
 * call, and only when a hint field could actually use it.
 */
function automaticBinding(
  harnessDir: string,
  entries: readonly ActiveEntry[],
  hint: SessionHint,
): ActiveWorkflowSelection | undefined {
  const cwd = hint.cwd === '' ? undefined : hint.cwd
  const holder = hint.leaseHolder === '' ? undefined : hint.leaseHolder
  if (cwd === undefined && holder === undefined) return undefined
  const snapshots = new Map<string, Record<string, unknown> | undefined>()
  const snapshotOf = (entry: ActiveEntry): Record<string, unknown> | undefined => {
    const cached = snapshots.get(entry.dir)
    if (cached !== undefined || snapshots.has(entry.dir)) return cached
    const snapshot = readSnapshot(harnessDir, entry)
    snapshots.set(entry.dir, snapshot)
    return snapshot
  }
  const leaseMatches = new Map<string, ActiveEntry>()
  const cwdMatches = new Map<string, ActiveEntry>()
  for (const entry of entries) {
    const snapshot = snapshotOf(entry)
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
    const controlWorktree = snapshot.control_worktree_path
    if (cwd !== undefined && typeof controlWorktree === 'string' && within(controlWorktree, cwd)) {
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
 * Resolve the ACTIVE lifecycle this session writes under (root v2
 * `status.json` `workflows[]` — the list holds non-terminal lifecycles
 * only, removal-at-terminal). This is the ONLY resolver the agent-flow
 * writer / ledger may use: no bound entry → a clear error, never a terminal
 * snapshot, never the root v1 file, and never the registry's first entry.
 *
 * EVERY registry entry is validated before N or the candidates are exposed:
 * the engine `validateWorkflowEntry` contract (`id`/`type`/`started_at` and a
 * harness-relative `dir` with no absolute path or `..` segment) plus
 * duplicate-id rejection. A bad row is an error, not a smaller active set —
 * and never a path the resolver would read outside the harness. Only a real
 * empty array is `workflow.selection.no-active`. Active-set definition:
 * membership in `workflows[]` — the engine lifecycle enum's non-terminal
 * states are `running` AND `paused`, so a PAUSED lifecycle stays in the
 * active set (it is still the operator's current lifecycle; only a TERMINAL
 * lifecycle is never a write target).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 * @param hint - the carrying session's structural identity, when it has one
 *   (omitted ⇒ the automatic rungs and the durable pick miss; unique-active
 *   still works).
 */
export function resolveActiveWorkflow(harnessDir: string, hint?: SessionHint): ActiveWorkflowSelection {
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) {
    return {
      kind: 'error',
      code: 'status.missing',
      message: `no ${STATUS_FILE} at ${harnessDir} — the root v2 document is required`,
    }
  }
  let doc: Record<string, unknown>
  try {
    doc = readJson(statusPath)
  } catch {
    return { kind: 'error', code: 'status.unreadable', message: `cannot read ${statusPath}` }
  }
  if (doc.version !== 2) {
    return {
      kind: 'error',
      code: 'status.migration-required',
      message: `status.json schema version 2 required — got ${JSON.stringify(doc.version)} (v1 or unknown version); run \`mstar migrate\` to convert the tree`,
    }
  }
  const registry = doc.workflows
  if (!Array.isArray(registry)) {
    return {
      kind: 'error',
      code: 'workflow.selection.invalid-registry',
      message: `status.json workflows[] is not an array: ${JSON.stringify(registry)} — the registry cannot be validated`,
    }
  }
  if (registry.length === 0) {
    return {
      kind: 'error',
      code: 'workflow.selection.no-active',
      message: 'no active lifecycle in status.json workflows[] — the agent-flow writer appends only to an active lifecycle',
    }
  }
  const entries: ActiveEntry[] = []
  const seen = new Set<string>()
  for (const raw of registry) {
    // Engine contract for one `workflows[]` row: `id`/`type`/`started_at`,
    // and a harness-relative `dir` with no absolute path or `..` segment
    // (so `readSnapshot` can never be pointed outside the harness). Every
    // entry is validated before N or the candidates are exposed.
    const gate = validateWorkflowEntry(raw)
    if (!gate.ok) {
      return {
        kind: 'error',
        code: 'workflow.selection.invalid-entry',
        message: `workflows[] entry fails the v2 workflow-entry contract: ${gate.violations
          .map((violation) => violation.message)
          .join('; ')}`,
      }
    }
    const entry = raw as { id: string; dir: string }
    if (seen.has(entry.id)) {
      return {
        kind: 'error',
        code: 'workflow.selection.invalid-registry',
        message: `duplicate workflow id in status.json workflows[]: ${entry.id} — the registry must be keyed by unique active lifecycles`,
      }
    }
    seen.add(entry.id)
    entries.push({ id: entry.id, dir: entry.dir })
  }
  if (hint !== undefined) {
    const automatic = automaticBinding(harnessDir, entries, hint)
    if (automatic !== undefined) return automatic
    const selected = hint.selectedWorkflowId
    if (selected !== undefined && selected !== '') {
      const picked = entries.find((entry) => entry.id === selected)
      if (picked !== undefined) return { kind: 'active', workflowId: picked.id, dir: picked.dir }
    }
  }
  if (entries.length === 1) {
    const only = entries[0] as ActiveEntry
    return { kind: 'active', workflowId: only.id, dir: only.dir }
  }
  return {
    kind: 'error',
    code: 'workflow.selection.unbound-multi-active',
    message: `${entries.length} active lifecycles in status.json workflows[] — this session has no lease, is not inside a workflow worktree and has no stored selection; pick one for this session (writes pause until then)`,
    activeWorkflowIds: entries.map((entry) => entry.id),
  }
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
