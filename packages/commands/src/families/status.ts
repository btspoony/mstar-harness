import { existsSync } from "node:fs";
import path from "node:path";
import {
  closeFileWorkflow,
  createFsStore,
  decodeExecutionSessionRef,
  executionContextFor,
  findingsCleanupGate,
  listIssues,
  mutateExecutionWorkflow,
  readExecutionAuthority,
  readWorkflowSnapshot,
  resolveExecutionReadRoute,
  resolveCurrentAuthority,
  resolveIntentRoot,
  resolveIntentTarget,
  resolveProcessHarnessDir,
  resolveWorkflowDir,
  setArtifactStore,
  validateStatusV2,
  WORKFLOW_SNAPSHOT_FILE,
  type ExecutionToken,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const harnessInput = z.object({ harness: z.string().min(1).optional() });

function ok<T>(command: string, data: T): CommandEnvelope<T> {
  return { version: 1, command, status: "ok", code: "status.ok", exitCode: 0, data };
}

function refused(command: string, code: string, message: string, details?: Record<string, unknown>): CommandEnvelope<never> {
  return { version: 1, command, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) };
}

function invalid(command: string, error: z.ZodError): CommandEnvelope<never> {
  return {
    version: 1,
    command,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
  };
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
  if (code === "execution.not-active") return "Complete the supported `store safe-upgrade` workflow, then retry `status validate`.";
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

function todayString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}


function executionHarness(context: InvocationContext, override?: string): string | null {
  return resolveProcessHarnessDir(context.cwd, override);
}

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
      description: "Validate the v2 status register or a workflow snapshot.",
      async execute(input, context) {
        const parsed = z.object({ path: z.string().min(1).optional() }).safeParse(input);
        if (!parsed.success) return invalid("status.validate", parsed.error);
        try {
          const defaultTarget = parsed.data.path === undefined;
          let target = parsed.data.path;
          if (defaultTarget) {
            const harnessDir = executionHarness(context);
            if (harnessDir === null) return refused("status.validate", "status.harness-not-found", "Harness directory not found");
            try {
              const authority = await resolveCurrentAuthority({ harnessDir });
              if (authority.route === "execution") {
                const read = await readExecutionAuthority({ harnessDir });
                return ok("status.validate", { authority: read.data, token: read.token, workflows: "workflows" in read.data ? read.data.workflows.map((entry) => ({ id: entry.state.id, token: entry.workflowToken })) : [], state: "active" });
              }
            } catch (error) {
              const code = engineCode(error, "status.authority-unreadable");
              const cause = messageOf(error);
              const recovery = authorityRecoveryHint(code);
              const originalDetails =
                error !== null && typeof error === "object" && "details" in error && isDetailsRecord(error.details)
                  ? error.details
                  : {};
              return refused("status.validate", code, `${cause} Self-check recovery: ${recovery}`, {
                ...originalDetails,
                selfCheck: { couldNotRead: cause, recovery },
              });
            }
            target = path.join(harnessDir, "status.json");
          } else {
            target = path.resolve(context.cwd, target!);
            if (path.basename(target) === "status.json" && (await resolveExecutionReadRoute({ harnessDir: path.dirname(target) })) === "execution") {
              return refused("status.validate", "status.execution-authority-active", "The active execution authority must be validated through its authority reader");
            }
          }
          if (!existsSync(target)) {
            if (defaultTarget) {
              return refused("status.validate", "status.file-not-found", `status file not found: ${target}`, {
                path: target,
                state: "legacy",
                upgrade: { entry: "mstar store safe-upgrade" },
                selfCheck: { couldNotRead: "legacy status register is missing", recovery: "The legacy upgrade path exists; run mstar store safe-upgrade after supplying its required inputs." },
              });
            }
            return refused("status.validate", "status.file-not-found", `status file not found: ${target}`);
          }
          if (path.basename(target) === WORKFLOW_SNAPSHOT_FILE) {
            const read = readWorkflowSnapshot(path.dirname(target));
            return ok("status.validate", { path: target, diagnostics: read.diagnostics });
          }
          const gate = validateStatusV2(target);
          const data = defaultTarget
            ? { path: target, violations: gate.ok ? [] : gate.violations, state: "legacy", upgrade: { entry: "mstar store safe-upgrade" } }
            : { path: target, violations: gate.ok ? [] : gate.violations };
          return gate.ok
            ? ok("status.validate", data)
            : refused("status.validate", gate.violations[0]?.code ?? "status.invalid", "Status validation failed", { ...data });
        } catch (error) {
          return refused("status.validate", engineCode(error, "status.validation-failed"), messageOf(error));
        }
      },
    }),
    /**
     * Lifecycle close uses the engine's composed file close: it resolves row
     * completion, terminal state and root unregister as one resumable domain
     * operation. The DB route remains the workflow mutation API.
     */
    command({
      id: "status.workflow-close",
      cli: { path: ["status", "workflow-close"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true },
        { key: "harness", flags: "--harness <path>", required: false },
        { key: "endedAt", flags: "--ended-at <date>", required: false },
        { key: "session", flags: "--session <path>", required: false },
        { key: "sessionRef", flags: "--session-ref <wire>", required: false },
        { key: "expect", flags: "--expect <token>", required: false },
        { key: "operation", flags: "--operation <id>", required: false },
        { key: "reason", flags: "--reason <text>", required: false },
        { key: "json", flags: "--json", required: false },
        { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" },
      ] },
      input: z.object({
        workflow: z.string().min(1), harness: z.string().min(1).optional(), endedAt: z.string().optional(), session: z.string().optional(),
        sessionRef: z.string().optional(), expect: z.string().optional(), operation: z.string().optional(), reason: z.string().optional(), json: z.boolean().optional(),
      }),
      output,
      effects: ["write"],
      description: "Close a workflow only after engine lifecycle and delivery guards pass.",
      async execute(input, context) {
        const schema = z.object({
          workflow: z.string().min(1), harness: z.string().min(1).optional(), endedAt: z.string().optional(), session: z.string().optional(),
          sessionRef: z.string().optional(), expect: z.string().optional(), operation: z.string().optional(), reason: z.string().optional(), json: z.boolean().optional(),
        });
        const parsed = schema.safeParse(input);
        if (!parsed.success) return invalid("status.workflow-close", parsed.error);
        const { workflow, harness, endedAt, session } = parsed.data;
        if (workflow === "." || workflow === ".." || workflow.includes("/") || workflow.includes("\\")) {
          return refused("status.workflow-close", "workflow.invalid-id", `invalid workflow id ${JSON.stringify(workflow)}`);
        }
        try {
          const harnessDir = executionHarness(context, harness);
          if (harnessDir === null) return refused("status.workflow-close", "status.harness-not-found", "Harness directory not found");
          const activeFields = [parsed.data.sessionRef, parsed.data.expect, parsed.data.operation];
          const activeRequested = activeFields.some((field) => field !== undefined);
          const active = (await resolveExecutionReadRoute({ harnessDir })) === "execution";
          if (activeRequested || active) {
            if (active && !activeRequested) {
              return refused("status.workflow-close", "execution.consumer-not-ready", "File-based workflow close is unavailable while active execution authority is enabled");
            }
            if (endedAt !== undefined || session !== undefined) {
              return { version: 1, command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active execution close cannot combine --ended-at or --session with its CAS envelope" };
            }
            if (activeFields.some((field) => field === undefined) || parsed.data.reason === undefined || parsed.data.reason.trim() === "") {
              return { version: 1, command: "status.workflow-close", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active execution close requires --session-ref, --expect, --operation, and --reason" };
            }
            if (context.sessionId === undefined || context.sessionId.trim() === "") {
              return refused("status.workflow-close", "coordination.identity-missing", "The invocation has no acquired main-session identity");
            }
            const executionContext = executionContextFor(
              { harnessDir },
              { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: workflow, role: "coordinator", planId: null },
            );
            const receipt = await mutateExecutionWorkflow(executionContext, {
              workflowId: workflow,
              session: decodeExecutionSessionRef(parsed.data.sessionRef!),
              expected: parsed.data.expect as ExecutionToken,
              operationId: parsed.data.operation!,
              operation: { kind: "lifecycle", status: "completed", reason: parsed.data.reason },
            });
            return ok("status.workflow-close", receipt);
          }
          const rootResolution = resolveIntentRoot({
            cwd: context.cwd,
            ...(harnessDir === undefined ? {} : { controlRoot: harnessDir }),
          });
          if (!rootResolution.ok) throw Object.assign(new Error(rootResolution.problem.needed), {
            code: rootResolution.problem.code,
            details: { recovery: { unresolved: [rootResolution.problem] } },
          });
          const target = resolveIntentTarget({ root: rootResolution.root, selection: { workflowId: workflow } });
          if (!target.ok) throw Object.assign(new Error(target.problem.needed), {
            code: target.problem.code,
            details: { recovery: { unresolved: [target.problem] } },
          });
          setArtifactStore(createFsStore(rootResolution.root));
          const closed = await closeFileWorkflow({
            harnessRoot: rootResolution.root,
            workflowId: target.workflowId,
            endedAt: endedAt ?? todayString(),
            ...(session === undefined ? {} : { sessionPath: session }),
          });
          return ok("status.workflow-close", { ...closed, statusFile: path.join(rootResolution.root, "status.json") });
        } catch (error) {
          // A refused close reports the engine's own typed cause: the field
          // facts and the `recovery` sidecar travel with the code and message.
          const details =
            error !== null && typeof error === "object" && "details" in error && isDetailsRecord(error.details)
              ? error.details
              : undefined;
          return refused("status.workflow-close", engineCode(error, "workflow.close-refused"), messageOf(error), details);
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
          return gate.ok ? ok("status.findings-cleanup", { planId: parsed.data.planId, violations: [] }) : refused("status.findings-cleanup", gate.violations[0]?.code ?? "findings.cleanup-refused", "Findings cleanup gate failed", { violations: gate.violations });
        } catch (error) {
          return refused("status.findings-cleanup", engineCode(error, "findings.cleanup-refused"), messageOf(error));
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
          return refused("status.tech-debt", engineCode(error, "issue.store-refused"), messageOf(error));
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
        );
      },
    })),
  ];
}

export type StatusCommandId = "status.validate" | "status.workflow-close" | "status.archive-residuals" | "status.findings-cleanup" | "status.tech-debt" | "status.backlog-register" | "status.backlog-close";
