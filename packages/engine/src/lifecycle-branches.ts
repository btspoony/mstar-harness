/** Shared active lifecycle ownership and fail-closed host register scan. */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { readJson, type ValidationResult } from "./core.js";
import { assertSafePathComponent, resolveWorkflowDir } from "./path.js";
import { readWorkflowSnapshot, WORKFLOW_SNAPSHOT_FILE, type WorkflowSnapshot } from "./workflow.js";
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Collect ownership, including retained L2 tracks; base/target are not ownership. */
export function collectActiveLifecycleBranches(snapshots: readonly Record<string, unknown>[]): string[] {
  const owned = new Set<string>();
  for (const doc of snapshots) {
    const branch = doc.branch;
    if (isPlainObject(branch) && typeof branch.integration === "string" && branch.integration.trim() !== "") {
      owned.add(branch.integration);
    }
    if (!Array.isArray(doc.plans)) continue;
    for (const row of doc.plans) {
      if (!isPlainObject(row)) continue;
      const lease = row.execution_lease;
      if (isPlainObject(lease) && typeof lease.working_branch === "string" && lease.working_branch.trim() !== "") {
        owned.add(lease.working_branch);
      }
      const meta = row.metadata;
      if (isPlainObject(meta) && Array.isArray(meta.track_branches)) {
        for (const branch of meta.track_branches) {
          if (typeof branch === "string" && branch.trim() !== "") owned.add(branch);
        }
      }
      if (isPlainObject(meta) && typeof meta.working_branch === "string" && meta.working_branch.trim() !== "") {
        owned.add(meta.working_branch);
      }
    }
  }
  return [...owned];
}

export type ActiveLifecycleScan =
  | { kind: "ok"; branches: string[]; notes: ValidationResult[] }
  | { kind: "refusal"; code: string; detail: string };

/** Read all other registered active snapshots through the canonical reader.
 * Missing register means no siblings; malformed register or unreadable sibling
 * refuses. Governing snapshot is supplied by the caller, never read twice.
 */
export function scanActiveLifecycleBranches(harnessDir: string, governingWorkflowId: string | null): ActiveLifecycleScan {
  const registerPath = join(harnessDir, "status.json");
  if (!existsSync(registerPath)) return { kind: "ok", branches: [], notes: [] };
  let register: Record<string, unknown>;
  try {
    register = readJson(registerPath);
  } catch (error) {
    return { kind: "refusal", code: "worktree.l1.lifecycle-register-unreadable", detail: `${registerPath}: ${(error as Error).message}` };
  }
  if (!isPlainObject(register) || register.version !== 2 || !Array.isArray(register.workflows)) {
    return {
      kind: "refusal",
      code: "worktree.l1.lifecycle-register-unreadable",
      detail: `${registerPath}: not a readable v2 root register (version 2 + workflows[]) — the active lifecycle set cannot be enumerated`,
    };
  }
  let workflowsDir: string;
  try {
    workflowsDir = resolveWorkflowDir(harnessDir, { harnessDir });
  } catch (error) {
    return { kind: "refusal", code: "worktree.l1.lifecycle-register-unreadable", detail: `${registerPath}: ${(error as Error).message}` };
  }
  const owned = new Set<string>();
  const notes: ValidationResult[] = [];
  for (const entry of register.workflows as unknown[]) {
    if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>).id !== "string") {
      return {
        kind: "refusal",
        code: "worktree.l1.lifecycle-register-unreadable",
        detail: `${registerPath}: malformed workflows[] entry — a registered active lifecycle cannot be identified`,
      };
    }
    const id = (entry as Record<string, unknown>).id as string;
    try {
      assertSafePathComponent(id, "workflow id");
    } catch (error) {
      return { kind: "refusal", code: "worktree.l1.lifecycle-register-unreadable", detail: `${registerPath}: ${(error as Error).message}` };
    }
    if (id === governingWorkflowId) continue; // governing snapshot read at the call site — dedupe
    const snapshotPath = join(workflowsDir, id, WORKFLOW_SNAPSHOT_FILE);
    let snapshot: WorkflowSnapshot;
    try {
      const read = readWorkflowSnapshot(dirname(snapshotPath));
      snapshot = read.snapshot;
      notes.push(...read.diagnostics);
    } catch (error) {
      return {
        kind: "refusal",
        code: "worktree.l1.lifecycle-snapshot-unreadable",
        detail: `${snapshotPath}: ${(error as Error).message}`,
      };
    }
    for (const branch of collectActiveLifecycleBranches([snapshot])) owned.add(branch);
  }
  return { kind: "ok", branches: [...owned], notes };
}
