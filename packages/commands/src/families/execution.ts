import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SddScriptError,
  exportExecutionState,
  previewExecutionRestore,
  resolveProcessHarnessDir,
  restoreExecutionBackup,
  type ExecutionRecoveryPreview,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  harness: z.string().optional(),
  out: z.string().optional(),
  backup: z.string().optional(),
  operator: z.string().optional(),
  preview: z.string().optional(),
  authorization: z.string().optional(),
});
type ExecutionInput = z.infer<typeof inputSchema>;
const verbs = ["restore-preview", "restore", "export"] as const;
const writeVerbs: Record<string, true> = { restore: true };

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return error instanceof SddScriptError
    ? refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message, ...(details === undefined ? {} : { details }) })
    : refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) });
}
function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  return value.trim();
}
function absolute(value: string | undefined, flag: string, optional = false): string | undefined {
  if (value === undefined || (optional && value.trim() === "")) return undefined;
  if (!path.isAbsolute(value)) throw new SddScriptError(`${flag} must be an absolute path`, 2);
  return value;
}
function readJson(value: string | undefined, flag: string): Record<string, unknown> {
  const file = absolute(required(value, flag), flag)!;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; }
  catch (error) { throw new SddScriptError(`${flag} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, 2); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SddScriptError(`${flag} must contain a JSON object`, 2);
  return parsed as Record<string, unknown>;
}
function requireInputs(input: ExecutionInput, fields: readonly (keyof ExecutionInput)[]): void {
  const missing = fields.filter((field) => {
    const value = input[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new SddScriptError(
      `${missing.map((field) => `--${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
      2,
    );
  }
}
function executionContext(input: ExecutionInput, invocation: InvocationContext, verb: string): StoreContext {
  const harness = absolute(input.harness, "--harness");
  const root = resolveProcessHarnessDir(invocation.cwd, harness);
  if (root === null) throw new SddScriptError(`${verb}: no target harness was resolved; pass --harness <absolute-path>`, 2);
  if (invocation.controlRoot !== null && path.resolve(root) === path.resolve(invocation.controlRoot)) {
    throw new SddScriptError(`${verb}: the control-root store is not an admitted execution target`, 2);
  }
  return { harnessDir: root };
}
function document<T>(value: string | undefined, flag: string): T {
  return readJson(value, flag) as T;
}

async function execute(id: string, input: ExecutionInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const verb = id.slice("store.execution.".length);
    const context = executionContext(input, invocation, `store execution ${verb}`);
    if (verb === "restore-preview") {
      const backupPath = absolute(required(input.backup, "--backup"), "--backup")!;
      const preview = await previewExecutionRestore(context, backupPath);
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, `${JSON.stringify(preview, null, 2)}\n`);
      return ok(id, { ...preview, previewFile: out ?? null });
    }
    if (verb === "restore") {
      const operator = required(input.operator, "--operator");
      const authorization = required(input.authorization, "--authorization");
      const preview = document<ExecutionRecoveryPreview>(input.preview, "--preview");
      if (typeof preview.lossDigest !== "string") throw new SddScriptError("--preview is not the object `store execution restore-preview` produced", 2);
      const receipt = await restoreExecutionBackup(context, { preview, operator, authorization });
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
      return ok(id, { ...receipt, receiptFile: out ?? null });
    }
    if (verb === "export") {
      const artifact = await exportExecutionState(context);
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, artifact.canonicalJson.endsWith("\n") ? artifact.canonicalJson : `${artifact.canonicalJson}\n`);
      return ok(id, { format: artifact.format, sha256: artifact.sha256, out: out ?? null, canonicalJson: artifact.canonicalJson });
    }
    throw new Error(`unsupported store execution command ${id}`);
  } catch (error) { return refused(id, error); }
}

function cliDefinition(id: string): CommandDefinition<ExecutionInput, unknown> {
  const verb = id.slice("store.execution.".length) as (typeof verbs)[number];
  const flags: Record<keyof ExecutionInput, string> = {
    harness: "--harness <path>", out: "--out <path>", backup: "--backup <path>", operator: "--operator <name>",
    preview: "--preview <path>", authorization: "--authorization <ref>",
  };
  const optionsByVerb: Record<(typeof verbs)[number], (keyof ExecutionInput)[]> = {
    "restore-preview": ["harness", "backup", "out"],
    restore: ["harness", "operator", "authorization", "preview", "out"],
    export: ["harness", "out"],
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof ExecutionInput]?: true };
  const options = optionKeys.map((key) => ({ key, flags: flags[key], required: false }));
  return {
    id,
    cli: { path: ["store", "execution", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    output: commandEnvelopeSchema,
    effects: writeVerbs[verb] === true ? ["read", "write"] : ["read"],
    description: verb === "export"
      ? "Export the current execution state as a canonical reporting artifact."
      : `Store execution ${verb} from a standalone store backup.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getExecutionCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.execution.${verb}`));
}
