import { refusalEnvelope } from "../envelope.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SddScriptError,
  checkSddAction,
  resolveSddExecutionContext,
  reviewPackage,
  sddWorkspace,
  taskBrief,
  type SddExecutionContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";


type SddInput = {
  planId?: string; controlRoot?: string; planFile?: string; taskNumber?: string; outfile?: string; context?: string;
  base?: string; head?: string; kind?: "source" | "artifact" | "launch"; target?: string; request?: string; argv?: string[];
  sddDir?: string; plan?: string; task?: string; run?: string;
};
const verbs = ["workspace", "task-brief", "review-package", "check-context", "evidence.capture", "evidence.verify"] as const;
const sddArgvSchema = z.array(z.string());
const inputSchemas: Record<(typeof verbs)[number], z.ZodType<SddInput>> = {
  workspace: z.object({ planId: z.string().optional(), controlRoot: z.string().optional() }) as z.ZodType<SddInput>,
  "task-brief": z.object({ planFile: z.string().optional(), taskNumber: z.string().optional(), outfile: z.string().optional(), context: z.string().optional() }) as z.ZodType<SddInput>,
  "review-package": z.object({ base: z.string().optional(), head: z.string().optional(), outfile: z.string().optional(), context: z.string().optional() }) as z.ZodType<SddInput>,
  "check-context": z.object({ context: z.string().optional(), kind: z.enum(["source", "artifact", "launch"]).optional(), target: z.string().optional() }) as z.ZodType<SddInput>,
  "evidence.capture": z.object({ request: z.string().optional(), argv: sddArgvSchema.optional() }) as z.ZodType<SddInput>,
  "evidence.verify": z.object({ sddDir: z.string().optional(), plan: z.string().optional(), task: z.string().optional(), run: z.string().uuid().optional(), target: z.string().optional() }) as z.ZodType<SddInput>,
};
const payloads: Partial<Record<(typeof verbs)[number], CommandDefinition["payloads"]>> = {
  "evidence.capture": { argv: { schema: sddArgvSchema, help: "Literal argv passed to the admitted child process." } },
};

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
export function failed(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError && error.exitCode === 2) {
    return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message });
  }
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: error instanceof SddScriptError ? error.exitCode : 1,
    message,
   recovery: id === "sdd.workspace"
        ? "Set the plan id whose SDD workspace is requested and the control root only when it cannot be resolved from the current directory. Run mstar sdd workspace <plan-id>."
        : id === "sdd.task-brief"
          ? "Correct the plan file, task number, and output file. Run mstar sdd task-brief <plan-file> <task-number> <output-file>."
          : id === "sdd.review-package"
            ? "Verify both refs resolve in the feature worktree and choose a writable package path. Run mstar sdd review-package <base> <head> <output-file>."
            : id === "sdd.check-context"
              ? "Align the context document and requested action seam with the resolved SDD execution context. Run mstar sdd check-context."
              : id === "sdd.evidence.capture"
                ? "The exact authorized argv and execution context are required; the evidence destination or child-process failure must be corrected. Run mstar sdd evidence capture <literal-argv...>."
                : "Select the retained evidence bundle by SDD directory, plan, task, and execution identifiers and correct its target or integrity issue. Run mstar sdd evidence verify."});
}
function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  return value;
}
async function readContext(value: string | undefined): Promise<SddExecutionContext | undefined> {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) throw new SddScriptError("--context must be an absolute path", 2);
  const doc: unknown = JSON.parse(readFileSync(value, "utf8"));
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new SddScriptError("context file must contain a JSON object", 2);
  return resolveSddExecutionContext(doc as SddExecutionContext);
}
async function execute(id: string, input: SddInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const verb = id.slice("sdd.".length);
    if (verb === "workspace") {
      return ok(id, { sddDir: sddWorkspace(required(input.planId, "PLAN_ID"), input.controlRoot ? { controlRoot: input.controlRoot } : {}) });
    }
    if (verb === "task-brief") {
      const planFile = required(input.planFile, "PLAN_FILE");
      const taskNumber = required(input.taskNumber, "TASK_NUMBER");
      const bound = await readContext(input.context);
      const outfile = taskBrief(planFile, Number(taskNumber), input.outfile, { cwd: invocation.cwd, ...(bound ? { context: bound } : {}) });
      return ok(id, { outfile });
    }
    if (verb === "review-package") {
      const base = required(input.base, "BASE");
      const head = required(input.head, "HEAD");
      const bound = await readContext(input.context);
      return ok(id, { outfile: reviewPackage(base, head, input.outfile, { cwd: invocation.cwd, ...(bound ? { context: bound } : {}) }) });
    }
    if (verb === "check-context") {
      const context = await readContext(required(input.context, "--context"));
      const kind = required(input.kind, "--kind") as "source" | "artifact" | "launch";
      const gate = checkSddAction(context!, { kind, cwd: invocation.cwd, target: input.target });
      if (!gate.ok) throw new SddScriptError(gate.violations.map(({ code, message }) => `${code}: ${message}`).join("; "), 1);
      return ok(id, { kind, planId: context!.planId });
    }
    if (verb === "evidence.capture") {
      const request = required(input.request, "--request");
      const argv = input.argv ?? [];
      if (argv.length === 0) throw new SddScriptError("argv after -- must include the child executable", 2);
      const capture = invocation.effects.captureSddEvidence;
      if (!capture) throw new SddScriptError("SDD evidence capture is unavailable in this invocation context", 1);
      const result = await capture(request, argv) as { exitCode: number; runDir: string; record: unknown };
      if (result.exitCode === 0) return ok(id, result);
      return {
        version: 1, command: id, status: "error", code: "sdd.evidence.child-exit", exitCode: result.exitCode,
        message: `child exited with status ${result.exitCode}`,
        details: { runDir: result.runDir, record: result.record },
      };
    }
    if (verb === "evidence.verify") {
      const verify = invocation.effects.verifySddEvidence;
      if (!verify) throw new SddScriptError("SDD evidence verification is unavailable in this invocation context", 1);
      const result = await verify({
        sddDir: required(input.sddDir, "--sdd-dir"),
        planId: required(input.plan, "--plan"),
        taskId: required(input.task, "--task"),
        runId: required(input.run, "--run"),
        ...(input.target !== undefined ? { targetPath: input.target } : {}),
      });
      const assessment = result as { integrity?: { ok?: boolean }; applicability?: string; outcome?: string };
      // "passed" requires the recorded run outcome itself (exit 0, not
      // running/spawn-error), not just intact bytes and a usable target: a
      // failed run with no target reads as applicability "not-assessed".
      const assessmentPassed = assessment.outcome === "passed"
        && assessment.integrity?.ok !== false
        && assessment.applicability !== "uncertain"
        && assessment.applicability !== "changed";
      return ok(id, { ...result as Record<string, unknown>, assessmentPassed });
    }
    throw new SddScriptError(`unsupported SDD command: ${id}`, 2);
  } catch (error) {
    return failed(id, error);
  }
}

const contract: Record<(typeof verbs)[number], { path: string[]; arguments: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; required: boolean }[]; effects: CommandDefinition["effects"]; description: string }> = {
  workspace: { path: ["sdd", "workspace"], arguments: [{ key: "planId", required: false, variadic: false }, { key: "controlRoot", required: false, variadic: false }], options: [], effects: ["read", "write"], description: "Resolve and ensure {SDD_DIR} for a plan." },
  "task-brief": { path: ["sdd", "task-brief"], arguments: [{ key: "planFile", required: false, variadic: false }, { key: "taskNumber", required: false, variadic: false }, { key: "outfile", required: false, variadic: false }], options: [{ key: "context", flags: "--context <path>", required: false }], effects: ["read", "write"], description: "Extract the requested plan task section into its SDD brief; missing tasks preserve exit code 3." },
  "review-package": { path: ["sdd", "review-package"], arguments: [{ key: "base", required: false, variadic: false }, { key: "head", required: false, variadic: false }, { key: "outfile", required: false, variadic: false }], options: [{ key: "context", flags: "--context <path>", required: false }], effects: ["read", "write", "process"], description: "Write commits, stat and diff -U10 for BASE..HEAD into a review package." },
  "check-context": { path: ["sdd", "check-context"], arguments: [], options: [{ key: "context", flags: "--context <path>", required: false }, { key: "kind", flags: "--kind <kind>", required: false }, { key: "target", flags: "--target <path>", required: false }], effects: ["read", "validate"], description: "Gate one action seam against a resolved SDD execution context." },
  "evidence.capture": { path: ["sdd", "evidence", "capture"], arguments: [{ key: "argv", required: false, variadic: true }], options: [{ key: "request", flags: "--request <path>", required: false }], effects: ["read", "write", "process"], description: "Capture evidence for an already-authorized literal argv child." },
  "evidence.verify": { path: ["sdd", "evidence", "verify"], arguments: [], options: [{ key: "sddDir", flags: "--sdd-dir <path>", required: false }, { key: "plan", flags: "--plan <id>", required: false }, { key: "task", flags: "--task <id>", required: false }, { key: "run", flags: "--run <uuid>", required: false }, { key: "target", flags: "--target <path>", required: false }], effects: ["read", "validate"], description: "Read-only integrity and applicability assessment of a retained evidence bundle." },
};

function cliDefinition(verb: (typeof verbs)[number]): CommandDefinition<SddInput, unknown> {
  const id = `sdd.${verb}`;
  const shape = contract[verb];
  return {
    id,
    cli: { path: shape.path, aliases: [], arguments: shape.arguments, options: shape.options },
    input: inputSchemas[verb],
    ...(payloads[verb] === undefined ? {} : { payloads: payloads[verb] }),
    output: commandEnvelopeSchema,
    effects: shape.effects,
    description: shape.description,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getSddCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map(cliDefinition);
}
