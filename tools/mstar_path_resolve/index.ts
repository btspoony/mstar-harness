/**
 * mstar_path_resolve — resolve the eight Morning Star harness directory
 * symbols from the session cwd via engine resolvers
 * (`resolveHarnessDir` / `resolvePlanDir` / `resolveSddDir` /
 * `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir` /
 * `resolveWorkflowDir` / `resolveProjectDir`).
 *
 * `resolveSddDir` composes `{HARNESS_DIR}/sdd/<plan-id>/` and requires a
 * plan id (single safe path component), so `planId` is an optional param:
 * pass it to resolve the per-plan SDD dir; omit it to resolve only the
 * other seven symbols. No local rule logic — path composition is engine
 * code.
 *
 * `resolveWorkflowDir` / `resolveProjectDir` are P1-only engine exports
 * absent from the published floor `^2.0.2` (qc3 F-001 / fix-wave W-B) —
 * they come from a DYNAMIC engine import. On a stale engine the tool keeps
 * working with the six v1-era symbols and skips the two v3 dirs with a
 * one-time warning (never a module-link crash, never a silent drop).
 */
import {
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveSddDir,
  resolveSpecsDir,
} from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { planId?: string };

function result(text: string, details: unknown, isError: boolean): AgentToolResult {
  const out: AgentToolResult = { content: [{ type: "text", text }], details };
  if (isError) out.isError = true;
  return out;
}

/** One-time stale-engine warning (module-level flag; must never throw). */
let workflowProjectDirWarned = false;

/**
 * Resolve the two v3 subdirs from a DYNAMIC engine import (fix-wave W-B):
 * missing exports degrade to `null` + a one-time warning line — the six
 * v1-era symbols still resolve.
 */
async function resolveV3Dirs(pi: CustomToolAPI): Promise<{ workflowDir: string | null; projectDir: string | null; warning: string | null }> {
  // Dynamic import (fix-wave W-B): static named imports of these exports
  // would fail at module link on published engines (^2.0.2 floor) and
  // silently drop the tool from /extensions.
  const engine = await import("@mstar-harness/engine");
  if (typeof engine.resolveWorkflowDir !== "function" || typeof engine.resolveProjectDir !== "function") {
    let warning: string | null = null;
    if (!workflowProjectDirWarned) {
      workflowProjectDirWarned = true;
      warning =
        "note: installed @mstar-harness/engine lacks resolveWorkflowDir/resolveProjectDir — workflow/project dirs skipped; upgrade the engine (next release)";
    }
    return { workflowDir: null, projectDir: null, warning };
  }
  return { workflowDir: engine.resolveWorkflowDir(pi.cwd), projectDir: engine.resolveProjectDir(pi.cwd), warning: null };
}

export default function mstarPathResolve(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_path_resolve",
    label: "Resolve harness directories",
    description:
      "Resolve the Morning Star harness directory symbols ({HARNESS_DIR}, {PLAN_DIR}, {SDD_DIR}, {ITERATION_DIR}, {KNOWLEDGE_DIR}, {SPECS_DIR}, {WORKFLOW_DIR}, {PROJECT_DIR}) from the session cwd using the engine resolvers. " +
      "Pass `planId` to also resolve the per-plan SDD dir ({HARNESS_DIR}/sdd/<plan-id>/). " +
      "On an engine older than the v3 release the workflow/project dirs are skipped with a warning (the other six still resolve). " +
      "Use when a tool needs the exact harness, plans, sdd, iterations, knowledge, specs, workflows, or projects path (e.g. before reading status.json, workflow snapshots, project registers, plan files, or review bundles).",
    parameters: pi.zod.object({ planId: pi.zod.string().optional() }).optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        const harnessDir = resolveHarnessDir(pi.cwd);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        const planDir = resolvePlanDir(harnessDir);
        const iterationDir = resolveIterationDir(harnessDir);
        const knowledgeDir = resolveKnowledgeDir(harnessDir);
        const specsDir = resolveSpecsDir(harnessDir, { create: false });
        const v3 = await resolveV3Dirs(pi);
        let sddDir: string | undefined;
        if (params?.planId) {
          sddDir = resolveSddDir(harnessDir, params.planId);
        }
        const lines = [
          `harness: ${harnessDir}`,
          `plan: ${planDir}`,
          `sdd: ${sddDir ?? "(pass planId to resolve the per-plan sdd dir)"}`,
          `iteration: ${iterationDir}`,
          `knowledge: ${knowledgeDir}`,
          `specs: ${specsDir}`,
          `workflow: ${v3.workflowDir ?? "(engine lacks resolveWorkflowDir — upgrade)"}`,
          `project: ${v3.projectDir ?? "(engine lacks resolveProjectDir — upgrade)"}`,
        ];
        const text = v3.warning !== null ? `${lines.join("\n")}\n${v3.warning}` : lines.join("\n");
        return result(text, {
          cwd: pi.cwd,
          harness_dir: harnessDir,
          plan_dir: planDir,
          sdd_dir: sddDir ?? null,
          iteration_dir: iterationDir,
          knowledge_dir: knowledgeDir,
          specs_dir: specsDir,
          workflow_dir: v3.workflowDir,
          project_dir: v3.projectDir,
        }, false);
      } catch (error) {
        return result(`mstar_path_resolve failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
