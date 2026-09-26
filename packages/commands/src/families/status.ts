import { existsSync } from "node:fs";
import path from "node:path";
import {
  closeWorkflow,
  createFsStore,
  decodeExecutionSessionRef,
  executionContextFor,
  findingsCleanupGate,
  listIssues,
  mutateExecutionWorkflow,
  readExecutionAuthority,
  readJson,
  readWorkflowSnapshot,
  resolveExecutionReadRoute,
  resolveProcessHarnessDir,
  resolveWorkflowDir,
  setArtifactStore,
  unregisterWorkflow,
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
          let target = parsed.data.path;
          if (target === undefined) {
            const harnessDir = executionHarness(context);
            if (harnessDir === null) return refused("status.validate", "status.harness-not-found", "Harness directory not found");
            if ((await resolveExecutionReadRoute({ harnessDir })) === "execution") {
              const read = await readExecutionAuthority({ harnessDir });
              return ok("status.validate", { authority: read.data, token: read.token, workflows: "workflows" in read.data ? read.data.workflows.map((entry) => ({ id: entry.state.id, token: entry.workflowToken })) : [] });
            }
            target = path.join(harnessDir, "status.json");
          } else {
            target = path.resolve(context.cwd, target);
            if (path.basename(target) === "status.json" && (await resolveExecutionReadRoute({ harnessDir: path.dirname(target) })) === "execution") {
              return refused("status.validate", "status.execution-authority-active", "The active execution authority must be validated through its authority reader");
            }
          }
          if (!existsSync(target)) return refused("status.validate", "status.file-not-found", `status file not found: ${target}`);
          if (path.basename(target) === WORKFLOW_SNAPSHOT_FILE) {
            const read = readWorkflowSnapshot(path.dirname(target));
            return ok("status.validate", { path: target, diagnostics: read.diagnostics });
          }
          const gate = validateStatusV2(target);
          return gate.ok
            ? ok("status.validate", { path: target, violations: [] })
            : refused("status.validate", gate.violations[0]?.code ?? "status.invalid", "Status validation failed", { violations: gate.violations });
        } catch (error) {
          return refused("status.validate", engineCode(error, "status.validation-failed"), messageOf(error));
        }
      },
    }),
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
          if (session !== undefined && !path.isAbsolute(session)) {
            return refused("status.workflow-close", "command.invalid-input", "--session must be an absolute path");
          }
          setArtifactStore(createFsStore(harnessDir));
          const snapshotDir = path.join(resolveWorkflowDir(harnessDir, { harnessDir }), workflow);
          const statusFile = path.join(harnessDir, "status.json");
          const closed = await closeWorkflow(workflow, snapshotDir, { endedAt: endedAt ?? todayString(), ...(session ? { sessionPath: session } : {}) });
          let hadRootEntry = false;
          try {
            const rootDoc = readJson(statusFile);
            hadRootEntry = Array.isArray(rootDoc.workflows) && (rootDoc.workflows as Array<Record<string, unknown>>).some((entry) => entry?.id === workflow);
            await unregisterWorkflow(statusFile, workflow);
          } catch (error) {
            throw new Error(`partial close: snapshot ${workflow} is terminal (${closed.status}, ended_at ${closed.ended_at}) but its status.json entry remains — resolve the root and re-run the close (${messageOf(error)})`);
          }
          return ok("status.workflow-close", { snapshot: closed, unregistered: hadRootEntry, statusFile });
        } catch (error) {
          return refused("status.workflow-close", engineCode(error, "workflow.close-refused"), messageOf(error));
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
