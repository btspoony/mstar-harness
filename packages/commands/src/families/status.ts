import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  decodeExecutionSessionRef,
  executionContextFor,
  findingsCleanupGate,
  listIssues,
  mutateExecutionWorkflow,
  readExecutionAuthority,
  readWorkflowSnapshot,
  resolveExecutionReadRoute,
  resolveCurrentAuthority,
  resolveProcessHarnessDir,
  validateStatusV2,
  WORKFLOW_SNAPSHOT_FILE,
  WorkflowSnapshotValidationError,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import { SESSION_REF_SUPPLIES, TOKEN_SUPPLIES } from "../identity-supplies.js";
import { engineErrorFacts } from "./family-refusal.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const harnessInput = z.object({ harness: z.string().min(1).optional() });

function ok<T>(command: string, data: T): CommandEnvelope<T> {
  return { version: 1, command, status: "ok", code: "status.ok", exitCode: 0, data };
}

function refused(command: string, code: string, message: string, details?: Record<string, unknown>, recovery?: string): CommandEnvelope<never> {
  return refusalEnvelope({ command, status: "refused", code, exitCode: 1, message, details: details ?? {}, recovery: recovery ?? "Correct the reported status or workflow condition, then rerun the command." });
}

function invalid(command: string, error: z.ZodError): CommandEnvelope<never> {
  return refusalEnvelope({
    command, status: "usage", code: "command.invalid-input", exitCode: 2,
    message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineCode(error: unknown, fallback: string): string {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error !== null && typeof error === "object" && "violations" in error && Array.isArray(error.violations)) {
    const first = error.violations[0];
    if (first !== null && typeof first === "object" && "code" in first && typeof first.code === "string") return first.code;
  }
  return fallback;
}
function authorityRecoveryHint(code: string): string {
  if (code === "store.busy") return "Wait for the competing store writer to finish, then retry `status validate`.";
  if (code === "store.corrupt") return "Preserve the corrupt database and legacy sources; restore through a supported recovery process or provide the full refusal to the store recovery owner. An unreadable live store cannot be recovered by online restore-preview.";
  if (code === "store.runtime-unsupported") return "Run with a supported Bun or Node runtime with native SQLite support, then retry `status validate`.";
  if (code === "store.schema-unsupported") return "Use a harness build that supports this store schema, then retry `status validate`.";
  if (code === "store.schema-drift") return "Use the harness build that owns the applied schema and retry `status validate`.";
  if (code === "execution.not-active") return "Run `mstar store upgrade --operator <name>` to import legacy state and activate authority, then retry `status validate`.";
  return "Restore the store file, schema, or runtime capability indicated by the cause, then retry `status validate`.";
}

/**
 * The typed details a refusal carries (`error.details`: the field facts and the
 * `recovery` sidecar) are forwarded verbatim, so a command refusal is the same
 * contract as the engine's own — never reduced to its code and message.
 */
function isDetailsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function executionHarness(context: InvocationContext, override?: string): string | null {
  return resolveProcessHarnessDir(context.cwd, override);
}

/**
 * The retired file close route's inputs stay RECOGNIZED so their use is a named
 * refusal that states the ACTIVE route, not commander's generic unknown-option
 * usage. The help text carries the same statement to `--help`.
 */
const RETIRED_FILE_CLOSE_HELP =
  "retired file-close transport: the terminal timestamp and coordinator envelope belong to the pre-activation route. " +
  "This verb closes through the ACTIVE execution authority; the authority records the terminal timestamp itself.";

/** The one recovery sentence every retired-file-input refusal carries. */
const ACTIVE_CLOSE_RECOVERY =
  "Close through the ACTIVE execution authority: bind the workflow's coordinator (mstar plan bind --execution --workflow <id> --coordinator), " +
  "then run mstar status workflow-close --workflow <id> --reason <text>. A control root with no ACTIVE authority is created with mstar harness scaffold then mstar store init (or mstar store upgrade to import historical file state).";

function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> {
  return definition;
}

export function getStatusCommandDefinitions(): readonly CommandDefinition[] {
  const output = commandEnvelopeSchema;
  return [
    command({
      id: "status.validate",
      cli: { path: ["status", "validate"], aliases: [], arguments: [{ key: "path", required: false, variadic: false }], options: [] },
      input: z.object({ path: z.string().min(1).optional() }),
      output,
      effects: ["read", "validate"],
      description: "Validate the v2 status register or a workflow snapshot. Under an ACTIVE execution authority the output carries the execution CAS tokens a caller records as --expect: the store's root token at data.token, each workflow's token at data.workflows[].token, and each plan's token at data.authority.workflows[].planTokens[<planId>].",
      async execute(input, context) {
        const parsed = z.object({ path: z.string().min(1).optional() }).safeParse(input);
        if (!parsed.success) return invalid("status.validate", parsed.error);
        try {
          const defaultTarget = parsed.data.path === undefined;
          let target = parsed.data.path;
          const legacyUpgradeEntry = "mstar store upgrade --operator <name>";
          const legacyUpgradeDetails: { entry: string; limitation?: string } = { entry: legacyUpgradeEntry };
          if (defaultTarget) {
            const harnessDir = executionHarness(context);
            if (harnessDir === null) return refused("status.validate", "status.harness-not-found", "Harness directory not found", undefined, "Run mstar harness scaffold to create the harness directory, then rerun mstar status validate.");
            try {
              const authority = await resolveCurrentAuthority({ harnessDir });
              if (authority.route === "execution") {
                const read = await readExecutionAuthority({ harnessDir });
                return ok("status.validate", {
                  authority: read.data,
                  token: read.token,
                  workflows: "workflows" in read.data ? read.data.workflows.map((entry) => ({ id: entry.state.id, token: entry.workflowToken })) : [],
                  terminalUnregistered: "terminalUnregistered" in read.data ? read.data.terminalUnregistered : [],
                  terminalAdoptions: "terminalAdoptions" in read.data ? read.data.terminalAdoptions : [],
                  state: "active",
                });
              }
            } catch (error) {
              const code = engineCode(error, "status.authority-unreadable");
              const cause = messageOf(error);
              const recovery = authorityRecoveryHint(code);
              const originalDetails =
                error !== null && typeof error === "object" && "details" in error && isDetailsRecord(error.details)
                  ? error.details
                  : {};
              return refused("status.validate", code || "status.authority-unreadable", `${cause} Self-check recovery: ${recovery}`, {
                ...originalDetails,
                state: "unreadable",
                selfCheck: { couldNotRead: cause, recovery },
              }, "Correct the store or runtime problem named in the self-check recovery, then run mstar status validate.");
            }
            target = path.join(harnessDir, "status.json");
          } else {
            target = path.resolve(context.cwd, target!);
            if (path.basename(target) === "status.json" && (await resolveExecutionReadRoute({ harnessDir: path.dirname(target) })) === "execution") {
              return refused("status.validate", "status.execution-authority-active", "The active execution authority must be validated through its authority reader", undefined, "Run mstar status validate to read the active execution authority instead of this status file.");
            }
          }
          if (!existsSync(target)) {
            if (defaultTarget) {
              return refused("status.validate", "status.file-not-found", `status file not found: ${target}`, {
                path: target,
                state: "legacy",
                upgrade: legacyUpgradeDetails,
                selfCheck: {
                  couldNotRead: "legacy status register is missing",
                  recovery: "Run `mstar store upgrade --operator <name>` to create or upgrade the store, import recognizable workflows, and report skipped items without moving their source files.",
                },
              }, "Run mstar store upgrade --operator <name> to create the store, import recognizable workflows, and report skipped items, then rerun mstar status validate.");
            }
            return refused("status.validate", "status.file-not-found", `status file not found: ${target}`, undefined, "Restore or create the status file at the reported path, then run mstar status validate.");
          }
          if (path.basename(target) === WORKFLOW_SNAPSHOT_FILE) {
            const read = readWorkflowSnapshot(path.dirname(target));
            return ok("status.validate", { path: target, diagnostics: read.diagnostics });
          }
          const gate = validateStatusV2(target);
          const data = defaultTarget
            ? { path: target, violations: gate.ok ? [] : gate.violations, state: "legacy", upgrade: legacyUpgradeDetails }
            : { path: target, violations: gate.ok ? [] : gate.violations };
          return gate.ok
            ? ok("status.validate", data)
            : refused("status.validate", gate.violations[0]?.code ?? "status.invalid", "Status validation failed", { ...data }, "Resolve each status validation violation reported in the details, then run mstar status validate.");
        } catch (error) {
          // The engine's own refusal facts travel verbatim at this mapper too:
          // a typed store/authority error keeps its code, its `details` record
          // (e.g. the distinct schema-unsupported version facts) and any
          // recovery it authors, instead of collapsing to code plus prose.
          const { code, details, recovery } = engineErrorFacts(error);
          const snapshotCode = error instanceof WorkflowSnapshotValidationError ? error.violations[0]?.code : undefined;
          const failureMessage = recovery === undefined ? messageOf(error) : `${messageOf(error)}\nRecovery: ${recovery}`;
          const fallbackRecovery = recovery ?? "Correct the invalid snapshot field, then run mstar status validate again.";
          return refusalEnvelope({
            command: "status.validate",
            status: "refused",
            code: snapshotCode ?? code ?? "status.validation-failed",
            exitCode: 1,
            message: failureMessage,
            details: details ?? {},
            recovery: fallbackRecovery,
          });
        }
      },
    }),
    /**
     * Lifecycle close runs on the ACTIVE execution authority only: the close is
     * the workflow mutation API's terminal `lifecycle` transition, which
     * resolves the plan-row completion prerequisite, the terminal state and the
     * root unregister as one transaction. The pre-activation file route is
     * retired, so `closeFileWorkflow` and the file-route root/target resolution
     * are gone with it; a control root that holds no ACTIVE authority is refused
     * with the ACTIVE route's own recovery instead of falling back to files.
     */
    command({
      id: "status.workflow-close",
      cli: { path: ["status", "workflow-close"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: false },
        { key: "harness", flags: "--harness <path>", required: false },
        { key: "endedAt", flags: "--ended-at <date>", required: false, help: RETIRED_FILE_CLOSE_HELP },
        { key: "session", flags: "--session <path>", required: false, help: RETIRED_FILE_CLOSE_HELP },
        { key: "sessionRef", flags: "--session-ref <wire>", required: false, help: SESSION_REF_SUPPLIES },
        { key: "expect", flags: "--expect <token>", required: false, help: `CAS expectation: ${TOKEN_SUPPLIES.workflow}` },
        { key: "operation", flags: "--operation <id>", required: false },
        { key: "reason", flags: "--reason <text>", required: false },
        { key: "json", flags: "--json", required: false },
        { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" },
      ] },
      input: z.object({
        workflow: z.string().min(1).optional(), harness: z.string().min(1).optional(), endedAt: z.string().optional(), session: z.string().optional(),
        sessionRef: z.string().optional(), expect: z.string().optional(), operation: z.string().optional(), reason: z.string().optional(), json: z.boolean().optional(),
      }),
      output,
      effects: ["write"],
      description: "Close a workflow only after engine lifecycle and delivery guards pass.",
      async execute(input, context) {
        const schema = z.object({
          workflow: z.string().min(1).optional(), harness: z.string().min(1).optional(), endedAt: z.string().optional(), session: z.string().optional(),
          sessionRef: z.string().optional(), expect: z.string().optional(), operation: z.string().optional(), reason: z.string().optional(), json: z.boolean().optional(),
        });
        const parsed = schema.safeParse(input);
        if (!parsed.success) return invalid("status.workflow-close", parsed.error);
        const workflow = parsed.data.workflow ?? context.executionIdentity?.workflowId;
        if (workflow === undefined) {
          return refusalEnvelope({
            command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2,
            message: "workflow selector or acquired workflow identity is required",
          });
        }
        if (workflow === "." || workflow === ".." || workflow.includes("/") || workflow.includes("\\")) {
          return refused("status.workflow-close", "workflow.invalid-id", `invalid workflow id ${JSON.stringify(workflow)}`, undefined, "Rerun mstar status workflow-close with a valid registered workflow id.");
        }
        // The file-close transport is retired, so a caller that supplies one of
        // its inputs is told the cause and the ACTIVE route rather than being
        // answered by a fallback that no longer exists.
        const retiredInput = parsed.data.endedAt === undefined
          ? (parsed.data.session === undefined ? undefined : "--session")
          : "--ended-at";
        if (retiredInput !== undefined) {
          return refusalEnvelope({
            command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2,
            message:
              `workflow-close runs on the ACTIVE execution authority only: ${retiredInput} belongs to the retired file close route, ` +
              "and its terminal timestamp is the authority's own. Nothing was written.",
            recovery: ACTIVE_CLOSE_RECOVERY,
          });
        }
        try {
          const harnessDir = executionHarness(context, parsed.data.harness);
          if (harnessDir === null) return refused("status.workflow-close", "status.harness-not-found", "Harness directory not found", undefined, "Run mstar harness scaffold then mstar store init to create an ACTIVE control root, then rerun the close.");
          if (context.sessionId === undefined || context.sessionId.trim() === "") {
            return refused(
              "status.workflow-close",
              "coordination.identity-missing",
              "This close needs an acquired coordinator identity: launch `mstar session run --workflow <id> --role coordinator -- <argv>` for a minted identity, or pass an explicit acquired `--session-id`; a launch does not bind, so first establish the binding with `mstar plan bind --execution --workflow <id> --coordinator`.",
              undefined,
              "Acquire a coordinator identity for this workflow, then rerun mstar status workflow-close.",
            );
          }
          const acquired = context.executionIdentity;
          if (acquired !== undefined && (acquired.workflowId !== workflow || acquired.role !== "coordinator")) {
            return refused("status.workflow-close", "coordination.identity-mismatch", "acquired caller identity does not address this workflow's coordinator seat", undefined, "Rerun mstar status workflow-close after acquiring the coordinator identity that addresses this workflow.");
          }
          const executionContext = executionContextFor(
            { harnessDir },
            acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator" },
          );
          const ref = parsed.data.sessionRef === undefined ? undefined : decodeExecutionSessionRef(parsed.data.sessionRef);
          if (ref !== undefined && (ref.workflowId !== workflow || ref.role !== "coordinator")) {
            return refused("status.workflow-close", "coordination.identity-mismatch", "sessionRef must address this workflow's coordinator seat", undefined, "Rerun mstar status workflow-close after acquiring the coordinator identity that owns this sessionRef.");
          }
          const receipt = await mutateExecutionWorkflow(executionContext, {
            workflowId: workflow,
            ...(ref === undefined ? {} : { session: ref }),
            ...(parsed.data.expect === undefined ? {} : { expected: parsed.data.expect as ExecutionToken }),
            operationId: parsed.data.operation ?? randomUUID(),
            operation: { kind: "lifecycle", status: "completed", reason: parsed.data.reason ?? "closed through status workflow-close" },
          });
          return ok("status.workflow-close", receipt);
        } catch (error) {
          // A refused close reports the engine's own typed cause verbatim (code,
          // message and `details`), and the recovery names the ACTIVE route: the
          // file route is retired, so a store-less or pre-cutover control root is
          // a routing problem, never a reason to fall back to files.
          const code = engineCode(error, "workflow.close-refused");
          const details =
            error !== null && typeof error === "object" && "details" in error && isDetailsRecord(error.details)
              ? error.details
              : undefined;
          const recovery =
            code === "execution.not-active" || code === "store.not-initialized" || code === "store.not-active"
              ? "Select the control root that holds the workflow's ACTIVE execution authority, or create one with mstar harness scaffold then mstar store init (or mstar store upgrade to import historical file state); the file close route is retired and never falls back."
              : code === "coordination.scope-mismatch" || code === "coordination.harness-not-found" || code === "coordination.git-unavailable"
                ? "Select the control root that holds the workflow, then rerun mstar status workflow-close."
                : code === "coordination.invalid-input" || code === "coordination.workflow-not-found" || code === "coordination.plan-not-found"
                  ? "Select a workflow and plan this control root's ACTIVE authority holds, then rerun mstar status workflow-close."
                  : "Correct the reported workflow lifecycle problem, then rerun mstar status workflow-close.";
          return refused("status.workflow-close", code || "workflow.close-refused", messageOf(error), details, recovery);
        }
      },
    }),
    command({
      id: "status.archive-residuals",
      cli: { path: ["status", "archive-residuals"], aliases: [], arguments: [], options: [] },
      input: z.object({}), output, effects: [], description: "Retired command; refuses without mutation.",
      async execute() {
        return refused(
          "status.archive-residuals",
          "status.verb-retired",
          "status archive-residuals: removed — findings are issues in {HARNESS_DIR}/store.db; close one with `mstar plan issue-close` (plan-scoped) or `mstar issue close|waive|duplicate|supersede` (unscoped) instead",
          undefined,
          "Close the finding with mstar plan issue-close, then list what remains with mstar issue list.",
        );
      },
    }),
    command({
      id: "status.findings-cleanup",
      cli: { path: ["status", "findings-cleanup"], aliases: [], arguments: [{ key: "planId", required: true, variadic: false }], options: [
        { key: "harness", flags: "--harness <path>", required: false },
        { key: "mode", flags: "--mode <mode>", required: false },
      ] },
      input: z.object({ planId: z.string().min(1), harness: z.string().min(1).optional(), mode: z.enum(["zero-residual", "allow-residual"]).optional() }),
      output, effects: ["read", "validate"], description: "Enforce the findings-cleanup gate against the issue store.",
      async execute(input, context) {
        const schema = z.object({ planId: z.string().min(1), harness: z.string().min(1).optional(), mode: z.enum(["zero-residual", "allow-residual"]).optional() });
        const parsed = schema.safeParse(input);
        if (!parsed.success) return invalid("status.findings-cleanup", parsed.error);
        try {
          const harnessDir = executionHarness(context, parsed.data.harness) ?? parsed.data.harness ?? context.cwd;
          const gate = await findingsCleanupGate({ harnessDir }, parsed.data.planId, parsed.data.mode ? { mode: parsed.data.mode } : undefined);
          return gate.ok ? ok("status.findings-cleanup", { planId: parsed.data.planId, violations: [] }) : refused("status.findings-cleanup", gate.violations[0]?.code ?? "findings.cleanup-refused", "Findings cleanup gate failed", { violations: gate.violations }, "Resolve each reported findings-cleanup violation, then rerun mstar status findings-cleanup <plan-id>.");
        } catch (error) {
          const code = engineCode(error, "findings.cleanup-refused");
          return refused("status.findings-cleanup", code || "findings.cleanup-refused", messageOf(error), undefined, "Correct the reported findings-cleanup problem, then rerun mstar status findings-cleanup <plan-id>.");
        }
      },
    }),
    command({
      id: "status.tech-debt",
      cli: { path: ["status", "tech-debt"], aliases: [], arguments: [], options: [{ key: "harness", flags: "--harness <path>", required: false }] },
      input: harnessInput, output, effects: ["read"], description: "Read the open issue rollup from the issue store.",
      async execute(input, context) {
        const parsed = harnessInput.safeParse(input);
        if (!parsed.success) return invalid("status.tech-debt", parsed.error);
        try {
          const harnessDir = executionHarness(context, parsed.data.harness) ?? parsed.data.harness ?? context.cwd;
          const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          const byProject: Record<string, number> = {};
          let totalOpen = 0;
          for (let offset = 0; ; offset += 200) {
            const page = await listIssues({ harnessDir }, { disposition: "open", limit: 200, offset });
            totalOpen = page.total;
            for (const issue of page.items) {
              bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
              byProject[issue.projectId] = (byProject[issue.projectId] ?? 0) + 1;
            }
            if (page.items.length === 0 || offset + page.items.length >= page.total) break;
          }
          return ok("status.tech-debt", { total_open: totalOpen, by_severity: bySeverity, by_project: Object.fromEntries(Object.entries(byProject).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) });
        } catch (error) {
          const code = engineCode(error, "issue.store-refused");
          return refused("status.tech-debt", code || "issue.store-refused", messageOf(error), undefined, "Correct the reported issue-store problem, then run mstar status tech-debt.");
        }
      },
    }),
    ...([["backlog-register", "plan issue-add"], ["backlog-close", "plan issue-close"]] as const).map(([verb, replacement]) => command({
      id: `status.${verb}`,
      cli: { path: ["status", verb], aliases: [], arguments: [], options: [] },
      input: z.object({}), output, effects: [], description: "Retired command; refuses without mutation.",
      async execute() {
        return refused(
          `status.${verb}`,
          "status.verb-retired",
          `status ${verb}: removed — project registers are migration history; findings are issues in {HARNESS_DIR}/store.db (capture/close via \`mstar ${replacement}\`, or the unscoped \`mstar issue add|close\`); this verb writes nothing`,
          undefined,
          "Use mstar plan issue-add to capture the finding and mstar plan issue-close to close it.",
        );
      },
    })),
  ];
}

export type StatusCommandId = "status.validate" | "status.workflow-close" | "status.archive-residuals" | "status.findings-cleanup" | "status.tech-debt" | "status.backlog-register" | "status.backlog-close";
