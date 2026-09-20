/**
 * execution-coordination.ts — the DB transport of the plan coordination
 * operations (primary spec §2.3/§3/§4.1).
 *
 * One accepted plan operation is ONE transaction. `withExecutionPlanAuthority`
 * owns that transaction, the shared role/scope gates and the sealed witness
 * every DB plan verb starts from; W2–W4 add the per-operation transitions on
 * top of it, and this module is where they land.
 *
 * Nothing here is a public surface: the package index exports no coordination
 * mutator, and `mutateExecutionPlan` is published only once its whole closed
 * operation union exists (W4).
 */
import { CoordinationError, isNonEmptyString, isPlainObject } from "./coordination-write.js";
import {
  IMPLEMENTED_OPERATIONS,
  assertOperationRole,
  assertPlanAddress,
  type CoordinationSeat,
} from "./coordination-transitions.js";
import {
  ExecutionError,
  assertExecutionToken,
  readExecutionPlanWitness,
  withExecutionTransaction,
  type ExecutionContext,
  type ExecutionPlanWitness,
  type ExecutionSessionRef,
  type ExecutionToken,
  type ExecutionTransaction,
} from "./execution-store.js";
import type { PlanCoordinationOperation } from "./coordination.js";

/**
 * §3 the DB route's verb vocabulary: exactly the existing closed coordination
 * union. One union and one role/state machine for both transports — a second
 * verb set is what the extraction exists to prevent.
 */
export type CoordinationOperation = PlanCoordinationOperation;

/**
 * §3 one DB plan operation call: the session reference the caller claims, the
 * plan it addresses with the token it read, and the operation itself. The
 * caller identity is NOT part of this request — it comes from
 * `ExecutionContext.caller`, so a role named here authorizes nothing.
 */
export type ExecutionPlanCall = {
  session: ExecutionSessionRef;
  /** The addressed plan's `exec-v1` token from the current read (the CAS). */
  expected: ExecutionToken;
  /** The plan this operation transitions. */
  planId: string;
  operation: CoordinationOperation;
};

/**
 * §2.3/§3.1/§4.1 the authorization boundary of one DB plan operation.
 *
 * The operation's kind decides which seat may issue it and a plan session
 * addresses only its own plan — the SHARED pure rules, so the DB route cannot
 * drift from the file route. Inside one `BEGIN IMMEDIATE` transaction the
 * authority must be active, the trusted caller's own session row is revalidated
 * at the current epoch, the addressed plan is selected under that authority and
 * the supplied token is compared against the plan's exact CAS token. The
 * addressed plan's sealed witness is then handed to the operation's transition,
 * which commits or rolls back with everything above.
 *
 * A forged caller/role, a sibling plan, a revoked or stale-epoch reference, a
 * stale token and a nested call all refuse with no row, revision or receipt
 * change. The transition body receives the owned transaction — the only handle
 * a DB operation may write through — and is synchronous for the same reason
 * `withExecutionTransaction` requires it: nothing awaits, launches, reads a file
 * or mutates Git between BEGIN and COMMIT (§4.1).
 */
export async function withExecutionPlanAuthority<T>(
  context: ExecutionContext,
  call: ExecutionPlanCall,
  transition: (witness: ExecutionPlanWitness, tx: ExecutionTransaction) => T,
): Promise<T> {
  const operation = call.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw new CoordinationError("coordination.invalid-input", "a plan operation needs an operation with a kind");
  }
  const kind = operation.kind;
  if (IMPLEMENTED_OPERATIONS[kind] !== true) {
    throw new CoordinationError("coordination.unknown-operation", `${kind} is not a coordination operation`, {
      operation: kind,
    });
  }
  const seat: CoordinationSeat = {
    role: context.caller.role,
    sessionId: context.caller.sessionId,
    planId: context.caller.planId,
  };
  assertOperationRole(seat, kind);
  assertPlanAddress(seat, call.planId);
  return withExecutionTransaction(context, (tx) => {
    if (tx.execution.authorityState !== "active") {
      throw new ExecutionError(
        "execution.not-active",
        `the execution authority is ${tx.execution.authorityState}; a plan operation requires an active authority. ` +
          `A staged store is inspectable only through migration diagnostics.`,
      );
    }
    const witness = readExecutionPlanWitness(tx, context.caller, call.session, call.planId);
    assertExecutionToken(call.expected, {
      kind: "plan",
      storeId: tx.storeId,
      epoch: tx.epoch,
      key: [witness.workflowId, witness.planId],
      revision: witness.revision,
    });
    return transition(witness, tx);
  });
}
