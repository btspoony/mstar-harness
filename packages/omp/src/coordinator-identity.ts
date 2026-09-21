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
  readWorkflowSnapshot,
  recoverPrepareCoordinator,
  resolveWorkflowDir,
  showPrepareCoordinatorRecovery,
  validateExecutionIdentity,
  type CoordinationResult,
  type ExecutionIdentity,
  type PrepareCoordinatorRecoveryView,
  type RecoverPrepareCoordinatorResult,
} from "@mstar-harness/engine";
import { join } from "node:path";

/** The host-owned tool name (the only advertised managed bootstrap route). */
export const COORDINATOR_TOOL_NAME = "mstar_coordinator";

/** The exact `bind` input: no session id, root, role, authority flag or credential path. */
export type CoordinatorBindRequest = Readonly<{ operation: "bind"; workflowId: string }>;

/** The only keys the input union accepts; anything else is refused by name. */
export const COORDINATOR_BIND_INPUT_KEYS = ["operation", "workflowId"] as const;

/** The read-only recovery view input: the same two caller-chosen fields as `bind`. */
export type CoordinatorShowRecoveryRequest = Readonly<{ operation: "show-recovery"; workflowId: string }>;

/**
 * The `recover` input (prerequisite contract §3.3): the reviewed tokens and the
 * operator's own proof, plus the workflow. Deliberately absent: any session id
 * for the NEW identity (host-derived), the prior holder's session id or
 * envelope path (resolved from the stored binding, never accepted from the
 * caller), a root, a role and any force flag.
 */
export type CoordinatorRecoverRequest = Readonly<{
  operation: "recover";
  workflowId: string;
  expectedSnapshotVersion: string;
  expectedCompassVersion: string;
  operationId: string;
  reason: string;
  authorizationRef: string;
  stoppedSessionIds: readonly string[];
}>;

/** The only keys `show-recovery` accepts. */
export const COORDINATOR_SHOW_RECOVERY_INPUT_KEYS = ["operation", "workflowId"] as const;

/** The only keys `recover` accepts — reviewed tokens and stop proof, nothing else. */
export const COORDINATOR_RECOVER_INPUT_KEYS = [
  "operation",
  "workflowId",
  "expectedSnapshotVersion",
  "expectedCompassVersion",
  "operationId",
  "reason",
  "authorizationRef",
  "stoppedSessionIds",
] as const;

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
 * The stored coordinator binding of one workflow, resolved by the HOST from the
 * engine's own path table (§3.3): the adapter never accepts a prior credential
 * path from the caller, and the engine re-verifies that the resolved envelope is
 * still the recorded one before it replaces anything. A missing binding, an
 * unreadable snapshot or a malformed stored block refuses.
 */
export type CoordinatorRecoveryTarget = Readonly<{ priorSessionPath: string; priorSessionId: string }>;

/** How the adapter resolves the recorded prior holder; injectable for fixtures. */
export type CoordinatorRecoveryTargetReader = (input: {
  harnessRoot: string;
  workflowId: string;
}) => { ok: true; target: CoordinatorRecoveryTarget } | { ok: false; code: string; message: string };

/** The default target reader: the snapshot's own top-level coordinator binding. */
export const readStoredCoordinatorTarget: CoordinatorRecoveryTargetReader = ({ harnessRoot, workflowId }) => {
  let snapshot;
  try {
    // The same resolved workflow dir the engine writes to (a configured
    // `workflow_dir` moves with the engine, not with this adapter).
    snapshot = readWorkflowSnapshot(join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), workflowId)).snapshot;
  } catch (error) {
    return {
      ok: false,
      code: "recovery-not-prepare",
      message: `workflow ${workflowId} snapshot is unreadable, so no recorded coordinator binding can be recovered: ${messageOf(error)}`,
    };
  }
  const coordinator = snapshot.coordination?.coordinator;
  if (coordinator === undefined) {
    return {
      ok: false,
      code: "recovery-not-prepare",
      message: `workflow ${workflowId} has no recorded coordinator binding \u2014 recovery replaces a recorded binding and never creates one`,
    };
  }
  return { ok: true, target: { priorSessionPath: coordinator.session_file, priorSessionId: coordinator.session_id } };
};

/** The engine verbs the recovery operations call; injectable so fixtures prove the derived input. */
export type CoordinatorRecoveryDeps = Readonly<{
  show: (input: { cwd: string; harnessDir: string; workflowId: string }) => Promise<PrepareCoordinatorRecoveryView>;
  recover: (input: {
    cwd: string;
    harnessDir: string;
    identity: ExecutionIdentity;
    priorSessionPath: string;
    priorSessionId: string;
    expectedSnapshotVersion: string;
    expectedCompassVersion: string;
    operationId: string;
    reason: string;
    authorizationRef: string;
    stoppedSessionIds: readonly string[];
  }) => Promise<RecoverPrepareCoordinatorResult>;
  target: CoordinatorRecoveryTargetReader;
}>;

const DEFAULT_RECOVERY_DEPS: CoordinatorRecoveryDeps = {
  show: (input) => showPrepareCoordinatorRecovery(input),
  recover: (input) => recoverPrepareCoordinator(input),
  target: readStoredCoordinatorTarget,
};

/** The host-derived facts and the refusal order every coordinator operation shares. */
function coordinatorCallContext(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  allowedKeys: readonly string[],
  operation: "show-recovery" | "recover",
): { ok: true; workflowId: string; harnessRoot: string } | { ok: false; outcome: CoordinatorIdentityOutcome } {
  if (!isPlainObject(raw)) {
    return { ok: false, outcome: refuse("invalid-input", `the coordinator ${operation} input must be an object`) };
  }
  const forbidden = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (forbidden.length > 0) {
    const extra =
      operation === "recover"
        ? "a session id, root, caller role, authority flag, credential path or force flag is never accepted from the caller"
        : "a session id, root, caller role, authority flag or credential path is never accepted from the caller";
    return {
      ok: false,
      outcome: refuse("forbidden-field", `the coordinator ${operation} input accepts only ${allowedKeys.join(", ")} \u2014 refused ${forbidden.join(", ")}; ${extra}`, {
        forbidden,
      }),
    };
  }
  if (!isNonEmpty(raw.workflowId)) {
    return { ok: false, outcome: refuse("invalid-input", "workflowId is required") };
  }
  if (!isNonEmpty(facts.sessionId)) {
    return {
      ok: false,
      outcome: refuse(
        "identity-missing",
        "this host session has no native session id, so no coordinator identity can be acquired \u2014 the engine never generates one",
      ),
    };
  }
  if (facts.leaf) {
    return { ok: false, outcome: refuse("leaf-session", "this is a leaf/subagent (task) session, not a coordinator seat") };
  }
  if (facts.scopedPlanEntry) {
    return {
      ok: false,
      outcome: refuse(
        "scoped-plan-route",
        "the last host-observed entry of this session is the scoped-plan PM route; that route restores an existing binding and never bootstraps or recovers one",
      ),
    };
  }
  if (!isNonEmpty(facts.harnessRoot)) {
    return {
      ok: false,
      outcome: refuse("harness-not-found", `no canonical control harness root is resolvable from ${facts.cwd}`, { cwd: facts.cwd }),
    };
  }
  return { ok: true, workflowId: raw.workflowId, harnessRoot: facts.harnessRoot };
}

/**
 * `{operation:"show-recovery"}` — the read-only recovery view of one workflow
 * (prerequisite contract §3.3): the recorded owner, both byte versions and the
 * Prepare verdict, with no envelope bytes, credential or path. The caller uses
 * it to review before recovering; it writes nothing.
 */
export async function showCoordinatorRecovery(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  deps: CoordinatorRecoveryDeps = DEFAULT_RECOVERY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const context = coordinatorCallContext(raw, facts, COORDINATOR_SHOW_RECOVERY_INPUT_KEYS, "show-recovery");
  if (!context.ok) return context.outcome;
  if ((raw as Record<string, unknown>).operation !== "show-recovery") {
    return refuse("unknown-operation", `this is the show-recovery path; got ${JSON.stringify((raw as Record<string, unknown>).operation)}`);
  }
  try {
    const view = await deps.show({ cwd: facts.cwd, harnessDir: context.harnessRoot, workflowId: context.workflowId });
    const blockers = view.blockers.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    return {
      ok: true,
      isError: false,
      code: view.allowed ? "recovery-allowed" : "recovery-blocked",
      text: `workflow ${view.workflowId} records coordinator session ${view.priorSessionId} (snapshot ${view.snapshotVersion}, compass ${view.compassVersion}); recovery is ${view.allowed ? "admissible" : `blocked \u2014 ${blockers}`}. This view holds no envelope bytes or credential path.`,
      details: {
        workflowId: view.workflowId,
        priorSessionId: view.priorSessionId,
        snapshotVersion: view.snapshotVersion,
        compassVersion: view.compassVersion,
        allowed: view.allowed,
        blockers: view.blockers.map((entry) => `${entry.code}: ${entry.message}`),
        harnessRoot: context.harnessRoot,
      },
    };
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId: context.workflowId, harnessRoot: context.harnessRoot });
  }
}

/**
 * `{operation:"recover"}` — replace the recorded coordinator binding with THIS
 * host session, under the audited guards of §3.3. The new identity is the
 * host-derived native id (never a caller value); the prior holder and its
 * envelope path come from the engine's stored binding (never a caller path),
 * and the caller must name that holder in the stop assertion. Every semantic
 * guard stays the engine's, inside the snapshot write lock.
 */
export async function recoverCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  deps: CoordinatorRecoveryDeps = DEFAULT_RECOVERY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const context = coordinatorCallContext(raw, facts, COORDINATOR_RECOVER_INPUT_KEYS, "recover");
  if (!context.ok) return context.outcome;
  const request = raw as Record<string, unknown>;
  if (request.operation !== "recover") {
    return refuse("unknown-operation", `this is the recover path; got ${JSON.stringify(request.operation)}`);
  }
  for (const [field, value] of [
    ["expectedSnapshotVersion", request.expectedSnapshotVersion],
    ["expectedCompassVersion", request.expectedCompassVersion],
    ["operationId", request.operationId],
    ["reason", request.reason],
    ["authorizationRef", request.authorizationRef],
  ] as const) {
    if (!isNonEmpty(value)) return refuse("invalid-input", `${field} is required`);
  }
  const stopped = request.stoppedSessionIds;
  if (!Array.isArray(stopped) || stopped.length === 0 || stopped.some((entry) => !isNonEmpty(entry))) {
    return refuse(
      "unauthorized",
      "stoppedSessionIds must name the recorded prior holder this recovery replaces \u2014 the host never treats an empty stop assertion as an authorization",
      { workflowId: context.workflowId },
    );
  }
  const stoppedSessionIds = stopped as readonly string[];

  const resolved = deps.target({ harnessRoot: context.harnessRoot, workflowId: context.workflowId });
  if (!resolved.ok) return refuse(resolved.code, resolved.message, { workflowId: context.workflowId });
  const { priorSessionPath, priorSessionId } = resolved.target;
  // The stop assertion is forwarded EXACTLY as the caller stated it: whether it
  // names the recorded holder is the engine's guard, checked against the
  // binding it reads inside the snapshot lock (which is also what makes an
  // exact retry of an accepted recovery recognizable). The host still refuses
  // an empty assertion above, because that is a missing proof, not a mismatch.

  const identity: ExecutionIdentity = {
    source: "host",
    sessionId: facts.sessionId,
    workflowId: context.workflowId,
    role: "coordinator",
    planId: null,
  };
  try {
    validateExecutionIdentity(identity, { workflowId: context.workflowId, role: "coordinator", planId: null });
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId: context.workflowId });
  }
  try {
    const result = await deps.recover({
      cwd: facts.cwd,
      harnessDir: context.harnessRoot,
      identity,
      priorSessionPath,
      priorSessionId,
      expectedSnapshotVersion: request.expectedSnapshotVersion as string,
      expectedCompassVersion: request.expectedCompassVersion as string,
      operationId: request.operationId as string,
      reason: request.reason as string,
      authorizationRef: request.authorizationRef as string,
      stoppedSessionIds,
    });
    const receipt = result.recovery;
    return {
      ok: true,
      isError: false,
      code: receipt.replay ? "replayed" : "recovered",
      text: receipt.replay
        ? `workflow ${receipt.workflowId} already recorded operation ${receipt.operationId}: this session ${receipt.sessionId} is still its coordinator (snapshot ${receipt.snapshotVersion}); nothing was written.`
        : `workflow ${receipt.workflowId} now has coordinator session ${receipt.sessionId} (was ${receipt.priorSessionId}); the replacement is audited as operation ${receipt.operationId}, and the prior envelope's bytes remain as history without authorizing anything.`,
      details: {
        workflowId: receipt.workflowId,
        priorSessionId: receipt.priorSessionId,
        sessionId: receipt.sessionId,
        operationId: receipt.operationId,
        replay: receipt.replay,
        snapshotVersion: receipt.snapshotVersion,
        compassVersion: receipt.compassVersion,
        // Coordinator-owned transport: the replacing session continues with it.
        sessionFile: result.session_file,
        harnessRoot: context.harnessRoot,
      },
    };
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId: context.workflowId, harnessRoot: context.harnessRoot });
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
