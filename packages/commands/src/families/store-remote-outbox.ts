/**
 * note: store-remote-outbox.ts (command family) — the provider-free recovery surface of the
 * collaboration outbox: `store collaboration remote outbox-*`.
 *
 * Every verb here is a thin route to ONE engine operation; none of them opens a provider
 * connection, holds a credential or retries a send. The CLI reports what the durable lane
 * recorded: a `confirmed` state is the only effect success, and an `unconfirmed` or
 * `conflict` state is a settled command outcome that still awaits the host's evidence.
 *
 * `--harness` names this checkout's harness ABSOLUTELY, exactly like the observation lane,
 * because the outbox belongs to the binding that harness recorded and never to a discovered
 * root. JSON documents use `--input <file|->` and are read here, before any store work, so a
 * malformed or unreadable document is a usage refusal that mutates nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SddScriptError,
  abandonRemoteIntent,
  dispatchRemoteIntent,
  prepareRemoteResolution,
  readPendingIntents,
  readRemoteIntent,
  recordRemoteReceipt,
  reconcileRemoteIntent,
  type RemoteResolution,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema, refusalEnvelope } from "../envelope.js";
import {
  remoteForkObservationDocumentSchema,
  remoteReceiptDocumentSchema,
  remoteReconcileDocumentSchema,
  remoteResolutionDocumentSchema,
} from "../store-remote-documents.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";

const inputSchema = z.object({
  harness: z.string().optional(),
  project: z.string().optional(),
  operation: z.string().optional(),
  input: z.string().optional(),
  reason: z.string().optional(),
});
type OutboxInput = z.infer<typeof inputSchema>;

const outboxVerbs = [
  "outbox-pending",
  "outbox-show",
  "outbox-dispatch",
  "outbox-receipt",
  "outbox-reconcile",
  "outbox-resolve",
  "outbox-abandon",
] as const;
type OutboxVerb = (typeof outboxVerbs)[number];

const optionFlags: Record<keyof OutboxInput, string> = {
  harness: "--harness <path>",
  project: "--project <local-project-id>",
  operation: "--operation <uuid>",
  input: "--input <file|->",
  reason: "--reason <text>",
};

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}

function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const record = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const code = record !== undefined && typeof record.code === "string" ? record.code : `${id}.internal-error`;
  const details = record !== undefined && record.details !== null && typeof record.details === "object" && !Array.isArray(record.details)
    ? (record.details as Record<string, unknown>)
    : undefined;
  if (error instanceof SddScriptError) {
    return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message });
  }
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message,
    ...(details === undefined ? {} : { details }),
    recovery: recoveryFor(code, id.slice("store.collaboration.remote.".length) as OutboxVerb),
  });
}

/**
 * note: The cache rebuild route, mirroring the engine's own text: a cache whose bytes an in-place
 * settlement cannot honor may hold OTHER unsettled intents - including a permitted send whose
 * provider outcome is unknown - so the operator settles those, retains the file as evidence,
 * proves a fresh reviewed bind is admissible, and only then removes the name the checkout reads.
 */
const CACHE_REBUILD_ROUTE =
  "settle every other unsettled intent that cache holds (outbox-pending lists them, and outbox-show, " +
  "outbox-dispatch, outbox-receipt, outbox-abandon, outbox-resolve and outbox-reconcile move each state), keep " +
  "the cache file as evidence under a retained name instead of deleting it, confirm the checked selector and " +
  "this checkout's binding satisfy a fresh reviewed bind, then remove the name the checkout reads, run " +
  "mstar store collaboration remote status --harness <abs>, and perform a fresh reviewed remote bind";

/**
 * note: The exact supported route for one refusal, by cause and by the verb that refused it. A
 * document refusal is resubmitted to the verb that reads THAT document: a resolution is not
 * a receipt, and reconciliation is not a receipt either. Texts stay literal because the
 * repository's refusal-quality lint proves each named command statically.
 */
function recoveryFor(code: string, verb: OutboxVerb): string {
  if (code === "remote.intent-not-found") {
    // note: An unknown id is never guessed or replaced by retrying the business verb.
    return "List this project's durable intents with mstar store collaboration remote outbox-pending --harness <abs> --project <local-project-id>, then address the operation id it names; an operation id is never regenerated to make a write succeed.";
  }
  if (code === "remote.operation-conflict") {
    return "This operation id already holds a different request, kind or generation. Inspect the recorded content with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>; for a conflicted fork, prepare the reviewed replacement with mstar store collaboration remote outbox-resolve --harness <abs> --operation <conflicted-uuid> --input <file>.";
  }
  if (code === "remote.dispatch-refused") {
    if (verb === "outbox-dispatch") {
      return "The named intent is not dispatchable in its recorded state. Read it with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>; an enqueued reviewed resolution still needs the host fork observation through mstar store collaboration remote outbox-dispatch --harness <abs> --operation <uuid> --input <file|->, an uncertain send is reconciled under its original binding with mstar store collaboration remote outbox-reconcile --harness <abs> --input <file|->, and a moved base needs a fresh observation before a new intent. Never reuse a dispatched operation id.";
    }
    if (verb === "outbox-receipt") {
      // note: This cause covers two different row states, and the recovery must not pick one for
      // the operator: a normal `conflict` row has a supported settlement, while a row whose state
      // says confirmed beside only a conflict receipt is damaged cache bytes. The row's own state
      // is what tells them apart, so the text names both branches and the read that decides.
      return "The receipt names an attempt id or a state this intent does not hold. Read the row's recorded state with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>, then take the branch that state names: a row whose state is conflict is settleable in place, so settle it through mstar store collaboration remote outbox-resolve --harness <abs> --operation <uuid> --input <file|->, while a row whose state says confirmed beside a recorded conflict receipt holds a state that contradicts its evidence, so that damaged row has no in-place settlement and the cache rebuild is its route: " + CACHE_REBUILD_ROUTE + ". For any other cause, resubmit the receipt for that exact attempt with mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->; evidence of another send never settles this attempt.";
    }
    if (verb === "outbox-reconcile") {
      // note: The same two row states as the receipt branch: a normal `conflict` row is settled
      // with a reviewed resolution, and only the damaged confirmed-beside-conflict row needs the
      // rebuild. Naming one branch for both would move a shared cache for a settleable conflict.
      return "Reconciliation is read-only evidence for a dispatched attempt under its original binding. Read the row's recorded state with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>, then take the branch that state names: a row whose state is conflict is settleable in place, so settle it through mstar store collaboration remote outbox-resolve --harness <abs> --operation <uuid> --input <file|->, while a row whose state says confirmed beside a recorded conflict receipt holds a state that contradicts its evidence, so that damaged row has no in-place settlement and the cache rebuild is its route: " + CACHE_REBUILD_ROUTE + ". For any other cause, resubmit under that binding with mstar store collaboration remote outbox-reconcile --harness <abs> --input <file|->; a pre-send not-sent proof is only the original host's own receipt, recorded with mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->.";
    }
    return "Read the intent's recorded state with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid> and correct the named precondition; an operation id is never regenerated to make a write succeed.";
  }
  if (code === "remote.input-invalid") {
    if (verb === "outbox-receipt") {
      return "Correct the receipt document fields this refusal names, then resubmit it with mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->; a refused document records nothing.";
    }
    if (verb === "outbox-reconcile") {
      return "Correct the reconciliation document fields this refusal names (read-only evidence for an attempt under its original binding), then resubmit it with mstar store collaboration remote outbox-reconcile --harness <abs> --input <file|->; a refused document records nothing.";
    }
    if (verb === "outbox-resolve") {
      return "Correct the reviewed resolution document fields this refusal names (version, operationId, operator, reason and event), then resubmit it with mstar store collaboration remote outbox-resolve --harness <abs> --operation <uuid> --input <file|->; a refused document enqueues nothing.";
    }
    if (verb === "outbox-dispatch") {
      return "Correct the host fork observation this refusal names (a complete traversal that began after the conflict evidence), then resubmit it with mstar store collaboration remote outbox-dispatch --harness <abs> --operation <uuid> --input <file|->; a refused document sends nothing.";
    }
    return "Correct the fact this refusal names, then inspect the intent with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid> and rerun the same verb; a refused request records nothing.";
  }
  if (code === "remote.scope-mismatch" || code === "remote.denied" || code === "remote.revoked") {
    return "Correct the verified scope, permission or selection this refusal names: re-prove this checkout's scope with mstar store collaboration remote status --harness <abs>, then rerun the same verb with the same operation id; a refused request records nothing.";
  }
  if (code === "collaboration.stale-binding") {
    return "Re-prove the checked selection and this checkout's binding with mstar store collaboration remote status --harness <abs>, then complete the reviewed bind with mstar store collaboration remote bind --harness <abs> --input <file|->; a draining generation is recovered, never resent.";
  }
  if (code === "collaboration.not-initialized" || code === "collaboration.upgrade-required" || code === "collaboration.mode-unavailable") {
    return "Initialize or advance this checkout's collaboration lane with mstar store upgrade --operator <name> --harness <abs>, then bind it with mstar store collaboration remote bind --harness <abs> --input <file|->.";
  }
  if (code === "remote.selector-unavailable" || code === "collaboration.observation-incomplete" || code === "collaboration.observation-stale") {
    return "Bring back Git access to the canonical origin and the protected selector ref, then inspect mstar store collaboration remote status --harness <abs> and resubmit the host's fresh observation with mstar store collaboration remote observe --harness <abs> --input <file|->.";
  }
  return "Read the cause and the intent's recorded state with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>, and correct the named fact before resubmitting.";
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  return value;
}

function absoluteFile(value: string, flag: string): string {
  if (!path.isAbsolute(value)) throw new SddScriptError(`${flag} must be an absolute path`, 2);
  return value;
}

/**
 * note: Read one JSON document for a verb: a file path (resolved against the caller's working
 * directory, exactly like the observation lane's reader), or `-` for stdin. An unreadable
 * path or a body that is not JSON is a usage refusal naming the flag, before any store work.
 */
async function readJsonDocument(invocation: InvocationContext, value: string | undefined, flag: string): Promise<unknown> {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  let raw: string;
  if (value === "-") raw = await invocation.effects.readInput();
  else {
    try {
      raw = readFileSync(value, "utf8");
    } catch (error) {
      throw new SddScriptError(`${flag} ${value} cannot be read: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
  }
  if (raw.trim() === "") throw new SddScriptError(`${flag} received no content; pass a JSON document`, 2);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SddScriptError(`${flag} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

async function execute(id: string, input: OutboxInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  const verb = id.slice("store.collaboration.remote.".length) as OutboxVerb;
  try {
    const context: StoreContext = { harnessDir: path.resolve(absoluteFile(required(input.harness, "--harness"), "--harness")) };
    if (verb === "outbox-pending") {
      return ok(id, await readPendingIntents(context, required(input.project, "--project")));
    }
    const operation = () => required(input.operation, "--operation");
    if (verb === "outbox-show") return ok(id, await readRemoteIntent(context, operation()));
    if (verb === "outbox-dispatch") {
      // note: Only a reviewed resolution carries a host ForkObservation; an ordinary intent's
      // base is its complete cached snapshot, and the engine refuses evidence it must not take.
      const forkObservation = input.input === undefined ? undefined : await readJsonDocument(invocation, input.input, "--input");
      return ok(id, await dispatchRemoteIntent(context, operation(), forkObservation));
    }
    if (verb === "outbox-receipt") return ok(id, await recordRemoteReceipt(context, await readJsonDocument(invocation, input.input, "--input")));
    if (verb === "outbox-reconcile") return ok(id, await reconcileRemoteIntent(context, await readJsonDocument(invocation, input.input, "--input")));
    if (verb === "outbox-resolve") {
      const resolution = await readJsonDocument(invocation, input.input, "--input") as RemoteResolution;
      return ok(id, await prepareRemoteResolution(context, operation(), resolution));
    }
    if (verb === "outbox-abandon") {
      return ok(id, await abandonRemoteIntent(context, { operationId: operation(), reason: required(input.reason, "--reason") }));
    }
    throw new SddScriptError(`unknown store collaboration remote outbox verb ${verb}`, 2);
  } catch (error) {
    return refused(id, error);
  }
}

/**
 * note: The strict `--input` document each outbox verb carries, published through schema
 * discovery (`payloadSchemas.inputDocument`). The descriptor name is deliberately NOT an
 * input field: the CLI value of `--input` stays a file path (or `-` for stdin), so only
 * discovery sees the schema and nothing reshapes the path input.
 */
const outboxInputDocuments: Partial<Record<OutboxVerb, z.ZodType>> = {
  "outbox-dispatch": remoteForkObservationDocumentSchema,
  "outbox-receipt": remoteReceiptDocumentSchema,
  "outbox-reconcile": remoteReconcileDocumentSchema,
  "outbox-resolve": remoteResolutionDocumentSchema,
};

function outboxDefinition(verb: OutboxVerb): CommandDefinition<OutboxInput, unknown> {
  const id = `store.collaboration.remote.${verb}`;
  const optionsByVerb: Record<OutboxVerb, (keyof OutboxInput)[]> = {
    "outbox-pending": ["harness", "project"],
    "outbox-show": ["harness", "operation"],
    "outbox-dispatch": ["harness", "operation", "input"],
    "outbox-receipt": ["harness", "input"],
    "outbox-reconcile": ["harness", "input"],
    "outbox-resolve": ["harness", "operation", "input"],
    "outbox-abandon": ["harness", "operation", "reason"],
  };
  const requiredKeys: Record<OutboxVerb, (keyof OutboxInput)[]> = {
    "outbox-pending": ["harness", "project"],
    "outbox-show": ["harness", "operation"],
    "outbox-dispatch": ["harness", "operation"],
    "outbox-receipt": ["harness", "input"],
    "outbox-reconcile": ["harness", "input"],
    "outbox-resolve": ["harness", "operation", "input"],
    "outbox-abandon": ["harness", "operation", "reason"],
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof OutboxInput]?: true };
  const optionHelp: Partial<Record<keyof OutboxInput, string>> = {
    harness: "absolute path to this checkout's harness (the operation target, never discovered from the working directory)",
    project: "the local project id whose current-binding intents this listing reports",
    operation: "the caller-owned operation UUID this verb addresses (never a display id)",
    input: verb === "outbox-dispatch"
      ? `optional path (absolute, or relative to the working directory) to the host ForkObservation JSON, or - for stdin; required only to dispatch a reviewed resolution, and refused for an ordinary intent. The document shape publishes as payloadSchemas.inputDocument in \`mstar schema --command ${id}\``
      : verb === "outbox-resolve"
        ? `path (absolute, or relative to the working directory) to the reviewed resolution JSON, or - for stdin. The document shape publishes as payloadSchemas.inputDocument in \`mstar schema --command ${id}\``
        : `path (absolute, or relative to the working directory) to the strict ${verb === "outbox-reconcile" ? "reconciliation" : "receipt"} JSON document, or - for stdin. The document shape publishes as payloadSchemas.inputDocument in \`mstar schema --command ${id}\``,
    reason: "why this intent is abandoned; the reason is retained with the attempt history",
  };
  const descriptions: Record<OutboxVerb, string> = {
    "outbox-pending":
      "List this project's current-binding unsettled intents - enqueued, unconfirmed and conflict - oldest first, each with its state and without a send permit or an attempt id. It is a read: listing implies no send right, and it creates and mutates nothing.",
    "outbox-show":
      "Disclose one intent's binding, state, attempt id, request hash and frozen request, so the host can look up an uncertain attempt after a restart. It never grants a send permit, and content is withheld while the project's verified access check is not current.",
    "outbox-dispatch":
      "Issue the ONE send permit for the oldest enqueue of its binding and mark it unconfirmed in one committed transaction, before any provider call. A replay returns state only. A reviewed resolution additionally requires the host ForkObservation through --input.",
    "outbox-receipt":
      "Record what one dispatched attempt observed. Exit 0 means the evidence was recorded durably, never that the business effect landed: read the returned state, where only confirmed is effect success and unconfirmed or conflict still awaits reconciliation.",
    "outbox-reconcile":
      "Record read-only recovery evidence for one uncertain attempt under its ORIGINAL binding, including a draining previous generation. It never issues a send permit and never authorizes a provider call.",
    "outbox-resolve":
      "Freeze a reviewed replacement event for one conflicted intent under a NEW operation id, with the freshly observed complete fork heads as parents. The original event and its conflict proof are retained and never rewritten.",
    "outbox-abandon":
      "Abandon one intent explicitly: before dispatch, or after a recorded pre-send not-sent receipt. The reason and the reservation history are retained; an ambiguous effect is never abandoned as absent.",
  };
  const effects: Record<OutboxVerb, readonly CommandEffect[]> = {
    "outbox-pending": ["read"],
    "outbox-show": ["read"],
    "outbox-dispatch": ["read", "write"],
    "outbox-receipt": ["read", "write"],
    "outbox-reconcile": ["read", "write"],
    "outbox-resolve": ["read", "write"],
    "outbox-abandon": ["read", "write"],
  };
  const options = optionKeys.map((key) => ({
    key,
    flags: optionFlags[key],
    required: requiredKeys[verb].includes(key),
    ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
  }));
  return {
    id,
    cli: { path: ["store", "collaboration", "remote", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    // note: `payloadSchemas.inputDocument` is the strict JSON the --input flag carries;
    // the flag's own value stays a file path, so no admission schema changes.
    ...(outboxInputDocuments[verb] === undefined ? {} : { payloads: { inputDocument: { schema: outboxInputDocuments[verb] } } }),
    // invariant: `harness` names the operation's target, so the connection pin must not rewrite it.
    rootInputs: [],
    output: commandEnvelopeSchema,
    effects: effects[verb],
    description: descriptions[verb],
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreRemoteOutboxCommandDefinitions(): readonly CommandDefinition[] {
  return outboxVerbs.map((verb) => outboxDefinition(verb));
}
