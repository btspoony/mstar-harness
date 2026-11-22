/**
 * store-remote-outbox.ts (command family) — the provider-free recovery surface of the
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
  // Literal branches only: the repository's refusal-quality lint proves each text
  // statically, so every code these verbs can emit names its own supported route
  // instead of a composed variable.
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message,
    ...(details === undefined ? {} : { details }),
    recovery: code === "remote.intent-not-found"
      // note: An unknown id is never guessed or replaced by retrying the business verb.
      ? "List this project's durable intents with mstar store collaboration remote outbox-pending --harness <abs> --project <local-project-id>, then address the operation id it names; an operation id is never regenerated to make a write succeed."
      : code === "remote.operation-conflict"
        ? "This operation id already holds a different request, kind or generation. Inspect the recorded content with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>; for a conflicted fork, prepare the reviewed replacement with mstar store collaboration remote outbox-resolve --harness <abs> --operation <conflicted-uuid> --input <file>."
        : code === "remote.dispatch-refused"
          ? "The named intent is not dispatchable in its recorded state. Read it with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>; reconcile an uncertain send under its original binding before any further attempt, and never reuse a dispatched operation id."
          : code === "remote.outbox-unavailable"
            ? "This checkout's collaboration lane holds no durable outbox, so nothing was enqueued and nothing was sent. Advance the lane with mstar store upgrade --operator <name> --harness <abs>, then rerun the same verb with the same operation id."
            : code === "remote.input-invalid" || code === "remote.scope-mismatch" || code === "remote.denied" || code === "remote.revoked"
              ? "Correct the JSON document or the host's verified scope this refusal names, then resubmit the same receipt with mstar store collaboration remote outbox-receipt --harness <abs> --input <file|->; a refused document records nothing."
              : code === "collaboration.stale-binding"
                ? "Re-prove the checked selection and this checkout's binding with mstar store collaboration remote status --harness <abs>, then complete the reviewed bind with mstar store collaboration remote bind --harness <abs> --input <file|->; a draining generation is recovered, never resent."
                : code === "collaboration.not-initialized" || code === "collaboration.upgrade-required" || code === "collaboration.mode-unavailable"
                  ? "Initialize or advance this checkout's collaboration lane with mstar store upgrade --operator <name> --harness <abs>, then bind it with mstar store collaboration remote bind --harness <abs> --input <file|->."
                  : code === "remote.selector-unavailable" || code === "collaboration.observation-incomplete" || code === "collaboration.observation-stale"
                    ? "Bring back Git access to the canonical origin and the protected selector ref, then inspect mstar store collaboration remote status --harness <abs> and resubmit the host's fresh observation with mstar store collaboration remote observe --harness <abs> --input <file|->."
                    : "Read the cause and the intent's recorded state with mstar store collaboration remote outbox-show --harness <abs> --operation <uuid>, and correct the named fact before resubmitting.",
  });
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
 * Read one JSON document for a verb: an absolute file path, or `-` for stdin. An unreadable
 * path or a body that is not JSON is a usage refusal naming the flag, before any store work.
 */
async function readJsonDocument(invocation: InvocationContext, value: string | undefined, flag: string): Promise<unknown> {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  let raw: string;
  if (value === "-") raw = await invocation.effects.readInput();
  else {
    const absolute = absoluteFile(value, flag);
    try {
      raw = readFileSync(absolute, "utf8");
    } catch (error) {
      throw new SddScriptError(`${flag} ${absolute} cannot be read: ${error instanceof Error ? error.message : String(error)}`, 2);
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
      ? "optional path to the host ForkObservation JSON, or - for stdin; required only to dispatch a reviewed resolution, and refused for an ordinary intent"
      : verb === "outbox-resolve"
        ? "path to the reviewed resolution JSON `{version,operationId,operator,reason,event}`, or - for stdin"
        : "path to the strict receipt JSON document, or - for stdin",
    reason: "why this intent is abandoned; the reason is retained with the attempt history",
  };
  const descriptions: Record<OutboxVerb, string> = {
    "outbox-pending":
      "List this project's current-binding enqueued intents, oldest first, as summaries without a send permit. It creates and mutates nothing.",
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
