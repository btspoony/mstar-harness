/**
 * mstar_worktree_check — run the engine L1 / L2 pre-dispatch worktree
 * checklists (`l1PreDispatchCheck` / `l2PreDispatchCheck`).
 *
 * kind=l1 mirrors the status.json L1 fields (metadata.control_worktree_path
 * + plans[].execution_lease) as optional params — missing values are passed
 * as "" so the engine emits its structured violations instead of throwing.
 * kind=l2 takes the parallel writable `tracks` (absolute worktreePath +
 * Working branch per track); the zod shape guards the L2PreDispatchInput
 * contract at the parameter boundary. No local rule logic.
 */
import { l1PreDispatchCheck, l2PreDispatchCheck } from "@mstar-harness/engine";
import type { L1PreDispatchInput, ValidationResult, WorktreeTrack } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = {
  kind: "l1" | "l2";
  controlWorktreePath?: string;
  leaseWorktreePath?: string;
  leaseWorkingBranch?: string;
  planId?: string;
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

export default function mstarWorktreeCheck(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_worktree_check",
    label: "Check worktree dispatch readiness",
    description:
      "Run the engine pre-dispatch worktree checklists: kind=l1 verifies the cross-plan L1 gate (control worktree recorded, feature worktree exists, lease worktree != control, checked-out branch matches the lease working branch); kind=l2 verifies the within-plan L2 gate (each parallel writable track has a distinct absolute worktree path and matching checked-out branch). " +
      "Use before any writable dispatch, especially parallel multi-track dispatch. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        kind: pi.zod.enum(["l1", "l2"]),
        controlWorktreePath: pi.zod.string().optional(),
        leaseWorktreePath: pi.zod.string().optional(),
        leaseWorkingBranch: pi.zod.string().optional(),
        planId: pi.zod.string().optional(),
        tracks: pi.zod
          .array(pi.zod.object({ worktreePath: pi.zod.string(), workingBranch: pi.zod.string() }))
          .optional(),
      })
      .optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (params?.kind === "l2") {
          const gate = l2PreDispatchCheck({ tracks: params.tracks ?? [] });
          return result(
            gate.ok ? "l2 pre-dispatch check OK" : violationLines(gate.violations),
            { kind: "l2", ok: gate.ok, violations: gate.violations, track_count: (params.tracks ?? []).length },
            !gate.ok,
          );
        }
        const input: L1PreDispatchInput = {
          controlWorktreePath: params?.controlWorktreePath ?? "",
          leaseWorktreePath: params?.leaseWorktreePath ?? "",
          leaseWorkingBranch: params?.leaseWorkingBranch ?? "",
          planId: params?.planId ?? "",
        };
        const gate = l1PreDispatchCheck(input);
        return result(
          gate.ok
            ? `l1 pre-dispatch check OK${input.planId ? ` (plan "${input.planId}")` : ""}`
            : violationLines(gate.violations),
          { kind: "l1", plan_id: input.planId || null, ok: gate.ok, violations: gate.violations, input },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_worktree_check failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
