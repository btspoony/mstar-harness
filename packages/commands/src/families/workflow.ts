import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  PLAN_PARALLELISM_VALUES,
  WORKFLOW_COMPOUND_OUTCOMES, WORKFLOW_DELIVERY_KINDS, WORKFLOW_LIFECYCLE_STATUSES,
  adoptTerminalWorkflow, createFsStore, decodeExecutionSessionRef,
  executionContextFor, mutateExecutionWorkflow, registerShippedCatalogExecution,
  reopenExecutionWorkflow, resolveProcessHarnessDir, setArtifactStore,
  type ActivationAttestation,
  type CatalogExecutionWorkflow, type ExecutionIdentity, type ExecutionToken, type WorkflowCompoundOutcome,
  type WorkflowDeliveryEvidence, type WorkflowExecutionOperation, type WorkflowExecutionPolicy,
} from "@mstar-harness/engine";
import { redactSecrets } from "@mstar-harness/engine/src/audit";
import { activationAttestationDocumentConstraints, activationAttestationDocumentSchema } from "../activation-attestation.js";
import { commandEnvelopeSchema } from "../envelope.js";
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
  const posixReadFailure = /^E[A-Z0-9]+$/.test(code);
  const proofRequired = adoptionRefusal === "active-session-proof-required";
  const proofIncomplete = adoptionRefusal === "active-session-proof-incomplete";
  const recovery = proofRequired
    ? `Terminal adoption can settle the eligible unregistered header's ACTIVE coordinator session(s) ${holderList} only against genuine operator stop evidence. The refusal details include attestationContract.schema and attestationContract.constraints for the full document; write an absolute JSON file whose stoppedSessions names every listed target as stopped/reloaded, then retry ` +
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
            : code === "execution.adoption-refused" && message.includes("has no header to adopt")
              ? "The missing header cannot be adopted; create/register a new workflow through `mstar workflow register` with a valid catalog selection."
              : code === "execution.adoption-refused" && message.includes("already registered")
                ? "Run `mstar status workflow-close --workflow <id> --reason <text>` through the existing registered-workflow close path under the ACTIVE coordinator holder's binding."
                : code === "execution.adoption-refused" && message.includes("already has a terminal-adoption record")
                  ? "Read `mstar status validate`; the existing terminal-adoption record is already the close receipt, so no further adoption is needed."
                  : (id === "workflow.adopt-terminal" || id === "workflow.reopen") &&
                      (code === `${id}.attestation-unreadable` ||
                        code === `${id}.attestation-malformed` || posixReadFailure)
                      ? id === "workflow.reopen"
                        ? "Supply --attestation as an absolute path to the operator's recovery-scope JSON document: version, attestedAt, operator.actor, operator.authorizationRef and a stoppedSessions array (possibly empty); consumers is optional and ignored. The attestation is self-reported operator authorization, not verified host evidence."
                        : "Supply --attestation as an absolute path to the operator's ActivationAttestation JSON document; `mstar schema --command workflow.adopt-terminal` (payload contract adoptionAttestation) publishes its structure and semantic constraints."
                    : (id === "workflow.evidence" || id === "workflow.execution-policy") &&
                      (code === `${id}.file-malformed` || posixReadFailure)
                      ? (id === "workflow.evidence"
                        ? "Correct the absolute JSON path supplied with --file, then retry mstar workflow evidence --workflow <id> --file <absolute-json>."
                        : "Correct the absolute JSON path supplied with --file, then retry mstar workflow execution-policy --workflow <id> --file <absolute-json>.")
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
  const supportedRecovery = recovery ?? (code === "workflow.reopen-completed"
    ? "A completed lifecycle is never reopened and this route has no override: keep its recorded history and register a new lifecycle for further work (mstar workflow register)."
    : code === "workflow.reopen-not-terminal"
      ? "Read `mstar status validate`: only a failed or stopped lifecycle is reopened, and a running or paused one is already active."
      : "mstar status validate.");
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1,
    message,
    details: refusalDetails ?? {},
    recovery: supportedRecovery,
  });
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
function parseWorkflowJson<T>(text: string, label: string, code: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const diagnostic = jsonParseDiagnostic(error);
    throw Object.assign(
      new Error(`${label} is not valid JSON (${diagnostic.cause}${diagnostic.location === undefined ? "" : ` at ${diagnostic.location}`})`),
      { code, details: { parser: diagnostic } },
    );
  }
}
/**
 * The transport mirror of the engine's declared `WorkflowExecutionPolicy`
 * (`packages/engine/src/workflow.ts`). `policy` is parsed AND published through
 * this one schema, so `mstar schema --command workflow.execution-policy` states
 * the shape the `--file` route accepts — including the `plan_parallelism` set
 * the engine refuses anything outside of, taken from the engine's own
 * `PLAN_PARALLELISM_VALUES` so the accepted values have one authority and
 * cannot drift. `worktree_mode` / `push_policy` stay
 * accepted-but-opaque, and `passthrough` keeps the engine's own
 * `coordination.forbidden-field` guard as the authority on unknown keys: the
 * transport must not refuse them with a weaker message first.
 */
const workflowExecutionPolicySchema = z.object({
  plan_parallelism: z.enum(PLAN_PARALLELISM_VALUES).optional().describe("Concurrency contract: serial or parallel. Any other value is refused."),
  worktree_mode: z.unknown().optional().describe("Accepted-but-opaque worktree mode value; copied into the policy block unchanged."),
  push_policy: z.unknown().optional().describe("Accepted-but-opaque push policy value; copied into the policy block unchanged."),
}).passthrough();

function parseWorkflowExecutionPolicy(text: string): WorkflowExecutionPolicy {
  const parsed = workflowExecutionPolicySchema.safeParse(
    parseWorkflowJson<unknown>(text, "execution policy file", "workflow.execution-policy.file-malformed"),
  );
  if (!parsed.success) {
    // The refusal names the offending member(s) as the file spells them; a
    // bare "needs a policy object" would hide which value the engine's closed
    // set rejected.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? "policy" : issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WorkflowInputError(`an execution-policy operation needs a policy object: ${problems}`);
  }
  return parsed.data;
}
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
  const scrubbed = redactSecrets(cause === "" ? "syntax error" : cause).text;
  return { cause: scrubbed, ...(location === undefined ? {} : { location }) };
}

function readOperatorAttestation(documentPath: string, id: string, label: string): ActivationAttestation {
  let text: string;
  try { text = readFileSync(documentPath, "utf8"); }
  catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : `${id}.attestation-unreadable`;
    throw Object.assign(new Error(`the attestation document ${documentPath} could not be read: ${cause}`), { code });
  }
  try { return JSON.parse(text) as ActivationAttestation; }
  catch (error) {
    const diagnostic = jsonParseDiagnostic(error);
    throw Object.assign(
      new Error(`the attestation document ${documentPath} is not valid JSON (${diagnostic.cause}${diagnostic.location === undefined ? "" : ` at ${diagnostic.location}`}); --attestation must point at the operator's ${label} object`),
      { code: `${id}.attestation-malformed`, details: { parser: diagnostic } },
    );
  }
}

function schema() {
  return z.object({
    workflow: z.string().min(1).optional(), harness: z.string().optional(), planId: z.string().min(1).optional(),
    planTitle: z.string().min(1).optional(), planFile: z.string().min(1).optional(), deliveryKind: z.enum(WORKFLOW_DELIVERY_KINDS).optional(),
    project: z.string().min(1).optional(), branchWork: z.string().min(1).optional(), branchSource: z.string().min(1).optional(), branchTarget: z.string().min(1).optional(),
    completionPolicy: z.string().min(1).optional(), startedAt: z.string().min(1).optional(), expect: z.string().min(1).optional(),
    operation: z.string().min(1).optional(), file: z.string().min(1).optional(),
    sessionRef: z.string().min(1).optional(), sessionId: z.string().min(1).optional(), priorSession: z.string().min(1).optional(),
    reason: z.string().min(1).optional(), stopped: z.array(z.string()).optional(), attestation: z.string().min(1).optional(),
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
        { name: "expect", ownership: "caller" as const, route: "cli" as const, required: false, tokenKind: "root" as const, constraint: "optional checked constraint on the current root execution token" },
        { name: "operation", ownership: "caller" as const, route: "cli" as const, required: false, constraint: "optional pinned replay id" },
        { name: "workflow", ownership: "caller" as const, route: "mcp" as const, required: true },
        { name: "planId", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must equal the plan_id declared in the selected plan document header (canonical form: **plan_id:** <id>)" },
        { name: "planTitle", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must equal the selected plan document's H1 title" },
        { name: "planFile", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "must identify the selected plan document under the canonical plans directory" },
        { name: "deliveryKind", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: `must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` },
        { name: "expect", ownership: "caller" as const, route: "mcp" as const, required: false, tokenKind: "root" as const, constraint: "optional checked constraint on the current root execution token" },
        { name: "operation", ownership: "caller" as const, route: "mcp" as const, required: false, constraint: "optional pinned replay id" },
      ],
    } : {}),
    ...(id === "iteration.register" ? {
      requirements: (["cli", "mcp"] as const).flatMap((route) => [
        { name: "expect", ownership: "caller" as const, route, required: false, tokenKind: "root" as const, constraint: "optional checked constraint on the current root execution token" },
        { name: "operation", ownership: "caller" as const, route, required: false, constraint: "optional pinned replay id" },
      ]),
    } : {}),
    ...(id === "workflow.evidence" ? {
      requirements: [
        { name: "workflow", ownership: "caller" as const, route: "cli" as const, required: true },
        { name: "file", ownership: "caller" as const, route: "cli" as const, required: true, constraint: "absolute path to UTF-8 JSON file containing delivery evidence" },
        { name: "workflow", ownership: "caller" as const, route: "mcp" as const, required: true },
        { name: "file", ownership: "caller" as const, route: "mcp" as const, required: true, constraint: "absolute path to UTF-8 JSON file containing delivery evidence" },
        ...(["cli", "mcp"] as const).flatMap((route) => [
          { name: "sessionRef", ownership: "caller" as const, route, required: false, tokenKind: "workflow" as const, constraint: "when supplied, exec-session-v1 coordinator reference for this workflow; ACTIVE writes always require the acquired current operator identity" },
          { name: "expect", ownership: "caller" as const, route, required: false, tokenKind: "workflow" as const, constraint: "optional workflow CAS token on the ACTIVE operation route" },
          { name: "operation", ownership: "caller" as const, route, required: false, constraint: "ACTIVE write replay id; omitted creates one fresh id for this invocation; explicit values are preserved" },
        ]),
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
          constraint: `required only for an eligible unregistered header with current-epoch ACTIVE coordinator session(s); --attestation remains an absolute JSON file path, and its stoppedSessions must name every exact target as stopped/reloaded. The engine refuses undeclared/credential-bearing fields and self-settlement. ${attestationRules}`,
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
    ...(id === "workflow.reopen" ? {
      requirements: (["cli", "mcp"] as const).flatMap((route) => [
        {
          name: "expect",
          ownership: "caller" as const,
          route,
          required: false,
          tokenKind: "workflow" as const,
          constraint:
            "checked CAS on the closed header's current terminal token, exactly as `mstar status validate` publishes it " +
            "(terminalUnregistered[].token or terminalAdoptions[].token); when omitted this verb reads that token itself and " +
            "passes it explicitly, so the transition is always CAS-guarded",
        },
        { name: "operation", ownership: "caller" as const, route, required: false, constraint: "optional replay id; omitted creates one fresh id for this invocation" },
        { name: "reason", ownership: "caller" as const, route, required: true, constraint: "recorded with the transition: the operator-facing justification, never generated from the request" },
        {
          name: "attestation",
          ownership: "caller" as const,
          route,
          required: true,
          constraint:
            "absolute JSON path to the operator's recovery-scope document: version, attestedAt, operator.actor, " +
            "operator.authorizationRef and a stoppedSessions array (possibly empty); consumers is optional and ignored. " +
            "The attestation is SELF-REPORTED operator authorization — structure is validated, host liveness is not",
        },
      ]),
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
          ...(key === "policy" ? { help: "Execution-policy object loaded from --file (pathname, never inline JSON): plan_parallelism, worktree_mode and push_policy, every member optional. The object REPLACES the recorded policy block — an omitted key is removed, never retained. plan_parallelism is the closed serial | parallel set; an unknown key is refused. Read the declared shape with mstar schema --command workflow.execution-policy." } : {}),
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
 * `mutateExecutionWorkflow` validates delivery evidence; the
 * `WorkflowDeliveryEvidence` type and deliveryEvidenceViolations are the
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

/**
 * Non-blocking advisory for a `development` registration whose delivery
 * branch and target name the same branch: such a pair cannot describe a
 * delivery PR. The registration still succeeds - the warning rides in the ok
 * envelope's `data.warnings` and never refuses.
 */
function deliveryAnchorWarnings(deliveryKind: string, work: string | undefined, target: string | undefined): string[] {
  if (deliveryKind !== "development") return [];
  if (work === undefined || target === undefined || work !== target) return [];
  return [
    `--branch-work/--branch-target: both were recorded as ${JSON.stringify(work)}, so branch.work === branch.target and the anchors name no delivery PR. ` +
    "--branch-work is the branch the delivery PR comes from, normally the plan's own feature branch; " +
    "`mstar plan complete` compares it with the plan row's recorded working branch. " +
    "Repair the registered workflow with `mstar workflow delivery-anchors --workflow <id> --branch-work <branch> --reason <text>`.",
  ];
}

export function getWorkflowCommandDefinitions(): readonly CommandDefinition[] {
  const commonRegister = ["workflow", "planId", "planTitle", "planFile", "deliveryKind", "project", "branchBase", "branchWork", "branchSource", "branchTarget", "completionPolicy", "startedAt", "harness", "expect", "operation", "json"] as const;
  const defs: CommandDefinition[] = [
    makeDefinition("workflow.register", "Register a standalone plan workflow on the ACTIVE execution authority.", "write", commonRegister, async (input, context) => {
      try {
        const required = [input.workflow, input.planId, input.planTitle, input.planFile, input.deliveryKind];
        if (required.some((value) => value === undefined || value.trim() === "")) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow, planId, planTitle, planFile and deliveryKind are required" });
        if (!(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(input.deliveryKind!)) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: `deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}` });
        const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
        if (harnessDir === null) return refusalEnvelope({ command: "workflow.register", status: "usage", code: "command.invalid-input", exitCode: 2, message: "harness dir not found; supply harness" });
        // `--branch-source` is the deprecated alias of `--branch-work`: the two
        // flags write the one delivery branch, and the current name wins when
        // both are supplied.
        const branchWork = input.branchWork ?? input.branchSource;
        const workflow: CatalogExecutionWorkflow = { kind: "plan", workflowId: input.workflow!, options: { harnessDir, plan: { id: input.planId!, title: input.planTitle!, file: input.planFile! }, deliveryKind: input.deliveryKind as never, ...(input.project === undefined ? {} : { project: input.project }), ...(input.branchBase === undefined ? {} : { branchBase: input.branchBase }), ...(branchWork === undefined ? {} : { branchWork }), ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }), ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
        const identity: ExecutionIdentity = context.executionIdentity ?? {
          source: context.host === undefined ? "local" : "host",
          sessionId: context.sessionId ?? "",
          workflowId: input.workflow!,
          role: "coordinator",
        };
        const result = await registerShippedCatalogExecution(
          executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }),
          {
            actor: "mcp:workflow-register",
            workflow,
            ...(input.expect === undefined ? {} : { expected: input.expect as never }),
            ...(input.operation === undefined ? {} : { operationId: input.operation }),
          },
        );
        const warnings = deliveryAnchorWarnings(input.deliveryKind!, branchWork, input.branchTarget);
        return ok("workflow.register", warnings.length === 0 ? result : { ...result, warnings });
      } catch (error) {
        return engineRefusal("workflow.register", error);
      }
    }, [{ key: "sessionId", context: "sessionId" }], {
      expect: `Optional checked CAS constraint: ${TOKEN_SUPPLIES.root}`,
      planTitle: "Must match the selected plan document's H1; that document is the registration authority.",
      branchWork: "The delivery branch recorded as branch.work: the branch the delivery PR comes from, normally the plan's own feature branch. `mstar plan complete` compares it with the plan row's recorded working branch, so a default/protected branch name here is normally wrong — and a wrong value is repairable on a running workflow with mstar workflow delivery-anchors.",
      branchBase: "The branch this workflow was created from, recorded as branch.base: the protected merge anchor. It is not the delivery branch.",
      branchSource: "Deprecated alias of --branch-work: it records the same delivery branch (branch.work).",
      branchTarget: "The delivery target anchor recorded as branch.target: the branch the delivery merges into. A wrong value is repairable on a running workflow with mstar workflow delivery-anchors.",
    }),
    makeDefinition("workflow.evidence", "Record delivery evidence through the ACTIVE coordinator operation. `--file` is a pathname (never inline JSON): it must be absolute and name a UTF-8 JSON file containing a non-empty object with at least one member. For `development`, members are any subset of compound {outcome: created|updated|skipped, reason?: non-empty string; reason is required for skipped}, pr {repo, head, target: non-empty strings}, and merge {provider, evidence: non-empty strings}; for `verification/report-only`, the only member is completion {policy, evidence: non-empty strings}. Omit untouched members; supplied members are complete blocks, not sub-field patches. `completion.policy` must match the registered `completion_policy` for lifecycle completion; a mismatched report may be recorded and corrected by another evidence update before close. A matching non-empty completion on a Done row is frozen; edit its referenced document in place, or use a separate workflow for a different completed intent. Done alone does not freeze other evidence. PR identity is immutable once recorded: keep its registered repo/head/target for that delivery, or use a separate workflow for a different PR. The registered delivery kind selects permitted members. `--expect` and `--operation` optionally constrain this ACTIVE write.", "write", ["workflow", "file", "sessionRef", "expect", "operation", "harness"], async (input, context) => {
      try {
        if (input.workflow === undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow is required" });
        if (input.file === undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "file is required" });
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: "harness dir not found; supply harness" });
        const evidence = parseWorkflowJson<Record<string, unknown>>(
          readFileSync(absolute(input.file, "file"), "utf8"), "evidence file", "workflow.evidence.file-malformed",
        );
        if (context.sessionId === undefined) return refusalEnvelope({ command: "workflow.evidence", status: "usage", code: "command.invalid-input", exitCode: 2, message: `active evidence requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).` });
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
      } catch (error) { return engineRefusal("workflow.evidence", error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      expect: `Optional CAS expectation: ${TOKEN_SUPPLIES.workflow}`,
      sessionRef: `session transport: ${SESSION_REF_SUPPLIES}`,
      file: "Path-only wire: absolute path to a UTF-8 JSON file; inline JSON text is not accepted.",
    }, { delivery: deliveryEvidenceSchema }),
    makeDefinition("workflow.delivery-anchors", "Repair a RUNNING workflow's delivery anchors (`branch.base` / `branch.work` / `branch.target`) under the workflow CAS token. Name the anchor(s) to record with `--branch-base`, `--branch-work` and/or `--branch-target`: an anchor you do not name keeps the value the workflow already registers, and the named values are written in one transaction. Each anchor you do name must be a non-empty branch name. `--reason` is required, and the correction is revisable and repeatable for as long as the workflow keeps running. A closed lifecycle is refused by the pre-existing workflow-wide amend guard.", "write", ["workflow", "branchBase", "branchWork", "branchSource", "branchTarget", "reason", "sessionRef", "expect", "operation", "harness"], async (input, context) => {
      const id = "workflow.delivery-anchors";
      try {
        // Every flag this verb requires is reported in ONE usage refusal: an
        // agent that omitted two of them must not have to guess its way to the
        // second on a retry.
        // One anchor is enough: the operator who mistyped only the delivery
        // branch must not restate a correct --branch-target. `--branch-source`
        // is the deprecated alias of `--branch-work`: both write one field, and
        // the current name wins when both are supplied.
        const work = input.branchWork ?? input.branchSource;
        const reason = input.reason ?? "";
        const missing = [
          ...(input.workflow === undefined ? ["workflow is required; inspect registered workflows with mstar status validate."] : []),
          ...(work === undefined && input.branchBase === undefined && input.branchTarget === undefined
            ? ["at least one delivery anchor is required; name the anchor being recorded, and an anchor you do not name keeps its registered value."]
            : []),
          ...(reason.trim() === "" ? ["a non-empty reason is required: state why the delivery anchors are being corrected, so the repair is auditable."] : []),
        ];
        // The row address is re-tested in the condition because a reported
        // workflow sentence does not narrow `input.workflow` for the checks
        // below; `missing` already carries it, so the two disjuncts agree.
        if (input.workflow === undefined || missing.length > 0) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: missing.join(" ") });
        }
        if (context.sessionId === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active anchor repair requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).` });
        const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
        const acquired = context.executionIdentity;
        if (ref !== undefined && (ref.workflowId !== input.workflow || ref.role !== "coordinator")) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "sessionRef must address the selected workflow's coordinator seat" });
        }
        if (acquired !== undefined && (acquired.workflowId !== input.workflow || acquired.role !== "coordinator")) {
          return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired caller identity does not address the selected coordinator workflow" });
        }
        const root = resolveProcessHarnessDir(context.cwd, input.harness);
        if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
        const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator" };
        const operation: WorkflowExecutionOperation = {
          kind: "delivery-anchors",
          branch: {
            ...(input.branchBase === undefined ? {} : { base: input.branchBase }),
            ...(work === undefined ? {} : { work }),
            ...(input.branchTarget === undefined ? {} : { target: input.branchTarget }),
          },
          reason,
        };
        const applied = await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
          workflowId: input.workflow,
          ...(ref === undefined ? {} : { session: ref }),
          ...(input.expect === undefined ? {} : { expected: input.expect as never }),
          operationId: input.operation ?? randomUUID(),
          operation,
        });
        // The ok envelope's advisory payload, in the shape `workflow register`
        // already uses: an advisory rides `data.warnings` and never fails the
        // operation. The engine decides it on the anchors THIS transaction
        // stored (the result's `recovery.warnings`), so a repair that leaves the
        // header disagreeing with an already-recorded PR identity still
        // succeeds and says so here.
        const warnings = (applied.recovery?.warnings ?? []).map((warning) => warning.message);
        return ok(id, warnings.length === 0 ? applied : { ...applied, warnings });
      } catch (error) { return engineRefusal(id, error); }
    }, [{ key: "sessionId", context: "sessionId" }], {
      branchWork: "The delivery branch to record, as branch.work: the branch the delivery PR comes from, normally the plan's own feature branch. Omit it to keep the registered branch.work.",
      branchBase: "The creation/merge anchor to record, as branch.base: the branch the workflow was created from. Omit it to keep the registered branch.base.",
      branchSource: "Deprecated alias of --branch-work: it records the same delivery branch (branch.work).",
      branchTarget: "The delivery target anchor to record, as branch.target: the branch the delivery merges into. Omit it to keep the registered branch.target.",
      reason: "Required. Why the registered delivery anchors are being corrected; recorded with the operation so the repair is auditable.",
      expect: `CAS expectation: ${TOKEN_SUPPLIES.workflow}`,
      sessionRef: `session transport: ${SESSION_REF_SUPPLIES}`,
      harness: "Control harness root whose store owns the addressed workflow.",
    }),
    makeDefinition(
      "workflow.compass-ref",
      "Repair a RUNNING iteration workflow's registered reviewed-compass pointer (`compass_ref`) under the workflow CAS token. `--compass` names the reviewed delivery compass as an absolute path inside the harness root or as a harness-relative pointer; it must exist, be a non-empty valid compass frontmatter for THIS iteration, and the stored value is its canonical harness-relative form. `--reason` is required and recorded with the operation. The correction preserves the workflow/session/plan identities and their rows and is revisable and repeatable for as long as the workflow keeps running; a closed lifecycle is refused by the pre-existing amend guard.",
      "write",
      ["workflow", "compass", "reason", "sessionRef", "expect", "operation", "harness"],
      async (input, context) => {
        const id = "workflow.compass-ref";
        try {
          const missing = [
            ...(input.workflow === undefined ? ["workflow is required; inspect registered workflows with mstar status validate."] : []),
            ...(input.compass === undefined || input.compass.trim() === ""
              ? ["a compass is required: name the reviewed delivery compass as an absolute path inside the harness root or as a harness-relative pointer."]
              : []),
            ...((input.reason ?? "").trim() === ""
              ? ["a non-empty reason is required: state why the registered compass pointer is being corrected, so the repair is auditable."]
              : []),
          ];
          if (input.workflow === undefined || missing.length > 0) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: missing.join(" ") });
          }
          if (context.sessionId === undefined) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `active compass repair requires an acquired coordinator identity: ${IDENTITY_RECOVERY} (${IDENTITY_SUPPLIES}).` });
          const ref = input.sessionRef === undefined ? undefined : decodeExecutionSessionRef(input.sessionRef);
          const acquired = context.executionIdentity;
          if (ref !== undefined && (ref.workflowId !== input.workflow || ref.role !== "coordinator")) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "sessionRef must address the selected workflow's coordinator seat" });
          }
          if (acquired !== undefined && (acquired.workflowId !== input.workflow || acquired.role !== "coordinator")) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired caller identity does not address the selected coordinator workflow" });
          }
          const root = resolveProcessHarnessDir(context.cwd, input.harness);
          if (root === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
          const identity: ExecutionIdentity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId: input.workflow, role: "coordinator" };
          const operation: WorkflowExecutionOperation = { kind: "compass-ref", compassPath: input.compass!, reason: input.reason! };
          return ok(id, await mutateExecutionWorkflow(executionContextFor({ harnessDir: root }, identity), {
            workflowId: input.workflow,
            ...(ref === undefined ? {} : { session: ref }),
            ...(input.expect === undefined ? {} : { expected: input.expect as never }),
            operationId: input.operation ?? randomUUID(),
            operation,
          }));
        } catch (error) { return engineRefusal(id, error); }
      },
      [{ key: "sessionId", context: "sessionId" }],
      {
        compass: "The reviewed delivery compass to record: an absolute path inside the harness root, or its harness-relative pointer (e.g. iterations/<iteration-id>/delivery-compass.md). A repository-relative `.mstar/...` pointer is not a compass_ref — it is joined under the harness root and would name `.mstar/.mstar/...`.",
        reason: "Required. Why the registered compass pointer is being corrected; recorded with the operation so the repair is auditable.",
        expect: `CAS expectation: ${TOKEN_SUPPLIES.workflow}`,
        sessionRef: `session transport: ${SESSION_REF_SUPPLIES}`,
        harness: "Control harness root whose store owns the addressed workflow.",
      },
    ),
    makeDefinition(
      "workflow.adopt-terminal",
      "Adopt a header that has no ACTIVE registry membership. An optional --expect is a positive header-revision CAS; if omitted, the engine derives the current revision inside the guarded transaction. An omitted --operation gets one generated id for this invocation. A header that never closed is terminalized to stopped in the same transaction as its adoption record, so the committed state never carries an adoption on a still-running header; an already-terminal header keeps its recorded status and ended_at. If the eligible header holds current-epoch ACTIVE coordinator session(s), the same transaction settles only the exact sessions supported by genuine operator stop evidence supplied through --attestation <absolute-json>; its stoppedSessions must name every target stopped/reloaded. The engine refuses self-settlement, invalid proof, and changed proof under a committed operation id. It does not infer that a process stopped or that consumer/operator facts are true.",
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
            : readOperatorAttestation(absolute(input.attestation, "attestation"), id, "ActivationAttestation");
          const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
          if (harnessDir === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
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
        attestation: `absolute JSON file path for operator proof; required only for an eligible unregistered header with current-epoch ACTIVE coordinator sessions. Exact structure is payload adoptionAttestation; shared semantic constraints: ${attestationRules}`,
      },
      { adoptionAttestation: activationAttestationDocumentSchema },
    ),
    makeDefinition(
      "workflow.reopen",
      "Return a failed or stopped workflow to running on the SAME id. The header keeps its identity anchors, plan rows, session rows and retained operation receipts; the lifecycle simply re-enters the ACTIVE registry, and the ordinary bind/recover routes resume ownership afterwards. Reopening a terminal workflow takes an EXPLICIT operator authorization: a coordinator identity addressing this workflow, a non-empty --reason, and --attestation <absolute-json>, the recovery-scope document whose operator + reason are the authorization (no installed consumer is required and an empty stoppedSessions is valid). The attestation is SELF-REPORTED operator evidence: its structure is validated, the operator's authorization is never verified against host liveness. --expect is the closed header's current terminal token exactly as `mstar status validate` publishes it in terminalUnregistered[].token (or terminalAdoptions[].token for an adopted close); when omitted this verb reads that token from the authority and passes it explicitly, so the transition is always CAS-guarded. `completed` is never reopened and this route has no override — register a new lifecycle instead. An omitted --operation gets one generated id for this invocation.",
      "write",
      ["workflow", "harness", "expect", "operation", "reason", "attestation"],
      async (input, context) => {
        const id = "workflow.reopen";
        try {
          if (context.sessionId === undefined || context.sessionId.trim() === "") {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `reopening a workflow requires an acquired coordinator identity (${IDENTITY_RECOVERY})` });
          }
          const acquired = context.executionIdentity;
          const workflowId = input.workflow ?? acquired?.workflowId;
          if (workflowId === undefined || input.reason === undefined || input.attestation === undefined) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "workflow, reason and attestation are required; expect and operation may be omitted safely" });
          }
          if (acquired !== undefined && (acquired.workflowId !== workflowId || acquired.role !== "coordinator")) {
            return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "acquired caller identity does not address the selected coordinator workflow" });
          }
          const attestation = readOperatorAttestation(absolute(input.attestation, "attestation"), id, "recovery-scope attestation");
          const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
          if (harnessDir === null) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
          // The caller's own token (or its absence) is what the engine sees: the
          // omitted form resolves the current terminal revision inside the
          // guarded transaction, which keeps the replay fingerprint stable after
          // a committed reopen. A derived out-of-transaction token would enter
          // that fingerprint and turn an identical retry into a conflict.
          const identity = acquired ?? { source: context.host === undefined ? "local" : "host", sessionId: context.sessionId, workflowId, role: "coordinator" as const };
          return ok(id, await reopenExecutionWorkflow(executionContextFor({ harnessDir }, identity), {
            workflowId,
            reason: input.reason,
            attestation,
            ...(input.expect === undefined ? {} : { expected: input.expect as ExecutionToken }),
            operationId: input.operation ?? randomUUID(),
          }));
        } catch (error) {
          return engineRefusal(id, error);
        }
      },
      [{ key: "sessionId", context: "sessionId" }],
      {
        expect: `Optional checked CAS: the closed header's terminal token published by \`mstar status validate\`. When omitted the engine resolves the current terminal header revision inside the guarded transaction and checks it there; only a token you pass explicitly enters the request fingerprint, so repeating the same --operation without --expect replays the committed reopen. ${TOKEN_SUPPLIES.workflow}`,
        operation: "Optional idempotency/replay id; when omitted one id is generated for this invocation.",
        reason: "Required. Why the terminal lifecycle is reopened; recorded with the transition as the operator-facing justification.",
        attestation: "Required absolute JSON path to the operator's recovery-scope document: version, attestedAt, operator.actor, operator.authorizationRef and a stoppedSessions array (possibly empty); consumers is optional and ignored. SELF-REPORTED operator authorization — the structure is validated, host liveness is never verified.",
      },
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
              ? { kind: "execution-policy", policy: parseWorkflowExecutionPolicy(
                readFileSync(absolute(input.file, "file"), "utf8"),
              ) }
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
      ...(transition.name === "execution-policy" ? {
        file: "Absolute path to a UTF-8 JSON execution-policy object; read its fields with mstar schema --command workflow.execution-policy",
      } : {}),
    }, transition.name === "execution-policy" ? { policy: workflowExecutionPolicySchema } : {}));
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
      // The producer's request fingerprint is the caller's spelling, so this
      // transport hands `--compass-ref` through unchanged: canonicalization
      // follows symlinks, and settling it here would move the fingerprint of a
      // committed alias once its target is deleted, turning its retry into a
      // refusal. Containment is the PRODUCER's post-replay proof: it resolves
      // the pointer against the real harness root, so an absolute pointer under
      // a symlinked `--harness` and an external alias onto an in-root compass
      // are accepted, while a genuinely escaping pointer is still refused for a
      // new registration (I-000868, PR #578).
      const workflow: CatalogExecutionWorkflow = { kind: "iteration", workflowId: input.workflow, options: { harnessDir, compassRef: input.compassRef, branch: { base: input.branchBase, integration: input.branchIntegration, target: input.branchTargetIteration }, rows: rows as never[], ...(input.project === undefined ? {} : { project: input.project }), ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }) } };
      const identity: ExecutionIdentity = context.executionIdentity ?? {
        source: context.host === undefined ? "local" : "host",
        sessionId: context.sessionId ?? "",
        workflowId: input.workflow,
        role: "coordinator",
      };
      return ok("iteration.register", await registerShippedCatalogExecution(
        executionContextFor({ harnessDir }, identity, { allowUnsetSessionId: true }),
        {
          actor: "mcp:iteration-register",
          workflow,
          ...(input.expect === undefined ? {} : { expected: input.expect as never }),
          ...(input.operation === undefined ? {} : { operationId: input.operation }),
        },
      ));
    } catch (error) {
      return engineRefusal("iteration.register", error);
    }
  }, [{ key: "sessionId", context: "sessionId" }], { expect: `Optional checked CAS constraint: ${TOKEN_SUPPLIES.root}` }));
  return defs;
}
