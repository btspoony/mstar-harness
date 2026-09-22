/**
 * CLI active execution transport (phase 2b execution contract §3.2) — the ONE
 * place this package acquires an active caller identity, carries a session
 * reference, and turns the engine's active DB verbs into the documented CLI
 * grammar.
 *
 * The active transport is deliberately NOT the retired file route:
 *
 * - the caller identity is **acquired**, never looked up: it arrives in
 *   `MSTAR_EXECUTION_IDENTITY` from a launcher that overwrote it from native
 *   host facts or minted it locally (`mstar session run`). A missing channel is
 *   a usage refusal; it is never replaced by a generated id, a session file, an
 *   inherited `MSTAR_HOST_SESSION_ID`, or a flag (`--session-id` is not an
 *   active input at all). The value itself is never echoed into a diagnostic.
 * - a session reference is a canonical `exec-session-v1:` wire produced by the
 *   engine codec, carried per call (`--session-ref`). It is a lookup, never a
 *   credential: the engine still compares the independently acquired caller
 *   inside its own transaction.
 * - `--expect` on an active mutation is the FULL execution token from the
 *   current read. A revision integer belongs to the retired file route and is
 *   refused here without being coerced.
 *
 * Identity-channel encoding (the seam a host launcher reproduces): the value is
 * exactly the engine's public `serializeExecutionValue(identity)` — canonical
 * JSON with one terminal LF. There is no second codec: decode is `JSON.parse`
 * plus the SHARED `validateExecutionIdentity` (the §3.1 identity SSOT), so no
 * CLI-local id policy can drift from the engine's.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  SddScriptError,
  StoreError,
  createFsStore,
  createLocalExecutionIdentity,
  decodeExecutionSessionRef,
  executionContextFor,
  recoverExecutionCoordinator,
  resolveExecutionReadRoute,
  resolveProcessHarnessDir,
  serializeExecutionValue,
  setArtifactStore,
  validateExecutionIdentity,
  type ActivationAttestation,
  type ExecutionIdentity,
  type ExecutionIdentityRole,
  type ExecutionIdentityScope,
  type ExecutionRead,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionToken,
  type StoreContext,
} from "@mstar-harness/engine";

/* ------------------------------------------------------------------------ *
 * § The identity channel
 * ------------------------------------------------------------------------ */

/** The active caller-identity channel: overwritten by the launcher, never inherited. */
export const EXECUTION_IDENTITY_ENV = "MSTAR_EXECUTION_IDENTITY";

/** The legacy pre-activation channel: a file-route input only, never an active identity. */
export const LEGACY_SESSION_ID_ENV = "MSTAR_HOST_SESSION_ID";

/** The exact key set of the §3.1 identity tuple, in canonical order. */
const IDENTITY_KEYS = "planId,role,sessionId,source,workflowId";

/**
 * The canonical producer form of the channel value — the seam a host launcher
 * reproduces, so it stays an exported contract rather than an inline call.
 */
export function encodeExecutionIdentity(identity: ExecutionIdentity): string {
  return serializeExecutionValue(identity);
}

/**
 * Decode one acquired identity from the channel. Shape only — the caller's
 * scope is validated separately — and every refusal states the rule without
 * echoing the payload, because this diagnostic can reach stdout.
 */
export function decodeExecutionIdentity(value: unknown): ExecutionIdentity {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SddScriptError(
      `usage: ${EXECUTION_IDENTITY_ENV} is empty \u2014 it must carry the independently acquired execution identity ` +
        "(canonical JSON as produced by the engine's serializeExecutionValue); the received value is not echoed in this diagnostic",
      2,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SddScriptError(
      `usage: ${EXECUTION_IDENTITY_ENV} is not the canonical JSON execution identity \u2014 the received value is not echoed ` +
        "in this diagnostic",
      2,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SddScriptError(
      `usage: ${EXECUTION_IDENTITY_ENV} must be one execution identity object \u2014 the received value is not echoed in this diagnostic`,
      2,
    );
  }
  const keys = Object.keys(parsed as Record<string, unknown>).sort().join(",");
  if (keys !== IDENTITY_KEYS) {
    throw new SddScriptError(
      `usage: ${EXECUTION_IDENTITY_ENV} must carry exactly ${IDENTITY_KEYS} \u2014 an unknown or missing field is a malformed ` +
        "identity, never an ignored one; the received value is not echoed in this diagnostic",
      2,
    );
  }
  // The §3.1 type/scope rules stay the engine's single implementation.
  return parsed as ExecutionIdentity;
}

/**
 * The independently acquired identity of THIS invocation, validated against the
 * scope it addresses. An absent channel is a usage refusal (nothing was
 * acquired); a present identity that names another workflow/role/plan is the
 * engine's own `coordination.identity-mismatch`.
 */
export function requireExecutionIdentity(
  scope: ExecutionIdentityScope,
  verb: string,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionIdentity {
  const raw = env[EXECUTION_IDENTITY_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new SddScriptError(
      `usage: ${verb} requires an independently acquired execution identity in ${EXECUTION_IDENTITY_ENV} \u2014 launch it with ` +
        "`mstar session run --workflow <id> --role <coordinator|plan-pm> [--plan <id>] [--harness <absolute-path>] -- <argv>`; " +
        "the identity is never generated here, never read from a session file, and the legacy MSTAR_HOST_SESSION_ID does not supply it",
      2,
    );
  }
  const identity = decodeExecutionIdentity(raw);
  validateExecutionIdentity(identity, scope);
  return identity;
}

/* ------------------------------------------------------------------------ *
 * § Shared active-flag shape (exit 2, before any IO)
 * ------------------------------------------------------------------------ */

function requireFlagValue(raw: string | undefined, flag: string, verb: string, what: string): string {
  if (raw === undefined || raw.trim() === "") {
    throw new SddScriptError(`usage: ${verb} requires ${flag} <${what}>`, 2);
  }
  return raw.trim();
}

/** The resolved control root an active flag set addresses. */
export function requireExecutionRoot(harnessArg: string | undefined, verb: string): string {
  if (harnessArg !== undefined && !isAbsolute(harnessArg)) {
    // Same non-echoing shape as every other absolute-path refusal here: a
    // caller-supplied address never becomes a public diagnostic.
    throw new SddScriptError(
      "--harness must be an absolute path \u2014 the received value is not absolute and is not echoed in this diagnostic",
      2,
    );
  }
  const root = resolveProcessHarnessDir(process.cwd(), harnessArg);
  if (root === null) {
    throw new SddScriptError(
      `usage: ${verb}: no control harness was resolved from ${process.cwd()} \u2014 pass --harness <absolute-path>`,
      2,
    );
  }
  return root;
}

/**
 * The `--expect` of an ACTIVE mutation: the full execution token of the scope
 * being written. A revision integer is what the retired file route took, so it
 * is refused here rather than reinterpreted.
 */
export function requireExecutionToken(raw: string | undefined, flag: string, verb: string): ExecutionToken {
  const value = requireFlagValue(raw, flag, verb, "full-execution-token");
  if (!value.startsWith("exec-v1:")) {
    throw new SddScriptError(
      `${flag} must be the full execution token of the addressed scope ` +
        '("exec-v1:<kind>:<store-id>:<epoch>:<key64>:<revision>") from the current read \u2014 a revision integer is a ' +
        "pre-activation input and is never coerced; the received value is not echoed in this diagnostic",
      2,
    );
  }
  return value as ExecutionToken;
}

/** Decode one `--session-ref` wire (prefix shape here; canonical form in the engine). */
export function requireSessionRef(raw: string | undefined, flag: string, verb: string): ExecutionSessionRef {
  const value = requireFlagValue(raw, flag, verb, "session-reference");
  if (!value.startsWith("exec-session-v1:")) {
    throw new SddScriptError(
      `${flag} must be the canonical session reference ("exec-session-v1:<base64url>") \u2014 a session file path, a plain ` +
        "session id and a revision integer are all pre-activation inputs; the received value is not echoed in this diagnostic",
      2,
    );
  }
  return decodeExecutionSessionRef(value);
}

/** An absolute JSON file read as one payload value (usage class on shape). */
export function requireJsonFile(raw: string | undefined, flag: string, verb: string, what: string): unknown {
  const file = requireFlagValue(raw, flag, verb, what);
  if (!isAbsolute(file)) {
    throw new SddScriptError(
      `${flag} must be an absolute path \u2014 the received value is not absolute and is not echoed in this diagnostic`,
      2,
    );
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SddScriptError(`${flag} is unreadable: ${(error as Error).message}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SddScriptError(`${flag} is not valid JSON: ${(error as Error).message}`, 2);
  }
}

/* ------------------------------------------------------------------------ *
 * § Route refusals
 * ------------------------------------------------------------------------ */

/**
 * The pre-activation form of one command is unavailable while the control
 * harness's execution authority is ACTIVE. The engine's own file guards already
 * refuse those writers; this early refusal keeps the transport decision visible
 * (which active form to use instead) and never writes a file first.
 */
export async function assertLegacyExecutionFormAvailable(context: StoreContext, what: string): Promise<void> {
  if ((await resolveExecutionReadRoute(context)) !== "execution") return;
  throw new StoreError(
    "execution.consumer-not-ready",
    `${what}: the execution authority of ${context.harnessDir} is ACTIVE, so this pre-activation form is retired. ` +
      "Nothing was written \u2014 read the current token and run the active DB form of the same verb under an independently " +
      "acquired identity instead.",
  );
}

/* ------------------------------------------------------------------------ *
 * § Result shape (contract §3.2)
 * ------------------------------------------------------------------------ */

/** The active success envelope: `{ok, route, operation, data, token, store_id, epoch, ...}`. */
export function executionSuccessPayload(
  operation: string,
  receipt: { data: unknown; token: string; storeId: string; epoch: number; operationId?: string; replayed?: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: true,
    route: "execution",
    operation,
    data: receipt.data,
    token: receipt.token,
    store_id: receipt.storeId,
    epoch: receipt.epoch,
  };
  // A resume is a read: it owns no operation receipt, so it carries neither key.
  if (receipt.operationId !== undefined) payload.operation_id = receipt.operationId;
  if (receipt.replayed !== undefined) payload.replayed = receipt.replayed;
  return payload;
}

export function printExecutionSuccess(
  operation: string,
  receipt: ExecutionReceipt<unknown>,
  json: boolean,
  human: string,
): void {
  if (json) {
    console.log(JSON.stringify(executionSuccessPayload(operation, receipt)));
    return;
  }
  // Human mode keeps stdout machine-only: the readable summary is diagnostic.
  console.error(pc.green(human));
  console.error(`${operation}: token ${receipt.token} (store ${receipt.storeId}, epoch ${receipt.epoch})`);
}

export function printExecutionRead(
  operation: string,
  read: ExecutionRead<unknown>,
  json: boolean,
  human: string,
): void {
  if (json) {
    console.log(JSON.stringify(executionSuccessPayload(operation, read)));
    return;
  }
  console.error(pc.green(human));
  console.error(`${operation}: token ${read.token} (store ${read.storeId}, epoch ${read.epoch})`);
}

/** The engine's stable refusal prefixes; anything else is an unexpected failure. */
const REFUSAL_PREFIXES = ["coordination.", "catalog.", "store.", "issue.", "execution."] as const;

/** One failure exit for the active transport: usage 2, engine refusal 1, else 1. */
export function failExecutionVerb(verb: string, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError) {
    if (json) console.log(JSON.stringify({ ok: false, operation: verb, code: "usage", message }));
    else console.error(pc.red(`${verb}: ${message}`));
    process.exitCode = error.exitCode;
    return;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && REFUSAL_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    if (json) console.log(JSON.stringify({ ok: false, operation: verb, code, message }));
    else console.error(pc.red(`${verb}: ${message}`));
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify({ ok: false, operation: verb, code: "session.internal-error", message }));
  else console.error(pc.red(`${verb} failed: ${message}`));
  process.exitCode = 1;
}

/* ------------------------------------------------------------------------ *
 * § mstar session — the local launcher and coordinator recovery
 * ------------------------------------------------------------------------ */

const SESSION_ROLES: Record<string, ExecutionIdentityRole> = { coordinator: "coordinator", "plan-pm": "plan-pm" };

/** The child's env: the identity channel overwritten, the legacy channel removed. */
function launchEnv(identity: ExecutionIdentity, root: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [EXECUTION_IDENTITY_ENV]: encodeExecutionIdentity(identity) };
  // A stale pre-activation value never reaches the child, and the root is the
  // launcher's own resolution rather than an inherited global.
  delete env[LEGACY_SESSION_ID_ENV];
  if (root !== null) env.MSTAR_HARNESS_DIR = root;
  return env;
}

/**
 * The signal a child died from, reading both runtime spellings of the same
 * fact: Node's `spawnSync` returns `signal`, Bun's returns `signalCode`.
 */
function childSignalOf(child: { signal?: NodeJS.Signals | null; signalCode?: NodeJS.Signals | null }): NodeJS.Signals | null {
  return child.signalCode ?? child.signal ?? null;
}

/**
 * The exit code a child finished with, reading both runtime spellings:
 * `node:child_process` under Node returns `status`, Bun's own result carries
 * `exitCode`. A normal child exit is only propagated when BOTH are read.
 */
function childExitOf(child: { status?: number | null; exitCode?: number | null }): number | null {
  return child.exitCode ?? child.status ?? null;
}

/**
 * Run argv with inherited stdio and propagate the child's own outcome: its exit
 * code, or the signal it was killed by (re-raised so scripts and CI observe the
 * same termination). Nothing about the identity is printed.
 */
function launchUnderIdentity(argv: readonly string[], identity: ExecutionIdentity, root: string | null): void {
  const [file, ...rest] = argv;
  const child = spawnSync(file!, rest, { stdio: "inherit", env: launchEnv(identity, root) });
  if (child.error !== undefined) {
    console.error(pc.red(`session run: could not launch the child command: ${child.error.message}`));
    process.exitCode = 1;
    return;
  }
  const signal = childSignalOf(child);
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = childExitOf(child) ?? 0;
}

/**
 * `mstar session` — the local identity launcher and the ACTIVE coordinator
 * recovery. Both are deliberately separate from `mstar workflow
 * recover-coordinator` (JSON/Prepare only, prerequisite contract §3.3): the
 * active route never invokes the JSON writer, and the JSON route never activates
 * a store to obtain DB recovery.
 */
export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description(
      "Active execution transport helpers: `run` launches argv under a freshly minted local execution identity " +
        "(`MSTAR_EXECUTION_IDENTITY`), and `recover` binds a crashed/stopped workflow's coordinator through the " +
        "active DB recovery verb under an independently acquired identity (engine-backed; exit 0 ok, 1 refusal, 2 usage)",
    )
    .exitOverride();

  session
    .command("run")
    .description(
      "Launch a command under ONE freshly minted local execution identity: mints it once, overwrites " +
        "MSTAR_EXECUTION_IDENTITY in the child's environment (never a shell string, never a session file) and runs argv " +
        "with inherited stdio. Repeated CLI invocations inside the child share that identity; nothing is bound. The " +
        "child's exit code is propagated, and a child killed by a signal is reported as that signal",
    )
    .argument("<argv...>", "Command and arguments to launch (pass them after `--`)")
    .option("--workflow <id>", "Workflow the launched identity addresses")
    .option("--role <role>", "Seat the launched identity claims: coordinator | plan-pm")
    .option("--plan <id>", "Plan id (plan-pm only; a coordinator identity carries none)")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .exitOverride()
    .action((argv: string[], options: { workflow?: string; role?: string; plan?: string; harness?: string }) => {
      try {
        const workflowId = requireFlagValue(options.workflow, "--workflow", "session run", "workflow-id");
        const roleValue = requireFlagValue(options.role, "--role", "session run", "role");
        const role = SESSION_ROLES[roleValue];
        if (role === undefined) {
          throw new SddScriptError(`--role must be coordinator | plan-pm \u2014 got ${JSON.stringify(roleValue)}`, 2);
        }
        const planId = options.plan === undefined || options.plan.trim() === "" ? null : options.plan.trim();
        if (role === "coordinator" && planId !== null) {
          throw new SddScriptError("session run --role coordinator accepts no --plan (a coordinator identity carries no plan)", 2);
        }
        if (role === "plan-pm" && planId === null) {
          throw new SddScriptError("session run --role plan-pm requires --plan <id>", 2);
        }
        if (argv.length === 0 || argv[0]!.trim() === "") {
          throw new SddScriptError(
            "usage: session run --workflow <id> --role <coordinator|plan-pm> [--plan <id>] [--harness <absolute-path>] -- <argv...>",
            2,
          );
        }
        const root =
          options.harness === undefined
            ? resolveProcessHarnessDir(process.cwd())
            : requireExecutionRoot(options.harness, "session run");
        launchUnderIdentity(argv, createLocalExecutionIdentity({ workflowId, role, planId }), root);
      } catch (error) {
        failExecutionVerb("session run", error, false);
      }
    });

  session
    .command("recover")
    .description(
      "Recover a workflow's coordinator identity through the active DB recovery verb under an independently acquired " +
        "coordinator identity: the prior holder is NAMED (or `--unowned` when the workflow records none), the stop " +
        "attestation must name it stopped/reloaded, and the exact workflow token is the CAS. Resume is never recovery",
    )
    .option("--workflow <id>", "Workflow whose coordinator is recovered")
    .option("--prior-session <id>", "Session id of the coordinator being replaced")
    .option("--unowned", "The workflow records no prior coordinator (mutually exclusive with --prior-session)")
    .option("--reason <text>", "Why the prior coordinator can no longer authenticate")
    .option("--attestation <path>", "Absolute path of the ActivationAttestation JSON document")
    .option("--expect <token>", "The workflow's full execution token from the current read")
    .option("--operation <id>", "Caller-supplied id of this one recovery operation (the replay key)")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable JSON on stdout")
    .exitOverride()
    .action(async (options: Record<string, string | boolean | undefined>) => {
      const json = options.json === true;
      try {
        const workflowId = requireFlagValue(
          options.workflow as string | undefined,
          "--workflow",
          "session recover",
          "workflow-id",
        );
        const unowned = options.unowned === true;
        const priorRaw = options.priorSession as string | undefined;
        const priorNamed = priorRaw !== undefined && priorRaw.trim() !== "";
        if (unowned && priorNamed) {
          throw new SddScriptError("session recover accepts either --prior-session or --unowned, never both", 2);
        }
        if (!unowned && !priorNamed) {
          throw new SddScriptError(
            "usage: session recover --workflow <id> (--prior-session <id> | --unowned) --reason <text> " +
              "--attestation <absolute-json-path> --expect <full-execution-token> --operation <id> [--harness <absolute-path>] [--json]",
            2,
          );
        }
        const reason = requireFlagValue(options.reason as string | undefined, "--reason", "session recover", "text");
        const expected = requireExecutionToken(options.expect as string | undefined, "--expect", "session recover");
        const operationId = requireFlagValue(
          options.operation as string | undefined,
          "--operation",
          "session recover",
          "operation-id",
        );
        // The shape authority is the engine's `validateActivationAttestation`,
        // which `recoverExecutionCoordinator` runs before touching the store.
        const attestation = requireJsonFile(
          options.attestation as string | undefined,
          "--attestation",
          "session recover",
          "attestation-json-path",
        ) as ActivationAttestation;
        const root = requireExecutionRoot(options.harness as string | undefined, "session recover");
        // The identity is acquired for THIS workflow's coordinator seat; the
        // engine revalidates it against the current authority inside its own
        // transaction, so a copied or stale identity refuses there.
        const identity = requireExecutionIdentity(
          { workflowId, role: "coordinator", planId: null },
          "session recover",
        );
        setArtifactStore(createFsStore(root));
        const receipt = await recoverExecutionCoordinator(executionContextFor({ harnessDir: root }, identity), {
          expected,
          operationId,
          priorSessionId: unowned ? null : priorRaw!.trim(),
          reason,
          attestation,
        });
        printExecutionSuccess(
          "recover",
          receipt,
          json,
          `session recover: ${receipt.data.workflowId} coordinator is now session ${receipt.data.sessionId}`,
        );
      } catch (error) {
        failExecutionVerb("session recover", error, json);
      }
    });
}
