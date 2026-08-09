/**
 * mstar_status_validate — validate a Morning Star harness `status.json`
 * document via the engine's `validateStatus` gate.
 *
 * Defaults to `{harness}/status.json` resolved from the session cwd
 * (`resolveHarnessDir(pi.cwd)`); pass `path` to target another file
 * (resolved against `pi.cwd`). No local rule logic — the engine is the
 * single validator; this module only locates the file and formats output.
 */
import { join, resolve } from "node:path";
import { readJson, resolveHarnessDir, validateStatus } from "@mstar-harness/engine";
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
    label: "Validate harness status.json",
    description:
      "Validate a Morning Star harness status.json document (schema: status-and-residuals.md) using the engine validateStatus gate. " +
      "Defaults to {harness}/status.json discovered from the session cwd; pass `path` to check another file. " +
      "Use after editing status.json, before writable dispatch, or when plan status / execution_lease / residual_findings edits are reviewed. " +
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
        const gate = validateStatus(statusPath);
        // plan count only when the gate passed: validateStatus(path) already
        // proved the file parses, so the re-read cannot throw.
        let planCount = 0;
        if (gate.ok) {
          const doc = readJson(statusPath) as { plans?: unknown };
          planCount = Array.isArray(doc.plans) ? doc.plans.length : 0;
        }
        return result(
          gate.ok ? `status.json valid (${planCount} plans)` : violationLines(gate.violations),
          { path: statusPath, plan_count: planCount, ok: gate.ok, violations: gate.violations },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_status_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
