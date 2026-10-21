import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SddScriptError,
  exportExecutionState,
  previewExecutionRestore,
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
/**
 * The refusal for an operation target the call did not name as an absolute
 * path.
 *
 * These actions run ROOT-FREE (`ROOT_FREE_COMMANDS`): with no connection root
 * the invocation workspace stays at the MCP server's launch directory, which is
 * the HOST's checkout. Discovering a store from it is exactly the launch-cwd
 * rooting the connection rule removes, and `restore` WRITES to the store it
 * finds, so the target is a required INPUT here and is never discovered.
 */
function targetRefusal(id: string, supplied: string): CommandEnvelope {
  const relative = supplied !== "";
  return refusalEnvelope({
    command: id,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: relative
      ? `${id}: the operation target must be an absolute path; a relative "harness" would resolve against the invocation directory instead of naming the store this call reads or restores`
      : `${id} needs the operation's target: it names the store this call reads or restores, and this action never discovers one from the invocation directory`,
    helpRoute: `mstar schema --command ${id}`,
    recovery: "Pass `harness` naming the harness directory this operation targets, as an ABSOLUTE path. A pinned MCP connection still takes the target from that field, never from its control root.",
    diagnostics: [{
      path: "harness",
      code: relative ? "invalid_type" : "required",
      message: relative ? "harness must be an absolute path" : "harness is required: the operation target is never discovered from the invocation directory",
      expected: "absolute path",
      received: relative ? "relative path" : "undefined",
    }],
  });
}
function executionContext(target: string, invocation: InvocationContext, verb: string): StoreContext {
  // `target` is an absolute path (validated by the caller): resolving an
  // absolute value never consults the invocation directory.
  const root = path.resolve(target);
  if (invocation.controlRoot !== null && root === path.resolve(invocation.controlRoot)) {
    throw new SddScriptError(
      `${verb}: the resolved target ${root} is this invocation's control root, and a control root is not an admitted execution target. `
      + "Pass --harness <absolute-path> naming a harness other than this control root, or invoke from a checkout where no control root is discovered. "
      + "To back up or move a control root's own store, use mstar store backup.",
      2,
    );
  }
  return { harnessDir: root };
}
function document<T>(value: string | undefined, flag: string): T {
  return readJson(value, flag) as T;
}

async function execute(id: string, input: ExecutionInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  const verb = id.slice("store.execution.".length);
  // The target is a required absolute INPUT, not a discovery: a blank or
  // relative value refuses here, before any store is opened.
  const target = typeof input.harness === "string" ? input.harness.trim() : "";
  if (target === "" || !path.isAbsolute(target)) return targetRefusal(id, target);
  try {
    const context = executionContext(target, invocation, `store execution ${verb}`);
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
    return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message: `Unknown store execution verb: ${verb}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
    const details = error !== null && typeof error === "object" && "details" in error
      && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : undefined;
    return error instanceof SddScriptError
      ? refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message, ...(details === undefined ? {} : { details }) })
      : refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) , recovery: id === "store.execution.restore-preview"
          ? "Select a readable execution backup and writable preview destination. Run mstar store execution restore-preview --backup <backup> --out <preview>."
          : id === "store.execution.restore"
            ? "The backup preview or operator authorization does not match the diagnostic. Regenerate a current preview with mstar store execution restore-preview --backup <backup> --out <preview>, then retry restore with the same operator and authorization."
            : "Choose a writable export destination or omit --out for stdout. Run mstar store execution export."});
  }
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
    // `harness` names the operation's TARGET store, not the root this command
    // runs from: the MCP connection pin must not rewrite it (and a target equal
    // to the connection's control root is the family's own refusal, below).
    rootInputs: [],
    output: commandEnvelopeSchema,
    effects: writeVerbs[verb] === true ? ["read", "write"] : ["read"],
    description: verb === "export"
      ? "Export the current execution state as a canonical reporting artifact."
      : verb === "restore-preview"
        ? "Store execution restore-preview from a standalone store backup. Receipt retention is an expected source of backup-only `execution` " +
          "operation rows: a terminal close or adoption prunes that workflow's operation receipts (each listed in a preview of an older point with " +
          "`liveRevision: null`), the init-time purge beside the in-place epoch bump clears the superseded epoch's, and a restore preserves " +
          "prior-epoch receipt rows as history under its frozen bytes-plus-one-epoch contract, outside the current epoch's replay scope, so " +
          "restoring any of them is harmless and re-arms nothing. `result_json` payloads are write-time versioned: graph rows written " +
          "before the slimming change keep their full form, later rows carry the slim envelope, so inventory digests compare write-time " +
          "bytes per row and mixed forms never produce same-key content drift."
        : `Store execution ${verb} from a standalone store backup.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getExecutionCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.execution.${verb}`));
}
