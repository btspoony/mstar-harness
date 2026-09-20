/**
 * coordination-transitions.ts — the pure domain rules of a coordinated plan,
 * separated from every transport that stores one.
 *
 * The JSON/file route (`coordination.ts`) and the DB route
 * (`execution-coordination.ts`) both run these rules here: which seat may issue
 * an operation, which plan a session may address, which operations a row
 * advertises, and whether a row's handoff or lease permits a transition. A rule
 * reads no file, no path and no store — a seat, the workflow state and the plan
 * row are the whole input — so neither transport can drift into a second
 * role/state machine.
 *
 * The transport-specific halves stay with the transport that owns them: the
 * file route keeps its `canonicalTarget` envelope comparisons, and the DB route
 * reads session and lease authority from `execution_sessions` /
 * `execution_leases` rather than from a row's `coordination.session` block
 * (primary spec §2.3).
 *
 * NOT a public surface: the package index exports none of this.
 */
import {
  CoordinationError,
  isNonEmptyString,
  isPlainObject,
  type CoordinatorBinding,
  type PlanHandoff,
  type RowCoordination,
} from "./coordination-write.js";
import { validateExecutionLease, type ExecutionLease } from "./lease.js";
import type { PlanRow } from "./status.js";
import { isStandaloneDevelopmentWorkflow, type WorkflowSnapshot } from "./workflow.js";

/* ------------------------------------------------------------------------ *
 * § Seats and the advertised operation set
 * ------------------------------------------------------------------------ */

/** Bind roles: one coordinator per lifecycle, one plan session per plan. */
export type CoordinationRole = "plan-pm" | "coordinator";

/**
 * The seat a call acts as. Both transports can state exactly these three
 * fields about their caller — the file route from its session envelope, the DB
 * route from its trusted caller — and no rule below needs more.
 */
export type CoordinationSeat = {
  role: CoordinationRole;
  sessionId: string;
  /** The plan a plan-pm seat is bound to; `null` for a coordinator seat. */
  planId: string | null;
};

/** The operations this slice implements — the only ones ever advertised. */
export const IMPLEMENTED_OPERATIONS: Record<string, true> = {
  prepare: true,
  progress: true,
  "residual-add": true,
  "residual-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  "repair-delivery-source": true,
  reconcile: true,
};

/** Operations only a coordinator session may issue (spec §D/§E). */
const COORDINATOR_OPERATIONS: readonly string[] = [
  "prepare",
  "accept",
  "return",
  "integration-start",
  "integration-accept",
  "complete",
  "repair-delivery-source",
  "reconcile",
];

/** Row statuses a claim may start from (mirrors the pure lease transition). */
export function isClaimableStatus(status: string): boolean {
  return status === "Todo" || status === "Blocked";
}

/** Render validation violations the one way every refusal message spells them. */
export function summarize(violations: readonly { code: string; message: string }[]): string {
  return violations.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
}

/** The row's own coordination block, or `undefined` when it carries none. */
export function rowCoordinationOf(row: PlanRow): RowCoordination | undefined {
  const value = row.coordination;
  if (!isPlainObject(value)) return undefined;
  // Boundary cast: every row `coordination` block reaching here was written
  // through the coordination module and validated by `validateRowCoordination`.
  const coordination = value as RowCoordination;
  return coordination;
}

export function rowStatusOf(row: PlanRow): string {
  return isNonEmptyString(row.status) ? row.status : "";
}

/**
 * The operations one seat may run against one row right now. The advertised
 * set is derived from the same closed union the writers dispatch on, so a
 * caller is never told about an operation the route refuses (spec §B
 * "unimplemented operations must be absent, not stubbed").
 */
export function allowedOperations(
  role: CoordinationRole,
  sessionId: string,
  snapshot: WorkflowSnapshot,
  row: PlanRow,
): string[] {
  const coordination = rowCoordinationOf(row);
  const status = rowStatusOf(row);
  const handoff = coordination?.handoff;
  const out: string[] = [];
  if (role === "coordinator") {
    // The coordinator seat is per workflow: an unbound session advertises nothing.
    if (snapshot.coordination?.coordinator.session_id !== sessionId) return [];
    if (
      coordination?.prepared === undefined &&
      coordination?.session === undefined &&
      handoff === undefined &&
      isClaimableStatus(status)
    ) {
      out.push("prepare");
    }
    switch (handoff?.state) {
      case "submitted":
        out.push("accept", "return");
        break;
      case "accepted":
        if (isStandaloneDevelopmentWorkflow(snapshot)) {
          out.push("return", "complete", "repair-delivery-source");
        } else {
          out.push("return", "integration-start");
        }
        break;
      case "integrating":
        out.push("integration-accept", "complete", "reconcile");
        break;
      case "merged":
        out.push("complete", "reconcile");
        break;
      case "completed":
        out.push("reconcile");
        break;
      default:
        break;
    }
  } else if (coordination?.session?.session_id === sessionId && coordination.prepared !== undefined) {
    // A plan session keeps only `handoff`: returning a handoff restores the
    // same session, so both directions stay available to it without rebinding.
    if (handoff === undefined || handoff.state === "returned") {
      out.push("progress", "residual-add", "residual-close", "handoff");
    }
  }
  return out.filter((kind) => IMPLEMENTED_OPERATIONS[kind] === true);
}

/* ------------------------------------------------------------------------ *
 * § Role and scope eligibility (spec §D/§E)
 * ------------------------------------------------------------------------ */

/**
 * The seat an operation requires (spec §D/§E): the coordinator verbs are
 * coordinator-only, and every other operation is a plan-session operation — a
 * coordinator session coordinates, it does not execute.
 */
export function assertOperationRole(seat: CoordinationSeat, kind: string): void {
  const coordinatorOperation = COORDINATOR_OPERATIONS.includes(kind);
  if (coordinatorOperation && seat.role !== "coordinator") {
    throw new CoordinationError(
      "coordination.session-role",
      `${kind} requires a coordinator session, not ${seat.role}`,
      { role: seat.role, operation: kind },
    );
  }
  if (!coordinatorOperation && seat.role !== "plan-pm") {
    throw new CoordinationError(
      "coordination.session-role",
      `${kind} is a plan-session operation (a coordinator session coordinates, it does not execute)`,
      { role: seat.role, operation: kind },
    );
  }
}

/** A plan session addresses only its own plan; a coordinator selects one. */
export function assertPlanAddress(seat: CoordinationSeat, requestedPlanId: string | undefined): void {
  if (requestedPlanId === undefined || seat.role === "coordinator") return;
  if (seat.planId !== requestedPlanId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan session ${seat.sessionId} addresses only its own plan ${String(seat.planId)}, not ${requestedPlanId}`,
      { expected: seat.planId, actual: requestedPlanId },
    );
  }
}

/**
 * The row's own bound session, proven to be `sessionId`'s. Identity is not
 * ownership (§D): the caller of this rule still has to prove it holds the
 * row's lease.
 */
export function requirePlanSessionBinding(row: PlanRow, sessionId: string, planId: string): CoordinatorBinding {
  const binding = rowCoordinationOf(row)?.session;
  if (binding === undefined) {
    throw new CoordinationError("coordination.not-prepared", `plan ${planId} has no bound plan session`, {
      plan_id: planId,
    });
  }
  if (binding.session_id !== sessionId) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `plan ${planId} is bound to session ${binding.session_id}, not ${sessionId}`,
      { expected: binding.session_id, actual: sessionId },
    );
  }
  return binding;
}

/* ------------------------------------------------------------------------ *
 * § Row eligibility: the handoff gate and the execution-lease gate
 * ------------------------------------------------------------------------ */

/** Reject row mutations while a handoff owns the plan's transition. */
export function assertNoHandoffTransition(coordination: RowCoordination | undefined, planId: string): void {
  const handoff = coordination?.handoff;
  if (handoff === undefined || handoff.state === "returned") return;
  throw new CoordinationError(
    "coordination.invalid-transition",
    `plan ${planId} is handed off (state ${String(handoff.state)}) \u2014 the plan session owns no transition until the coordinator returns or completes it`,
    { plan_id: planId, state: handoff.state },
  );
}

/**
 * The handoff of a plan the operation named, or a refusal when the row has none
 * or holds a different one. This runs under the transport's own read-then-write
 * exclusion: the id the caller read before the call is a precondition of the
 * mutation, never a hint — a concurrent `return` plus a fresh handoff leaves
 * the new attempt untouched (spec §B).
 */
export function requirePlanHandoff(
  coordination: RowCoordination | undefined,
  planId: string,
  namedHandoffId: string,
): PlanHandoff {
  const handoff = coordination?.handoff;
  if (handoff === undefined) {
    throw new CoordinationError("coordination.invalid-transition", `plan ${planId} has no handoff to transition`, {
      plan_id: planId,
    });
  }
  if (handoff.id !== namedHandoffId) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${planId} handoff ${handoff.id} is not the handoff this command named (${namedHandoffId}) \u2014 a replaced handoff is a different attempt`,
      { plan_id: planId, expected: namedHandoffId, actual: handoff.id },
    );
  }
  return handoff;
}

/**
 * The row's own execution lease, validated (spec §C2/§C3: a released lease is
 * deleted, `null`/tombstone objects are invalid). Fails closed — callers that
 * need a holder never proceed on an absent or malformed lease.
 */
export function requireExecutionLease(row: PlanRow, planId: string, what: string): ExecutionLease {
  const gate = validateExecutionLease(row.execution_lease);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `${what} requires ${planId} to hold an active execution lease \u2014 ${summarize(gate.violations)}`,
      { plan_id: planId, violations: gate.violations.map((entry) => entry.code) },
    );
  }
  // Boundary cast: `validateExecutionLease` just proved the shape.
  return row.execution_lease as ExecutionLease;
}

/** The row's execution lease, proven to be held by `holder` (spec §D). */
export function assertExecutionHolder(row: PlanRow, holder: string, planId: string, what: string): void {
  const lease = requireExecutionLease(row, planId, what);
  if (lease.holder !== holder) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `${what} requires ${planId}'s execution lease held by ${holder} \u2014 it is held by ${lease.holder}`,
      { plan_id: planId, expected: holder, actual: lease.holder },
    );
  }
}
