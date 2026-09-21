/**
 * Adapter-only execution identity (prerequisite contract §3.1 / phase2b
 * execution contract §3.1).
 *
 * The tuple `(source, sessionId, workflowId, role, planId)` is how one adapter
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
import { CoordinationError, isNonEmptyString, isPlainObject } from "./coordination-write.js";

/** The two coordination seats a workflow's identity can name. */
export type ExecutionIdentityRole = "coordinator" | "plan-pm";

/**
 * One acquired identity: provenance + workflow/role/plan scope + session id.
 * This is the §3.1 type SSOT the DB session task imports — not a second shape.
 */
export type ExecutionIdentity = Readonly<{
  source: "host" | "local";
  sessionId: string;
  workflowId: string;
  role: ExecutionIdentityRole;
  planId: string | null;
}>;

/** The scope an identity is validated against (the workflow/role/plan it addresses). */
export type ExecutionIdentityScope = Readonly<{
  workflowId: string;
  role: ExecutionIdentityRole;
  planId: string | null;
}>;

function isRole(value: unknown): value is ExecutionIdentityRole {
  return value === "coordinator" || value === "plan-pm";
}

function isSource(value: unknown): value is "host" | "local" {
  return value === "host" || value === "local";
}

/**
 * Validate one adapter-supplied identity against the scope it addresses.
 *
 * Refuses (never repairs) a missing/blank session id or workflow id, a missing
 * or unknown provenance source, a non-coordination role, a coordinator carrying
 * a plan scope, a plan-pm without one, and any workflow/role/plan disagreement
 * with `scope`. Canonical-root equality is the caller's explicit check, not
 * this function's: the root is not a member of the identity.
 */
export function validateExecutionIdentity(identity: ExecutionIdentity, scope: ExecutionIdentityScope): void {
  if (!isPlainObject(identity)) {
    throw new CoordinationError("coordination.identity-missing", "an execution identity tuple is required");
  }
  const value = identity as unknown as Record<string, unknown>;

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
      "the execution identity carries no workflow id",
      { workflow_id: value.workflowId },
    );
  }
  if (!isNonEmptyString(value.sessionId)) {
    throw new CoordinationError(
      "coordination.identity-missing",
      "the execution identity carries no session id \u2014 an identity is acquired explicitly and is never generated; supply a native or local id",
      { workflow_id: value.workflowId },
    );
  }
  if (!isRole(value.role)) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `the execution identity role ${JSON.stringify(value.role)} is not a coordination role`,
      { expected: "coordinator|plan-pm", actual: value.role },
    );
  }
  const role = value.role;
  const planId = value.planId;
  if (role === "coordinator" && planId !== null) {
    throw new CoordinationError("coordination.identity-mismatch", "a coordinator identity carries no plan scope", {
      role,
      plan_id: planId,
    });
  }
  if (role === "plan-pm" && !isNonEmptyString(planId)) {
    throw new CoordinationError("coordination.identity-missing", "a plan-pm identity carries a non-empty plan id", {
      role,
    });
  }
  if (value.workflowId !== scope.workflowId) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `the identity addresses workflow ${value.workflowId}, not ${scope.workflowId}`,
      { expected: scope.workflowId, actual: value.workflowId },
    );
  }
  if (role !== scope.role) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `the identity role ${role} does not address the ${scope.role} seat`,
      { expected: scope.role, actual: role },
    );
  }
  if (planId !== scope.planId) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `the identity plan ${JSON.stringify(planId)} does not address plan ${JSON.stringify(scope.planId)}`,
      { expected: scope.planId, actual: planId },
    );
  }
}
