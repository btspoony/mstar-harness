/**
 * The dispatch WORKTREE isolation checks (engine `l1PreDispatchCheck` /
 * `l2PreDispatchCheck` input assembly): L2 within-plan track isolation and L1
 * cross-plan isolation, both keyed on the Assignment header region.
 *
 * Module boundary: one responsibility — assemble the engine's worktree inputs
 * from the Assignment header plus the ACTIVE workflow snapshot and return its
 * violations. It never decides allow/deny, never logs and never hardens: the
 * shared dispatch core folds these violations into ONE verdict.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import {
  collectActiveLifecycleBranches,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  parseAssignmentFieldsFromFrontmatter,
  probeCheckoutRoot,
  readActiveLifecycleBranchDocs,
  readMainWorktree,
} from '@mstar-harness/engine'
import type { FrontmatterEntry, ValidationResult, WorkflowSnapshot, WorktreeTrack } from '@mstar-harness/engine'
import { asRecord } from './_shared.ts'
import { activeRowsOf, readExecutionWorkflowSource, refusalOf } from './workflow-selection.ts'
import type { ExecutionWorkflowSourceRead, SessionHint } from './workflow-selection.ts'
import { assignmentEntriesValue } from './dispatch-assignment.ts'

/**
 * One worktree-gate violation line (dsh-side codes live in the
 * `worktree.l2.*` namespace beside the engine's `worktree.l1.*` /
 * `worktree.l2.*` emit).
 */
function worktreeViolation(code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity: 'high', code, message, fix }
}

/**
 * L2 within-plan track isolation (engine `l2PreDispatchCheck`):
 * when the Assignment declares parallel tracks — a `worktree_path` LIST of
 * ≥2 entries, the shared schema's own parallel shape — every declared track
 * must carry an absolute, distinct worktree path whose checkout branch
 * matches its Working branch, BEFORE the first concurrent writable dispatch
 * (N parallel invokes ≠ isolation).
 *
 * Track pairing follows the Assignment grammar: one `working_branch` entry
 * per `worktree_path`, OR a single `working_branch` value applying to every
 * track (the same-branch multi-dir topology, mstar-branch-worktree
 * 同分支多目录例外 — git forbids one branch in two linked worktrees, so the
 * second checkout is a clone). Any other count mismatch is a violation.
 *
 * Pure over the parsed fields + the filesystem; the engine probes
 * `git -C <path> branch --show-current` per valid track (bounded, fails
 * closed). compass D14 — the caller passes the parse it already made of the
 * RESOLVED assignment document (`assignmentFrontmatterEntries`), so a pointer
 * and the inline form answer the same track questions and no leg reparses the
 * document.
 * @param entries - the decision's ONE front-matter parse (`null` = unparseable).
 */
export function worktreeL2Violations(entries: Map<string, FrontmatterEntry> | null): ValidationResult[] {
  // The parallel-track declaration is the SHARED schema's own shape: a
  // `worktree_path` / `working_branch` string list (or a scalar, the serial
  // norm). Read from the parsed fields — the one projection the field gate,
  // the branch gate and this check share — never a second decode of the
  // entries, so no shape this check accepts can be one the schema rejects.
  // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
  const fields = parseAssignmentFieldsFromFrontmatter(entries)
  const worktreePaths = fields.worktreePaths ?? (fields.worktreePath?.trim() ? [fields.worktreePath] : [])
  const workingBranches = fields.workingBranches ?? (fields.workingBranch?.trim() ? [fields.workingBranch] : [])
  // ≥2 declared tracks is the parallel declaration; a single Worktree path is
  // the serial norm and never triggers the L2 checklist (no track list to
  // verify against).
  // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
  if (worktreePaths.length < 2) return []

  const violations: ValidationResult[] = []
  const tracks: WorktreeTrack[] = []
  if (worktreePaths.length === 0 || workingBranches.length === worktreePaths.length) {
    for (let i = 0; i < worktreePaths.length; i += 1) {
      tracks.push({ worktreePath: worktreePaths[i]!, workingBranch: workingBranches[i] ?? '' })
    }
  } else if (workingBranches.length === 1) {
    // One Working branch line applies to every track (同分支多目录例外).
    for (const path of worktreePaths) tracks.push({ worktreePath: path, workingBranch: workingBranches[0]! })
  } else {
    violations.push(worktreeViolation(
      'worktree.l2.track-count-mismatch',
      `parallel-track declaration pairs ${worktreePaths.length} Worktree path entr${worktreePaths.length === 1 ? 'y' : 'ies'} with ${workingBranches.length} Working branch entries — every track needs its own absolute Worktree path AND Working branch (or one shared branch for all tracks)`,
      'align the track counts in the Assignment header (one Worktree path + Working branch per track, or a single Working branch for all tracks)',
    ))
    const n = Math.min(worktreePaths.length, workingBranches.length)
    for (let i = 0; i < n; i += 1) {
      tracks.push({ worktreePath: worktreePaths[i]!, workingBranch: workingBranches[i]! })
    }
  }
  const isolation = l2PreDispatchCheck({ tracks })
  violations.push(...isolation.violations)
  if (!isolation.ok) return violations
  const checkoutRoots = new Set<string>()
  for (const track of tracks) {
    const root = probeCheckoutRoot(track.worktreePath)
    if (root === null) {
      violations.push(worktreeViolation(
        'worktree.l2.checkout-unresolved',
        `cannot establish the Git checkout root of "${track.worktreePath}" before writable dispatch`,
        'use an existing Git worktree checkout on its declared Working branch and retry dispatch',
      ))
    } else if (checkoutRoots.has(root)) {
      violations.push(worktreeViolation(
        'worktree.l2.checkout-collision',
        `parallel writable track "${track.worktreePath}" shares Git checkout "${root}" with another track; subdirectories and symlink aliases are not independent worktrees`,
        'create a separate Git worktree for each writable track and update its Worktree path before retrying dispatch',
      ))
    } else {
      checkoutRoots.add(root)
    }
  }
  return violations
}

/**
 * The selected ACTIVE workflow graph for synchronous dispatch consumers.
 * `readExecutionWorkflowSource` materializes its plan rows and integration
 * topology from the execution store; coordination files are never read here.
 * `unreadable` distinguishes an unavailable/ambiguous authority from an
 * ordinary workspace with no active workflow so each gate preserves its
 * established refusal or no-op behavior.
 */
interface ActiveSnapshotRead {
  /** The snapshot's plan rows ([] when the doc has no plans array); null when the read did not reach the rows. */
  rows: Record<string, unknown>[] | null
  /** The canonical snapshot (non-null exactly when `rows` is non-null). */
  snapshot: WorkflowSnapshot | null
  /** The selected workflow id (register key — the sibling scan skips it). */
  workflowId: string | null
  /** True when the lifecycle cannot be attributed (selection failure / unreadable / refused snapshot). */
  unreadable: boolean
}

async function activeSnapshotRows(harnessDir: string, hint?: SessionHint, activeSource?: ExecutionWorkflowSourceRead): Promise<ActiveSnapshotRead> {
  try {
    const source = activeSource ?? await readExecutionWorkflowSource({ harnessDir }, hint)
    if (source.kind === 'error' && source.selection.kind === 'error' && source.selection.code === 'workflow.selection.no-active') {
      return { rows: null, snapshot: null, workflowId: null, unreadable: false }
    }
    if (source.kind !== 'active') return { rows: null, snapshot: null, workflowId: null, unreadable: true }
    const snapshot = source.snapshot as WorkflowSnapshot
    return { rows: activeRowsOf(snapshot), snapshot, workflowId: source.workflowId, unreadable: false }
  } catch {
    return { rows: null, snapshot: null, workflowId: null, unreadable: true }
  }
}

/**
 * L1 cross-plan isolation (engine `l1PreDispatchCheck` FULL input): when
 * the Assignment resolves a plan id AND the ACTIVE workflow snapshot
 * records a plan row scope (metadata.worktree_path + metadata.working_branch), the
 * gate assembles the full three-domain topology — the Git-derived main
 * worktree (`readMainWorktree` from the harness root: the main worktree of
 * the repo containing `{HARNESS_DIR}`; null is a failure row, never a
 * skip), the recorded residency expectation (the Assignment header's
 * `Main worktree branch` — the recorded value only, never the observed
 * branch — with the explicit `branch.base` fallback), the snapshot's
 * canonical integration topology (`integration_worktree_path` +
 * `branch.integration`), and the lifecycle-owned branches collected from
 * all active workflow snapshots (the governing one plus every sibling in
 * the v2 register — a scan refusal is a high violation, CLI parity, never
 * a silent skip).
 *
 * Fires ONLY when the row scope metadata is present (the "L1 checks when
 * metadata present" contract): no harness dir, unresolvable plan id,
 * missing/unattributable snapshot (selection failure, unreadable), or a
 * lease without the two path/branch fields all degrade to silence — the
 * exec-bound lease gate owns lease SHAPE errors (sdd
 * unverifiable/unreadable/plan-not-found) on the same verdict. Standalone
 * plans without integration fields run the main-vs-feature rows only (the
 * engine owns that distinction). The engine probes are subprocess-based
 * and fail closed.
 * @param harnessDir - the plugin's resolved `{HARNESS_DIR}` (null when none).
 * @param entries - the decision's ONE front matter parse (the caller already
 *   made it for plan selection; this check never parses the document again).
 * @param planId - the plan id that same parse resolved (undefined = no plan
 *   row to compare against).
 * @param hint - the carrying session's selection hint (which lifecycle's
 *   snapshot carries the L1 metadata to compare against).
 */
export async function worktreeL1Violations(
  harnessDir: string | null,
  entries: Map<string, FrontmatterEntry> | null,
  planId: string | undefined,
  hint?: SessionHint,
  activeSource?: ExecutionWorkflowSourceRead,
): Promise<ValidationResult[]> {
  if (harnessDir === null) return []
  if (planId === undefined || planId === '') return []
  const read = await activeSnapshotRows(harnessDir, hint, activeSource)
  if (read.rows === null || read.snapshot === null) return []
  const row = read.rows.find((r) => r?.id === planId || r?.plan_id === planId)
  const metadata = asRecord(row?.metadata)
  const rowWorktreePath = typeof metadata?.worktree_path === 'string' ? metadata.worktree_path : undefined
  const rowWorkingBranch = typeof metadata?.working_branch === 'string' ? metadata.working_branch : undefined
  if (!rowWorktreePath || !rowWorkingBranch) return []
  const snapshot = read.snapshot
  try {
    const lifecycleBranches = collectActiveLifecycleBranches(await readActiveLifecycleBranchDocs({ harnessDir }))
    const expectedMainBranch = assignmentEntriesValue(entries, 'Main worktree branch')
      ?? (typeof snapshot.branch?.base === 'string' ? snapshot.branch.base : '')
    return l1PreDispatchCheck({
      workflowType: snapshot.type,
      integrationWorktreePath: typeof snapshot.integration_worktree_path === 'string' ? snapshot.integration_worktree_path : '',
      integrationBranch: typeof snapshot.branch?.integration === 'string' ? snapshot.branch.integration : '',
      mainWorktree: readMainWorktree(harnessDir),
      expectedMainBranch,
      lifecycleBranches,
      rowWorktreePath,
      rowWorkingBranch,
      planId,
      workflowId: snapshot.id,
    }).violations
  } catch (error) {
    const refusal = refusalOf(error)
    return [worktreeViolation(refusal.code, refusal.message, 'restore the ACTIVE store authority before writable dispatch')]
  }
}
