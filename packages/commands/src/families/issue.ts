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
  resolveProcessHarnessDir,
  triageIssue,
  type CaptureInput,
  type ClosureEvidence,
  type IssueFilter,
  type IssueLink,
  type IssueTriage,
  type MutationContext,
  type OccurrenceInput,
  type StoreContext,
  type TerminalDisposition,
} from "@mstar-harness/engine";
import type { PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
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
  session: z.string().optional(),
  expect: z.number().int().nonnegative().optional(),
  payload: z.unknown().optional(),
});
type IssueInput = z.infer<typeof inputSchema>;

const verbs = ["add", "list", "show", "occurrence", "triage", "close", "waive", "duplicate", "supersede", "link", "export"] as const;
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
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  const paths = error !== null && typeof error === "object" && "paths" in error && Array.isArray(error.paths)
    ? error.paths as string[]
    : [];
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message, ...(paths.length > 0 ? { details: { paths } } : {}) };
}
function storeContext(input: IssueInput, invocation: InvocationContext): StoreContext {
  const root = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function mutation(input: IssueInput, privileged: boolean): MutationContext {
  const missing = [
    ...(input.operationId === undefined ? ["operationId"] : []),
    ...(input.actor === undefined ? ["actor"] : []),
  ];
  if (missing.length > 0) {
    const error = new Error(`${missing.join(" and ")} required for issue mutation`) as Error & { code: string; paths: string[] };
    error.code = "issue.scope-refused";
    error.paths = missing;
    throw error;
  }
  return {
    operationId: input.operationId!,
    actor: input.actor!,
    ...(privileged && input.session !== undefined ? { sessionFile: input.session } : {}),
    ...(privileged && input.expect !== undefined ? { expectedRevision: input.expect } : {}),
  };
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
function requiredId(input: IssueInput): string {
  if (input.id === undefined || input.id.trim() === "") throw new Error("issue id is required");
  return input.id.trim();
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

async function execute(id: string, input: IssueInput, invocation: InvocationContext): Promise<CommandEnvelope<unknown>> {
  try {
    const context = storeContext(input, invocation);
    if (id === "issue.list" || id === "issue.export") {
      const page = await listIssues(context, issueFilter(input));
      if (id === "issue.export" && input.id !== undefined && input.id.trim() !== "") return ok(id, await getIssue(context, input.id.trim()));
      return ok(id, page);
    }
    if (id === "issue.show") return ok(id, await getIssue(context, requiredId(input)));
    if (id === "issue.add") return ok(id, await captureIssue(context, validatePayload(input, "CaptureInput", "add") as CaptureInput, mutation(input, false)));
    if (id === "issue.occurrence") return ok(id, await appendOccurrence(context, requiredId(input), validatePayload(input, "OccurrenceInput", "occurrence") as OccurrenceInput, mutation(input, false)));
    if (id === "issue.triage") return ok(id, await triageIssue(context, requiredId(input), validatePayload(input, "IssueTriage", "triage") as IssueTriage, mutation(input, true)));
    const disposition = terminalDisposition[id.slice("issue.".length)];
    if (disposition !== undefined) return ok(id, await closeIssue(context, requiredId(input), disposition, validatePayload(input, "ClosureEvidence", id.slice("issue.".length)) as ClosureEvidence, mutation(input, true)));
    if (id === "issue.link") return ok(id, await linkIssue(context, requiredId(input), validatePayload(input, "IssueLink", "link") as IssueLink, mutation(input, true)));
    throw new Error(`unsupported issue command ${id}`);
  } catch (error) {
    return refused(id, error);
  }
}

const payloadType: Record<string, keyof typeof ISSUE_PAYLOAD_SCHEMAS> = {
  add: "CaptureInput",
  occurrence: "OccurrenceInput",
  triage: "IssueTriage",
  close: "ClosureEvidence",
  waive: "ClosureEvidence",
  duplicate: "ClosureEvidence",
  supersede: "ClosureEvidence",
  link: "IssueLink",
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
  } else if (field.type === "string") {
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
    session: "--session <path>", expect: "--expect <n>", payload: "--payload <json>",
  };
  const options = Object.keys(inputSchema.shape).map((key) => ({
    key,
    flags: optionFlags[key]!,
    required: payloadType[verb] !== undefined && (key === "operationId" || key === "actor"),
  }));
  return {
    id,
    cli: { path: ["issue", verb], aliases: [], arguments: [], options },
    input: inputSchema,
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
