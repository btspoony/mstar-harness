/**
 * Adapter-only execution identity (prerequisite contract §3.1).
 *
 * The tuple `(canonical harness root, workflowId, role, planId, native/local
 * sessionId)` is how one adapter hands an **already acquired** identity to the
 * engine. It is never a model-request field: nothing here reads the global
 * environment, the latest workflow or a path name to choose it. A canonical
 * control-harness root is carried in the tuple and compared by the caller at
 * the adapter boundary — a different root is an *addressing* error (a different
 * control harness), not a malformed tuple, so `validateExecutionIdentity`
 * deliberately does not compare it.
 *
 * The whole point of this module is the negative: an identity is acquired, and
 * a missing one refuses. It never synthesizes an id and never accepts an
 * inherited environment value as authorization.
 */
import { CoordinationError, isNonEmptyString, isPlainObject } from "./coordination-write.js";

/** The two coordination seats a workflow's identity can name. */
export type ExecutionIdentityRole = "coordinator" | "plan-pm";

/** One acquired identity: canonical root + workflow/role/plan scope + session id. */
export type ExecutionIdentity = Readonly<{
  harnessRoot: string;
  workflowId: string;
  role: ExecutionIdentityRole;
  planId: string | null;
  sessionId: string;
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

/**
 * Validate one adapter-supplied identity against the scope it addresses.
 *
 * Refuses (never repairs) a missing/blank session id or workflow id, a missing
 * canonical root, a non-coordination role, a coordinator carrying a plan scope,
 * a plan-pm without one, and any workflow/role/plan disagreement with `scope`.
 * Canonical root equality is the caller's explicit check, not this function's.
 */
export function validateExecutionIdentity(identity: ExecutionIdentity, scope: ExecutionIdentityScope): void {
  if (!isPlainObject(identity)) {
    throw new CoordinationError("coordination.identity-missing", "an execution identity tuple is required");
  }
  const value = identity as unknown as Record<string, unknown>;

  if (!isNonEmptyString(value.harnessRoot) || !isNonEmptyString(value.workflowId)) {
    throw new CoordinationError(
      "coordination.identity-missing",
      "the execution identity carries no canonical harness root or workflow id",
      { harness_root: value.harnessRoot, workflow_id: value.workflowId },
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
