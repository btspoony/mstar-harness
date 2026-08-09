/**
 * mstar_dispatch_validate — validate a Morning Star Assignment document
 * via the engine dispatch gates.
 *
 * Composition is the engine's single shared `dispatch.composeDispatchGate`
 * (qc1 F-001/F-006 — the same composition the opencode adapter and the omp
 * blocking hook use): field validation, anti-recursion precheck when `agent`
 * is provided, the default-branch gate (incl. the `$MSTAR_WORKING_BRANCH`
 * env fallback) and the header-region enforcement flag. Read-only roles
 * (scout/explore, or the `readOnlyRole` flag) skip the branch-form and
 * default-branch gates. No local rule logic — every check is an engine call.
 *
 * `composeDispatchGate` is imported DYNAMICALLY (module-level cached loader,
 * `loadComposeDispatchGate`) so the tool stays loadable against published
 * engine versions that predate the export (2.0.2): a missing export is a
 * clear upgrade error instead of a module-load failure that silently drops
 * the tool (parity with `mstar_iteration_gate`).
 */
import { isReadOnlyAssignmentRole, parseAssignmentFields } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

type Params = { assignmentText: string; agent?: string; readOnlyRole?: boolean };

/**
 * Engine-version compat (parity with the omp hook): `composeDispatchGate`
 * postdates published engine 2.0.2 — a static named import would fail at
 * module link and silently drop the tool from /extensions. The loader
 * resolves to `null` on builds lacking the export; `execute` turns that
 * into an explicit upgrade error.
 */
type DispatchGateFn = (text: string, options?: { agent?: string; writable?: boolean }) => {
  ok: boolean;
  shaped: boolean;
  enforcement: { hard: boolean };
  violations: ValidationResult[];
};

let cachedDispatchGate: Promise<DispatchGateFn | null> | null = null;

export function loadComposeDispatchGate(): Promise<DispatchGateFn | null> {
  cachedDispatchGate ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.composeDispatchGate === "function" ? (mod.composeDispatchGate as DispatchGateFn) : null,
    )
    .catch(() => null);
  return cachedDispatchGate;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without `composeDispatchGate`. */
export const composeDispatchGateLoader: { load: () => Promise<DispatchGateFn | null> } = {
  load: loadComposeDispatchGate,
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
      }),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        const text = params?.assignmentText ?? "";
        if (text.trim() === "") {
          return result("mstar_dispatch_validate: assignmentText is required", { ok: false }, true);
        }
        // Dynamic engine load (qc3 F-001 parity with mstar_iteration_gate):
        // published engine 2.0.2 lacks composeDispatchGate — a static named
        // import would fail at module link and silently drop the tool. The
        // runtime check degrades to an explicit upgrade error instead.
        const composeDispatchGate = await composeDispatchGateLoader.load();
        if (composeDispatchGate === null) {
          return result(
            "installed @mstar-harness/engine lacks composeDispatchGate — upgrade the engine (next release); CLI fallback: mstar dispatch validate",
            { ok: false },
            true,
          );
        }
        const fields = parseAssignmentFields(text);
        const readOnly = params?.readOnlyRole === true || isReadOnlyAssignmentRole(fields.executeAs ?? "");
        const composed = composeDispatchGate(text, {
          agent: params?.agent ?? "",
          writable: readOnly ? false : undefined,
        });
        return result(
          composed.ok ? "assignment ok" : violationLines(composed.violations),
          {
            ok: composed.ok,
            shaped: composed.shaped,
            enforcement: composed.enforcement,
            violations: composed.violations,
            execute_as: fields.executeAs ?? null,
            read_only: readOnly,
            agent: (params?.agent ?? "").trim() !== "" ? params?.agent : null,
          },
          !composed.ok,
        );
      } catch (error) {
        return result(`mstar_dispatch_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
