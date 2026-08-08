/**
 * mstar_iteration_gate — evaluate the iteration Phase transition gates via
 * the engine `evaluatePhaseGate` over a status.json and a
 * delivery-compass.md frontmatter.
 *
 * Verified against the engine source: `PhaseGateOptions` has NO `phase`
 * key — the transition (phase-2-execute | phase-3-close |
 * phase-4-pr-delivery) is computed from the two documents. The `phase`
 * param is therefore informational: it labels the check the caller
 * intends to run and is echoed into the text/details, never passed to the
 * engine. `statusPath` is read as JSON (engine `readJson`); `compassPath`
 * is a delivery-compass.md whose YAML frontmatter is parsed by the engine
 * `parseCompassFrontmatter` (same parser the CLI uses — no fork). Both
 * paths are resolved against `pi.cwd`.
 */
import { resolve } from "node:path";
import { evaluatePhaseGate, parseCompassFrontmatter, readJson } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { phase: string; statusPath: string; compassPath: string };

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

export default function mstarIterationGate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_iteration_gate",
    label: "Evaluate iteration phase gate",
    description:
      "Evaluate the Morning Star iteration Phase transition gates (mstar-iteration): reads the given status.json and delivery-compass.md frontmatter and runs the engine evaluatePhaseGate (all compass-registered plans Done, close entry checklist, PR-delivery exit checklist). " +
      "`phase` labels the intended transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) for the report; `statusPath` and `compassPath` are file paths resolved against the session cwd. " +
      "Use before iteration-close or PR delivery to confirm the gate state. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        phase: pi.zod.string(),
        statusPath: pi.zod.string(),
        compassPath: pi.zod.string(),
      })
      .optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (!params?.phase || !params?.statusPath || !params?.compassPath) {
          return result("mstar_iteration_gate: phase, statusPath and compassPath are required", { ok: false }, true);
        }
        const statusDoc = readJson(resolve(pi.cwd, params.statusPath));
        const compassDoc = parseCompassFrontmatter(resolve(pi.cwd, params.compassPath));
        const gate = evaluatePhaseGate(statusDoc, compassDoc, {});
        return result(
          gate.ok
            ? `gate ok (transition: ${gate.transition})`
            : `phase "${params.phase}" gate violations:\n${violationLines(gate.violations)}`,
          {
            phase: params.phase,
            transition: gate.transition,
            all_plans_done: gate.allPlansDone,
            ok: gate.ok,
            violations: gate.violations,
            entry_ok: gate.entry.ok,
            entry_violation_count: gate.entry.violations.length,
            exit_ok: gate.exit.ok,
            exit_violation_count: gate.exit.violations.length,
          },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_iteration_gate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
