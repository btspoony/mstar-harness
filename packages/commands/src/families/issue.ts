import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  appendOccurrence,
  captureIssue,
  closeIssue,
  getIssue,
  ISSUE_PAYLOAD_SCHEMAS,
  linkIssue,
  listIssues,
  reopenIssue,
  resolveProcessHarnessDir,
  triageIssue,
  type CaptureInput,
  type ClosureEvidence,
  type IssueFilter,
  type IssueLink,
  type IssueReopen,
  type IssueTriage,
  type MutationContext,
  type OccurrenceInput,
  type StoreContext,
  type TerminalDisposition,
} from "@mstar-harness/engine";
import type { PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  id: z.string().optional(),
  project: z.string().optional(),
  disposition: z.enum(["open", "resolved", "waived", "duplicate", "superseded"]).optional(),
  kind: z.enum(["bug", "risk", "improvement", "request", "decision", "review-obligation"]).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  harness: z.string().optional(),
  file: z.string().optional(),
  operationId: z.string().optional(),
  actor: z.string().optional(),
  expect: z.number().int().nonnegative().optional(),
  payload: z.unknown().optional(),
});
type IssueInput = z.infer<typeof inputSchema>;

const verbs = ["add", "list", "show", "occurrence", "triage", "close", "reopen", "waive", "duplicate", "supersede", "link", "export"] as const;
const terminalDisposition: Record<string, TerminalDisposition> = {
  close: "resolved",
  waive: "waived",
  duplicate: "duplicate",
  supersede: "superseded",
};
const readVerbs: Record<string, true> = { list: true, show: true, export: true };

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown, input?: IssueInput): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  const paths = error !== null && typeof error === "object" && "paths" in error && Array.isArray(error.paths)
    ? error.paths as string[]
    : [];
  const issueId = input?.id?.trim() || "<id>";
  const recovery = id !== "issue.reopen"
    ? undefined
    : code === "store.operation-conflict"
      ? `Replay the original request that reserved this operation id unchanged to receive its recorded receipt, or run this operation with a fresh \`--operation-id\`.`
      : code === "issue.revision-conflict"
        ? `Run \`mstar issue show --id ${issueId}\`, then retry \`mstar issue reopen --id ${issueId} --expect <current-revision>\` with the same non-empty reason payload.`
        : code === "issue.invalid-disposition"
        ? `Run \`mstar issue show --id ${issueId}\`; only resolved|waived|duplicate|superseded issues can reopen, and open issues stay open.`
        : code === "issue.scope-refused"
          ? `Retry \`mstar issue reopen --id ${issueId}\` with \`--actor project-manager\`; \`--operation-id\` is optional and a fresh replay id is generated when omitted.`
          : code === "issue.invalid-payload"
            ? `Retry \`mstar issue reopen --id ${issueId}\` with a non-empty \`payload.reason\`.`
            : `Run \`mstar issue show --id ${issueId}\` to verify the issue before retrying reopen.`;
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1, message,
    ...(paths.length > 0 ? { details: { paths } } : {}),
    ...(recovery === undefined ? {} : { recovery }),
  });
}
function storeContext(input: IssueInput, invocation: InvocationContext): StoreContext {
  const root = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function payload<T>(input: IssueInput): T {
  let value = input.payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      const error = new Error("payload is not valid JSON") as Error & { code: string; paths: string[] };
      error.code = "issue.invalid-payload";
      error.paths = ["payload"];
      throw error;
    }
  }
  if (value === undefined && input.file !== undefined) {
    if (!path.isAbsolute(input.file)) throw new Error("file must be an absolute path");
    try {
      value = JSON.parse(readFileSync(input.file, "utf8")) as unknown;
    } catch {
      const error = new Error("payload file is not valid JSON or could not be read") as Error & { code: string; paths: string[] };
      error.code = "issue.invalid-payload";
      error.paths = ["payload"];
      throw error;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("payload must be a JSON object");
  return value as T;
}
function mutation(input: IssueInput): MutationContext {
  if (input.actor === undefined) {
    const error = new Error("actor required for issue mutation") as Error & { code: string; paths: string[] };
    error.code = "issue.scope-refused";
    error.paths = ["actor"];
    throw error;
  }
  return {
    operationId: input.operationId ?? randomUUID(),
    actor: input.actor,
    ...(input.expect !== undefined ? { expectedRevision: input.expect } : {}),
  };
}
function issueFilter(input: IssueInput): IssueFilter {
  return {
    ...(input.project !== undefined ? { projectId: input.project } : {}),
    ...(input.disposition !== undefined ? { disposition: input.disposition } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  };
}
function requiredId(input: IssueInput): string {
  if (input.id === undefined || input.id.trim() === "") {
    const error = new Error("issue id is required") as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = ["id"];
    throw error;
  }
  return input.id.trim();
}

async function execute(id: string, input: IssueInput, invocation: InvocationContext): Promise<CommandEnvelope<unknown>> {
  try {
    const context = storeContext(input, invocation);
    if (id === "issue.list" || id === "issue.export") {
      const page = await listIssues(context, issueFilter(input));
      if (id === "issue.export" && input.id !== undefined && input.id.trim() !== "") return ok(id, await getIssue(context, input.id.trim()));
      return ok(id, page);
    }
    if (id === "issue.show") return ok(id, await getIssue(context, requiredId(input)));
    if (id === "issue.add") return ok(id, await captureIssue(context, validatePayload(input, "CaptureInput", "add") as CaptureInput, mutation(input)));
    if (id === "issue.occurrence") return ok(id, await appendOccurrence(context, requiredId(input), validatePayload(input, "OccurrenceInput", "occurrence") as OccurrenceInput, mutation(input)));
    if (id === "issue.triage") return ok(id, await triageIssue(context, requiredId(input), validatePayload(input, "IssueTriage", "triage") as IssueTriage, mutation(input)));
    if (id === "issue.reopen") {
      return ok(id, await reopenIssue(
        context,
        requiredId(input),
        validatePayload(input, "IssueReopen", "reopen") as IssueReopen,
        mutation(input),
      ));
    }
    const disposition = terminalDisposition[id.slice("issue.".length)];
    if (disposition !== undefined) return ok(id, await closeIssue(context, requiredId(input), disposition, validatePayload(input, "ClosureEvidence", id.slice("issue.".length)) as ClosureEvidence, mutation(input)));
    if (id === "issue.link") return ok(id, await linkIssue(context, requiredId(input), validatePayload(input, "IssueLink", "link") as IssueLink, mutation(input)));
    throw new Error(`unsupported issue command ${id}`);
  } catch (error) {
    return refused(id, error, input);
  }
}

const payloadType: Record<string, keyof typeof ISSUE_PAYLOAD_SCHEMAS> = {
  add: "CaptureInput",
  occurrence: "OccurrenceInput",
  triage: "IssueTriage",
  close: "ClosureEvidence",
  reopen: "IssueReopen",
  waive: "ClosureEvidence",
  duplicate: "ClosureEvidence",
  supersede: "ClosureEvidence",
  link: "IssueLink",
};
const expectedRevisionVerbs: Record<string, true> = {
  triage: true,
  close: true,
  reopen: true,
  waive: true,
  duplicate: true,
  supersede: true,
  link: true,
};
function fieldSchema(field: PayloadFieldSchema, verb: string): z.ZodType {
  let schema: z.ZodType;
  if (field.type === "object") {
    schema = z.object(Object.fromEntries(Object.entries(field.properties ?? {}).map(([name, child]) => [name, fieldSchema(child, verb)])));
  } else if (field.type === "string[]") {
    let array = z.array(z.string());
    if (field.minItems !== undefined) array = array.min(field.minItems);
    if (field.itemsNonblank) array = array.refine((items) => items.every((item) => item.trim() !== ""));
    schema = array;
  } else if (field.type === "string" || field.type === "string | null") {
    // `"string | null"` is the declared union spelling (the null arm also
    // arrives as the separate `nullable` flag, applied below). Treating it as a
    // free-form string keeps the type the contract states: falling through to
    // `z.unknown()` would accept any JSON value where the domain declares a
    // string-or-null.
    if (field.values !== undefined) {
      // An enum is its own constraint: every member is a non-empty string by
      // construction, so `nonblankWhenPresent` has nothing left to assert on it
      // (applying a refine here would be provably-true dead code). It applies
      // only to a free-form string.
      schema = z.enum(field.values as [string, ...string[]]);
    } else {
      let text = z.string();
      if (field.nonblankWhenPresent) text = text.refine((value) => value.trim() !== "", `${field.description ?? "field"} must be nonblank when present`);
      schema = text;
    }
  } else {
    schema = z.unknown();
  }
  if (field.nullable) schema = schema.nullable();
  return field.required || field.requiredWhen?.includes(verb) ? schema : schema.optional();
}

function payloadSchema(typeName: keyof typeof ISSUE_PAYLOAD_SCHEMAS, verb: string): z.ZodType {
  const fields = ISSUE_PAYLOAD_SCHEMAS[typeName] as Record<string, PayloadFieldSchema>;
  return z.object(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field, verb)])));
}

function validatePayload(input: IssueInput, typeName: keyof typeof ISSUE_PAYLOAD_SCHEMAS, verb: string): unknown {
  const value = payload(input);
  const result = payloadSchema(typeName, verb).safeParse(value);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => `payload.${issue.path.join(".")}`);
    const error = new Error(`invalid payload: ${paths.join(", ")}`) as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = paths;
    throw error;
  }
  return result.data;
}

function cliDefinition(id: string): CommandDefinition<IssueInput, unknown> {
  const verb = id.slice("issue.".length);
  const optionFlags: Record<string, string> = {
    id: "--id <id>", project: "--project <id>", disposition: "--disposition <disposition>", kind: "--kind <kind>",
    severity: "--severity <severity>", query: "--query <text>", limit: "--limit <n>", offset: "--offset <n>",
    harness: "--harness <path>", file: "--file <path>", operationId: "--operation-id <id>", actor: "--actor <role>",
    expect: "--expect <n>", payload: "--payload <json>",
  };
  const mutationOperationHelp = payloadType[verb] === undefined
    ? undefined
    : "Replay id; if omitted, this command generates one fresh id for this invocation. Explicit values are preserved and blank values are not defaulted.";
  const options = Object.keys(inputSchema.shape).map((key) => ({
    key,
    flags: optionFlags[key]!,
    required: (payloadType[verb] !== undefined && key === "actor") ||
      (verb === "show" && key === "id") ||
      (expectedRevisionVerbs[verb] === true && key === "expect"),
    ...(expectedRevisionVerbs[verb] === true && key === "expect"
      ? { help: "Current issue revision from `mstar issue show --id <id>`; the write checks this revision as a CAS precondition." }
      : {}),
    ...(key === "operationId" && mutationOperationHelp !== undefined ? { help: mutationOperationHelp } : {}),
  }));
  const isMutation = payloadType[verb] !== undefined;
  const requirements = isMutation
    ? (["cli", "mcp"] as const).flatMap((route) => [
        { name: "actor", ownership: "caller" as const, route, required: true, constraint: "accepted actor vocabulary is project-manager" },
        { name: "operationId", ownership: "caller" as const, route, required: false, constraint: mutationOperationHelp! },
        { name: "payload", ownership: "caller" as const, route, required: true, condition: { field: "file", present: false }, constraint: `payload shape: mstar schema ${payloadType[verb]}` },
        { name: "file", ownership: "caller" as const, route, required: true, condition: { field: "payload", present: false }, constraint: "absolute JSON file alternative to payload" },
        ...(verb === "reopen" || expectedRevisionVerbs[verb] === true
          ? [{ name: "expect", ownership: "caller" as const, route, required: true, tokenKind: "revision" as const, constraint: "fetch the current issue revision from `mstar issue show --id <id>` immediately before this write" }]
          : []),
      ])
    : verb === "show" || verb === "export"
      ? (["cli", "mcp"] as const).map((route) => ({
          name: "id", ownership: "caller" as const, route, required: verb === "show",
          ...(verb === "show" ? { constraint: "non-empty issue id" } : { constraint: "optional id returns one issue; omitted returns the issue page" }),
        }))
      : [];
  return {
    id,
    cli: { path: ["issue", verb], aliases: [], arguments: [], options },
    input: inputSchema,
    requirements,
    output: commandEnvelopeSchema,
    effects: readVerbs[verb] === true ? ["read"] : ["write"],
    description: `${verb} issue operation; ${payloadType[verb] === undefined ? "no JSON payload" : `payload schema: mstar schema ${payloadType[verb]}`}. Actor vocabulary: project-manager.`,
    ...(payloadType[verb] !== undefined
      ? { payloads: { payload: { schema: payloadSchema(payloadType[verb], verb), help: `Domain schema: mstar schema ${payloadType[verb]}` } } }
      : {}),
    execute: (input, context) => execute(id, input, context),
  };
}
export function getIssueCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`issue.${verb}`));
}
