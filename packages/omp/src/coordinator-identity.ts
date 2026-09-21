/**
 * `mstar_coordinator` — the one host-owned coordinator-identity entry
 * (prerequisite contract §3.2).
 *
 * This adapter is deliberately thin and deliberately negative. A `bind` call
 * carries **only** the operation and the explicitly named workflow: the native
 * session id comes from `ctx.sessionManager`, the canonical control-harness
 * root is derived from the host cwd, and the caller cannot supply a session id,
 * root, role, authority flag or credential path — an input that tries is
 * refused before anything is read or written.
 *
 * `extensions/model-handoff.ts` registers the tool; the same adapter also
 * classifies the shell transport, so a managed coordinator bind attempted
 * through `bash` is refused with a redirect to this tool instead of being
 * silently authorized by an injected environment variable.
 */
import {
  bindPlanSession,
  validateExecutionIdentity,
  type CoordinationResult,
  type ExecutionIdentity,
} from "@mstar-harness/engine";

/** The host-owned tool name (the only advertised managed bootstrap route). */
export const COORDINATOR_TOOL_NAME = "mstar_coordinator";

/** The exact `bind` input: no session id, root, role, authority flag or credential path. */
export type CoordinatorBindRequest = Readonly<{ operation: "bind"; workflowId: string }>;

/** The only keys the input union accepts; anything else is refused by name. */
export const COORDINATOR_BIND_INPUT_KEYS = ["operation", "workflowId"] as const;

/** Host facts the adapter derives itself — never the caller. */
export type CoordinatorIdentityFacts = Readonly<{
  /** Native id from `ctx.sessionManager.getSessionId()`; `""` when the host has none. */
  sessionId: string;
  /** Host cwd: the engine re-derives residency and root identity from it. */
  cwd: string;
  /** Canonical control harness root resolved from `cwd`, or `null`. */
  harnessRoot: string | null;
  /** This session is a leaf/subagent (task) session. */
  leaf: boolean;
  /** The last host-observed entry route is the scoped-plan PM family. */
  scopedPlanEntry: boolean;
}>;

/** Observable outcome the registered tool projects into its result. */
export type CoordinatorIdentityOutcome = Readonly<{
  ok: boolean;
  isError: boolean;
  code: string;
  text: string;
  details: Record<string, unknown>;
}>;

/** The engine verb this adapter calls; injectable so a fixture proves the derived input. */
export type CoordinatorBindFn = (input: {
  coordinator: true;
  workflowId: string;
  harnessDir: string;
  /** The provenance this host adapter states for the acquired identity (§3.1). */
  source: "host" | "local";
  cwd: string;
  sessionId: string;
}) => Promise<CoordinationResult>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The stable refusal code of a thrown engine error, or `tool-error`. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.includes(".") ? code : "tool-error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refuse(code: string, text: string, details: Record<string, unknown> = {}): CoordinatorIdentityOutcome {
  return { ok: false, isError: true, code, text, details: { ...details, code } };
}

/**
 * Derive the adapter input from host facts and bind one coordinator identity.
 *
 * Refusal order is deliberate: the caller-supplied shape first (an extra field
 * is never partially honored), then the host-derived facts, then the shared
 * `validateExecutionIdentity`, then the engine verb — which re-checks
 * residency, root membership, registration commit and duplicate holders.
 */
export async function bindCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  bind: CoordinatorBindFn = (input) => bindPlanSession(input),
): Promise<CoordinatorIdentityOutcome> {
  if (!isPlainObject(raw)) {
    return refuse("invalid-input", "the coordinator bind input must be an object with operation and workflowId");
  }
  const forbidden = Object.keys(raw).filter(
    (key) => !(COORDINATOR_BIND_INPUT_KEYS as readonly string[]).includes(key),
  );
  if (forbidden.length > 0) {
    return refuse(
      "forbidden-field",
      `the coordinator bind input accepts only operation and workflowId \u2014 refused ${forbidden.join(", ")}; a session id, root, caller role, authority flag or credential path is never accepted from the caller`,
      { forbidden },
    );
  }
  if (raw.operation !== "bind") {
    return refuse("unknown-operation", `the coordinator tool implements bind only; got ${JSON.stringify(raw.operation)}`, {
      operation: raw.operation,
    });
  }
  if (!isNonEmpty(raw.workflowId)) {
    return refuse("invalid-input", "workflowId is required");
  }
  const workflowId = raw.workflowId;

  if (!isNonEmpty(facts.sessionId)) {
    return refuse(
      "identity-missing",
      "this host session has no native session id, so no coordinator identity can be acquired \u2014 the engine never generates one",
    );
  }
  if (facts.leaf) {
    return refuse("leaf-session", "this is a leaf/subagent (task) session, not a coordinator seat");
  }
  if (facts.scopedPlanEntry) {
    return refuse(
      "scoped-plan-route",
      "the last host-observed entry of this session is the scoped-plan PM route; that route restores an existing binding and never bootstraps one",
    );
  }
  if (!isNonEmpty(facts.harnessRoot)) {
    return refuse("harness-not-found", `no canonical control harness root is resolvable from ${facts.cwd}`, {
      cwd: facts.cwd,
    });
  }
  const harnessRoot = facts.harnessRoot;

  // The identity is the §3.1 tuple: provenance, scope and the host-derived
  // native id. The canonical root stays a separately supplied value (it is the
  // `harnessDir` the engine resolves and compares) — never an identity member.
  const identity: ExecutionIdentity = {
    source: "host",
    sessionId: facts.sessionId,
    workflowId,
    role: "coordinator",
    planId: null,
  };
  try {
    validateExecutionIdentity(identity, { workflowId, role: "coordinator", planId: null });
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId });
  }

  try {
    const bound = await bind({
      coordinator: true,
      workflowId,
      harnessDir: harnessRoot,
      source: "host",
      cwd: facts.cwd,
      sessionId: facts.sessionId,
    });
    return {
      ok: true,
      isError: false,
      code: "bound",
      text: `workflow ${workflowId} is bound to coordinator session ${bound.session.session_id} (${bound.session_file}). This binding is one-shot and this tool is the only supported managed bootstrap route.`,
      details: {
        workflowId,
        sessionId: bound.session.session_id,
        sessionFile: bound.session_file,
        role: "coordinator",
        harnessRoot,
      },
    };
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId, harnessRoot });
  }
}

/**
 * The managed coordinator bind as a bounded shell-token match: `plan bind`
 * carrying `--coordinator` in one `bash`/`functions.bash` command.
 *
 * This is intentionally not a shell parser and fences no arbitrary native code —
 * it recognizes the one documented transport shape so the shell route can refuse
 * with a redirect instead of relying on an injected environment variable for
 * authority. Unrelated commands are left untouched.
 */
const MANAGED_BIND_COMMAND_RE = /(?:^|[^\w-])plan\s+bind\b/;
const COORDINATOR_FLAG_RE = /(?:^|[^\w-])--coordinator\b/;

/** The shell tool identities this host may present (bare and namespaced). */
export const SHELL_TOOL_NAMES = ["bash", "functions.bash"] as const;

export type ShellCallRefusal = Readonly<{ block: true; reason: string }>;

/**
 * Classify one pre-execution tool call. Returns a refusal for a managed
 * coordinator bind attempted through a shell, and `undefined` for every other
 * call — an unrelated command, an unknown tool, or an input shape this bounded
 * classifier does not recognize (which is never revised, so an absent or
 * unsupported `env` field cannot produce an invalid input revision).
 */
export function classifyCoordinatorShellCall(event: Readonly<{ toolName: string; input: unknown }>): ShellCallRefusal | undefined {
  if (!(SHELL_TOOL_NAMES as readonly string[]).includes(event.toolName)) return undefined;
  if (!isPlainObject(event.input) || typeof event.input.command !== "string") return undefined;
  const command = event.input.command;
  if (!MANAGED_BIND_COMMAND_RE.test(command) || !COORDINATOR_FLAG_RE.test(command)) return undefined;
  return {
    block: true,
    reason:
      "a managed coordinator bind is not performed through the shell. Call the host-owned `mstar_coordinator` tool with " +
      '{operation:"bind", workflowId} instead \u2014 it derives the native session id and the canonical control root. A ' +
      "`plan bind --coordinator` through `bash` no longer carries an authorized identity.",
  };
}
