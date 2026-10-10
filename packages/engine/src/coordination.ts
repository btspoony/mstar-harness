/**
 * coordination.ts — the shared ACTIVE-route plan-operation surface.
 *
 * Pieces the ACTIVE execution authority (store.db) and the migration tooling
 * share without an ESM cycle: the closed plan-operation union, Git proof
 * machinery, execution-catalog pin family and evidence-area/path helpers.
 * The coordinated-artifact replacement surface is retired; file `status` and
 * `snapshot` kinds remain only for migration staging.
 * The FILE execution route is retired: the coordinator session envelope, the
 * file-route scope/read/mutate machinery and the Prepare show/amend/recover
 * verbs were deleted. Their byte-witness envelope reader lives in
 * `coordination-envelope.ts` for the migration side, and the coordinator
 * binding is written by `execution-session.ts`.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson } from "./core.js";
import {
  COORDINATION_ERROR_CODES,
  CoordinationError,
  canonicalTarget,
  isNonEmptyString,
  isPlainObject,
  evidenceRefOf,
  sha256Bytes,
  validatePlanProgress,
  validateRowCoordination,
  type CoordinationErrorCode,
  type PlanProgress,
  type PreparedCoordination,
  type PlanPrepareConfig,
  type CompletionEvidence,
  type IntegrationResultInput,
  type RowCoordination,
  type CoordinatorBinding,
  type CoordinationIdentityRecovery,
  type CompletionRecord,
} from "./coordination-write.js";

import {
  selectSemanticFields,
  unresolvedRecovery,
  type IntentContext,
  type RecoveryDetails,
  type RecoveryProblem,
  type ResolutionSource,
  type ResolutionWarning,
  type RootResolution,
  type TargetResolution,
} from "./recovery-intent.js";
import { assertSafeSessionId, validateExecutionIdentity, type ExecutionIdentity } from "./session-identity.js";
import {
  IMPLEMENTED_OPERATIONS,
  allowedOperations,
  assertCompletionReviewDecision,
  assertGitObjectId,
  assertNoIntegrationContamination,
  assertOperationRole,
  assertPlanAddress,
  assertPrepareAdmission,
  assertTrackBranches,
  gitProof,
  integrationAnchors,
  integrationDiverged,
  integrationUnresolved,
  missingDecision,
  projectBucketOf,
  readCompletionEvidence,
  requireProgressStatus,
  rowCoordinationOf,
  rowStatusOf,
  standaloneDeliveryAnchors,
  summarize,
  type CoordinationRole,
  type CoordinationSeat,
  type IntegrationAnchors,
  type ValidatedCompletionEvidence,
} from "./coordination-transitions.js";
import {
  withStatusWriteLock,
} from "./lease.js";
import {
  assertSafePathComponent,
  canonicalizeNearestExisting,
  resolveHarnessDir,
  resolvePlanDir,
  resolveSddDir,
  resolveWorkflowDir,
} from "./path.js";
import { findingsCleanupGate, _DEFAULT_PROJECT } from "./project.js";
import { assertCatalogExecutionCommitted } from "./catalog-registration.js";
import { CatalogError } from "./catalog.js";
import { PlanPathError, planDeclaredHeaders, resolveRegisteredPlanFile, type RegisteredPlanFile } from "./plan-path.js";
import { parseCompassFrontmatterText } from "./iteration.js";
import { findRegisteredWorkflow, rowPlanIds, validatePlanRow, type PlanRow } from "./status.js";
import {
  StoreError,
  openStore,
  type StoreContext,
  type StoreDb,
  type StoreHandle,
} from "./store-db.js";
import type { ActivationAttestation } from "./store-activation.js";
import {
  IssueError,
  assertIssueProvenanceSchema,
  captureIssue,
  closeIssue,
  linkIssueScoped,
  type CaptureInput,
  type ClosureEvidence,
  type TerminalDisposition,
} from "./issue.js";
import { isDistinctCheckout, readMainWorktree, type MainWorktreeInfo } from "./worktree.js";
import {
  DERIVED_PHASE_CODE,
  deriveLifecyclePhase,
  isStandaloneDevelopmentWorkflow,
  isStandaloneReportOnlyWorkflow,
  isTerminalSnapshot,
  rowValidationRoute,
  consultDeliveryEvidence,
  readWorkflowSnapshot,
  stableJson,
  PREPARE_PHASE,
  WORKFLOW_TERMINAL_STATUSES,
  type WorkflowBranchAnchors,
  type WorkflowExecutionPolicy,
  type WorkflowSnapshot,
} from "./workflow.js";
import { MSTAR_REVIEW_V1_PAYLOAD_SCHEMA } from "./qcreview-schema.js";

/**
 * Persist payload contracts are owned by their validating domains. `json` is
 * intentionally syntax-only: arbitrary JSON has no domain validator; use the
 * review kind for governed documents.
 *
 * Published as BOTH a value (`PERSIST_PAYLOAD_CONTRACTS`) and a callable
 * (`persistPayloadContracts`); `packages/commands` reads it inside command
 * construction. The retired `status`/`snapshot` kinds — the file execution
 * route's transports — no longer appear here.
 */
export const PERSIST_PAYLOAD_CONTRACTS = {
  review: { schema: MSTAR_REVIEW_V1_PAYLOAD_SCHEMA, validation: "mstar.review/v1" },
  json: {
    schema: null,
    validation: "parse-only",
    reason: "Arbitrary JSON has no declared domain shape.",
    alternative: "Use review for governed artifacts.",
  },
} as const;

export function persistPayloadContracts(): typeof PERSIST_PAYLOAD_CONTRACTS {
  return PERSIST_PAYLOAD_CONTRACTS;
}

/* ------------------------------------------------------------------------ *
 * § Types — public surface
 * ------------------------------------------------------------------------ */

/**
 * Re-exported from the storage layer because this module is the public entry
 * point for the scoped writers: callers catch `CoordinationError` and branch
 * on its `code` without importing the storage layer directly.
 */
export { CoordinationError };

/** The sole plan coordinator identity. */
export type { CoordinationRole };

export type ResidualInput = Omit<CaptureInput, "projectId">;
export type PlanCoordinationOperation =
  | { kind: "prepare"; config?: PlanPrepareConfig }
  | { kind: "progress"; progress: PlanProgress }
  | { kind: "residual-add"; entries: ResidualInput[] }
  | { kind: "residual-close"; issueId: string; disposition: TerminalDisposition; evidence: ClosureEvidence; expectedIssueRevision: number }
  | { kind: "complete"; evidence: CompletionEvidence; integration?: IntegrationResultInput };


const SNAPSHOT_FILE = "snapshot.json";
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `error.code` when the thrown value carries a POSIX errno string. */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function invalidInput(message: string, details: Record<string, unknown> = {}): CoordinationError {
  return new CoordinationError("coordination.invalid-input", message, details);
}

/** The single mapping from a violated stored shape to the refusal vocabulary. */
export function assertViolationFree(violations: readonly { code: string; message: string }[], what: string): void {
  if (violations.length > 0) {
    throw new CoordinationError("coordination.invalid-input", "Stored workflow is invalid. Inspect it with mstar status validate.", {
      subject: what,
      violations: violations.map((entry) => entry.code),
      violation_messages: violations.map((entry) => entry.message),
    });
  }
}

function snapshotPathOf(harnessRoot: string, workflowId: string): string {
  return join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), workflowId, SNAPSHOT_FILE);
}

/**
 * The canonical local store, pinned to `harnessRoot`. A remote/injected store
 * cannot serve this surface: every caller resolves paths from the same
 * FsStore path table, so a non-local store is refused rather than silently
 * writing somewhere else.
 */

/* ------------------------------------------------------------------------ *
 * § Process root
 * ------------------------------------------------------------------------ */

/** `true` when `child` is `parent` or lives below it (both canonical). */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * The process-wide harness root (spec §C1): resolved from the **main**
 * worktree's root, never from the checkout the process happens to sit in.
 * This is the fix for the process-root bug — a process inside a linked
 * worktree must not resolve the worktree's own `.mstar`.
 *
 * Returns `null` when no harness root is resolvable (the unscoped CLI keeps
 * its existing non-Git fallback). Throws `coordination.not-in-git` when the
 * cwd is provably a linked checkout (a `.git` **file**) whose main worktree
 * cannot be read — falling back to local artifacts there is exactly the bug.
 */
export function resolveProcessHarnessDir(cwd: string = process.cwd(), harnessDir?: string): string | null {
  if (isNonEmptyString(harnessDir)) return resolve(cwd, harnessDir);
  const start = resolve(cwd);
  const main: MainWorktreeInfo | null = readMainWorktree(start);
  if (main !== null) return resolveHarnessDir(main.root);
  for (let dir = start; ;) {
    let linked = false;
    try {
      const marker = statSync(join(dir, ".git"));
      // Stop at the nearest independent repository, not its enclosing checkout.
      if (marker.isDirectory()) return resolveHarnessDir(start, { workspaceRoot: dir });
      linked = marker.isFile();
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (linked) {
      throw new CoordinationError(
        "coordination.not-in-git",
        "The linked checkout's main worktree cannot be read. Run mstar status validate. Then inspect the main worktree at the control harness root.",
        { cwd: start, marker: join(dir, ".git") },
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolveHarnessDir(start);
}

/* ------------------------------------------------------------------------ *
 * § Intent resolution (S2): trusted root, associated target
 * ------------------------------------------------------------------------ */

/**
 * The process-root probe WITHOUT the hard Git verdict. `resolveProcessHarnessDir`
 * keeps refusing for callers that bring no root of their own; an engine
 * operation that already holds a trusted root must not be invalidated by a
 * Git fact it does not need (design R12/A24), so an unreadable main worktree is
 * reported as `unavailable` here instead of becoming a refusal.
 */
function probeProcessRoot(cwd: string): { root: string | null; unavailable: string | null } {
  try {
    return { root: resolveProcessHarnessDir(cwd), unavailable: null };
  } catch (error) {
    if (error instanceof CoordinationError && error.code === "coordination.not-in-git") {
      return { root: null, unavailable: error.message };
    }
    throw error;
  }
}

/** The durable root association an entry already holds: the control harness root
 * its own session envelope (or catalog binding) recorded. */
export type RootAssociation = Readonly<{ root: string; source: string }>;

/**
 * Resolve the TRUSTED control root of one sparse intent, in source order:
 *
 * 1. `context.controlRoot` — a root the caller explicitly holds. It is
 *    authoritative: it is never re-derived from Git, so a Git outage cannot
 *    invalidate it and no nested harness is guessed (R12/A24).
 * 2. `association` — the root the caller's identity already holds (its session
 *    envelope). Also Git-independent, but cross-checked against the process
 *    root when that probe answers: two durable statements that disagree are an
 *    unresolved conflict, never a silent pick (§3.3).
 * 3. The process probe from `context.cwd` — the only Git-dependent source, and
 *    the only one that can answer "no root".
 *
 * A root is never guessed and no candidate list is used to choose one. A Git
 * fact that cannot be read is a warning beside a resolved root, and an
 * unresolved component (with every source tried) when no root was established.
 */
export function resolveIntentRoot(context: IntentContext, association?: RootAssociation): RootResolution {
  const resolvedFrom: ResolutionSource[] = [];
  const warnings: ResolutionWarning[] = [];
  const cwd = resolve(context.cwd);
  if (isNonEmptyString(context.controlRoot)) {
    resolvedFrom.push({ path: "controlRoot", source: "intent.explicit" });
    return {
      ok: true,
      root: canonicalizeNearestExisting(resolve(cwd, context.controlRoot)),
      resolvedFrom,
      warnings,
    };
  }
  const associated =
    association === undefined
      ? null
      : { root: canonicalizeNearestExisting(association.root), source: association.source };
  if (associated !== null) resolvedFrom.push({ path: "controlRoot", source: associated.source });

  const probe = probeProcessRoot(cwd);
  if (probe.root !== null) {
    const probed = canonicalizeNearestExisting(probe.root);
    resolvedFrom.push({ path: "cwd", source: "harness.probe" });
    if (associated === null) return { ok: true, root: probed, resolvedFrom, warnings };
    if (probed !== associated.root) {
      return {
        ok: false,
        resolvedFrom,
        problem: {
          component: "root",
          path: "controlRoot",
          code: "coordination.scope-mismatch",
          sourcesTried: resolvedFrom.map((entry) => `${entry.path} (${entry.source})`),
          currentFacts: [
            `the durable association ${associated.source} names ${associated.root}`,
            `the process root of ${cwd} is ${probed}`,
          ],
          needed: "which control root this intent belongs to",
          withheldEffect:
            "the addressed lifecycle effect - two durable root statements disagree, so nothing was read or written",
          availableWork: [
            "run the call from inside the recorded control root (or a checkout of it)",
            "pass the trusted root explicitly (IntentContext.controlRoot) when the association is the intended one",
          ],
        },
      };
    }
    return { ok: true, root: associated.root, resolvedFrom, warnings };
  }
  if (associated !== null) {
    // The trusted root stands; an unreadable Git fact about the process
    // association is reported, not promoted to a refusal (R12/A24). A probe
    // that simply found no harness beside the association is not a warning —
    // there is nothing to compare, exactly as before.
    if (probe.unavailable !== null) {
      warnings.push({
        code: "coordination.git-unavailable",
        path: "cwd",
        message:
          `the process root of ${cwd} could not be established (${probe.unavailable}); this call proceeds on the ` +
          `trusted root ${associated.root} recorded by ${associated.source}`,
      });
    }
    resolvedFrom.push({
      path: "cwd",
      source: probe.unavailable === null ? "harness.probe.absent" : "harness.probe.unavailable",
    });
    return { ok: true, root: associated.root, resolvedFrom, warnings };
  }
  const problem: RecoveryProblem = {
    component: "root",
    path: "controlRoot",
    code: "coordination.harness-not-found",
    sourcesTried: [...resolvedFrom.map((entry) => `${entry.path} (${entry.source})`), "cwd (harness probe)"],
    currentFacts: [
      probe.unavailable ?? `${cwd} holds no resolvable control harness`,
      `${cwd} holds no durable root association for this call`,
    ],
    needed: "the control harness root this intent belongs to",
    withheldEffect: "the addressed lifecycle effect - resolution stopped before any root, workflow or store was read",
    availableWork: [
      "pass the trusted control root explicitly (IntentContext.controlRoot)",
      "run the call from inside the control harness's own main worktree",
    ],
  };
  return { ok: false, resolvedFrom, problem };
}

/** One target selection: what the caller stated, or what its identity already holds. */
export type TargetSelection = Readonly<{ workflowId?: string; planId?: string }>;

/**
 * The workflow ids the TRUSTED root holds, in stable order — one listing of the
 * root's own workflow directory plus a snapshot existence check per entry. This
 * bounded read is the whole candidate set: no repository-wide scan and no
 * "most recent" ordering, so resolution can only ever list what it read.
 *
 * It is walked ONLY when the intent names no target at all, where the list IS
 * the answer (A22). A named target is validated against its own snapshot, so
 * naming a workflow never reads — or depends on reading — the other ones.
 */
function workflowIdsAt(root: string): string[] {
  const dir = resolveWorkflowDir(root, { harnessDir: root });
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, SNAPSHOT_FILE)))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The refusal of one unresolved TARGET component, in the standard shape: the
 * withheld effect is always the addressed lifecycle effect, and the caller is
 * told what is currently true and what to do next rather than handed a guess.
 */
function unresolvedTarget(input: {
  code: RecoveryProblem["code"];
  needed: string;
  resolvedFrom: ResolutionSource[];
  currentFacts: string[];
  availableWork: string[];
}): TargetResolution {
  return {
    ok: false,
    resolvedFrom: input.resolvedFrom,
    problem: {
      component: "target",
      path: "workflowId",
      code: input.code,
      sourcesTried: input.resolvedFrom.map((entry) => `${entry.path} (${entry.source})`),
      currentFacts: input.currentFacts,
      needed: input.needed,
      withheldEffect:
        "the addressed lifecycle effect - no target was guessed, so no workflow row, document or store was read for it",
      availableWork: input.availableWork,
    },
  };
}

/**
 * Resolve the ADDRESSED TARGET of one sparse intent against a trusted root, in
 * source order: the explicit `selection`, then the durable `association` the
 * caller's identity already holds (its session envelope or catalog link).
 *
 * A NAMED target is validated DIRECTLY against that one workflow's own
 * snapshot document, so resolving it reads only the addressed workflow and can
 * never depend on the root's other workflows. Only when neither source names a
 * workflow is the root's own workflow directory listed — and then the listing
 * is not a choice but the answer handed back: the candidate identities the
 * caller must select between. Resolution never picks the sole/most-recent
 * workflow without an association (contract § One resolver path, A22). A
 * selector the root does not hold — or a `planId` that is not a row of the
 * addressed workflow — is the same kind of unresolved component, reported from
 * the addressed workflow's own facts, never a silent fallback.
 */
export function resolveIntentTarget(input: {
  root: string;
  selection?: TargetSelection;
  association?: TargetSelection;
}): TargetResolution {
  const root = canonicalizeNearestExisting(input.root);
  const explicit = isNonEmptyString(input.selection?.workflowId) ? input.selection.workflowId : undefined;
  const associated = isNonEmptyString(input.association?.workflowId) ? input.association.workflowId : undefined;
  const workflowId = explicit ?? associated;

  if (workflowId === undefined) {
    // Nothing names a workflow: the root's own candidate identities are the
    // whole answer, listed for the caller to select between (never chosen from).
    const listed: ResolutionSource = { path: "workflowId", source: "workflows.dir" };
    const candidates = workflowIdsAt(root);
    return unresolvedTarget({
      code: "coordination.invalid-input",
      needed: "which workflow this intent addresses",
      resolvedFrom: [listed],
      currentFacts:
        candidates.length === 0
          ? [`${root} holds no workflow`]
          : candidates.map((id) => `workflow ${id} exists at ${root}`),
      availableWork: [
        ...(candidates.length === 0 ? ["register or select the work this intent addresses"] : []),
        ...candidates.map((id) => `address workflow ${id} explicitly`),
      ],
    });
  }

  const source: ResolutionSource =
    explicit !== undefined
      ? { path: "workflowId", source: "intent.explicit" }
      : { path: "workflowId", source: "target.association" };
  const resolvedFrom: ResolutionSource[] = [source];
  const id = safePlanId(workflowId, "workflowId");
  // The addressed workflow's own snapshot is the only existence fact needed:
  // one bounded check of the named workflow, never a listing of its siblings.
  const snapshotFile = snapshotPathOf(root, id);
  if (!existsSync(snapshotFile)) {
    return unresolvedTarget({
      code: "coordination.workflow-not-found",
      needed: `the addressed workflow ${id}`,
      resolvedFrom,
      currentFacts: [`${root} holds no workflow ${id}`],
      availableWork: ["address a workflow this control root holds", "register or select the work this intent addresses"],
    });
  }

  const explicitPlan = isNonEmptyString(input.selection?.planId) ? input.selection.planId : undefined;
  const associatedPlan = isNonEmptyString(input.association?.planId) ? input.association.planId : undefined;
  const planId = explicitPlan ?? associatedPlan;
  if (planId === undefined) return { ok: true, workflowId: id, resolvedFrom };
  const plan = safePlanId(planId, "planId");
  resolvedFrom.push({ path: "planId", source: explicitPlan !== undefined ? "intent.explicit" : "target.association" });
  // The addressed workflow's own row set is the bounded fact read that confirms
  // the plan id: one snapshot, never a scan of other workflows.
  const snapshot = readSnapshot(dirname(snapshotFile));
  if (!snapshot.plans.some((row) => rowPlanIds(row).includes(plan))) {
    return unresolvedTarget({
      code: "coordination.plan-not-found",
      needed: `the addressed plan ${plan} of workflow ${id}`,
      resolvedFrom,
      currentFacts: [`workflow ${id} exists at ${root}`, `workflow ${id} holds no plan row ${plan}`],
      availableWork: [`address a plan row of workflow ${id}`],
    });
  }
  return { ok: true, workflowId: id, planId: plan, resolvedFrom };
}

/** `true` when `planId` is safe to use as a single path component. */
function safePlanId(planId: string, where: string): string {
  try {
    assertSafePathComponent(planId, where);
  } catch (error) {
    throw invalidInput("The supplied path component is unsafe. Correct the caller input and inspect the target workflow with mstar status validate.", {
      plan_id: planId, where, cause: errorMessage(error),
    });
  }
  return planId;
}

/** The canonical snapshot payload, for the callers that need no phase fact. */
function readSnapshot(dir: string): WorkflowSnapshot {
  return readSnapshotWithPhase(dir).snapshot;
}

/**
 * The canonical snapshot read plus the ONE phase fact a consumer cannot
 * re-derive from the payload alone: whether the label it carries was DERIVED by
 * the reader (`deriveLifecyclePhase`, E06a/R3) rather than declared by the
 * document. The reader reports that through its own diagnostic, so a caller
 * that must persist the repair knows the label was absent without duplicating
 * the derivation rule.
 */
function readSnapshotWithPhase(dir: string): { snapshot: WorkflowSnapshot; phaseDerived: boolean } {
  const snapshotPath = join(dir, SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) {
    throw new CoordinationError("coordination.workflow-not-found", "Workflow snapshot was not found. Inspect the harness with mstar status validate.", {
      path: snapshotPath,
    });
  }
  try {
    const read = readWorkflowSnapshot(dir);
    return { snapshot: read.snapshot, phaseDerived: read.diagnostics.some((entry) => entry.code === DERIVED_PHASE_CODE) };
  } catch (error) {
    // The authority verdict is the store's own typed refusal — an ACTIVE
    // execution authority retires this file reader, and an unreadable store
    // cannot be re-read. Relabelling it `coordination.store` would drop the
    // actual cause (contract: a capability failure reports its own code), so it
    // is re-thrown verbatim; only a genuinely unusable document is wrapped.
    if (error instanceof StoreError) throw error;
    throw new CoordinationError(
      "coordination.store",
      "Workflow snapshot is unreadable or invalid. Inspect the harness with mstar status validate.",
      { path: snapshotPath, cause: errorMessage(error) },
    );
  }
}

/**
 * `catalog_pin` — the frozen identity of the catalog input a prepared
 * execution selected (state-projection contract §1). It is written on a newly
 * prepared row by the authorized `prepare` (its only writer) and read by
 * every execution consumer; a generic snapshot/metadata update is never a
 * catalog writer. Changing the *current* catalog (descriptive metadata, a
 * relocated path, new relations) therefore does NOT change a prepared
 * execution, and a discrepancy between the frozen execution input and its pin
 * is `catalog.execution-pin-conflict` — never a reason to overwrite either
 * side. Progress/status/lease changes are execution authority and cannot
 * invalidate the pin.
 */
/** Stable refusal code for malformed, foreign or missing catalog selections. */
export const EXECUTION_PIN_CONFLICT_CODE = "catalog.execution-pin-conflict";

export type CatalogExecutionPin = {
  /** The store that owns the selection (`store_meta.store_id`). */
  store_id: string;
  /** The catalog entity revision the selection was copied from. */
  entity_revision: number;
  /**
   * The document half of the pin: sha256 over the frozen execution-input
   * selection (see `executionInputHash`) — never the live catalog row's hash.
   */
  document_hash: string;
  /** sha256 over the catalog relations the entity carried at selection time. */
  relation_hash: string;
};

/**
 * Why a plan carries no pin. `store-absent` (no catalog database) and
 * `store-inactive` (staged, pre-activation) are deliberately distinct from
 * `unbound` (an active catalog that does not select this plan): a missing
 * catalog is never reported as an empty one.
 */
export type CatalogPinAbsence = "store-absent" | "store-inactive" | "unbound";

/** The frozen-vs-current pin state of one plan (the prepare/execution reader). */
export type ExecutionCatalogPinState = {
  workflow_id: string;
  plan_id: string;
  /** Where the recorded pin came from; `null` when this plan carries none. */
  source: "row" | "binding" | null;
  pin: CatalogExecutionPin | null;
  /** The catalog store's availability for this read — never inferred from a pin. */
  store: "active" | "absent" | "inactive";
  /**
   * Why NO pin is recorded (`null` whenever `pin` is set): the catalog is
   * missing, staged, or simply does not select this plan.
   */
  absence: CatalogPinAbsence | null;
  /** The catalog's current revision for this plan, when it is reachable. */
  current_revision: number | null;
  /** The catalog moved past the recorded pin — tolerated, disclosed, never silent. */
  catalog_moved: boolean;
  /** Set when the frozen execution input and its recorded pin disagree. */
  conflict: string | null;
};
/** Raised for field-value mismatches between a pin and its owning catalog. */
export class ExecutionPinConflictError extends Error {
  readonly code = EXECUTION_PIN_CONFLICT_CODE;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(`[${EXECUTION_PIN_CONFLICT_CODE}] ${message}`);
    this.name = "ExecutionPinConflictError";
    this.details = details;
  }
}


/** The row fields contract §1 freezes as the execution input pin. */
const FROZEN_ROW_FIELDS: readonly string[] = ["id", "plan_id", "title", "file"];
/** The `metadata` keys contract §1 freezes (catalog-copied references). */
const FROZEN_METADATA_FIELDS: readonly string[] = ["primary_spec", "spec_refs", "iteration_compass", "iteration_refs"];

/**
 * The frozen execution-input selection one plan row carries (contract §1):
 * `plan_id` plus the row's id/title/file and its metadata catalog references,
 * and nothing else. This is the single definition of the selection: the DB
 * authority of the execution store seals exactly this object as a plan's
 * `execution_inputs.input_json`, so the stored selection and the hash below can
 * never describe different bytes.
 */
export function executionInputSelection(row: unknown, planId: string): Record<string, unknown> {
  const selection: Record<string, unknown> = { plan_id: planId };
  if (isPlainObject(row)) {
    const metadata = isPlainObject(row.metadata) ? row.metadata : {};
    for (const key of FROZEN_ROW_FIELDS) {
      if (row[key] !== undefined) selection[key] = row[key];
    }
    for (const key of FROZEN_METADATA_FIELDS) {
      if (metadata[key] !== undefined) selection[key] = metadata[key];
    }
  }
  return selection;
}

/**
 * The document half of `catalog_pin`: sha256 over the frozen execution-input
 * selection only. `status`, `progress`, task/QC/QA fields, leases and track
 * branches are execution authority (contract §1) and are deliberately not
 * hashed, so reporting progress never invalidates a pin.
 */
export function executionInputHash(row: unknown, planId: string): string {
  return createHash("sha256").update(stableJson(executionInputSelection(row, planId)), "utf8").digest("hex");
}

/** Parse (and shape-check) the pin recorded on a plan row, or `null`. */
function recordedPinOf(row: unknown): CatalogExecutionPin | null {
  if (!isPlainObject(row) || !isPlainObject(row.metadata)) return null;
  const raw = row.metadata.catalog_pin;
  if (!isPlainObject(raw)) return null;
  if (
    !isNonEmptyString(raw.store_id) ||
    typeof raw.entity_revision !== "number" ||
    !Number.isInteger(raw.entity_revision) ||
    !isNonEmptyString(raw.document_hash) ||
    !isNonEmptyString(raw.relation_hash)
  ) {
    return null;
  }
  return {
    store_id: raw.store_id,
    entity_revision: raw.entity_revision,
    document_hash: raw.document_hash,
    relation_hash: raw.relation_hash,
  };
}

/** What the catalog currently holds for one workflow/plan (read-only facts). */
export type CatalogPinFacts = {
  store: "absent" | "active" | "inactive";
  storeId: string | null;
  revision: number | null;
  relation_hash: string | null;
  /** The workflow's registration binding (contract §3), when one is committed. */
  binding: { catalogId: string; relativePath: string | null } | null;
};

/**
 * The registration gate (contract §3 step 3) for the prepare/bind/selection
 * readers: a root-visible workflow whose catalog registration is not committed
 * refuses `catalog.registration-pending` — a pending operation is never a
 * valid workspace. Pre-activation exclusion (§7 of the issue contract): a
 * missing or staged store is not a catalog verdict, so workspaces without an
 * ACTIVE store keep their pass-through and are never retro-refused here.
 */
async function assertWorkflowRegistrationCommitted(harnessRoot: string, workflowId: string): Promise<void> {
  const context: StoreContext = { harnessDir: harnessRoot };
  let handle: StoreHandle;
  try {
    handle = await openStore(context, "read");
  } catch (error) {
    if (error instanceof StoreError && error.code === "store.not-initialized") return;
    throw error;
  }
  try {
    await assertCatalogExecutionCommitted(context, workflowId);
  } catch (error) {
    // A staged store is the pre-activation exclusion (§7), not a catalog verdict.
    if (error instanceof CatalogError && error.code === "store.not-active") return;
    throw error;
  } finally {
    handle.close();
  }
}

/**
 * The catalog side of a pin read. These are read-only lookups over the
 * catalog tables (`store_meta`, `catalog_entities`, `catalog_links`,
 * `catalog_execution_bindings`) — the same tables the registration journal
 * reads to resolve its own state; no mutation ever goes through here, and
 * every catalog WRITE stays on the domain verbs.
 *
 * A missing database is `store: "absent"` and a staged one `"inactive"`: a
 * reader discloses that instead of pretending the catalog is empty, and does
 * not refuse — a pre-activation workspace legitimately has unpinned,
 * byte-unchanged snapshots (contract §1/§3).
 */
async function readCatalogPinFacts(harnessRoot: string, workflowId: string, planId: string): Promise<CatalogPinFacts> {
  const context: StoreContext = { harnessDir: harnessRoot };
  let handle: StoreHandle;
  try {
    handle = await openStore(context, "read");
  } catch (error) {
    if (error instanceof StoreError && error.code === "store.not-initialized") {
      return { store: "absent", storeId: null, revision: null, relation_hash: null, binding: null };
    }
    throw error;
  }
  try {
    return catalogPinFactsOn(handle.db, handle.storeId, workflowId, planId);
  } finally {
    handle.close();
  }
}

/**
 * The same catalog facts read through a handle the caller ALREADY owns. The
 * execution transaction opens one handle on the same `store.db`, so a DB
 * `prepare` re-selects its pin under its own write lock through this function
 * instead of opening a second connection — one relation-hash algorithm and one
 * set of catalog lookups for both transports.
 */
export function catalogPinFactsOn(
  db: StoreDb,
  storeId: string,
  workflowId: string,
  planId: string,
): CatalogPinFacts {
  const meta = db.prepare("select authority_state from store_meta where id = 1").get() as
    | { authority_state?: unknown }
    | undefined;
  if (meta?.authority_state !== "active") {
    return { store: "inactive", storeId, revision: null, relation_hash: null, binding: null };
  }
  const entity = db
    .prepare("select revision, root_kind, relative_path from catalog_entities where kind = 'plan' and id = ?")
    .get(planId) as { revision?: unknown; root_kind?: unknown; relative_path?: unknown } | undefined;
  const links = db
    .prepare(
      "select from_kind, from_id, relation, to_kind, to_id, ordinal from catalog_links " +
        "where (from_kind = 'plan' and from_id = ?) or (to_kind = 'plan' and to_id = ?)",
    )
    .all(planId, planId) as Array<Record<string, unknown>>;
  const relationHash = createHash("sha256")
    .update(
      stableJson(
        links
          .map((link) => [link.from_kind, link.from_id, link.relation, link.to_kind, link.to_id, link.ordinal ?? ""].join(" "))
          .sort(),
      ),
      "utf8",
    )
    .digest("hex");
  const binding = db
    .prepare(
      "select catalog_id, pin_json from catalog_execution_bindings where workflow_id = ? and catalog_kind = 'plan' and catalog_id = ?",
    )
    .get(workflowId, planId) as { catalog_id?: unknown; pin_json?: unknown } | undefined;
  let bindingRelativePath: string | null = null;
  if (typeof binding?.pin_json === "string") {
    try {
      const pin = JSON.parse(binding.pin_json) as { relativePath?: unknown };
      if (typeof pin.relativePath === "string") bindingRelativePath = pin.relativePath;
    } catch {
      // An unreadable binding payload is reported as an unknown location,
      // never guessed: the identity comparison below simply cannot confirm it.
    }
  }
  return {
    store: "active",
    storeId,
    revision: typeof entity?.revision === "number" ? entity.revision : null,
    relation_hash: relationHash,
    binding:
      binding !== undefined && typeof binding.catalog_id === "string"
        ? { catalogId: binding.catalog_id, relativePath: bindingRelativePath }
        : null,
  };
}

/**
 * The prepare/execution pin reader for one plan (contract §1). Reads only:
 * the recorded pin comes from the row itself (what the authorized `prepare`
 * wrote) or, when the row carries none, from the workflow's committed
 * registration binding — the imported pin an activated legacy snapshot keeps
 * outside its JSON (contract §1: activation leaves those bytes unchanged).
 */
export async function readExecutionCatalogPin(input: {
  harnessRoot: string;
  workflowId: string;
  planId: string;
  row: unknown;
}): Promise<ExecutionCatalogPinState> {
  const { harnessRoot, workflowId, planId } = input;
  // Selection readers refuse a root-visible workflow with a pending catalog
  // registration before they resolve any pin (contract §3 step 3).
  await assertWorkflowRegistrationCommitted(harnessRoot, workflowId);
  const facts = await readCatalogPinFacts(harnessRoot, workflowId, planId);
  const state: ExecutionCatalogPinState = {
    workflow_id: workflowId,
    plan_id: planId,
    source: null,
    pin: null,
    store: facts.store,
    absence: null,
    current_revision: facts.revision,
    catalog_moved: false,
    conflict: null,
  };
  // The recorded pin lives on the frozen row, so it is readable (and
  // disposable) even when no catalog store exists to verify it against.
  const recorded = recordedPinOf(input.row);
  if (recorded !== null) {
    state.source = "row";
    state.pin = recorded;
    if (facts.store !== "active" || facts.storeId === null) return state;
    if (facts.revision === null) {
      state.conflict =
        `plan ${planId} is pinned to catalog revision ${recorded.entity_revision}, but the catalog no longer holds that plan ` +
        "entity \u2014 resolve the catalog registration explicitly; the pin and the frozen input are both left untouched";
      return state;
    }
    state.catalog_moved = facts.revision !== recorded.entity_revision;
    return state;
  }

  if (facts.store !== "active" || facts.storeId === null) {
    state.absence = facts.store === "absent" ? "store-absent" : "store-inactive";
    return state;
  }
  if (facts.binding === null) {
    state.absence = "unbound";
    return state;
  }
  // The binding is the imported pin: it freezes the workflow's catalog
  // identity, not a revision pointer, so there is nothing to compare beyond
  // that identity (and nothing a later catalog move could invalidate).
  state.source = "binding";
  state.pin = {
    store_id: facts.storeId,
    entity_revision: facts.revision ?? 0,
    document_hash: executionInputHash(input.row, planId),
    relation_hash: facts.relation_hash ?? "",
  };
  if (facts.binding.catalogId !== planId) {
    state.conflict =
      `workflow ${workflowId} is registered against plan ${facts.binding.catalogId}, but this row is plan ${planId} \u2014 ` +
      "the binding and the frozen execution input disagree; neither side is overwritten";
  } else if (facts.binding.relativePath !== null && !planFileNamesLocation(input.row, facts.binding.relativePath)) {
    state.conflict =
      `plan ${planId} is registered at ${facts.binding.relativePath}, but its frozen row names a different document \u2014 ` +
      "re-run the authorized prepare to rebind the input";
  }
  return state;
}

/** Whether a plan row's frozen `file` names the catalog location `relativePath`. */
function planFileNamesLocation(row: unknown, relativePath: string): boolean {
  if (!isPlainObject(row) || !isNonEmptyString(row.file)) return false;
  const file = row.file.replace(/\\/g, "/");
  return file === relativePath || file.endsWith(`/${relativePath}`);
}

/**
 * Refuse `catalog.execution-pin-conflict` when this plan's frozen execution
 * input and its recorded pin disagree (contract §1). The execution consumer
 * calls this before it starts consuming the input; a plan with no pin (no
 * catalog, or an unbound plan) is left to the JSON execution protocol.
 */
export async function assertExecutionCatalogPin(input: {
  harnessRoot: string;
  workflowId: string;
  planId: string;
  row: unknown;
}): Promise<void> {
  const state = await readExecutionCatalogPin(input);
  if (state.conflict === null) return;
  throw new ExecutionPinConflictError(state.conflict, {
    workflow_id: state.workflow_id,
    plan_id: state.plan_id,
    source: state.source,
    pin: state.pin,
    current_revision: state.current_revision,
    catalog_moved: state.catalog_moved,
  });
}

/**
 * The same §1 selection decided from facts the caller already read: the
 * catalog identity a `prepare` freezes is that row's current revision and
 * relation hash, and the document half is the frozen input's own hash — never a
 * hash recomputed from a row that may have moved. `null` when the catalog
 * cannot select this plan, and then the caller clears any stale pin instead of
 * leaving it behind.
 *
 * The DB transport reads the facts through its OWN handle inside the
 * transaction that writes them (`catalogPinFactsOn`), so the revision recorded
 * is the one no concurrent catalog write can change before commit.
 */
export function selectCatalogPinOn(facts: CatalogPinFacts, documentHash: string): CatalogExecutionPin | null {
  if (facts.store !== "active" || facts.storeId === null || facts.revision === null) return null;
  return {
    store_id: facts.storeId,
    entity_revision: facts.revision,
    document_hash: documentHash,
    relation_hash: facts.relation_hash ?? "",
  };
}

/* ------------------------------------------------------------------------ *
 * § Plan-area evidence checks (shared with the ACTIVE route)
 * ------------------------------------------------------------------------ */

/**
 * §D the two areas a plan's own evidence may live in: `{PLAN_DIR}` and
 * `{SDD_DIR}/<plan-id>`, derived from the harness configuration and plan identity.
 */
export function planAreaRoots(harnessRoot: string, planId: string): string[] {
  return [
    canonicalizeNearestExisting(resolvePlanDir(harnessRoot)),
    canonicalizeNearestExisting(resolveSddDir(harnessRoot, planId)),
  ];
}

/**
 * Absolute, existing evidence inside one plan's own plan/SDD area. Both
 * transports derive their areas from the addressed plan and harness layout.
 */
export function assertEvidenceInsidePlanArea(roots: readonly string[], paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw invalidInput("Evidence path must be absolute and inside the plan area. Inspect the plan scope with mstar plan show. Pass the plan id registered in the workflow row.", { path });
    }
    const abs = canonicalizeNearestExisting(path);
    if (!roots.some((root) => isWithin(root, abs))) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        "Evidence path is outside the plan's plan/SDD area. Inspect the plan scope with mstar plan show. Pass the plan id registered in the workflow row.",
        { path: abs, allowed: roots },
      );
    }
    if (!existsSync(abs)) {
      throw new CoordinationError("coordination.invalid-input", "Evidence path does not exist inside the plan's plan/SDD area. Inspect the plan scope with mstar plan show. Pass the plan id registered in the workflow row.", { path: abs });
    }
  }
}

/** A full Git object id (40- or 64-hex); abbreviations are never expanded. */
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** In-flight Git operations: a checkout holding one is never proof. */
const UNFINISHED_GIT_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
];

export type GitCheckout = { head: string; clean: boolean; operation: string | undefined };

/**
 * How long one read-only Git read may take. The snapshot write lock waits 30s,
 * so a `git` that never answers (a stalled filesystem, a contended lock) has to
 * give up well short of it rather than hold the row for the whole budget.
 */
const GIT_READ_TIMEOUT_MS = 10_000;


/**
 * One own property of an unknown thrown value, read without asserting a shape.
 */
function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.entries(value).find(([name]) => name === key)?.[1];
}

/**
 * The environment could not answer a Git read — a missing or non-executable
 * `git`, or a read that outlived its timeout. That says nothing about whether a
 * branch merged or diverged, so it is refused as its own failure instead of
 * being reported as repository state (spec §E — nothing is repaired by
 * guessing).
 */
function gitUnavailable(cwd: string, args: readonly string[], error: unknown): CoordinationError {
  const code = propertyOf(error, "code");
  const signal = propertyOf(error, "signal");
  const message = propertyOf(error, "message");
  const timedOut = code === "ETIMEDOUT";
  const cause = timedOut
    ? `git did not answer within ${GIT_READ_TIMEOUT_MS}ms${typeof signal === "string" ? ` (${signal})` : ""}`
    : typeof code === "string"
      ? code
      : typeof message === "string"
        ? message
        : String(error);
  return new CoordinationError(
    "coordination.git-unavailable",
    "Git state cannot be read. Inspect workflow registration with mstar status validate. Git availability requires a readable checkout.",
    { path: cwd, command: `git ${args.join(" ")}`, cause },
  );
}

/**
 * One read-only `git` read. Every argument is a separate argv entry, so branch
 * names, worktree paths and revisions never reach a shell.
 *
 * A non-zero exit is the repository answering — no such object, not an
 * ancestor, not a worktree — and resolves to `undefined`. An error without an
 * exit status means `git` itself never answered, which is refused rather than
 * folded into `undefined` (see `gitUnavailable`).
 *
 * DB proofs run before SQLite ownership. Final synchronous, read-only Git
 * identity/branch/status probes at commit retain actual checkout facts without
 * file-byte witnesses; they never await or take a harness lock.
 */
export function gitRead(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: GIT_READ_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    if (typeof propertyOf(error, "status") === "number") return undefined;
    throw gitUnavailable(cwd, args, error);
  }
}

export function gitObjectExists(cwd: string, sha: string): boolean {
  return gitRead(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined;
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitRead(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== undefined;
}

/** `undefined` when `path` is not a readable Git worktree. */
function gitCheckout(path: string): GitCheckout | undefined {
  const head = gitRead(path, ["rev-parse", "HEAD"]);
  if (head === undefined || !GIT_OBJECT_ID.test(head)) return undefined;
  const dirty = gitRead(path, ["status", "--porcelain"]);
  if (dirty === undefined) return undefined;
  let operation: string | undefined;
  for (const [marker, label] of UNFINISHED_GIT_OPERATIONS) {
    const markerPath = gitRead(path, ["rev-parse", "--git-path", marker]);
    if (markerPath !== undefined && markerPath.length > 0 && existsSync(resolve(path, markerPath))) {
      operation = label;
      break;
    }
  }
  return { head, clean: dirty.length === 0, operation };
}

/** Current Git identity, not a seal of repository or document bytes. */
export type GitProofWitness = Readonly<{
  repository: string;
  refusal: "coordination.git-proof" | "coordination.integration-diverged";
  gitDir: string;
  commonDir: string;
  gitIdentity: readonly [number, number];
  commonIdentity: readonly [number, number];
  head: string;
  ref: string | null;
}>;

function gitDirectoryIdentity(path: string): readonly [number, number] {
  const stat = statSync(path);
  return [Number(stat.dev), Number(stat.ino)];
}

function currentGitHead(gitDir: string, commonDir: string): { head: string; ref: string | null } {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return { head, ref: null };
  const ref = head.slice(5);
  for (const root of [gitDir, commonDir]) {
    const path = join(root, ref);
    if (existsSync(path)) return { head: readFileSync(path, "utf8").trim(), ref };
  }
  const packed = join(commonDir, "packed-refs");
  const entry = existsSync(packed)
    ? readFileSync(packed, "utf8").split("\n").find((line) => line.split(" ")[1] === ref)
    : undefined;
  return { head: entry?.split(" ")[0] ?? "", ref };
}

/** Capture identity before SQLite ownership; no document contents are retained. */
export function captureGitProofWitness(
  cwd: string,
  refusal: GitProofWitness["refusal"] = "coordination.git-proof",
): GitProofWitness {
  const repository = canonicalTarget(resolve(cwd));
  const gitDir = gitRead(repository, ["rev-parse", "--absolute-git-dir"]);
  const common = gitRead(repository, ["rev-parse", "--git-common-dir"]);
  const head = gitRead(repository, ["rev-parse", "HEAD"]);
  if (gitDir === undefined || common === undefined || head === undefined) {
    throw new CoordinationError(refusal, "Cannot read the Git checkout. Inspect registered scope with mstar plan show. Pass the plan id registered in the workflow row.", { repository });
  }
  const commonDir = canonicalTarget(resolve(repository, common));
  const current = currentGitHead(gitDir, commonDir);
  if (current.head !== head) {
    throw new CoordinationError(refusal, "Git HEAD changed between reads. Inspect registered scope with mstar plan show. Pass the plan id registered in the workflow row.", { repository, expected: head, actual: current.head });
  }
  return {
    repository, refusal, gitDir, commonDir,
    gitIdentity: gitDirectoryIdentity(gitDir),
    commonIdentity: gitDirectoryIdentity(commonDir),
    head, ref: current.ref,
  };
}

/** Verify checkout identity, branch, HEAD and unfinished operations, never file hashes. */
export function revalidateGitProofWitness(witness: GitProofWitness): void {
  let current: ReturnType<typeof currentGitHead>;
  try {
    const routing = gitRead(witness.repository, [
      "--no-optional-locks", "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir",
    ])?.split("\n");
    if (routing?.length !== 2 ||
        canonicalTarget(routing[0]!) !== canonicalTarget(witness.gitDir) ||
        canonicalTarget(routing[1]!) !== witness.commonDir) {
      throw new CoordinationError(
        witness.refusal,
        "Git checkout routing changed. Inspect source registration with mstar plan show. Pass the plan id registered in the workflow row.",
        { repository: witness.repository },
      );
    }
    const gitIdentity = gitDirectoryIdentity(witness.gitDir);
    const commonIdentity = gitDirectoryIdentity(witness.commonDir);
    current = currentGitHead(witness.gitDir, witness.commonDir);
    if (
      gitIdentity[0] === witness.gitIdentity[0] && gitIdentity[1] === witness.gitIdentity[1] &&
      commonIdentity[0] === witness.commonIdentity[0] && commonIdentity[1] === witness.commonIdentity[1] &&
      current.ref === witness.ref && current.head === witness.head &&
      gitRead(witness.repository, ["--no-optional-locks", "status", "--porcelain"]) === "" &&
      !UNFINISHED_GIT_OPERATIONS.some(([marker]) =>
        existsSync(join(witness.gitDir, marker)) || existsSync(join(witness.commonDir, marker)))
    ) return;
  } catch (error) {
    if (error instanceof CoordinationError) throw error;
    throw new CoordinationError(witness.refusal, "Cannot re-read Git identity. Inspect source registration with mstar plan show. Pass the plan id registered in the workflow row.", { repository: witness.repository });
  }
  throw new CoordinationError(
    witness.refusal,
    "Git checkout identity, branch, HEAD, cleanliness, or operation state changed. Inspect source registration with mstar plan show. Pass the plan id registered in the workflow row.",
    { repository: witness.repository, expected: witness.head, actual: current.head },
  );
}



/**
 * Feature-side proof (spec §D): the pinned commit is what the recorded plan
 * worktree has checked out, the worktree is clean, and no Git operation is
 * half-finished. Required at handoff, accept and integration-start. The
 * worktree is the persisted plan scope — never an evidence field — so both
 * transports hand this rule the scope their own authority records.
 */
export function assertFeatureCheckout(worktreePath: string, sourceSha: string, what: string, planId: string): void {
  const checkout = gitCheckout(worktreePath);
  if (checkout === undefined) {
    throw new CoordinationError(
      "coordination.not-in-git",
      "The recorded plan worktree is not a readable Git worktree. Its registered scope is available with mstar plan show. Pass the plan id registered in the workflow row.",
      { plan_id: planId, worktree_path: worktreePath },
    );
  }
  if (checkout.operation !== undefined) {
    throw gitProof(
      "The plan worktree has an unfinished Git operation. Restore the recorded plan worktree, finish or abort its Git operation, then retry.",
      { plan_id: planId, operation: checkout.operation },
    );
  }
  if (!checkout.clean) {
    throw gitProof("The plan worktree has uncommitted changes. Restore the recorded plan worktree to a clean state before retrying.", {
      plan_id: planId,
      head: checkout.head,
    });
  }
  if (checkout.head !== sourceSha) {
    throw gitProof(
      "The plan worktree HEAD does not match the pinned source. Restore the pinned commit before retrying.",
      { plan_id: planId, expected: sourceSha, actual: checkout.head },
    );
  }
}

/**
 * The recorded integration checkout: readable, on its recorded target branch,
 * and free of uncommitted changes or half-finished Git operations (spec §E).
 */
export function assertIntegrationCheckout(anchors: IntegrationAnchors, planId: string): GitCheckout {
  const checkout = gitCheckout(anchors.worktreePath);
  if (checkout === undefined) {
    throw integrationDiverged(
      `plan ${planId} integration checkout ${anchors.worktreePath} is not a readable Git worktree`,
      { plan_id: planId, worktree_path: anchors.worktreePath },
    );
  }
  const branch = gitRead(anchors.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== anchors.targetBranch) {
    throw integrationDiverged(
      `plan ${planId} integration checkout ${anchors.worktreePath} is on ${branch || "a detached HEAD"}, not the recorded target ${anchors.targetBranch}`,
      { plan_id: planId, expected: anchors.targetBranch, actual: branch },
    );
  }
  if (checkout.operation !== undefined || !checkout.clean) {
    throw integrationUnresolved(
      `plan ${planId} integration checkout ${anchors.worktreePath} ${
        checkout.operation === undefined ? "has uncommitted changes" : `has an unfinished ${checkout.operation}`
      } \u2014 finish or abort it, then retry`,
      { plan_id: planId, operation: checkout.operation, head: checkout.head },
    );
  }
  return checkout;
}

/** What proving one integration attempt from the pinned objects yields (spec §E). */
export type IntegrationProof =
  | { kind: "proven"; resultSha: string }
  | { kind: "pending" }
  | { kind: "diverged"; reason: string };

/**
 * Prove the attempt from the pinned objects (spec §E): the pinned base must
 * still be an ancestor of `head`, the integration HEAD the proof is taken
 * against — otherwise the checkout has moved on and no merge in it belongs to
 * this attempt. Given that, either the source was already an ancestor of the
 * recorded base, or the first-parent path from the base to `head` carries
 * exactly one merge whose parents are exactly base then source. Zero
 * candidates is `pending` (nothing merged yet); several are `diverged` — a
 * result is never picked out of a set.
 */
export function integrationProof(path: string, head: string, baseSha: string, sourceSha: string): IntegrationProof {
  if (!gitObjectExists(path, baseSha)) {
    return { kind: "diverged", reason: `the pinned base ${baseSha} is unavailable` };
  }
  if (!gitObjectExists(path, sourceSha)) {
    return { kind: "diverged", reason: `the pinned source ${sourceSha} is unavailable` };
  }
  if (!gitObjectExists(path, head)) {
    return { kind: "diverged", reason: `the integration HEAD ${head} is unavailable` };
  }
  if (!gitIsAncestor(path, baseSha, head)) {
    return {
      kind: "diverged",
      reason: `the pinned base ${baseSha} is not an ancestor of the integration HEAD ${head}`,
    };
  }
  if (gitIsAncestor(path, sourceSha, baseSha)) return { kind: "proven", resultSha: baseSha };
  const range = gitRead(path, ["rev-list", "--first-parent", "--parents", `${baseSha}..${head}`]);
  if (range === undefined) {
    return { kind: "diverged", reason: `the first-parent path ${baseSha}..HEAD is unreadable` };
  }
  // One call carries the parents of every commit on the path: the proof never
  // spawns a Git process per commit, and a commit whose parents the repository
  // cannot report is a diverged path rather than a silently skipped candidate.
  const candidates = range
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((line) => line.split(" ").map((entry) => entry.trim()).filter((entry) => entry.length > 0))
    .filter((ids) => ids.length === 3 && ids[1] === baseSha && ids[2] === sourceSha)
    .map((ids) => ids[0]);
  if (candidates.length === 0) return { kind: "pending" };
  if (candidates.length > 1) {
    return {
      kind: "diverged",
      reason: `${candidates.length} merges of ${sourceSha} onto ${baseSha} exist (${candidates.join(", ")})`,
    };
  }
  return { kind: "proven", resultSha: candidates[0] };
}

/* ------------------------------------------------------------------------ *
 * § Prepare amendment component identity (shared with the ACTIVE route)
 * ------------------------------------------------------------------------ */

/**
 * The only `plan_parallelism` values the approved concurrency contract names.
 *
 * Exported because the ACTIVE DB route's `execution-policy` transition applies
 * the SAME closed set (E08): one rule, two authority routes, no second list to
 * drift (`execution-workflow.ts` no longer mirrors it).
 */
export const PLAN_PARALLELISM_VALUES: readonly string[] = ["serial", "parallel"];

/**
 * The stable identity of one amendment component, as BOTH authority routes
 * report it (`recovery.applied`, `unresolved[].component`): the transports
 * consume ONE component vocabulary whether the effect was committed on the
 * supported file route or on the ACTIVE DB route (E08).
 */
export function prepareAmendmentComponent(
  kind: "append" | "correct-plan-file" | "integration-worktree" | "execution-policy",
  value: string,
): string {
  return kind === "append" ? `append plan ${value}` : kind === "correct-plan-file" ? `correct-plan-file ${value}` : `${kind} ${value}`;
}

