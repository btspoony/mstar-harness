/**
 * Adapter-only execution identity (prerequisite contract §3.1 / phase2b
 * execution contract §3.1).
 *
 * The tuple `(source, sessionId, workflowId, role)` is how one adapter
 * hands an **already acquired** identity to the engine. It is never a
 * model-request field: nothing here reads the global environment, the latest
 * workflow or a path name to choose it. `source` is the adapter's provenance —
 * `host` for a native host session, `local` for an engine-created local
 * launcher or a plain local operator.
 *
 * A canonical control-harness root is **not** a member of this tuple: it is
 * supplied separately and compared at the adapter boundary — a different root
 * is an *addressing* error (a different control harness), not a malformed
 * identity.
 *
 * The whole point of this module is the negative: an identity is acquired, and
 * a missing one refuses. It never synthesizes an id and never accepts an
 * inherited environment value as authorization.
 */
import { CoordinationError, assertExactKeys, isNonEmptyString, isPlainObject } from "./coordination-write.js";
import { assertSafePathComponent } from "./path.js";

/** The sole execution identity role: a workflow coordinator. */
export type ExecutionIdentityRole = "coordinator";

/** Longest session id the identity/envelope contract accepts. */
export const SESSION_ID_MAX_LENGTH = 128;

/**
 * Validate one PUBLIC session id — the single rule every route shares. A session
 * id names the coordination envelope's file, so it must be one safe path
 * component of at most `SESSION_ID_MAX_LENGTH` characters; the same rule
 * protects the recovery stop assertion, whose entries are hashed into the
 * request digest, persisted in the immutable audit and echoed in refusals.
 *
 * Throws `coordination.invalid-session-id`; `what` names the field in the
 * message so each caller reports its own input.
 *
 * The rejected value itself is NEVER repeated: this refusal reaches public
 * diagnostics (CLI JSON, host tool results), so each branch states the rule and
 * reports a non-identifying fact instead — the received form/type, or the
 * received length — exactly as `recoveryStopList` does. `details.session_id`
 * carried the raw value once; it no longer exists in any branch.
 */
export function assertSafeSessionId(value: unknown, what = "session id"): string {
  if (!isNonEmptyString(value)) {
    throw new CoordinationError(
      "coordination.invalid-session-id",
      "Invalid public session id: provide one safe path component using [A-Za-z0-9._-], at most 128 characters. Inspect coordinator identity with mstar status validate.",
      { form: typeof value, field: what },
    );
  }
  if (value.length > SESSION_ID_MAX_LENGTH) {
    throw new CoordinationError(
      "coordination.invalid-session-id",
      "Invalid public session id: the value exceeds 128 characters and is not echoed. Inspect coordinator identity with mstar status validate.",
      { length: value.length, max_length: SESSION_ID_MAX_LENGTH, field: what },
    );
  }
  try {
    assertSafePathComponent(value, what);
  } catch {
    throw new CoordinationError(
      "coordination.invalid-session-id",
      `${what} is not a safe path component \u2014 a single safe path component ([A-Za-z0-9._-]+) of at most ` +
        `${SESSION_ID_MAX_LENGTH} characters, not "", ".", ".." or a value containing "/" or "\\"; the rejected value is not echoed in this diagnostic`,
      { length: value.length },
    );
  }
  return value;
}

/**
 * One acquired identity: provenance + workflow coordinator + session id.
 * This is the §3.1 type SSOT the DB session task imports — not a second shape.
 */
export type ExecutionIdentity = Readonly<{
  source: "host" | "local";
  sessionId: string;
  workflowId: string;
  role: "coordinator";
}>;

/** Per-call relaxations of the acquired-identity rule; default is strict. */
export type ExecutionIdentityOptions = Readonly<{
  /**
   * ACTIVE registration only: creator attribution is optional, so the empty
   * string (the normalized spelling of an unset id) is accepted and the create
   * path records a NULL `creator_session_id` that the first coordinator bind
   * adopts (§2.3). Every other consumer keeps the acquired-identity rule.
   */
  allowUnsetSessionId?: boolean;
}>;

/** Scope is workflow-wide; plans are explicit operation addresses. */
export type ExecutionIdentityScope = Readonly<{
  workflowId: string;
  role: "coordinator";
}>;

function isRole(value: unknown): value is ExecutionIdentityRole {
  return value === "coordinator";
}

function isSource(value: unknown): value is "host" | "local" {
  return value === "host" || value === "local";
}

/**
 * Validate one adapter-supplied identity against the scope it addresses.
 *
 * Refuses a missing/blank session id or workflow id, unknown provenance,
 * non-coordinator role, and workflow/role disagreement with `scope`.
 * Canonical-root equality is the caller's explicit check, not
 * this function's: the root is not a member of the identity.
 *
 * `allowUnsetSessionId` is the ACTIVE registration exception: the empty string
 * passes as "unset" and the create path records a NULL creator. A missing or
 * non-string session id refuses under every option.
 */
export function validateExecutionIdentity(
  identity: ExecutionIdentity,
  scope: ExecutionIdentityScope,
  options: ExecutionIdentityOptions = {},
): void {
  if (!isPlainObject(identity)) {
    throw new CoordinationError("coordination.identity-missing", "Invalid execution identity: provide the identity tuple. Inspect coordinator identity with mstar status validate.");
  }
  const value = identity as unknown as Record<string, unknown>;
  assertExactKeys(value, ["source", "sessionId", "workflowId", "role"], "execution identity");

  if (!isSource(value.source)) {
    // An absent provenance is identity-missing; a present but unknown value is
    // identity-mismatch. Neither is ever coerced to a default.
    const missing = value.source === undefined || value.source === null;
    throw new CoordinationError(
      missing ? "coordination.identity-missing" : "coordination.identity-mismatch",
      missing
        ? "the execution identity carries no provenance source \u2014 an adapter states `host` or `local`, and it is never inferred"
        : `the execution identity source ${JSON.stringify(value.source)} is not \`host\` or \`local\``,
      { source: value.source },
    );
  }
  if (!isNonEmptyString(value.workflowId)) {
    throw new CoordinationError(
      "coordination.identity-missing",
      "Invalid execution identity: provide a workflow id. Inspect registered workflows with mstar status validate.",
      { workflow_id: value.workflowId },
    );
  }
  if (!isNonEmptyString(value.sessionId)) {
    if (!(options.allowUnsetSessionId === true && typeof value.sessionId === "string")) {
      throw new CoordinationError(
        "coordination.identity-missing",
        "the execution identity carries no session id \u2014 an identity is acquired explicitly and is never generated; " +
          "supply a native or local id (CLI: pass --session-id or set MSTAR_HOST_SESSION_ID; MCP: the host must pass sessionId per call)",
        { workflow_id: value.workflowId },
      );
    }
  }
  if (isNonEmptyString(value.sessionId)) assertSafeSessionId(value.sessionId);
  if (!isRole(value.role)) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Invalid execution identity role; expected coordinator. Inspect the recorded identity with mstar status validate.",
      { expected: "coordinator", actual: value.role },
    );
  }
  const role = value.role;
  if (value.workflowId !== scope.workflowId) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Execution identity does not address the expected workflow. Inspect the recorded identity with mstar status validate.",
      { expected: scope.workflowId, actual: value.workflowId },
    );
  }
  if (role !== scope.role) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      "Execution identity role does not match the expected seat. Inspect the recorded identity with mstar status validate.",
      { expected: scope.role, actual: role },
    );
  }
}
