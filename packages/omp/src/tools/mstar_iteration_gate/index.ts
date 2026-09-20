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
 * `--workflow <id>` and the sibling snapshot-consuming tools,
 * S-b / W-A): it is resolved to
 * `{WORKFLOW_DIR}/<workflowId>/snapshot.json` from the session cwd with
 * the traversal guard — a full path is NOT accepted. The workflow dir
 * comes from the engine resolver (Phase-5 F1): a `.mstarc` `[config]
 * workflow_dir` declaration wins, else `{HARNESS_DIR}/workflows` — a
 * custom layout is READ at the same location it is written. `compassPath`
 * is a delivery-compass.md whose YAML frontmatter is parsed by the engine
 * `parseCompassFrontmatter` (same parser the CLI uses — no fork), resolved
 * against `pi.cwd`.
 *
 * Missing files are explicit isError results — the engine `readJson` would
 * otherwise read a missing snapshot as `{}` and the gate would report a
 * false "gate ok" on nothing . `parseCompassFrontmatter` is
 * imported DYNAMICALLY so the tool stays loadable against published engine
 * versions that predate the export (2.0.2): a missing parser is a clear
 * upgrade error instead of a module-load failure that silently drops the
 * tool . `resolveWorkflowDir` is likewise P1-only: it is
 * loaded dynamically and a stale engine (or a resolver failure) falls
 * back to the DEFAULT `workflows` name (same degrade as
 * `mstar_status_validate`).
 *
 * EXECUTION authority (source readiness, plan S3): the workflow snapshot is
 * retired as a persistence route while the control harness's execution
 * authority is ACTIVE (primary spec §4.3), and the phase gates consume the
 * snapshot DOCUMENT — including the plan session bindings the DB adapter
 * deliberately does not carry. The gate therefore asks the engine's route
 * (`resolveExecutionReadRoute`, plan S2) BEFORE reading anything and refuses
 * `execution.consumer-not-ready` rather than reading retired bytes or
 * synthesizing a snapshot (primary spec §5). A store that exists and cannot be
 * read keeps its own refusal — never a fall-through to the file route.
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

/** Workflow-id guard (parity): reject "", ".", "..", separators. */
function assertSafeWorkflowId(workflowId: string): string | null {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    return `mstar_iteration_gate: invalid workflowId ${JSON.stringify(workflowId)}`;
  }
  return null;
}

/** The P1-only v3 workflow-dir resolver (custom `.mstarc` `workflow_dir`
 * support, Phase-5 F1) — same stale-engine rationale as the dynamic
 * `parseCompassFrontmatter` import: dynamic import, `null` on missing
 * export / import failure (snapshot resolution falls back to the DEFAULT
 * `workflows` name). */
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

/** §5 the engine's execution-source route (plan S2). P1-only export: dynamic
 * import with an explicit upgrade error — a stale engine must never answer
 * "files" for a harness whose authority it cannot see (that silent verdict
 * would be exactly the retired-file fallback §5 forbids). */
type ExecutionRouteResolver = (context: { harnessDir: string }) => Promise<"execution" | "files">;

async function loadExecutionRoute(): Promise<
  { resolve: ExecutionRouteResolver } | { error: AgentToolResult }
> {
  const engine = await import("@mstar-harness/engine");
  const resolve = engine.resolveExecutionReadRoute as ExecutionRouteResolver | undefined;
  if (typeof resolve !== "function") {
    return {
      error: result(
        "installed @mstar-harness/engine lacks resolveExecutionReadRoute — upgrade the engine (next release); CLI fallback: mstar iteration gate",
        { ok: false },
        true,
      ),
    };
  }
  return { resolve };
}

/** §5: the refusal of this gate's retired input while the control harness's
 * execution authority is ACTIVE (or `null` when the file route still answers).
 * The gate's pure input is the whole snapshot DOCUMENT — the phase gates
 * validate its shape and a prepared row's coordination carries its session
 * binding, which the DB adapter deliberately does not carry — so the honest
 * answer is not-ready, never the retired bytes and never a synthesized
 * snapshot. A store that exists and cannot be read keeps its own refusal. */
async function executionNotReady(
  harnessDir: string,
): Promise<{ code: string; message: string } | { error: AgentToolResult } | null> {
  const load = await loadExecutionRoute();
  if ("error" in load) return { error: load.error };
  let route: "execution" | "files";
  try {
    route = await load.resolve({ harnessDir });
  } catch (error) {
    const refusal = error as { code?: unknown; message?: unknown };
    const code = typeof refusal?.code === "string" ? refusal.code : "store.authority-unreadable";
    return {
      code,
      message:
        `the execution authority of ${harnessDir} could not be read (${code}): ` +
        `${typeof refusal?.message === "string" ? refusal.message : String(error)} — the workflow snapshot is retired ` +
        "while that authority governs it, so no file-route gate verdict is available",
    };
  }
  if (route !== "execution") return null;
  return {
    code: "execution.consumer-not-ready",
    message:
      `the execution authority of ${harnessDir} is ACTIVE, so this gate's workflow-snapshot input is retired. Nothing ` +
      "was read: the phase gates consume a snapshot document whose plan rows carry their session binding (which the DB " +
      "adapter deliberately does not carry), so the gate reports not-ready rather than reading the retired file or " +
      "inventing a binding. Read the workflow/plan state through the execution DB adapter instead.",
  };
}

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

export default function mstarIterationGate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_iteration_gate",
    label: "Evaluate iteration phase gate",
    description:
      "Evaluate the Morning Star iteration Phase transition gates (mstar-iteration): reads the workflow snapshot ({WORKFLOW_DIR}/<id>/snapshot.json — .mstarc workflow_dir honored, default {harness}/workflows; resolved from the session cwd) and delivery-compass.md frontmatter and runs the engine evaluatePhaseGate (all compass-registered plans Done, close entry checklist, PR-delivery exit checklist). " +
      "`phase` labels the intended transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) for the report; `workflowId` is the workflow id (CLI parity, single safe path component) and `compassPath` is a file path resolved against the session cwd. " +
      "While the control harness's execution authority is ACTIVE the workflow snapshot is retired as a persistence route and this gate refuses execution.consumer-not-ready (its input document carries the plan session bindings the DB adapter does not). " +
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
        const workflowDir = await resolveWorkflowDirOf(harnessDir);
        // §5: before any snapshot/compass read — the gate's input document is
        // retired while the execution authority is ACTIVE.
        const notReady = await executionNotReady(harnessDir);
        if (notReady !== null && "error" in notReady) return notReady.error;
        if (notReady !== null) {
          return result(
            violationLines([{ ok: false, severity: "high", code: notReady.code, message: notReady.message }]),
            { phase: params.phase, workflow_id: params.workflowId, ok: false, execution: { code: notReady.code } },
            true,
          );
        }
        const snapshotPath = join(workflowDir, params.workflowId, "snapshot.json");
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
 // Dynamic engine import : published engine 2.0.2 lacks
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
