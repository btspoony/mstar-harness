/**
 * The recovery-first intent contract (S1).
 *
 * Engine-owned home of exactly two things and nothing else:
 *
 * 1. The sparse intent types the public lifecycle operations accept and report.
 *    `IntentContext` is the small subset of `InvocationContext`
 *    (`packages/commands/src/types.ts`) the engine needs plus an independently
 *    acquired `ExecutionIdentity` — a role string or session reference is a
 *    selector, never authority. `RecoveryDetails` is a SIDECAR on existing
 *    domain results: a successful engine value exposes `recovery`, a domain
 *    refusal exposes the same object under `error.details.recovery`.
 *    `CommandEnvelope` remains the only CLI/MCP transport envelope; nothing
 *    here is a second one (contract § One resolver path, two existing
 *    authorities).
 *
 * 2. The shared semantic selections (design §4.2): for each lifecycle operation
 *    kind, the field paths that make up its BUSINESS INTENT, so freshness,
 *    replay and reconciliation compare what an effect actually depends on
 *    instead of hashing a whole document, receipt or CAS token. The pattern is
 *    `executionInputSelection`/`executionInputHash` (`coordination.ts` §
 *    contract §1) generalized to the operation envelopes both authority routes
 *    already take; hashing a selection stays with the frame that owns the
 *    serializer (`stableJson`, `serializeExecutionValue`).
 *
 * Import discipline: runtime-imports only the cycle-safe write layer for
 * `isPlainObject`; the operation unions are type-only, so this module can be
 * imported from any engine frame without creating an ESM cycle.
 */
import { isPlainObject } from "./coordination-write.js";
import type { PlanCoordinationOperation } from "./coordination.js";
import type { WorkflowExecutionOperation } from "./execution-workflow.js";
import type { ExecutionIdentity } from "./session-identity.js";

/**
 * The sparse intent context one engine lifecycle operation accepts. Redundant
 * selectors, revisions, session projections and copied metadata are derived by
 * the engine's resolution path; the caller supplies only what cannot be
 * derived. The identity is acquired by the caller (adapter) and independently
 * validated — it is never inferred from the request.
 */
export type IntentContext = Readonly<{
  cwd: string;
  controlRoot?: string;
  identity?: ExecutionIdentity;
  requestId?: string;
}>;

/**
 * One component of an intent that could not be resolved or applied. Every
 * field is a fact the caller can act on: what was addressed, what was tried,
 * what is currently true, what the caller must decide/provide and what the
 * withheld effect was. Refusal prose alone is never the whole report.
 */
export type RecoveryProblem = Readonly<{
  component: string;
  path: string;
  code: string;
  sourcesTried: readonly string[];
  currentFacts: readonly string[];
  needed: string;
  withheldEffect: string;
  availableWork: readonly string[];
}>;

/**
 * The recovery sidecar of one domain result.
 *
 * - `applied` / `already-satisfied` are full successes: the CLI/MCP
 *   `CommandEnvelope` is `ok`/exit 0/`isError:false`.
 * - `partial` / `unresolved` name exactly which components landed
 *   (`applied`) and which did not (`unresolved`); independently requested
 *   components are never rolled back to make the answer simpler, and a
 *   connected component is all-or-nothing.
 * - `commitState` reports the known commit boundary — a transport failure
 *   after commit is never reported as "nothing happened".
 */
export type RecoveryDetails = Readonly<{
  outcome: "applied" | "already-satisfied" | "partial" | "unresolved";
  target: Readonly<{ workflowId?: string; planId?: string; entityId?: string }>;
  applied: readonly string[];
  unresolved: readonly RecoveryProblem[];
  resolvedFrom: readonly Readonly<{ path: string; source: string }>[];
  warnings: readonly Readonly<{ code: string; path?: string; message: string }>[];
  commitState: "none" | "committed" | "partial" | "unknown";
}>;

/**
 * One operation's business-intent selection: dot paths from the operation
 * ENVELOPE root (e.g. `operation.progress`). A path that is absent or
 * `undefined` contributes nothing; a path that is present with any other value
 * — including `null` — is part of the selection, so "absent" and "explicitly
 * cleared" never compare equal.
 */
export type SemanticSelection = readonly string[];

/**
 * Plan-coordination operations. The envelope is `CoordinationRequest`
 * (`{ sessionPath, planId?, expectedRevision, operation }`).
 *
 * Deliberately NOT selected (design §4.2 a/b): `sessionPath` and
 * `expectedRevision` are transport addressing and the row CAS generation — a
 * stale revision alone says nothing about whether the requested effect is
 * still valid, so a replay must not see it as a changed intent.
 * `expectedIssueRevision` (residual-close) IS selected: it is an
 * entity-level constraint on the read set the effect depends on, exactly like
 * an explicitly supplied `expectedFile`.
 */
export const PLAN_OPERATION_SEMANTICS: Readonly<Record<PlanCoordinationOperation["kind"], SemanticSelection>> = {
  prepare: ["planId", "operation.kind", "operation.assignmentPath"],
  progress: ["planId", "operation.kind", "operation.progress"],
  "residual-add": ["planId", "operation.kind", "operation.entries"],
  "residual-close": [
    "planId",
    "operation.kind",
    "operation.issueId",
    "operation.disposition",
    "operation.evidence",
    "operation.expectedIssueRevision",
  ],
  handoff: ["planId", "operation.kind", "operation.evidence"],
  accept: ["planId", "operation.kind", "operation.handoffId"],
  return: ["planId", "operation.kind", "operation.handoffId", "operation.reason"],
  "integration-start": ["planId", "operation.kind", "operation.handoffId"],
  "integration-accept": ["planId", "operation.kind", "operation.handoffId"],
  complete: ["planId", "operation.kind", "operation.handoffId"],
  "repair-delivery-source": ["planId", "operation.kind", "operation.handoffId"],
  reconcile: ["planId", "operation.kind", "operation.handoffId"],
};

/**
 * Workflow operations. The envelope is `WorkflowOperationRequest`
 * (`{ operationId, session, expected, workflowId, operation }`).
 *
 * Deliberately NOT selected (design §4.2 a/b): `operationId` and `session` are
 * retry/identity addressing, and `expected` is the workflow CAS token — the
 * exact case §4.2 calls out ("semantic replay must stop hashing transport
 * freshness as business intent"). The addressed `workflowId` and the
 * operation's own member are the intent.
 */
export const WORKFLOW_OPERATION_SEMANTICS: Readonly<Record<WorkflowExecutionOperation["kind"], SemanticSelection>> = {
  phase: ["workflowId", "operation.kind", "operation.phase", "operation.compassPath"],
  lifecycle: ["workflowId", "operation.kind", "operation.status", "operation.reason"],
  "execution-policy": ["workflowId", "operation.kind", "operation.policy"],
  "integration-worktree": ["workflowId", "operation.kind", "operation.path"],
  delivery: ["workflowId", "operation.kind", "operation.delivery"],
};

/**
 * The canonical subset one operation envelope carries under `selection`: the
 * selected paths, in selection order, with absent/`undefined` paths omitted —
 * the same rule `executionInputSelection` uses for a plan row, so the frozen
 * execution input and any later freshness comparison describe the same bytes.
 */
export function selectSemanticFields(envelope: unknown, selection: SemanticSelection): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const path of selection) {
    const value = readPath(envelope, path);
    if (value !== undefined) selected[path] = value;
  }
  return selected;
}

/** Walk one dot path; a missing/non-object hop is `undefined`, never a throw. */
function readPath(envelope: unknown, path: string): unknown {
  let current: unknown = envelope;
  for (const key of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}
