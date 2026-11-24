import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  appendOccurrence,
  assertIssueWriteSeat,
  captureIssue,
  closeIssue,
  discardAcrossAuthorities,
  getIssue,
  moveAcrossByDocument,
  moveDocumentOf,
  showIssue,
  ISSUE_ACTION_NAMES,
  ISSUE_ACTIONS,
  ISSUE_DISPOSITIONS,
  ISSUE_PAYLOAD_SCHEMAS,
  TERMINAL_DISPOSITIONS,
  linkIssue,
  listIssues,
  moveIssue,
  reopenIssue,
  resolveProcessHarnessDir,
  triageIssue,
  type CaptureInput,
  type ClosureEvidence,
  type IssueActionSpec,
  type ExchangeReceipt,
  type IssueFilter,
  type IssueLink,
  type IssueMove,
  type IssuePayloadName,
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
import { refusalEnvelope, type RefusalDiagnostic } from "../envelope.js";
import { commandEnvelopeSchema } from "../envelope.js";
import { decodeInputDiagnostics } from "../input-diagnostics.js";
import { payloadSchema } from "../payload-field-schema.js";
import { engineErrorFacts } from "./family-refusal.js";

const inputSchema = z.object({
  id: z.string().optional(),
  project: z.string().optional(),
  disposition: z.enum(ISSUE_DISPOSITIONS).optional(),
  kind: z.enum(["bug", "risk", "improvement", "request", "decision", "review-obligation"]).optional(),
  severity: z.enum(["critical", "high", "medium", "low", "nit"]).optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  harness: z.string().optional(),
  file: z.string().optional(),
  operationId: z.string().optional(),
  actor: z.string().optional(),
  expect: z.number().int().nonnegative().optional(),
  expectStore: z.number().int().nonnegative().optional(),
  toAuthority: z.string().optional(),
  discard: z.boolean().optional(),
  /** note: The peer checkout's move document, or `-` for stdin: the two-checkout exchange's handoff. */
  input: z.string().optional(),
  /** note: Where this side writes the document the other checkout needs next. */
  out: z.string().optional(),
  payload: z.unknown().optional(),
});
type IssueInput = z.infer<typeof inputSchema>;

/**
 * The action vocabulary and its domain facts live once, in the engine (#453).
 * These transport tables are DERIVED from it: adding or renaming an action is
 * one edit in `ISSUE_ACTIONS`, never a second copy here.
 */
const actions = Object.entries(ISSUE_ACTIONS) as [string, IssueActionSpec][];
const verbs = ISSUE_ACTION_NAMES;
const terminalDisposition: Record<string, TerminalDisposition> = Object.fromEntries(
  actions.flatMap(([verb, action]) => (action.disposition === null ? [] : [[verb, action.disposition] as [string, TerminalDisposition]])),
);
const readVerbs: Record<string, true> = Object.fromEntries(actions.filter(([, action]) => action.read).map(([verb]) => [verb, true]));

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown, input?: IssueInput): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  const paths = error !== null && typeof error === "object" && "paths" in error && Array.isArray(error.paths)
    ? error.paths as string[]
    : [];
  const { details: engineDetails, recovery: engineRecovery } = engineErrorFacts(error);
  const issueId = input?.id?.trim() || "<id>";
  const hasPaths = paths.length > 0;
  const recovery = engineRecovery ?? (
    code === "issue.revision-conflict"
      ? `Run \`mstar issue show --id ${issueId}\` against the same harness selection if one was supplied, then rerun the original command with \`--expect <current-revision>\` added or replacing the stale value, keeping \`--operation-id\`, \`--actor\`, and the original payload unchanged.`
      : id !== "issue.reopen"
        ? code === "issue.scope-refused"
          ? "As an authorized actor, retry the same command after acquiring the required scope. Read its contract with mstar schema --command issue.add."
          : code === "issue.invalid-payload" && message.startsWith("invalid payload:")
            ? "Correct the payload field(s) named in this refusal, then retry the same command. Read its schema with mstar schema --command issue.add."
            : code === "issue.invalid-payload" && message.includes("not valid JSON")
              ? "Ensure the payload parses as a JSON object, then retry the same command. Read its schema with mstar schema --command issue.add."
              : "Correct the issue input, then read the command contract with mstar schema --command issue.add."
        : code === "store.operation-conflict"
          ? `Replay the original request that reserved this operation id unchanged to receive its recorded receipt, or run this operation with a fresh \`--operation-id\`.`
          : code === "issue.invalid-disposition"
            ? `Run \`mstar issue show --id ${issueId}\`; only ${TERMINAL_DISPOSITIONS.join("|")} issues can reopen, and open issues stay open.`
            : code === "issue.scope-refused"
              ? `Retry \`mstar issue reopen --id ${issueId}\` with \`--actor project-manager\`; \`--operation-id\` is optional and a fresh replay id is generated when omitted.`
              : code === "issue.invalid-payload"
                ? `Retry \`mstar issue reopen --id ${issueId}\` with a non-empty \`payload.reason\`.`
                : `Run \`mstar issue show --id ${issueId}\` to verify the issue before retrying reopen.`
  );
  // Engine-authored details (e.g. `causes`) are never replaced by the family's
  // own diagnostic paths: whichever facts the thrown error carries are all
  // reported, so a structured capture failure keeps both its per-cause facts
  // and the fields the family rejected.
  const details = engineDetails === undefined
    ? (hasPaths ? { paths } : undefined)
    : (hasPaths ? { paths, ...engineDetails } : engineDetails);
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1, message,
    details: details ?? {},
    recovery: recovery ?? "mstar issue show --id issue-id.",
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
  const operationId = input.operationId ?? randomUUID();
  if (operationId.trim() === "") {
    const error = new Error("operationId must be non-empty when supplied") as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = ["operationId"];
    throw error;
  }
  return {
    operationId,
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
/**
 * note: One exchange document for the two-checkout move: an absolute path, or `-` for stdin. An
 * unreadable path or a body that is not a JSON object refuses before any store work, exactly as the
 * outbox lane's own document reader does.
 */
async function readMoveDocument(invocation: InvocationContext, value: string, flag: string): Promise<unknown> {
  let raw: string;
  if (value === "-") raw = await invocation.effects.readInput();
  else if (!path.isAbsolute(value)) {
    const error = new Error(`${flag} must be an absolute path or -`) as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = [flag.replace(/^--/, "")];
    throw error;
  } else {
    try {
      raw = readFileSync(value, "utf8");
    } catch (error) {
      const failure = new Error(`${flag} ${value} cannot be read: ${error instanceof Error ? error.message : String(error)}`) as Error & { code: string; paths: string[] };
      failure.code = "issue.invalid-payload";
      failure.paths = [flag.replace(/^--/, "")];
      throw failure;
    }
  }
  if (raw.trim() === "") {
    const error = new Error(`${flag} received no content; pass a move document`) as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = [flag.replace(/^--/, "")];
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const error = new Error(`${flag} is not valid JSON`) as Error & { code: string; paths: string[] };
    error.code = "issue.invalid-payload";
    error.paths = [flag.replace(/^--/, "")];
    throw error;
  }
}

/**
 * invariant: The handoff is written create-only, and a failure to write it never rewrites the
 * operation's outcome: the move already committed, so the receipt discloses the reporting failure
 * instead of reporting the move as failed.
 */
function publishMoveDocument(
  out: string,
  document: unknown,
): { out: string | null; documentError: { code: string; message: string } | null } {
  const target = path.resolve(out);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { out: target, documentError: null };
  } catch (error) {
    return {
      out: null,
      documentError: {
        code: "issue.move-document-not-written",
        message:
          (error as { code?: unknown })?.code === "EEXIST"
            ? `A file already exists at ${target}; a handoff is create-only and never overwrites an existing document. The move itself completed as reported.`
            : `The handoff could not be written at ${target} (${error instanceof Error ? error.message : String(error)}). The move itself completed as reported.`,
      },
    };
  }
}

/**
 * note: A move combination neither route admits, refused by code with the route that does. It names the
 * flags rather than the engine's internals, so an operator corrects the request instead of the store.
 */
function unsupportedMove(flag: string, route: string): Error & { code: string; paths: string[]; details: Record<string, unknown> } {
  const recovery =
    `${flag} needs the staged cross-authority route: ${route}. A project reassignment inside one authority takes ` +
    `--payload '{"projectId":"<target>","reason":"<text>"}' with --expect and --expect-store, and no authority flag.`;
  const error = new Error(recovery) as Error & { code: string; paths: string[]; details: Record<string, unknown> };
  error.code = "issue.scope-refused";
  error.paths = [flag.replace(/^--/, "")];
  // note: The family's default recovery for a scope refusal is the seat's, which is not this cause;
  // the flag's own route is the repair, so it travels as the refusal's recovery.
  error.details = { flag: flag.replace(/^--/, ""), supported_route: route, recovery };
  return error;
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
    if (id === "issue.show") return ok(id, await showIssue(context, requiredId(input), input.project));
    const runMutation = async (action: (write: MutationContext) => Promise<unknown>): Promise<CommandEnvelope<unknown>> => {
      const write = mutation(input);
      const receipt = await action(write);
      return ok(id, { ...(receipt as Record<string, unknown>), operationId: write.operationId });
    };
    if (id === "issue.add") return await runMutation((write) => captureIssue(context, validatePayload(input, "CaptureInput", "add") as CaptureInput, write));
    if (id === "issue.occurrence") return await runMutation((write) => appendOccurrence(context, requiredId(input), validatePayload(input, "OccurrenceInput", "occurrence") as OccurrenceInput, write));
    if (id === "issue.triage") return await runMutation((write) => triageIssue(context, requiredId(input), validatePayload(input, "IssueTriage", "triage") as IssueTriage, write));
    if (id === "issue.reopen") {
      return await runMutation((write) => reopenIssue(
        context,
        requiredId(input),
        validatePayload(input, "IssueReopen", "reopen") as IssueReopen,
        write,
      ));
    }
    if (id === "issue.move") {
      const expectStore = input.expectStore;
      // invariant: `--expect` is the record's revision CAS on every route that reads a local record; only
      // the exchange's handoff half addresses a record another authority holds and carries no revision.
      if (input.expect === undefined && input.input === undefined) {
        const error = new Error(
          "expect is required for a move unless --input supplies the peer's handoff document",
        ) as Error & { code: string; paths: string[]; details: Record<string, unknown> };
        error.code = "issue.invalid-payload";
        error.paths = ["expect"];
        error.details = {
          recovery:
            `Read the record with \`mstar issue show --id <issue-id>\`, then reissue the same command with ` +
            `--expect <issue-revision> (and the same --operation-id).`,
        };
        throw error;
      }
      const addressed = requiredId(input);
      const payload = validatePayload(input, "IssueMove", "move") as IssueMove;
      const toAuthority = input.toAuthority?.trim();
      if (toAuthority === "") throw unsupportedMove("--to-authority", `mstar issue move --id ${addressed} --to-authority <repo-key>`);
      // invariant: `--discard` is decided before the store base: it restores the source record and never
      // compares the lane revision a move's own phase commits have already advanced, so `--expect-store`
      // is not one of its inputs and supplying one refuses instead of being accepted and dropped.
      if (input.discard === true) {
        if (toAuthority === undefined) {
          throw unsupportedMove("--discard", `mstar issue move --id ${addressed} --to-authority <repo-key> --discard`);
        }
        // invariant: The handoff flags belong to the staged exchange, which a discard never runs:
        // `--discard` releases the row this checkout holds and neither reads nor emits a document,
        // so admitting either flag here would drop it silently beside a completed discard.
        if (input.input !== undefined) {
          throw unsupportedMove("--input", `mstar issue move --id ${addressed} --to-authority <repo-key> --discard`);
        }
        if (input.out !== undefined) {
          throw unsupportedMove("--out", `mstar issue move --id ${addressed} --to-authority <repo-key> --discard`);
        }
        if (expectStore !== undefined) {
          const error = new Error(
            "expectStore is not a --discard input: a discard restores the source record and never compares the lane " +
              "revision a move's own phase commits have already advanced; pass the record's revision with --expect only",
          ) as Error & { code: string; paths: string[]; details: Record<string, unknown> };
          error.code = "issue.invalid-payload";
          error.paths = ["expectStore"];
          error.details = {
            recovery:
              `Read the record with \`mstar issue show --id ${addressed}\`, then reissue the same --discard command with ` +
              `--expect <issue-revision> and no --expect-store.`,
          };
          throw error;
        }
        // invariant: Discard unfreezes a record, so it is an issue write: the same capture seat that
        // authorizes the move authorizes abandoning it, checked before the store is touched.
        const write = mutation(input);
        assertIssueWriteSeat(write.actor);
        // invariant: the discard route is chosen by the lanes this checkout can open: a one-checkout
        // move releases both halves at once, a two-checkout exchange releases the half it holds here.
        const receipt = await discardAcrossAuthorities(context, {
          operationId: write.operationId,
          actor: write.actor,
          sourceIssueId: addressed,
          destinationAuthority: toAuthority,
          destinationProject: payload.projectId,
          reason: payload.reason,
          ...(input.expect !== undefined ? { expectedRevision: input.expect } : {}),
        });
        return ok(id, { ...receipt, operationId: write.operationId });
      }
      // invariant: `--expect-store` is the lane's store CAS, and every remaining route reads that base.
      if (expectStore === undefined) {
        const error = new Error("expectStore is required for a project move") as Error & { code: string; paths: string[] };
        error.code = "issue.invalid-payload";
        error.paths = ["expectStore"];
        throw error;
      }
      // invariant: `--to-authority` selects the staged cross-authority route; without it the verb is the
      // local project reassignment. A flag neither route admits refuses by code with the route that does.
      if (toAuthority === undefined) {
        // invariant: The handoff flags belong to the two-checkout route alone. Without a destination
        // authority neither is read, so admitting either here would perform a different mutation than
        // the request names; both refuse by code instead.
        if (input.input !== undefined) {
          throw unsupportedMove("--input", `mstar issue move --id ${addressed} --to-authority <repo-key> --input <path|->`);
        }
        if (input.out !== undefined) {
          throw unsupportedMove("--out", `mstar issue move --id ${addressed} --to-authority <repo-key> --out <path>`);
        }
        return await runMutation((write) => moveIssue(context, addressed, payload, { ...write, expectedStoreRevision: expectStore }));
      }
      // invariant: `--input`/`--out` select the two-checkout exchange. A checkout writes only the lane
      // its own mode selects, so a move across a mode boundary is two halves that hand each other
      // documents; the same command resumes from whatever phase its own ledger row holds.
      if (input.input !== undefined || input.out !== undefined) {
        const write = mutation(input);
        assertIssueWriteSeat(write.actor);
        const handoff = input.input === undefined ? null : moveDocumentOf(await readMoveDocument(invocation, input.input, "--input"));
        const receipt: ExchangeReceipt = await moveAcrossByDocument(context, {
          operationId: write.operationId,
          actor: write.actor,
          sourceIssueId: addressed,
          destinationAuthority: toAuthority,
          destinationProject: payload.projectId,
          reason: payload.reason,
          ...(input.expect !== undefined ? { expectedRevision: input.expect } : {}),
          expectedStoreRevision: expectStore,
        }, handoff);
        const published = input.out === undefined || receipt.document === null
          ? { out: null, documentError: null }
          : publishMoveDocument(input.out, receipt.document);
        // invariant: `operationId` stays the caller's move id, so the provider intent a step froze is
        // reported beside it: it is the operation `outbox-dispatch`/`outbox-receipt` address.
        return ok(id, {
          ...receipt,
          out: published.out,
          ...(published.documentError === null ? {} : { documentError: published.documentError }),
          operationId: write.operationId,
        });
      }
      return await runMutation((write) => moveIssue(context, addressed, { ...payload, toAuthority }, { ...write, expectedStoreRevision: expectStore }));
    }
    const defaultDisposition = terminalDisposition[id.slice("issue.".length)];
    if (defaultDisposition !== undefined) {
      const disposition = (input.disposition as TerminalDisposition | undefined) ?? defaultDisposition;
      return await runMutation((write) => closeIssue(
        context,
        requiredId(input),
        disposition,
        validatePayload(input, "ClosureEvidence", disposition) as ClosureEvidence,
        write,
      ));
    }
    if (id === "issue.link") return await runMutation((write) => linkIssue(context, requiredId(input), validatePayload(input, "IssueLink", "link") as IssueLink, write));
    throw new Error(`unsupported issue command ${id}`);
  } catch (error) {
    return refused(id, error, input);
  }
}

const payloadType: Record<string, IssuePayloadName> = Object.fromEntries(
  actions.flatMap(([verb, action]) => (action.payload === null ? [] : [[verb, action.payload] as [string, IssuePayloadName]])),
);
const expectedRevisionVerbs: Record<string, true> = Object.fromEntries(actions.filter(([, action]) => action.cas).map(([verb]) => [verb, true]));
/**
 * The conditions whose evidence rule the ENGINE owns rather than this admission
 * schema. `obsolete` must refuse with `issue.invalid-disposition` and name the
 * removal-evidence recovery; a transport-level required field would shadow that
 * with a generic `issue.invalid-payload` and lose the actionable repair. The
 * registry still publishes the requirement (`mstar schema`, the MCP tool), so
 * the contract is declared even where admission defers.
 */
const ENGINE_OWNED_EVIDENCE: ReadonlySet<string> = new Set<string>(["obsolete"]);

/**
 * The registry condition this transport actually enforces for one admission.
 * A non-closure verb passes its own name (the registry's `requiredWhen` names
 * dispositions only), which never matches an engine-owned disposition.
 */
function admissionCondition(condition: string | undefined): string | undefined {
  return condition !== undefined && ENGINE_OWNED_EVIDENCE.has(condition) ? undefined : condition;
}

function closureInputSchema(input: z.ZodObject<Record<string, z.core.$ZodType>>, defaultDisposition: TerminalDisposition): z.ZodType<IssueInput> {
  const fields = ISSUE_PAYLOAD_SCHEMAS.ClosureEvidence as Record<string, PayloadFieldSchema>;
  const dispositions = [...new Set(Object.values(fields).flatMap((field) => field.requiredWhen ?? []))] as TerminalDisposition[];
  return z.union([
    input.extend({
      disposition: z.never().optional(),
      payload: payloadSchema("ClosureEvidence", admissionCondition(defaultDisposition)).optional(),
    }),
    ...dispositions.map((disposition) => input.extend({
      disposition: z.literal(disposition),
      payload: payloadSchema("ClosureEvidence", admissionCondition(disposition)).optional(),
    })),
  ]) as z.ZodType<IssueInput>;
}

/**
 * The nested payload rejection as refusal diagnostics. The schema is bound to
 * the `payload` input field, so its issue paths are prefixed to name the same
 * `payload.<field>` positions both routes address, and the projection runs
 * through the shared input-aware decoder so each failure carries per-field
 * code/expected/received facts instead of collapsing to prose name lists.
 */
function payloadDiagnostics(error: z.ZodError, value: unknown): RefusalDiagnostic[] {
  return decodeInputDiagnostics(error, value).map((diagnostic) => ({
    ...diagnostic,
    path: diagnostic.path === "" ? "payload" : `payload.${diagnostic.path}`,
  }));
}

function validatePayload(
  input: IssueInput,
  typeName: keyof typeof ISSUE_PAYLOAD_SCHEMAS,
  condition: string | undefined,
): unknown {
  const value = payload(input);
  const result = payloadSchema(typeName, admissionCondition(condition)).safeParse(value);
  if (!result.success) {
    const diagnostics = payloadDiagnostics(result.error, value);
    const paths = diagnostics.map((diagnostic) => diagnostic.path ?? "payload");
    const error = new Error(`invalid payload: ${paths.join(", ")}`) as Error & { code: string; paths: string[]; details: Record<string, unknown> };
    error.code = "issue.invalid-payload";
    error.paths = paths;
    error.details = { diagnostics };
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
    expect: "--expect <n>", expectStore: "--expect-store <n>", payload: "--payload <json>",
    toAuthority: "--to-authority <repo-key>", discard: "--discard", input: "--input <path>", out: "--out <path>",
  };
  const requiresIssueId = verb === "show" || (payloadType[verb] !== undefined && verb !== "add");
  const mutationOperationHelp = payloadType[verb] === undefined
    ? undefined
    : "Replay id; if omitted, this command generates one fresh id for this invocation. Explicit values are preserved and blank values are not defaulted.";
  const commandInput = z.object({
    ...inputSchema.shape,
    id: requiresIssueId ? z.string().min(1) : z.string().optional(),
    // invariant: `--expect` is the record's revision CAS on every route that reads a local record. The
    // two-checkout exchange's destination half addresses a record it does not hold, so it carries no
    // revision to compare: only there is the flag optional, and the requirement below states when.
    expect: expectedRevisionVerbs[verb] === true
      ? verb === "move"
        ? z.number().int().nonnegative().optional()
        : z.number().int().nonnegative()
      : z.number().int().nonnegative().optional(),
    expectStore: z.number().int().nonnegative().optional(),
  });
  const options = Object.keys(inputSchema.shape).map((key) => ({
    key,
    flags: optionFlags[key]!,
    required: (payloadType[verb] !== undefined && (key === "actor" || (key === "id" && requiresIssueId))) ||
      (verb === "show" && key === "id") ||
      (expectedRevisionVerbs[verb] === true && key === "expect" && verb !== "move"),
    ...(requiresIssueId && key === "id" ? { help: "Current issue id from `mstar issue show --id <id>`." } : {}),
    ...(expectedRevisionVerbs[verb] === true && key === "expect"
      ? { help: "Exact current issue revision from `mstar issue show --id <id>`; this is a revision CAS, not an execution token. Compared by the run that stages the move; a --input run continues the recorded operation." }
      : {}),
    ...(verb === "move" && key === "expectStore"
      ? { help: "Exact current store revision of the lane this run stages in: `storeRevision` from `mstar issue list` there. Compared by the run that stages a move (its own lane's revision); a --input run continues the recorded operation. Not an input of `--discard`." }
      : {}),
    ...(verb === "move" && key === "toAuthority"
      ? { help: "Destination authority `repoKey` (`host/owner/repo`) of a staged cross-authority move; `--payload.projectId` names the destination project." }
      : {}),
    ...(verb === "move" && key === "discard"
      ? { help: "Abandon a staged cross-authority move before its destination admission: the source record is untouched. A one-checkout move releases both lanes in one run; a two-checkout exchange releases the half this checkout holds, so each side runs it once." }
      : {}),
    ...(verb === "move" && key === "input"
      ? { help: "The peer checkout's move document (absolute path, or - for stdin) for the two-checkout exchange; its shape publishes as payloadSchemas.inputDocument." }
      : {}),
    ...(verb === "move" && key === "out"
      ? { help: "Absolute path where this side writes the handoff document the other checkout needs next; create-only." }
      : {}),
    ...(key === "operationId" && mutationOperationHelp !== undefined ? { help: mutationOperationHelp } : {}),
  }));
  const isMutation = payloadType[verb] !== undefined;
  const requirements = isMutation
    ? (["cli", "mcp"] as const).flatMap((route) => [
        ...(requiresIssueId ? [{ name: "id", ownership: "caller" as const, route, required: true, constraint: "issue id from `mstar issue show --id <id>`" }] : []),
        { name: "actor", ownership: "caller" as const, route, required: true, constraint: "accepted actor vocabulary is project-manager" },
        { name: "operationId", ownership: "caller" as const, route, required: false, constraint: mutationOperationHelp! },
        { name: "payload", ownership: "caller" as const, route, required: true, condition: { field: "file", present: false }, constraint: `payload shape: mstar schema ${payloadType[verb]}` },
        { name: "file", ownership: "caller" as const, route, required: true, condition: { field: "payload", present: false }, constraint: "absolute JSON file alternative to payload" },
        ...(expectedRevisionVerbs[verb] === true
          ? [{
              name: "expect", ownership: "caller" as const, route, tokenKind: "revision" as const,
              // invariant: `issue move`'s destination half addresses a record another authority holds, so it
              // has no revision to compare; every other route reads the record it writes and requires it.
              ...(verb === "move" ? { required: true, condition: { field: "input", present: false } } : { required: true }),
              constraint: "fetch the current issue revision from `mstar issue show --id <id>` immediately before this write",
            }]
          : []),
        ...(verb === "move"
          ? [{
              name: "expectStore", ownership: "caller" as const, route, tokenKind: "revision" as const,
              // invariant: A discard restores the record instead of reading a lane base it cannot hold:
              // the move's own phase commits advance the store revision, so only the routes that read a
              // base they can still compare — the local project move and the exchange halves — require it.
              required: true, condition: { field: "discard", present: false },
              constraint: "fetch the current `storeRevision` from `mstar issue list` immediately before this write",
            }]
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
    input: terminalDisposition[verb] === undefined
      ? commandInput
      : closureInputSchema(commandInput, terminalDisposition[verb]),
    description: `${verb} issue operation; ${payloadType[verb] === undefined ? "no JSON payload" : `payload schema: mstar schema ${payloadType[verb]}`}. ${requiresIssueId ? "Requires the issue id from `mstar issue show --id <id>`." : ""} ${expectedRevisionVerbs[verb] === true ? "Requires `--expect` with the current revision from `mstar issue show --id <id>`." : ""} ${verb === "move" ? "Requires `--expect-store` with the current `storeRevision` from `mstar issue list`, except with `--discard`, which honours the record's revision alone." : ""} Actor vocabulary: project-manager.`,
    requirements,
    output: commandEnvelopeSchema,
    effects: readVerbs[verb] === true ? ["read"] : ["write"],
    ...(payloadType[verb] !== undefined
      ? { payloads: { payload: { schema: payloadSchema(payloadType[verb], terminalDisposition[verb]), registryName: payloadType[verb] } } }
      : {}),
    execute: (input, context) => execute(id, input, context),
  };
}
export function getIssueCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`issue.${verb}`));
}
