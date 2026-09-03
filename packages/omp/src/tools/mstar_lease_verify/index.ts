/**
 * mstar_lease_verify — verify a plan's execution_lease or the workflow
 * snapshot top-level integration_merge_lease via engine gates
 * (`verifyPlanExecutionLease` / `validateIntegrationMergeLease`).
 *
 * v3 hard cutover: the lease data home is the workflow snapshot
 * `{WORKFLOW_DIR}/<workflowId>/snapshot.json` (row-level
 * `plans[].execution_lease` for kind=execution; snapshot top-level
 * `integration_merge_lease` for kind=integration — no root-`metadata`
 * location remains). The workflow dir comes from the engine resolver
 * (Phase-5 F1): a `.mstarc` `[config] workflow_dir` declaration wins,
 * else `{HARNESS_DIR}/workflows` — a custom layout is READ at the same
 * location it is written. The plan row is looked up by `plan_id`
 * (falling back to `id`); when `planId` is omitted, the snapshot's sole
 * plan row is used. The lease checks themselves are pure engine calls.
 *
 * `WORKFLOW_SNAPSHOT_FILE` is a P1-only engine export absent from the
 * published floor `^2.0.2` — it is read from a DYNAMIC engine import so a
 * stale engine yields an explicit upgrade error instead of a module-link
 * failure that silently drops the tool (qc3 F-001 / fix-wave W-B).
 * `resolveWorkflowDir` is likewise P1-only: it is loaded dynamically and
 * a stale engine (or a resolver failure) falls back to the DEFAULT
 * `workflows` name (same degrade as `mstar_status_validate`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readJson,
  resolveHarnessDir,
  validateIntegrationMergeLease,
  verifyPlanExecutionLease,
} from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { workflowId: string; kind: "execution" | "integration"; planId?: string };

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

/** Resolve the snapshot path from the workflow dir; error result when absent. */
function resolveSnapshot(
  workflowDir: string,
  workflowId: string,
  snapshotFile: string,
): { snapshotPath: string } | { error: AgentToolResult } {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    return { error: result(`mstar_lease_verify: invalid workflowId ${JSON.stringify(workflowId)}`, { ok: false }, true) };
  }
  return { snapshotPath: join(workflowDir, workflowId, snapshotFile) };
}

/** The P1-only v3 workflow-dir resolver (custom `.mstarc` `workflow_dir`
 * support, Phase-5 F1) — same stale-engine rationale as the dynamic
 * snapshot-file import: dynamic import, `null` on missing export / import
 * failure (snapshot resolution falls back to the DEFAULT `workflows`
 * name). */
type WorkflowDirResolver = (startDir: string, opts?: { harnessDir?: string }) => string;

let cachedWorkflowDirResolver: Promise<WorkflowDirResolver | null> | null = null;

async function loadWorkflowDirResolver(): Promise<WorkflowDirResolver | null> {
  cachedWorkflowDirResolver ??= import("@mstar-harness/engine")
    .then((mod) => (typeof mod.resolveWorkflowDir === "function" ? mod.resolveWorkflowDir : null))
    .catch(() => null);
  return cachedWorkflowDirResolver;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without the P1 dir resolver (null — default-layout resolution). */
export const workflowDirResolverLoader: { load: () => Promise<WorkflowDirResolver | null> } = {
  load: loadWorkflowDirResolver,
};

/** Resolve `{WORKFLOW_DIR}` for the snapshot (Phase-5 F1): the engine
 * resolver honors a `.mstarc` `[config] workflow_dir` declaration; on a
 * stale engine (no resolver) or a resolver failure the DEFAULT
 * `{HARNESS_DIR}/workflows` name applies (same degrade as
 * `mstar_status_validate`). */
async function resolveWorkflowDirOf(harnessDir: string): Promise<string> {
  const resolver = await workflowDirResolverLoader.load();
  if (resolver === null) return join(harnessDir, "workflows");
  try {
    return resolver(harnessDir, { harnessDir });
  } catch {
    return join(harnessDir, "workflows");
  }
}

/** Dynamic engine import guard for the P1-only `WORKFLOW_SNAPSHOT_FILE`
 * export (qc3 F-001 / fix-wave W-B): missing → explicit upgrade error. */
async function loadSnapshotFile(): Promise<{ snapshotFile: string } | { error: AgentToolResult }> {
  const engine = await import("@mstar-harness/engine");
  const snapshotFile = engine.WORKFLOW_SNAPSHOT_FILE;
  if (typeof snapshotFile !== "string") {
    return {
      error: result(
        "installed @mstar-harness/engine lacks WORKFLOW_SNAPSHOT_FILE — upgrade the engine (next release); CLI fallback: mstar lease verify",
        { ok: false },
        true,
      ),
    };
  }
  return { snapshotFile };
}

export default function mstarLeaseVerify(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_lease_verify",
    label: "Verify plan lease",
    description:
      "Verify the lease state of a Morning Star workflow from its snapshot ({WORKFLOW_DIR}/<workflowId>/snapshot.json — .mstarc workflow_dir honored, default {harness}/workflows; resolved from the session cwd): kind=execution runs the engine verifyPlanExecutionLease gate on the snapshot plan row (SSOT plans[].execution_lease — the v1 metadata location is deleted; missing/orphan detection), kind=integration runs validateIntegrationMergeLease on the snapshot top-level integration_merge_lease (absent = unclaimed). " +
      "`planId` picks the row (default: the snapshot's sole plan row). " +
      "Use before writable dispatch, before InProgress claims, or when reviewing lease/merge state. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        workflowId: pi.zod.string(),
        kind: pi.zod.enum(["execution", "integration"]),
        planId: pi.zod.string().optional(),
      }),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (!params?.workflowId) {
          return result("mstar_lease_verify: workflowId is required", { ok: false }, true);
        }
        const harnessDir = resolveHarnessDir(pi.cwd);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        // Dynamic engine import (fix-wave W-B): see the module header —
        // WORKFLOW_SNAPSHOT_FILE is P1-only, a static named import would
        // fail at module link on published engines (^2.0.2 floor).
        const snapshotFileLoad = await loadSnapshotFile();
        if ("error" in snapshotFileLoad) return snapshotFileLoad.error;
        const workflowDir = await resolveWorkflowDirOf(harnessDir);
        const resolved = resolveSnapshot(workflowDir, params.workflowId, snapshotFileLoad.snapshotFile);
        if ("error" in resolved) return resolved.error;
        const snapshotPath = resolved.snapshotPath;
        if (!existsSync(snapshotPath)) {
          return result(`workflow snapshot not found: ${snapshotPath}`, { workflow_id: params.workflowId, snapshot_path: snapshotPath }, true);
        }
        const doc = readJson(snapshotPath);

        if (params?.kind === "integration") {
          const lease = doc.integration_merge_lease;
          // Absent lease = the normal unclaimed state (writers delete the key
          // on release) — informational ok, NOT an engine violation (qc2
          // F-002). Only a PRESENT lease is validated against the engine gate.
          if (lease === undefined) {
            return result(
              "no active integration merge lease (unclaimed)",
              { kind: "integration", workflow_id: params.workflowId, snapshot_path: snapshotPath, state: "unclaimed", ok: true, violations: [] },
              false,
            );
          }
          const gate = validateIntegrationMergeLease(lease);
          return result(
            gate.ok ? "integration merge lease OK" : violationLines(gate.violations),
            { kind: "integration", workflow_id: params.workflowId, snapshot_path: snapshotPath, ok: gate.ok, violations: gate.violations },
            !gate.ok,
          );
        }

        const rows = Array.isArray(doc.plans) ? (doc.plans as unknown[]) : [];
        let row: Record<string, unknown> | undefined;
        if (params?.planId !== undefined) {
          row = rows.find(
            (r): r is Record<string, unknown> =>
              isPlainObject(r) && (r.plan_id === params.planId || r.id === params.planId),
          );
        } else if (rows.length === 1 && isPlainObject(rows[0])) {
          row = rows[0];
        }
        if (row === undefined) {
          const planLabel = params?.planId ?? "(sole row)";
          return result(`plan "${planLabel}" not found in ${snapshotPath}`, { kind: "execution", workflow_id: params.workflowId, plan_id: params?.planId ?? null, snapshot_path: snapshotPath }, true);
        }
        const planId = String(row.plan_id ?? row.id ?? params?.planId ?? "");
        const verify = verifyPlanExecutionLease(row, planId);
        return result(
          verify.ok ? `execution lease OK for plan "${planId}"` : violationLines(verify.violations),
          {
            kind: "execution",
            workflow_id: params.workflowId,
            plan_id: planId,
            snapshot_path: snapshotPath,
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
