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
 */
import {
  resolveHarnessDir,
  resolveIterationDir,
  resolveKnowledgeDir,
  resolvePlanDir,
  resolveProjectDir,
  resolveSddDir,
  resolveSpecsDir,
  resolveWorkflowDir,
} from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { planId?: string };

function result(text: string, details: unknown, isError: boolean): AgentToolResult {
  const out: AgentToolResult = { content: [{ type: "text", text }], details };
  if (isError) out.isError = true;
  return out;
}

export default function mstarPathResolve(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_path_resolve",
    label: "Resolve harness directories",
    description:
      "Resolve the Morning Star harness directory symbols ({HARNESS_DIR}, {PLAN_DIR}, {SDD_DIR}, {ITERATION_DIR}, {KNOWLEDGE_DIR}, {SPECS_DIR}, {WORKFLOW_DIR}, {PROJECT_DIR}) from the session cwd using the engine resolvers. " +
      "Pass `planId` to also resolve the per-plan SDD dir ({HARNESS_DIR}/sdd/<plan-id>/). " +
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
        const specsDir = resolveSpecsDir(harnessDir);
        const workflowDir = resolveWorkflowDir(pi.cwd);
        const projectDir = resolveProjectDir(pi.cwd);
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
          `workflow: ${workflowDir}`,
          `project: ${projectDir}`,
        ];
        return result(lines.join("\n"), {
          cwd: pi.cwd,
          harness_dir: harnessDir,
          plan_dir: planDir,
          sdd_dir: sddDir ?? null,
          iteration_dir: iterationDir,
          knowledge_dir: knowledgeDir,
          specs_dir: specsDir,
          workflow_dir: workflowDir,
          project_dir: projectDir,
        }, false);
      } catch (error) {
        return result(`mstar_path_resolve failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
