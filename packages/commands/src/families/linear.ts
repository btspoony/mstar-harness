/**
 * `linear auth` — the one place an operator turns Linear on.
 *
 * Enabling the bundled `linear-mcp` row without a credential leaves a 401 and no
 * way forward, so the flow that produces a credential belongs in the product
 * rather than in a README. The command orchestrates; the host performs the
 * browser leg through `effects.linearAuthorize`.
 *
 * Storing is the command's job on purpose: the credential file is engine state
 * with a documented location and permissions, not something each host invents.
 */
import { clearLinearCredential, linearCredentialPath, readLinearCredential, writeLinearCredential } from "@mstar-harness/engine";
import { commandEnvelopeSchema, refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

const schema = z.object({
  operation: z.enum(["login", "status", "logout"]).optional(),
});

type Input = z.infer<typeof schema>;

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

function envelope(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}

function describe(now = Date.now()): Record<string, unknown> {
  const state = readLinearCredential(now);
  if (state.kind === "absent") {
    return { authorized: false, credentialPath: linearCredentialPath(), reason: "no credential is stored" };
  }
  if (state.kind === "unreadable") {
    return { authorized: false, credentialPath: state.path, reason: state.reason };
  }
  const expiresIn = state.credential.expiresAt === null ? null : Math.max(0, state.credential.expiresAt - now);
  return {
    authorized: true,
    credentialPath: state.path,
    scope: state.credential.scope,
    // Reported as facts, not as a verdict: a credential inside the refresh
    // window is still usable and is refreshed by the import path.
    refreshDue: state.refreshDue,
    expiresInMs: expiresIn,
    hasRefreshToken: state.credential.refreshToken !== null,
  };
}

async function run(operation: "login" | "status" | "logout", invocation: InvocationContext): Promise<CommandEnvelope> {
  if (operation === "status") {
    return envelope("linear.auth", describe());
  }
  if (operation === "logout") {
    const removed = clearLinearCredential();
    return envelope("linear.auth", { removed, credentialPath: linearCredentialPath() });
  }
  const authorize = invocation.effects.linearAuthorize;
  if (authorize === undefined) {
    return refusalEnvelope({
      command: "linear.auth",
      status: "refused",
      code: "linear.auth-unsupported",
      exitCode: 1,
      message: "this host cannot run the browser authorization leg",
      details: { credentialPath: linearCredentialPath() },
      recovery:
        "Run `mstar linear auth` with the standalone CLI on a machine that can open a browser, or export MSTAR_LINEAR_CREDENTIAL pointing at a credential file written elsewhere.",
    });
  }
  // The host leg can fail (timeout, refused registration, declined authorization).
  // Those carry their own code and recovery, so they become a refusal envelope
  // rather than an escaped Error the CLI would print as internal-error.
  let tokens: Awaited<ReturnType<NonNullable<typeof authorize>>>;
  try {
    tokens = await authorize(LINEAR_MCP_URL);
  } catch (error) {
    const facts = engineErrorFacts(error);
    const message = error instanceof Error ? error.message : String(error);
    return refusalEnvelope({
      command: "linear.auth",
      status: "refused",
      code: facts.code ?? "linear.auth-unavailable",
      exitCode: 1,
      message,
      details: { credentialPath: linearCredentialPath(), ...facts.details },
      // A literal, so the reachability lint can prove a real command: the host
      // facts still supply the message and the code.
      recovery: "Run `mstar linear auth` again, or check the authorization server is reachable.",
    });
  }
  if (tokens === null) {
    return refusalEnvelope({
      command: "linear.auth",
      status: "refused",
      code: "linear.auth-denied",
      exitCode: 1,
      message: "the authorization did not complete",
      details: { credentialPath: linearCredentialPath() },
      recovery: "Re-run `mstar linear auth`; if the browser never returned, check the authorization server is reachable.",
    });
  }
  const written = writeLinearCredential(tokens);
  return envelope("linear.auth", { credentialPath: written, scope: tokens.scope, expiresAt: tokens.expiresAt });
}

const description = "Authorize this machine against Linear's MCP server and store the credential";

export function getLinearCommandDefinitions(): CommandDefinition[] {
  return [
  {
    id: "linear.auth",
    description,
    cli: {
      path: ["linear", "auth"],
      aliases: [],
      arguments: [],
      options: [{ key: "operation", flags: "--operation <verb>", required: false }],
    },
    input: schema,
    output: commandEnvelopeSchema,
    effects: ["read", "write", "browser"],
    rootInputs: [],
    requirements: [],
    async execute(value: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
      return run(value.operation ?? "login", invocation);
    },
    } satisfies CommandDefinition,
  ];
}