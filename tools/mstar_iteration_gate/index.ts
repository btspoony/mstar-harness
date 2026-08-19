/**
 * mstar_iteration_gate — evaluate the iteration Phase transition gates via
 * the engine `evaluatePhaseGate` over a workflow snapshot
 * (`workflows/<id>/snapshot.json`) and a delivery-compass.md frontmatter.
 *
 * Verified against the engine source: `PhaseGateOptions` has NO `phase`
 * key — the transition (phase-2-execute | phase-3-close |
 * phase-4-pr-delivery) is computed from the two documents. The `phase`
 * param is therefore informational: it labels the check the caller
 * intends to run and is echoed into the text/details, never passed to the
 * engine.
 *
 * `workflowSnapshotPath` is read as JSON (engine `readJson`);
 * `compassPath` is a delivery-compass.md whose YAML frontmatter is parsed
 * by the engine `parseCompassFrontmatter` (same parser the CLI uses — no
 * fork). Both paths are resolved against `pi.cwd`.
 *
 * Missing files are explicit isError results — the engine `readJson` would
 * otherwise read a missing snapshot as `{}` and the gate would report a
 * false "gate ok" on nothing (qc2 F-001). `parseCompassFrontmatter` is
 * imported DYNAMICALLY so the tool stays loadable against published engine
 * versions that predate the export (2.0.2): a missing parser is a clear
 * upgrade error instead of a module-load failure that silently drops the
 * tool (qc3 F-001).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePhaseGate, readJson } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { phase: string; workflowSnapshotPath: string; compassPath: string };

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
      "Evaluate the Morning Star iteration Phase transition gates (mstar-iteration): reads the given workflow snapshot (workflows/<id>/snapshot.json) and delivery-compass.md frontmatter and runs the engine evaluatePhaseGate (all compass-registered plans Done, close entry checklist, PR-delivery exit checklist). " +
      "`phase` labels the intended transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) for the report; `workflowSnapshotPath` and `compassPath` are file paths resolved against the session cwd. " +
      "Use before iteration-close or PR delivery to confirm the gate state. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        phase: pi.zod.string(),
        workflowSnapshotPath: pi.zod.string(),
        compassPath: pi.zod.string(),
      }),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (!params?.phase || !params?.workflowSnapshotPath || !params?.compassPath) {
          return result("mstar_iteration_gate: phase, workflowSnapshotPath and compassPath are required", { ok: false }, true);
        }
        const snapshotPath = resolve(pi.cwd, params.workflowSnapshotPath);
        const compassPath = resolve(pi.cwd, params.compassPath);
        if (!existsSync(snapshotPath)) {
          return result(`workflow snapshot not found: ${snapshotPath}`, { phase: params.phase, workflow_snapshot_path: snapshotPath }, true);
        }
        if (!existsSync(compassPath)) {
          return result(
            `delivery-compass.md not found: ${compassPath}`,
            { phase: params.phase, compass_path: compassPath },
            true,
          );
        }
        // Dynamic engine import (qc3 F-001): published engine 2.0.2 lacks
        // parseCompassFrontmatter — a static named import would fail at
        // module link and silently drop the tool from /extensions. The
        // runtime check degrades to an explicit upgrade error instead.
        const engine = await import("@mstar-harness/engine");
        const parseCompassFrontmatter = engine.parseCompassFrontmatter;
        if (typeof parseCompassFrontmatter !== "function") {
          return result(
            "installed @mstar-harness/engine lacks parseCompassFrontmatter — upgrade the engine (next release); CLI fallback: mstar iteration gate",
            { phase: params.phase, workflow_snapshot_path: snapshotPath, compass_path: compassPath },
            true,
          );
        }
        const snapshotDoc = readJson(snapshotPath);
        const compassDoc = parseCompassFrontmatter(compassPath);
        const gate = evaluatePhaseGate(snapshotDoc, compassDoc, {});
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
