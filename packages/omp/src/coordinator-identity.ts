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
 *
 * ## Two authority-selected forms of the same operations (§6, phase 2b)
 *
 * The control root this call addresses decides WHICH authority answers, and the
 * caller never selects one:
 *
 * - an ACTIVE execution authority (`resolveExecutionReadRoute` → `execution`)
 *   answers through the DB session API: `bind {workflowId, expected,
 *   operationId}` and `recover {workflowId, priorSessionId, reason, attestation,
 *   expected, operationId}` call the existing engine verbs directly under an
 *   independently acquired host identity. `expected` is the full workflow
 *   execution token and `attestation` is the existing `ActivationAttestation`
 *   document, projected by the engine's own validator.
 * - the pre-activation file route (`files`, and only it) keeps the managed
 *   Prepare bootstrap `bind {workflowId}` and the JSON recovery, unchanged.
 *
 * The two forms are told apart by their own fields and then confirmed against
 * the route: a mixed key set, a missing field, an active form on a root with no
 * active authority, or a JSON form on an ACTIVE root all refuse *before* any
 * IO — a fallback authority is never selected on the caller's behalf.
 */
import {
  assertExecutionFileReadAllowed,
  assertSafeSessionId,
  bindExecutionSession,
  bindPlanSession,
  executionContextFor,
  readExecutionAuthority,
  readWorkflowSnapshot,
  recoverExecutionCoordinator,
  recoverPrepareCoordinator,
  resolveExecutionReadRoute,
  resolveWorkflowDir,
  showPrepareCoordinatorRecovery,
  validateActivationAttestation,
  validateExecutionIdentity,
  type CoordinationResult,
  type ExecutionBinding,
  type ExecutionIdentity,
  type ExecutionPlanView,
  type ExecutionRead,
  type ExecutionReceipt,
  type ExecutionSessionRef,
  type ExecutionState,
  type ExecutionToken,
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

/* ------------------------------------------------------------------------- *
 * Active execution authority (§6, phase 2b)
 * ------------------------------------------------------------------------- */

/**
 * The active `bind`: the managed bootstrap has no envelope here — the DB session
 * API records the binding under the host-derived identity. The caller supplies
 * the exact workflow execution token it read from the current authority and the
 * operation id that makes an identical retry a replay; it still supplies no
 * session id, root, role, authority flag or credential path.
 */
export type CoordinatorActiveBindRequest = Readonly<{
  operation: "bind";
  workflowId: string;
  /** Full `exec-v1:workflow:…` token of the addressed workflow, re-checked by the engine. */
  expected: string;
  /** Operation id: an identical retry is a replay, a different request refuses. */
  operationId: string;
}>;

/** The only keys the active `bind` accepts. */
export const COORDINATOR_ACTIVE_BIND_INPUT_KEYS = ["operation", "workflowId", "expected", "operationId"] as const;

/**
 * The active `recover`: the DB recovery verb replaces the named holder under the
 * operator's own attestation document. `priorSessionId` is explicit — the JSON
 * form resolves it from the stored binding, while the DB form records what the
 * operator names, and `null` means "this workflow records no coordinator at
 * all" (`--unowned`), never "work it out for me".
 */
export type CoordinatorActiveRecoverRequest = Readonly<{
  operation: "recover";
  workflowId: string;
  /** The recorded holder this recovery replaces, or `null` only for an unowned workflow. */
  priorSessionId: string | null;
  reason: string;
  /** The operator's own `ActivationAttestation` document; validated by the engine, never manufactured here. */
  attestation: unknown;
  /** Full `exec-v1:workflow:…` token of the addressed workflow. */
  expected: string;
  operationId: string;
}>;

/** The only keys the active `recover` accepts. */
export const COORDINATOR_ACTIVE_RECOVER_INPUT_KEYS = [
  "operation",
  "workflowId",
  "priorSessionId",
  "reason",
  "attestation",
  "expected",
  "operationId",
] as const;

/** The two fields that mark the active form of `bind`/`recover`. */
const ACTIVE_FORM_MARKERS = ["expected", "operationId"] as const;

/**
 * The engine/route surface the active forms call; injectable so a fixture proves
 * the derived input and the refusal order without a live store.
 */
export type CoordinatorAuthorityDeps = Readonly<{
  /** §5 route of this control root: `execution` only when an ACTIVE authority governs it. */
  route: (input: { harnessDir: string }) => Promise<"execution" | "files">;
  bind: (input: {
    harnessDir: string;
    identity: ExecutionIdentity;
    workflowId: string;
    expected: ExecutionToken;
    operationId: string;
  }) => Promise<ExecutionReceipt<ExecutionSessionRef>>;
  recover: (input: {
    harnessDir: string;
    identity: ExecutionIdentity;
    expected: ExecutionToken;
    operationId: string;
    priorSessionId: string | null;
    reason: string;
    attestation: unknown;
  }) => Promise<ExecutionReceipt<ExecutionSessionRef>>;
  read: (input: { harnessDir: string; workflowId: string }) => Promise<ExecutionRead<ExecutionState | ExecutionPlanView>>;
}>;

const DEFAULT_AUTHORITY_DEPS: CoordinatorAuthorityDeps = {
  route: (input) => resolveExecutionReadRoute({ harnessDir: input.harnessDir }),
  bind: (input) =>
    bindExecutionSession(executionContextFor({ harnessDir: input.harnessDir }, input.identity), {
      workflowId: input.workflowId,
      planId: null,
      role: "coordinator",
      expected: input.expected,
      operationId: input.operationId,
    }),
  recover: (input) =>
    recoverExecutionCoordinator(executionContextFor({ harnessDir: input.harnessDir }, input.identity), {
      expected: input.expected,
      operationId: input.operationId,
      priorSessionId: input.priorSessionId,
      reason: input.reason,
      attestation: validateActivationAttestation(input.attestation),
    }),
  read: (input) => readExecutionAuthority({ harnessDir: input.harnessDir }, { workflowId: input.workflowId }),
};

/**
 * The canonical host-side binding of one adopted execution session (§3.1): the
 * durable selection record hosts persist in their own native state. It is a
 * value shape — persisting it grants no authority, and an epoch mismatch
 * invalidates the reference it carries, never the host's own selection.
 *
 * The reference is PROJECTED field by field rather than stored as handed over:
 * the engine's canonical-value rule accepts only objects whose prototype is
 * `Object.prototype` or `null`, and this binding is serialized (compared and
 * persisted) by its host, so an engine-returned object never travels into it.
 */
export function executionBindingOf(harnessRoot: string, session: ExecutionSessionRef): ExecutionBinding {
  if (!isNonEmpty(harnessRoot)) {
    throw new Error("an execution binding needs the canonical control harness root it was adopted from");
  }
  return {
    version: 1,
    harnessRoot,
    session: {
      storeId: session.storeId,
      epoch: session.epoch,
      workflowId: session.workflowId,
      role: session.role,
      sessionId: session.sessionId,
      planId: session.planId,
    },
  };
}

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

/** The §3.1 host identity of one coordinator call: provenance, scope, native id. */
function coordinatorIdentityOf(sessionId: string, workflowId: string): ExecutionIdentity {
  return { source: "host", sessionId, workflowId, role: "coordinator", planId: null };
}

/** The §5 route of one control root, or the root's own refusal (never masked). */
async function routeOf(
  authority: CoordinatorAuthorityDeps,
  harnessRoot: string,
): Promise<{ ok: true; value: "execution" | "files" } | { ok: false; outcome: CoordinatorIdentityOutcome }> {
  try {
    return { ok: true, value: await authority.route({ harnessDir: harnessRoot }) };
  } catch (error) {
    return { ok: false, outcome: refuse(codeOf(error), messageOf(error), { harnessRoot }) };
  }
}

type CoordinatorForm =
  | { ok: true; form: "json" | "active"; request: Record<string, unknown> }
  | { ok: false; outcome: CoordinatorIdentityOutcome };

/**
 * Which of the two authority-selected forms one call declares, from its own key
 * set alone. The active form is the one carrying a marker field the JSON form
 * does not have; the chosen form's key set must then match EXACTLY, so a mixed
 * or partial call is refused by name instead of silently selecting an authority.
 */
function classifyCoordinatorForm(
  raw: unknown,
  operation: "bind" | "show-recovery" | "recover",
  jsonKeys: readonly string[],
  activeKeys: readonly string[],
  markers: readonly string[],
): CoordinatorForm {
  if (!isPlainObject(raw)) {
    return { ok: false, outcome: refuse("invalid-input", `the coordinator ${operation} input must be an object`) };
  }
  if (raw.operation !== operation) {
    return {
      ok: false,
      outcome: refuse("unknown-operation", `this is the coordinator ${operation} path; got ${JSON.stringify(raw.operation)}`, {
        operation: raw.operation,
      }),
    };
  }
  const keys = Object.keys(raw);
  const form = markers.some((marker) => keys.includes(marker)) ? "active" : "json";
  const allowed = form === "active" ? activeKeys : jsonKeys;
  const forbidden = keys.filter((key) => !allowed.includes(key));
  if (forbidden.length > 0) {
    return {
      ok: false,
      outcome: refuse(
        "forbidden-field",
        `the coordinator ${operation} ${form} form accepts only ${allowed.join(", ")} \u2014 refused ${forbidden.join(", ")}; ` +
          "a mixed form never selects an authority, and a session id, root, caller role, authority flag or credential path is never accepted from the caller",
        { forbidden, form },
      ),
    };
  }
  const missing = allowed.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    return {
      ok: false,
      outcome: refuse(
        "invalid-input",
        `the coordinator ${operation} ${form} form requires ${missing.join(", ")}; a partial form never falls back to the other authority`,
        { missing, form },
      ),
    };
  }
  return { ok: true, form, request: raw };
}

/**
 * Derive the adapter input from host facts and bind one coordinator identity.
 *
 * Refusal order is deliberate: the caller-supplied shape and its form first (an
 * extra field is never partially honored, and a mixed form never picks a
 * fallback authority), then the host-derived facts, then the route of the
 * addressed root, then the shared `validateExecutionIdentity`, then the engine
 * verb — which re-checks creation identity, root membership, registration
 * commit and duplicate holders.
 */
export async function bindCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  bind: CoordinatorBindFn = (input) => bindPlanSession(input),
  authority: CoordinatorAuthorityDeps = DEFAULT_AUTHORITY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const shape = classifyCoordinatorForm(
    raw,
    "bind",
    COORDINATOR_BIND_INPUT_KEYS,
    COORDINATOR_ACTIVE_BIND_INPUT_KEYS,
    ACTIVE_FORM_MARKERS,
  );
  if (!shape.ok) return shape.outcome;
  if (!isNonEmpty(shape.request.workflowId)) {
    return refuse("invalid-input", "workflowId is required");
  }
  const workflowId = shape.request.workflowId;

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

  // §5/§6: the root decides which authority answers. The probe runs for both
  // forms, before any engine verb, so an active form on a pre-activation root
  // and a Prepare form on an ACTIVE root both refuse without a fallback.
  const route = await routeOf(authority, harnessRoot);
  if (!route.ok) return route.outcome;

  if (shape.form === "active") {
    if (route.value !== "execution") {
      return refuse(
        "execution.not-active",
        `the control root ${harnessRoot} carries no ACTIVE execution authority (its read route is "${route.value}"), so no DB session can be bound there. The active form never falls back to the Prepare bootstrap: activate the execution authority, or use the file route deliberately.`,
        { workflowId, harnessRoot },
      );
    }
    for (const [field, value] of [
      ["expected", shape.request.expected],
      ["operationId", shape.request.operationId],
    ] as const) {
      if (!isNonEmpty(value)) return refuse("invalid-input", `${field} is required for the active coordinator bind`);
    }
    const identity = coordinatorIdentityOf(facts.sessionId, workflowId);
    try {
      validateExecutionIdentity(identity, { workflowId, role: "coordinator", planId: null });
    } catch (error) {
      return refuse(codeOf(error), messageOf(error), { workflowId });
    }
    try {
      const bound = await authority.bind({
        harnessDir: harnessRoot,
        identity,
        workflowId,
        expected: shape.request.expected as ExecutionToken,
        operationId: shape.request.operationId,
      });
      // The DB session reference is an identity, not a credential: the text
      // names the already-public workflow/session ids and the store epoch, and
      // never a token or a path.
      return {
        ok: true,
        isError: false,
        code: bound.replayed ? "replayed" : "bound",
        text: bound.replayed
          ? `workflow ${workflowId} already recorded this bind as operation ${bound.operationId}: session ${bound.data.sessionId} is still its coordinator in store epoch ${bound.epoch}; nothing was written.`
          : `workflow ${workflowId} is bound to coordinator session ${bound.data.sessionId} in store epoch ${bound.epoch} (operation ${bound.operationId}). This binding is one-shot; recovery is the only transition that replaces a recorded holder.`,
        details: {
          workflowId,
          sessionId: bound.data.sessionId,
          role: "coordinator",
          harnessRoot,
          storeId: bound.storeId,
          epoch: bound.epoch,
          operationId: bound.operationId,
          replayed: bound.replayed,
        },
      };
    } catch (error) {
      return refuse(codeOf(error), messageOf(error), { workflowId, harnessRoot });
    }
  }

  if (route.value === "execution") {
    return refuse(
      "execution.consumer-not-ready",
      `an ACTIVE execution authority governs ${harnessRoot}, so the managed Prepare bootstrap (a session envelope plus the ` +
        `workflow snapshot) is retired and was not written. Bind through the DB form instead: ` +
        `{operation:"bind", workflowId, expected, operationId} with the workflow execution token. Nothing was written.`,
      { workflowId, harnessRoot },
    );
  }

  // The identity is the §3.1 tuple: provenance, scope and the host-derived
  // native id. The canonical root stays a separately supplied value (it is the
  // `harnessDir` the engine resolves and compares) — never an identity member.
  const identity = coordinatorIdentityOf(facts.sessionId, workflowId);
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
    // §3.3 keeps the coordinator envelope path in coordinator-owned transport:
    // this result IS the model-visible tool result, so neither the text nor the
    // details carry it. The already-public workflow and session ids identify the
    // binding; the engine recorded the envelope itself.
    return {
      ok: true,
      isError: false,
      code: "bound",
      text: `workflow ${workflowId} is bound to coordinator session ${bound.session.session_id}. This binding is one-shot and this tool is the only supported managed bootstrap route.`,
      details: {
        workflowId,
        sessionId: bound.session.session_id,
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
  // §4.3 authority discrimination BEFORE any stored-target read: while an
  // execution authority is ACTIVE the snapshot is retired as a persistence
  // route, and the host must surface THAT refusal — with the redirect to the
  // existing DB recovery verb — instead of letting the read failure fall into
  // the generic Prepare refusal below and silently masking the DB route.
  const veto = authorityRefusal(harnessRoot);
  if (veto !== undefined) return veto;
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

/**
 * The §4.3 authority veto of a JSON recovery, or `undefined` when the file
 * route still answers. An ACTIVE authority keeps the store's own code
 * (`execution.consumer-not-ready`) and adds the redirect this adapter owes the
 * caller: recovery then belongs to the existing DB recovery verb with its
 * execution token and stop attestation, never to this JSON path. A store that
 * exists and cannot be read keeps ITS own refusal code and message — masking it
 * as a Prepare refusal would hide a real store fault.
 */
function authorityRefusal(
  harnessRoot: string,
): { ok: false; code: string; message: string } | undefined {
  try {
    assertExecutionFileReadAllowed({ harnessDir: harnessRoot });
  } catch (error) {
    const code = codeOf(error);
    const message =
      code === "execution.consumer-not-ready"
        ? `${messageOf(error)} Coordinator recovery of a workflow under an ACTIVE execution authority belongs to the ` +
          `existing DB recovery verb (\`mstar session recover\`) with its execution token and stop attestation; ` +
          `this JSON Prepare path never runs against an active store.`
        : messageOf(error);
    return { ok: false, code, message };
  }
  return undefined;
}

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
 *
 * This operation has the SAME key set in both authorities, so the addressed
 * root's route decides: an ACTIVE authority answers with the DB workflow/session
 * state (its coordinator reference, lifecycle status/phase, store epoch and the
 * workflow token a recovery would CAS against), and the file route answers with
 * the unchanged Prepare view.
 */
export async function showCoordinatorRecovery(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  deps: CoordinatorRecoveryDeps = DEFAULT_RECOVERY_DEPS,
  authority: CoordinatorAuthorityDeps = DEFAULT_AUTHORITY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const shape = classifyCoordinatorForm(
    raw,
    "show-recovery",
    COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
    COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
    [],
  );
  if (!shape.ok) return shape.outcome;
  const context = coordinatorCallContext(raw, facts, COORDINATOR_SHOW_RECOVERY_INPUT_KEYS, "show-recovery");
  if (!context.ok) return context.outcome;

  const route = await routeOf(authority, context.harnessRoot);
  if (!route.ok) return route.outcome;
  if (route.value === "execution") {
    let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
    try {
      read = await authority.read({ harnessDir: context.harnessRoot, workflowId: context.workflowId });
    } catch (error) {
      return refuse(codeOf(error), messageOf(error), { workflowId: context.workflowId, harnessRoot: context.harnessRoot });
    }
    const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
    if (workflow === undefined) {
      return refuse(
        "coordination.workflow-not-found",
        `the execution authority read of workflow ${context.workflowId} returned no lifecycle; nothing about it can be reviewed.`,
        { workflowId: context.workflowId, harnessRoot: context.harnessRoot },
      );
    }
    const coordinator = workflow.coordinator;
    return {
      ok: true,
      isError: false,
      code: "recovery-state",
      text:
        `workflow ${context.workflowId} is ${workflow.state.status} at phase ${JSON.stringify(workflow.state.phase ?? null)} under store epoch ` +
        `${read.epoch}; the DB session authority records ${coordinator === null ? "no coordinator (recovery with priorSessionId null is the explicit unowned path)" : `coordinator session ${coordinator.sessionId}`}. ` +
        "This view holds no token, envelope bytes or credential path.",
      details: {
        workflowId: context.workflowId,
        harnessRoot: context.harnessRoot,
        storeId: read.storeId,
        epoch: read.epoch,
        status: workflow.state.status,
        phase: workflow.state.phase ?? null,
        coordinatorSessionId: coordinator === null ? null : coordinator.sessionId,
        coordinatorStoreId: coordinator === null ? null : coordinator.storeId,
        coordinatorEpoch: coordinator === null ? null : coordinator.epoch,
      },
    };
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

/** The fields only the active `recover` declares (the JSON form has none of them). */
const ACTIVE_RECOVER_MARKERS = ["priorSessionId", "attestation", "expected"] as const;

/**
 * `{operation:"recover"}` — replace the recorded coordinator binding with THIS
 * host session. The new identity is the host-derived native id in both
 * authorities (never a caller value); which authority answers is decided by the
 * addressed root's route, and the two forms refuse a mixed key set before any
 * IO:
 *
 * - the ACTIVE form calls the existing DB recovery verb with the workflow
 *   execution token, the explicitly named prior holder and the operator's own
 *   attestation document (projected by the engine's validator);
 * - the file form keeps the audited Prepare-only guards: the prior holder and
 *   its envelope path come from the engine's stored binding (never a caller
 *   path) and the caller must name that holder in the stop assertion. Every
 *   semantic guard stays the engine's, inside the snapshot write lock.
 */
export async function recoverCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  deps: CoordinatorRecoveryDeps = DEFAULT_RECOVERY_DEPS,
  authority: CoordinatorAuthorityDeps = DEFAULT_AUTHORITY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const shape = classifyCoordinatorForm(
    raw,
    "recover",
    COORDINATOR_RECOVER_INPUT_KEYS,
    COORDINATOR_ACTIVE_RECOVER_INPUT_KEYS,
    ACTIVE_RECOVER_MARKERS,
  );
  if (!shape.ok) return shape.outcome;
  if (shape.form === "active") return recoverActiveCoordinator(shape.request, facts, authority);

  const context = coordinatorCallContext(raw, facts, COORDINATOR_RECOVER_INPUT_KEYS, "recover");
  if (!context.ok) return context.outcome;
  const request = raw as Record<string, unknown>;
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
  if (!Array.isArray(stopped) || stopped.length === 0) {
    return refuse(
      "unauthorized",
      "stoppedSessionIds must name the recorded prior holder this recovery replaces \u2014 the host never treats an empty stop assertion as an authorization",
      { workflowId: context.workflowId },
    );
  }
  // Every entry is forwarded to the engine AND echoed by it, so each must be a
  // safe PUBLIC session id (single path component, bounded length) under the
  // one shared rule — an arbitrary string is refused here, before the engine
  // call, instead of being hashed into the audit or returned in a diagnostic.
  // The refusal is a public diagnostic itself, so it reports the rule and the
  // entry's POSITION and never repeats the rejected value.
  for (const [index, entry] of stopped.entries()) {
    try {
      assertSafeSessionId(entry, "stoppedSessionIds entry");
    } catch {
      return refuse(
        "invalid-input",
        "every stoppedSessionIds entry must be a public session id \u2014 a single safe path component " +
          "([A-Za-z0-9._-]+) of at most 128 characters; this adapter does not echo the rejected value",
        { workflowId: context.workflowId, index },
      );
    }
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
    // §3.3 keeps the coordinator envelope path in coordinator-owned transport:
    // `result.session_file` is NOT projected here — neither as tool text nor as
    // a detail — because this result is the model-visible tool result. The
    // already-public workflow/session ids and the versions describe the binding.
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
        harnessRoot: context.harnessRoot,
      },
    };
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId: context.workflowId, harnessRoot: context.harnessRoot });
  }
}

/**
 * The active `recover`: the existing DB recovery verb under the host-derived
 * coordinator identity. Everything the engine owns stays the engine's — the
 * current epoch/root revalidation, the creator/prior-holder rule, the atomic
 * revocation and the immutable receipt — and the operator's attestation is
 * forwarded untouched to `validateActivationAttestation`. This adapter adds only
 * the caller-shape refusals and the host-derived identity, and never echoes the
 * attestation body, a token or a path back to the model.
 */
async function recoverActiveCoordinator(
  request: Record<string, unknown>,
  facts: CoordinatorIdentityFacts,
  authority: CoordinatorAuthorityDeps,
): Promise<CoordinatorIdentityOutcome> {
  if (!isNonEmpty(request.workflowId)) return refuse("invalid-input", "workflowId is required");
  const workflowId = request.workflowId;

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
      "the last host-observed entry of this session is the scoped-plan PM route; that route restores an existing binding and never recovers one",
    );
  }
  if (!isNonEmpty(facts.harnessRoot)) {
    return refuse("harness-not-found", `no canonical control harness root is resolvable from ${facts.cwd}`, { cwd: facts.cwd });
  }
  const harnessRoot = facts.harnessRoot;

  // `null` is the explicit "this workflow records no coordinator at all" claim
  // (`--unowned`), and the adapter never treats a missing field as it; a
  // non-null holder is validated under the same public-session-id rule the JSON
  // stop assertion uses, without echoing the rejected value.
  const prior = request.priorSessionId;
  if (prior !== null && !isNonEmpty(prior)) {
    return refuse(
      "invalid-input",
      "priorSessionId must name the recorded holder this recovery replaces, or be null only when the workflow records no coordinator at all \u2014 an absent or empty holder is never guessed",
      { workflowId },
    );
  }
  if (prior !== null) {
    try {
      assertSafeSessionId(prior, "priorSessionId");
    } catch {
      return refuse(
        "invalid-input",
        "priorSessionId must be a public session id \u2014 a single safe path component ([A-Za-z0-9._-]+) of at most 128 " +
          "characters; this adapter does not echo the rejected value",
        { workflowId },
      );
    }
  }
  for (const [field, value] of [
    ["expected", request.expected],
    ["operationId", request.operationId],
    ["reason", request.reason],
  ] as const) {
    if (!isNonEmpty(value)) return refuse("invalid-input", `${field} is required for the active coordinator recovery`);
  }
  if (!isPlainObject(request.attestation)) {
    return refuse(
      "unauthorized",
      "attestation must be the operator's own ActivationAttestation document \u2014 this adapter never manufactures or defaults one",
      { workflowId },
    );
  }

  const route = await routeOf(authority, harnessRoot);
  if (!route.ok) return route.outcome;
  if (route.value !== "execution") {
    return refuse(
      "execution.not-active",
      `the control root ${harnessRoot} carries no ACTIVE execution authority (its read route is "${route.value}"), so no DB session can be recovered there. The active form never falls back to the JSON recovery: activate the execution authority, or use the file route deliberately.`,
      { workflowId, harnessRoot },
    );
  }

  const identity = coordinatorIdentityOf(facts.sessionId, workflowId);
  try {
    validateExecutionIdentity(identity, { workflowId, role: "coordinator", planId: null });
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId });
  }
  try {
    const result = await authority.recover({
      harnessDir: harnessRoot,
      identity,
      expected: request.expected as ExecutionToken,
      operationId: request.operationId,
      priorSessionId: prior,
      reason: request.reason,
      attestation: request.attestation,
    });
    return {
      ok: true,
      isError: false,
      code: result.replayed ? "replayed" : "recovered",
      text: result.replayed
        ? `workflow ${workflowId} already recorded this recovery as operation ${result.operationId}: session ${result.data.sessionId} is still its coordinator in store epoch ${result.epoch}; nothing was written.`
        : `workflow ${workflowId} now has coordinator session ${result.data.sessionId} (was ${prior ?? "no recorded holder"}) in store epoch ${result.epoch}, audited as operation ${result.operationId}. The prior holder's execution session is revoked; its history stays readable without authorizing anything.`,
      details: {
        workflowId,
        priorSessionId: prior,
        sessionId: result.data.sessionId,
        operationId: result.operationId,
        replayed: result.replayed,
        storeId: result.storeId,
        epoch: result.epoch,
        harnessRoot,
      },
    };
  } catch (error) {
    return refuse(codeOf(error), messageOf(error), { workflowId, harnessRoot });
  }
}

/** The CLI's own program spellings (`packages/cli` bin map), keyed by word. */
const CLI_PROGRAMS: Record<string, true> = { mstar: true, "mstar-harness": true };
/** A leading `NAME=value` word a shell may put before the program. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The words of every simple command in one shell line, in order. Bounded by
 * design: quoting, escaping, comments and the command separators are handled;
 * substitutions, redirections and control flow are not interpreted.
 */
function shellCommandWords(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  const endWord = (): void => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "'" || char === '"') {
      // A quoted span is one word's data: its closing quote is the next one of
      // the same kind, and its content is never read as an argument word.
      const close = command.indexOf(char, index + 1);
      word += close === -1 ? command.slice(index + 1) : command.slice(index + 1, close);
      started = true;
      index = close === -1 ? command.length : close + 1;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      word += command[index + 1];
      started = true;
      index += 2;
      continue;
    }
    if (char === "#" && !started) {
      // A `#` at a word boundary starts a comment: the rest of the line holds
      // no words at all.
      const eol = command.indexOf("\n", index);
      index = eol === -1 ? command.length : eol;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      index += 1;
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "\n") {
      endCommand();
      index += 1;
      continue;
    }
    word += char;
    started = true;
    index += 1;
  }
  endCommand();
  return commands;
}

/**
 * The managed coordinator bind, classified from the shell command that is
 * actually run: the `mstar plan bind` subcommand carrying `--coordinator` as one
 * of its own argument words.
 *
 * This is intentionally not a shell parser and fences no arbitrary native code.
 * It reads the line as shell *words* — quoted spans, `#` comments and escapes
 * are data, not structure — and separates the simple commands the line joins
 * (`;`, `&`, `|`, newline), so a bind is recognized by the command it runs
 * rather than by tokens that merely occur somewhere in the string. A command
 * that only mentions these words (an `echo` argument, a commit message, a
 * generated doc line, a comment) is left untouched, which is what §3.2 requires.
 *
 * simplify: bounded to the CLI's own two program spellings and one command
 * shape. A bind spelled through an unrecognized wrapper (`npx`, a shell alias,
 * a program path) is not redirected — the shell route carries no authority
 * anyway, so that is a UX gap, not a security one. Widen only if a real
 * transport appears.
 */
function isManagedCoordinatorBind(command: string): boolean {
  for (const words of shellCommandWords(command)) {
    let program = 0;
    while (program < words.length && ENV_ASSIGNMENT_RE.test(words[program]!)) program += 1;
    if (CLI_PROGRAMS[words[program] ?? ""] !== true) continue;
    // The subcommand pair, then `--coordinator` somewhere among its arguments.
    if (words[program + 1] !== "plan" || words[program + 2] !== "bind") continue;
    if (words.slice(program + 3).includes("--coordinator")) return true;
  }
  return false;
}

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
  if (!isManagedCoordinatorBind(event.input.command)) return undefined;
  return {
    block: true,
    reason:
      "a managed coordinator bind is not performed through the shell. Call the host-owned `mstar_coordinator` tool with " +
      '{operation:"bind", workflowId} instead \u2014 it derives the native session id and the canonical control root. A ' +
      "`plan bind --coordinator` through `bash` no longer carries an authorized identity.",
  };
}
