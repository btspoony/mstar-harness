/**
 * `mstar_coordinator` — the one host-owned coordinator-identity entry
 * (prerequisite contract §3.2).
 *
 * This adapter is deliberately thin and deliberately negative. A `bind` call
 * carries the operation and the explicitly named workflow — plus, on an ACTIVE
 * route only, the optional `expected`/`operationId` CAS values the engine
 * re-checks. The native session id comes from `ctx.sessionManager`, the
 * canonical control-harness root is derived from the host cwd, and the caller
 * cannot supply a session id, root, role, authority flag or credential path —
 * an input that tries is refused before anything is read or written, and every
 * unusable field of one call is named in ONE refusal.
 *
 * `extensions/model-handoff.ts` registers the tool; the same adapter also
 * classifies the shell transport, so a managed coordinator bind attempted
 * through `bash` is refused with a redirect to this tool instead of being
 * silently authorized by an injected environment variable.
 *
 * ## One ordinary shape; the addressed root decides the authority (§6, phase 2b)
 *
 * The control root this call addresses decides WHICH authority answers, and the
 * caller never selects one. An ordinary call carries only the operation and the
 * explicitly named workflow, and works on both routes:
 *
 * - `bind {workflowId}` under an ACTIVE execution authority
 *   (`resolveExecutionReadRoute` → `execution`) reads the workflow's current
 *   execution token from that authority and mints an engine-safe operation id,
 *   so no caller ever has to discover/read/copy a token first; explicit
 *   `expected`/`operationId` values are still honored and re-checked by the
 *   engine. The pre-activation file route answers the same shape with the
 *   unchanged managed Prepare bootstrap.
 * - `recover` keeps the two authority-specific proofs: the ACTIVE form calls the
 *   existing DB recovery verb with `priorSessionId`, `reason` and the operator's
 *   own `ActivationAttestation` document (its token and operation id are
 *   derived exactly like the bind's), while the pre-activation file route keeps
 *   the audited `authorizationRef`/`stoppedSessionIds` JSON recovery, unchanged.
 *
 * A field the answering authority cannot honor refuses by name — an active CAS
 * field on a file root, a JSON stop proof on an ACTIVE root — so a fallback
 * authority is never selected on the caller's behalf, and every unusable field
 * of one call is reported in a single aggregated refusal.
 *
 * Every engine-sourced refusal carries the engine's own code, message and
 * COMPLETE structured details, plus the URL of the module the host actually
 * loaded: an incompatible loaded build is diagnosed from what is running, never
 * from installed-plugin inventory.
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
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** The host-owned tool name (the only advertised managed bootstrap route). */
export const COORDINATOR_TOOL_NAME = "mstar_coordinator";

/**
 * The ordinary `bind` input: the operation, the explicitly named workflow and —
 * never required — the caller's own CAS values. Under an ACTIVE authority the
 * adapter derives a missing `expected` from the addressed authority itself and
 * mints a missing `operationId`, so an ordinary call needs no discover/read/copy
 * ladder; supplied values are forwarded verbatim and re-checked by the engine.
 */
export type CoordinatorBindRequest = Readonly<{
  operation: "bind";
  workflowId: string;
  /** Full `exec-v1:workflow:…` token of the addressed workflow, re-checked by the engine. */
  expected?: string;
  /** Operation id: an identical retry is a replay, a different request refuses. */
  operationId?: string;
}>;

/**
 * The only keys `bind` accepts, on either route; anything else is refused by
 * name. `expected`/`operationId` are ACTIVE-authority CAS values and are
 * refused on a pre-activation root instead of being silently ignored.
 */
export const COORDINATOR_BIND_INPUT_KEYS = ["operation", "workflowId", "expected", "operationId"] as const;

/** The read-only recovery view input: the same two caller-chosen fields as `bind`. */
export type CoordinatorShowRecoveryRequest = Readonly<{ operation: "show-recovery"; workflowId: string }>;

/**
 * The `recover` input (prerequisite contract §3.3): the workflow, the audited
 * operation fields (operation id, reason, authorization reference) and the
 * operator's own stop proof. Deliberately absent: any session id for the NEW
 * identity (host-derived), the prior holder's session id or envelope path
 * (resolved from the stored binding, never accepted from the caller), any
 * observed digest of the snapshot or compass, a root, a role and any force
 * flag.
 */
export type CoordinatorRecoverRequest = Readonly<{
  operation: "recover";
  workflowId: string;
  operationId: string;
  reason: string;
  authorizationRef: string;
  stoppedSessionIds: readonly string[];
}>;

/** The only keys `show-recovery` accepts. */
export const COORDINATOR_SHOW_RECOVERY_INPUT_KEYS = ["operation", "workflowId"] as const;

/** The only keys `recover` accepts — the audited operation fields, nothing else. */
export const COORDINATOR_RECOVER_INPUT_KEYS = [
  "operation",
  "workflowId",
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
  /** Full `exec-v1:workflow:…` token; derived from the addressed authority when omitted. */
  expected?: string;
  /** Operation id; a fresh host-minted id when omitted. */
  operationId?: string;
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

/** The fields only the ACTIVE `recover` declares (the JSON form has none of them). */
const ACTIVE_RECOVER_MARKERS = ["priorSessionId", "attestation"] as const;

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

/**
 * The provenance a refusal carries about the adapter the host ACTUALLY loaded:
 * the URL of the module this outcome was produced from, as the running module
 * itself reports it. It is never inferred from installed-plugin inventory and
 * never read from disk metadata that merely claims to describe a cached closure
 * — the one thing a caller must be able to check when a loaded build refuses a
 * store its repository sources already know how to read.
 */
export const LOADED_ENTRY: string = import.meta.url;

/** The engine's own structured diagnostic record, or `{}` when it carries none. */
function engineDetailsOf(error: unknown): Record<string, unknown> {
  const details = (error as { details?: unknown } | null)?.details;
  return isPlainObject(details) ? { ...details } : {};
}

/**
 * One refusal for a thrown engine error: the engine's own code, message and
 * COMPLETE structured details travel with it unchanged, and the loaded entry
 * names the module that answered. Nothing is rewritten, summarized or replaced
 * with generic text — the structured facts (a schema refusal's applied and
 * supported bounds, an ownership refusal's recorded holder and its recovery
 * problem) are the caller's evidence.
 */
function refusalOf(error: unknown, facts: Record<string, unknown> = {}): CoordinatorIdentityOutcome {
  return refuse(codeOf(error), messageOf(error), {
    ...engineDetailsOf(error),
    ...facts,
    loadedEntry: LOADED_ENTRY,
  });
}

/**
 * The supported recovery for a store the LOADED build cannot read, stated on
 * the refusal itself. The advice distinguishes the three things callers conflate:
 * loading a refreshed extension registration (a NEW host process/session, never
 * this running one), the session identity a new process acquires (its own — it
 * does not inherit an existing coordinator binding), and the supported recovery
 * of an existing holder (the prior holder named with its stop attestation).
 * The engine's own facts stay first; this is additive routing guidance only.
 */
const INCOMPATIBLE_LOADED_ENGINE_CODES: Record<string, true> = {
  "store.schema-unsupported": true,
  "store.schema-drift": true,
};
const INCOMPATIBLE_LOADED_ENGINE_RECOVERY =
  "The loaded entry below is the build that answered, and this process keeps the extension registration it already " +
  "loaded: refreshing repository sources changes nothing here. Refresh the installed @mstar-harness/omp package to a " +
  "build that reads this store schema, then start a NEW host process/session so the registration is loaded from it — " +
  "that new session acquires its own native identity and never inherits an existing coordinator binding, so an existing " +
  "holder is replaced only through the supported recovery naming the prior holder with its stop attestation. Where an " +
  "independently acquired session identity is acceptable, the public MCP coordinator route serves the same operations " +
  "from the refreshed CLI.";

/** The refusal for one thrown engine error, with incompatible-loaded-build recovery added. */
function engineRefusal(error: unknown, facts: Record<string, unknown> = {}): CoordinatorIdentityOutcome {
  const outcome = refusalOf(error, facts);
  if (INCOMPATIBLE_LOADED_ENGINE_CODES[outcome.code] !== true) return outcome;
  return { ...outcome, text: `${outcome.text} ${INCOMPATIBLE_LOADED_ENGINE_RECOVERY}` };
}

/** The §3.1 host identity of one coordinator call: provenance, scope, native id. */
function coordinatorIdentityOf(sessionId: string, workflowId: string): ExecutionIdentity {
  return { source: "host", sessionId, workflowId, role: "coordinator" };
}

/** The §5 route of one control root, or the root's own refusal (never masked). */
async function routeOf(
  authority: CoordinatorAuthorityDeps,
  harnessRoot: string,
): Promise<{ ok: true; value: "execution" | "files" } | { ok: false; outcome: CoordinatorIdentityOutcome }> {
  try {
    return { ok: true, value: await authority.route({ harnessDir: harnessRoot }) };
  } catch (error) {
    return { ok: false, outcome: engineRefusal(error, { harnessRoot }) };
  }
}

/**
 * The shape contract of one coordinator call: the keys the addressed form
 * accepts, the keys it requires and the supplied values its contract cannot
 * use. One call is answered with ONE verdict listing every unusable field of
 * every class — an extra key, a missing key and a malformed value are reported
 * together — because a caller that repairs one field per round trip pays a new
 * call per defect. Only field NAMES are reported: a rejected session id,
 * credential path or attestation body is never echoed, and producing this
 * verdict never probes an authority.
 */
type CoordinatorShapeContract = Readonly<{
  /** Diagnostics label of the addressed form, or `null` for a single-form call. */
  form: string | null;
  /** Keys the form accepts; every other supplied key is `forbidden`. */
  keys: readonly string[];
  /** Keys the call must carry; an absent one is `missing`. */
  required: readonly string[];
  /** Required keys whose supplied value must be a non-empty string. */
  nonEmpty: readonly string[];
  /** Optional keys whose SUPPLIED value (never an omitted one) must be a non-empty string. */
  optionalNonEmpty: readonly string[];
  /** Supplied keys a richer contract of this form already judged unusable, by name. */
  invalid: readonly string[];
  /** The operator's own authorization/proof document is absent or unusable. */
  unproven: boolean;
  /** Why that document is required, for the `unauthorized` verdict. */
  unprovenVerdict: string;
}>;

/** One aggregated refusal for every unusable field of one call, or `undefined` when the shape is usable. */
function shapeRefusalOf(
  raw: Record<string, unknown>,
  operation: string,
  contract: CoordinatorShapeContract,
): CoordinatorIdentityOutcome | undefined {
  const supplied = Object.keys(raw);
  const forbidden = supplied.filter((key) => !contract.keys.includes(key));
  const missing = contract.required.filter((key) => !supplied.includes(key));
  const invalid = [
    ...contract.invalid,
    ...contract.nonEmpty.filter((key) => supplied.includes(key) && !isNonEmpty(raw[key])),
    ...contract.optionalNonEmpty.filter((key) => raw[key] !== undefined && !isNonEmpty(raw[key])),
  ].filter((key, index, all) => all.indexOf(key) === index);
  if (forbidden.length === 0 && missing.length === 0 && invalid.length === 0 && !contract.unproven) return undefined;
  const label = contract.form === null ? operation : `${operation} ${contract.form}`;
  const verdicts = [
    ...(forbidden.length > 0 ? [`refused ${forbidden.join(", ")}`] : []),
    ...(missing.length > 0 ? [`requires ${missing.join(", ")}`] : []),
    ...(invalid.length > 0 ? [`cannot use ${invalid.join(", ")}`] : []),
    ...(contract.unproven ? [contract.unprovenVerdict] : []),
  ];
  return refuse(
    forbidden.length > 0 ? "forbidden-field" : contract.unproven ? "unauthorized" : "invalid-input",
    `the coordinator ${label} accepts only ${contract.keys.join(", ")} \u2014 ${verdicts.join("; ")}; a session id, root, ` +
      "caller role, authority flag or credential path is never accepted from the caller",
    {
      ...(contract.form === null ? {} : { form: contract.form }),
      forbidden,
      missing,
      fields: invalid,
    },
  );
}

/**
 * The shape of an operation with ONE caller form on every route (`bind`,
 * `show-recovery`): the exact key set, the keys it requires and the optional
 * CAS values it honors when supplied. Every unusable field is reported in one
 * aggregated refusal, by name, before any authority is probed.
 */
function classifyCoordinatorCall(
  raw: unknown,
  operation: "bind" | "show-recovery",
  keys: readonly string[],
  required: readonly string[],
  optionalNonEmpty: readonly string[] = [],
): { ok: true; request: Record<string, unknown> } | { ok: false; outcome: CoordinatorIdentityOutcome } {
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
  const refusal = shapeRefusalOf(raw, operation, {
    form: null,
    keys,
    required,
    nonEmpty: required.filter((key) => key !== "operation"),
    optionalNonEmpty,
    invalid: [],
    unproven: false,
    unprovenVerdict: "",
  });
  if (refusal !== undefined) return { ok: false, outcome: refusal };
  return { ok: true, request: raw };
}

/**
 * The supplied public-session-id values that violate the one shared rule (a
 * single safe path component of bounded length), labelled by FIELD NAME or by
 * position inside a list — never by value. Every such value is forwarded to the
 * engine AND echoed by its audit, so the rule is applied here first; the
 * refusal is itself a public diagnostic and never repeats the rejected value.
 */
function unsafeSessionIdSubjects(
  candidates: readonly Readonly<{ subject: string; value: unknown }>[],
): string[] {
  return candidates.flatMap(({ subject, value }) => {
    try {
      assertSafeSessionId(value, subject);
      return [];
    } catch {
      return [subject];
    }
  });
}

/**
 * Which of the two authority-selected recovery forms one call declares, from its
 * own key set alone, and every unusable field of that form. The active form is
 * the one carrying a marker field the JSON form does not have; the form's key
 * set must then match EXACTLY beyond the keys the ACTIVE route derives, so a
 * mixed or partial call is refused by name instead of silently selecting an
 * authority. Both forms report their whole verdict in one refusal: an empty or
 * absent stop assertion and an unusable attestation each keep the explicit
 * `unauthorized` verdict — a missing proof is not a malformed field.
 */
function classifyCoordinatorRecover(
  raw: unknown,
): { ok: true; form: "json" | "active"; request: Record<string, unknown> } | { ok: false; outcome: CoordinatorIdentityOutcome } {
  if (!isPlainObject(raw)) {
    return { ok: false, outcome: refuse("invalid-input", "the coordinator recover input must be an object") };
  }
  if (raw.operation !== "recover") {
    return {
      ok: false,
      outcome: refuse("unknown-operation", `this is the coordinator recover path; got ${JSON.stringify(raw.operation)}`, {
        operation: raw.operation,
      }),
    };
  }
  const keys = Object.keys(raw);
  const form = ACTIVE_RECOVER_MARKERS.some((marker) => keys.includes(marker)) ? "active" : "json";
  const stopped = raw.stoppedSessionIds;
  const contract: CoordinatorShapeContract =
    form === "active"
      ? {
          form,
          keys: COORDINATOR_ACTIVE_RECOVER_INPUT_KEYS,
          required: ["operation", "workflowId", "priorSessionId", "reason"],
          nonEmpty: ["workflowId", "reason"],
          optionalNonEmpty: ["expected", "operationId"],
          // `null` is the explicit "this workflow records no coordinator at all"
          // claim (`--unowned`) and is never treated as a missing field or an
          // unusable id; every other supplied holder — including an own
          // `undefined` key — honors the same public-session-id rule as the stop
          // list, without echoing the rejected value.
          invalid:
            raw.priorSessionId === null
              ? []
              : unsafeSessionIdSubjects([{ subject: "priorSessionId", value: raw.priorSessionId }]),
          unproven: !isPlainObject(raw.attestation),
          unprovenVerdict:
            "attestation must be the operator's own ActivationAttestation document, forwarded to the engine's own validator \u2014 this adapter never manufactures or defaults one",
        }
      : {
          form,
          keys: COORDINATOR_RECOVER_INPUT_KEYS,
          required: ["operation", "workflowId", "operationId", "reason", "authorizationRef"],
          nonEmpty: ["workflowId", "operationId", "reason", "authorizationRef"],
          optionalNonEmpty: [],
          invalid: Array.isArray(stopped)
            ? unsafeSessionIdSubjects(stopped.map((value, index) => ({ subject: `stoppedSessionIds[${index}]`, value })))
            : [],
          unproven: !Array.isArray(stopped) || stopped.length === 0,
          unprovenVerdict:
            "stoppedSessionIds must name the recorded prior holder this recovery replaces \u2014 the host never treats an empty stop assertion as an authorization",
        };
  const refusal = shapeRefusalOf(raw, "recover", contract);
  if (refusal !== undefined) return { ok: false, outcome: refusal };
  return { ok: true, form, request: raw };
}

/**
 * The host-derived facts every coordinator operation needs before any authority
 * IO: a native session id, a non-leaf seat and a resolvable control root. The
 * caller's own shape is already settled by the classifiers above, so this gate
 * reports host facts only, in one shared order.
 */
function coordinatorHostFacts(
  facts: CoordinatorIdentityFacts,
): { ok: true; harnessRoot: string } | { ok: false; outcome: CoordinatorIdentityOutcome } {
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
  if (!isNonEmpty(facts.harnessRoot)) {
    return {
      ok: false,
      outcome: refuse("harness-not-found", `no canonical control harness root is resolvable from ${facts.cwd}`, { cwd: facts.cwd }),
    };
  }
  return { ok: true, harnessRoot: facts.harnessRoot };
}

/**
 * The engine-safe defaults of an ACTIVE call's two CAS controls, derived so an
 * ordinary call carries only the operation and the workflow:
 *
 * - `expected` is the workflow's CURRENT execution token, read from the very
 *   authority the call addresses — never a caller-invented or cached value, and
 *   re-checked by the engine inside its own write transaction;
 * - `operationId` is a fresh host-minted id when the caller names none, so a
 *   repeated call is a second attempt the engine's own holder guard answers
 *   truthfully instead of a replay nobody asked for. A caller-supplied id is
 *   forwarded verbatim and makes an identical retry the replay.
 */
async function activeControlsOf(
  authority: CoordinatorAuthorityDeps,
  harnessRoot: string,
  workflowId: string,
  request: Record<string, unknown>,
): Promise<{ ok: true; expected: string; operationId: string } | { ok: false; outcome: CoordinatorIdentityOutcome }> {
  // A supplied token is forwarded verbatim — the shared shape gate already
  // refused an empty one — and is re-checked by the engine inside its own write
  // transaction, which is what makes a stale value a real refusal instead of a
  // value this adapter could have masked.
  let expected = request.expected as string | undefined;
  if (expected === undefined) {
    let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
    try {
      read = await authority.read({ harnessDir: harnessRoot, workflowId });
    } catch (error) {
      return { ok: false, outcome: engineRefusal(error, { workflowId, harnessRoot }) };
    }
    // The engine requires the exact workflow token; a read that returned without
    // one cannot be turned into a CAS value here.
    if (!isNonEmpty(read.token)) {
      return {
        ok: false,
        outcome: refuse(
          "execution.token-unavailable",
          `the execution authority read of workflow ${workflowId} returned no workflow token, so no CAS value can be derived; supply \`expected\` explicitly`,
          { workflowId, harnessRoot },
        ),
      };
    }
    expected = read.token;
  }
  const supplied = request.operationId;
  return { ok: true, expected, operationId: isNonEmpty(supplied) ? supplied : `coordinator-bind-${randomUUID()}` };
}

/**
 * The ACTIVE arm of a bind: the DB session API records the binding under the
 * host-derived identity, with the CAS controls derived when the caller omits
 * them. A supplied-but-unusable control is already answered by the shared shape
 * gate, before any authority is probed.
 */
async function bindActiveCoordinator(
  request: Record<string, unknown>,
  facts: CoordinatorIdentityFacts,
  workflowId: string,
  harnessRoot: string,
  authority: CoordinatorAuthorityDeps,
): Promise<CoordinatorIdentityOutcome> {
  const identity = coordinatorIdentityOf(facts.sessionId, workflowId);
  try {
    validateExecutionIdentity(identity, { workflowId, role: "coordinator" });
  } catch (error) {
    return refusalOf(error, { workflowId });
  }
  const controls = await activeControlsOf(authority, harnessRoot, workflowId, request);
  if (!controls.ok) return controls.outcome;
  try {
    const bound = await authority.bind({
      harnessDir: harnessRoot,
      identity,
      workflowId,
      expected: controls.expected as ExecutionToken,
      operationId: controls.operationId,
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
    return engineRefusal(error, { workflowId, harnessRoot });
  }
}

/**
 * Derive the adapter input from host facts and bind one coordinator identity.
 *
 * The caller shape is ONE ordinary form — the operation and the explicitly named
 * workflow, with optional ACTIVE CAS values — and the addressed root's route
 * decides which authority answers. Refusal order is deliberate: the caller's
 * key set first (an extra field is never partially honored), then the
 * host-derived facts, then the route, then the ACTIVE identity validation, then
 * the engine verb — which re-checks creation identity, root membership,
 * registration commit and duplicate holders.
 */
export async function bindCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  bind: CoordinatorBindFn = (input) => bindPlanSession(input),
  authority: CoordinatorAuthorityDeps = DEFAULT_AUTHORITY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const shape = classifyCoordinatorCall(raw, "bind", COORDINATOR_BIND_INPUT_KEYS, ["operation", "workflowId"], [
    "expected",
    "operationId",
  ]);
  if (!shape.ok) return shape.outcome;
  const workflowId = shape.request.workflowId as string;

  const host = coordinatorHostFacts(facts);
  if (!host.ok) return host.outcome;
  const harnessRoot = host.harnessRoot;

  // §5/§6: the root decides which authority answers, before any engine verb.
  const route = await routeOf(authority, harnessRoot);
  if (!route.ok) return route.outcome;
  if (route.value === "execution") {
    return bindActiveCoordinator(shape.request, facts, workflowId, harnessRoot, authority);
  }

  // A pre-activation root answers through the Prepare bootstrap, whose bind has
  // no CAS value and no operation id: a call carrying the ACTIVE controls
  // asserts an authority this root does not carry and is refused, never
  // partially honored.
  const carried = (["expected", "operationId"] as const).filter((field) => shape.request[field] !== undefined);
  if (carried.length > 0) {
    return refuse(
      "execution.not-active",
      `the control root ${harnessRoot} carries no ACTIVE execution authority (its read route is "${route.value}"), so the ` +
        `CAS values ${carried.join(", ")} address no store there. The file route's managed bootstrap takes only the ` +
        `operation and the workflow: retry without them, or activate the execution authority deliberately.`,
      { workflowId, harnessRoot, fields: carried },
    );
  }

  // The identity is the §3.1 tuple: provenance, scope and the host-derived
  // native id. The canonical root stays a separately supplied value (it is the
  // `harnessDir` the engine resolves and compares) — never an identity member.
  const identity = coordinatorIdentityOf(facts.sessionId, workflowId);
  try {
    validateExecutionIdentity(identity, { workflowId, role: "coordinator" });
  } catch (error) {
    return refusalOf(error, { workflowId });
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
    return engineRefusal(error, { workflowId, harnessRoot });
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

/**
 * `{operation:"show-recovery"}` — the read-only recovery view of one workflow
 * (prerequisite contract §3.3): the recorded owner, the observed snapshot and
 * compass digests (provenance only, they neither admit nor reject a recovery)
 * and the Prepare verdict, with no envelope bytes, credential or path. The
 * caller uses it to review before recovering; it writes nothing.
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
  const shape = classifyCoordinatorCall(
    raw,
    "show-recovery",
    COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
    COORDINATOR_SHOW_RECOVERY_INPUT_KEYS,
  );
  if (!shape.ok) return shape.outcome;
  const host = coordinatorHostFacts(facts);
  if (!host.ok) return host.outcome;
  const workflowId = shape.request.workflowId as string;
  const harnessRoot = host.harnessRoot;

  const route = await routeOf(authority, harnessRoot);
  if (!route.ok) return route.outcome;
  if (route.value === "execution") {
    let read: ExecutionRead<ExecutionState | ExecutionPlanView>;
    try {
      read = await authority.read({ harnessDir: harnessRoot, workflowId });
    } catch (error) {
      return engineRefusal(error, { workflowId, harnessRoot });
    }
    const workflow = "workflows" in read.data ? read.data.workflows[0] : undefined;
    if (workflow === undefined) {
      return refuse(
        "coordination.workflow-not-found",
        `the execution authority read of workflow ${workflowId} returned no lifecycle; nothing about it can be reviewed.`,
        { workflowId, harnessRoot },
      );
    }
    const coordinator = workflow.coordinator;
    return {
      ok: true,
      isError: false,
      code: "recovery-state",
      text:
        `workflow ${workflowId} is ${workflow.state.status} at phase ${JSON.stringify(workflow.state.phase ?? null)} under store epoch ` +
        `${read.epoch}; the DB session authority records ${coordinator === null ? "no coordinator (recovery with priorSessionId null is the explicit unowned path)" : `coordinator session ${coordinator.sessionId}`}. ` +
        "This view holds no token, envelope bytes or credential path.",
      details: {
        workflowId,
        harnessRoot,
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
    const view = await deps.show({ cwd: facts.cwd, harnessDir: harnessRoot, workflowId });
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
        harnessRoot,
      },
    };
  } catch (error) {
    return engineRefusal(error, { workflowId, harnessRoot });
  }
}

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
 * The caller shape is settled FIRST, in one aggregated refusal: the addressed
 * form's key set (an extra key is never partially honored), the keys it
 * requires, the values their contract cannot use (including the POSITION of a
 * stop-assertion entry that is not a public session id) and the separate
 * `unauthorized` verdict of a missing operator proof. Only then do the
 * host-derived facts, the route, the identity validation and the engine verb
 * run — and the engine re-checks every semantic guard inside its own
 * transaction.
 */
export async function recoverCoordinatorIdentity(
  raw: unknown,
  facts: CoordinatorIdentityFacts,
  deps: CoordinatorRecoveryDeps = DEFAULT_RECOVERY_DEPS,
  authority: CoordinatorAuthorityDeps = DEFAULT_AUTHORITY_DEPS,
): Promise<CoordinatorIdentityOutcome> {
  const shape = classifyCoordinatorRecover(raw);
  if (!shape.ok) return shape.outcome;
  const host = coordinatorHostFacts(facts);
  if (!host.ok) return host.outcome;
  const harnessRoot = host.harnessRoot;
  if (shape.form === "active") return recoverActiveCoordinator(shape.request, facts, harnessRoot, authority);

  const request = shape.request;
  const workflowId = request.workflowId as string;
  // Every entry is forwarded to the engine AND echoed by its audit, so the one
  // shared public-session-id rule was applied by the classifier above: an
  // arbitrary string never reaches the request digest or the audit record.
  const stoppedSessionIds = request.stoppedSessionIds as readonly string[];

  const resolved = deps.target({ harnessRoot, workflowId });
  if (!resolved.ok) return refuse(resolved.code, resolved.message, { workflowId });
  const { priorSessionPath, priorSessionId } = resolved.target;
  // The stop assertion is forwarded EXACTLY as the caller stated it: whether it
  // names the recorded holder is the engine's guard, checked against the
  // binding it reads inside the snapshot lock (which is also what makes an
  // exact retry of an accepted recovery recognizable).

  const identity: ExecutionIdentity = {
    source: "host",
    sessionId: facts.sessionId,
    workflowId,
    role: "coordinator",
  };
  try {
    validateExecutionIdentity(identity, { workflowId, role: "coordinator" });
  } catch (error) {
    return refusalOf(error, { workflowId });
  }
  try {
    const result = await deps.recover({
      cwd: facts.cwd,
      harnessDir: harnessRoot,
      identity,
      priorSessionPath,
      priorSessionId,
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
        harnessRoot,
      },
    };
  } catch (error) {
    return engineRefusal(error, { workflowId, harnessRoot });
  }
}

/**
 * The active `recover`: the existing DB recovery verb under the host-derived
 * coordinator identity. Everything the engine owns stays the engine's — the
 * current epoch/root revalidation, the creator/prior-holder rule, the atomic
 * revocation and the immutable receipt — and the operator's attestation is
 * forwarded untouched to `validateActivationAttestation`. This adapter adds only
 * the caller-shape refusals (already aggregated by the shared classifier, which
 * validates the holder under the same public-session-id rule the JSON stop
 * assertion uses and keeps the missing attestation an `unauthorized` verdict)
 * and the host-derived identity. It derives the two CAS controls exactly like
 * the bind and never echoes the attestation body, a token or a path back to the
 * model.
 */
async function recoverActiveCoordinator(
  request: Record<string, unknown>,
  facts: CoordinatorIdentityFacts,
  harnessRoot: string,
  authority: CoordinatorAuthorityDeps,
): Promise<CoordinatorIdentityOutcome> {
  const workflowId = request.workflowId as string;
  const prior = request.priorSessionId as string | null;
  // The authorization document is forwarded UNTOUCHED: the classifier already
  // refused an absent or non-object attestation as `unauthorized`, and the
  // engine's own `validateActivationAttestation` projects the declared shape.

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
    validateExecutionIdentity(identity, { workflowId, role: "coordinator" });
  } catch (error) {
    return refusalOf(error, { workflowId });
  }
  const controls = await activeControlsOf(authority, harnessRoot, workflowId, request);
  if (!controls.ok) return controls.outcome;
  try {
    const result = await authority.recover({
      harnessDir: harnessRoot,
      identity,
      expected: controls.expected as ExecutionToken,
      operationId: controls.operationId,
      priorSessionId: prior,
      reason: request.reason as string,
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
    return engineRefusal(error, { workflowId, harnessRoot });
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
