/**
 * mstar_worktree_check — run the engine L1 / L2 pre-dispatch worktree
 * checklists (`l1PreDispatchCheck` / `l2PreDispatchCheck`).
 *
 * kind=l1 in v3 reads its inputs from the workflow snapshot
 * (`{HARNESS_DIR}/workflows/<workflowId>/snapshot.json`, resolved from the
 * session cwd): the plan row's `execution_lease` (worktree_path +
 * working_branch) and the snapshot-level `control_worktree_path` (the
 * v1 root-`metadata` source is gone) — `controlWorktreePath` may still be
 * passed as an explicit override. Missing values are passed as "" so the
 * engine emits its structured violations instead of throwing.
 * kind=l2 takes the parallel writable `tracks` (absolute worktreePath +
 * Working branch per track); the zod shape guards the L2PreDispatchInput
 * contract at the parameter boundary. No local rule logic.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  readJson,
  resolveHarnessDir,
  WORKFLOW_SNAPSHOT_FILE,
} from "@mstar-harness/engine";
import type { L1PreDispatchInput, ValidationResult, WorktreeTrack } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = {
  kind: "l1" | "l2";
  workflowId?: string;
  planId?: string;
  controlWorktreePath?: string;
  tracks?: WorktreeTrack[];
};

function violationLines(violations: readonly ValidationResult[]): string {
  return violations
    .map((v) => `[${v.severity}] ${v.code}: ${v.message}${v.fix ? ` (fix: ${v.fix})` : ""}`)
    .join("\n");
}

function result(text: string, details: unknown, isError: boolean): AgentToolResult {
  const out: AgentToolResult = { content: [{ type: "text", text }], details };
  if (isError) out.isError = true;
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function mstarWorktreeCheck(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_worktree_check",
    label: "Check worktree dispatch readiness",
    description:
      "Run the engine pre-dispatch worktree checklists: kind=l1 verifies the cross-plan L1 gate from the workflow snapshot (control worktree path from snapshot control_worktree_path, feature worktree from the plan row execution_lease, lease worktree != control, checked-out branch matches the lease working branch); kind=l2 verifies the within-plan L2 gate (each parallel writable track has a distinct absolute worktree path and matching checked-out branch). " +
      "Use before any writable dispatch, especially parallel multi-track dispatch. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        kind: pi.zod.enum(["l1", "l2"]),
        workflowId: pi.zod.string().optional(),
        planId: pi.zod.string().optional(),
        controlWorktreePath: pi.zod.string().optional(),
        tracks: pi.zod
          .array(pi.zod.object({ worktreePath: pi.zod.string(), workingBranch: pi.zod.string() }))
          .optional(),
      }),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (params?.kind !== "l1" && params?.kind !== "l2") {
          return result("mstar_worktree_check: kind required (l1|l2)", { ok: false }, true);
        }
        if (params.kind === "l2") {
          const gate = l2PreDispatchCheck({ tracks: params.tracks ?? [] });
          return result(
            gate.ok ? "l2 pre-dispatch check OK" : violationLines(gate.violations),
            { kind: "l2", ok: gate.ok, violations: gate.violations, track_count: (params.tracks ?? []).length },
            !gate.ok,
          );
        }
        if (!params?.workflowId) {
          return result("mstar_worktree_check: kind=l1 requires workflowId (the snapshot supplies the L1 inputs)", { ok: false }, true);
        }
        const harnessDir = resolveHarnessDir(pi.cwd);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        const snapshotPath = join(harnessDir, "workflows", params.workflowId, WORKFLOW_SNAPSHOT_FILE);
        if (!existsSync(snapshotPath)) {
          return result(`workflow snapshot not found: ${snapshotPath}`, { workflow_id: params.workflowId, snapshot_path: snapshotPath }, true);
        }
        const doc = readJson(snapshotPath);
        const rows = Array.isArray(doc.plans) ? (doc.plans as unknown[]) : [];
        let row: Record<string, unknown> | undefined;
        if (params?.planId !== undefined) {
          row = rows.find(
            (r): r is Record<string, unknown> =>
              isPlainObject(r) && (r.plan_id === params.planId || r.id === params.planId),
          );
        } else if (rows.length === 1 && isPlainObject(rows[0])) {
          row = rows[0];
        }
        if (row === undefined) {
          const planLabel = params?.planId ?? "(sole row)";
          return result(
            `plan "${planLabel}" not found in ${snapshotPath}`,
            { kind: "l1", workflow_id: params.workflowId, plan_id: params?.planId ?? null, snapshot_path: snapshotPath },
            true,
          );
        }
        const lease = isPlainObject(row.execution_lease) ? row.execution_lease : {};
        const planId = String(row.plan_id ?? row.id ?? params?.planId ?? "");
        const input: L1PreDispatchInput = {
          controlWorktreePath: params?.controlWorktreePath ?? String(doc.control_worktree_path ?? ""),
          leaseWorktreePath: String(lease.worktree_path ?? ""),
          leaseWorkingBranch: String(lease.working_branch ?? ""),
          planId,
        };
        const gate = l1PreDispatchCheck(input);
        return result(
          gate.ok
            ? `l1 pre-dispatch check OK (plan "${planId}", workflow "${params.workflowId}")`
            : violationLines(gate.violations),
          { kind: "l1", workflow_id: params.workflowId, plan_id: planId, ok: gate.ok, violations: gate.violations, input },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_worktree_check failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
