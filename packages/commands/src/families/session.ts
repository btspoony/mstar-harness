import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createFsStore,
  createLocalExecutionIdentity,
  executionContextFor,
  recoverExecutionCoordinator,
  resolveProcessHarnessDir,
  serializeExecutionValue,
  setArtifactStore,
  type ActivationAttestation,
  type ExecutionIdentity,
} from "@mstar-harness/engine";
import { redactSecrets } from "@mstar-harness/engine/src/audit";
import { refusalEnvelope, type RefusalDiagnostic } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { decodeInputDiagnostics } from "../input-diagnostics.js";
import { engineErrorFacts } from "./family-refusal.js";
import { TOKEN_SUPPLIES } from "../identity-supplies.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const command = <I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> => definition;
const SESSION_ROLES = ["coordinator"] as const;
/** Recovery compares the addressed workflow's own CAS token. */
const SESSION_RECOVER_EXPECT_HELP = `required CAS token: ${TOKEN_SUPPLIES.workflow}`;

function ok<T>(id: string, data: T): CommandEnvelope<T> {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function engineRefusal(id: string, error: unknown): CommandEnvelope<never> {
  const { code, details, recovery } = engineErrorFacts(error);
  const message = error instanceof Error ? error.message : String(error);
  const fallbackRecovery = id === "session.run"
    ? "Correct the reported executable or working directory, then rerun mstar session run."
    : "Correct the workflow or attestation inputs, then rerun mstar session recover.";
  return refusalEnvelope({
    command: id, status: "refused", code: code ?? `${id}.refused`, exitCode: 1, message,
    details: details ?? {},
    recovery: recovery ?? fallbackRecovery,
  });
}

/**
 * One refusal this family authors itself, before the engine is reached. It
 * exists so the two input boundaries `session.recover` owns stay specific:
 * the aggregated missing/exclusive facts carry one diagnostic per path, and a
 * caller-supplied attestation path is validated as the caller input it is
 * rather than being silently resolved against the process cwd.
 */
class RecoveryInputError extends Error {
  constructor(readonly code: string, readonly status: "usage" | "refused", message: string) {
    super(message);
    this.name = "RecoveryInputError";
  }
}

function requiredFact(path: string): RefusalDiagnostic {
  return {
    path,
    code: "required",
    message: path === "sessionId" ? "active recovery requires the main conversation session identity" : `${path} is required`,
  };
}

/** The recovered cardinality facts, in the shared admission vocabulary. */
const RECOVER_ALTERNATIVE_EXPECTED = "exactly one of priorSession | unowned=true";

/** The parser's reported position, kept only when the runtime actually gives one. */
function parserLocation(message: string): string | undefined {
  const position = message.match(/\bposition\s+(\d+)\b/i)?.[1];
  if (position !== undefined) return `position ${position}`;
  const lineColumn = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
  return lineColumn === null ? undefined : `line ${lineColumn[1]} column ${lineColumn[2]}`;
}

/**
 * The parser fact one malformed attestation refusal carries: the runtime's own
 * grammatical cause and, only when it reports one, its position — never the
 * offending source bytes.
 *
 * The safe discriminator is the operand's DIAGNOSTIC ROLE, not its quote style:
 * an operand named by an "Unexpected …" or "Unrecognized …" clause is the
 * SUBMITTED SOURCE token the parser tripped over — Node's
 * `Unexpected token 'F', "…" is not valid JSON` quotes the offending character,
 * Bun's `Unexpected identifier "<token>"` quotes the offending token, and Bun's
 * `Unrecognized token '@'` quotes the offending character too — so it is removed
 * whichever quote style carries it. An operand named by an "Expected …" clause,
 * or a delimiter the message merely mentions, is grammar the PARSER authored
 * (`','`, `'}'`, `')'`) and is preserved. Node's trailing document excerpt and
 * any other double-quoted echo are removed too. The reported position/location
 * is published separately and kept only when this runtime supplies it.
 */
function attestationParserCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const location = parserLocation(message);
  const cause = message
    .replace(/^JSON Parse error:\s*/i, "")
    .replace(/^JSON parse error:\s*/i, "")
    .replace(/^SyntaxError:\s*/i, "")
    // Node's document excerpt tail: greedy, because the excerpt itself contains
    // quotes and a truncated trailing ellipsis.
    .replace(/,?\s*"[\s\S]*"\s*\.{0,3}\s*is not valid JSON\s*$/i, "")
    .replace(/,?\s*\.{0,3}\s*is not valid JSON\s*$/i, "")
    // By role: the operand an "Unexpected …" / "Unrecognized …" clause names is
    // the submitted source token — Node's `Unexpected token 'F'`, Bun's
    // `Unexpected identifier "<token>"` and Bun's `Unrecognized token '@'` — so
    // it goes whatever its quote style, while the category words that classify
    // the failure survive.
    .replace(/((?:Unexpected|Unrecognized|Unrecognised)\s+(?:token|identifier|number|string|character|end of input)\s+)(?:'[^']*'|"[^"]*")/gi, "$1")
    // Any remaining double-quoted span is a runtime echo of an operand too.
    .replace(/\s*"[^"]*"/g, "")
    .replace(/\s+in JSON at position \d+(?:\s*\(line \d+ column \d+\))?/gi, "")
    .replace(/\s+at position \d+(?:\s*\(line \d+ column \d+\))?/gi, "")
    .replace(/\s*\(line \d+ column \d+\)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,:;]+$/, "")
    .trim();
  const scrubbed = redactSecrets(cause).text;
  // `syntax error` is only the last resort for a message that carried no usable
  // parser fact at all — never a mask over grammar that was already preserved
  // above, which is why any runtime message with real content yields a
  // non-empty cause here.
  const fact = scrubbed !== "" ? scrubbed : "syntax error";
  return location === undefined ? fact : `${fact} (${location})`;
}

/** The recovered caller inputs of `session.recover`, all non-optional. */
type RecoverInputs = Readonly<{
  workflow: string;
  priorSessionId: string | null;
  reason: string;
  attestationPath: string;
  expect: string;
  operation: string;
  sessionId: string;
  harness: string | undefined;
}>;

const recoverInput = z.object({ workflow: z.string().min(1), priorSession: z.string().min(1).optional(), unowned: z.boolean().optional(), reason: z.string().min(1).optional(), attestation: z.string().min(1).optional(), expect: z.string().min(1).optional(), operation: z.string().min(1).optional(), harness: z.string().min(1).optional() });

/**
 * The ONE resolution of `session.recover`'s caller inputs. Every known absent
 * or contradictory field becomes its own diagnostic, so the caller sees all
 * of them in one refusal instead of discovering them one call at a time; the
 * combined guard below then performs the actual narrowing, so the engine call
 * reads real strings and never an assertion over a maybe-absent field.
 *
 * The `priorSession`/`unowned` source is ONE cardinality fact, reported with
 * the same code, path and expected text shared admission publishes for the
 * contract's `alternatives` entry — never as two independent required fields,
 * which would misstate the contract as "both are mandatory".
 */
function resolveRecoverInputs(
  data: z.infer<typeof recoverInput>,
  sessionId: string | undefined,
): { ok: true; inputs: RecoverInputs } | { ok: false; diagnostics: RefusalDiagnostic[] } {
  const { workflow, priorSession, unowned, reason, attestation, expect, operation, harness } = data;
  const sourceCount = Number(priorSession !== undefined) + Number(unowned === true);
  const missing = [
    ...(reason === undefined ? ["reason"] : []),
    ...(attestation === undefined ? ["attestation"] : []),
    ...(expect === undefined ? ["expect"] : []),
    ...(operation === undefined ? ["operation"] : []),
    ...(sessionId === undefined || sessionId.trim() === "" ? ["sessionId"] : []),
  ];
  const diagnostics: RefusalDiagnostic[] = [
    ...missing.map(requiredFact),
    ...(sourceCount === 1 ? [] : [{
      path: "priorSession|unowned=true",
      code: "alternative-required",
      message: `${RECOVER_ALTERNATIVE_EXPECTED}; received ${sourceCount === 0 ? "none" : "priorSession | unowned=true"}`,
      expected: RECOVER_ALTERNATIVE_EXPECTED,
      received: sourceCount === 0 ? "none" : "priorSession | unowned=true",
    }]),
  ];
  if (
    diagnostics.length > 0 ||
    reason === undefined || attestation === undefined || expect === undefined || operation === undefined ||
    sessionId === undefined
  ) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    inputs: { workflow, priorSessionId: priorSession === undefined ? null : priorSession, reason, attestationPath: attestation, expect, operation, sessionId, harness },
  };
}

/**
 * The operator stop attestation read at this route's FILE consumer boundary.
 * Each failure keeps its own specific fact instead of collapsing into one
 * generic cause: a relative value is a usage refusal (caller input, never a
 * read against the process cwd); an unreadable document keeps its real POSIX
 * code and message; a malformed one names the parser failure. The engine still
 * owns the document's SHAPE, so a readable but invalid attestation remains the
 * engine's own typed refusal.
 */
function readAttestationDocument(pathValue: string): ActivationAttestation {
  if (!isAbsolute(pathValue)) {
    throw new RecoveryInputError("command.invalid-input", "usage", `--attestation must be an absolute path - got ${JSON.stringify(pathValue)}`);
  }
  let text: string;
  try {
    text = readFileSync(pathValue, "utf8");
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "session.recover.attestation-unreadable";
    throw new RecoveryInputError(code, "refused", error instanceof Error ? error.message : String(error));
  }
  try {
    return JSON.parse(text) as ActivationAttestation;
  } catch (error) {
    throw new RecoveryInputError("session.recover.attestation-malformed", "refused", `--attestation is not valid JSON: ${attestationParserCause(error)}`);
  }
}

export function getSessionCommandDefinitions(): readonly CommandDefinition[] {
  const runInput = z.object({ workflow: z.string().min(1), role: z.enum(SESSION_ROLES), argv: z.array(z.string()).optional(), harness: z.string().min(1).optional() });
  return [
    command({
      id: "session.run",
      cli: { path: ["session", "run"], aliases: [], arguments: [{ key: "argv", required: true, variadic: true }], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "role", flags: "--role <role>", required: true },
        { key: "harness", flags: "--harness <path>", required: false },
      ] },
      input: runInput, output: commandEnvelopeSchema, effects: ["process"],
      requirements: [
        ...(["workflow", "role", "argv"] as const).flatMap((name) => [
          { name, ownership: "caller" as const, route: "cli" as const, required: true },
          { name, ownership: "caller" as const, route: "mcp" as const, required: true },
        ]),
      ],
      description: "Launch argv under a freshly minted local execution identity; this is a launch, not a binding — it writes no session row or lease, and the child binds through the public `plan bind --execution --workflow <id> --coordinator` route, whose creator/ownerless/foreign-holder conditions still apply.",
      async execute(raw, context) {
        const { workflow, role, argv = [], harness } = raw as z.infer<typeof runInput>;
        if (role !== "coordinator" || argv.length === 0 || argv[0]!.trim() === "") {
          return refusalEnvelope({ command: "session.run", status: "usage", code: "command.invalid-input", exitCode: 2, message: "session run requires --workflow, --role coordinator, and a child argv" });
        }
        const root = resolveProcessHarnessDir(context.cwd, harness);
        const identity = createLocalExecutionIdentity({ workflowId: workflow, role });
        const env: Record<string, string> = { ...process.env as Record<string, string>, MSTAR_EXECUTION_IDENTITY: serializeExecutionValue(identity) };
        delete env.MSTAR_HOST_SESSION_ID;
        if (root !== null) env.MSTAR_HARNESS_DIR = root;
        // The receipt is a launch fact, never an ownership claim: the minted
        // identity is attribution the CLI now consumes, and no session row or
        // lease was written. Binding is a separate public step whose real
        // conditions (creator first-bind, ownerless adoption, foreign/live
        // holder refusal) are the engine's, not this launcher's.
        const binding = {
          written: false,
          route: `mstar plan bind --execution --workflow ${workflow} --coordinator`,
          conditions: "the workflow's creating identity binds first; a workflow with no coordinator record may be adopted; a live or foreign holder is refused and never replaced by a launch",
        };
        try {
          const child = await context.effects.spawn({ argv, cwd: context.cwd, env, signal: context.signal });
          const childCode = child.signal === null
            ? child.exitCode ?? 0
            : 128 + (constants.signals[child.signal as keyof typeof constants.signals] ?? 0);
          const launched = { identity, binding, exitCode: childCode, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
          if (childCode === 0) return ok("session.run", launched);
          return {
            version: 1, command: "session.run", status: "error", code: "session.child-exit", exitCode: childCode,
            message: child.signal === null ? `child exited with status ${childCode}` : `child terminated by ${child.signal}`,
            details: launched,
          };
        } catch (error) {
          return engineRefusal("session.run", error);
        }
      },
    }),
    command({
      id: "session.recover",
      cli: { path: ["session", "recover"], aliases: [], arguments: [], options: [
        { key: "workflow", flags: "--workflow <id>", required: true }, { key: "priorSession", flags: "--prior-session <id>", required: false, help: "Exactly one of --prior-session or --unowned=true is required." },
        { key: "unowned", flags: "--unowned", required: false, help: "Only true selects ownerless recovery; false is not an alternative." }, { key: "reason", flags: "--reason <text>", required: true },
        { key: "attestation", flags: "--attestation <path>", required: true }, { key: "expect", flags: "--expect <token>", required: true, help: SESSION_RECOVER_EXPECT_HELP },
        { key: "operation", flags: "--operation <id>", required: true }, { key: "harness", flags: "--harness <path>", required: false },
        { key: "sessionId", flags: "--session-id <value>", required: false, context: "sessionId" },
      ] },
      input: recoverInput, output: commandEnvelopeSchema, effects: ["write"],
      requirements: [
        ...(["workflow", "reason", "attestation", "expect", "operation"] as const).flatMap((name) => [
          { name, ownership: "caller" as const, route: "cli" as const, required: true, ...(name === "expect" ? { tokenKind: "workflow" as const } : {}) },
          { name, ownership: "caller" as const, route: "mcp" as const, required: true, ...(name === "expect" ? { tokenKind: "workflow" as const } : {}) },
        ]),
        ...(["cli", "mcp"] as const).flatMap((route) => [
          { name: "priorSession", ownership: "caller" as const, route, required: false, alternatives: { cardinality: "exactly-one" as const, members: [{ name: "priorSession" }, { name: "unowned", whenTrue: true }] }, constraint: "exactly one of priorSession or unowned=true" },
          { name: "unowned", ownership: "caller" as const, route, required: false, constraint: "only true selects ownerless recovery; false does not select this alternative" },
          { name: "sessionId", ownership: "caller" as const, route, required: true, constraint: "current operator's acquired conversation identity; never derive or substitute it" },
        ]),
      ],
      description: "Recover a stopped workflow coordinator through active DB authority. Requires the current operator identity, workflow CAS token, replay id, reason and operator attestation; specify exactly one prior session or --unowned=true. Recovery never resumes a session.",
      async execute(raw, context: InvocationContext) {
        const parsed = recoverInput.safeParse(raw);
        if (!parsed.success) return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: "Invalid input.", diagnostics: decodeInputDiagnostics(parsed.error, raw) });
        const resolved = resolveRecoverInputs(parsed.data, context.sessionId);
        if (!resolved.ok) {
          return refusalEnvelope({
            command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2,
            message: "session recover inputs are incomplete or mutually exclusive",
            diagnostics: resolved.diagnostics,
          });
        }
        try {
          const { workflow, priorSessionId, reason, attestationPath, expect, operation, sessionId, harness } = resolved.inputs;
          const root = resolveProcessHarnessDir(context.cwd, harness);
          if (root === null) return refusalEnvelope({ command: "session.recover", status: "usage", code: "command.invalid-input", exitCode: 2, message: "no control harness resolved; supply an absolute harness" });
          const identity: ExecutionIdentity = { source: context.host === undefined ? "local" : "host", sessionId, workflowId: workflow, role: "coordinator" };
          const parsedAttestation = readAttestationDocument(attestationPath);
          const contextForCaller = executionContextFor({ harnessDir: root }, identity);
          const receipt = await recoverExecutionCoordinator(contextForCaller, {
            expected: expect as never, operationId: operation, priorSessionId, reason,
            attestation: parsedAttestation,
          });
          return ok("session.recover", receipt);
        } catch (error) {
          if (error instanceof RecoveryInputError) {
            // The refusal shape is a discriminated pair of branches, so status
            // and exit code are correlated by the branch itself rather than by
            // a computed exit code the caller's union cannot narrow: a relative
            // path stays the usage form (exit 2), and an unreadable or
            // malformed document stays the refused form (exit 1).
            return error.status === "usage"
              ? refusalEnvelope({ command: "session.recover", status: "usage", code: error.code, exitCode: 2, message: error.message })
              : refusalEnvelope({ command: "session.recover", status: "refused", code: error.code, exitCode: 1, message: error.message, recovery: "Run mstar status validate, then correct the rejected workflow or attestation input before retrying." });
          }
          return engineRefusal("session.recover", error);
        }
      },
    }),
  ];
}
