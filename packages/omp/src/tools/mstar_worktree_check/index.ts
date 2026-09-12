/**
 * mstar_worktree_check — run the engine L1 / L2 pre-dispatch worktree
 * checklists (`l1PreDispatchCheck` / `l2PreDispatchCheck`).
 *
 * kind=l1 in v3 assembles the FULL `L1PreDispatchInput` from the workflow
 * snapshot (`{WORKFLOW_DIR}/<workflowId>/snapshot.json`, read through the
 * canonical `readWorkflowSnapshot` — the v1 `control_worktree_path` key is
 * accepted as a read-alias with its migration diagnostic) plus the
 * Git-derived main worktree: `readMainWorktree(cwd)` runs BEFORE snapshot
 * resolution (the process-SSOT control root never comes from the snapshot),
 * the recorded residency expectation comes from the `mainBranch` param
 * (the recorded value only — never the observed branch) with the explicit
 * `branch.base` fallback, the integration topology comes from the snapshot's
 * `integration_worktree_path` + `branch.integration` (the
 * `integrationWorktreePath` param overrides the path), the plan row's
 * `execution_lease` (worktree_path + working_branch) supplies the feature
 * checkout, and `lifecycleBranches` are collected from the governing
 * snapshot plus every OTHER registered ACTIVE workflow's snapshot (v2 root
 * register; fail-closed on unreadable/malformed sibling state — CLI
 * parity, codes `worktree.l1.lifecycle-register-unreadable` /
 * `worktree.l1.lifecycle-snapshot-unreadable`). No local rule logic.
 *
 * kind=l2 takes the parallel writable `tracks` (absolute worktreePath +
 * Working branch per track); the zod shape guards the L2PreDispatchInput
 * contract at the parameter boundary.
 *
 * `workflowId` is a single safe path component — reject separators and
 * `..` before joining (parity with the CLI `resolveSnapshotPath` and
 * `mstar_lease_verify`, W-A). `WORKFLOW_SNAPSHOT_FILE`, `readWorkflowSnapshot`
 * and `readMainWorktree` are P1-only engine exports absent from the
 * published floor `^2.0.2`, read from a DYNAMIC engine import so a stale
 * engine yields an explicit upgrade error instead of a module-link failure
 * that silently drops the tool. `resolveWorkflowDir` is likewise
 * P1-only: it is loaded dynamically and a stale engine (or a resolver
 * failure) falls back to the DEFAULT `workflows` name (same degrade as
 * `mstar_status_validate`).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  resolveHarnessDir,
} from "@mstar-harness/engine";
import type {
  L1PreDispatchInput,
  MainWorktreeInfo,
  ValidationResult,
  WorkflowSnapshot,
  WorktreeTrack,
} from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

/** The omp tool's canonical parameter shape (spec § Locked interfaces —
 * P1 CLI and host): no obsolete camelCase control alias. */
type WorktreeCheckParams = {
  kind: "l1" | "l2";
  workflowId?: string;
  planId?: string;
  integrationWorktreePath?: string;
  mainBranch?: string;
  tracks?: WorktreeTrack[];
};

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

/** Workflow-id guard : reject "", ".", "..", separators. */
function assertSafeWorkflowId(workflowId: string): string | null {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    return `mstar_worktree_check: invalid workflowId ${JSON.stringify(workflowId)}`;
  }
  return null;
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

/** The P1-only engine exports this tool consumes (worktree-write model):
 * the snapshot file name, the canonical snapshot reader (legacy alias
 * normalization) and the main-worktree discovery primitive. Dynamic import
 * : a static named import of any of these would fail at module link on
 * published engines (^2.0.2 floor) and silently drop the tool from
 * /extensions. */
type P1EngineExports = {
  collectActiveLifecycleBranches: typeof import("@mstar-harness/engine").collectActiveLifecycleBranches;
  scanActiveLifecycleBranches: typeof import("@mstar-harness/engine").scanActiveLifecycleBranches;
  snapshotFile: string;
  readWorkflowSnapshot: (dir: string) => { snapshot: WorkflowSnapshot; diagnostics: ValidationResult[] };
  readMainWorktree: (cwd?: string) => MainWorktreeInfo | null;
};

async function loadP1Exports(): Promise<P1EngineExports | { error: AgentToolResult }> {
  const engine = await import("@mstar-harness/engine");
  const { collectActiveLifecycleBranches, scanActiveLifecycleBranches } = engine;
  const snapshotFile = engine.WORKFLOW_SNAPSHOT_FILE;
  const readWorkflowSnapshot = engine.readWorkflowSnapshot;
  const readMainWorktree = engine.readMainWorktree;
  if (typeof collectActiveLifecycleBranches !== "function" || typeof scanActiveLifecycleBranches !== "function" || typeof snapshotFile !== "string" || typeof readWorkflowSnapshot !== "function" || typeof readMainWorktree !== "function") {
    return {
      error: result(
        "installed @mstar-harness/engine lacks the P1 worktree-write-model exports (WORKFLOW_SNAPSHOT_FILE / readWorkflowSnapshot / readMainWorktree) — upgrade the engine (next release); CLI fallback: mstar worktree check",
        { ok: false },
        true,
      ),
    };
  }
  return { snapshotFile, readWorkflowSnapshot, readMainWorktree, collectActiveLifecycleBranches, scanActiveLifecycleBranches };
}


export default function mstarWorktreeCheck(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_worktree_check",
    label: "Check worktree dispatch readiness",
    description:
      "Run the engine pre-dispatch worktree checklists: kind=l1 verifies the cross-plan L1 gate — main-worktree residency against the recorded expectation (mainBranch param or the snapshot's branch.base) and non-ownership of any active lifecycle branch, the dedicated integration checkout (snapshot integration_worktree_path on branch.integration), and the plan row execution_lease feature worktree (Git-checkout identity, existence, branch alignment). kind=l2 verifies the within-plan L2 gate (each parallel writable track has a distinct absolute worktree path and matching checked-out branch). " +
      "Use before any writable dispatch, especially parallel multi-track dispatch. Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod
      .object({
        kind: pi.zod.enum(["l1", "l2"]),
        workflowId: pi.zod.string().optional(),
        planId: pi.zod.string().optional(),
        integrationWorktreePath: pi.zod.string().optional(),
        mainBranch: pi.zod.string().optional(),
        tracks: pi.zod
          .array(pi.zod.object({ worktreePath: pi.zod.string(), workingBranch: pi.zod.string() }))
          .optional(),
      }),
    async execute(_toolCallId: string, params: WorktreeCheckParams, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        if (params?.kind !== "l1" && params?.kind !== "l2") {
          return result("mstar_worktree_check: kind required (l1|l2)", { ok: false }, true);
        }
        if (params.kind === "l2") {
          const gate = l2PreDispatchCheck({ tracks: params.tracks ?? [] });
          return result(
            gate.ok ? "l2 pre-dispatch check OK" : violationLines(gate.violations),
            { kind: "l2", ok: gate.ok, violations: gate.violations, track_count: (params.tracks ?? []).length },
            !gate.ok,
          );
        }
        if (!params?.workflowId) {
          return result("mstar_worktree_check: kind=l1 requires workflowId (the snapshot supplies the L1 inputs)", { ok: false }, true);
        }
        const guardError = assertSafeWorkflowId(params.workflowId);
        if (guardError !== null) return result(guardError, { ok: false }, true);
        const p1 = await loadP1Exports();
        if ("error" in p1) return p1.error;
        const main = p1.readMainWorktree(pi.cwd);
        if (main === null) return result("[high] worktree.main.unresolved: cannot verify main worktree", { ok: false }, true);
        const harnessDir = resolveHarnessDir(main.root);
        if (harnessDir === null) {
          return result(
            `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up)`,
            { cwd: pi.cwd },
            true,
          );
        }
        // Main-root discovery BEFORE snapshot resolution: the main worktree
        // (process-SSOT control root) is Git-derived, never snapshot state.
        const observedMain = `main worktree: ${main.root} on branch "${main.branch}" (observed)`;
        const workflowDir = await resolveWorkflowDirOf(harnessDir);
        const snapshotDir = join(workflowDir, params.workflowId);
        if (!existsSync(join(snapshotDir, p1.snapshotFile))) {
          return result(`workflow snapshot not found: ${join(snapshotDir, p1.snapshotFile)}`, { workflow_id: params.workflowId, snapshot_path: join(snapshotDir, p1.snapshotFile) }, true);
        }
        // Canonical reader: accepts the v1 control_worktree_path alias with
        // its medium migration diagnostic (reported as a read-only advisory
        // — the source file is never rewritten here); any other violation
        // refuses the read.
        let snapshot: WorkflowSnapshot;
        let diagnostics: ValidationResult[];
        try {
          const read = p1.readWorkflowSnapshot(snapshotDir);
          snapshot = read.snapshot;
          diagnostics = read.diagnostics;
        } catch (error) {
          return result(`${(error as Error).message}`, { workflow_id: params.workflowId, snapshot_path: join(snapshotDir, p1.snapshotFile) }, true);
        }
        const rows = Array.isArray(snapshot.plans) ? (snapshot.plans as Array<Record<string, unknown>>) : [];
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
          return result(
            `plan "${planLabel}" not found in ${join(snapshotDir, p1.snapshotFile)}`,
            { kind: "l1", workflow_id: params.workflowId, plan_id: params?.planId ?? null, snapshot_path: join(snapshotDir, p1.snapshotFile) },
            true,
          );
        }
        const lease = isPlainObject(row.execution_lease) ? row.execution_lease : {};
        const planId = String(row.plan_id ?? row.id ?? params?.planId ?? "");
        // Lifecycle-owned branches: the governing snapshot's contribution
        // plus every OTHER registered ACTIVE workflow's snapshot.
        const lifecycleBranches = new Set(p1.collectActiveLifecycleBranches([snapshot]));
        const siblingScan = p1.scanActiveLifecycleBranches(harnessDir, params.workflowId);
        if (siblingScan.kind === "refusal") {
          return result(
            `${observedMain}\n[high] ${siblingScan.code}: ${siblingScan.detail}`,
            { kind: "l1", workflow_id: params.workflowId, plan_id: planId, ok: false, refusal: siblingScan },
            true,
          );
        }
        for (const branch of siblingScan.branches) lifecycleBranches.add(branch);
        const branch = isPlainObject(snapshot.branch) ? snapshot.branch : {};
        const input: L1PreDispatchInput = {
          workflowType: snapshot.type,
          integrationWorktreePath:
            params?.integrationWorktreePath !== undefined
              ? resolve(params.integrationWorktreePath)
              : String(snapshot.integration_worktree_path ?? ""),
          integrationBranch: String(branch.integration ?? ""),
          mainWorktree: main,
          expectedMainBranch: params?.mainBranch ?? String(branch.base ?? ""),
          lifecycleBranches: [...lifecycleBranches],
          leaseWorktreePath: String(lease.worktree_path ?? ""),
          leaseWorkingBranch: String(lease.working_branch ?? ""),
          planId,
        };
        const gate = l1PreDispatchCheck(input);
        // Governing + sibling diagnostics share one `note:` channel (the
        // sibling contributions come from the scan, CLI parity).
        const notes = [...diagnostics, ...siblingScan.notes]
          .map((d) => `note: [${d.severity}] ${d.code}: ${d.message}`)
          .join("\n");
        const body = gate.ok
          ? `l1 pre-dispatch check OK (plan "${planId}", workflow "${params.workflowId}")`
          : violationLines(gate.violations);
        return result(
          `${observedMain}\n${notes === "" ? body : `${notes}\n${body}`}`,
          { kind: "l1", workflow_id: params.workflowId, plan_id: planId, ok: gate.ok, violations: gate.violations, input },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_worktree_check failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
