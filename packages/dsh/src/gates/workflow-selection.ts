/**
 * Shared workflow selection resolvers (compass v3.0.0 § Catalog selection
 * rule).
 *
 * READ path (catalog/panel): active `workflows[]` first → latest terminal
 * snapshot by mtime → clear error. WRITE path (agent-flow writer / ledger):
 * active-set only — the terminal-mtime fallback is catalog-read-only and
 * MUST NOT be imported by the writer. Both resolvers live in ONE module so
 * the selection rule cannot drift between the two consumers; the write side
 * imports only `resolveActiveWorkflow`.
 *
 * Module boundary: no barrel — consumers import by explicit relative path.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  readJson,
  resolveWorkflowDir,
  WORKFLOW_SNAPSHOT_FILE,
  WORKFLOW_TERMINAL_STATUSES,
} from '@mstar-harness/engine'
import type { WorkflowSelectionView } from '../types.ts'
import { STATUS_FILE, asRecord } from './_shared.ts'

/** The active-set resolver result: the first active lifecycle or a clear error. */
export type ActiveWorkflowSelection = WorkflowSelectionView

/**
 * Resolve the ACTIVE lifecycle set (root v2 `status.json` `workflows[]` —
 * the list holds non-terminal lifecycles only, removal-at-terminal). This
 * is the ONLY resolver the agent-flow writer / ledger may use: no active
 * entry → a clear error, never a terminal snapshot and never the root v1
 * file.
 *
 * Active-set definition (explicit decision, plan `20260819-workflow-dsh-viz`
 * Task 2): membership in `workflows[]` — the engine lifecycle enum's
 * non-terminal states are `running` AND `paused` (terminal lifecycles are
 * removed from the list at terminal). A PAUSED lifecycle therefore stays in
 * the active set and the agent-flow writer / ledger append to its workflow
 * dir (a paused lifecycle is still the operator's current lifecycle — its
 * ledger must keep recording; only a TERMINAL lifecycle is never a write
 * target).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
export function resolveActiveWorkflow(harnessDir: string): ActiveWorkflowSelection {
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
  if (!Array.isArray(doc.workflows) || doc.workflows.length === 0) {
    return {
      kind: 'error',
      code: 'workflow.selection.no-active',
      message: 'no active lifecycle in status.json workflows[] — the agent-flow writer appends only to an active lifecycle',
    }
  }
  const first = doc.workflows[0]
  const entry = asRecord(first)
  const workflowId = typeof entry?.id === 'string' ? entry.id : undefined
  const dir = typeof entry?.dir === 'string' ? entry.dir : undefined
  if (workflowId === undefined || dir === undefined) {
    return {
      kind: 'error',
      code: 'workflow.selection.invalid-entry',
      message: `workflows[] first entry is missing id/dir: ${JSON.stringify(first)}`,
    }
  }
  if (doc.workflows.length > 1) {
    return {
      kind: 'active',
      workflowId,
      dir,
      warning: {
        code: 'workflow.selection.multi-active',
        message: `${doc.workflows.length} active lifecycles in status.json workflows[] — selected the first (${workflowId}); no silent pick`,
      },
    }
  }
  return { kind: 'active', workflowId, dir }
}

/**
 * Resolve the workflow the catalog/panel READ path aggregates (compass
 * v3.0.0 § Catalog selection rule): active `workflows[]` first (multiple
 * active → first + a structured warning), else the latest terminal
 * snapshot by mtime (history view), else a clear error. Never reads the
 * root v1 `plans[]` / root `agent-flow.jsonl` as primary or as a quiet
 * fallback.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
export function resolveReadWorkflow(harnessDir: string): WorkflowSelectionView {
  const active = resolveActiveWorkflow(harnessDir)
  if (active.kind === 'active') return active
  // A non-`no-active` error (missing/v1 root, invalid entry) is terminal
  // for the read path too — only the empty-active-set case falls through to
  // the terminal-snapshot history view.
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
    if (!existsSync(snapshotPath)) continue
    let snapshot: Record<string, unknown>
    try {
      snapshot = readJson(snapshotPath)
    } catch {
      continue // unreadable snapshot — skip (advisory)
    }
    const status = snapshot.status
    if (typeof status !== 'string' || !(WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status)) continue
    let mtimeMs: number
    try {
      mtimeMs = statSync(snapshotPath).mtimeMs
    } catch {
      continue
    }
    if (best === undefined || mtimeMs > best.mtimeMs) {
      best = { workflowId: entry.name, dir: join(relative(harnessDir, workflowsDir), entry.name), mtimeMs }
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
