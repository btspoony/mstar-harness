import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  WORKFLOW_COMPOUND_OUTCOMES, WORKFLOW_DELIVERY_KINDS, WORKFLOW_LIFECYCLE_STATUSES, StoreError, amendPrepareWorkflow,
  adoptTerminalWorkflow, commitExecutionRegistration, createFsStore, decodeExecutionSessionRef, declareWorkflowDeliveryKind,
  executionContextFor, mutateExecutionWorkflow, normalizeIterationCompassRef, readCatalogRevisions, readSessionEnvelope,
  recoverPrepareCoordinator, recordWorkflowDelivery, registerShippedCatalogExecution,
  resolveExecutionReadRoute, resolvePlanDir, resolveProcessHarnessDir, resolveWorkflowDir, setArtifactStore,
  showPrepareWorkflow,
  type ActivationAttestation,
  type CatalogExecutionWorkflow, type ExecutionIdentity, type WorkflowCompoundOutcome, type WorkflowDeliveryEvidence, type WorkflowExecutionOperation,
} from "@mstar-harness/engine";
import { activationAttestationDocumentConstraints, activationAttestationDocumentSchema } from "../activation-attestation.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import { IDENTITY_SUPPLIES, SESSION_REF_SUPPLIES, TOKEN_SUPPLIES } from "../identity-supplies.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const command = <I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> => definition;
const transitions = [
  { name: "phase", effect: "write" as const }, { name: "lifecycle", effect: "write" as const },
  { name: "execution-policy", effect: "write" as const }, { name: "integration-worktree", effect: "write" as const },
];
function ok<T>(id: string, data: T): CommandEnvelope<T> { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
const IDENTITY_RECOVERY =
  "launch `mstar session run --workflow <id> --role coordinator -- <argv>` for a minted identity, or pass an explicit acquired `--session-id`; a launch does not bind, so first establish the binding with `mstar plan bind --execution --workflow <id> --coordinator`";
const attestationRules = activationAttestationDocumentConstraints
  .map(({ path: rulePath, rule }) => `${rulePath}: ${rule}`)
  .join(" ");


/**
 * The ACTIVE registration refusal: `expect` and `operation` are required (the
 * store's root token and the caller's replay id). Session identity is NOT —
 * it is creator attribution; an unset identity registers a NULL creator that
 * the first coordinator bind adopts.
 */
function activeRegistrationRefusal(id: string, missing: readonly string[]): CommandEnvelope<never> {
  const recovery = [
    "For workflow.register and iteration.register, expect is the store's root execution token from mstar status validate; for workflow.evidence, use the addressed workflow's token from its workflows[] entry in mstar status validate; for other workflow-scoped writes, use that addressed scope's own token.",
    "operation is your own replay id.",
    "Session identity is optional at registration: supply it when the transport has one " +
      `(${IDENTITY_SUPPLIES}); an unset identity registers a NULL creator that the first coordinator bind adopts.`,
    ...(missing.includes("sessionRef") ? ["sessionRef is the active session reference returned by the plan bind receipt; pass it as --session-ref on the CLI or sessionRef in MCP input."] : []),
  ].join(" ");
  return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `Active registration is missing ${missing.join(", ")}. ${recovery}` });
}

class WorkflowInputError extends Error {}
function engineRefusal(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof WorkflowInputError) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.message });
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // The structured facts of one settled-adoption refusal, when the engine
  // carries them: which ACTIVE holders it addressed and which settlement rule
  // refused. Keying the recovery on these facts (not on refusal wording) lets
  // the supported recovery name real targets.
  const adoptionRefusal = code === "execution.adoption-refused" && details !== undefined && typeof details.adoption_refusal === "string"
    ? details.adoption_refusal
    : undefined;
  const holders = details !== undefined && Array.isArray(details.active_holder_sessions)
    ? details.active_holder_sessions.filter((value): value is string => typeof value === "string")
    : [];
  const holderList = holders.map((sessionId) => JSON.stringify(sessionId)).join(", ");
  const proofRequired = adoptionRefusal === "active-session-proof-required";
  const proofIncomplete = adoptionRefusal === "active-session-proof-incomplete";
  const recovery = proofRequired
    ? `Terminal adoption can settle the eligible unadopted terminal header's ACTIVE coordinator session(s) ${holderList} only against genuine operator stop evidence. The refusal details include attestationContract.schema and attestationContract.constraints for the full document; write an absolute JSON file whose stoppedSessions names every listed target as stopped/reloaded, then retry ` +
      "`mstar workflow adopt-terminal --workflow <id> --reason <text> --attestation <absolute-json>` (omitted --expect derives the current header revision in the guarded transaction; omitted --operation is generated once). Optional discovery: `mstar schema --command workflow.adopt-terminal`. The engine remains the authority; no stop, consumer-readiness, operator, or authorization facts are generated."
    : proofIncomplete
      ? `Add every listed ACTIVE coordinator session (${holderList}) to the attestation's stoppedSessions with state "stopped" or ` +
        `"reloaded", then retry. The refusal details include the full attestationContract schema and constraints; each addressed holder needs its own genuine stop evidence, and rows outside the addressed workflow are never settled.`
      : adoptionRefusal === "self-settlement"
        ? "Run the adoption from a distinct operator identity — an acquired session id other than the one the attestation names " +
          "stopped/reloaded; the attested stop must come from an observer other than the identity being settled."
        : code === "workflow.register.title-constraint"
          ? "Use the title in the selected plan document's H1, or correct that document before registering."
          : code === "execution.header-revision-conflict"
            ? "Run `mstar status validate` and retry with its current header revision, or omit --expect to derive the current revision inside the guarded transaction."
            : code === "execution.adoption-refused" && message.includes("no terminal header")
              ? "The missing header cannot be adopted; create/register a new workflow through `mstar workflow register` with a valid catalog selection."
              : code === "execution.adoption-refused" && message.includes("already registered")
                ? "Run `mstar status workflow-close --workflow <id> --reason <text>` through the existing registered-workflow close path under the ACTIVE coordinator holder's binding."
                : code === "execution.adoption-refused" && message.includes("non-terminal header without registry membership")
                  ? "No supported exit exists for a non-terminal header without registry membership — this is the I-000397 residual surface; capture an issue with `mstar issue add`."
                  : code === "execution.adoption-refused" && message.includes("no recorded terminal reason")
                    ? "No supported exit exists for a stopped/failed header missing the recorded terminal reason; capture an issue with `mstar issue add` and preserve the header."
                    : code === "execution.adoption-refused" && message.includes("already has a terminal-adoption record")
                      ? "Read `mstar status validate`; the existing terminal-adoption record is already the close receipt, so no further adoption is needed."
                      : code === "workflow.adopt-terminal.attestation-unreadable" || code === "workflow.adopt-terminal.attestation-malformed"
                        ? "Supply --attestation as an absolute path to the operator's ActivationAttestation JSON document; `mstar schema --command workflow.adopt-terminal` (payload contract adoptionAttestation) publishes its structure and semantic constraints."
                        : code === "store.attestation-invalid" || code === "store.activation-blocked"
                          ? "The engine refused this operator attestation. Use `mstar schema --command workflow.adopt-terminal` for the structural contract and semantic rules; the engine validator remains authoritative. Do not invent operator, consumer-readiness, or stop facts."
                          : code.startsWith("execution.adoption")
                            ? "Preserve the header and resolve the stated cause; re-read `mstar status validate` before retrying."
                            : undefined;
  const refusalDetails = details === undefined
    ? undefined
    : {
        ...details,
        ...(proofRequired || proofIncomplete ? {
          attestationContract: {
            schema: activationAttestationDocumentSchema.toJSONSchema(),
            constraints: activationAttestationDocumentConstraints,
          },
        } : {}),
      };
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
    ...(refusalDetails === undefined ? {} : { details: refusalDetails }),
    ...(recovery === undefined ? {} : { recovery }),
  });
}
function object(value: unknown, field: string): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new WorkflowInputError(`${field} must be a JSON object`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new WorkflowInputError(`${field} must be an object`);
  return parsed as Record<string, unknown>;
}
function absolute(value: string | undefined, field: string): string {
  if (value === undefined || !path.isAbsolute(value)) throw new WorkflowInputError(`${field} must be an absolute path`);
  return value;
}


/**
 * The document is read here but validated by the engine. A malformed document
 * is reported with the parser's own grammatical cause and, only when the
 * parser actually reports one, its location.
 *
 * Not every quoted span is grammar. A supported runtime quotes source-derived
 * content after an unexpected/unrecognized diagnostic — the offending operand
 * (`Unexpected token 'F'`, `Unrecognized token '@'`, `Unexpected identifier
 * "<token>"`), in either quote style, plus the document excerpt Node appends
 * before `is not valid JSON` — and those spans are removed. The parser's own
 * Expected-delimiter/keyword grammar (`Expected '}'`, `Expected property name
 * or '}'`, `("'")`) is never introduced by those roles and is preserved. No
 * offset is invented when the parser reports none.
 */
function jsonParseDiagnostic(error: unknown): { cause: string; location?: string } {
  const message = error instanceof Error ? error.message : "";
  const position = message.match(/\bposition\s+(\d+)\b/i)?.[1];
  const lineColumn = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
  const location = position !== undefined
    ? `position ${position}`
    : lineColumn === null || lineColumn === undefined
      ? undefined
      : `line ${lineColumn[1]} column ${lineColumn[2]}`;
  const cause = message
    .replace(/^JSON Parse error:\s*/i, "")
    .replace(/^SyntaxError:\s*/i, "")
    // The document excerpt Node appends before `is not valid JSON` (a truncated
    // excerpt carries an embedded `...`). The clause carries raw document bytes,
    // so the marker and everything from its opening double quote onward is
    // dropped together.
    .replace(/[:,]?\s*"[\s\S]*is not valid JSON\s*$/i, "")
    .replace(/[,\s]+is not valid JSON\s*$/i, "")
    .replace(/\s+in JSON at position \d+(?:\s*\(line \d+ column \d+\))?/gi, "")
    .replace(/\s+at position \d+(?:\s*\(line \d+ column \d+\))?/gi, "")
    .replace(/\s*\(line \d+ column \d+\)/gi, "")
    // The operand a runtime quotes after `Unexpected token` / `Unexpected
    // identifier` / `Unrecognized token` is source-derived in EITHER quote style:
    // `Unexpected token 'F'` quotes the submitted character and `Unexpected
    // identifier "<token>"` quotes the submitted token. Drop the operand, keep
    // the diagnostic's own words. Expected-delimiter grammar is not introduced
    // by those roles, so it is never touched here.
    .replace(/\b(Unexpected token|Unexpected identifier|Unrecognized token)\b\s*('[^']*'|"[^"]*")/gi, "$1")
    .replace(/\s+/g, " ")
    .replace(/[\s,:;]+$/, "")
    .trim();
  return { cause: cause === "" ? "syntax error" : cause, ...(location === undefined ? {} : { location }) };
}

function readAdoptionAttestation(documentPath: string): ActivationAttestation {
  let text: string;
  try { text = readFileSync(documentPath, "utf8"); }
  catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`the attestation document ${documentPath} could not be read: ${cause}`), {
      code: "workflow.adopt-terminal.attestation-unreadable",
    });
  }
  try { return JSON.parse(text) as ActivationAttestation; }
  catch (error) {
    const diagnostic = jsonParseDiagnostic(error);
    throw Object.assign(
      new Error(`the attestation document ${documentPath} is not valid JSON (${diagnostic.cause}${diagnostic.location === undefined ? "" : ` at ${diagnostic.location}`}); --attestation must point at the operator's ActivationAttestation object`),
      { code: "workflow.adopt-terminal.attestation-malformed", details: { parser: diagnostic } },
    );
  }
}

async function assertLegacyRoute(harnessDir: string, operation: string): Promise<void> {
  if (await resolveExecutionReadRoute({ harnessDir }) === "execution") {
    throw new StoreError(
      "execution.consumer-not-ready",
      `state: active. Upgrade outcome: not required; ${operation}: the pre-activation form is retired. ` +
        `Nothing was written; use the active DB form with the current execution token under an independently acquired identity.`,
    );
}
}
function schema() {
  return z.object({
    workflow: z.string().min(1).optional(), harness: z.string().min(1).optional(), planId: z.string().min(1).optional(),
    planTitle: z.string().min(1).optional(), planFile: z.string().min(1).optional(), deliveryKind: z.enum(WORKFLOW_DELIVERY_KINDS).optional(),
    project: z.string().min(1).optional(), branchSource: z.string().min(1).optional(), branchTarget: z.string().min(1).optional(),
    completionPolicy: z.string().min(1).optional(), startedAt: z.string().min(1).optional(), expect: z.string().min(1).optional(),
    operation: z.string().min(1).optional(), file: z.string().min(1).optional(), declareKind: z.string().min(1).optional(),
    at: z.string().min(1).optional(), session: z.string().min(1).optional(), sessionRef: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(), priorSession: z.string().min(1).optional(), reason: z.string().min(1).optional(),
    stopped: z.array(z.string()).optional(), attestation: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(), authorizationRef: z.string().min(1).optional(), input: z.unknown().optional(),
    phase: z.string().min(1).optional(), status: z.string().min(1).optional(), path: z.string().min(1).optional(),
    compass: z.string().min(1).optional(), policy: z.unknown().optional(), json: z.boolean().optional(),
    row: z.array(z.unknown()).optional(), branchBase: z.string().min(1).optional(), branchIntegration: z.string().min(1).optional(),
    branchTargetIteration: z.string().min(1).optional(), compassRef: z.string().min(1).optional(),
  });
}

function makeDefinition(
  id: string,
  description: string,
  effect: "read" | "write",
  keys: readonly string[],
  execute: (input: z.infer<ReturnType<typeof schema>>, context: InvocationContext) => Promise<CommandEnvelope<unknown>>,
  contextOptions: readonly { key: string; context: "sessionId" }[] = [],
  optionHelp: Readonly<Record<string, string>> = {},
  payloadOverride: Readonly<Record<string, z.ZodType>> = {},
): CommandDefinition {
  const input = schema().pick(Object.fromEntries(keys.map((key) => [key, true])) as never);
  const optionNames = [...keys, ...contextOptions.map(({ key }) => key)];
  return {
    id,
    ...(id === "workflow.register" ? {
      requirements: [
        { name: "workflow", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "planId", ownership: "caller" as const, route: "cli" as const, required: true, constraint: "must equal the plan_id declared in the selected plan document header (canonical form: **plan_id:** <id>)" },
        { name: "planTitle", ownership: "caller" as const, route: "cli" as const, required: true, constraint: "must equal the selected plan document's H1 title" },
        { name: "planFile", ownership: "caller" as const, route: "cli" as const, required: true, constraint: "must identify the selected plan document under the canonical plans directory" },
        { name: "deliveryKind", ownership: "caller" as const, route: "cli" as const, required: true, constraint: `must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` },
        { name: "expect", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "operation" }, constraint: "supply together with operation to select active registration" },
        { name: "operation", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "expect" }, constraint: "supply together with expect to select active registration" },
        { name: "workflow", ownership: "caller" as const, route: "mcp" as const, required: true },
        { name: "planId", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must equal the plan_id declared in the selected plan document header (canonical form: **plan_id:** <id>)" },
        { name: "planTitle", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must equal the selected plan document's H1 title" },
        { name: "planFile", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must identify the selected plan document under the canonical plans directory" },
        { name: "deliveryKind", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: `must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` },
        { name: "expect", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "operation" }, constraint: "supply together with operation to select active registration" },
        { name: "operation", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "expect" }, constraint: "supply together with expect to select active registration" },
      ],
    } : {}),
    ...(id === "workflow.evidence" ? {
      requirements: [
        { name: "workflow", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "file", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "declareKind", present: false }, constraint: "absolute path to UTF-8 JSON file; supply exactly one of file or declareKind" },
        { name: "declareKind", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "file", present: false }, constraint: `pre-activation one-time declaration; one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}; supply exactly one of file or declareKind` },
        { name: "branchSource", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "declareKind", equals: "development" }, constraint: "source branch required for the one-time development declaration" },
        { name: "branchTarget", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "declareKind", equals: "development" }, constraint: "target branch required for the one-time development declaration" },
        { name: "completionPolicy", ownership: "caller" as const, route: "cli" as const, required: true, condition: { field: "declareKind", equals: "verification/report-only" }, constraint: "registered fulfilment policy required for report-only declaration" },
        { name: "workflow", ownership: "caller" as const, route: "mcp" as const, required: true },
        { name: "file", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "declareKind", present: false }, constraint: "absolute path to UTF-8 JSON file; supply exactly one of file or declareKind" },
        { name: "declareKind", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "file", present: false }, constraint: `pre-activation one-time declaration; one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}; supply exactly one of file or declareKind` },
        { name: "branchSource", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "declareKind", equals: "development" }, constraint: "source branch required for the one-time development declaration" },
        { name: "branchTarget", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "declareKind", equals: "development" }, constraint: "target branch required for the one-time development declaration" },
        { name: "completionPolicy", ownership: "caller" as const, route: "mcp" as const, required: true, condition: { field: "declareKind", equals: "verification/report-only" }, constraint: "registered fulfilment policy required for report-only declaration" },
        ...(["cli", "mcp"] as const).flatMap((route) => [
          { name: "sessionRef", ownership: "caller" as const, route, required: false, tokenKind: "workflow" as const, constraint: "when supplied, exec-session-v1 coordinator reference for this workflow; ACTIVE writes always require the acquired current operator identity" },
          { name: "expect", ownership: "caller" as const, route, required: false, tokenKind: "workflow" as const, constraint: "optional workflow CAS token on the ACTIVE operation route" },
          { name: "operation", ownership: "caller" as const, route, required: false, constraint: "ACTIVE write replay id; omitted creates one fresh id for this invocation; explicit values are preserved" },
          { name: "session", ownership: "caller" as const, route, required: false, constraint: "optional legacy pre-activation session path; refused on ACTIVE writes" },
          { name: "at", ownership: "caller" as const, route, required: false, constraint: "optional legacy pre-activation RFC3339 timestamp; omitted defaults to current time" },
        ]),
      ],
    } : {}),
    ...(id === "workflow.recover-coordinator" ? {
      requirements: [
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "cli" as const,
          required: true,
          condition: { field: "interruptedIntegrationMergeClaim", equals: true },
          constraint: "the pre-activation engine requires this operator attestation only when an interrupted integration-merge claim is held",
        },
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "mcp" as const,
          required: true,
          condition: { field: "interruptedIntegrationMergeClaim", equals: true },
          constraint: "the pre-activation engine requires this operator attestation only when an interrupted integration-merge claim is held",
        },
      ],
    } : {}),
    ...(id === "workflow.show-prepare" ? {
      requirements: [
        { name: "session", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "session", ownership: "caller" as const, route: "mcp" as const, required: true },
      ],
    } : {}),
    ...(id === "workflow.amend-prepare" ? {
      requirements: [
        { name: "session", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "input", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "session", ownership: "caller" as const, route: "mcp" as const, required: true },
        { name: "input", ownership: "caller" as const, route: "mcp" as const, required: true },
      ],
    } : {}),
    ...(id === "workflow.recover-coordinator" ? {
      requirements: [
        ...(["session", "operationId", "reason", "authorizationRef", "stopped"] as const).flatMap((name) => [
          { name, ownership: "caller" as const, route: "cli" as const, required: true },
          { name, ownership: "caller" as const, route: "mcp" as const, required: true },
        ]),
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "cli" as const,
          required: true,
          condition: { field: "interruptedIntegrationMergeClaim", equals: true },
          constraint: "the pre-activation engine requires this operator attestation only when an interrupted integration-merge claim is held",
        },
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "mcp" as const,
          required: true,
          condition: { field: "interruptedIntegrationMergeClaim", equals: true },
          constraint: "the pre-activation engine requires this operator attestation only when an interrupted integration-merge claim is held",
        },
      ],
    } : {}),
    ...(id === "workflow.adopt-terminal" ? {
      requirements: [
        ...(["expect", "operation"] as const).flatMap((name) => [
          {
            name,
            ownership: "caller" as const,
            route: "cli" as const,
            required: false,
            // The explicit entry overrides the route-derived `expect` hint, so
            // it is also the entry that must publish the CAS token kind.
            ...(name === "expect" ? { tokenKind: "revision" as const } : {}),
            constraint: name === "expect"
              ? "optional positive header revision CAS; when omitted, the current addressed revision is derived inside the adoption transaction"
              : "optional replay identifier; when omitted, one operation id is generated for this invocation",
          },
          {
            name,
            ownership: "caller" as const,
            route: "mcp" as const,
            required: false,
            ...(name === "expect" ? { tokenKind: "revision" as const } : {}),
            constraint: name === "expect"
              ? "optional positive header revision CAS; when omitted, the current addressed revision is derived inside the adoption transaction"
              : "optional replay identifier; when omitted, one operation id is generated for this invocation",
          },
        ]),
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "cli" as const,
          required: false,
          constraint: `required only for an eligible unadopted terminal header with current-epoch ACTIVE coordinator session(s); --attestation remains an absolute JSON file path, and its stoppedSessions must name every exact target as stopped/reloaded. The engine refuses undeclared/credential-bearing fields and self-settlement. ${attestationRules}`,
        },
        {
          name: "attestation",
          ownership: "caller" as const,
          route: "mcp" as const,
          required: false,
          constraint: `the same absolute JSON path string (same-host paths remain usable); the structure is adoptionAttestation in the command schema, and engine-semantic constraints are: ${attestationRules}`,
        },
      ],
    } : {}),
    cli: {
      path: id.split("."),
      aliases: [],
      arguments: [],
      options: optionNames.map((key) => {
        const field = input.shape[key as keyof typeof input.shape];
        const variadic = key === "stopped" || field instanceof z.ZodArray || (field instanceof z.ZodOptional && field.unwrap() instanceof z.ZodArray);
        return {
          key,
          flags: `--${key.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`)} <value${variadic ? "..." : ""}>`,
          required: false,
          ...(variadic ? { variadic: true } : {}),
          ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
          ...(contextOptions.find((option) => option.key === key) ?? {}),
        };
      }),
    },
    input,
    payloads: Object.fromEntries([
      ...keys.flatMap((key): [string, { schema: z.ZodType }][] => {
        if (key === "row") return [[key, { schema: z.array(z.unknown()) }]];
        if (key === "input" || key === "policy") return [[key, { schema: z.record(z.string(), z.unknown()) }]];
        const override = payloadOverride[key];
        return override === undefined ? [] : [[key, { schema: override }]];
      }),
      // An independent payload key whose option counterpart is a path (the
      // adapter reads the document), never an inline JSON field.
      ...Object.entries(payloadOverride)
        .filter(([key]) => !keys.includes(key))
        .map(([key, schema]): [string, { schema: z.ZodType; help?: string }] => [key, {
          schema,
          ...(key === "delivery" ? { help: "UTF-8 JSON object loaded from --file (pathname, never inline JSON); supply at least one complete member. development allows any subset of compound {outcome: created|updated|skipped, reason?: non-empty; required for skipped}, pr {repo,head,target: non-empty}, merge {provider,evidence: non-empty}; verification/report-only allows completion {policy,evidence: non-empty}. Omit untouched members; supplied member blocks are complete, not sub-field patches. Members outside registered delivery_kind are refused. A report-only completion.policy must match the registered completion_policy for lifecycle completion; a mismatched report may be recorded and corrected by another evidence update before close. A matching non-empty completion on a Done row is frozen; edit its referenced document in place, or use a separate workflow for a different completed intent. Done alone does not freeze other evidence. PR identity is immutable once recorded: keep its registered repo/head/target for that delivery, or use a separate workflow for a different PR. ACTIVE workflows use the DB-backed coordinator evidence operation; this --file route is pre-activation." } : {}),
        }]),
    ]),
    output: commandEnvelopeSchema,
    effects: [effect],
    description,
    execute,
  };
}

/**
 * Structural discovery shape for the engine-owned WorkflowDeliveryEvidence.
 * `recordWorkflowDelivery` / `mutateExecutionWorkflow` remain the validators;
 * the `WorkflowDeliveryEvidence` type and deliveryEvidenceViolations are the
 * contract authorities for members, partial updates, lifecycle kind and
 * provider/fulfilment invariants.
 */
const nonBlankEvidenceText = z.string().regex(/\S/, "must be non-empty");
const nonSkippedCompoundOutcomes = WORKFLOW_COMPOUND_OUTCOMES.filter(
  (outcome): outcome is Exclude<WorkflowCompoundOutcome, "skipped"> => outcome !== "skipped",
) as [Exclude<WorkflowCompoundOutcome, "skipped">, ...Exclude<WorkflowCompoundOutcome, "skipped">[]];
const compoundEvidenceSchema = z.union([
  z.object({ outcome: z.literal("skipped"), reason: nonBlankEvidenceText }).strict(),
  z.object({ outcome: z.enum(nonSkippedCompoundOutcomes), reason: nonBlankEvidenceText.optional() }).strict(),
]);
const prEvidenceSchema = z.object({ repo: nonBlankEvidenceText, head: nonBlankEvidenceText, target: nonBlankEvidenceText }).strict();
const mergeEvidenceSchema = z.object({ provider: nonBlankEvidenceText, evidence: nonBlankEvidenceText }).strict();
const completionEvidenceSchema = z.object({ policy: nonBlankEvidenceText, evidence: nonBlankEvidenceText }).strict();
const deliveryEvidenceFields = {
  compound: compoundEvidenceSchema.optional(),
  pr: prEvidenceSchema.optional(),
  merge: mergeEvidenceSchema.optional(),
  completion: completionEvidenceSchema.optional(),
};
const deliveryEvidenceSchema: z.ZodType<WorkflowDeliveryEvidence> = z.union([
  z.object({ ...deliveryEvidenceFields, compound: compoundEvidenceSchema }).strict(),
  z.object({ ...deliveryEvidenceFields, pr: prEvidenceSchema }).strict(),
  z.object({ ...deliveryEvidenceFields, merge: mergeEvidenceSchema }).strict(),
  z.object({ ...deliveryEvidenceFields, completion: completionEvidenceSchema }).strict(),
]);

export function getWorkflowCommandDefinitions(): readonly CommandDefinition[] {
  const commonRegister = ["workflow", "planId", "planTitle", "planFile", "deliveryKind", "project", "branchSource", "branchTarget", "completionPolicy", "startedAt", "harness", "expect", "operation", "json"] as const;
  const defs: CommandDefinition[] = [
    makeDefinition("workflow.register", "Register a standalone plan workflow using create-only catalog registration and active DB CAS when selected.", "write", commonRegister, async (input, context) => {
      try {
        const required = [input.workflow, input.planId, input.planTitle, input.planFile, input.deliveryKind];
        if (required.some((value) => value === undefined || value.trim() === "")) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow, planId, planTitle, planFile and deliveryKind are required" });
        if (!(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(input.deliveryKind!)) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: `deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` });
        const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
        if (harnessDir === null) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "harness dir not found; supply harness" });
        const workflow: CatalogExecutionWorkflow = { kind: "plan", workflowId: input.workflow!, options: { harnessDir, plan: { id: input.planId!, title: input.planTitle!, file: input.planFile! }, deliveryKind: input.deliveryKind as never, ...(input.project === undefined ? {} : { project: input.project }), ...(input.branchSource === undefined ? {} : { branchSource: input.branchSource }), ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }), ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
        setArtifactStore(createFsStore(harnessDir));
        if (input.expect !== undefined || input.operation !== undefined) {
          if (input.expect === undefined || input.operation === undefined) {
            return activeRegistrationRefusal("workflow.register", [
              ...(input.expect === undefined ? ["expect"] : []),
              ...(input.operation === undefined ? ["operation"] : []),
            ]);
          }
          const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId ?? "", workflowId: input.workflow!, role: "coordinator" };
          const { catalogRevision } = await readCatalogRevisions({ harnessDir });
          const canonicalPlanAbs = path.isAbsolute(input.planFile!) ? path.resolve(input.planFile!) : path.join(harnessDir, input.planFile!);
          const plansRelative = path.relative(resolvePlanDir(harnessDir), canonicalPlanAbs);
          const relativePath = plansRelative === ".." || plansRelative.startsWith(`..${path.sep}`) || path.isAbsolute(plansRelative) ? input.planFile! : plansRelative;
          // Creator attribution is optional: an unset session id registers a
          // NULL creator that the first coordinator bind adopts.
          return ok("workflow.register", await commitExecutionRegistration(executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }), { operationId: input.operation, actor: "mcp:workflow-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "plan", id: input.planId!, title: input.planTitle!, rootKind: "plans", relativePath }], binding: { catalogKind: "plan", catalogId: input.planId! } }, expected: input.expect as never }));
        }
        await assertLegacyRoute(harnessDir, "workflow register");
        return ok("workflow.register", await registerShippedCatalogExecution({ harnessDir }, { operationId: randomUUID(), actor: "mcp:workflow-register", workflow }));
      } catch (error) { return engineRefusal("workflow.register", error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      expect: `CAS expectation: ${TOKEN_SUPPLIES.root}`,
      planTitle: "Must match the selected plan document's H1; that document is the registration authority.",
    }),
    makeDefinition("workflow.evidence", "Record delivery evidence or a one-time kind declaration. `--file` is a pathname (never inline JSON): it must be absolute and name a UTF-8 JSON file containing a non-empty object with at least one member. For `development`, members are any subset of compound {outcome: created|updated|skipped, reason?: non-empty string; reason is required for skipped}, pr {repo, head, target: non-empty strings}, and merge {provider, evidence: non-empty strings}; for `verification/report-only`, the only member is completion {policy, evidence: non-empty strings}. Omit untouched members; supplied members are complete blocks, not sub-field patches. `completion.policy` must match the registered `completion_policy` for lifecycle completion; a mismatched report may be recorded and corrected by another evidence update before close. A matching non-empty completion on a Done row is frozen; edit its referenced document in place, or use a separate workflow for a different completed intent. Done alone does not freeze other evidence. PR identity is immutable once recorded: keep its registered repo/head/target for that delivery, or use a separate workflow for a different PR. The declared delivery_kind selects permitted members and is never inferred. The pre-activation FILE route writes snapshots; ACTIVE workflows use the DB-backed coordinator evidence operation and close guard.", "write", ["workflow", "file", "declareKind", "branchSource", "branchTarget", "completionPolicy", "session", "sessionRef", "expect", "operation", "at", "harness"], async (input, context) => {
      try {
        if (input.workflow === undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow is required" });
        if ((input.file === undefined) === (input.declareKind === undefined)) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "provide exactly one of file or declareKind" });
        if (input.declareKind !== undefined && !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(input.declareKind)) {
          return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: `--declare-kind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` });
        }
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "harness dir not found; supply harness" });
        setArtifactStore(createFsStore(root));
        const workflowDir = path.join(resolveWorkflowDir(root, { harnessDir: root }), input.workflow);
        if (input.declareKind !== undefined) {
          if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "declareKind is pre-activation only" });
          await assertLegacyRoute(root, "workflow evidence --declare-kind");
          const result = await declareWorkflowDeliveryKind(input.workflow, workflowDir, { deliveryKind: input.declareKind as never, ...(input.branchSource === undefined ? {} : { branchSource: input.branchSource }), ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }), ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }), ...(input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }), ...(input.at === undefined ? {} : { at: input.at }) });
          return ok("workflow.evidence", result);
        }
        const evidence = JSON.parse(readFileSync(absolute(input.file, "file"), "utf8")) as Record<string, unknown>;
        const active = (await resolveExecutionReadRoute({ harnessDir: root })) === "execution";
        if (input.sessionRef !== undefined || input.expect !== undefined || input.operation !== undefined || active) {
          if (context.sessionId === undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: `active evidence requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).` });
          if (input.at !== undefined || input.session !== undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active evidence cannot use legacy session or at fields" });
          if (input.expect !== undefined && typeof input.expect !== "string") return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "active evidence requires a full workflow execution token" });
          const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
          const acquired = context.executionIdentity;
          if (ref !== undefined && (ref.workflowId !== input.workflow || ref.role !== "coordinator")) {
            return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "sessionRef must address the selected workflow's coordinator seat" });
          }
          if (acquired !== undefined && (acquired.workflowId !== input.workflow || acquired.role !== "coordinator")) {
            return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired identity must address the selected workflow's coordinator seat" });
          }
          const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator" };
          return ok("workflow.evidence", await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
            workflowId: input.workflow,
            ...(ref === undefined ? {} : { session: ref }),
            ...(input.expect === undefined ? {} : { expected: input.expect as never }),
            operationId: input.operation ?? randomUUID(),
            operation: { kind: "delivery", delivery: evidence },
          }));
        }
        await assertLegacyRoute(root, "workflow evidence");
        return ok("workflow.evidence", await recordWorkflowDelivery(input.workflow, workflowDir, { evidence, ...(input.session === undefined ? {} : { sessionPath: absolute(input.session, "session") }), ...(input.at === undefined ? {} : { at: input.at }) }));
      } catch (error) { return engineRefusal("workflow.evidence", error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      expect: `CAS expectation: ${TOKEN_SUPPLIES.workflow}`,
      sessionRef: `session transport: ${SESSION_REF_SUPPLIES}`,
      file: "Path-only wire: absolute path to a UTF-8 JSON file; inline JSON text is not accepted.",
    }, { delivery: deliveryEvidenceSchema }),
    makeDefinition("workflow.show-prepare", "Read the pre-activation Prepare workflow view from its coordinator session envelope.", "read", ["session"], async (input, context) => {
      try { if (input.session === undefined) return refusalEnvelope({ command: "workflow.show-prepare", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session is required" }); return ok("workflow.show-prepare", await showPrepareWorkflow({ sessionPath: absolute(input.session, "session"), cwd: context.cwd })); } catch (error) { return engineRefusal("workflow.show-prepare", error); }
    }),
    makeDefinition("workflow.amend-prepare", "Append approved Prepare rows under the current coordinator and row state.", "write", ["session", "input"], async (input, context) => {
      try {
        if (input.session === undefined || input.input === undefined) return refusalEnvelope({ command: "workflow.amend-prepare", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session and input patch are required" });
        const sessionPath = absolute(input.session, "session");
        const envelope = readSessionEnvelope(sessionPath);
        await assertLegacyRoute(envelope.harness_root, "workflow amend-prepare");
        return ok("workflow.amend-prepare", await amendPrepareWorkflow({ sessionPath, cwd: context.cwd, patch: object(input.input, "input") as never }));
      } catch (error) { return engineRefusal("workflow.amend-prepare", error); }
    }),
    makeDefinition("workflow.recover-coordinator", "Recover a stopped workflow coordinator on the pre-activation FILE route: the prior session's coordinator binding is replaced and the exact prior claim is settled atomically. `--attestation <absolute-json>` supplies the operator's full ActivationAttestation, which the engine REQUIRES when an interrupted integration-merge claim is held; it is optional when no such claim exists. Reading the document is this command's admission step \u2014 the engine performs the authority discrimination. An ACTIVE execution authority is not this verb's transport: that route refuses here and points at `mstar session recover` with its existing supported flags. It does not resume a session: the engine settles the exact prior claim atomically as part of the replacement.", "write", ["session", "operationId", "reason", "authorizationRef", "stopped", "attestation", "harness"], async (input, context) => {
      try {
        if (context.sessionId === undefined || context.sessionId.trim() === "") {
          return refusalEnvelope({ command: "workflow.recover-coordinator", status: "usage", code: "command.invalid-input", exitCode: 2, message: `recovery requires the main conversation session identity (${IDENTITY_SUPPLIES}).` });
        }
        if (input.session === undefined || input.operationId === undefined || input.reason === undefined || input.authorizationRef === undefined || input.stopped === undefined) {
          return refusalEnvelope({ command: "workflow.recover-coordinator", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session, operationId, reason, authorizationRef and stopped are required" });
        }
        // The admission step is reading the operator's stop document. The
        // engine requires it when an interrupted mutex claim is held and
        // performs the authority discrimination itself; the CLI never decides
        // which transport applies.
        const attestation = input.attestation === undefined
          ? undefined
          : JSON.parse(readFileSync(absolute(input.attestation, "attestation"), "utf8")) as ActivationAttestation;
        const priorSessionPath = absolute(input.session, "session");
        const prior = readSessionEnvelope(priorSessionPath);
        // The ACTIVE authority is a different transport with its own supported
        // verb (`mstar session recover`); this FILE verb never doubles as it.
        if (await resolveExecutionReadRoute({ harnessDir: prior.harness_root }) === "execution") {
          return refusalEnvelope({
            command: "workflow.recover-coordinator",
            status: "usage",
            code: "command.invalid-input",
            exitCode: 2,
            message: "this FILE-route recovery does not apply on an ACTIVE execution authority; use `mstar session recover --workflow <id> (--prior-session <id>|--unowned) --reason <text> --attestation <absolute-json> --expect <token> --operation <id>` instead",
          });
        }
        setArtifactStore(createFsStore(prior.harness_root));
        return ok("workflow.recover-coordinator", await recoverPrepareCoordinator({
          cwd: context.cwd,
          harnessDir: prior.harness_root,
          identity: { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: prior.workflow_id, role: "coordinator" },
          priorSessionPath,
          priorSessionId: prior.session_id,
          operationId: input.operationId,
          reason: input.reason,
          authorizationRef: input.authorizationRef,
          stoppedSessionIds: input.stopped,
          ...(attestation === undefined ? {} : { attestation }),
        }));
      } catch (error) { return engineRefusal("workflow.recover-coordinator", error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      attestation: "absolute path to the operator's ActivationAttestation JSON \u2014 the engine requires it when an interrupted integration-merge claim is held",
    }),
    makeDefinition(
      "workflow.adopt-terminal",
      "Adopt an eligible unadopted terminal header without registry membership. An optional --expect is a positive header-revision CAS; if omitted, the engine derives the current revision inside the guarded transaction. An omitted --operation gets one generated id for this invocation. If the eligible header holds current-epoch ACTIVE coordinator session(s), the same transaction settles only the exact sessions supported by genuine operator stop evidence supplied through --attestation <absolute-json>; its stoppedSessions must name every target stopped/reloaded. The engine refuses self-settlement, invalid proof, and changed proof under a committed operation id. It does not infer that a process stopped or that consumer/operator facts are true.",
      "write",
      ["workflow", "harness", "expect", "operation", "reason", "attestation"],
      async (input, context) => {
        const id = "workflow.adopt-terminal";
        try {
          if (context.sessionId === undefined || context.sessionId.trim() === "") {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `terminal adoption requires an acquired coordinator identity (${IDENTITY_RECOVERY})` });
          }
          const acquired = context.executionIdentity;
          const workflowId = input.workflow ?? acquired?.workflowId;
          if (workflowId === undefined || input.reason === undefined) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow and reason are required; expect and operation may be omitted safely" });
          }
          if (input.expect !== undefined && (!/^[1-9]\d*$/.test(input.expect) || !Number.isSafeInteger(Number(input.expect)))) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "--expect must be a positive integer header revision" });
          }
          if (acquired !== undefined && (acquired.workflowId !== workflowId || acquired.role !== "coordinator")) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired caller identity does not address the selected coordinator workflow" });
          }
          const attestation = input.attestation === undefined
            ? undefined
            : readAdoptionAttestation(absolute(input.attestation, "attestation"));
          const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
          if (harnessDir === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
          const active = await resolveExecutionReadRoute({ harnessDir });
          if (active !== "execution") {
            return refusalEnvelope({
              command: id,
              status: "refused",
              code: "execution.adoption-refused",
              exitCode: 1,
              message: "terminal adoption requires an active execution authority",
              recovery: "Run `mstar status validate` to inspect the harness, then `mstar store upgrade --operator <name>` to import legacy execution state and activate the execution authority before retrying adoption.",
            });
          }
          const identity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId, role: "coordinator" as const };
          return ok(id, await adoptTerminalWorkflow(executionContextFor({ harnessDir }, identity), {
            workflowId,
            ...(input.expect === undefined ? {} : { expectedRevision: Number(input.expect) }),
            reason: input.reason,
            operationId: input.operation ?? randomUUID(),
            ...(attestation === undefined ? {} : { attestation }),
          }));
        } catch (error) {
          return engineRefusal(id, error);
        }
      },
      [{ key: "sessionId", context: "sessionId" }],
      {
        expect: "Optional positive header-revision CAS; when omitted the engine derives the current addressed revision inside the guarded adoption transaction.",
        operation: "Optional idempotency/replay id; when omitted one id is generated for this invocation.",
        attestation: `absolute JSON file path for operator proof; required only for eligible unadopted terminal headers with current-epoch ACTIVE coordinator sessions. Exact structure is payload adoptionAttestation; shared semantic constraints: ${attestationRules}`,
      },
      { adoptionAttestation: activationAttestationDocumentSchema },
    ),
  ];
  for (const transition of transitions) {
    const id = `workflow.${transition.name}`;
    defs.push(makeDefinition(id, `Apply the existing active workflow ${transition.name} transition under coordinator scope.`, transition.effect, ["workflow", "sessionRef", "expect", "operation", "harness", "phase", "compass", "status", "reason", "file", "path"], async (input, context) => {
      try {
        if (context.sessionId === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active workflow transition requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).` });
        const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
        const acquired = context.executionIdentity;
        const workflowId = input.workflow ?? acquired?.workflowId ?? ref?.workflowId;
        if (workflowId === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow selector or minted workflow identity is required" });
        if (ref !== undefined && (ref.workflowId !== workflowId || ref.role !== "coordinator")) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "sessionRef must address the selected workflow's coordinator seat" });
        }
        if (acquired !== undefined && (acquired.workflowId !== workflowId || acquired.role !== "coordinator")) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired caller identity does not address the selected coordinator workflow" });
        }
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
        const operation: WorkflowExecutionOperation = transition.name === "phase"
          ? input.phase === undefined || input.compass === undefined || !path.isAbsolute(input.compass) ? (() => { throw new Error("phase requires phase and absolute compass") })() : { kind: "phase", phase: input.phase, compassPath: input.compass }
          : transition.name === "lifecycle"
            ? input.status === undefined || input.reason === undefined || !(WORKFLOW_LIFECYCLE_STATUSES as readonly string[]).includes(input.status) ? (() => { throw new Error("lifecycle requires a supported status and reason") })() : { kind: "lifecycle", status: input.status as never, reason: input.reason }
            : transition.name === "execution-policy"
              ? { kind: "execution-policy", policy: JSON.parse(readFileSync(absolute(input.file, "file"), "utf8")) }
              : { kind: "integration-worktree", path: absolute(input.path, "path") };
        const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId, role: "coordinator" };
        setArtifactStore(createFsStore(root));
        return ok(id, await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
          workflowId,
          ...(ref === undefined ? {} : { session: ref }),
          ...(input.expect === undefined ? {} : { expected: input.expect as never }),
          operationId: input.operation ?? randomUUID(),
          operation,
        }));
      } catch (error) { return engineRefusal(id, error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      expect: `CAS expectation: ${TOKEN_SUPPLIES.workflow}`,
      sessionRef: `session transport: ${SESSION_REF_SUPPLIES}`,
    }));
  }
  defs.push(makeDefinition("iteration.register", "Register a create-only iteration workflow with its branch anchors and Todo rows.", "write", ["workflow", "compassRef", "branchBase", "branchIntegration", "branchTargetIteration", "row", "project", "startedAt", "harness", "expect", "operation"], async (input, context) => {
    try {
      if (input.workflow === undefined || input.workflow.trim() === "" || input.compassRef === undefined || input.compassRef.trim() === "" || input.branchBase === undefined || input.branchBase.trim() === "" || input.branchIntegration === undefined || input.branchIntegration.trim() === "" || input.branchTargetIteration === undefined || input.branchTargetIteration.trim() === "" || input.row === undefined || input.row.length === 0) {
        return refusalEnvelope({ command: "iteration.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow, compassRef, all branch anchors and rows are required" });
      }
      const rows = input.row.map((value) => {
        if (typeof value !== "string") return value;
        try { return JSON.parse(value); } catch { return undefined; }
      });
      if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
        return refusalEnvelope({ command: "iteration.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "each row must be a JSON object" });
      }
      const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
      if (harnessDir === null) return refusalEnvelope({ command: "iteration.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "harness dir not found; supply harness" });
      // Normalize BEFORE the registration workflow/catalog plan is composed:
      // the catalog identity is derived from this same value, so the caller's
      // absolute-in-root spelling must reach every consumer in the stored
      // (harness-relative) contract form — otherwise the producer's own
      // normalization would disagree with the catalog plan and the post-write
      // identity check would refuse an otherwise-successful registration
      // (Greptile #301 issue 1).
      const compassRef = normalizeIterationCompassRef(input.compassRef, harnessDir, (detail) => new WorkflowInputError(detail));
      const workflow: CatalogExecutionWorkflow = { kind: "iteration", workflowId: input.workflow, options: { harnessDir, compassRef, branch: { base: input.branchBase, integration: input.branchIntegration, target: input.branchTargetIteration }, rows: rows as never[], ...(input.project === undefined ? {} : { project: input.project }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
      setArtifactStore(createFsStore(harnessDir));
      if (input.expect !== undefined || input.operation !== undefined) {
        if (input.expect === undefined || input.operation === undefined) {
          return activeRegistrationRefusal("iteration.register", [
            ...(input.expect === undefined ? ["expect"] : []),
            ...(input.operation === undefined ? ["operation"] : []),
          ]);
        }
        const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId ?? "", workflowId: input.workflow, role: "coordinator" };
        const { catalogRevision } = await readCatalogRevisions({ harnessDir });
        // Creator attribution is optional: an unset session id registers a
        // NULL creator that the first coordinator bind adopts.
        return ok("iteration.register", await commitExecutionRegistration(executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }), { operationId: input.operation, actor: "mcp:iteration-register", expectedCatalogRevision: catalogRevision, workflow, delta: { entities: [{ kind: "iteration", id: input.workflow, title: input.workflow, rootKind: "iterations", relativePath: input.workflow }], binding: { catalogKind: "iteration", catalogId: input.workflow } }, expected: input.expect as never }));
      }
      await assertLegacyRoute(harnessDir, "iteration register");
      return ok("iteration.register", await registerShippedCatalogExecution({ harnessDir }, { operationId: randomUUID(), actor: "mcp:iteration-register", workflow }));
    } catch (error) { return engineRefusal("iteration.register", error); }
  }, [{ key: "sessionId", context: "sessionId" }], { expect: `CAS expectation: ${TOKEN_SUPPLIES.root}` }));
  return defs;
}
