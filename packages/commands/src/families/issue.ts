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
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function storeContext(input: IssueInput, invocation: InvocationContext): StoreContext {
  const root = resolveProcessHarnessDir(invocation.cwd, input.harness);
  return { harnessDir: root ?? input.harness ?? invocation.controlRoot ?? invocation.cwd };
}
function mutation(input: IssueInput, privileged: boolean): MutationContext {
  if (input.operationId === undefined || input.actor === undefined) {
    const error = new Error("operationId and actor are required for issue mutation") as Error & { code: string };
    error.code = "issue.scope-refused";
    throw error;
  }
  return {
    operationId: input.operationId,
    actor: input.actor,
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
      throw new Error("payload is not valid JSON");
    }
  }
  if (value === undefined && input.file !== undefined) {
    if (!path.isAbsolute(input.file)) throw new Error("file must be an absolute path");
    try {
      value = JSON.parse(readFileSync(input.file, "utf8")) as unknown;
    } catch {
      throw new Error("payload file is not valid JSON or could not be read");
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
    if (id === "issue.add") return ok(id, await captureIssue(context, payload<CaptureInput>(input), mutation(input, false)));
    if (id === "issue.occurrence") return ok(id, await appendOccurrence(context, requiredId(input), payload<OccurrenceInput>(input), mutation(input, false)));
    if (id === "issue.triage") return ok(id, await triageIssue(context, requiredId(input), payload<IssueTriage>(input), mutation(input, true)));
    const disposition = terminalDisposition[id.slice("issue.".length)];
    if (disposition !== undefined) return ok(id, await closeIssue(context, requiredId(input), disposition, payload<ClosureEvidence>(input), mutation(input, true)));
    if (id === "issue.link") return ok(id, await linkIssue(context, requiredId(input), payload<IssueLink>(input), mutation(input, true)));
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
      ? { payloads: { [payloadType[verb]]: { schema: z.record(z.string(), z.unknown()), help: `Domain schema: mstar schema ${payloadType[verb]}` } } }
      : {}),
    execute: (input, context) => execute(id, input, context),
  };
}
export function getIssueCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`issue.${verb}`));
}
