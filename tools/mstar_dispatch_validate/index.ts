/**
 * mstar_dispatch_validate — validate a Morning Star Assignment document
 * via the engine dispatch gates.
 *
 * Composition mirrors `packages/opencode/src/mstar.ts`
 * `validateDispatchAssignment` (same engine calls, minus the opencode log
 * channel): field validation (`validateAssignmentFields`), anti-recursion
 * precheck when `agent` is provided, and the default-branch gate for
 * writable roles. Read-only roles (scout/explore, or the `readOnlyRole`
 * flag) skip the branch-form and default-branch gates. No local rule
 * logic — every check is an engine call.
 */
import {
  antiRecursionPrecheck,
  assertDefaultBranchProtected,
  isReadOnlyAssignmentRole,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  validateAssignmentFields,
} from "../../bundle/engine-bundle.js";
import type { GateResult, ValidationResult } from "../../bundle/engine-bundle.js";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { assignmentText: string; agent?: string; readOnlyRole?: boolean };

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

export default function mstarDispatchValidate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_dispatch_validate",
    label: "Validate dispatch assignment",
    description:
      "Validate a Morning Star Assignment document before dispatch (engine gates: required Execute as / Delegation / Task category fields, exactly-one branch form for writable roles, default-branch protection, and the anti-recursion NEVER red line). " +
      "Pass the full Assignment markdown as `assignmentText`; `agent` is the host role-binding field (subagent_type / agent / subagent) checked against Execute as for self-recursion; set `readOnlyRole` when the dispatch target is a read-only orientation role. " +
      "Use before any task/subagent dispatch. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        assignmentText: pi.zod.string(),
        agent: pi.zod.string().optional(),
        readOnlyRole: pi.zod.boolean().optional(),
      })
      .optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        const text = params?.assignmentText ?? "";
        if (text.trim() === "") {
          return result("mstar_dispatch_validate: assignmentText is required", { ok: false }, true);
        }
        const violations: ValidationResult[] = [];
        const fields = parseAssignmentFields(text);
        const readOnly = params?.readOnlyRole === true || isReadOnlyAssignmentRole(fields.executeAs ?? "");
        const writable = readOnly ? false : undefined;
        violations.push(...validateAssignmentFields(text, { writable }).violations);
        const agent = params?.agent ?? "";
        if (agent.trim() !== "") {
          violations.push(...antiRecursionPrecheck(agent, fields.executeAs ?? "").violations);
        }
        if (writable !== false) {
          const forms = parseAssignmentBranchForms(text);
          const branch =
            forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? process.env.MSTAR_WORKING_BRANCH;
          if (branch !== undefined && branch.trim() !== "") {
            const directOnException = parseBranchPolicyDirectOnBranch(text) === branch.trim();
            violations.push(...assertDefaultBranchProtected(branch.trim(), { directOnException }).violations);
          }
        }
        const gate: GateResult = { ok: violations.length === 0, violations };
        return result(
          gate.ok ? "assignment ok" : violationLines(gate.violations),
          {
            ok: gate.ok,
            violations: gate.violations,
            execute_as: fields.executeAs ?? null,
            read_only: readOnly,
            agent: agent.trim() !== "" ? agent : null,
          },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_dispatch_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
