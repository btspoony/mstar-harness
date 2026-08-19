/**
 * mstar_status_validate — validate a Morning Star harness v2 status.json
 * root or a workflow snapshot (`workflows/<id>/snapshot.json`) via the
 * engine's `validateStatus` / `validateWorkflowSnapshot` gates.
 *
 * Defaults to `{harness}/status.json` resolved from the session cwd
 * (`resolveHarnessDir(pi.cwd)`); pass `path` to target another file —
 * a `snapshot.json` basename selects the snapshot validator
 * (resolved against `pi.cwd`). No local rule logic — the engine is the
 * single validator; this module only locates the file and formats output.
 */
import { basename, join, resolve } from "node:path";
import {
  readJson,
  resolveHarnessDir,
  validateStatus,
  validateWorkflowSnapshot,
  WORKFLOW_SNAPSHOT_FILE,
} from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { path?: string };

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

export default function mstarStatusValidate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_status_validate",
    label: "Validate harness status.json / workflow snapshot",
    description:
      "Validate a Morning Star harness v2 status document: the root status.json (version 2 + workflows[] with per-entry snapshot invariants) via the engine validateStatus gate, or a workflow snapshot (schema_version 1 + plan rows + lease shapes) via validateWorkflowSnapshot when `path` basename is snapshot.json. " +
      "Defaults to {harness}/status.json discovered from the session cwd; pass `path` to check another file. " +
      "Use after editing status.json / workflows/<id>/snapshot.json, before writable dispatch, or when workflow/plan state edits are reviewed. " +
      "Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod.object({ path: pi.zod.string().optional() }).optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        let statusPath: string;
        if (params?.path) {
          statusPath = resolve(pi.cwd, params.path);
        } else {
          const harnessDir = resolveHarnessDir(pi.cwd);
          if (harnessDir === null) {
            return result(
              `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up) — pass an explicit path`,
              { cwd: pi.cwd },
              true,
            );
          }
          statusPath = join(harnessDir, "status.json");
        }
        const isSnapshot = basename(statusPath) === WORKFLOW_SNAPSHOT_FILE;
        const gate = isSnapshot ? validateWorkflowSnapshot(readJson(statusPath)) : validateStatus(statusPath);
        // Row/workflow counts only when the gate passed: the validators
        // already proved the file parses, so the re-read cannot throw.
        let planCount: number | null = null;
        let workflowCount: number | null = null;
        if (gate.ok) {
          const doc = readJson(statusPath) as { plans?: unknown; workflows?: unknown };
          if (isSnapshot) {
            planCount = Array.isArray(doc.plans) ? doc.plans.length : 0;
          } else {
            workflowCount = Array.isArray(doc.workflows) ? doc.workflows.length : 0;
          }
        }
        const label = isSnapshot ? "snapshot" : "status.json";
        return result(
          gate.ok
            ? `${label} valid${planCount !== null ? ` (${planCount} plans)` : ""}${workflowCount !== null ? ` (${workflowCount} active workflows)` : ""}`
            : violationLines(gate.violations),
          { path: statusPath, kind: isSnapshot ? "snapshot" : "root", plan_count: planCount, workflow_count: workflowCount, ok: gate.ok, violations: gate.violations },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_status_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
