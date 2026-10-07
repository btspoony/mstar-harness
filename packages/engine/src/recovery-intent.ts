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
 *
 * `controlRoot` is the TRUSTED root when the caller holds one: a caller-supplied
 * root is authoritative and is never re-derived from Git (contract § One
 * resolver path, design R12/A24).
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
 * Direct coordinator plan operations. The addressed workflow and plan are
 * explicit; operation semantics select the operation's actual payload.
 *
 * Deliberately NOT selected: `sessionPath` and `expectedRevision` are
 * transport addressing and row-CAS freshness, not business intent.
 */
export const PLAN_OPERATION_SEMANTICS: Readonly<Record<PlanCoordinationOperation["kind"], SemanticSelection>> = {
  prepare: ["planId", "operation.kind", "operation.config"],
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
  complete: ["planId", "operation.kind", "operation.evidence", "operation.integration"],
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

/* ------------------------------------------------------------------------- *
 * Resolution: sparse intent → trusted root, associated target, current
 * authority (S2). Types and pure builders only — the probes that read Git,
 * files or the store live in the frames that own them (`coordination.ts` root
 * and target, `store-read.ts` authority), so this module keeps E01's
 * import discipline and stays reachable from any engine frame.
 * ------------------------------------------------------------------------- */

/** One resolved fact and the source that supplied it (`RecoveryDetails.resolvedFrom`). */
export type ResolutionSource = Readonly<{ path: string; source: string }>;

/** One non-fatal fact a resolution had to work around (`RecoveryDetails.warnings`). */
export type ResolutionWarning = Readonly<{ code: string; path?: string; message: string }>;

/**
 * The persistence route one resolved intent takes: the ACTIVE execution DB
 * authority, or the supported pre-activation file route. There is no third
 * answer and no fallback between them (contract § One resolver path).
 */
export type AuthorityRoute = "execution" | "files";

/**
 * The current authority verdict of one trusted control root.
 *
 * `handle` is the durable authority generation (`store_meta.store_id` +
 * `authority_epoch`) of an ACTIVE execution authority — the value a caller
 * re-asserts before an effect commits, so a generation that advanced mid-call
 * is refused instead of replayed blindly. It stays `null` on the file route,
 * which has no generation of its own: the only authority change that matters
 * there is that an ACTIVE authority appeared, and the route itself carries it.
 */
export type AuthorityVerdict = Readonly<{
  route: AuthorityRoute;
  handle: Readonly<{ storeId: string; epoch: number }> | null;
}>;

/**
 * Trusted control-root resolution of one sparse intent. `ok: false` is the
 * unresolved component: no root could be established (or two durable
 * statements disagree), with the sources tried and the facts currently true.
 * A root is never guessed and a Git outage never invalidates an established
 * one — an unreadable Git fact only becomes a warning next to a resolved root.
 */
export type RootResolution =
  | Readonly<{
      ok: true;
      root: string;
      resolvedFrom: readonly ResolutionSource[];
      warnings: readonly ResolutionWarning[];
    }>
  | Readonly<{ ok: false; problem: RecoveryProblem; resolvedFrom: readonly ResolutionSource[] }>;

/**
 * Addressed-target resolution of one sparse intent: the workflow (and plan)
 * the intent acts on. `ok: false` is the unresolved component — a selector
 * that does not exist at the trusted root, a root that holds no workflow, or
 * an unassociated root that holds one or more candidates, which are LISTED
 * rather than picked (contract § One resolver path: never select the sole or
 * most-recent workflow without an association).
 */
export type TargetResolution =
  | Readonly<{
      ok: true;
      workflowId: string;
      planId?: string;
      resolvedFrom: readonly ResolutionSource[];
    }>
  | Readonly<{ ok: false; problem: RecoveryProblem; resolvedFrom: readonly ResolutionSource[] }>;

/**
 * The recovery sidecar of a resolution that withheld its effect, in the frozen
 * `RecoveryDetails` shape: a refusal carries this object under
 * `error.details.recovery`, and it names every unresolved component, the facts
 * that were resolved instead, and that nothing was committed.
 */
export function unresolvedRecovery(input: {
  target: RecoveryDetails["target"];
  unresolved: readonly RecoveryProblem[];
  resolvedFrom?: readonly ResolutionSource[];
  warnings?: readonly ResolutionWarning[];
}): RecoveryDetails {
  return {
    outcome: "unresolved",
    target: input.target,
    applied: [],
    unresolved: [...input.unresolved],
    resolvedFrom: [...(input.resolvedFrom ?? [])],
    warnings: [...(input.warnings ?? [])],
    commitState: "none",
  };
}
