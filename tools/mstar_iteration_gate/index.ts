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
 * `workflowId` is a single safe path component (parity with the CLI
 * `--workflow <id>` and the sibling snapshot-consuming tools, fix-wave
 * S-b / W-A): it is resolved to
 * `{HARNESS_DIR}/workflows/<workflowId>/snapshot.json` from the session
 * cwd with the traversal guard — a full path is NOT accepted. `compassPath`
 * is a delivery-compass.md whose YAML frontmatter is parsed by the engine
 * `parseCompassFrontmatter` (same parser the CLI uses — no fork), resolved
 * against `pi.cwd`.
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
import { join, resolve } from "node:path";
import { evaluatePhaseGate, readJson, resolveHarnessDir } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { phase: string; workflowId: string; compassPath: string };

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

/** Workflow-id guard (fix-wave S-b / W-A parity): reject "", ".", "..", separators. */
function assertSafeWorkflowId(workflowId: string): string | null {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    return `mstar_iteration_gate: invalid workflowId ${JSON.stringify(workflowId)}`;
  }
  return null;
}

export default function mstarIterationGate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_iteration_gate",
    label: "Evaluate iteration phase gate",
    description:
      "Evaluate the Morning Star iteration Phase transition gates (mstar-iteration): reads the workflow snapshot (workflows/<id>/snapshot.json, resolved from the session cwd) and delivery-compass.md frontmatter and runs the engine evaluatePhaseGate (all compass-registered plans Done, close entry checklist, PR-delivery exit checklist). " +
      "`phase` labels the intended transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) for the report; `workflowId` is the workflow id (CLI parity, single safe path component) and `compassPath` is a file path resolved against the session cwd. " +
      "Use before iteration-close or PR delivery to confirm the gate state. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        phase: pi.zod.string(),
        workflowId: pi.zod.string(),
        compassPath: pi.zod.string(),
      }),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (!params?.phase || !params?.workflowId || !params?.compassPath) {
          return result("mstar_iteration_gate: phase, workflowId and compassPath are required", { ok: false }, true);
        }
        const guardError = assertSafeWorkflowId(params.workflowId);
        if (guardError !== null) return result(guardError, { ok: false }, true);
        const harnessDir = resolveHarnessDir(pi.cwd);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        const snapshotPath = join(harnessDir, "workflows", params.workflowId, "snapshot.json");
        const compassPath = resolve(pi.cwd, params.compassPath);
        if (!existsSync(snapshotPath)) {
          return result(`workflow snapshot not found: ${snapshotPath}`, { phase: params.phase, workflow_id: params.workflowId, workflow_snapshot_path: snapshotPath }, true);
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
            { phase: params.phase, workflow_id: params.workflowId, workflow_snapshot_path: snapshotPath, compass_path: compassPath },
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
            workflow_id: params.workflowId,
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
