/**
 * mstar_lease_verify — verify a plan's execution_lease or the root
 * integration_merge_lease in the resolved harness status.json via engine
 * gates (`verifyPlanExecutionLease` / `validateIntegrationMergeLease`).
 *
 * The plan row is looked up by `plan_id` (falling back to `id`, the
 * engine-documented read-compat key); the lease checks themselves are pure
 * engine calls. No local rule logic.
 */
import { join } from "node:path";
import { readJson, resolveHarnessDir, validateIntegrationMergeLease, verifyPlanExecutionLease } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { planId: string; kind: "execution" | "integration" };

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

export default function mstarLeaseVerify(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_lease_verify",
    label: "Verify plan lease",
    description:
      "Verify the lease state of a Morning Star plan from the harness status.json (resolved from the session cwd): kind=execution runs the engine verifyPlanExecutionLease gate on the plan row (SSOT plans[].execution_lease, legacy metadata location, orphan/dual-write detection); kind=integration runs validateIntegrationMergeLease on metadata.integration_merge_lease (absent = unclaimed). " +
      "Use before writable dispatch, before InProgress claims, or when reviewing lease/merge state. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        planId: pi.zod.string(),
        kind: pi.zod.enum(["execution", "integration"]),
      })
      .optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (!params?.planId) {
          return result("mstar_lease_verify: planId is required", { ok: false }, true);
        }
        const harnessDir = resolveHarnessDir(pi.cwd);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        const statusPath = join(harnessDir, "status.json");
        const doc = readJson(statusPath);

        if (params?.kind === "integration") {
          const metadata = doc.metadata;
          const lease = isPlainObject(metadata) ? metadata.integration_merge_lease : undefined;
          const gate = validateIntegrationMergeLease(lease);
          return result(
            gate.ok ? "integration merge lease OK" : violationLines(gate.violations),
            { kind: "integration", status_path: statusPath, ok: gate.ok, violations: gate.violations },
            !gate.ok,
          );
        }

        const rows = Array.isArray(doc.plans) ? doc.plans : [];
        const row = rows.find(
          (r): r is Record<string, unknown> =>
            isPlainObject(r) && (r.plan_id === params?.planId || r.id === params?.planId),
        );
        if (row === undefined) {
          return result(`plan "${params?.planId}" not found in ${statusPath}`, { kind: "execution", plan_id: params?.planId, status_path: statusPath }, true);
        }
        const verify = verifyPlanExecutionLease(row, params?.planId ?? "");
        return result(
          verify.ok ? `execution lease OK for plan "${params?.planId}"` : violationLines(verify.violations),
          {
            kind: "execution",
            plan_id: params?.planId,
            status_path: statusPath,
            ok: verify.ok,
            violations: verify.violations,
            lease: verify.lease ?? null,
          },
          !verify.ok,
        );
      } catch (error) {
        return result(`mstar_lease_verify failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
