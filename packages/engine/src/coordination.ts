/**
 * Coordinator plan operations and protected workflow artifact writers.
 *
 * Row intents are prepare, progress, residual-add, residual-close and complete.
 * FILE writes hold the snapshot lock before issue-store transactions; ACTIVE
 * authority routes through the execution store instead of these file writers.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson, type GateResult } from "./core.js";
import {
  COORDINATION_ERROR_CODES,
  CoordinationError,
  assertExactKeys,
  canonicalTarget,
  isNonEmptyString,
  isPlainObject,
  readArtifactBytes,
  evidenceRefOf,
  sha256Bytes,
  validatePlanProgress,
  validateRowCoordination,
  withProtectedWrite,
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
import { findRegisteredWorkflow, rowPlanIds, unregisterWorkflow, validatePlanRow, validateStatusV2, type PlanRow, type StatusV2Doc } from "./status.js";
import { getArtifactStore, resolveArtifactPath, type ArtifactRef, type ArtifactStore } from "./store.js";
import {
  StoreError,
  assertExecutionFileReadAllowed,
  assertExecutionFileWriteAllowed,
  openStore,
  type StoreContext,
  type StoreDb,
  type StoreHandle,
} from "./store-db.js";
import { validateActivationAttestation, type ActivationAttestation } from "./store-activation.js";
import {
  IssueError,
  assertIssueProvenanceSchema,
  assertPlanIssueSession,
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
  closeWorkflow,
  deriveLifecyclePhase,
  isCloseTimestamp,
  isStandaloneDevelopmentWorkflow,
  isStandaloneReportOnlyWorkflow,
  isTerminalSnapshot,
  rowValidationRoute,
  consultDeliveryEvidence,
  readWorkflowSnapshot,
  stableJson,
  validateWorkflowSnapshot,
  PREPARE_PHASE,
  WORKFLOW_TERMINAL_STATUSES,
  writeWorkflowSnapshot,
  type WorkflowBranchAnchors,
  type WorkflowExecutionPolicy,
  type WorkflowSnapshot,
} from "./workflow.js";
import { MSTAR_REVIEW_V1_PAYLOAD_SCHEMA } from "./qcreview-schema.js";
import { WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA, STATUS_V2_PAYLOAD_SCHEMA } from "./persist-payload-schemas.js";

/**
 * Persist payload contracts are owned by their validating domains. `json` is
 * intentionally syntax-only: arbitrary JSON has no domain validator; use the
 * status, snapshot, or review kind for governed documents.
 *
 * Published as BOTH a value (`PERSIST_PAYLOAD_CONTRACTS`) and a callable
 * (`persistPayloadContracts`). The value's one previously-cyclic input
 * (`WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA`) lives in the acyclic leaf
 * `workflow-payload-schema.ts`, so the top-level binding is TDZ-safe in every
 * import order; `packages/commands` reads it inside command construction.
 */
export const PERSIST_PAYLOAD_CONTRACTS = {
  status: { schema: STATUS_V2_PAYLOAD_SCHEMA, validation: "status-v2" },
  snapshot: { schema: WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA, validation: "workflow-snapshot" },
  review: { schema: MSTAR_REVIEW_V1_PAYLOAD_SCHEMA, validation: "mstar.review/v1" },
  json: {
    schema: null,
    validation: "parse-only",
    reason: "Arbitrary JSON has no declared domain shape.",
    alternative: "Use status, snapshot, or review for governed artifacts.",
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

/** The workflow-wide coordinator envelope persisted by the engine. */
export type CoordinationSession = {
  schema_version: 1;
  role: "coordinator";
  session_id: string;
  workflow_id: string;
  harness_root: string;
};

/**
 * Bind addressing (spec §B). A fresh bind generates the session UUID and
 * creates `<workflow-dir>/<workflow-id>/sessions/<role>-<session-id>.json`
 * itself, unless the caller supplies `sessionId` — then the engine adopts that
 * value as the identity after validating it as a single safe path component (it
 * names the envelope's file, prefixed by the role). An existing session is
 * reached only through its explicit `resumePath`, which resumes read-only,
 * never writes and never re-identifies.
 */
export type BindPlanSessionInput =
  | {
      coordinator?: true;
      workflowId: string;
      harnessDir?: string;
      source?: "host" | "local";
      cwd: string;
      sessionId?: string;
    }
  | { resumePath: string; cwd: string };

/** One artifact read: payload plus the byte version it was read at. */
export type VersionedArtifact = { payload: unknown; version: string };

/** Scope facts derived from ordinary row metadata and workflow branch anchors. */
export type PlanCoordinationScope = {
  projectId: string;
  worktreePath: string | null;
  workingBranch: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  integrationBranch: string | null;
  integrationWorktreePath: string | null;
};

/** Everything `mstar plan show` needs, in one read. */
export type PlanCoordinationView = {
  revision: number;
  snapshot_version: string;
  scope: PlanCoordinationScope | null;
  row: PlanRow;
  prepared?: PreparedCoordination;
  session: CoordinationSession;
  session_file: string;
  allowed_operations: string[];
  catalog_pin?: ExecutionCatalogPinState;
};

/** One issue a scoped plan operation touched, as the core verb reported it. */
export type CoordinationIssueReceipt = {
  issue_id: string;
  /** The issue revision after the operation — the CAS value for the next mutation. */
  revision: number;
  /** `true` when this call created the issue, `false` on an idempotent replay. */
  created: boolean;
};


/** Success shape of a coordination call. */
export type CoordinationResult = {
  ok: true;
  operation: string;
  session: CoordinationSession;
  session_file: string;
  /** `claimed` / `resumed` / `prepared` / `progressed` / `already-satisfied` / `residual-added` / `residual-closed`. */
  outcome?: string;
  view?: PlanCoordinationView;
  /**
   * §4.1 the recovery sidecar of this call: what it did with the intent, the
   * row it addressed, the facts it reconciled and the commit boundary the
   * caller can rely on. The same object shape a refusal carries under
   * `error.details.recovery`, so one contract covers both paths.
   */
  recovery?: RecoveryDetails;
  /**
   * The issues a scoped issue operation captured or closed, in call order
   * (G2a). The IDs are DB-allocated, so the caller learns them here instead of
   * supplying them, and `revision` is the value `residual-close` must echo
   * back as `expectedIssueRevision`.
   */
  issues?: CoordinationIssueReceipt[];
};

export type ResidualInput = Omit<CaptureInput, "projectId">;
export type PlanCoordinationOperation =
  | { kind: "prepare"; config?: PlanPrepareConfig }
  | { kind: "progress"; progress: PlanProgress }
  | { kind: "residual-add"; entries: ResidualInput[] }
  | { kind: "residual-close"; issueId: string; disposition: TerminalDisposition; evidence: ClosureEvidence; expectedIssueRevision: number }
  | { kind: "complete"; evidence: CompletionEvidence; integration?: IntegrationResultInput };

/**
 * One whole coordination request: one session, one operation, one precondition.
 *
 * § One resolver path (S2/E02) every field but the operation is DERIVABLE, so
 * a public caller states what it actually holds: the bound session envelope, or
 * the acquired identity whose own envelope the engine resolves; the addressed
 * plan; the revision `show` reported. An explicitly supplied value is a
 * CONSTRAINT — it is validated exactly as before, never replaced — so a fully
 * specified caller keeps this surface's behavior byte for byte.
 */
export type CoordinationRequest = {
  /** The bound coordinator envelope (absolute); omitted → the identity's own envelope. */
  sessionPath?: string;
  /** Sparse intent: the process context the trusted control root is resolved from. */
  cwd?: string;
  /** Sparse intent: the trusted control root the caller already holds (never re-derived from Git). */
  controlRoot?: string;
  /**
   * Sparse intent: the caller's independently acquired identity — a SELECTOR
   * for the workflow/plan and for its own envelope, never authority. A role
   * string or session reference authorizes nothing on its own.
   */
  identity?: ExecutionIdentity;
  /** Explicit plan selection required for every coordinator operation. */
  planId: string;
  /**
   * The selected row's `coordination.revision` from `show` (absent row = 0).
   * §4.2 this is transport FRESHNESS, not the intent: a token whose revision
   * moved is reported as provenance (`recovery.warnings`) and the operation's
   * own record, read under the lock, decides whether the intent is already
   * satisfied, still applicable, or in conflict with another writer's work.
   * Omitted → the revision the addressed row carries when this call resolves
   * it, which is the value `show` would have handed the caller.
   */
  expectedRevision?: number;
  operation: PlanCoordinationOperation;
};

type RowRequest = { expectedRevision: number };
type PrepareRequest = RowRequest & { config?: PlanPrepareConfig };
type ProgressCoordinationRequest = RowRequest & { progress: PlanProgress };
type ResidualAddCoordinationRequest = RowRequest & { entries: ResidualInput[] };
type ResidualCloseCoordinationRequest = RowRequest & {
  issueId: string;
  disposition: TerminalDisposition;
  evidence: ClosureEvidence;
  expectedIssueRevision: number;
};
type CompleteRequest = RowRequest & { evidence: CompletionEvidence; integration?: IntegrationResultInput };

/** Coordinator replacement of a coordinated artifact (spec §B). */
export type CoordinatedReplacement = {
  harnessRoot: string;
  ref: ArtifactRef;
  payload: unknown;
  /** Required for snapshot replacement (the coordinator session envelope). */
  sessionPath?: string;
};

/* ------------------------------------------------------------------------ *
 * § Constants
 * ------------------------------------------------------------------------ */

const SESSION_DIR = "sessions";
const SNAPSHOT_FILE = "snapshot.json";
const ENVELOPE_KEYS = ["schema_version", "role", "session_id", "workflow_id", "harness_root"] as const;

/* ------------------------------------------------------------------------ *
 * § Small helpers
 * ------------------------------------------------------------------------ */

/** ISO-8601 timestamp for `prepared_at` / `bound_at` / snapshot `updated_at`. */
function nowIso(): string {
  return new Date().toISOString();
}


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
    throw new CoordinationError("coordination.invalid-input", `${what} is invalid \u2014 ${summarize(violations)}`, {
      violations: violations.map((entry) => entry.code),
    });
  }
}

function snapshotPathOf(harnessRoot: string, workflowId: string): string {
  return join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), workflowId, SNAPSHOT_FILE);
}

/** Canonical workflow coordinator envelope path. */
export function sessionFilePath(
  harnessRoot: string,
  workflowId: string,
  role: CoordinationRole,
  sessionId: string,
): string {
  return join(
    resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }),
    workflowId,
    SESSION_DIR,
    `${role}-${sessionId}.json`,
  );
}

/**
 * The canonical local store, pinned to `harnessRoot`. A remote/injected store
 * cannot serve this surface: every caller resolves paths from the same
 * FsStore path table, so a non-local store is refused rather than silently
 * writing somewhere else.
 */
function localStore(harnessRoot: string): ArtifactStore & { root: string } {
  let store: ArtifactStore;
  try {
    store = getArtifactStore();
  } catch (error) {
    throw new CoordinationError(
      "coordination.local-store-required",
      `no artifact store is resolvable from ${resolve(process.cwd())} \u2014 scoped coordination requires createFsStore(<control harness root>): ${errorMessage(error)}`,
      { harness_root: harnessRoot },
    );
  }
  const root = "root" in store ? store.root : undefined;
  if (typeof root !== "string") {
    throw new CoordinationError(
      "coordination.local-store-required",
      "the active ArtifactStore exposes no local root \u2014 scoped coordination requires the canonical FsStore",
      { harness_root: harnessRoot },
    );
  }
  const actual = canonicalTarget(root);
  const expected = canonicalTarget(harnessRoot);
  if (actual !== expected) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `active ArtifactStore root ${actual} does not match the resolved control harness root ${expected}`,
      { expected, actual },
    );
  }
  // Narrowed by the `root` presence + string check above: this is the FsStore
  // contract (`createFsStore` is the only local-root implementation).
  const local = store as ArtifactStore & { root: string };
  return local;
}

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
  for (let dir = start; ; dir = dirname(dir)) {
    let linked = false;
    try {
      linked = statSync(join(dir, ".git")).isFile();
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (linked) {
      throw new CoordinationError(
        "coordination.not-in-git",
        `${start} is a linked checkout (${join(dir, ".git")} is a file) whose main worktree is unreadable \u2014 refusing to resolve a process harness root from local artifacts`,
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

/**
 * The refusal of an unresolved resolution, in the frozen coordination
 * vocabulary: the problem's `needed` is the actionable message, the problem
 * itself is the caller's question, and the contract's sidecar travels under
 * `details.recovery` so the refusal prose is never the whole report.
 */
function refuseResolution(problem: RecoveryProblem, resolvedFrom: readonly ResolutionSource[]): never {
  const code = (COORDINATION_ERROR_CODES as readonly string[]).includes(problem.code)
    ? (problem.code as CoordinationErrorCode)
    : "coordination.invalid-input";
  // The message names the unresolved fact AND the facts currently true, so a
  // consumer that renders only prose still sees the conflict it must decide.
  throw new CoordinationError(code, `${problem.needed}: ${problem.currentFacts.join("; ")}`, {
    component: problem.component,
    path: problem.path,
    sources_tried: problem.sourcesTried,
    current_facts: problem.currentFacts,
    available_work: problem.availableWork,
    recovery: unresolvedRecovery({ target: {}, unresolved: [problem], resolvedFrom }),
  });
}

/* ------------------------------------------------------------------------ *
 * Explicit row addressing
 * ------------------------------------------------------------------------ */

export type PlanScopeInput = { workflowId: string; planId: string; harnessDir?: string };

export type ResolvedPlanScope = PlanCoordinationScope & {
  harnessRoot: string;
  workflowId: string;
  planId: string;
  planPath: string;
  sddDir: string;
  snapshotPath: string;
};

/** `true` when `planId` is safe to use as a single path component. */
function safePlanId(planId: string, where: string): string {
  try {
    assertSafePathComponent(planId, where);
  } catch (error) {
    throw invalidInput(`${where} ${JSON.stringify(planId)} is not a safe path component: ${errorMessage(error)}`, {
      plan_id: planId,
    });
  }
  return planId;
}

/**
 * The caller-supplied session identity, validated **before any write**. The id
 * names the envelope's file (`sessionFilePath`), so a value that could name
 * another directory or another file is refused here rather than left to a
 * filesystem error. `undefined` keeps the engine-generated UUID. The rule
 * itself is the shared public-session-id contract the recovery stop assertion
 * uses too — one validator, not two.
 */
function safeSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidInput("sessionId must be a string");
  return assertSafeSessionId(value, "session id");
}

/* ------------------------------------------------------------------------ *
 * § Scope resolution
 * ------------------------------------------------------------------------ */


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
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
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
      `workflow snapshot is unreadable or invalid at ${snapshotPath}: ${errorMessage(error)}`,
      { path: snapshotPath },
    );
  }
}

function findPlanRow(snapshot: WorkflowSnapshot, planId: string): { row: PlanRow; index: number } {
  const matches = snapshot.plans
    .map((row, index) => ({ row, index }))
    .filter((entry) => rowPlanIds(entry.row).includes(planId));
  if (matches.length === 0) {
    throw new CoordinationError("coordination.plan-not-found", `plan ${planId} is not a row of workflow ${snapshot.id}`, {
      workflow_id: snapshot.id,
      plan_id: planId,
    });
  }
  if (matches.length > 1) {
    throw new CoordinationError(
      "coordination.store",
      `workflow ${snapshot.id} has ${matches.length} rows claiming plan id ${planId} \u2014 refusing to pick one`,
      { workflow_id: snapshot.id, plan_id: planId },
    );
  }
  return matches[0];
}



/** Resolve recorded row source facts; no Assignment bytes or preparation ceremony. */
export async function resolvePlanScope(input: PlanScopeInput, cwd: string = process.cwd()): Promise<ResolvedPlanScope> {
  if (!isPlainObject(input)) throw invalidInput("scope input must name a workflow and plan");
  assertExactKeys(input, ["workflowId", "planId", "harnessDir"], "scope input");
  if (!isNonEmptyString(input.workflowId) || !isNonEmptyString(input.planId)) {
    throw invalidInput("workflowId and planId are required; select the explicit row with plan show");
  }
  const workflowId = safePlanId(input.workflowId, "workflowId");
  const planId = safePlanId(input.planId, "planId");
  const harnessRoot = requireProcessRoot(cwd, input.harnessDir);
  const snapshotPath = snapshotPathOf(harnessRoot, workflowId);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  const { row } = findPlanRow(snapshot, planId);
  const projectId = projectBucketOf(row);
  if (!isNonEmptyString(row.file)) throw invalidInput(`plan ${planId} has no registered file; supply its canonical plan file through workflow registration or Prepare amendment`);
  const plan = resolveRegisteredPlanFile({ harnessRoot, planId, file: row.file });
  const recorded = planScopeOfMetadata(row, snapshot);
  return {
    harnessRoot,
    workflowId,
    planId,
    projectId,
    worktreePath: recorded?.worktreePath ?? null,
    workingBranch: recorded?.workingBranch ?? null,
    sourceBranch: recorded?.sourceBranch ?? null,
    targetBranch: recorded?.targetBranch ?? null,
    integrationBranch: recorded?.integrationBranch ?? null,
    integrationWorktreePath: recorded?.integrationWorktreePath ?? null,
    planPath: plan.planPath,
    sddDir: canonicalTarget(resolveSddDir(harnessRoot, planId)),
    snapshotPath,
  };
}

/* ------------------------------------------------------------------------ *
 * § Session envelopes
 * ------------------------------------------------------------------------ */

/** Read and validate a session envelope (throws `coordination.session-*`). */
export function readSessionEnvelope(sessionPath: string): CoordinationSession {
  if (!isNonEmptyString(sessionPath) || !isAbsolute(sessionPath)) {
    throw invalidInput("sessionPath must be an absolute path");
  }
  const abs = resolve(sessionPath);
  if (!existsSync(abs)) {
    throw new CoordinationError("coordination.session-not-found", `session envelope not found: ${abs}`, { path: abs });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", `session envelope is not valid JSON: ${abs}: ${errorMessage(error)}`, {
      path: abs,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new CoordinationError("coordination.store", `session envelope must be an object: ${abs}`, { path: abs });
  }
  assertExactKeys(parsed, ENVELOPE_KEYS, `session envelope ${abs}`);
  if (parsed.schema_version !== 1) {
    throw invalidInput(`session envelope ${abs} must declare schema_version 1`, { path: abs });
  }
  const role = parsed.role;
  if (role !== "coordinator") {
    throw new CoordinationError("coordination.invalid-input", `session envelope ${abs} has role ${JSON.stringify(role)}`, {
      path: abs,
    });
  }
  const sessionId = parsed.session_id;
  const workflowId = parsed.workflow_id;
  const harnessRoot = parsed.harness_root;
  if (!isNonEmptyString(sessionId)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty session_id`, { path: abs });
  }
  if (!isNonEmptyString(workflowId)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty workflow_id`, { path: abs });
  }
  if (!isNonEmptyString(harnessRoot)) {
    throw invalidInput(`session envelope ${abs} requires a non-empty harness_root`, { path: abs });
  }
  if (!isAbsolute(harnessRoot)) {
    throw invalidInput(`session envelope ${abs} harness_root must be absolute`, { path: abs });
  }
  const session: CoordinationSession = {
    schema_version: 1,
    role,
    session_id: sessionId,
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
  return session;
}

/** An entry boundary's own authority anchor: the session envelope the call is
 * about to use, plus the control harness root it names. */
type EntryAnchor = { session: CoordinationSession; harnessRoot: string };

/**
 * Resolve the ONE thing an entry-boundary authority veto needs before it can
 * decide anything: the session envelope that names the control harness this
 * call belongs to (`store-db`'s `storeDbPath` resolves the process/control
 * root from the harness root recorded here).
 *
 * This is the ENTIRE entry boundary (spec §4.3/§5) for the coordinated
 * entries that take a `sessionPath`: the envelope carries no authority of its
 * own and no request payload, version token, operation shape or scope is
 * inspected here, so nothing in the call body can pre-empt the refusal with a
 * payload error. A `sessionPath` that cannot address an envelope refuses with
 * the envelope reader's own `coordination.invalid-input` — there is then no
 * control harness to discriminate against.
 */
function entryAnchor(sessionPath: unknown): EntryAnchor {
  const session = readSessionEnvelope(sessionPath as string);
  return { session, harnessRoot: canonicalizeNearestExisting(session.harness_root) };
}

function createSessionEnvelope(session: CoordinationSession): string {
  // Canonical authority discrimination precedes the file creation below
  // (spec §4.3): with an ACTIVE execution authority the session-envelope file
  // is retired as a persistence route, so a bind refuses before any byte or
  // the snapshot it would accompany is written.
  assertExecutionFileWriteAllowed({ harnessDir: session.harness_root });
  const path = sessionFilePath(session.harness_root, session.workflow_id, session.role, session.session_id);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new CoordinationError(
        "coordination.identity-mismatch",
        `session envelope already exists: ${path}; use plan bind --resume with that coordinator envelope instead of re-binding`,
        { path },
      );
    }
    throw new CoordinationError("coordination.store", `cannot create session envelope ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  return path;
}

function dropSessionEnvelope(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* the bind failed; a leftover envelope is harmless but never trusted */
  }
}

/* ------------------------------------------------------------------------ *
 * § Snapshot reads + writers
 * ------------------------------------------------------------------------ */

/** Assert the resolved snapshot path is the store's own path for this ref. */
function assertSnapshotPath(harnessRoot: string, workflowId: string, snapshotPath: string): string {
  const fromTable = resolveArtifactPath(harnessRoot, { kind: "snapshot", key: workflowId });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(snapshotPath)) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `resolved snapshot path ${snapshotPath} is not the store's ${fromTable}`,
      { expected: fromTable, actual: snapshotPath },
    );
  }
  return snapshotPath;
}

/** Validate + write the snapshot inside the protected-write context. */
async function commitSnapshot(
  harnessRoot: string,
  workflowId: string,
  snapshotPath: string,
  next: WorkflowSnapshot,
): Promise<void> {
  const store = localStore(harnessRoot);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);
  const gate = validateWorkflowSnapshot(next);
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `refusing to write a snapshot that fails validation \u2014 ${summarize(gate.violations)}`,
      { violations: gate.violations.map((entry) => entry.code) },
    );
  }
  await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "snapshot", key: workflowId, payload: next }));
}

type RowCommit = {
  row: PlanRow;
  coordination: RowCoordination;
  /** Snapshot-level fields this row mutation owns (e.g. the merge lease). */
  topLevel?: Partial<WorkflowSnapshot>;
  /** Snapshot-level keys this row mutation deletes in the same write. */
  dropTopLevel?: readonly string[];
};

type RowContext = {
  scope: ResolvedPlanScope;
  snapshot: WorkflowSnapshot;
  row: PlanRow;
  rowIndex: number;
  coordination: RowCoordination | undefined;
  revision: number;
};

/**
 * §4.2 the effect one file-route operation's read-only admission RECOGNISED in
 * the row it just read: the row already holds exactly the effect this intent
 * asks for, so current state is the success the caller asked for (R6/A09/A12).
 * `field` and `source` are the provenance a consumer reads to see WHERE the
 * effect was found instead of where it was written.
 */
type RowSatisfied = Readonly<{ field: string; source: string }>;

/**
 * One operation's read-only admission of the row this call reads under its own
 * lock. Returning nothing proceeds with the intent; returning `RowSatisfied`
 * answers from current state without writing; THROWING is the operation's own
 * relevant conflict (A11) — the frame turns it into the typed cause below.
 */
type RowAdmission = (context: RowContext) => void | RowSatisfied | Promise<void | RowSatisfied>;

/**
 * §4.1 how a mutation whose effect lands OUTSIDE this row discloses the
 * components it commits as it goes: it reports each one the moment that commit
 * stands, so a failure on a later component is refused as a partial boundary
 * (the applied components enumerated, the remainder named) instead of as the
 * "nothing moved" an atomic effect earns. A mutation that commits nothing
 * outside simply never calls it.
 */
type ExternalCommitReporter = (component: string) => void;

type RowFrameResult = {
  snapshot: WorkflowSnapshot;
  row: PlanRow;
  /** `null` when this call applied the intent; the recognised effect otherwise. */
  satisfied: RowSatisfied | null;
  /** `true` when the operation's own mutation committed (its effect landed now). */
  applied: boolean;
  /** §4.2/§4.3 non-fatal facts beside the effect (a drifted token). */
  warnings: readonly ResolutionWarning[];
  recovery: RecoveryDetails;
};

/**
 * §4.1/§4.2 the sidecar of one file-route row mutation: what this call did with
 * the intent, the row it addressed and the commit boundary the caller can rely
 * on. The same object shape a refusal carries under `error.details.recovery`,
 * mirroring the DB frames' `planRecovery`.
 *
 * `commitState` is `committed` only when THIS call landed the effect (its own
 * commit boundary — the row write, or the composed effect a mutation lands in
 * another authority) and `none` when it answered an effect that was already
 * held, because that call wrote nothing: the recorded state IS the commit.
 */
function rowFrameRecovery(input: {
  scope: ResolvedPlanScope;
  kind: string;
  satisfied: RowSatisfied | null;
  applied: boolean;
  warnings: readonly ResolutionWarning[];
}): RecoveryDetails {
  const applied = input.satisfied === null && input.applied;
  return {
    outcome: applied ? "applied" : "already-satisfied",
    target: { workflowId: input.scope.workflowId, planId: input.scope.planId },
    applied: applied ? [`${input.kind} on plan ${input.scope.planId}`] : [],
    unresolved: [],
    // Where the answer came from: the request itself when this call applied it,
    // the record the operation recognised, or — when the operation's own
    // mutation decided nothing was left to do — that same stored row.
    resolvedFrom: applied
      ? [{ path: input.kind, source: "intent.request" }]
      : input.satisfied !== null
        ? [{ path: input.satisfied.field, source: input.satisfied.source }]
        : [{ path: input.kind, source: "stored plan row" }],
    warnings: [...input.warnings],
    commitState: applied ? "committed" : "none",
  };
}

/** §4.2 (R7/A10) the provenance fact of a token whose revision moved, never a refusal. */
function tokenDriftedWarning(input: {
  scope: ResolvedPlanScope;
  kind: string;
  readRevision: number;
  currentRevision: number;
}): ResolutionWarning {
  return {
    code: "coordination.token-drifted",
    path: "expectedRevision",
    message:
      `the token carries row revision ${input.readRevision} while plan ${input.scope.planId} is at revision ` +
      `${input.currentRevision}: the revision is transport freshness, so the ${input.kind} intent was decided against ` +
      "the row this call read instead of being refused",
  };
}

/**
 * Refusal codes that name an unavailable PREREQUISITE (a capability this call
 * genuinely needs and could not read) rather than a conflict on the row's own
 * record: the store and the Git facts behind the operation's proofs. They keep
 * their own code and are reported as a capability fact with the commit boundary
 * the caller can rely on and the work that remains possible (A25).
 */
function isPrerequisiteRefusal(code: string): boolean {
  return code.startsWith("store.") || code === "coordination.store" || code === "coordination.not-in-git" || code === "coordination.git-unavailable";
}

/** Attach the recovery sidecar to an existing refusal without changing its code. */
function withRowRecoveryDetails<T>(error: T, details: Record<string, unknown>): T {
  if (error === null || typeof error !== "object") return error;
  // The thrown value is always one of the engine's own error classes (they all
  // carry a mutable `details` record), and this is the same access the shared
  // `withRecoveryDetails` performs — narrowed to a named target so the write is
  // reachable for an error that has not been given `details` yet.
  const target = error as { details?: Record<string, unknown> };
  target.details = { ...(target.details ?? {}), ...details };
  return error;
}

/**
 * §4.1/§4.2 (A11/A13/A25) the typed cause of one refused file-route row
 * operation: the row as this call read it, the refused operation, the commit
 * boundary the caller can rely on (nothing moved) and the work that remains
 * possible. The refusal keeps its own code, message and field details; the
 * sidecar is what makes the report complete (mirrors the DB frames'
 * conflict/prerequisite causes).
 */
function rowFrameRefusal(
  error: unknown,
  input: {
    scope: ResolvedPlanScope;
    kind: string;
    context: RowContext;
    warnings: readonly ResolutionWarning[];
    /**
     * §4.1 the components a mutation had ALREADY committed in another authority
     * when it refused (`withRowCommit` collects them from the mutation's
     * `ExternalCommitReporter`): the refusal then reports that partial boundary
     * instead of the "nothing moved" an atomic effect earns.
     */
    appliedOutside?: readonly string[];
  },
): unknown {
  const refusalCode = errorCode(error) ?? "coordination.invalid-input";
  const declared = error !== null && typeof error === "object" && "details" in error ? error.details : undefined;
  const declaredPath = isPlainObject(declared) ? declared.path : undefined;
  // §6.2 an operation that declared its own §R5 report (a recorded decision
  // that is genuinely absent — `missingDecision`) keeps it: the report names
  // the one fact the caller must obtain, and this frame adds the row's own
  // commit boundary and drift warning to it instead of replacing it with the
  // generic problem. Both routes then report the SAME object for the same
  // state; every other refusal keeps the generic report below.
  const declaredReport =
    isPlainObject(declared) && isPlainObject((declared as Record<string, unknown>).recovery)
      ? ((declared as Record<string, unknown>).recovery as RecoveryDetails)
      : undefined;
  const prerequisite = isPrerequisiteRefusal(refusalCode);
  const message = errorMessage(error);
  const appliedOutside = input.appliedOutside ?? [];
  const partialOutside = appliedOutside.length > 0;
  const problem: RecoveryProblem = {
    component: prerequisite ? "operation-prerequisite" : "plan-row",
    path: isNonEmptyString(declaredPath) ? declaredPath : prerequisite ? input.kind : "expectedRevision",
    code: refusalCode,
    sourcesTried: [
      `${input.scope.snapshotPath} as this call reads it under its own write lock`,
      `the ${input.kind} operation's own admission rules for the facts it depends on`,
      ...(partialOutside ? ["the issue authority this mutation had already committed in"] : []),
    ],
    currentFacts: [
      `plan ${input.scope.planId} is at row revision ${input.context.revision} (status ${rowStatusOf(input.context.row) || "none"})`,
      `the refusal reports: ${message}`,
      ...(partialOutside
        ? [
            `before refusing, the ${input.kind} had already committed ${appliedOutside.length} component(s) in the issue authority: ${appliedOutside.join("; ")}`,
            "the components after the failing one were not attempted, and the failing component's own commit boundary is unknown \u2014 a retry must reconcile them",
          ]
        : []),
    ],
    needed: message,
    withheldEffect: prerequisite
      ? `the ${input.kind} operation: a prerequisite it genuinely needs could not be read, so plan ${input.scope.planId}, its ` +
        "coordination block and every revision are exactly as they were"
      : partialOutside
        ? `the rest of the ${input.kind} operation: ${appliedOutside.length} component(s) had already committed in the issue ` +
          "authority when the call refused and they are not rolled back, so plan " +
          `${input.scope.planId}'s snapshot is not the whole story`
        : `the ${input.kind} operation and its whole transaction: plan ${input.scope.planId}, its coordination block and every ` +
          "revision are exactly as they were",
    availableWork: [
      `read plan ${input.scope.planId} and its current row state`,
      partialOutside
        ? `retry the ${input.kind} operation exactly as it was requested: every component it already committed is ` +
          "operation-id idempotent, so the repeat settles those components and completes the remainder"
        : `retry the ${input.kind} operation once the conflicting fact is resolved`,
      "independent operations on other rows, plans and workflows continue",
    ],
  };
  return withRowRecoveryDetails(error, {
    ...(declaredReport === undefined
      ? {
          component: problem.component,
          path: problem.path,
          sources_tried: problem.sourcesTried,
          current_facts: problem.currentFacts,
          available_work: problem.availableWork,
        }
      : {}),
    workflow_id: input.scope.workflowId,
    plan_id: input.scope.planId,
    current_revision: input.context.revision,
    recovery: partlyAppliedRecovery(
      declaredReport === undefined
        ? unresolvedRecovery({
            target: { workflowId: input.scope.workflowId, planId: input.scope.planId },
            unresolved: [problem],
            warnings: input.warnings,
          })
        : { ...declaredReport, warnings: [...declaredReport.warnings, ...input.warnings] },
      appliedOutside,
    ),
  });
}

/**
 * §4.1 the recovery sidecar of a refusal that committed components in another
 * authority before it refused: `partial` is the boundary the caller can rely on
 * and `applied` enumerates exactly what stands. A refusal that committed
 * nothing keeps the `unresolved`/`none` `unresolvedRecovery` reports.
 */
function partlyAppliedRecovery(recovery: RecoveryDetails, applied: readonly string[]): RecoveryDetails {
  if (applied.length === 0) return recovery;
  return { ...recovery, outcome: "partial", applied: [...applied], commitState: "partial" };
}

/**
 * The single locked read-reconcile-mutate-write path for one plan row.
 *
 * `expectedRevision: null` means "no revision precondition" (bind only). The
 * whole section runs under the snapshot write lock, so the read, the semantic
 * checks and the write are atomic against other coordinated writers.
 *
 * §4.2 the frame's reconciliation, mirroring the DB frames' state intents:
 *
 * - the row revision is TRANSPORT freshness, never business intent. A token
 *   whose revision moved is recorded as provenance (`coordination.token-drifted`)
 *   and the intent is decided against the row this call reads under its own
 *   lock, so a sibling or non-semantic change recomputes instead of blocking (A10).
 * - the operation's own read-only admission decides relevance. A fact it
 *   depends on having moved is its own typed refusal, disclosed with the exact
 *   fields and the one decision left — another writer's relevant work is never
 *   overwritten (A11/A13).
 */
async function withRowCommit(
  scope: ResolvedPlanScope,
  opts: {
    kind: string;
    expectedRevision: number | null;
    precheck: RowAdmission;
    /**
     * §4.1 the mutation reports every component it commits outside this row
     * through the second argument, so a failure on a later component refuses
     * with the applied boundary instead of claiming nothing moved.
     */
    mutate: (
      context: RowContext,
      reportExternalCommit: ExternalCommitReporter,
    ) => RowCommit | null | Promise<RowCommit | null>;
    /**
     * §4.1 a mutation whose effect lands OUTSIDE this row (the two residual verbs
     * compose the core issue authority): it returns no row commit, yet the call
     * did land its effect, so the sidecar reports that committed boundary.
     */
    effectOutsideRow?: boolean;
  },
): Promise<RowFrameResult> {
  localStore(scope.harnessRoot);
  assertSnapshotPath(scope.harnessRoot, scope.workflowId, scope.snapshotPath);
  const result = await withStatusWriteLock(scope.snapshotPath, async () => {
    const snapshot = readSnapshot(dirname(scope.snapshotPath));
    const { row, index } = findPlanRow(snapshot, scope.planId);
    const coordination = rowCoordinationOf(row);
    const context: RowContext = {
      scope,
      snapshot,
      row,
      rowIndex: index,
      coordination,
      revision: coordination?.revision ?? 0,
    };
    const warnings: readonly ResolutionWarning[] =
      opts.expectedRevision !== null && context.revision !== opts.expectedRevision
        ? [
            tokenDriftedWarning({
              scope,
              kind: opts.kind,
              readRevision: opts.expectedRevision,
              currentRevision: context.revision,
            }),
          ]
        : [];
    let satisfied: RowSatisfied | null = null;
    try {
      satisfied = (await opts.precheck(context)) ?? null;
    } catch (error) {
      throw rowFrameRefusal(error, { scope, kind: opts.kind, context, warnings });
    }
    if (satisfied !== null) return { snapshot, row, satisfied, applied: false, warnings };
    let commit: RowCommit | null;
    // §4.1 the components (if any) this mutation commits in another authority,
    // in call order: a failure after them refuses on that partial boundary.
    const committedOutside: string[] = [];
    try {
      commit = await opts.mutate(context, (component) => committedOutside.push(component));
    } catch (error) {
      throw rowFrameRefusal(error, {
        scope,
        kind: opts.kind,
        context,
        warnings,
        appliedOutside: committedOutside,
      });
    }
    if (commit === null) return { snapshot, row, satisfied: null, applied: false, warnings };
    const nextSnapshot: WorkflowSnapshot = {
      ...snapshot,
      ...(commit.topLevel ?? {}),
      updated_at: nowIso(),
      plans: snapshot.plans.map((entry, i) => (i === index ? commit.row : entry)),
    };
    for (const key of commit.dropTopLevel ?? []) {
      delete (nextSnapshot as Record<string, unknown>)[key];
    }
    await commitSnapshot(scope.harnessRoot, scope.workflowId, scope.snapshotPath, nextSnapshot);
    return { snapshot: nextSnapshot, row: commit.row, satisfied: null, applied: true, warnings };
  });
  return {
    ...result,
    recovery: rowFrameRecovery({
      scope,
      kind: opts.kind,
      satisfied: result.satisfied,
      applied: result.applied || (opts.effectOutsideRow === true && result.satisfied === null),
      warnings: result.warnings,
    }),
  };
}

/** A coordinator session must match the snapshot's coordinator binding. */
function assertCoordinatorBinding(session: CoordinationSession, sessionPath: string, snapshot: WorkflowSnapshot): void {
  const coordinator = snapshot.coordination?.coordinator;
  if (coordinator === undefined) {
    throw new CoordinationError(
      "coordination.identity-missing",
      `workflow ${snapshot.id} has no coordinator binding; use plan bind for this workflow first`,
      { workflow_id: snapshot.id },
    );
  }
  if (coordinator.session_id !== session.session_id) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `workflow ${snapshot.id} is bound to coordinator ${coordinator.session_id}, not ${session.session_id}; resume the recorded envelope or recover the stopped coordinator through workflow recover-coordinator`,
      { expected: coordinator.session_id, actual: session.session_id },
    );
  }
  if (canonicalTarget(coordinator.session_file) !== canonicalTarget(sessionPath)) {
    throw new CoordinationError(
      "coordination.identity-mismatch",
      `coordinator envelope ${sessionPath} is not the recorded ${coordinator.session_file}; resume the recorded envelope with plan bind --resume`,
      { expected: coordinator.session_file, actual: canonicalTarget(sessionPath) },
    );
  }
}

/** Ordinary row writes require the workflow coordinator, not a per-row seat. */
function assertMutableRow(context: RowContext, session: CoordinationSession, sessionPath: string, what: string): void {
  assertCoordinatorBinding(session, sessionPath, context.snapshot);
  if (context.snapshot.status !== "running") {
    throw new CoordinationError("coordination.workflow-not-running", `${what} requires running workflow ${context.snapshot.id}; resume it through workflow lifecycle before retrying`, { status: context.snapshot.status });
  }
  if (rowStatusOf(context.row) === "Done") {
    throw new CoordinationError("coordination.plan-status", `${what} cannot revise completed plan ${context.scope.planId}; register a new plan for further work`, { plan_id: context.scope.planId });
  }
}



/* ------------------------------------------------------------------------ *
 * § Reads
 * ------------------------------------------------------------------------ */

function buildView(
  harnessRoot: string,
  workflowId: string,
  projectId: string,
  scope: PlanCoordinationScope | null,
  snapshot: WorkflowSnapshot,
  row: PlanRow,
  session: CoordinationSession,
  sessionPath: string,
): PlanCoordinationView {
  const coordination = rowCoordinationOf(row);
  const snapshotBytes = readArtifactBytes(snapshotPathOf(harnessRoot, workflowId));
  return {
    revision: coordination?.revision ?? 0,
    snapshot_version: snapshotBytes?.version ?? "absent",
    scope,
    row,
    prepared: coordination?.prepared,
    session,
    session_file: canonicalTarget(sessionPath),
    allowed_operations: allowedOperations(session.role, row),
  };
}
function planScopeOfMetadata(row: PlanRow, snapshot: WorkflowSnapshot): PlanCoordinationScope | null {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  const worktreePath = isNonEmptyString(metadata.worktree_path) ? canonicalTarget(metadata.worktree_path) : null;
  const workingBranch = isNonEmptyString(metadata.working_branch) ? metadata.working_branch : null;
  if (worktreePath === null && workingBranch === null) return null;
  const branch = isPlainObject(snapshot.branch) ? snapshot.branch : {};
  return {
    projectId: projectBucketOf(row),
    worktreePath,
    workingBranch,
    sourceBranch: isNonEmptyString(branch.source) ? branch.source : null,
    targetBranch: isNonEmptyString(branch.target) ? branch.target : null,
    integrationBranch: isNonEmptyString(branch.integration) ? branch.integration : null,
    integrationWorktreePath: isNonEmptyString(snapshot.integration_worktree_path)
      ? canonicalTarget(snapshot.integration_worktree_path)
      : null,
  };
}

/** Read the explicitly selected row as the workflow coordinator. */
export async function readPlanCoordination(
  sessionPath: string,
  planId: string,
  cwd: string = process.cwd(),
): Promise<PlanCoordinationView> {
  if (!isNonEmptyString(planId)) throw invalidInput("planId is required to select a plan");
  const anchor = entryAnchor(sessionPath);
  assertExecutionFileReadAllowed({ harnessDir: anchor.harnessRoot });
  const session = anchor.session;
  const targetPlanId = safePlanId(planId, "planId");
  const rootResolution = resolveIntentRoot({ cwd }, { root: anchor.harnessRoot, source: "session.envelope" });
  if (!rootResolution.ok) refuseResolution(rootResolution.problem, rootResolution.resolvedFrom);
  const harnessRoot = rootResolution.root;
  localStore(harnessRoot);
  const snapshotPath = snapshotPathOf(harnessRoot, session.workflow_id);
  assertSnapshotPath(harnessRoot, session.workflow_id, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  const { row } = findPlanRow(snapshot, targetPlanId);
  assertCoordinatorBinding(session, sessionPath, snapshot);
  const scope = planScopeOfMetadata(row, snapshot);
  return {
    ...buildView(harnessRoot, session.workflow_id, projectBucketOf(row), planScopeOfMetadata(row, snapshot), snapshot, row, session, sessionPath),
    catalog_pin: await readExecutionCatalogPin({ harnessRoot, workflowId: session.workflow_id, planId: targetPlanId, row }),
  };
}


/**
 * Read one coordinated artifact plus its byte version, from a **single** byte
 * read. `payload` is `undefined` and `version` is `"absent"` when the document
 * does not exist. Snapshot payloads are validated before they are handed out.
 *
 * Read veto at the entry boundary (spec §4.3/§5): `harnessRoot` is this entry's
 * own anchor, so the verdict precedes the `ref` shape check and the byte read —
 * a direct consumer of this authoritative surface cannot observe retired
 * root/snapshot bytes while the execution authority is ACTIVE, and an
 * unreadable store refuses here instead of serving them.
 */
export async function readCoordinatedArtifact(
  harnessRoot: string,
  ref: ArtifactRef,
): Promise<VersionedArtifact> {
  if (typeof harnessRoot === "string" && isAbsolute(harnessRoot)) {
    assertExecutionFileReadAllowed({ harnessDir: harnessRoot });
  }
  if (!isPlainObject(ref) || !isNonEmptyString(ref.kind) || !isNonEmptyString(ref.key)) {
    throw invalidInput("ref must be an ArtifactRef with kind and key");
  }
  const root = canonicalizeNearestExisting(harnessRoot);
  localStore(root);
  const path = resolveArtifactPath(root, ref);
  const bytes = readArtifactBytes(path);
  if (bytes === undefined) return { payload: undefined, version: "absent" };
  if (bytes.payload !== undefined) assertStoredArtifact(ref.kind, bytes.payload, path, root);
  return { payload: bytes.payload, version: bytes.version };
}

/**
 * Validate a stored artifact against its kind's owner validator. The read
 * surface fails loud on invalid content instead of handing out a document the
 * scoped writers would refuse to write back.
 */
function assertStoredArtifact(kind: string, payload: unknown, path: string, harnessRoot: string): void {
  let gate: GateResult | undefined;
  if (kind === "snapshot") gate = validateWorkflowSnapshot(payload);
  else if (kind === "status") gate = validateStatusV2(payload as StatusV2Doc, { harnessDir: harnessRoot });
  if (gate === undefined || gate.ok) return;
  throw new CoordinationError(
    "coordination.store",
    `${kind} ${path} fails validation \u2014 ${summarize(gate.violations)}`,
    { path, kind, violations: gate.violations.map((entry) => entry.code) },
  );
}


/**
 * Root register check (spec §C1): the workflow must be an active entry. The
 * entry is returned so callers that must re-check its declared lifecycle
 * status (the Prepare amendment) read the same document this check accepted.
 */
function assertRootRegisterEntry(harnessRoot: string, workflowId: string): Record<string, unknown> {
  const store = localStore(harnessRoot);
  const path = resolveArtifactPath(harnessRoot, { kind: "status", key: "root" });
  if (!existsSync(path)) {
    throw new CoordinationError("coordination.workflow-not-found", `root status.json not found: ${path}`, { path });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", `root status.json is not valid JSON: ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  const workflows = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
  const entry = workflows.find(
    (candidate) => isPlainObject(candidate) && candidate.id === workflowId,
  );
  if (entry === undefined) {
    throw new CoordinationError(
      "coordination.workflow-not-found",
      `workflow ${workflowId} is not an active entry of ${path} (kind ${store.root})`,
      { path, workflow_id: workflowId },
    );
  }
  // Boundary cast: the predicate above proved a plain object.
  return entry as Record<string, unknown>;
}

/** Coordinator residency (spec §C1): main worktree or recorded integration worktree.
 *
 * The Git-derived checkout is READ here, so an unavailable Git fact refuses for
 * the callers that genuinely need one. A caller for whom the checkout is only a
 * prerequisite of some of its components reads the checkout itself and runs
 * `assertCoordinatorCheckoutResidency` when Git answered — a local repair then
 * proceeds on its trusted envelope root instead of adding a global environment
 * gate (R12/A24).
 */
function assertCoordinatorResidency(cwd: string, snapshot: WorkflowSnapshot): MainWorktreeInfo {
  const main = readMainWorktree(cwd);
  if (main === null) {
    throw new CoordinationError(
      "coordination.not-in-git",
      `coordinator binding requires a Git process root \u2014 ${resolve(cwd)} has no readable main worktree`,
      { cwd: resolve(cwd) },
    );
  }
  assertCoordinatorCheckoutResidency(main, cwd, snapshot);
  return main;
}

/** The residency comparison itself, against a main worktree Git actually answered. */
function assertCoordinatorCheckoutResidency(main: MainWorktreeInfo, cwd: string, snapshot: WorkflowSnapshot): void {
  const here = canonicalizeNearestExisting(cwd);
  const allowed = [canonicalTarget(main.root)];
  const integration = snapshot.integration_worktree_path;
  if (isNonEmptyString(integration)) allowed.push(canonicalizeNearestExisting(integration));
  if (!allowed.some((candidate) => isWithin(candidate, here))) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `a coordinator session must be bound from the main worktree or the recorded integration worktree \u2014 ${here} is neither (${allowed.join(", ")})`,
      { cwd: here, allowed },
    );
  }
}

/** Bind the caller's workflow-wide coordinator and its durable envelope atomically. */
async function bindCoordinatorSession(
  cwd: string,
  workflowId: string,
  harnessDir?: string,
  sessionId?: string,
  source?: "host" | "local",
): Promise<CoordinationResult> {
  const harnessRoot = requireProcessRoot(cwd, harnessDir);
  safePlanId(workflowId, "workflowId");
  // Direct local bootstrap may mint a safe coordinator id; host adapters supply
  // their acquired identity explicitly. Both forms bind only this workflow.
  const identity: ExecutionIdentity = {
    source: source ?? "local",
    sessionId: sessionId ?? randomUUID(),
    workflowId,
    role: "coordinator",
  };
  validateExecutionIdentity(identity, { workflowId, role: "coordinator" });
  const snapshotPath = snapshotPathOf(harnessRoot, workflowId);
  assertSnapshotPath(harnessRoot, workflowId, snapshotPath);

  assertCoordinatorResidency(cwd, readSnapshot(dirname(snapshotPath)));
  const session: CoordinationSession = {
    schema_version: 1,
    role: "coordinator",
    session_id: identity.sessionId,
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
  let created = "";
  try {
    await withStatusWriteLock(snapshotPath, async () => {
      const snapshot = readSnapshot(dirname(snapshotPath));
      if (snapshot.status !== "running") {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `workflow ${workflowId} is ${String(snapshot.status)} \u2014 a coordinator session binds only to a running lifecycle`,
          { workflow_id: workflowId, status: snapshot.status },
        );
      }
      assertRootRegisterEntry(harnessRoot, workflowId);
      // A root-visible workflow with a pending catalog registration is never a
      // valid workspace to bind (contract §3 step 3).
      await assertWorkflowRegistrationCommitted(harnessRoot, workflowId);
      const existing = snapshot.coordination?.coordinator;
      if (existing !== undefined) {
        throw new CoordinationError(
          "coordination.identity-mismatch",
          `workflow ${workflowId} already has coordinator ${existing.session_id}; use plan bind --resume ${existing.session_file}, or recover the stopped coordinator through workflow recover-coordinator`,
          { holder: existing.session_id, session_file: existing.session_file },
        );
      }
      created = createSessionEnvelope(session);
      const next: WorkflowSnapshot = {
        ...snapshot,
        updated_at: nowIso(),
        coordination: {
          coordinator: { session_id: session.session_id, session_file: canonicalTarget(created), bound_at: nowIso() },
        },
      };
      await commitSnapshot(harnessRoot, workflowId, snapshotPath, next);
    });
  } catch (error) {
    if (created !== "") dropSessionEnvelope(created);
    throw error;
  }
  // No `view`: a coordinator session binds the lifecycle, not one plan row —
  // the caller selects a plan explicitly (`plan show --plan <id>`).
  return { ok: true, operation: "bind", session, session_file: created, outcome: "bound" };
}


function requireProcessRoot(cwd: string, harnessDir?: string): string {
  const root = resolveProcessHarnessDir(cwd, harnessDir);
  if (root === null) {
    throw new CoordinationError(
      "coordination.harness-not-found",
      `no harness root is resolvable from ${resolve(cwd)} \u2014 pass the control harness root explicitly`,
      { cwd: resolve(cwd) },
    );
  }
  return root;
}

/** Bind the workflow coordinator, or verify its existing envelope read-only. */
export async function bindPlanSession(input: BindPlanSessionInput): Promise<CoordinationResult> {
  if (!isPlainObject(input)) throw invalidInput("bind input must be an object");
  if ("resumePath" in input) {
    assertExactKeys(input, ["resumePath", "cwd"], "bind resume input");
    requireCwd(input.cwd);
    return resumeBoundSession(input.resumePath);
  }
  assertExactKeys(input, ["coordinator", "workflowId", "harnessDir", "source", "cwd", "sessionId"], "bind coordinator input");
  if (input.coordinator !== undefined && input.coordinator !== true) throw invalidInput("only the workflow coordinator can bind; omit coordinator or set it to true");
  if (!isNonEmptyString(input.workflowId)) throw invalidInput("workflowId is required");
  requireCwd(input.cwd);
  const sessionId = safeSessionId(input.sessionId);
  return bindCoordinatorSession(input.cwd, input.workflowId, input.harnessDir, sessionId, input.source);
}

/** Every bind form is a cooperative local call: it needs a real cwd. */
function requireCwd(cwd: string): void {
  if (!isNonEmptyString(cwd) || !isAbsolute(cwd)) throw invalidInput("bind input requires an absolute cwd");
}

/** Resume is a read-only verification of the workflow coordinator binding. */
function resumeBoundSession(resumePath: string): CoordinationResult {
  if (!isNonEmptyString(resumePath) || !isAbsolute(resumePath)) {
    throw invalidInput("resumePath must be an absolute path");
  }
  const sessionPath = canonicalTarget(resumePath);
  const session = readSessionEnvelope(sessionPath);
  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  localStore(harnessRoot);
  const snapshotPath = snapshotPathOf(harnessRoot, session.workflow_id);
  assertSnapshotPath(harnessRoot, session.workflow_id, snapshotPath);
  const snapshot = readSnapshot(dirname(snapshotPath));
  assertCoordinatorBinding(session, sessionPath, snapshot);
  return { ok: true, operation: "bind", session, session_file: sessionPath, outcome: "resumed" };
}

/* ------------------------------------------------------------------------ *
 * § Catalog execution pin (state-projection contract §1)
 * ------------------------------------------------------------------------ */

/** Stable refusal code for malformed, foreign or missing catalog selections. */
export const EXECUTION_PIN_CONFLICT_CODE = "catalog.execution-pin-conflict";

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
 * The pin the authorized `prepare` records for one row: `null` when the
 * catalog cannot select this plan's input (no store, staged store, or the plan
 * is not registered), in which case `prepare` writes no pin rather than
 * inventing one.
 */
async function selectCatalogPin(harnessRoot: string, workflowId: string, planId: string, row: unknown): Promise<CatalogExecutionPin | null> {
  return selectCatalogPinOn(await readCatalogPinFacts(harnessRoot, workflowId, planId), executionInputHash(row, planId));
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
 * § mutatePlanCoordination
 * ------------------------------------------------------------------------ */

/** Absolute, existing evidence inside the plan's own plan/SDD area. */
function assertEvidenceInsidePlan(scope: ResolvedPlanScope, paths: readonly string[]): void {
  assertEvidenceInsidePlanArea([canonicalizeNearestExisting(dirname(scope.planPath)), scope.sddDir], paths);
}

/**
 * §D the two areas a plan's own evidence may live in: `{PLAN_DIR}` and
 * `{SDD_DIR}/<plan-id>`. A prepared plan's Assignment is required to name
 * exactly these (see `scopeFromAssignment`), so a transport that reads its plan
 * identity from the store derives them here instead of trusting a caller file.
 */
export function planAreaRoots(harnessRoot: string, planId: string): string[] {
  return [
    canonicalizeNearestExisting(resolvePlanDir(harnessRoot)),
    canonicalizeNearestExisting(resolveSddDir(harnessRoot, planId)),
  ];
}

/**
 * Absolute, existing evidence inside one plan's own plan/SDD area. Shared by
 * both transports: the file route passes the areas its prepared scope pins, the
 * DB route the areas its own plan identity derives.
 */
export function assertEvidenceInsidePlanArea(roots: readonly string[], paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw invalidInput(`evidence path must be absolute: ${path}`, { path });
    }
    const abs = canonicalizeNearestExisting(path);
    if (!roots.some((root) => isWithin(root, abs))) {
      throw new CoordinationError(
        "coordination.path-mismatch",
        `evidence path ${path} is outside this plan's own plan/SDD area (${roots.join(", ")})`,
        { path: abs, allowed: roots },
      );
    }
    if (!existsSync(abs)) {
      throw new CoordinationError("coordination.invalid-input", `evidence path does not exist: ${path}`, { path: abs });
    }
  }
}

const PROTECTED_SOURCE_BRANCHES: Readonly<Record<string, true>> = { main: true, master: true, develop: true, dev: true };

async function assertRecordedSourceCheckout(scope: ResolvedPlanScope, snapshot: WorkflowSnapshot, worktreePath: string, workingBranch: string): Promise<void> {
  if (!isAbsolute(worktreePath)) throw invalidInput("config.worktreePath must be absolute; revise it with plan prepare");
  const root = gitRead(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) throw gitProof(`cannot read source checkout ${worktreePath}; restore the recorded Git checkout and retry prepare`);
  const checkoutRoot = canonicalTarget(root);
  if (checkoutRoot !== canonicalTarget(worktreePath)) throw invalidInput("config.worktreePath must be the Git checkout root; revise it with plan prepare", { worktree_path: worktreePath, checkout_root: checkoutRoot });
  const main = readMainWorktree(worktreePath);
  const control = readMainWorktree(scope.harnessRoot);
  if (main === null || (control !== null && canonicalTarget(main.root) !== canonicalTarget(control.root))) {
    throw invalidInput("the recorded source checkout must belong to this workflow repository; select its owned feature checkout with plan prepare");
  }
  if (canonicalTarget(main.root) === checkoutRoot || checkoutRoot === canonicalTarget(snapshot.integration_worktree_path ?? scope.harnessRoot)) {
    throw invalidInput("the plan source must not be the primary or integration checkout; select its owned feature worktree with plan prepare");
  }
  if (PROTECTED_SOURCE_BRANCHES[workingBranch] === true || workingBranch === snapshot.branch?.target || workingBranch === snapshot.branch?.integration) {
    throw invalidInput("the plan source branch must differ from protected target and integration branches; revise workingBranch with plan prepare", { working_branch: workingBranch });
  }
  const actual = gitRead(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (actual !== workingBranch) throw invalidInput("the source checkout does not match workingBranch; checkout the recorded branch or revise it with plan prepare", { working_branch: workingBranch, actual });
}

async function mutatePrepare(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: PrepareRequest,
): Promise<CoordinationResult> {
  const config = request.config ?? {};
  if (!isPlainObject(config)) throw invalidInput("prepare config must be an object");
  assertExactKeys(config, ["worktreePath", "workingBranch", "qaGate", "findingsCleanup"], "prepare config");
  if (config.worktreePath !== undefined && (!isNonEmptyString(config.worktreePath) || !isAbsolute(config.worktreePath))) throw invalidInput("config.worktreePath must be an absolute source checkout path");
  if (config.workingBranch !== undefined && !isNonEmptyString(config.workingBranch)) throw invalidInput("config.workingBranch must name the source feature branch");
  if (config.qaGate !== undefined && !["mandatory", "pm-acceptance"].includes(config.qaGate)) throw invalidInput("config.qaGate must be mandatory or pm-acceptance");
  if (config.findingsCleanup !== undefined && !["allow-residual", "zero-residual"].includes(config.findingsCleanup)) throw invalidInput("config.findingsCleanup must be allow-residual or zero-residual");
  let prepared: PreparedCoordination;
  let metadata: Record<string, unknown>;
  const result = await withRowCommit(scope, {
    kind: "prepare",
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      assertPrepareAdmission({ planId: scope.planId, row: context.row });
      assertMutableRow(context, session, sessionPath, "prepare");
      const current = context.coordination?.prepared;
      const recorded = isPlainObject(context.row.metadata) ? context.row.metadata : {};
      const worktreePath = config.worktreePath !== undefined ? canonicalTarget(config.worktreePath) : recorded.worktree_path;
      const workingBranch = config.workingBranch ?? recorded.working_branch;
      if (config.worktreePath !== undefined || config.workingBranch !== undefined) {
        if (!isNonEmptyString(worktreePath) || !isNonEmptyString(workingBranch)) throw invalidInput("source configuration needs both worktreePath and workingBranch; provide the missing source fact with plan prepare");
        await assertRecordedSourceCheckout(scope, context.snapshot, worktreePath, workingBranch);
      }
      const qaGate = config.qaGate ?? current?.qa_gate ?? (recorded.qa_gate === "pm-acceptance" ? "pm-acceptance" : "mandatory");
      const findingsCleanup = config.findingsCleanup ?? current?.findings_cleanup ?? (recorded.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual");
      prepared = {
        qa_gate: qaGate,
        findings_cleanup: findingsCleanup,
        prepared_by: session.session_id,
        prepared_at: nowIso(),
      };
      metadata = {
        ...recorded,
        ...(isNonEmptyString(worktreePath) ? { worktree_path: worktreePath } : {}),
        ...(isNonEmptyString(workingBranch) ? { working_branch: workingBranch } : {}),
      };
      await assertWorkflowRegistrationCommitted(scope.harnessRoot, scope.workflowId);
      if (recordedPinOf(context.row) === null) {
        const pin = await selectCatalogPin(scope.harnessRoot, scope.workflowId, scope.planId, context.row);
        if (pin !== null) metadata.catalog_pin = pin;
      }
      if (current !== undefined
        && current.qa_gate === qaGate
        && current.findings_cleanup === findingsCleanup
        && isDeepStrictEqual(recorded, metadata)) {
        return { field: "coordination.prepared", source: "stored plan row" };
      }
    },
    mutate: (context) => {
      const coordination = { ...(context.coordination ?? { revision: 0 }), revision: context.revision + 1, prepared };
      const row = { ...context.row, metadata, coordination };
      return { row, coordination };
    },
  });
  return {
    ok: true, operation: "prepare", session, session_file: sessionPath,
    outcome: result.satisfied === null ? "prepared" : "already-satisfied",
    recovery: result.recovery,
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, planScopeOfMetadata(result.row, result.snapshot), result.snapshot, result.row, session, sessionPath),
  };
}

/**
 * §4.2 (R6/R7/A09/A12) the record one progress report writes, as the row field
 * it lives in and the value this intent asks that field to hold. The selection
 * is the kind's OWN effect — the coordination progress block, the row status and
 * (only when the report constrains them) the reported track branches — never the
 * whole row, its siblings or a revision, so a change anywhere else leaves the
 * effect genuinely held (A10) while the record itself being replaced is
 * disclosed (A11/A13).
 */
function progressEffect(input: {
  progress: PlanProgress;
  row: PlanRow;
  coordination: RowCoordination | undefined;
}): { fields: readonly string[]; current: Record<string, unknown>; requested: Record<string, unknown> } {
  const { progress } = input;
  const record: PlanProgress = {
    status: progress.status,
    summary: progress.summary,
    evidence_paths: [...progress.evidence_paths],
    ...(progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {}),
  };
  return {
    fields: ["coordination.progress", "plan.status", ...(progress.track_branches !== undefined ? ["plan.metadata.track_branches"] : [])],
    current: { coordination: input.coordination ?? {}, plan: input.row },
    requested: {
      coordination: { progress: record },
      plan: {
        status: progress.status,
        metadata: progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {},
      },
    },
  };
}

/**
 * §4.2 (R6/R7/A11/A13) the refusal of a progress report whose record moved
 * since the token this call presents was read: another writer's report IS the
 * record this operation writes, so it is disclosed with both values and the one
 * decision left instead of being overwritten.
 */
function progressRecordConflict(input: {
  progress: PlanProgress;
  row: PlanRow;
  coordination: RowCoordination | undefined;
  planId: string;
  readRevision: number;
  currentRevision: number;
}): CoordinationError {
  const effect = progressEffect(input);
  const field = effect.fields[0]!;
  const current = stableJson(selectSemanticFields(effect.current, effect.fields));
  const requested = stableJson(selectSemanticFields(effect.requested, effect.fields));
  return new CoordinationError(
    "coordination.version-conflict",
    `plan ${input.planId} already holds a different ${field} ${current} than this report asks for ${requested}, written after ` +
      `the token this call presents was read (row revision ${input.currentRevision}, token ${input.readRevision}) \u2014 the ` +
      "recorded report is not overwritten; accept it, or re-read the row and express the report you still want",
    {
      plan_id: input.planId,
      path: field,
      expected: input.readRevision,
      actual: input.currentRevision,
      current_value: current,
      requested_value: requested,
    },
  );
}

async function mutateProgress(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ProgressCoordinationRequest,
): Promise<CoordinationResult> {
  const progress = request.progress;
  assertViolationFree(validatePlanProgress(progress), "progress");
  assertEvidenceInsidePlan(scope, progress.evidence_paths);
  const result = await withRowCommit(scope, {
    kind: "progress",
    expectedRevision: request.expectedRevision,
    precheck: (context) => {
      assertMutableRow(context, session, sessionPath, "progress");
      // Already-recorded field values are current success; compare the named
      // progress fields directly rather than serializing the whole projection.
      const recorded = context.coordination?.progress;
      const rowBranches = isPlainObject(context.row.metadata) ? context.row.metadata.track_branches : undefined;
      const sameEvidencePaths =
        recorded !== undefined &&
        recorded.evidence_paths.length === progress.evidence_paths.length &&
        recorded.evidence_paths.every((path, index) => path === progress.evidence_paths[index]);
      const sameTrackBranches =
        recorded?.track_branches === undefined
          ? progress.track_branches === undefined
          : progress.track_branches !== undefined &&
            recorded.track_branches.length === progress.track_branches.length &&
            recorded.track_branches.every((branch, index) => branch === progress.track_branches![index]);
      const sameRowBranches =
        progress.track_branches === undefined ||
        (Array.isArray(rowBranches) &&
          rowBranches.length === progress.track_branches.length &&
          rowBranches.every((branch, index) => branch === progress.track_branches![index]));
      if (
        recorded?.status === progress.status &&
        recorded.summary === progress.summary &&
        sameEvidencePaths &&
        sameTrackBranches &&
        sameRowBranches &&
        context.row.status === progress.status
      ) {
        return { field: "coordination.progress", source: "stored plan row" };
      }
      // §4.2 (R7/A11/A13) the row moved since the caller read it AND already
      // carries a different report: another writer's work is disclosed, never
      // overwritten. The token revision alone is transport freshness, so the
      // record — not the revision — decides.
      if (context.revision !== request.expectedRevision && context.coordination?.progress !== undefined) {
        throw progressRecordConflict({
          progress,
          row: context.row,
          coordination: context.coordination,
          planId: scope.planId,
          readRevision: request.expectedRevision,
          currentRevision: context.revision,
        });
      }
      requireProgressStatus(context.row, progress.status, scope.planId);
      if (progress.track_branches !== undefined) {
        assertTrackBranches(
          { planId: scope.planId, branch: context.snapshot.branch, plans: context.snapshot.plans },
          progress.track_branches,
        );
      }
    },
    mutate: (context) => {
      const metadata = isPlainObject(context.row.metadata) ? context.row.metadata : {};
      const nextMetadata =
        progress.track_branches !== undefined ? { ...metadata, track_branches: [...progress.track_branches] } : metadata;
      const nextCoordination: RowCoordination = {
        ...(context.coordination ?? { revision: 0 }),
        revision: context.revision + 1,
        progress: {
          status: progress.status,
          summary: progress.summary,
          evidence_paths: [...progress.evidence_paths],
          ...(progress.track_branches !== undefined ? { track_branches: [...progress.track_branches] } : {}),
        },
      };
      assertViolationFree(validateRowCoordination(nextCoordination), `plan ${scope.planId} coordination`);
      const row: PlanRow = { ...context.row, status: progress.status, coordination: nextCoordination };
      if (nextMetadata !== context.row.metadata) row.metadata = nextMetadata;
      return { row, coordination: nextCoordination };
    },
  });
  return {
    ok: true,
    operation: "progress",
    session,
    session_file: sessionPath,
    outcome: result.satisfied === null ? "progressed" : "already-satisfied",
    recovery: result.recovery,
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, planScopeOfMetadata(result.row, result.snapshot), result.snapshot, result.row, session, sessionPath),
  };
}

/* ------------------------------------------------------------------------ *
 * § Residual operations (issue-authority cutover, G2a)
 * ------------------------------------------------------------------------ */

/**
 * The store context that owns this plan's issue authority. The scoped session
 * binding and the row `expectedRevision` were already proven by
 * `mutatePlanCoordination` / `withRowCommit`; the DB mutations below then use
 * the core issue API — capture (operation-id idempotent), plan provenance
 * link, and closure under the mandatory issue `expectedRevision`.
 */
function planStoreContext(scope: ResolvedPlanScope): StoreContext {
  return { harnessDir: scope.harnessRoot };
}

/** Deterministic operation id: one logical capture per session/plan/observation. */
function captureOperationId(scope: ResolvedPlanScope, session: CoordinationSession, occurrenceKey: string): string {
  return `residual-add:${session.session_id}:${scope.planId}:${occurrenceKey}`;
}

/** Plan provenance link for a captured finding (idempotent in the core). */
function linkOperationId(scope: ResolvedPlanScope, session: CoordinationSession, occurrenceKey: string): string {
  return `residual-add-link:${session.session_id}:${scope.planId}:${occurrenceKey}`;
}

async function mutateResidualAdd(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ResidualAddCoordinationRequest,
): Promise<CoordinationResult> {
  if (!Array.isArray(request.entries) || request.entries.length === 0) {
    throw invalidInput("residual-add requires at least one entry");
  }
  const entries = request.entries;
  const context = planStoreContext(scope);
  const receipts: CoordinationIssueReceipt[] = [];
  const result = await withRowCommit(scope, {
    kind: "residual-add",
    expectedRevision: request.expectedRevision ?? null,
    effectOutsideRow: true,
    precheck: (rowContext) => {
      assertMutableRow(rowContext, session, sessionPath, "residual-add");
    },
    mutate: async (rowContext, reportExternalCommit) => {
      // Issue mutations run under the snapshot lock, then re-check the
      // engine-issued session against the live workflow at the issue boundary.
      //
      // Entries are deliberately NOT pre-validated before this loop: the first
      // thing that must hold is that this session may mutate this row at all, so
      // a foreign or unscoped caller is refused as such (`issue.scope-refused`,
      // raised by the core verb inside the transaction) rather than as a
      // caller-input error it could have avoided by presenting a better-formed
      // entry — and a mid-loop failure still discloses the components that
      // already committed instead of claiming nothing moved (§4.1).
      for (const entry of entries) {
        const capture = await captureIssue(
          context,
          { ...entry, projectId: scope.projectId },
          {
            operationId: captureOperationId(scope, session, entry.occurrenceKey),
            actor: "project-manager",
            sessionFile: sessionPath,
          },
        );
        // §4.1 each component is disclosed the moment its own commit stands: a
        // failure on a later entry then refuses on the boundary that already
        // moved (these capture/link commits are in the issue authority, not the
        // snapshot) instead of reporting that nothing changed.
        reportExternalCommit(
          `issue ${capture.issueId} captured for plan ${scope.planId} (occurrence ${entry.occurrenceKey})`,
        );
        // Always link, never only on `created`: the plan link is the gate's
        // authority, and a replay (or a capture that appended an occurrence)
        // must converge to the same linked state. Both verbs are operation-id
        // idempotent, so a retry after a partial failure heals instead of
        // leaving an unlinked issue the plan can never close.
        assertPlanIssueSession(context, sessionPath);
        const link = await linkIssueScoped(
          context,
          capture.issueId,
          { kind: "plan", target: scope.planId },
          {
            operationId: linkOperationId(scope, session, entry.occurrenceKey),
            actor: "project-manager",
            sessionFile: sessionPath,
            expectedRevision: capture.revision,
          },
        );
        reportExternalCommit(
          `issue ${capture.issueId} linked to plan ${scope.planId} (occurrence ${entry.occurrenceKey})`,
        );
        // The link's revision, not the capture's: the caller closes the issue
        // under the current value.
        receipts.push({ issue_id: capture.issueId, revision: link.revision, created: capture.created });
      }
      return null;
    },
  });
  return {
    ok: true,
    operation: "residual-add",
    session,
    session_file: sessionPath,
    outcome: result.satisfied === null ? "residual-added" : "already-satisfied",
    recovery: result.recovery,
    issues: receipts,
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, planScopeOfMetadata(result.row, result.snapshot), result.snapshot, result.row, session, sessionPath),
  };
}

/**
 * The plan session may close only an issue linked to THIS plan: a foreign or
 * unscoped issue refuses before any authority is consumed. The link is
 * append-only (no unlink verb), so a read-side scope check cannot race; it
 * still runs inside the row's locked section, after the session binding and
 * handoff checks have proven this session may mutate this row.
 *
 * The refusal surfaces the issue contract's stable code (`issue.scope-refused`,
 * contract §4/§5 — foreign or unscoped mutation), not a coordination code: a
 * consumer classifies scope refusals by the contract enum on every surface,
 * and only the code changes — the check, its position and the message stay.
 */
async function assertIssueLinkedToPlan(context: StoreContext, issueId: string, planId: string): Promise<void> {
  const handle = await openStore(context, "read");
  try {
    assertIssueProvenanceSchema(handle.db);
    const linked = handle.db
      .prepare("select 1 as ok from provenance where issue_id = ? and kind = 'plan' and target = ? and origin = 'scoped'")
      .get(issueId, planId) as { ok: number } | undefined;
    if (!linked) {
      throw new IssueError(
        "issue.scope-refused",
        `issue ${issueId} is not linked to plan ${planId} \u2014 a plan session closes only its own findings`,
      );
    }
  } finally {
    handle.close();
  }
}

async function mutateResidualClose(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: ResidualCloseCoordinationRequest,
): Promise<CoordinationResult> {
  if (!isNonEmptyString(request.issueId)) throw invalidInput("issueId is required");
  if (!Number.isInteger(request.expectedIssueRevision) || request.expectedIssueRevision < 0) {
    throw invalidInput(
      `expectedIssueRevision must be a nonnegative integer \u2014 the issue revision guards the DB mutation; got ${JSON.stringify(request.expectedIssueRevision)}`,
      { issue_id: request.issueId },
    );
  }
  const context = planStoreContext(scope);
  let closed: CoordinationIssueReceipt | undefined;
  const result = await withRowCommit(scope, {
    kind: "residual-close",
    expectedRevision: request.expectedRevision ?? null,
    effectOutsideRow: true,
    precheck: (rowContext) => {
      assertMutableRow(rowContext, session, sessionPath, "residual-close");
    },
    mutate: async (rowContext) => {
      await assertIssueLinkedToPlan(context, request.issueId, scope.planId);
      assertPlanIssueSession(context, sessionPath);
      const receipt = await closeIssue(
        context,
        request.issueId,
        request.disposition,
        request.evidence,
        {
          operationId: `residual-close:${session.session_id}:${scope.planId}:${request.issueId}`,
          actor: "project-manager",
          sessionFile: sessionPath,
          expectedRevision: request.expectedIssueRevision,
        },
      );
      closed = { issue_id: request.issueId, revision: receipt.revision, created: false };
      return null;
    },
  });
  return {
    ok: true,
    operation: "residual-close",
    session,
    session_file: sessionPath,
    outcome: result.satisfied === null ? "residual-closed" : "already-satisfied",
    recovery: result.recovery,
    issues: closed === undefined ? [] : [closed],
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, planScopeOfMetadata(result.row, result.snapshot), result.snapshot, result.row, session, sessionPath),
  };
}

/* ------------------------------------------------------------------------ *
 * § Coordination request dispatch
 * ------------------------------------------------------------------------ */

/** The file-route entry anchor plus the canonical envelope path it was read from. */
type CoordinationAnchor = EntryAnchor & { sessionPath: string };

/**
 * § One resolver path (S2/E02) for the FILE route: the trusted control root, the
 * addressed workflow/plan, then the caller's OWN session envelope under that
 * root. A stated `sessionPath` is a constraint and short-circuits the whole
 * resolution; a sparse call states its acquired `identity` instead and the
 * engine computes the envelope's own path from it (`sessionFilePath`) — the
 * caller never has to know the `sessions/` layout, and holding the path
 * authorizes nothing: the strict frames below still re-authenticate the envelope
 * against the addressed row's recorded binding.
 *
 * The authority veto is part of this boundary (spec §4.3/§5): the resolved root
 * is checked before the target, the snapshot or any payload byte is read, so a
 * retired file route refuses on its own. Nothing is guessed — an unresolvable
 * root, target or envelope is refused with the sources tried and the facts
 * currently true.
 */
function resolveCoordinationAnchor(request: CoordinationRequest): CoordinationAnchor {
  const stated = isNonEmptyString(request?.sessionPath) ? request.sessionPath : undefined;
  if (stated !== undefined) {
    const anchor = entryAnchor(stated);
    assertExecutionFileWriteAllowed({ harnessDir: anchor.harnessRoot });
    return { ...anchor, sessionPath: canonicalTarget(stated) };
  }
  const identity = request?.identity;
  const rootResolution = resolveIntentRoot({
    cwd: isNonEmptyString(request?.cwd) ? request.cwd : process.cwd(),
    ...(isNonEmptyString(request?.controlRoot) ? { controlRoot: request.controlRoot } : {}),
    ...(identity === undefined ? {} : { identity }),
  });
  if (!rootResolution.ok) refuseResolution(rootResolution.problem, rootResolution.resolvedFrom);
  const root = rootResolution.root;
  assertExecutionFileWriteAllowed({ harnessDir: root });
  const resolvedFrom: ResolutionSource[] = [...rootResolution.resolvedFrom];
  if (identity === undefined) {
    refuseResolution(
      {
        component: "session",
        path: "sessionPath",
        code: "coordination.invalid-input",
        sourcesTried: ["sessionPath (intent.explicit)", "identity (invocation association)"],
        currentFacts: [
          `${root} holds the workflow this call addresses`,
          "no session envelope and no acquired identity were stated",
        ],
        needed: "the session this call runs under",
        withheldEffect:
          "the addressed coordination operation - no session was guessed, so no row, binding or revision was read for it",
        availableWork: [
          "pass the bound session envelope (sessionPath)",
          "pass the acquired identity (identity) so the engine resolves that identity's own envelope",
        ],
      },
      resolvedFrom,
    );
  }
  // Identity selects the workflow coordinator; the request selects the plan.
  validateExecutionIdentity(identity, { workflowId: identity.workflowId, role: identity.role });
  const target = resolveIntentTarget({
    root,
    selection: {
      workflowId: identity.workflowId,
      ...(isNonEmptyString(request?.planId) ? { planId: request.planId } : {}),
    },
  });
  if (!target.ok) refuseResolution(target.problem, [...resolvedFrom, ...target.resolvedFrom]);
  resolvedFrom.push(...target.resolvedFrom);
  const envelope = sessionFilePath(root, target.workflowId, identity.role, identity.sessionId);
  if (!existsSync(envelope)) {
    refuseResolution(
      {
        component: "session",
        path: "sessionPath",
        code: "coordination.session-not-found",
        sourcesTried: [...resolvedFrom.map((entry) => `${entry.path} (${entry.source})`), `${envelope} (identity.sessionId)`],
        currentFacts: [
          `the acquired identity is session ${identity.sessionId} of workflow ${target.workflowId}`,
          `${envelope} does not exist`,
        ],
        needed: `this identity's own bound session envelope at ${envelope}`,
        withheldEffect:
          "the addressed coordination operation - the envelope is the durable proof of the binding, so nothing was read or written for it",
        availableWork: [
          `bind this identity to workflow ${target.workflowId} and resume it`,
          "pass the bound session envelope explicitly (sessionPath) when it lives elsewhere",
        ],
      },
      resolvedFrom,
    );
  }
  return { session: readSessionEnvelope(envelope), harnessRoot: root, sessionPath: canonicalTarget(envelope) };
}

/**
 * §4.2 the revision `show` would have handed the caller: the addressed row's own
 * `coordination.revision` (0 for a row that is not yet coordinated). It is
 * transport freshness, so deriving it is exactly as valid as reading it — and a
 * plan a coordinator addresses without naming one has no row to read, which
 * stays the caller's own missing fact rather than an invented number.
 */
function resolveRowRevision(anchor: EntryAnchor, planId: string | undefined): number {
  const addressed = planId;
  if (!isNonEmptyString(addressed)) {
    throw invalidInput(
      "expectedRevision is required here: this request names no plan row whose revision could be derived",
      { workflow_id: anchor.session.workflow_id },
    );
  }
  const snapshot = readSnapshot(dirname(snapshotPathOf(anchor.harnessRoot, anchor.session.workflow_id)));
  const { row } = findPlanRow(snapshot, addressed);
  return rowCoordinationOf(row)?.revision ?? 0;
}

/** Apply an ordinary coordinator row intent under the existing protected write frame. */
export async function mutatePlanCoordination(request: CoordinationRequest): Promise<CoordinationResult> {
  const anchor = resolveCoordinationAnchor(request);
  const session = anchor.session;
  assertExactKeys(
    request,
    ["sessionPath", "cwd", "controlRoot", "identity", "planId", "expectedRevision", "operation"],
    "coordination request",
  );
  if (!isNonEmptyString(request.planId)) {
    throw invalidInput("planId is required to address a coordinator plan operation", { path: "planId" });
  }
  if (request.expectedRevision !== undefined) assertExpectedRevision(request.expectedRevision);
  const expectedRevision = request.expectedRevision ?? resolveRowRevision(anchor, request.planId);
  const operation = request.operation;
  if (!isPlainObject(operation) || !isNonEmptyString(operation.kind)) {
    throw invalidInput("a coordination request requires an operation with a kind");
  }
  if ("expectedRevision" in operation) {
    throw invalidInput("expectedRevision belongs to the request, not the operation");
  }
  const kind = operation.kind;
  if (typeof kind !== "string" || IMPLEMENTED_OPERATIONS[kind] !== true) {
    throw new CoordinationError("coordination.unknown-operation", `${kind} is not a coordination operation`, {
      operation: kind,
    });
  }
  const seat: CoordinationSeat = { role: session.role, sessionId: session.session_id };
  assertOperationRole(seat, kind);
  const planId = assertPlanAddress(seat, request.planId);
  const scope = await coordinatorScope(session, planId);
  switch (operation.kind) {
    case "prepare":
      assertExactKeys(operation, ["kind", "config"], "prepare operation");
      return mutatePrepare(scope, session, anchor.sessionPath, { config: operation.config, expectedRevision });
    case "progress":
      assertExactKeys(operation, ["kind", "progress"], "progress operation");
      return mutateProgress(scope, session, anchor.sessionPath, { progress: operation.progress, expectedRevision });
    case "residual-add":
      assertExactKeys(operation, ["kind", "entries"], "residual-add operation");
      return mutateResidualAdd(scope, session, anchor.sessionPath, { entries: operation.entries, expectedRevision });
    case "residual-close":
      assertExactKeys(operation, ["kind", "issueId", "disposition", "evidence", "expectedIssueRevision"], "residual-close operation");
      return mutateResidualClose(scope, session, anchor.sessionPath, { issueId: operation.issueId, disposition: operation.disposition, evidence: operation.evidence, expectedIssueRevision: operation.expectedIssueRevision, expectedRevision });
    case "complete":
      assertExactKeys(operation, ["kind", "evidence", "integration"], "complete operation");
      return mutateComplete(scope, session, anchor.sessionPath, { evidence: operation.evidence, integration: operation.integration, expectedRevision });
    default:
      throw new CoordinationError("coordination.unknown-operation", `${String(kind)} is not a coordinator row operation; use plan show or plan --help for supported operations`, { operation: String(kind) });
  }
}

function assertExpectedRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) {
    throw invalidInput(`expectedRevision must be a nonnegative integer \u2014 got ${JSON.stringify(revision)}`, { revision });
  }
}

/** Resolve source facts from the addressed row, using the authenticated control root. */
async function coordinatorScope(session: CoordinationSession, planId: string): Promise<ResolvedPlanScope> {
  return resolvePlanScope({ workflowId: session.workflow_id, planId, harnessDir: session.harness_root }, session.harness_root);
}

/* ------------------------------------------------------------------------ *
 * § Git proof (spec §D/§E)
 * ------------------------------------------------------------------------ */

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
    `cannot read Git state at ${cwd} (git ${args.join(" ")}): ${cause}`,
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
    throw new CoordinationError(refusal, `cannot read Git checkout ${repository}; restore the recorded checkout and retry`, { repository });
  }
  const commonDir = canonicalTarget(resolve(repository, common));
  const current = currentGitHead(gitDir, commonDir);
  if (current.head !== head) {
    throw new CoordinationError(refusal, `Git HEAD moved at ${repository}; retry against the current checkout`, { repository, expected: head, actual: current.head });
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
        `Git checkout routing moved at ${witness.repository}; restore the recorded checkout or retry against its current repository`,
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
    throw new CoordinationError(witness.refusal, `cannot re-read Git identity at ${witness.repository}; restore the recorded checkout and retry`, { repository: witness.repository });
  }
  throw new CoordinationError(
    witness.refusal,
    `Git checkout identity, branch, HEAD, cleanliness or operation state moved at ${witness.repository}; restore a clean recorded checkout or retry the proof against its current state`,
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
      `${what} requires the plan worktree ${worktreePath} to be a readable Git worktree`,
      { plan_id: planId, worktree_path: worktreePath },
    );
  }
  if (checkout.operation !== undefined) {
    throw gitProof(
      `${what} requires a clean plan worktree \u2014 ${worktreePath} has an unfinished ${checkout.operation}`,
      { plan_id: planId, operation: checkout.operation },
    );
  }
  if (!checkout.clean) {
    throw gitProof(`${what} requires a clean plan worktree \u2014 ${worktreePath} has uncommitted changes`, {
      plan_id: planId,
      head: checkout.head,
    });
  }
  if (checkout.head !== sourceSha) {
    throw gitProof(
      `${what} requires the plan worktree HEAD to be the pinned source ${sourceSha} \u2014 ${worktreePath} is at ${checkout.head}`,
      { plan_id: planId, expected: sourceSha, actual: checkout.head },
    );
  }
}

/** Prove the current source checkout and the approved review ancestry. */
function assertSourceReviewProof(
  worktreePath: string,
  input: { source_sha: string; review_base: string; review_head: string },
  what: string,
  planId: string,
): void {
  assertFeatureCheckout(worktreePath, input.source_sha, what, planId);
  if (input.review_head !== input.source_sha) {
    throw gitProof(
      `${what} requires review_head to be the pinned source ${input.source_sha} \u2014 got ${input.review_head}`,
      { plan_id: planId, source_sha: input.source_sha, review_head: input.review_head },
    );
  }
  if (!gitObjectExists(worktreePath, input.review_base)) {
    throw gitProof(`${what} review base ${input.review_base} is not a commit of ${worktreePath}`, {
      plan_id: planId,
      review_base: input.review_base,
    });
  }
  if (!gitIsAncestor(worktreePath, input.review_base, input.review_head)) {
    throw gitProof(
      `${what} review range ${input.review_base}..${input.review_head} is not an ancestry`,
      { plan_id: planId, review_base: input.review_base, review_head: input.review_head },
    );
  }
}


/** Read the issue store's authoritative completion findings gate. */
async function assertFindingsClosed(
  scope: ResolvedPlanScope,
  prepared: PreparedCoordination,
  what: string,
): Promise<void> {
  let gate: GateResult;
  try {
    gate = await findingsCleanupGate({ harnessDir: scope.harnessRoot }, scope.planId, {
      mode: prepared.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CoordinationError(
      "coordination.store",
      `plan ${scope.planId} cannot ${what}: the issue store is unavailable and findings authority cannot be read \u2014 ${message}`,
      { plan_id: scope.planId, findings_cleanup: prepared.findings_cleanup },
    );
  }
  if (!gate.ok) {
    throw new CoordinationError(
      "coordination.invalid-transition",
      `plan ${scope.planId} cannot ${what} while findings are open (${prepared.findings_cleanup}): ${summarize(gate.violations)}`,
      { plan_id: scope.planId, findings_cleanup: prepared.findings_cleanup },
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

/** The parent ids carried by one `<sha> <parent>…` rev-list line. */
function parentIdsOf(line: string): string[] {
  return line
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(1);
}

/** Parents of one pinned commit in a repository. */
function commitParents(path: string, sha: string): string[] | undefined {
  const line = gitRead(path, ["rev-list", "--parents", "-n", "1", sha]);
  if (line === undefined) return undefined;
  return parentIdsOf(line);
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

function validateRowCoordinationInContext(context: RowContext, coordination: RowCoordination, what: string): void {
  assertViolationFree(validateRowCoordination(coordination, what, rowValidationRoute(context.snapshot, context.row)), what);
}





/** Prove the row's recorded source ref and review range, never a caller path. */
export function assertStandaloneSourceGitProof(
  worktreePath: string,
  evidence: { source_sha: string; review_base: string; review_head: string },
  sourceBranch: string,
  what: string,
  planId: string,
): void {
  assertSourceReviewProof(worktreePath, evidence, what, planId);
  const branch = gitRead(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const tip = gitRead(worktreePath, ["rev-parse", `refs/heads/${sourceBranch}`]);
  if (branch !== sourceBranch || tip !== evidence.source_sha) {
    throw gitProof(`${what} requires source checkout ${worktreePath} on ${sourceBranch} at ${evidence.source_sha}; restore that checkout or revise source facts with plan prepare`, { plan_id: planId, expected: sourceBranch, actual: branch, tip });
  }
}



function assertReportOnlyCompletionEvidence(context: RowContext, planId: string, what: string): void {
  const policy = context.snapshot.completion_policy;
  const recorded = context.snapshot.delivery?.completion;
  if (!isNonEmptyString(policy) || recorded?.policy !== policy || !isNonEmptyString(recorded.evidence)) {
    throw new CoordinationError("coordination.invalid-transition", `${what} requires plan ${planId}'s explicitly recorded fulfilment of its registered completion policy; record matching workflow evidence before plan complete`, { plan_id: planId, registered: policy ?? null, recorded: recorded ?? null });
  }
  const failure = consultDeliveryEvidence(context.snapshot).find((entry) => !entry.ok);
  if (failure !== undefined) throw new CoordinationError("coordination.invalid-transition", `${what} requires matching report-only completion evidence: ${failure.message}; correct it through workflow evidence`, { plan_id: planId, code: failure.code });
}
let completeStandaloneMutateGapForTest: (() => void) | undefined;

/** Test-only hook to observe the precheck→mutate gap in standalone complete. */
export function setCompleteStandaloneMutateGapForTest(callback: (() => void) | undefined): void {
  completeStandaloneMutateGapForTest = callback;
}


/** Complete one row directly; no ownership-transfer or pre-merge state exists. */
async function mutateComplete(
  scope: ResolvedPlanScope,
  session: CoordinationSession,
  sessionPath: string,
  request: CompleteRequest,
): Promise<CoordinationResult> {
  let completion: CompletionRecord;
  let evidence: ValidatedCompletionEvidence;
  let witnesses: GitProofWitness[] = [];
  let proveGit: (() => void) | undefined;
  let releaseMergeClaim = false;
  const result = await withRowCommit(scope, {
    kind: "complete",
    expectedRevision: request.expectedRevision,
    precheck: async (context) => {
      assertCoordinatorBinding(session, sessionPath, context.snapshot);
      const route = rowValidationRoute(context.snapshot, context.row);
      evidence = readCompletionEvidence(request.evidence, route);
      const existing = context.coordination?.completion;
      if (rowStatusOf(context.row) === "Done" && existing !== undefined) {
        const same = existing.source_sha === evidence.source_sha
          && existing.review_base === evidence.review_base && existing.review_head === evidence.review_head
          && existing.qc.decision === evidence.qc_decision && existing.qa.gate === evidence.qa_gate
          && existing.qa.decision === evidence.qa_decision
          && existing.qc.reports.length === evidence.qc_reports.length
          && existing.qc.reports.every((ref, index) => ref.path === canonicalTarget(evidence.qc_reports[index]))
          && existing.qc.consolidated.path === canonicalTarget(evidence.qc_consolidated)
          && existing.qa.report.path === canonicalTarget(evidence.qa_report)
          && (existing.integration === undefined
            ? request.integration === undefined
            : existing.integration.base_sha === request.integration?.base_sha && existing.integration.result_sha === request.integration?.result_sha);
        if (!same) throw new CoordinationError("coordination.completion-frozen", `plan ${scope.planId} already records different completion evidence; read plan show and retry the original completion without replacing it`, { plan_id: scope.planId });
        return { field: "coordination.completion", source: "stored plan row" };
      }
      assertMutableRow(context, session, sessionPath, "complete");
      const status = rowStatusOf(context.row);
      if (status !== "InReview" && status !== "InProgress") {
        throw new CoordinationError("coordination.plan-status", `complete requires ${scope.planId} in InProgress or InReview, not ${status}; record its start or unblock it through plan progress first`, { plan_id: scope.planId, status });
      }
      const metadata = isPlainObject(context.row.metadata) ? context.row.metadata : {};
      const configured = context.coordination?.prepared;
      const effective: PreparedCoordination = {
        qa_gate: configured?.qa_gate ?? (metadata.qa_gate === "pm-acceptance" ? "pm-acceptance" : "mandatory"),
        findings_cleanup: configured?.findings_cleanup ?? (metadata.findings_cleanup === "zero-residual" ? "zero-residual" : "allow-residual"),
        prepared_by: session.session_id, prepared_at: nowIso(),
      };
      assertCompletionReviewDecision(evidence, scope.planId, effective.qa_gate);
      assertNoIntegrationContamination({ snapshot: context.snapshot, planId: scope.planId, integration: request.integration, what: "complete" });
      assertEvidenceInsidePlan(scope, evidence.evidence_paths);
      await assertFindingsClosed(scope, effective, "complete");
      const at = nowIso();
      const qc: CompletionRecord["qc"] = {
        decision: evidence.qc_decision,
        reports: evidence.qc_reports.map(evidenceRefOf),
        consolidated: evidenceRefOf(evidence.qc_consolidated),
      };
      const qa: CompletionRecord["qa"] = { gate: evidence.qa_gate, decision: "pass", report: evidenceRefOf(evidence.qa_report) };
      let worktreePath: string | null = null;
      let workingBranch: string | null = null;
      let integration: CompletionRecord["integration"];
      if (route === "standalone-report-only") {
        assertReportOnlyCompletionEvidence(context, scope.planId, "complete");
      } else {
        if (!isNonEmptyString(metadata.worktree_path) || !isNonEmptyString(metadata.working_branch)) {
          throw invalidInput("complete requires row source worktree and branch; supply the missing source facts with plan prepare");
        }
        worktreePath = canonicalTarget(metadata.worktree_path);
        workingBranch = metadata.working_branch;
        await assertRecordedSourceCheckout(scope, context.snapshot, worktreePath, workingBranch);
        const source = { source_sha: evidence.source_sha!, review_base: evidence.review_base!, review_head: evidence.review_head! };
        if (route === "standalone-development") {
          const anchors = standaloneDeliveryAnchors(context.snapshot, scope.planId);
          if (workingBranch !== anchors.sourceBranch) throw new CoordinationError("coordination.scope-mismatch", `complete requires source branch ${anchors.sourceBranch}, not ${workingBranch}; revise source facts through plan prepare`, { plan_id: scope.planId });
        }
        const sourcePath = worktreePath;
        const sourceBranch = workingBranch;
        const sourceProof = () => assertStandaloneSourceGitProof(sourcePath, source, sourceBranch, "complete", scope.planId);
        sourceProof();
        witnesses = [captureGitProofWitness(sourcePath)];
        proveGit = sourceProof;
        if (route === "integration") {
          if (!isPlainObject(request.integration)) throw invalidInput("iteration complete requires integration { base_sha, result_sha } naming the already-performed serial merge");
          assertExactKeys(request.integration, ["base_sha", "result_sha"], "completion integration");
          const baseSha = assertGitObjectId(request.integration.base_sha, "integration.base_sha");
          const resultSha = assertGitObjectId(request.integration.result_sha, "integration.result_sha");
          const anchors = integrationAnchors(context.snapshot, scope.planId);
          const lease = context.snapshot.integration_merge_lease;
          if (lease !== undefined && (lease.holder !== session.session_id || lease.plan_id !== scope.planId || lease.source_branch !== sourceBranch || lease.target_branch !== anchors.targetBranch)) {
            throw new CoordinationError("coordination.merge-lease-foreign", `integration mutex belongs to ${lease.holder} for plan ${lease.plan_id}; complete that recorded plan's serial merge under its workflow coordinator before retrying this plan`, { plan_id: scope.planId, holder: lease.holder, owner_plan: lease.plan_id });
          }
          const integrationProofCheck = () => {
            sourceProof();
            const checkout = assertIntegrationCheckout(anchors, scope.planId);
            const parents = commitParents(anchors.worktreePath, resultSha);
            if (parents?.length !== 2 || parents[0] !== baseSha || parents[1] !== source.source_sha || !gitIsAncestor(anchors.worktreePath, resultSha, checkout.head)) {
              throw integrationDiverged(`complete requires result ${resultSha} to be the two-parent merge [${baseSha}, ${source.source_sha}] reachable from ${anchors.targetBranch}; perform or correct the serial merge and retry with its actual result`, { plan_id: scope.planId, parents: parents ?? null, head: checkout.head });
            }
          };
          integrationProofCheck();
          proveGit = integrationProofCheck;
          witnesses.push(captureGitProofWitness(anchors.worktreePath, "coordination.integration-diverged"));
          integration = { target_branch: anchors.targetBranch, worktree_path: canonicalTarget(anchors.worktreePath), base_sha: baseSha, result_sha: resultSha, verified_at: at };
          releaseMergeClaim = lease !== undefined;
        }
      }
      completion = {
        source_branch: workingBranch, source_sha: evidence.source_sha, worktree_path: worktreePath,
        review_base: evidence.review_base, review_head: evidence.review_head,
        qc, qa, ...(integration === undefined ? {} : { integration }),
        completed_by: session.session_id, completed_at: at,
      };
    },
    mutate: (context) => {
      completeStandaloneMutateGapForTest?.();
      for (const witness of witnesses) revalidateGitProofWitness(witness);
      proveGit?.();
      const refs = [...completion.qc.reports, completion.qc.consolidated, completion.qa.report];
      for (const ref of refs) {
        if (sha256Bytes(readFileSync(ref.path)) !== ref.sha256) throw invalidInput(`completion evidence changed before commit: ${ref.path}; finish the report and retry complete`);
      }
      const coordination: RowCoordination = { ...(context.coordination ?? { revision: 0 }), revision: context.revision + 1, completion };
      validateRowCoordinationInContext(context, coordination, `plan ${scope.planId} coordination`);
      return { row: { ...context.row, status: "Done", coordination }, coordination, ...(releaseMergeClaim ? { dropTopLevel: ["integration_merge_lease"] } : {}) };
    },
  });
  return {
    ok: true, operation: "complete", session, session_file: sessionPath,
    outcome: result.satisfied === null ? "completed" : "already-satisfied",
    recovery: result.recovery,
    view: buildView(scope.harnessRoot, scope.workflowId, scope.projectId, planScopeOfMetadata(result.row, result.snapshot), result.snapshot, result.row, session, sessionPath),
  };
}


/** File-authority terminal close; completed rows are never reconstructed here. */
export type FileWorkflowCloseInput = Readonly<{
  /** The control harness root holding `status.json` and the workflow directory. */
  harnessRoot: string;
  /** The ACTIVE lifecycle being closed. */
  workflowId: string;
  /** The terminal timestamp of the FIRST close; a retry never rewrites a committed one. */
  endedAt: string;
  /** The workflow coordinator envelope when the snapshot is coordinated. */
  sessionPath?: string;
}>;

export type FileWorkflowCloseResult = Readonly<{
  /** The stored snapshot after the close: terminal, or the committed one the retry found. */
  snapshot: WorkflowSnapshot;
  /** `true` when this call removed the workflow's ACTIVE root register entry. */
  unregistered: boolean;
  /**
   * `completed` when this call wrote the terminal state; `already-terminal`
   * when it finished a state already committed (the residue repair). The stored
   * `status` is what says WHICH terminal outcome was recorded — a `failed` or
   * `stopped` lifecycle is returned as that outcome, never relabelled.
   */
  outcome: "completed" | "already-terminal";
}>;


/** Test-only crash seam after terminal commit and before root cleanup. */
let fileCloseGapForTest: ((stage: "cleanup") => void) | undefined;
export function setFileCloseGapForTest(callback: ((stage: "cleanup") => void) | undefined): void {
  fileCloseGapForTest = callback;
}

export async function closeFileWorkflow(input: FileWorkflowCloseInput): Promise<FileWorkflowCloseResult> {
  assertExecutionFileWriteAllowed({ harnessDir: input.harnessRoot });
  if (!isNonEmptyString(input.workflowId)) throw invalidInput("workflowId must be a non-empty string");
  safePlanId(input.workflowId, "workflowId");
  if (!isCloseTimestamp(input.endedAt)) throw invalidInput("endedAt must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  const harnessRoot = resolve(input.harnessRoot);
  const workflowDir = join(resolveWorkflowDir(harnessRoot, { harnessDir: harnessRoot }), input.workflowId);
  const statusPath = join(harnessRoot, "status.json");
  let snapshot = readWorkflowSnapshot(workflowDir).snapshot;
  if (snapshot.id !== input.workflowId) throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot does not name ${input.workflowId}; select the registered workflow with status validate`);
  const alreadyTerminal = isTerminalSnapshot(snapshot);
  if (!alreadyTerminal) {
    for (const row of snapshot.plans) {
      if (rowStatusOf(row) !== "Done") {
        throw missingDecision({
          planId: String(row.id), what: "close", component: "plan-completion",
          field: "coordination.completion", source: "stored plan row",
          message: `close requires every owned row Done; plan ${row.id} is ${rowStatusOf(row)}. Complete it through plan complete with approved QC/QA and its delivery proof, then retry close`,
        });
      }
    }
    if (isStandaloneReportOnlyWorkflow(snapshot)) {
      const policy = snapshot.completion_policy;
      const recorded = snapshot.delivery?.completion;
      if (!isNonEmptyString(policy) || recorded?.policy !== policy || !isNonEmptyString(recorded.evidence)) {
        throw new CoordinationError("coordination.invalid-transition", "report-only close requires explicitly recorded fulfilment matching completion_policy; record it through workflow evidence and retry close");
      }
    }
    snapshot = await closeWorkflow(input.workflowId, workflowDir, {
      endedAt: input.endedAt,
      ...(input.sessionPath === undefined ? {} : { sessionPath: input.sessionPath }),
    });
    fileCloseGapForTest?.("cleanup");
  }
  // A retry only cleans the register after the first terminal timestamp committed.
  const registered = findRegisteredWorkflow(harnessRoot, input.workflowId);
  const hadEntry = registered !== undefined;
  if (hadEntry) {
    await unregisterWorkflow(statusPath, input.workflowId);
  } else if (!isV2RootRegister(statusPath)) {
    throw new CoordinationError(
      "coordination.root-register-unwritable",
      `workflow ${input.workflowId} is terminal, but its root register is not writable as v2. Terminal state stands; run mstar migrate, then retry close to finish unregistering without rewriting ended_at`,
      { workflow_id: input.workflowId, applied: ["terminal-snapshot"], rootRegister: "not-v2-register" },
    );
  }
  return { snapshot, unregistered: hadEntry, outcome: alreadyTerminal ? "already-terminal" : "completed" };
}

/**
 * Whether the root register at `statusPath` is a v2 register the JSON writer can
 * address: absent/empty counts (there is nothing to unregister and nothing was
 * left behind), a document carrying a `workflows` array counts, and anything
 * else — a pre-migration v1 root, or a document whose `workflows` was replaced —
 * does not. An unreadable/undecodable document is reported as un-addressable
 * rather than thrown: the caller is already handling a partial close and needs
 * the diagnosis, not a second failure from the diagnosis itself.
 */
function isV2RootRegister(statusPath: string): boolean {
  try {
    const doc = readJson(statusPath) as unknown;
    // An EMPTY register is the initialize template and is v2-writable. Any
    // non-empty register must actually BE a v2 register: a `workflows` array
    // alone (a v1 register, or a v2 register with the version field stripped)
    // is exactly the shape `validateStatusV2` refuses, and a close that
    // silently skipped its unregister over it would report success while
    // leaving an invalid root in place (close contract §3).
    if (!isPlainObject(doc) || Object.keys(doc).length === 0) return true;
    if (!Array.isArray(doc.workflows)) return false;
    return validateStatusV2(doc as never, { harnessDir: dirname(statusPath) }).ok;
  } catch {
    return false;
  }
}

/** The row revision a composed close passes as transport freshness (never intent). */


/* ------------------------------------------------------------------------ *
 * § replaceCoordinatedArtifact
 * ------------------------------------------------------------------------ */

/**
 * Replace a coordinated artifact. Snapshot replacement goes through the
 * canonical snapshot writer (coordinator session and phase-only delta); root
 * status is validated and written under root → snapshot → destination locks.
 * `review`/`json` are not coordinated artifacts, so they refuse explicitly
 * instead of silently no-opping.
 *
 * Canonical authority discrimination is the entry boundary: the harness root
 * veto precedes request-shape and ownership checks and any lock.
 */
export async function replaceCoordinatedArtifact(input: CoordinatedReplacement): Promise<VersionedArtifact> {
  if (typeof input?.harnessRoot === "string" && isAbsolute(input.harnessRoot)) {
    assertExecutionFileWriteAllowed({ harnessDir: input.harnessRoot });
  }
  assertExactKeys(
    input,
    ["harnessRoot", "ref", "payload", "sessionPath"],
    "replacement",
  );
  if (!isNonEmptyString(input.harnessRoot) || !isAbsolute(input.harnessRoot)) {
    throw invalidInput("harnessRoot must be an absolute path");
  }
  if (!isPlainObject(input.ref) || !isNonEmptyString(input.ref.kind) || !isNonEmptyString(input.ref.key)) {
    throw invalidInput("ref must be an ArtifactRef with kind and key");
  }
  const kind = input.ref.kind;
  if (kind === "status") {
    const root = canonicalizeNearestExisting(input.harnessRoot);
    await replaceRootStatus(input, root);
    return readCoordinatedArtifact(root, input.ref);
  }
  if ((kind as string) === "residuals") {
    throw new CoordinationError(
      "coordination.store",
      "project register replacement is retired \u2014 a residuals.json is migration history and the issue store (store.db) is the only findings authority",
      { kind: "residuals" },
    );
  }
  if (kind !== "snapshot") {
    throw new CoordinationError(
      "coordination.scoped-writer-required",
      `kind ${kind} has no coordinated writer \u2014 a scoped replacement covers snapshot and status; ${kind} keeps its own writer`,
      { kind },
    );
  }
  const harnessRoot = canonicalizeNearestExisting(input.harnessRoot);
  localStore(harnessRoot);
  if (!isNonEmptyString(input.sessionPath) || !isAbsolute(input.sessionPath)) {
    throw new CoordinationError(
      "coordination.session-role",
      "a coordinated snapshot replacement requires the coordinator session envelope",
      { kind: input.ref.kind },
    );
  }
  const session = readSessionEnvelope(input.sessionPath);
  if (session.role !== "coordinator") {
    throw new CoordinationError("coordination.session-role", `a coordinator session is required, not ${session.role}`, {
      role: session.role,
    });
  }
  if (session.workflow_id !== input.ref.key) {
    throw new CoordinationError(
      "coordination.scope-mismatch",
      `session ${session.session_id} coordinates workflow ${session.workflow_id}, not ${input.ref.key}`,
      { expected: session.workflow_id, actual: input.ref.key },
    );
  }
  const snapshotPath = resolveArtifactPath(harnessRoot, input.ref);
  assertSnapshotPath(harnessRoot, input.ref.key, snapshotPath);
  if (!existsSync(snapshotPath)) {
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
      path: snapshotPath,
    });
  }
  const current = readSnapshot(dirname(snapshotPath));
  if (current.coordination === undefined) {
    throw new CoordinationError(
      "coordination.identity-missing",
      `workflow ${current.id} has no coordinator binding; use plan bind before coordinated snapshot replacement`,
      { workflow_id: current.id },
    );
  }
  if (!isPlainObject(input.payload)) {
    throw invalidInput("a snapshot payload must be an object");
  }
  if (input.payload.id !== input.ref.key) {
    throw invalidInput(
      `snapshot payload id ${JSON.stringify(input.payload.id)} does not match ref key ${JSON.stringify(input.ref.key)}`,
      {},
    );
  }
  const gate = validateWorkflowSnapshot(input.payload);
  if (!gate.ok) {
    throw invalidInput(`snapshot payload fails validation \u2014 ${summarize(gate.violations)}`, {
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  // Boundary cast: the payload passed the snapshot gate immediately above and
  // `writeWorkflowSnapshot` re-validates the merged document before writing.
  // This writer is the phase projection only: `plans` may not differ from disk
  // (`coordination.direct-write-refused`), so it can never move a frozen
  // execution input — and therefore never touches a `catalog_pin` either.
  const payload = input.payload as WorkflowSnapshot;
  await writeWorkflowSnapshot(payload, dirname(snapshotPath), {
    sessionPath: canonicalTarget(input.sessionPath),
  });
  return readCoordinatedArtifact(harnessRoot, input.ref);
}


function scopedWriterRequired(message: string, details: Record<string, unknown>): CoordinationError {
  return new CoordinationError("coordination.scoped-writer-required", message, details);
}

/** One workflow a root status doc registers, with its resolved snapshot path. */
type WorkflowEntryRef = { id: string; dir: string; snapshotPath: string };

/** Coordination ownership discovered from validated workflow snapshots. */
type CoordinatedOwnership = { workflows: string[]; plans: Set<string> };

/**
 * The workflow entries one root status doc registers (spec §C "protection
 * discovery"). Entries are engine-written and harness-relative; a malformed
 * one refuses the replacement rather than silently dropping a protected
 * workflow from the discovered set.
 */
function registeredWorkflowEntries(harnessRoot: string, doc: unknown, statusPath: string): WorkflowEntryRef[] {
  const workflows = isPlainObject(doc) && Array.isArray(doc.workflows) ? doc.workflows : [];
  const entries: WorkflowEntryRef[] = [];
  for (const entry of workflows) {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.dir)) {
      throw new CoordinationError(
        "coordination.store",
        `root ${statusPath} holds a malformed workflow entry \u2014 refusing to classify coordination ownership`,
        { path: statusPath },
      );
    }
    if (isAbsolute(entry.dir) || entry.dir.split(/[\\/]+/).includes("..")) {
      throw new CoordinationError(
        "coordination.store",
        `root ${statusPath} holds a workflow entry whose dir ${JSON.stringify(entry.dir)} is not harness-relative`,
        { path: statusPath, dir: entry.dir },
      );
    }
    entries.push({ id: entry.id, dir: entry.dir, snapshotPath: join(harnessRoot, entry.dir, "snapshot.json") });
  }
  entries.sort((left, right) =>
    canonicalizeNearestExisting(left.snapshotPath).localeCompare(canonicalizeNearestExisting(right.snapshotPath)),
  );
  return entries;
}

/**
 * Hold every entry's snapshot lock, in canonical path order, across `run`
 * (spec §C lock order: root → snapshots → destination). Holding them through
 * the destination write is what keeps the discovered protected set stable.
 */
async function withSnapshotLocks<T>(entries: readonly WorkflowEntryRef[], run: () => Promise<T>): Promise<T> {
  const next = entries[0];
  if (next === undefined) return run();
  return withStatusWriteLock(next.snapshotPath, () => withSnapshotLocks(entries.slice(1), run));
}

/**
 * Ownership of the entries whose snapshot locks are held. Reading a snapshot
 * outside that set would be the unlocked scan spec §C forbids, so it refuses.
 */
function coordinatedOwnershipOf(
  locked: readonly WorkflowEntryRef[],
  subset: readonly WorkflowEntryRef[],
): CoordinatedOwnership {
  const workflows: string[] = [];
  const plans = new Set<string>();
  // Membership is decided by canonical snapshot path, never by object
  // identity: a replacement that retains an existing workflow passes its own
  // entry object for the very file the lock was taken on (spec §C4 — the
  // guard judges the document set, not the caller's instances).
  const lockedPaths = new Set(locked.map((entry) => canonicalizeNearestExisting(entry.snapshotPath)));
  for (const entry of subset) {
    const snapshotPath = canonicalizeNearestExisting(entry.snapshotPath);
    if (!lockedPaths.has(snapshotPath)) {
      throw new CoordinationError(
        "coordination.store",
        `snapshot ${snapshotPath} was not locked before the protection discovery`,
        { path: snapshotPath },
      );
    }
    const snapshot = readSnapshot(dirname(entry.snapshotPath));
    if (snapshot.coordination === undefined) continue;
    workflows.push(entry.id);
    for (const row of snapshot.plans ?? []) {
      if (!isPlainObject(row)) continue;
      const coordination = row.coordination;
      // Every address the row answers to (`id` and/or legacy `plan_id`): a
      // prepared row reachable under either key makes that key protected.
      if (isPlainObject(coordination) && coordination.prepared !== undefined) {
        for (const planId of rowPlanIds(row)) plans.add(planId);
      }
    }
  }
  return { workflows, plans };
}

/** The workflow entries both documents name, deduplicated by canonical snapshot path. */
function lockableEntries(...groups: readonly WorkflowEntryRef[][]): WorkflowEntryRef[] {
  const byPath = new Map<string, WorkflowEntryRef>();
  for (const entry of groups.flat()) {
    const key = canonicalizeNearestExisting(entry.snapshotPath);
    if (!byPath.has(key)) byPath.set(key, entry);
  }
  return [...byPath.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, entry]) => entry);
}

/**
 * Replace the root status.json under its own lock (spec §C2 line 156). The
 * whole-writer cutover refuses any root that registers a coordinated workflow
 * — current or proposed — because those rows belong to the scoped writers.
 */
async function replaceRootStatus(input: CoordinatedReplacement, harnessRoot: string): Promise<void> {
  const store = localStore(harnessRoot);
  const statusPath = resolveArtifactPath(harnessRoot, input.ref);
  const fromTable = resolveArtifactPath(harnessRoot, { kind: "status", key: "root" });
  if (canonicalizeNearestExisting(fromTable) !== canonicalizeNearestExisting(statusPath)) {
    throw new CoordinationError(
      "coordination.path-mismatch",
      `resolved status path ${statusPath} is not the store's ${fromTable}`,
      { expected: fromTable, actual: statusPath },
    );
  }
  if (!isPlainObject(input.payload)) throw invalidInput("a status payload must be an object");
  // The store's status slot is typed; `validateStatusV2` below is what proves
  // the payload actually carries that shape before anything is written.
  const statusDoc = input.payload as StatusV2Doc;
  const gate = validateStatusV2(statusDoc, { harnessDir: harnessRoot });
  if (!gate.ok) {
    throw invalidInput(`status payload fails validation \u2014 ${summarize(gate.violations)}`, {
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  await withStatusWriteLock(statusPath, async () => {
    const current = readArtifactBytes(statusPath);
    const currentEntries = registeredWorkflowEntries(harnessRoot, current?.payload, statusPath);
    const proposedEntries = registeredWorkflowEntries(harnessRoot, input.payload, statusPath);
    const lockedEntries = lockableEntries(currentEntries, proposedEntries);
    await withSnapshotLocks(lockedEntries, async () => {
      const currentOwnership = coordinatedOwnershipOf(lockedEntries, currentEntries);
      if (currentOwnership.workflows.length > 0) {
        throw scopedWriterRequired(
          `refusing to replace ${statusPath}: it registers coordinated workflows ${currentOwnership.workflows.join(", ")} \u2014 the scoped writers own those rows`,
          { path: statusPath, workflows: currentOwnership.workflows, side: "current" },
        );
      }
      const proposedOwnership = coordinatedOwnershipOf(lockedEntries, proposedEntries);
      if (proposedOwnership.workflows.length > 0) {
        throw scopedWriterRequired(
          `refusing to replace ${statusPath} with a root that registers coordinated workflows ${proposedOwnership.workflows.join(", ")}`,
          { path: statusPath, workflows: proposedOwnership.workflows, side: "proposed" },
        );
      }
      await withProtectedWrite(statusPath, "put", () => store.put({ kind: "status", key: "root", payload: statusDoc }));
    });
  });
}

/* ------------------------------------------------------------------------ *
 * § Prepare workflow amendment (show-prepare / amend-prepare)
 * ------------------------------------------------------------------------ */

/**
 * The guarded, coordinator-authenticated Prepare-stage amendment (§ New API and
 * CLI, frozen). One approved plan row: the plan markdown that carries it plus
 * the metadata the row records. Nothing else is addressable — the verb cannot
 * edit an existing row.
 *
 * Only `primary_spec` names a genuinely selected governing document; every other
 * metadata field is DERIVABLE from the amended workflow's own reviewed compass,
 * its recorded integration anchor and the appended plan document's recognized
 * branch declarations (§5 D), so the patch supplies it only when it holds the
 * fact — and a supplied value is a semantic constraint the derivation must agree
 * with. Unknown keys are custom metadata: preserved inertly on the row, never
 * read as authority.
 */
export type PreparePlanAppend = Readonly<{
  id: string;
  title: string;
  file: string;
  metadata: Readonly<{
    primary_spec: string;
    spec_refs?: readonly string[];
    iteration_compass?: string;
    iteration_refs?: readonly string[];
    working_branch?: string;
    spec_integration_branch?: string;
    merge_target?: string;
    /** Custom keys this verb does not recognize; carried onto the row inertly. */
    [key: string]: unknown;
  }>;
}>;

/**
 * One existing row's plan-file pointer correction (prerequisite contract §4.1):
 * `expectedFile` is the exact pointer the row holds **now** and `file` is that
 * row's own canonical registered plan file. The exact old value is supplied
 * rather than inferred, so the correction can only move a pointer it observed —
 * a row that changed underneath the caller (or was addressed by a guess) never
 * gets repointed.
 */
export type PreparePlanFileCorrection = Readonly<{
  id: string;
  expectedFile: string;
  file: string;
}>;

/**
 * The whole structural delta one amendment may apply (§ Admission and mutation
 * step 5): the caller's main-worktree branch, the approved plan appends, the
 * exact pointer corrections of existing rows, the reviewed integration
 * checkout, and the single approved execution-policy key.
 */
export type PrepareWorkflowPatch = Readonly<{
  mainWorktreeBranch: string;
  appendPlans: readonly PreparePlanAppend[];
  /**
   * Optional exact corrections of existing rows' plan-file pointers
   * (prerequisite contract §4.1): each entry names one registered Todo row by
   * the pointer it holds now and that row's own canonical plan file, repairing
   * a malformed repository-relative pointer without a raw snapshot edit. Only
   * `file` is addressable — a correction never rebinds a row to a different
   * document, and no other row field can travel through the patch. Omitted or
   * empty means no correction; a correction-only call passes an empty
   * `appendPlans`.
   */
  correctPlanFiles?: readonly PreparePlanFileCorrection[];
  integrationWorktreePath?: string;
  planParallelism?: "serial" | "parallel";
}>;

/** What a coordinator observes about one workflow before amending it. */
export type PrepareWorkflowView = Readonly<{
  workflowId: string;
  /** Digests of the snapshot and compass observed by this read; provenance only. */
  snapshotVersion: string;
  compassVersion: string;
  /** Plan ids in row order — including this call's own appends on success. */
  planIds: readonly string[];
  /**
   * The lifecycle phase this call reads. The document's own label when it
   * declares one, otherwise the value `deriveLifecyclePhase` derives from the
   * registration/execution facts it already holds (E06a authority; R3/#293) —
   * so a manually registered iteration is in Prepare without a `persist
   * snapshot` step and without a `not-prepare` dead end.
   */
  phase?: string;
  /** `true` when `phase` is a DERIVED value rather than a recorded label. */
  phaseDerived?: boolean;
  /**
   * The STAGE signal of this lifecycle: `true` while it is a registered running
   * workflow that no execution ownership has moved off Prepare — every row still
   * Todo, no row progress/lease/coordination block, no merge lease, no
   * non-Prepare label. It is not a verdict on any one patch: the amendment decides
   * per addressed component (§4.1/E07), so a local repair of one row is admitted
   * while `allowed` is `false` and `blockers` names the sibling fact that put the
   * stage elsewhere.
   */
  allowed: boolean;
  /** One `<reason>: <message>` line per admission blocker; empty when allowed. */
  blockers: readonly string[];
  /**
   * The projections this surface repaired itself (R3/I-000243): `"compass_ref"`
   * when the stored pointer was absolute-but-in-root. The phase is reported by
   * `phase`/`phaseDerived` instead — the canonical reader already derives an
   * absent label (E06a), so it is never a second derivation here. A read view
   * only reports them; the next ordinary amendment adopts them in its own locked
   * write.
   */
  derived?: readonly string[];
}>;

/** Success shape of the verb: the existing envelope with a workflow view. */
export type PrepareWorkflowResult = Omit<CoordinationResult, "view"> & { view: PrepareWorkflowView };

/** Refusal reasons of the Prepare amendment (spec § Admission and mutation). */
type PrepareAmendmentReason =
  | "invalid-patch"
  | "not-prepare"
  | "execution-started"
  | "duplicate-plan"
  | "invalid-plan"
  | "compass-mismatch"
  | "invalid-worktree";

/** One `coordination.prepare-amendment.<reason>` code (`coordination-write.ts`). */
type PrepareAmendmentCode = `coordination.prepare-amendment.${PrepareAmendmentReason}`;

/** Prepare stage label — SSOT is the exported `PREPARE_PHASE` in workflow.ts. */

/**
 * Patch keys the amendment accepts. Any other key is an arbitrary-field
 * attempt, not a future-proof extension (spec § Admission and mutation step 4).
 */
const PREPARE_PATCH_KEYS: readonly string[] = [
  "mainWorktreeBranch",
  "appendPlans",
  "correctPlanFiles",
  "integrationWorktreePath",
  "planParallelism",
];

/** One plan append carries exactly these fields — no runtime row state. */
const PREPARE_APPEND_KEYS: readonly string[] = ["id", "title", "file", "metadata"];

/**
 * One pointer correction carries exactly these fields — no row state at all,
 * and the old pointer by value so the addressed row can be re-verified.
 */
const PREPARE_CORRECTION_KEYS: readonly string[] = ["id", "expectedFile", "file"];

/**
 * Row metadata keys this verb RECOGNIZES: each is validated here and, when the
 * patch omits it, derived from the amended workflow or the appended plan
 * document (§5: derive before validating). A key outside this set is custom
 * metadata — preserved inertly on the row, never elevated to authority.
 */
const PREPARE_APPEND_METADATA_KEYS: readonly string[] = [
  "primary_spec",
  "spec_refs",
  "iteration_compass",
  "iteration_refs",
  "working_branch",
  "spec_integration_branch",
  "merge_target",
];

/**
 * Row metadata the engine READS AS RECORDED AUTHORITY rather than as inert
 * custom data: `catalog_pin` is the frozen catalog selection the execution
 * readers trust (`executionInputSelection`, `readExecutionCatalogPin`). A
 * Prepare append may never write one — the pin belongs to the `prepare`
 * transition — so a patch that supplies it refuses instead of having its value
 * promoted (§5: unknown metadata must not gain authority).
 */
const PREPARE_APPEND_AUTHORITY_METADATA_KEYS: readonly string[] = ["catalog_pin"];

/**
 * The only `plan_parallelism` values the approved concurrency contract names.
 *
 * Exported because the ACTIVE DB route's `execution-policy` transition applies
 * the SAME closed set (E08): one rule, two authority routes, no second list to
 * drift (`execution-workflow.ts` no longer mirrors it).
 */
export const PLAN_PARALLELISM_VALUES: readonly string[] = ["serial", "parallel"];

function prepareAmendmentRefusal(
  reason: PrepareAmendmentReason,
  message: string,
  details: Record<string, unknown> = {},
): CoordinationError {
  const code: PrepareAmendmentCode = `coordination.prepare-amendment.${reason}`;
  return new CoordinationError(code, message, details);
}

/** The addressed workflow of one workflow-level verb. */
type PrepareWorkflowScope = {
  session: CoordinationSession;
  /** Canonical envelope path (the result's `session_file`). */
  sessionPath: string;
  harnessRoot: string;
  workflowId: string;
  snapshotPath: string;
};

/**
 * Resolve the workflow one coordinator envelope addresses (§ Admission and
 * mutation step 1). The envelope's own `harness_root` and `workflow_id` are
 * the only address: no caller-supplied root or workflow id retargets it. The
 * active store must be that root and the process root must agree, so a linked
 * checkout's own artifacts can never be read as the control root. Every
 * refusal here is an existing auth/scope error, never a new one.
 */
function prepareWorkflowScope(sessionPath: string, cwd: string, anchorSession?: CoordinationSession): PrepareWorkflowScope {
  // The Prepare entries pass the session the entry boundary already read for
  // the authority veto, so the anchor document is read once per call.
  const session = anchorSession ?? readSessionEnvelope(sessionPath);
  if (session.role !== "coordinator") {
    throw new CoordinationError(
      "coordination.session-role",
      `workflow Prepare verbs require a coordinator session, not ${session.role}`,
      { actual: session.role },
    );
  }
  const harnessRoot = canonicalizeNearestExisting(session.harness_root);
  localStore(harnessRoot);
  // Same trusted-root rule as `readPlanCoordination`: the envelope's root is the
  // association, so a Git outage in the caller's process cannot invalidate it.
  const rootResolution = resolveIntentRoot({ cwd }, { root: harnessRoot, source: "session.envelope" });
  if (!rootResolution.ok) refuseResolution(rootResolution.problem, rootResolution.resolvedFrom);
  const workflowId = safePlanId(session.workflow_id, "workflow_id");
  const snapshotPath = assertSnapshotPath(harnessRoot, workflowId, snapshotPathOf(harnessRoot, workflowId));
  return { session, sessionPath: canonicalTarget(sessionPath), harnessRoot, workflowId, snapshotPath };
}

/**
 * The stored snapshot, the byte version of the file it came from, and whether
 * the phase label it carries was DERIVED by the reader from the lifecycle facts
 * (E06a/R3) rather than declared. The version is the CAS token of the exact
 * bytes on disk; the payload comes from the canonical reader (strict
 * validation, one in-memory legacy-alias normalization). Both reads happen
 * inside one locked section for a writer — the snapshot lock, not an editor or
 * power-loss transaction, is this verb's boundary (spec § Admission and
 * mutation step 7).
 */
function readPrepareSnapshot(snapshotPath: string): { snapshot: WorkflowSnapshot; version: string; phaseDerived: boolean } {
  const bytes = readArtifactBytes(snapshotPath);
  if (bytes === undefined) {
    throw new CoordinationError("coordination.workflow-not-found", `workflow snapshot not found: ${snapshotPath}`, {
      path: snapshotPath,
    });
  }
  const read = readSnapshotWithPhase(dirname(snapshotPath));
  return { snapshot: read.snapshot, version: bytes.version, phaseDerived: read.phaseDerived };
}

/** The reviewed compass of a workflow plus the declarations it binds. */
type PrepareCompass = {
  /** Canonical compass path (`snapshot.compass_ref` resolved). */
  path: string;
  /** `sha256:<64 hex>` of the Markdown bytes — the compass CAS token. */
  version: string;
  /** `plans:` frontmatter ids, validated as declared (non-empty, unique). */
  planIds: readonly string[];
  /**
   * The harness-relative form of `snapshot.compass_ref`, present only when
   * the stored spelling was absolute-but-in-root: the identical reviewed
   * document under the stored contract form. The next ordinary amendment
   * adopts it in its own locked write (I-000243 disposition (b)-adjacent
   * derivation — the reader never writes).
   */
  canonicalCompassRef?: string;
  specIntegrationBranch?: string;
  integrationWorktreePath?: string;
};

/**
 * One optional compass declaration (`spec_integration_branch`,
 * `integration_worktree_path`) of an amendment-reviewed compass. Absence
 * leaves the declaration unset — there is then nothing to compare — while a
 * key that is present without a usable value (a YAML list, a number, an empty
 * value) refuses: the declaration feeds an agreement check, so a malformed
 * value must never read as no declaration at all.
 */
function prepareCompassDeclaration(
  frontmatter: Record<string, unknown>,
  key: string,
  workflowId: string,
  path: string,
): string | undefined {
  const value = frontmatter[key];
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${workflowId} compass ${path} declares a malformed ${key} \u2014 every declaration must be a non-empty string`,
      { workflow_id: workflowId, path, field: key, actual: value },
    );
  }
  return value;
}

/**
 * Read the workflow's own reviewed compass (`snapshot.compass_ref`) and the
 * declarations an amendment must agree with (§ Admission and mutation step 6).
 * The token is the raw-byte SHA-256 of the Markdown (`sha256Bytes`), rendered
 * in the same `sha256:<hex>` form as the snapshot version. A missing, escaping,
 * unreadable or unparsable compass refuses, and so does one that does not
 * declares its own `iteration_id` or whose `plans` list is malformed (an entry
 * that is not a non-empty string) or repeats an id, or whose
 * `spec_integration_branch` / `integration_worktree_path` is present but not a
 * non-empty string: the reviewed declaration is read exactly as written —
 * never filtered, deduplicated or borrowed from another lifecycle — because an
 * unverifiable declaration cannot approve a structural delta.
 */
function readPrepareCompass(harnessRoot: string, snapshot: WorkflowSnapshot): PrepareCompass {
  const ref = snapshot.compass_ref;
  if (!isNonEmptyString(ref)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} declares no usable compass_ref \u2014 the amendment requires the reviewed iteration compass`,
      { workflow_id: snapshot.id, actual: ref ?? null },
    );
  }
  const root = canonicalizeNearestExisting(harnessRoot);
  // Recovery-first pointer derivation (I-000243): an absolute spelling of a
  // document inside this harness root names the identical reviewed compass as
  // its relative form. Resolve it, compute the stored contract form, and let
  // the next ordinary amendment adopt it — the reader itself never writes.
  // A pointer outside the root (or one that escapes it relatively) is a real
  // mismatch and refuses below.
  let canonicalCompassRef: string | undefined;
  let path: string;
  if (isAbsolute(ref)) {
    const resolved = canonicalizeNearestExisting(ref);
    if (!isWithin(root, resolved)) {
      throw prepareAmendmentRefusal(
        "compass-mismatch",
        `workflow ${snapshot.id} compass_ref resolves outside the harness root ${root}`,
        { workflow_id: snapshot.id, path: resolved, expected: "a compass document inside the harness root" },
      );
    }
    path = resolved;
    canonicalCompassRef = relative(root, resolved).split(sep).join("/");
  } else {
    path = canonicalTarget(join(harnessRoot, ref));
    if (!isWithin(root, path)) {
      throw prepareAmendmentRefusal(
        "compass-mismatch",
        `workflow ${snapshot.id} compass_ref ${JSON.stringify(ref)} resolves outside the harness root ${root}`,
        { workflow_id: snapshot.id, path, expected: ref },
      );
    }
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} is unreadable: ${errorMessage(error)}`,
      { workflow_id: snapshot.id, path },
    );
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseCompassFrontmatterText(bytes.toString("utf8"), path);
  } catch (error) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} has no parsable frontmatter: ${errorMessage(error)}`,
      { workflow_id: snapshot.id, path },
    );
  }
  // The declaration is read exactly as written. A missing lifecycle identity
  // cannot bind the compass to this workflow, and a malformed or repeated plan
  // entry means the reviewed list is not the exact set it appears to be — none
  // of that is repaired by filtering or deduplicating before the comparison.
  const iterationId = frontmatter.iteration_id;
  if (!isNonEmptyString(iterationId)) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares no iteration_id \u2014 a lifecycle amends only its own compass`,
      { workflow_id: snapshot.id, path, actual: iterationId ?? null },
    );
  }
  if (iterationId !== snapshot.id) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `compass ${path} declares iteration_id ${iterationId}, not workflow ${snapshot.id} \u2014 a lifecycle amends only its own compass`,
      { workflow_id: snapshot.id, expected: snapshot.id, actual: iterationId },
    );
  }
  const declaredPlans: unknown = frontmatter.plans;
  if (!Array.isArray(declaredPlans) || declaredPlans.length === 0) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares no plan ids in its frontmatter \u2014 the amendment cannot verify the approved plan set`,
      { workflow_id: snapshot.id, path, actual: declaredPlans ?? null },
    );
  }
  const malformed = declaredPlans.filter((entry) => !isNonEmptyString(entry));
  if (malformed.length > 0) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares ${malformed.length} malformed plan id(s) \u2014 every plans entry must be a non-empty string`,
      { workflow_id: snapshot.id, path, plans: declaredPlans },
    );
  }
  const planIds = declaredPlans as readonly string[];
  if (new Set(planIds).size !== planIds.length) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `workflow ${snapshot.id} compass ${path} declares the same plan id more than once \u2014 the reviewed plan set is not a multiset`,
      { workflow_id: snapshot.id, path, plans: planIds },
    );
  }
  // A declaration that is present is read exactly as written: a value that is
  // not a usable string refuses here rather than vanishing, so the agreement
  // checks further down can never be skipped by a malformed key.
  const specIntegrationBranch = prepareCompassDeclaration(frontmatter, "spec_integration_branch", snapshot.id, path);
  const integrationWorktreePath = prepareCompassDeclaration(frontmatter, "integration_worktree_path", snapshot.id, path);
  return {
    path,
    version: `sha256:${sha256Bytes(bytes)}`,
    planIds,
    ...(canonicalCompassRef !== undefined ? { canonicalCompassRef } : {}),
    ...(specIntegrationBranch !== undefined ? { specIntegrationBranch } : {}),
    ...(integrationWorktreePath !== undefined ? { integrationWorktreePath } : {}),
  };
}

/** Admitted, or the reason an amendment must not run. */
type PrepareAdmission =
  | { ok: true }
  | { ok: false; reason: PrepareAmendmentReason; message: string; details: Record<string, unknown> };

/**
 * The Prepare amendment's own admission (§ Admission and mutation step 3,
 * action-local since E07): the addressed lifecycle is a REGISTERED RUNNING
 * workflow, and that is all this gate decides.
 *
 * Row state is deliberately NOT an admission fact. A Prepare amendment repairs
 * registration bookkeeping — an addressed row's plan-file pointer, an approved
 * append's projections, the recorded integration checkout or policy — and each
 * of those reads only the facts its own component consumes (design §4.1). A
 * sibling row that is running, progressed or leased does not block a local
 * correction of another row, and the mere presence of executed rows never
 * blocks adding independently authorized work: both are preserved by value and
 * the amended projections are the addressed component's own. The one row whose
 * state IS read is the row a correction addresses, and that check lives with
 * the component that reads it (`assertUnstartedAddressedRow`).
 *
 * The recorded phase label is not an admission fact either (#293/A04): the
 * phase is derived from the registration/execution facts (`deriveLifecyclePhase`
 * and the reader's own derivation), so a lifecycle whose facts have moved into
 * execution still admits the local repair its rows need, and a manually
 * registered iteration is amendable without a `persist snapshot` step. The
 * whole-lifecycle reading — "no execution ownership anywhere" — is the
 * whole-document STAGE gate (`prepareStageAdmission`), not this verb's.
 */
function prepareAdmission(
  harnessRoot: string,
  workflowId: string,
  snapshot: WorkflowSnapshot,
): PrepareAdmission {
  const entry = assertRootRegisterEntry(harnessRoot, workflowId);
  if (isNonEmptyString(entry.status) && entry.status !== "running") {
    return {
      ok: false,
      reason: "not-prepare",
      message: `root register entry ${workflowId} is ${entry.status} \u2014 the amendment is available only while the lifecycle runs`,
      details: { workflow_id: workflowId, status: entry.status },
    };
  }
  if (snapshot.status !== "running") {
    return {
      ok: false,
      reason: "not-prepare",
      message: `workflow ${workflowId} is ${snapshot.status} \u2014 the amendment is available only while the lifecycle runs`,
      details: { workflow_id: workflowId, status: snapshot.status },
    };
  }
  return { ok: true };
}

/**
 * The whole-document Prepare STAGE gate, used by the readable Prepare view and
 * by the JSON coordinator recovery (§3.3) — the two callers that address a
 * lifecycle rather than one component of a patch: the addressed workflow is a
 * REGISTERED RUNNING lifecycle, NO execution ownership exists anywhere in the
 * document, and no non-Prepare label is recorded.
 *
 * Ownership is read through the ONE phase authority (`deriveLifecyclePhase`,
 * E06a): "some row left Todo / reports progress / carries a lease or a
 * coordination block, or the workflow carries a merge lease" IS the set of facts
 * that moves the derived phase off Prepare. The refusal vocabulary is unchanged —
 * ownership facts answer `execution-started`, and a recorded label that is not
 * Prepare answers `not-prepare`.
 *
 * This is a STAGE signal, not the amendment's admission: the amendment repairs
 * one addressed component and decides per component (§4.1/E07), so it is admitted
 * while a sibling row is mid-flight and the stage gate above still reports the
 * lifecycle as no longer pristine.
 */
function prepareStageAdmission(
  harnessRoot: string,
  workflowId: string,
  snapshot: WorkflowSnapshot,
  phaseDerived: boolean,
): PrepareAdmission {
  const lifecycle = prepareAdmission(harnessRoot, workflowId, snapshot);
  if (!lifecycle.ok) return lifecycle;
  const derivation = deriveLifecyclePhase(snapshot);
  if (derivation.phase !== PREPARE_PHASE) {
    return {
      ok: false,
      reason: "execution-started",
      message: `workflow ${workflowId} has begun executing \u2014 ${derivation.facts.join("; ")}`,
      details: { workflow_id: workflowId, facts: derivation.facts },
    };
  }
  if (!phaseDerived && snapshot.phase !== PREPARE_PHASE) {
    return {
      ok: false,
      reason: "not-prepare",
      message: `workflow ${workflowId} is in ${String(snapshot.phase)}, not ${PREPARE_PHASE}`,
      details: { workflow_id: workflowId, expected: PREPARE_PHASE, actual: snapshot.phase },
    };
  }
  return { ok: true };
}

/**
 * One plan metadata reference: absolute, inside the harness root (canonical,
 * so a symlink out of it is an escape), and an existing file. `iteration_compass`
 * is additionally required to BE this workflow's compass — the caller checks
 * that, because only it knows the resolved compass path.
 */
function prepareReferencePath(harnessRoot: string, value: unknown, field: string, planId: string): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} must be an absolute path \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field, actual: value ?? null },
    );
  }
  const canonical = canonicalTarget(value);
  if (!isWithin(canonicalizeNearestExisting(harnessRoot), canonical)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} ${canonical} escapes the harness root ${harnessRoot}`,
      { plan_id: planId, field, path: canonical, expected: harnessRoot },
    );
  }
  if (!existsSync(canonical) || !statSync(canonical).isFile()) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${planId} ${field} does not exist: ${canonical}`, {
      plan_id: planId,
      field,
      path: canonical,
    });
  }
  return canonical;
}

/** A list-valued metadata reference; every entry obeys the single-path rule. */
function prepareReferenceList(harnessRoot: string, value: unknown, field: string, planId: string): string[] {
  if (!Array.isArray(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} ${field} must be an array of absolute paths \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field, actual: value ?? null },
    );
  }
  return value.map((entry, index) => prepareReferencePath(harnessRoot, entry, `${field}[${index}]`, planId));
}

/** One required non-empty string metadata value. */
function prepareMetadataString(metadata: Record<string, unknown>, key: string, planId: string): string {
  const value = metadata[key];
  if (!isNonEmptyString(value)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} metadata.${key} must be a non-empty string \u2014 got ${JSON.stringify(value ?? null)}`,
      { plan_id: planId, field: `metadata.${key}`, actual: value ?? null },
    );
  }
  return value;
}

/**
 * One metadata field the amended lifecycle can DERIVE (§5 D): the patch's own
 * value when it supplies the fact, otherwise the declaration the workflow
 * already holds. A supplied value is still validated as a non-empty string, and
 * a field neither supplied nor derivable refuses as `invalid-plan` — the
 * refusal names the field and what was looked for, never a silent empty value.
 */
function prepareDerivableMetadataString(
  metadata: Record<string, unknown>,
  key: string,
  derived: string | undefined,
  planId: string,
): string {
  if (metadata[key] !== undefined) return prepareMetadataString(metadata, key, planId);
  if (derived === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${planId} metadata.${key} is required \u2014 the patch supplies no value and this lifecycle declares none to derive it from`,
      { plan_id: planId, field: `metadata.${key}` },
    );
  }
  return derived;
}

/**
 * The `Working branch policy` declaration a plan document carries, if any. The
 * identity parser's consulted header set stays closed (`plan-path.ts` owns it —
 * a descriptive policy line is never aliased into `working branch`), so the
 * recognized POLICY declaration is read here under the same markup and fence
 * rules: `**Working branch policy:** value`, `**Working branch policy**: value`
 * or a plain `Working branch policy: value` line. A fenced example is never a
 * declaration, and a document that repeats the label with two different values
 * declares no single policy.
 */
function planWorkingBranchPolicy(planPath: string): string | undefined {
  let marker: string | undefined;
  let markerLength = 0;
  let declared: string | undefined;
  for (const raw of readFileSync(planPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const run = fence[1]!;
      if (marker === undefined) {
        marker = run.charAt(0);
        markerLength = run.length;
      } else if (run.charAt(0) === marker && run.length >= markerLength) {
        marker = undefined;
      }
      continue;
    }
    if (marker !== undefined) continue;
    const match = /^\*{0,2}working branch policy\*{0,2}:\*{0,2}\s*(\S.*)$/i.exec(line);
    if (match === null) continue;
    const value = match[1]!.trim();
    if (declared !== undefined && declared !== value) return undefined;
    declared = value;
  }
  return declared;
}

/**
 * The branch intent one appended plan DECLARES (#278/A07, §5 branch row). Two
 * recognized declaration forms establish it, and nothing else does:
 *
 * - the literal `Working branch` header — its value IS the row's branch;
 * - a `Working branch policy` that names a feature worktree — the policy
 *   describes the plan's own feature branch, whose house spelling is
 *   `feature/<plan id>`; the sentence is read for that ONE declared kind, never
 *   scanned for a branch-shaped token (normalize equivalent representations,
 *   never guess from arbitrary prose).
 *
 * Anything else — no declaration at all, or a policy that does not name a
 * feature worktree — establishes no branch for this row, so the append refuses
 * instead of inventing one. `source` names what was read, for the diagnostic.
 */
function planBranchIntent(
  planPath: string,
  headers: ReadonlyMap<string, string>,
  planId: string,
): { branch?: string; source: string } {
  const declared = headers.get("working branch");
  if (declared !== undefined) return { branch: declared, source: "declares the `Working branch` header" };
  const policy = planWorkingBranchPolicy(planPath);
  if (policy !== undefined && /feature worktree/i.test(policy)) {
    return { branch: `feature/${planId}`, source: "declares a `Working branch policy` naming a feature worktree" };
  }
  return {
    source:
      policy === undefined
        ? "declares no branch declaration"
        : "declares a `Working branch policy` that names no feature worktree",
  };
}

/**
 * One appended plan, validated against its own plan markdown, the workflow's
 * recorded anchors and the reviewed compass (§ Admission and mutation steps 4
 * and 6). The row is constructed here — Todo, progress 0, the project-manager
 * owner, a creation timestamp — so no runtime field can travel through the
 * patch.
 *
 * The row's branch is resolved from the DECLARATIONS the plan document carries
 * (#278/A07: the literal `Working branch` header, or a `Working branch policy`
 * naming a feature worktree) instead of demanding one literal header spelling,
 * and the references the amended lifecycle already holds (its reviewed compass,
 * its recorded integration anchor) are derived rather than recited. Custom
 * metadata keys survive onto the row inertly; recorded authority never does.
 */
function readPlanAppend(
  value: unknown,
  context: {
    harnessRoot: string;
    snapshot: WorkflowSnapshot;
    compass: PrepareCompass;
    mainWorktreeBranch: string;
    /** §5 W sink: what this append preserved without consuming it. */
    warnings: ResolutionWarning[];
  },
): PlanRow {
  if (!isPlainObject(value)) {
    throw prepareAmendmentRefusal("invalid-plan", "every appendPlans entry must be an object", { actual: value ?? null });
  }
  const unexpected = Object.keys(value).filter((key) => !PREPARE_APPEND_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `a plan append accepts only ${PREPARE_APPEND_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpected.join(", ")}`,
      { allowed: [...PREPARE_APPEND_KEYS], unexpected },
    );
  }
  const id = value.id;
  if (!isNonEmptyString(id)) {
    throw prepareAmendmentRefusal("invalid-plan", `a plan append requires a non-empty id \u2014 got ${JSON.stringify(id ?? null)}`, {
      actual: id ?? null,
    });
  }
  try {
    assertSafePathComponent(id, "plan id");
  } catch (error) {
    throw prepareAmendmentRefusal("invalid-plan", `plan id ${JSON.stringify(id)} is not a safe path component: ${errorMessage(error)}`, {
      plan_id: id,
    });
  }
  const title = value.title;
  if (!isNonEmptyString(title)) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} requires a non-empty title`, { plan_id: id, actual: title ?? null });
  }
  const declaredFile = value.file;
  // The PlanRow `file` convention belongs to the ONE registered-plan path
  // resolver (prerequisite contract §4): it accepts the canonical absolute or
  // the normalized harness-relative pointer, and owns the canonical-target and
  // declared-`plan_id` checks — so the Prepare append cannot drift from
  // registration and readiness. The refusal vocabulary and code stay
  // `invalid-plan`; the resolver's typed path detail is attached rather than
  // weakening a predicate. No second absolute-path key is introduced (spec §
  // Admission step 4).
  //
  // The shape guard is enforced HERE, before the resolver is reached: the
  // resolver names the pointer form with `path.isAbsolute(file)` ahead of its
  // own type check, so an absent/numeric/null `file` would surface as a native
  // `TypeError` instead of this boundary's refusal code. String pointers
  // (including empty or whitespace-only) still reach the resolver, whose typed
  // path detail is attached below.
  if (typeof declaredFile !== "string") {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} requires a file path as a string`, {
      plan_id: id,
      actual: declaredFile ?? null,
    });
  }
  let resolved: RegisteredPlanFile;
  try {
    resolved = resolveRegisteredPlanFile({ harnessRoot: context.harnessRoot, planId: id, file: declaredFile });
  } catch (error) {
    if (error instanceof PlanPathError) {
      throw prepareAmendmentRefusal("invalid-plan", error.message, {
        plan_id: id,
        path_code: error.code,
        ...error.details,
      });
    }
    throw error;
  }
  const planPath = resolved.planPath;
  const headers = planDeclaredHeaders(planPath);

  const metadata = value.metadata;
  if (!isPlainObject(metadata)) {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} metadata must be an object`, { plan_id: id, actual: metadata ?? null });
  }
  // §5 metadata disposition. A key the engine READS AS AUTHORITY may not be
  // written through this verb: the catalog pin belongs to `prepare`, and
  // promoting a caller's value into it would be exactly the authority elevation
  // the design forbids. Every OTHER key outside the recognized set is custom
  // metadata — carried onto the row inertly, never read back by the engine.
  const reservedMetadata = Object.keys(metadata).filter((key) => PREPARE_APPEND_AUTHORITY_METADATA_KEYS.includes(key));
  if (reservedMetadata.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata.${reservedMetadata.join(", metadata.")} is recorded authority, not custom metadata \u2014 it is written by the \`prepare\` transition and never by a Prepare append`,
      { plan_id: id, reserved: reservedMetadata },
    );
  }
  const customMetadata: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (!PREPARE_APPEND_METADATA_KEYS.includes(key)) customMetadata[key] = metadata[key];
  }
  if (Object.keys(customMetadata).length > 0) {
    // §5 W: preserved, and SAID so — a typo'd field must not vanish into an
    // inert container silently.
    context.warnings.push({
      code: "coordination.append-custom-metadata",
      path: `plans.${id}.metadata`,
      message:
        `plan ${id} records ${Object.keys(customMetadata).join(", ")} as custom metadata \u2014 carried onto the row inertly and never read as ` +
        "authority by this engine",
    });
  }
  // The governing spec is the one fact this append still selects itself; every
  // other reference is derived from the amended workflow's own declarations and
  // the appended plan document (§5 D — the amended lifecycle already holds
  // them), and a supplied value stays a constraint the derivation is compared
  // against.
  const primarySpec = prepareReferencePath(context.harnessRoot, metadata.primary_spec, "metadata.primary_spec", id);
  const specRefs =
    metadata.spec_refs === undefined
      ? [primarySpec]
      : prepareReferenceList(context.harnessRoot, metadata.spec_refs, "metadata.spec_refs", id);
  const iterationCompass =
    metadata.iteration_compass === undefined
      ? context.compass.path
      : prepareReferencePath(context.harnessRoot, metadata.iteration_compass, "metadata.iteration_compass", id);
  if (iterationCompass !== context.compass.path) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `plan ${id} metadata.iteration_compass ${iterationCompass} is not this workflow's reviewed compass ${context.compass.path}`,
      { plan_id: id, expected: context.compass.path, actual: iterationCompass },
    );
  }
  const iterationRefs =
    metadata.iteration_refs === undefined
      ? [iterationCompass]
      : prepareReferenceList(context.harnessRoot, metadata.iteration_refs, "metadata.iteration_refs", id);
  const anchors: WorkflowBranchAnchors = context.snapshot.branch ?? {};
  const intent = planBranchIntent(planPath, headers, id);
  if (intent.branch === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} markdown ${planPath} ${intent.source} \u2014 the appended row's branch metadata cannot be verified against the reviewed plan`,
      { plan_id: id, field: "metadata.working_branch", path: planPath, declared: intent.source },
    );
  }
  const workingBranch =
    metadata.working_branch === undefined ? intent.branch : prepareMetadataString(metadata, "working_branch", id);
  if (workingBranch !== intent.branch) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata.working_branch ${workingBranch} does not match the branch ${planPath} ${intent.source} (${intent.branch})`,
      { plan_id: id, expected: intent.branch, actual: workingBranch, path: planPath },
    );
  }
  const specIntegrationBranch = prepareDerivableMetadataString(
    metadata,
    "spec_integration_branch",
    isNonEmptyString(anchors.integration) ? anchors.integration : undefined,
    id,
  );
  const mergeTarget = prepareDerivableMetadataString(
    metadata,
    "merge_target",
    isNonEmptyString(anchors.integration) ? anchors.integration : undefined,
    id,
  );

  // Branch metadata must match the reviewed plan and the lifecycle it joins: a
  // row never claims the main, integration or target branch as its own work.
  for (const [label, branch] of [
    ["branch.base", anchors.base],
    ["branch.integration", anchors.integration],
    ["branch.target", anchors.target],
  ] as const) {
    if (isNonEmptyString(branch) && branch === workingBranch) {
      throw prepareAmendmentRefusal(
        "invalid-plan",
        `plan ${id} metadata.working_branch ${workingBranch} is the workflow's ${label} \u2014 a plan row owns its own feature branch`,
        { plan_id: id, field: "metadata.working_branch", actual: workingBranch },
      );
    }
  }
  // The plan document remains the reviewed authority for the main-worktree
  // anchor: this append cross-checks the branch the reviewed plan was written
  // against, and an absent header is never treated as agreement with the
  // branches the append itself claims.
  const declaredMain = headers.get("main worktree branch");
  if (declaredMain === undefined) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} markdown ${planPath} declares no Main worktree branch header \u2014 the amendment cannot verify the branch the reviewed plan was written against`,
      { plan_id: id, field: "mainWorktreeBranch", path: planPath },
    );
  }
  if (declaredMain !== context.mainWorktreeBranch) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} metadata records main worktree branch ${context.mainWorktreeBranch}, but ${planPath} declares ${declaredMain}`,
      { plan_id: id, expected: declaredMain, actual: context.mainWorktreeBranch, path: planPath },
    );
  }
  if (isNonEmptyString(anchors.integration)) {
    for (const [field, recorded] of [
      ["metadata.spec_integration_branch", specIntegrationBranch],
      ["metadata.merge_target", mergeTarget],
    ] as const) {
      if (recorded !== anchors.integration) {
        throw prepareAmendmentRefusal(
          "invalid-plan",
          `plan ${id} ${field} ${recorded} is not the workflow's integration branch ${anchors.integration}`,
          { plan_id: id, expected: anchors.integration, actual: recorded },
        );
      }
    }
  }
  if (context.compass.specIntegrationBranch !== undefined && specIntegrationBranch !== context.compass.specIntegrationBranch) {
    throw prepareAmendmentRefusal(
      "compass-mismatch",
      `plan ${id} metadata.spec_integration_branch ${specIntegrationBranch} is not the reviewed compass integration branch ${context.compass.specIntegrationBranch}`,
      { plan_id: id, expected: context.compass.specIntegrationBranch, actual: specIntegrationBranch },
    );
  }

  const row: PlanRow = {
    id,
    title,
    file: planPath,
    status: "Todo",
    owner: "project-manager",
    progress: 0,
    created_at: nowIso(),
    metadata: {
      primary_spec: primarySpec,
      spec_refs: specRefs,
      iteration_compass: iterationCompass,
      iteration_refs: iterationRefs,
      working_branch: workingBranch,
      spec_integration_branch: specIntegrationBranch,
      merge_target: mergeTarget,
      // §5 custom metadata: carried onto the row INERTLY — the engine never
      // reads these keys, so preserving them cannot elevate a caller's value
      // into a recorded fact.
      ...customMetadata,
    },
  };
  const gate = validatePlanRow(row);
  if (!gate.ok) {
    throw prepareAmendmentRefusal("invalid-plan", `constructed row ${id} fails plan-row validation \u2014 ${summarize(gate.violations)}`, {
      plan_id: id,
      violations: gate.violations.map((entry) => entry.code),
    });
  }
  return row;
}

/**
 * The recorded integration checkout (§ Admission and mutation step 5): real and
 * canonical, a distinct Git checkout of the repository that owns the validated
 * control harness root, and actually on the workflow's recorded
 * `branch.integration`. Nothing is created, switched, fetched or cleaned — a
 * wrong or aliased checkout refuses instead.
 */
function readIntegrationWorktreePath(
  value: unknown,
  context: { harnessRoot: string; snapshot: WorkflowSnapshot; main: MainWorktreeInfo },
): string {
  const refuse = (message: string, details: Record<string, unknown> = {}): never => {
    throw prepareAmendmentRefusal("invalid-worktree", message, details);
  };
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    return refuse(`integrationWorktreePath must be an absolute path \u2014 got ${JSON.stringify(value ?? null)}`, {
      actual: value ?? null,
    });
  }
  const path = canonicalTarget(value);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    return refuse(`integration checkout ${path} does not exist`, { path, expected: value });
  }
  const mainRoot = canonicalTarget(context.main.root);
  const control = canonicalizeNearestExisting(context.harnessRoot);
  // The repository that owns the validated control harness root is the only
  // anchor this proof may use. A coordinator envelope can be presented from a
  // different clone of the same project, whose own repository — and whose own
  // checkouts — are not this lifecycle's; anchoring on the repository enclosing
  // the caller's cwd alone would record that clone's checkout. So the caller's
  // enclosing repository must be the control root's repository, and so must the
  // candidate.
  const controlRepo = readMainWorktree(control);
  if (controlRepo === null) {
    return refuse(
      `the control harness root ${control} has no readable Git main worktree \u2014 the integration checkout cannot be proven to be a checkout of this repository`,
      { path, harness_root: control },
    );
  }
  const controlMainRoot = canonicalTarget(controlRepo.root);
  if (controlMainRoot !== mainRoot) {
    return refuse(
      `this call runs from the main worktree of ${mainRoot}, not the repository owning the control harness root ${control} (${controlMainRoot}) \u2014 the recorded checkout must belong to that repository`,
      { path, expected: controlMainRoot, actual: mainRoot },
    );
  }
  if (path === mainRoot || path === control) {
    return refuse(`integration checkout ${path} is the main/control checkout \u2014 a dedicated integration worktree is required`, {
      path,
      expected: `a checkout distinct from ${mainRoot}`,
    });
  }
  const repo = readMainWorktree(path);
  if (repo === null || canonicalTarget(repo.root) !== controlMainRoot) {
    return refuse(
      `integration checkout ${path} is not a checkout of the repository owning the control harness root ${control} (${controlMainRoot})`,
      {
        path,
        expected: controlMainRoot,
        actual: repo === null ? null : canonicalTarget(repo.root),
      },
    );
  }
  if (!isDistinctCheckout(context.main.root, path)) {
    return refuse(`integration checkout ${path} is not a distinct checkout (same Git checkout as ${mainRoot})`, {
      path,
      expected: `a checkout distinct from ${mainRoot}`,
    });
  }
  const integrationBranch = context.snapshot.branch?.integration;
  if (!isNonEmptyString(integrationBranch)) {
    return refuse(
      `workflow ${context.snapshot.id} records no branch.integration \u2014 the integration checkout cannot be verified`,
      { workflow_id: context.snapshot.id, path },
    );
  }
  const branch = gitRead(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== integrationBranch) {
    return refuse(
      `integration checkout ${path} is on ${branch === undefined ? "an unreadable checkout" : branch || "a detached HEAD"}, not the recorded ${integrationBranch}`,
      { path, expected: integrationBranch, actual: branch ?? null },
    );
  }
  return path;
}

/** One pointer correction as the commit path applies it: the row and its canonical file. */
type PreparePlanFileCorrectionDelta = Readonly<{ id: string; file: string }>;

/**
 * The resolved outcome of one correction component (§4.1/A09): either the pointer
 * delta this call commits, or the recognition that the addressed row ALREADY
 * holds that plan's canonical file — the same intent, satisfied, so the
 * component is held and no second mutation is spent on it.
 */
type PreparePlanFileCorrectionOutcome =
  | Readonly<{ held: true; id: string }>
  | Readonly<{ held: false; delta: PreparePlanFileCorrectionDelta }>;

/**
 * The exact repository-relative spelling of a plan file, derived from this
 * control root's **configured** plan directory and the repository root that
 * owns the harness — the malformed form rows registered before P2 still hold
 * (`.mstar/plans/<id>.md`), and the one recovery spelling prerequisite contract
 * §4.1 admits for the *old* pointer only.
 *
 * It is derived, never searched: the spelling is the relative path from the
 * repository root to the canonical plan file, must not be absolute or escape
 * that root, and must resolve back to the same canonical target (so an alias or
 * a symlinked ancestor cannot make a different file pass). `undefined` means
 * this control root has no repository root to derive the form from, and then
 * only the declared forms count.
 */
function repositoryRelativePlanPointer(harnessRoot: string, planPath: string): string | undefined {
  const repository = readMainWorktree(canonicalizeNearestExisting(harnessRoot));
  if (repository === null) return undefined;
  const repositoryRoot = canonicalTarget(repository.root);
  const spelling = relative(repositoryRoot, planPath);
  if (spelling === "" || isAbsolute(spelling) || spelling === ".." || spelling.startsWith(`..${sep}`)) return undefined;
  if (canonicalTarget(join(repositoryRoot, spelling)) !== planPath) return undefined;
  return spelling;
}

/**
 * The addressed ROW's own execution ownership (E07 action-local admission): a
 * plan-file correction repairs a registration pointer of a row that has not
 * started executing, because that row's document identity is already sealed into
 * its execution input. The row's status, progress, lease and coordination block
 * are its OWN facts — reading them is reading the addressed row — while sibling
 * rows are never consulted, so one row's preparation, lease or progress can
 * never block a repair of another row (A06).
 */
function assertUnstartedAddressedRow(row: PlanRow, workflowId: string): void {
  const planId = rowPlanIds(row)[0] ?? "";
  const status = rowStatusOf(row);
  if (status !== "Todo") {
    throw prepareAmendmentRefusal(
      "execution-started",
      `plan ${planId} is ${status} \u2014 a plan-file correction repairs a registration pointer, never a row that has begun executing`,
      { workflow_id: workflowId, plan_id: planId, actual: status },
    );
  }
  if (row.progress !== undefined && row.progress !== 0) {
    throw prepareAmendmentRefusal(
      "execution-started",
      `plan ${planId} reports progress ${JSON.stringify(row.progress)} \u2014 a plan-file correction must not rewrite executed work`,
      { workflow_id: workflowId, plan_id: planId, actual: row.progress },
    );
  }
  if (row.coordination !== undefined) {
    throw prepareAmendmentRefusal(
      "execution-started",
      `plan ${planId} carries a coordination block \u2014 preparation or execution evidence already exists for this row`,
      { workflow_id: workflowId, plan_id: planId, revision: rowCoordinationOf(row)?.revision ?? null },
    );
  }
}

/**
 * One existing row's plan-file pointer correction (prerequisite contract §4.1).
 * The addressed row must be exactly one registered row of this workflow, the
 * pointer it holds now must be **exactly** the caller's `expectedFile`, that old
 * pointer must identify the same plan, and the corrected pointer must pass the
 * shared registered-plan resolver — the canonical configured
 * `{PLAN_DIR}/<id>.md`, with a matching declared `plan_id`.
 *
 * The old pointer is accepted in only two forms: a pointer the shared resolver
 * itself accepts (the canonical absolute or the normalized harness-relative
 * spelling), or the exact derived repository-relative spelling of that same
 * canonical target. Everything else refuses — a foreign absolute path, a
 * same-basename guess, an unrelated directory prefix, a copied plan markdown
 * with a matching header, a pointer naming another plan. The returned delta is
 * the pointer alone: a correction carries no other row field, so it can neither
 * rebind a row to a different document nor change a row's contents, status or
 * metadata. A row that already carries preparation or execution evidence
 * refuses earlier, at the admission that gates every amendment.
 */
function readPlanFileCorrection(
  value: unknown,
  context: { harnessRoot: string; snapshot: WorkflowSnapshot },
): PreparePlanFileCorrectionOutcome {
  if (!isPlainObject(value)) {
    throw prepareAmendmentRefusal("invalid-plan", "every correctPlanFiles entry must be an object", { actual: value ?? null });
  }
  const unexpected = Object.keys(value).filter((key) => !PREPARE_CORRECTION_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `a plan-file correction accepts only ${PREPARE_CORRECTION_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpected.join(", ")}`,
      { allowed: [...PREPARE_CORRECTION_KEYS], unexpected },
    );
  }
  const id = value.id;
  if (!isNonEmptyString(id)) {
    throw prepareAmendmentRefusal("invalid-plan", `a plan-file correction requires a non-empty id \u2014 got ${JSON.stringify(id ?? null)}`, {
      actual: id ?? null,
    });
  }
  try {
    assertSafePathComponent(id, "plan id");
  } catch (error) {
    throw prepareAmendmentRefusal("invalid-plan", `plan id ${JSON.stringify(id)} is not a safe path component: ${errorMessage(error)}`, {
      plan_id: id,
    });
  }
  // Exactly one row may address the id: a correction addresses the row the
  // caller observed, never "whichever row matched first".
  const addressed = context.snapshot.plans.filter((row) => rowPlanIds(row).includes(id));
  if (addressed.length === 0) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} is not a row of workflow ${context.snapshot.id} \u2014 a correction repairs an existing row's pointer and never creates one`,
      { plan_id: id, workflow_id: context.snapshot.id },
    );
  }
  if (addressed.length > 1) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} is addressed by ${addressed.length} rows of workflow ${context.snapshot.id} \u2014 the corrected row would be ambiguous`,
      { plan_id: id, workflow_id: context.snapshot.id, rows: addressed.length },
    );
  }
  const row = addressed[0]!;
  // The addressed row's own execution state is its own read set (§4.1):
  // unstarted rows only. Sibling rows are not consulted.
  assertUnstartedAddressedRow(row, context.snapshot.id);
  const previous = row.file;
  if (!isNonEmptyString(previous)) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} records no readable file pointer \u2014 a correction cannot prove which pointer it replaces`,
      { plan_id: id, actual: previous ?? null },
    );
  }
  const expectedFile = value.expectedFile;
  if (typeof expectedFile !== "string") {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} correction requires expectedFile as a string \u2014 got ${JSON.stringify(expectedFile ?? null)}`,
      { plan_id: id, actual: expectedFile ?? null },
    );
  }
  const declared = value.file;
  // Shape first, like the append path: the shared resolver names the pointer
  // form with `path.isAbsolute(file)` before its own type check.
  if (typeof declared !== "string") {
    throw prepareAmendmentRefusal("invalid-plan", `plan ${id} requires a corrected file path as a string`, {
      plan_id: id,
      actual: declared ?? null,
    });
  }
  let resolved: RegisteredPlanFile;
  try {
    resolved = resolveRegisteredPlanFile({ harnessRoot: context.harnessRoot, planId: id, file: declared });
  } catch (error) {
    if (error instanceof PlanPathError) {
      throw prepareAmendmentRefusal("invalid-plan", error.message, {
        plan_id: id,
        path_code: error.code,
        ...error.details,
      });
    }
    throw error;
  }
  const planPath = resolved.planPath;
  // §5/A09/A12 the exact already-applied correction is a CURRENT SUCCESS: the
  // addressed row already records this plan's canonical file, so the requested
  // effect holds and this call writes nothing for it. But the caller's
  // `expectedFile` must still NAME THIS PLAN's document — a pointer to a
  // foreign file observed a read set this row never had, so answering success
  // over it would launder an incoherent constraint through the replay rule. A
  // previous spelling of THIS plan's own pointer (the pre-correction form a
  // replayed patch still carries) is the same intent, satisfied.
  const expectedIdentifiesPlan =
    expectedFile === planPath ||
    (() => {
      try {
        return resolveRegisteredPlanFile({ harnessRoot: context.harnessRoot, planId: id, file: expectedFile }).planPath === planPath;
      } catch (error) {
        if (!(error instanceof PlanPathError)) throw error;
        return false;
      }
    })() ||
    expectedFile === repositoryRelativePlanPointer(context.harnessRoot, planPath);
  if (!expectedIdentifiesPlan) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} expectedFile ${JSON.stringify(expectedFile)} does not identify this plan's own file ${planPath} \u2014 a correction repairs a malformed pointer of the same plan, it never rebinds a row, and a replay must still name this plan's document`,
      { plan_id: id, actual: expectedFile, expected: planPath },
    );
  }
  if (previous === planPath) return { held: true, id };
  // The exact observed value, not a normalised one: a correction applies to the
  // pointer this patch was reviewed against, so a row that moved underneath the
  // caller refuses instead of being repointed from a stale observation.
  if (previous !== expectedFile) {
    throw prepareAmendmentRefusal(
      "invalid-plan",
      `plan ${id} row holds file ${JSON.stringify(previous)}, not the expectedFile ${JSON.stringify(expectedFile)} this correction was reviewed against \u2014 re-read the snapshot and review the pointer again`,
      { plan_id: id, expected: expectedFile, actual: previous },
    );
  }
  return { held: false, delta: { id, file: planPath } };
}

/**
 * The validated delta of one amendment, as its independent COMPONENTS. This is
 * the partition surface the commit path (E08) consumes: each component names
 * the facts it read, so a patch whose components are independent still lands
 * the ones that carry no conflict, while components that share a semantic read
 * or write — the recorded integration checkout and its policy, an appended row
 * and the reviewed integration topology it joins — stay connected and commit
 * together. Resolving and validating them is this verb's job; committing them
 * is the authority-specific commit path (this verb's snapshot lock on the
 * supported file route, the frame's own transaction on the ACTIVE DB route).
 */
type PrepareProposal = {
  /** One new approved row per entry — the `append` component. */
  rows: PlanRow[];
  /** The addressed existing rows' normalized pointers — the `correct-plan-file` component. */
  corrections: readonly PreparePlanFileCorrectionDelta[];
  /** The recorded integration checkout — the `integration-worktree` component. */
  integrationWorktreePath?: string;
  /** The approved concurrency key — the `execution-policy` component. */
  planParallelism?: string;
  /** §4.1 drift this patch does NOT consume: reported as a warning, never a refusal. */
  warnings: readonly ResolutionWarning[];
  /** The declarations each normalized value was resolved from (provenance). */
  resolvedFrom: readonly ResolutionSource[];
  /** Every component this patch ADDRESSES, in stable order (once each). */
  components: readonly string[];
};

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

/**
 * The minimum decision one component's own refusal code asks a caller for
 * (§1.3/§6.2): the withheld effect names what is genuinely missing, never an
 * invented field or a re-statement of a fact the caller already supplied.
 */
const AMENDMENT_MINIMUM: Readonly<Record<string, string>> = {
  "coordination.prepare-amendment.duplicate-plan": "a plan id this workflow does not already hold, or the removal of that entry from the patch",
  "coordination.prepare-amendment.invalid-plan": "an addressed existing unstarted row named by that plan's own registered file",
  "coordination.prepare-amendment.invalid-patch": "a patch whose addressed fields are well formed",
  "coordination.prepare-amendment.compass-mismatch": "an addressed plan, checkout or branch the reviewed compass declares",
  "coordination.prepare-amendment.execution-started": "the addressed fact's own execution state settled, or that entry removed from the patch",
  "coordination.prepare-amendment.invalid-worktree": "an existing distinct checkout of this repository on branch.integration",
  "coordination.not-in-git": "a readable main worktree of the caller's checkout, or a patch whose components read no checkout fact",
  "coordination.scope-mismatch": "a call from the main worktree of the branch the patch declares",
};

/**
 * One component of a patch this call WITHHOLDS (§4.1/A23/§6.2): the component
 * keeps its own refusal code, its own field details and its own typed problem,
 * so a patch that addresses several components reports ALL of them at once
 * (A27) — one minimum choice per withheld component, not one failed call per
 * component — while the components that carry no conflict still land.
 */
type PrepareAmendmentProblem = Readonly<{
  /** The component's stable identity (`prepareAmendmentComponent`). */
  component: string;
  /** The patch field the caller repairs (`appendPlans[1]`, `integrationWorktreePath`, …). */
  path: string;
  /** The component's own refusal code — an existing public `coordination.*` code. */
  code: string;
  /** The details the single-component refusal reported, kept verbatim. */
  details: Record<string, unknown>;
  /** The frozen typed problem (§1.3): sources tried, current facts, minimum decision. */
  recovery: RecoveryProblem;
}>;

/** One component resolution: its resolved value, or its own typed problem. */
type ComponentOutcome<T> = { ok: true; value: T } | { ok: false; problem: PrepareAmendmentProblem };

/**
 * The partitioned amendment: E07's admissible delta plus the per-component
 * verdicts that make an applied/held/unresolved split explicit (§6.2/A23).
 */
type PrepareAmendmentPlan = Readonly<{
  proposal: PrepareProposal;
  /** The components whose effect this call records, once each, in stable order. */
  applied: readonly string[];
  /** The components already recorded before this call (recognized, never re-applied). */
  held: readonly string[];
  /** The components this call withholds, each with its own typed problem. */
  unresolved: readonly PrepareAmendmentProblem[];
}>;

/** One typed problem for a component that never reached — or failed inside — its own reader. */
function componentProblem(input: {
  component: string;
  path: string;
  code: string;
  message: string;
  needed: string;
  details?: Record<string, unknown>;
  sourcesTried?: readonly string[];
  withheldEffect?: string;
}): PrepareAmendmentProblem {
  return {
    component: input.component,
    path: input.path,
    code: input.code,
    details: input.details ?? {},
    recovery: {
      component: input.component,
      path: input.path,
      code: input.code,
      sourcesTried: [...(input.sourcesTried ?? [`${input.path} (intent.request)`])],
      currentFacts: [input.message],
      needed: input.needed,
      withheldEffect: input.withheldEffect ?? `${input.component} is left exactly as it was; no part of it is half-applied`,
      availableWork: ["the unaffected components of this same patch", "reads and unrelated amendments of this lifecycle"],
    },
  };
}

/**
 * Resolve one component through its own reader, converting that reader's typed
 * refusal into this component's problem. Only a `CoordinationError` — this
 * surface's refusal vocabulary — is converted; anything else is a real fault
 * and travels unchanged.
 */
function captureComponent<T>(component: string, path: string, run: () => T): ComponentOutcome<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (!(error instanceof CoordinationError)) throw error;
    const target = isNonEmptyString(error.details.path) ? error.details.path : undefined;
    return {
      ok: false,
      problem: componentProblem({
        component,
        path,
        code: error.code,
        message: errorMessage(error),
        needed: AMENDMENT_MINIMUM[error.code] ?? `the ${path} entry revised so this component can be applied`,
        details: error.details,
        sourcesTried: [...[`${path} (intent.request)`], ...(target === undefined ? [] : [`${target} (resolved target)`])],
      }),
    };
  }
}

/**
 * The ONE refusal of a patch with withheld components (§6.2/A27): the primary
 * component's own code and details stay the refusal's classification, and the
 * sidecar names every withheld component with its own problem. A caller reads
 * one result rather than N failed calls, and the receipt never claims this call
 * was mutation-free when an independent component of the same patch landed.
 */
function refuseAmendment(
  problems: readonly PrepareAmendmentProblem[],
  input: { workflowId: string; components: readonly string[]; recovery: RecoveryDetails },
): never {
  const primary = problems[0]!;
  const rest = problems.slice(1);
  const fact = String(primary.recovery.currentFacts[0] ?? primary.code);
  const message =
    rest.length === 0
      ? fact
      : `${fact} \u2014 ${rest.length} further component(s) of this patch are withheld: ${rest.map((entry) => entry.component).join(", ")}`;
  throw new CoordinationError(primary.code as CoordinationErrorCode, message, {
    ...primary.details,
    workflow_id: input.workflowId,
    withheld_components: problems.map((entry) => entry.component),
    components: [...input.components],
    recovery: input.recovery,
  });
}


/**
 * The reviewed compass's `integration_worktree_path` declaration against the
 * checkout this commit would leave in place (§4.1). The declaration binds the
 * components that CONSUME an integration projection — an appended row, which
 * joins the reviewed integration topology, and the recorded checkout itself; a
 * plan-file pointer correction consumes nothing and reports the same
 * contradiction as drift instead.
 */
function compassCheckoutContradiction(
  context: { snapshot: WorkflowSnapshot; compass: PrepareCompass },
  requestedPath: unknown,
  recordedPath: string | undefined,
): { message: string; details: Record<string, unknown> } | undefined {
  if (context.compass.integrationWorktreePath === undefined) return undefined;
  const declaredPath = canonicalTarget(context.compass.integrationWorktreePath);
  const effectivePath = isNonEmptyString(requestedPath) ? canonicalTarget(requestedPath) : recordedPath;
  if (effectivePath === declaredPath) return undefined;
  return {
    message:
      `workflow ${context.snapshot.id} would record integration checkout ${effectivePath ?? "(none)"}, but the reviewed compass ` +
      `${context.compass.path} declares ${declaredPath}`,
    details: { path: effectivePath ?? null, expected: declaredPath, actual: effectivePath ?? null },
  };
}

/**
 * The recorded integration checkout and its policy: ONE connected component
 * group (§4.1 — "connected path/ownership/policy changes commit together").
 * Either both requested members land or neither does, and each withheld member
 * names the same group problem, so a caller never observes a half-applied pair.
 *
 * The checkout is VALIDATED only when it would change the recording: a
 * re-stated recorded checkout is the effect already held (§4.2/A12), and
 * re-validating a satisfied path would turn a stale precursor into a refusal.
 */
function readIntegrationGroup(input: {
  patch: Record<string, unknown>;
  context: { harnessRoot: string; snapshot: WorkflowSnapshot; compass: PrepareCompass; main: MainWorktreeInfo | null; cwd: string };
  recordedPath: string | undefined;
  /** The policy value the group would record, when the patch named an approved one. */
  requestedPolicy: string | undefined;
  /** Whether the patch addressed `planParallelism` at all — a malformed value included. */
  policyRequested: boolean;
  /** The identity of the policy member, naming the value the caller sent. */
  policyIdentity: string;
  /** A malformed `planParallelism` value: this GROUP's own problem (E08 fix round 1). */
  policyProblem: { code: string; message: string; needed: string; details: Record<string, unknown> } | undefined;
  recordedParallelism: unknown;
  checkoutFact: { code: string; message: string; details: Record<string, unknown> } | undefined;
}): {
  /** The identity of the requested checkout component, built from its canonical effective path. */
  pathComponent: string;
  /** The identity of the requested policy component. */
  policyComponent: string;
  path?: string;
  pathHeld: boolean;
  policy?: string;
  policyHeld: boolean;
  problems: PrepareAmendmentProblem[];
  /** The checkout this patch would leave in place (the effective value). */
  effectivePath: string | undefined;
} {
  const { context } = input;
  const requestedPath = input.patch.integrationWorktreePath;
  const pathRequested = requestedPath !== undefined;
  const policyRequested = input.policyRequested;
  // §4.1/E08 the checkout component's identity is the CANONICAL effective path —
  // the value this call records — so a lexical or symlink alias of one checkout
  // can never be a second `recovery` component, and it is the same identity the
  // ACTIVE route builds from `canonicalTarget(operation.path)`.
  const pathComponent = prepareAmendmentComponent(
    "integration-worktree",
    isNonEmptyString(requestedPath) ? canonicalTarget(requestedPath) : String(requestedPath),
  );
  const policyComponent = prepareAmendmentComponent("execution-policy", input.policyIdentity);
  const effectivePath = isNonEmptyString(requestedPath) ? canonicalTarget(requestedPath) : input.recordedPath;
  const pathHeld = pathRequested && isNonEmptyString(requestedPath) && canonicalTarget(requestedPath) === input.recordedPath;
  // A malformed value is never the effect already held: it is this group's problem.
  const policyHeld =
    policyRequested && input.policyProblem === undefined && input.requestedPolicy === input.recordedParallelism;
  const problems: PrepareAmendmentProblem[] = [];
  const pathChanges = pathRequested && !pathHeld;
  const policyChanges = policyRequested && !policyHeld;
  if (!pathChanges && !policyChanges) {
    return { pathComponent, policyComponent, pathHeld, policyHeld, problems, effectivePath };
  }
  const members = [
    ...(pathRequested ? [{ component: pathComponent, path: "integrationWorktreePath" }] : []),
    ...(policyRequested ? [{ component: policyComponent, path: "planParallelism" }] : []),
  ];
  // The connected group is withheld as ONE unit: each member names the same
  // problem, so neither of them can be observed as applied on its own.
  const withhold = (
    code: string,
    message: string,
    details: Record<string, unknown>,
    options: { sourcesTried?: readonly string[]; needed?: string } = {},
  ): void => {
    for (const member of members) {
      problems.push(
        componentProblem({
          component: member.component,
          path: member.path,
          code,
          message,
          details,
          needed: options.needed ?? AMENDMENT_MINIMUM[code] ?? `the ${member.path} entry revised so this component can be applied`,
          ...(options.sourcesTried === undefined ? {} : { sourcesTried: options.sourcesTried }),
        }),
      );
    }
  };
  // A malformed component-scoped field withholds the GROUP it belongs to: the
  // policy value this patch addressed cannot be recorded, so the connected
  // checkout member cannot land without it either (E08 fix round 1) — while the
  // appends and corrections of the same patch are unaffected (A23/A27).
  if (input.policyProblem !== undefined) {
    withhold(input.policyProblem.code, input.policyProblem.message, input.policyProblem.details, {
      needed: input.policyProblem.needed,
    });
  }
  // §4.1 the integration OWNERSHIP is in flight: neither member may rewrite a
  // fact the merging owner is using (A06: appends and corrections are not
  // affected — they consume no integration ownership).
  if (context.snapshot.integration_merge_lease !== undefined) {
    withhold(
      "coordination.prepare-amendment.execution-started",
      `workflow ${context.snapshot.id} carries an integration merge lease \u2014 the integration checkout/policy this patch would record cannot be rewritten while the integration owner is merging`,
      { workflow_id: context.snapshot.id },
    );
  }
  // §4.1 the reviewed branch declaration binds the integration state this group
  // would leave recorded.
  if (context.compass.specIntegrationBranch !== undefined) {
    const recordedBranch = context.snapshot.branch?.integration;
    if (!isNonEmptyString(recordedBranch) || recordedBranch !== context.compass.specIntegrationBranch) {
      withhold(
        "coordination.prepare-amendment.compass-mismatch",
        `workflow ${context.snapshot.id} records integration branch ${JSON.stringify(recordedBranch ?? null)}, but the reviewed compass ` +
          `${context.compass.path} declares ${context.compass.specIntegrationBranch}`,
        { expected: context.compass.specIntegrationBranch, actual: recordedBranch ?? null },
      );
    }
  }
  const contradiction = compassCheckoutContradiction(
    context,
    pathChanges ? requestedPath : undefined,
    input.recordedPath,
  );
  if (contradiction !== undefined) {
    withhold("coordination.prepare-amendment.compass-mismatch", contradiction.message, contradiction.details);
  }
  // A24/A25 the checkout/branch fact this pair consumes — the same partition the
  // appended rows obey.
  if (input.checkoutFact !== undefined && pathRequested) {
    withhold(input.checkoutFact.code, input.checkoutFact.message, input.checkoutFact.details, {
      sourcesTried: [
        "integrationWorktreePath (intent.request)",
        `${resolve(context.cwd)} (main worktree)`,
      ],
    });
  }
  let path: string | undefined;
  const main = context.main;
  if (pathChanges && problems.length === 0 && main !== null) {
    const attempt = captureComponent(pathComponent, "integrationWorktreePath", () =>
      readIntegrationWorktreePath(requestedPath, { harnessRoot: context.harnessRoot, snapshot: context.snapshot, main }),
    );
    if (attempt.ok) path = attempt.value;
    else problems.push(attempt.problem);
  }
  if (problems.length > 0) return { pathComponent, policyComponent, pathHeld, policyHeld, problems, effectivePath };
  return {
    ...(path !== undefined ? { path } : {}),
    pathComponent,
    policyComponent,
    pathHeld,
    ...(policyChanges && input.requestedPolicy !== undefined ? { policy: input.requestedPolicy } : {}),
    policyHeld,
    problems,
    effectivePath,
  };
}

/**
 * The patch, validated against the workflow, the plan files and the reviewed
 * compass (§ Admission and mutation steps 4–6) and PARTITIONED into independent
 * components (§4.1/E08). Each component is resolved through the facts it alone
 * consumes, so one component's conflict withholds that component — with its own
 * typed problem, reported together with every other withheld component (A27) —
 * while the components that carry no conflict still land in the same call
 * (A23). Components connected by a shared semantic read or write (the recorded
 * integration checkout and its policy) commit together or not at all.
 *
 * Only facts that invalidate the patch AS A WHOLE refuse before the partition:
 * the patch shape (aggregated, every broken field path at once — a malformed
 * `planParallelism` is included there only when another patch-wide reason already
 * withholds the whole patch) and a patch that addresses nothing at all. Every
 * other malformation is COMPONENT-scoped and is recorded against the component(s)
 * it affects — an entry whose id another entry also declares, a policy value
 * outside the approved set — so it is reported with the components that landed.
 */
function readPrepareAmendment(
  patch: unknown,
  context: {
    harnessRoot: string;
    snapshot: WorkflowSnapshot;
    compass: PrepareCompass;
    /** The Git-derived main worktree, or `null` when the Git fact is unreadable. */
    main: MainWorktreeInfo | null;
    cwd: string;
  },
): PrepareAmendmentPlan {
  if (!isPlainObject(patch)) {
    throw prepareAmendmentRefusal("invalid-patch", "the amendment patch must be an object", { actual: patch ?? null });
  }
  const invalidPatch = "coordination.prepare-amendment.invalid-patch";
  const wholePatchWithheld = "the whole patch is withheld; nothing was written";
  const shape: PrepareAmendmentProblem[] = [];
  const unexpected = Object.keys(patch).filter((key) => !PREPARE_PATCH_KEYS.includes(key));
  if (unexpected.length > 0) {
    shape.push(
      componentProblem({
        component: "patch",
        path: "patch",
        code: invalidPatch,
        message: `the amendment patch accepts only ${PREPARE_PATCH_KEYS.join(", ")} \u2014 unexpected key(s): ${unexpected.join(", ")}`,
        needed: AMENDMENT_MINIMUM[invalidPatch]!,
        details: { allowed: [...PREPARE_PATCH_KEYS], unexpected },
        withheldEffect: wholePatchWithheld,
      }),
    );
  }
  const branchValue = patch.mainWorktreeBranch;
  if (!isNonEmptyString(branchValue)) {
    shape.push(
      componentProblem({
        component: "patch",
        path: "mainWorktreeBranch",
        code: invalidPatch,
        message: `the amendment patch requires mainWorktreeBranch as a non-empty string \u2014 got ${JSON.stringify(branchValue ?? null)}`,
        needed: "the branch the caller's main worktree is on",
        details: { actual: branchValue ?? null },
        withheldEffect: wholePatchWithheld,
      }),
    );
  }
  const appendsValue = patch.appendPlans;
  if (!Array.isArray(appendsValue)) {
    shape.push(
      componentProblem({
        component: "patch",
        path: "appendPlans",
        code: invalidPatch,
        message: "the amendment patch requires appendPlans as an array",
        needed: "the approved plan rows this patch appends (an empty array is a correction-only call)",
        details: { actual: appendsValue ?? null },
        withheldEffect: wholePatchWithheld,
      }),
    );
  }
  const correctionsValue = patch.correctPlanFiles;
  if (correctionsValue !== undefined && !Array.isArray(correctionsValue)) {
    shape.push(
      componentProblem({
        component: "patch",
        path: "correctPlanFiles",
        code: invalidPatch,
        message: "the amendment patch requires correctPlanFiles as an array",
        needed: "the addressed rows' pointer corrections (an empty array is an append-only call)",
        details: { actual: correctionsValue ?? null },
        withheldEffect: wholePatchWithheld,
      }),
    );
  }
  // §4.1/E08 `planParallelism` is a COMPONENT-scoped field: its value is the
  // `execution-policy` member of the connected integration/policy group, so a
  // malformed value withholds that GROUP inside the partition instead of failing
  // the whole amendment before it — an independent component of the same patch
  // still lands. A patch that IS withheld whole for a genuinely patch-wide
  // reason additionally names it below, so one answer still lists every broken
  // field path (A27/§6.2).
  const parallelismValue = patch.planParallelism;
  const policyProblem =
    parallelismValue === undefined || (isNonEmptyString(parallelismValue) && PLAN_PARALLELISM_VALUES.includes(parallelismValue))
      ? undefined
      : {
          code: invalidPatch,
          message: `planParallelism must be one of ${PLAN_PARALLELISM_VALUES.join(" | ")} \u2014 got ${JSON.stringify(parallelismValue ?? null)}`,
          needed: `one of ${PLAN_PARALLELISM_VALUES.join(" | ")}`,
          details: { allowed: [...PLAN_PARALLELISM_VALUES], actual: parallelismValue ?? null },
        };
  if (shape.length > 0 && policyProblem !== undefined) {
    shape.push(
      componentProblem({
        component: "patch",
        path: "planParallelism",
        code: policyProblem.code,
        message: policyProblem.message,
        needed: policyProblem.needed,
        details: policyProblem.details,
        withheldEffect: wholePatchWithheld,
      }),
    );
  }
  // §6.2/A27: one refusal naming every broken patch-level field, not the first.
  if (shape.length > 0) {
    refuseAmendment(shape, {
      workflowId: context.snapshot.id,
      components: [],
      recovery: unresolvedRecovery({
        target: { workflowId: context.snapshot.id },
        unresolved: shape.map((entry) => entry.recovery),
      }),
    });
  }
  const mainWorktreeBranch = isNonEmptyString(branchValue) ? branchValue : "";
  const appends: readonly unknown[] = Array.isArray(appendsValue) ? appendsValue : [];
  const correctionsIn: readonly unknown[] = Array.isArray(correctionsValue) ? correctionsValue : [];
  const requestedPolicy = isNonEmptyString(parallelismValue) ? parallelismValue : undefined;
  // Whether the patch ADDRESSED the policy at all, so a malformed value is a
  // component of this patch rather than an unaddressed field. The identity names
  // the value the caller sent, exactly as the checkout component names its path.
  const policyRequested = parallelismValue !== undefined;
  const policyIdentity = isNonEmptyString(parallelismValue) ? parallelismValue : String(parallelismValue);
  const requestedPath = patch.integrationWorktreePath;
  const warnings: ResolutionWarning[] = [];
  // The caller's checkout identity. A component that CONSUMES an owned
  // checkout/branch fact — an appended row's plan-document anchor, the recorded
  // integration checkout — genuinely needs the Git-derived main worktree to be
  // on the declared branch, and an unreadable/differing Git fact withholds THAT
  // component as an unavailable prerequisite (A25). A local repair consumes
  // neither, so it proceeds on its trusted envelope root and reports the same
  // fact as a warning (R12/A24): an environment outage is never promoted into a
  // gate over work that does not depend on it. §4.1/E08 the fact is now
  // component-scoped, so a patch that carries both a repair and an append lands
  // the repair and withholds the append with its own typed problem.
  const consumesCheckoutFacts = appends.length > 0 || requestedPath !== undefined;
  let checkoutFact: { code: string; message: string; details: Record<string, unknown> } | undefined;
  if (context.main === null) {
    if (consumesCheckoutFacts) {
      checkoutFact = {
        code: "coordination.not-in-git",
        message:
          `this amendment records branch ${mainWorktreeBranch} on an appended plan row or an integration checkout, but ${resolve(context.cwd)} ` +
          "has no readable main worktree to verify it against",
        details: { cwd: resolve(context.cwd) },
      };
    } else {
      warnings.push({
        code: "coordination.git-unavailable",
        path: "cwd",
        message:
          `the main worktree of ${resolve(context.cwd)} could not be read; this amendment repairs registration facts that need no Git fact, so it ` +
          "proceeds on the trusted envelope root and the declared branch is not verified",
      });
    }
  } else if (context.main.branch !== mainWorktreeBranch) {
    // `branch.base` is a recorded anchor, not residency, so it is never the
    // expectation here.
    const on = context.main.branch === "" ? "a detached HEAD" : context.main.branch;
    if (consumesCheckoutFacts) {
      checkoutFact = {
        code: "coordination.scope-mismatch",
        message: `the main worktree ${context.main.root} is on ${on}, but this amendment declares ${mainWorktreeBranch}`,
        details: { expected: mainWorktreeBranch, actual: context.main.branch },
      };
    } else {
      warnings.push({
        code: "coordination.main-branch-drift",
        path: "cwd",
        message:
          `the main worktree ${context.main.root} is on ${on}, but this amendment declares ${mainWorktreeBranch}; this amendment repairs registration ` +
          "facts that no checkout fact binds, so it proceeds on the trusted envelope root and the declared branch is not enforced",
      });
    }
  }
  // §4.1 one identity per addressed plan: an id is either new (appended) or
  // existing (corrected), never both, and never twice in one patch. The rule is
  // enforced PER ENTRY instead of as a preflight throw (E08 fix round 1): an id
  // that more than one entry declares names no single component, so EVERY entry
  // carrying it is withheld with its own problem — the same public code and
  // `plan_id` the whole-patch refusal reported — while the unrelated components
  // of the same patch still land (A23) and one receipt aggregates them (A27).
  const appendIdCounts = new Map<string, number>();
  const correctionIdCounts = new Map<string, number>();
  for (const entry of appends) {
    const id = isPlainObject(entry) ? entry.id : undefined;
    if (!isNonEmptyString(id)) continue; // the entry's own shape becomes its problem below
    appendIdCounts.set(id, (appendIdCounts.get(id) ?? 0) + 1);
  }
  for (const entry of correctionsIn) {
    const id = isPlainObject(entry) ? entry.id : undefined;
    if (!isNonEmptyString(id)) continue; // the entry's own shape becomes its problem below
    correctionIdCounts.set(id, (correctionIdCounts.get(id) ?? 0) + 1);
  }
  /** The problem of one entry whose plan id no single component can name. */
  const ambiguousIdProblem = (component: string, path: string, id: string): PrepareAmendmentProblem | undefined => {
    const appended = appendIdCounts.get(id) ?? 0;
    const corrected = correctionIdCounts.get(id) ?? 0;
    if (appended + corrected <= 1) return undefined;
    const message =
      appended > 1 && corrected === 0
        ? `plan ${id} appears twice in one patch`
        : corrected > 1 && appended === 0
          ? `plan ${id} appears twice in correctPlanFiles`
          : `plan ${id} is both appended and corrected in one patch \u2014 a plan id is either a new row or an existing one`;
    return componentProblem({
      component,
      path,
      code: "coordination.prepare-amendment.duplicate-plan",
      message,
      needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.duplicate-plan"]!,
      details: { plan_id: id },
    });
  };

  // A patch that addresses NOTHING is not an amendment. (§5 a patch whose
  // components all ALREADY hold their effect is not this case: its effect is
  // current, so it is the success below, never an artificial no-op write.)
  if (appends.length === 0 && correctionsIn.length === 0 && requestedPath === undefined && !policyRequested) {
    throw prepareAmendmentRefusal(
      "invalid-patch",
      `the patch changes nothing on workflow ${context.snapshot.id} \u2014 it appends no plan, corrects no plan file, records no new integration checkout and no different plan parallelism`,
      { workflow_id: context.snapshot.id },
    );
  }

  const applied: string[] = [];
  const held: string[] = [];
  const unresolved: PrepareAmendmentProblem[] = [];
  const components: string[] = [];
  const resolvedIds: string[] = [];
  const rows: PlanRow[] = [];
  const corrections: PreparePlanFileCorrectionDelta[] = [];
  const recordedPath = isNonEmptyString(context.snapshot.integration_worktree_path)
    ? canonicalTarget(context.snapshot.integration_worktree_path)
    : undefined;
  const recordedParallelism = isPlainObject(context.snapshot.execution_policy)
    ? context.snapshot.execution_policy.plan_parallelism
    : undefined;

  // (1) Appends — one independent component per entry. An appended row reads its
  // own plan document, the reviewed compass approval of its id and the reviewed
  // integration topology it joins, and nothing about its siblings (A06).
  for (const [index, entry] of appends.entries()) {
    const id = isPlainObject(entry) && isNonEmptyString(entry.id) ? entry.id : undefined;
    const component = prepareAmendmentComponent("append", id ?? "(unnamed)");
    const path = `appendPlans[${index}]`;
    components.push(component);
    // §4.1/E08 an entry whose plan id another entry also declares cannot be
    // resolved: THIS entry is withheld with its own problem while its unrelated
    // siblings still land (A23/A27).
    const ambiguous = id === undefined ? undefined : ambiguousIdProblem(component, path, id);
    if (ambiguous !== undefined) {
      unresolved.push(ambiguous);
      continue;
    }
    if (checkoutFact !== undefined) {
      unresolved.push(
        componentProblem({
          component,
          path,
          code: checkoutFact.code,
          message: checkoutFact.message,
          needed: AMENDMENT_MINIMUM[checkoutFact.code] ?? `a readable checkout fact for ${path}`,
          details: checkoutFact.details,
          sourcesTried: [`${path} (intent.request)`, `${resolve(context.cwd)} (main worktree)`],
        }),
      );
      continue;
    }
    const attempt = captureComponent(component, path, () =>
      readPlanAppend(entry, {
        harnessRoot: context.harnessRoot,
        snapshot: context.snapshot,
        compass: context.compass,
        mainWorktreeBranch,
        warnings,
      }),
    );
    if (!attempt.ok) {
      unresolved.push(attempt.problem);
      continue;
    }
    const row = attempt.value;
    const rowId = rowPlanIds(row)[0] ?? "";
    // §4.1 the reviewed compass is the APPROVAL of the ids this patch addresses.
    if (!context.compass.planIds.includes(rowId)) {
      unresolved.push(
        componentProblem({
          component,
          path,
          code: "coordination.prepare-amendment.compass-mismatch",
          message: `the reviewed compass ${context.compass.path} does not declare plan ${rowId} \u2014 an append or a correction applies only to approved work`,
          needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.compass-mismatch"]!,
          details: { expected: [...context.compass.planIds], undeclared: [rowId] },
        }),
      );
      continue;
    }
    const contradiction = compassCheckoutContradiction(context, requestedPath, recordedPath);
    if (contradiction !== undefined) {
      unresolved.push(
        componentProblem({
          component,
          path,
          code: "coordination.prepare-amendment.compass-mismatch",
          message: contradiction.message,
          needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.compass-mismatch"]!,
          details: contradiction.details,
        }),
      );
      continue;
    }
    const existing = context.snapshot.plans.filter((candidate) => rowPlanIds(candidate).includes(rowId));
    if (existing.length > 1) {
      unresolved.push(
        componentProblem({
          component,
          path,
          code: "coordination.prepare-amendment.duplicate-plan",
          message: `plan ${rowId} is addressed by ${existing.length} rows of workflow ${context.snapshot.id} \u2014 the appended row would be ambiguous`,
          needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.duplicate-plan"]!,
          details: { plan_id: rowId, workflow_id: context.snapshot.id, rows: existing.length },
        }),
      );
      continue;
    }
    if (existing.length === 1) {
      const prior = existing[0]!;
      if (
        prior.title === row.title && prior.file === row.file &&
        isDeepStrictEqual(prior.metadata ?? {}, row.metadata ?? {})
      ) {
        held.push(component);
        resolvedIds.push(rowId);
        continue;
      }
      unresolved.push(
        componentProblem({
          component,
          path,
          code: "coordination.prepare-amendment.duplicate-plan",
          message: `plan ${rowId} is already a row of workflow ${context.snapshot.id} \u2014 the amendment appends new rows and never replaces existing ones`,
          needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.duplicate-plan"]!,
          details: { plan_id: rowId, workflow_id: context.snapshot.id },
        }),
      );
      continue;
    }
    rows.push(row);
    applied.push(component);
    resolvedIds.push(rowId);
  }

  // (2) Plan-file corrections — one independent component per entry: the
  // addressed row, the pointer it holds and that plan's canonical document.
  for (const [index, entry] of correctionsIn.entries()) {
    const id = isPlainObject(entry) && isNonEmptyString(entry.id) ? entry.id : undefined;
    const component = prepareAmendmentComponent("correct-plan-file", id ?? "(unnamed)");
    const path = `correctPlanFiles[${index}]`;
    components.push(component);
    // §4.1/E08 the same per-entry rule as the appends: one entry of a duplicated
    // or cross-kind id is withheld with its own problem, never a preflight throw.
    const ambiguous = id === undefined ? undefined : ambiguousIdProblem(component, path, id);
    if (ambiguous !== undefined) {
      unresolved.push(ambiguous);
      continue;
    }
    const attempt = captureComponent(component, path, () => readPlanFileCorrection(entry, context));
    if (!attempt.ok) {
      unresolved.push(attempt.problem);
      continue;
    }
    const outcome = attempt.value;
    const addressedId = outcome.held ? outcome.id : outcome.delta.id;
    if (!context.compass.planIds.includes(addressedId)) {
      unresolved.push(
        componentProblem({
          component,
          path,
          code: "coordination.prepare-amendment.compass-mismatch",
          message: `the reviewed compass ${context.compass.path} does not declare plan ${addressedId} \u2014 an append or a correction applies only to approved work`,
          needed: AMENDMENT_MINIMUM["coordination.prepare-amendment.compass-mismatch"]!,
          details: { expected: [...context.compass.planIds], undeclared: [addressedId] },
        }),
      );
      continue;
    }
    resolvedIds.push(addressedId);
    if (outcome.held) held.push(component);
    else {
      applied.push(component);
      corrections.push(outcome.delta);
    }
  }

  // (3) The recorded integration checkout and its policy: ONE connected group.
  // Either both requested members land or neither does, and a withheld member
  // carries the same group problem as its partner — never a half-applied pair.
  const group = readIntegrationGroup({
    patch,
    context,
    recordedPath,
    requestedPolicy,
    policyRequested,
    policyIdentity,
    policyProblem,
    recordedParallelism,
    checkoutFact,
  });
  // §4.1/E08 the component identities come from the group itself, built from the
  // CANONICAL effective path, so the receipt, the recorded fact and the ACTIVE
  // route's `canonicalTarget(operation.path)` identity are one vocabulary.
  if (requestedPath !== undefined) components.push(group.pathComponent);
  if (policyRequested) components.push(group.policyComponent);
  if (group.problems.length > 0) {
    unresolved.push(...group.problems);
  } else {
    // Each held member is recognized instead of re-applied: `applied` names only
    // what this call actually recorded (§4.2/A09 — a replay of the pair spends
    // no second mutation and reports `already-satisfied`).
    if (requestedPath !== undefined) {
      if (group.pathHeld) held.push(group.pathComponent);
      else if (group.path !== undefined) applied.push(group.pathComponent);
    }
    if (policyRequested) {
      if (group.policyHeld) held.push(group.policyComponent);
      else if (group.policy !== undefined) applied.push(group.policyComponent);
    }
  }

  // The reviewed compass is the APPROVAL of the ids this patch addresses
  // (§4.1): the compass plan SET is not an equality gate — a declaration with no
  // registered row is missing registration that this or a later ordinary append
  // repairs, and a row the compass does not declare is isolated drift. Both are
  // reported as warnings and neither is ever "repaired" by deleting a row to
  // make the sets equal (A06).
  const proposedIds = [
    ...context.snapshot.plans.flatMap((row) => rowPlanIds(row)),
    ...rows.map((row) => rowPlanIds(row)[0] ?? ""),
  ];
  const missing = context.compass.planIds.filter((id) => !proposedIds.includes(id));
  if (missing.length > 0) {
    warnings.push({
      code: "coordination.compass-plan-missing",
      path: context.compass.path,
      message:
        `the reviewed compass declares plan ${missing.join(", ")} with no registered row yet \u2014 missing registration is repaired by that ` +
        "plan's own ordinary append and does not block the work this patch addresses",
    });
  }
  const undeclaredRows = proposedIds.filter((id) => !context.compass.planIds.includes(id));
  if (undeclaredRows.length > 0) {
    warnings.push({
      code: "coordination.compass-plan-undeclared",
      path: context.compass.path,
      message:
        `workflow ${context.snapshot.id} holds row ${undeclaredRows.join(", ")}, which the reviewed compass does not declare \u2014 the existing row ` +
        "is isolated drift and is preserved by value, never deleted to make the sets equal",
    });
  }
  // A patch that addresses only plan-file pointers consumes no integration fact
  // (design §4.1: those checks do not apply to a plan-file pointer correction),
  // so a lifecycle whose recorded integration facts contradict its compass is
  // reported as unrelated drift instead of blocking the repair. A patch that
  // does address the checkout/policy carries the same contradiction as that
  // group's own problem (above), never as a silent warning.
  const correctionOnly =
    appends.length === 0 && correctionsIn.length > 0 && requestedPath === undefined && requestedPolicy === undefined;
  if (correctionOnly) {
    const recordedBranch = context.snapshot.branch?.integration;
    const declaredPath =
      context.compass.integrationWorktreePath === undefined ? undefined : canonicalTarget(context.compass.integrationWorktreePath);
    if (
      (context.compass.specIntegrationBranch !== undefined && recordedBranch !== context.compass.specIntegrationBranch) ||
      (declaredPath !== undefined && group.effectivePath !== declaredPath)
    ) {
      warnings.push({
        code: "coordination.compass-integration-drift",
        path: context.compass.path,
        message:
          `workflow ${context.snapshot.id}'s recorded integration facts (branch ${JSON.stringify(recordedBranch ?? null)}, checkout ` +
          `${group.effectivePath ?? "(none)"}) do not match the reviewed compass ${context.compass.path} \u2014 this patch repairs a plan-file pointer and ` +
          "consumes no integration fact, so the drift is reported and left for the call that records one",
      });
    }
  }

  return {
    proposal: {
      rows,
      corrections,
      ...(group.path !== undefined ? { integrationWorktreePath: group.path } : {}),
      ...(group.policy !== undefined ? { planParallelism: group.policy } : {}),
      warnings,
      resolvedFrom: [
        ...resolvedIds.map((id) => ({ path: `plans.${id}`, source: "reviewed compass declaration" })),
        ...(corrections.length > 0 ? [{ path: "correctPlanFiles", source: "addressed row's own pointer" }] : []),
      ],
      components,
    },
    applied,
    held,
    unresolved,
  };
}


/**
 * Read the workflow-level Prepare view of one coordinator-bound workflow
 * (spec § New API and CLI). Read-only: no snapshot lock, nothing written.
 * Snapshot and compass digests are provenance only; amendment gates compare
 * named fields and path/existence facts under the mutation lock.
 * Problems that make the documents or the caller's identity unusable — a
 * missing/foreign/mismatched envelope, an unregistered or unreadable snapshot,
 * an unreadable or borrowed compass — still refuse with their own code, because
 * no trustworthy answer can be produced from them.
 *
 * Read veto at the entry boundary (spec §4.3/§5): the envelope anchor is the
 * only thing resolved before the verdict, so the refusal precedes the request
 * shape, the scope resolution and the snapshot read, and this authoritative
 * scope read does not merely inherit it from a later reader.
 */
export async function showPrepareWorkflow(
  input: Readonly<{ sessionPath: string; cwd?: string }>,
): Promise<PrepareWorkflowResult> {
  const anchor = entryAnchor(input?.sessionPath);
  assertExecutionFileReadAllowed({ harnessDir: anchor.harnessRoot });
  assertExactKeys(input as unknown as Record<string, unknown>, ["sessionPath", "cwd"], "prepare workflow read");
  const cwd = input.cwd ?? process.cwd();
  const scope = prepareWorkflowScope(input.sessionPath, cwd, anchor.session);
  const { snapshot, version, phaseDerived } = readPrepareSnapshot(scope.snapshotPath);
  assertCoordinatorBinding(scope.session, scope.sessionPath, snapshot);
  const compass = readPrepareCompass(scope.harnessRoot, snapshot);
  const admission = prepareStageAdmission(scope.harnessRoot, scope.workflowId, snapshot, phaseDerived);
  // Issue 4: a BLOCKED admission must not advertise derivations the refused
  // amendment cannot apply - the derivation projection is only meaningful
  // when the caller could actually act on it.
  const derived = admission.ok && compass.canonicalCompassRef !== undefined ? ["compass_ref"] : [];
  return {
    ok: true,
    operation: "show-prepare",
    session: scope.session,
    session_file: scope.sessionPath,
    view: {
      workflowId: scope.workflowId,
      snapshotVersion: version,
      compassVersion: compass.version,
      planIds: snapshot.plans.map((row) => rowPlanIds(row)[0] ?? ""),
      ...(isNonEmptyString(snapshot.phase) ? { phase: snapshot.phase } : {}),
      ...(phaseDerived ? { phaseDerived: true } : {}),
      allowed: admission.ok,
      blockers: admission.ok ? [] : [`${admission.reason}: ${admission.message}`],
      derived: derived.length > 0 ? derived : undefined,
    },
  };
}

/**
 * Apply one approved Prepare structural amendment under the canonical snapshot
 * write lock. Field-value and state constraints are checked against the current
 * documents; digests are retained only as provenance in the returned view.
 *
 * The patch is partitioned into independent components: components without a
 * semantic conflict land in this one locked write, while conflicting
 * components are withheld with their own typed problem.
 * A refusal that withholds the whole patch leaves protected state unchanged;
 * partial component conflicts are reported without discarding independent
 * valid changes from the same request.
 *
 * A lock that cannot be acquired refuses explicitly; Git-unavailable probes
 * retain the existing `coordination.git-unavailable` refusal.
 *
 * The session envelope anchor is resolved before request processing so
 * execution-authority restrictions remain the entry boundary.
 */
export async function amendPrepareWorkflow(
  input: Readonly<{
    sessionPath: string;
    cwd?: string;
    patch: PrepareWorkflowPatch;
  }>,
): Promise<PrepareWorkflowResult> {
  const anchor = entryAnchor(input?.sessionPath);
  assertExecutionFileWriteAllowed({ harnessDir: anchor.harnessRoot });
  assertExactKeys(input as unknown as Record<string, unknown>, ["sessionPath", "cwd", "patch"], "prepare amendment input");
  const cwd = input.cwd ?? process.cwd();
  const scope = prepareWorkflowScope(input.sessionPath, cwd, anchor.session);
  const committed = await withStatusWriteLock(scope.snapshotPath, async () => {
    const { snapshot, phaseDerived } = readPrepareSnapshot(scope.snapshotPath);
    assertCoordinatorBinding(scope.session, scope.sessionPath, snapshot);
    // The Git-derived main worktree is READ here, but it only gates the
    // components that consume an owned checkout/branch fact: an unreadable Git
    // fact becomes those components' own problem inside `readPrepareAmendment`,
    // reported as `coordination.git-unavailable` drift beside a local repair that
    // needs nothing from Git (R12/A24). When Git answers, the coordinator's
    // residency in the main or recorded integration worktree is enforced for
    // every component.
    const main = readMainWorktree(cwd);
    if (main !== null) assertCoordinatorCheckoutResidency(main, cwd, snapshot);
    // Each component checks only its named field and path constraints against
    // the state read under this lock. File replacement remains serialized by
    // the same lock; document bytes are not a freshness token.
    const compass = readPrepareCompass(scope.harnessRoot, snapshot);
    const admission = prepareAdmission(scope.harnessRoot, scope.workflowId, snapshot);
    if (!admission.ok) throw prepareAmendmentRefusal(admission.reason, admission.message, admission.details);
    const plan = readPrepareAmendment(input.patch, {
      harnessRoot: scope.harnessRoot,
      snapshot,
      compass,
      main,
      cwd,
    });
    const proposal = plan.proposal;
    const writing =
      proposal.rows.length > 0 ||
      proposal.corrections.length > 0 ||
      proposal.integrationWorktreePath !== undefined ||
      proposal.planParallelism !== undefined;
    // §6.2/§4.1 the ONE receipt of this call (§6.2 common outcome contract): the
    // components it applied — once each, in stable order — the components it
    // recognized as already current, the components it withheld with their own
    // typed problem, the declarations it resolved from and the commit boundary a
    // caller can rely on. The same object shape travels on the refusal below
    // under `error.details.recovery`, so one contract covers both paths.
    const recovery: RecoveryDetails = {
      outcome: plan.unresolved.length > 0 ? (plan.applied.length > 0 ? "partial" : "unresolved") : writing ? "applied" : "already-satisfied",
      target: { workflowId: scope.workflowId },
      applied: [...plan.applied],
      unresolved: plan.unresolved.map((entry) => entry.recovery),
      resolvedFrom: [{ path: "patch", source: "intent.request" }, ...proposal.resolvedFrom],
      warnings: [
        ...proposal.warnings,
        ...plan.held.map((component) => ({
          code: "coordination.prepare-amendment.held",
          path: component,
          message:
            `${component} is already recorded on workflow ${scope.workflowId} \u2014 this call recognized the current effect and wrote nothing for it`,
        })),
      ],
      commitState: plan.unresolved.length > 0 ? (writing ? "partial" : "none") : writing ? "committed" : "none",
    };
    // §4.1/A23 the admissible components of this patch commit FIRST, in this one
    // locked write — the withheld components reported below never undo them. §6.2
    // the resulting refusal therefore carries a receipt whose `commitState` is
    // `partial` (or `none` when nothing was admissible), never a claim that a
    // call which landed another component was mutation-free.
    let snapshotVersion: string;
    let planIds: string[];
    let phase = snapshot.phase;
    let derived: string[] = [];
    if (writing) {
      // Recovery-first adoption (R3 / I-000243): the reader may have DERIVED the
      // absent phase from the lifecycle facts, and the reviewed compass may carry
      // an absolute-but-in-root pointer. This locked write is the ordinary intent
      // that adopts both — together with the requested patch and `updated_at` —
      // so one normal call repairs and applies. Old rows and unknown fields are
      // taken from disk by value — only the new
      // rows, the corrected row pointers, the requested whitelist projections and
      // `updated_at` are new. The policy copy carries the stored object's own
      // keys, so keys this verb may not edit survive it.
      const executionPolicy: WorkflowExecutionPolicy = { ...(snapshot.execution_policy ?? {}) };
      if (proposal.planParallelism !== undefined) executionPolicy.plan_parallelism = proposal.planParallelism;
      // A corrected row is rebuilt by spread, so every field but `file` survives
      // by value and by position (prerequisite contract §4.1).
      const correctedFiles = new Map(proposal.corrections.map((entry) => [entry.id, entry.file]));
      const plans = [
        ...snapshot.plans.map((row) => {
          const address = rowPlanIds(row).find((planId) => correctedFiles.has(planId));
          return address === undefined ? row : { ...row, file: correctedFiles.get(address)! };
        }),
        ...proposal.rows,
      ];
      const derivedFields = compass.canonicalCompassRef === undefined ? [] : ["compass_ref"];
      const next: WorkflowSnapshot = {
        ...snapshot,
        updated_at: nowIso(),
        ...(phaseDerived ? { phase: PREPARE_PHASE } : {}),
        ...(compass.canonicalCompassRef !== undefined ? { compass_ref: compass.canonicalCompassRef } : {}),
        plans,
        ...(proposal.integrationWorktreePath !== undefined
          ? { integration_worktree_path: proposal.integrationWorktreePath }
          : {}),
        ...(proposal.planParallelism !== undefined ? { execution_policy: executionPolicy } : {}),
      };
      // The compass field values were read under the operation lock; their
      // content bytes are provenance, not a second commit precondition.
      await commitSnapshot(scope.harnessRoot, scope.workflowId, scope.snapshotPath, next);
      // The returned CAS token is read from the bytes this call just wrote,
      // inside the critical section: a version read after the lock is released
      // could name a competing commit that landed in between, while the reported
      // plan ids and compass version would still be this call's.
      const written = readArtifactBytes(scope.snapshotPath);
      if (written === undefined) {
        throw new CoordinationError(
          "coordination.store",
          `snapshot ${scope.snapshotPath} is unreadable after this call committed it`,
          { path: scope.snapshotPath },
        );
      }
      snapshotVersion = written.version;
      planIds = next.plans.map((row) => rowPlanIds(row)[0] ?? "");
      phase = next.phase;
      derived = derivedFields;
    } else {
      // §4.2/A09/A12 every addressed component already holds its effect, so the
      // current snapshot IS the success: no byte moves and no revision is spent.
      // The derived phase/compass_ref repairs stay with the next ordinary write,
      // exactly as the read-only view reports them (I-000243: the reader never
      // writes).
      const current = readArtifactBytes(scope.snapshotPath);
      if (current === undefined) {
        throw new CoordinationError(
          "coordination.store",
          `snapshot ${scope.snapshotPath} is unreadable after this call inspected it`,
          { path: scope.snapshotPath },
        );
      }
      snapshotVersion = current.version;
      planIds = snapshot.plans.map((row) => rowPlanIds(row)[0] ?? "");
    }
    // §6.2/A27 ONE refusal naming every withheld component and its own minimum
    // choice — raised only after the admissible components of the same patch
    // committed (A23), so the successes stand and the caller reads one result.
    if (plan.unresolved.length > 0) {
      refuseAmendment(plan.unresolved, { workflowId: scope.workflowId, components: proposal.components, recovery });
    }
    return {
      outcome: writing ? ("amended" as const) : ("already-satisfied" as const),
      planIds,
      compassVersion: compass.version,
      snapshotVersion,
      derived,
      phase,
      phaseDerived,
      recovery,
    };
  });
  return {
    ok: true,
    operation: "amend-prepare",
    session: scope.session,
    session_file: scope.sessionPath,
    outcome: committed.outcome,
    recovery: committed.recovery,
    // The delta only appends admissible Todo rows, corrects the addressed rows'
    // plan-file pointers and records the requested path/policy, so the workflow
    // stays admissible after the commit.
    view: {
      workflowId: scope.workflowId,
      snapshotVersion: committed.snapshotVersion,
      compassVersion: committed.compassVersion,
      planIds: committed.planIds,
      ...(isNonEmptyString(committed.phase) ? { phase: committed.phase } : {}),
      ...(committed.phaseDerived ? { phaseDerived: true } : {}),
      allowed: true,
      blockers: [],
      derived: committed.derived !== undefined && committed.derived.length > 0 ? committed.derived : undefined,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * § JSON Prepare coordinator recovery (prerequisite contract §3.3)
 * ------------------------------------------------------------------------ */

/** One reason `recoverPrepareCoordinator` must not run, as a readable blocker. */
export type PrepareCoordinatorRecoveryBlocker = Readonly<{ code: string; message: string }>;

/**
 * What a caller observes about one recorded coordinator binding before
 * replacing it (§3.3). Deliberately owner-neutral: public session id, recorded
 * digests and the Prepare verdict — never envelope bytes or bearer material.
 */
export type PrepareCoordinatorRecoveryView = Readonly<{
  workflowId: string;
  /** The session id the snapshot currently records as the workflow's coordinator. */
  priorSessionId: string;
  /** Digests observed for provenance; they do not admit or reject recovery. */
  snapshotVersion: string;
  compassVersion: string;
  /** `true` when identity and semantic recovery preconditions permit a recovery. */
  allowed: boolean;
  /** One typed blocker per admission refusal; empty when allowed. */
  blockers: readonly PrepareCoordinatorRecoveryBlocker[];
}>;

/**
 * The public projection of one accepted recovery (§3.3): the two public
 * session ids, the replay identity, versions and time. No envelope body, no
 * credential, and the new envelope PATH stays in coordinator-owned transport
 * (`CoordinationResult.session_file`) rather than in this receipt.
 */
export type PrepareCoordinatorRecoveryReceipt = Readonly<{
  workflowId: string;
  priorSessionId: string;
  sessionId: string;
  operationId: string;
  requestHash: string;
  /** `true` when this call replayed an already-recorded operation and wrote nothing. */
  replay: boolean;
  /** Recorded digests for the committed snapshot and compass provenance. */
  snapshotVersion: string;
  compassVersion: string;
  recoveredAt: string;
}>;

/**
 * The existing `CoordinationResult` envelope plus the recovery receipt (§3.3).
 * This verb's `recovery` member IS that domain receipt: the identity recovery is
 * its own public shape (§3.3), not the §4.1 frame sidecar — the verb does not
 * run the locked row frame at all.
 */
export type RecoverPrepareCoordinatorResult = Omit<CoordinationResult, "recovery"> & {
  recovery: PrepareCoordinatorRecoveryReceipt;
};

/** Refusal reasons of the JSON Prepare recovery (§3.3 / §5). */
type RecoveryReason =
  | "invalid-request"
  | "not-prepare"
  | "execution-started"
  | "foreign-owner"
  | "unauthorized"
  | "operation-conflict";

/** One `coordination.identity-recovery.<reason>` code (`coordination-write.ts`). */
type RecoveryCode = `coordination.identity-recovery.${RecoveryReason}`;

function recoveryRefusal(reason: RecoveryReason, message: string, details: Record<string, unknown> = {}): CoordinationError {
  const code: RecoveryCode = `coordination.identity-recovery.${reason}`;
  return new CoordinationError(code, message, details);
}

/** The exact input keys of one recovery call (§3.3 — no force, no extra fields). */
const RECOVERY_INPUT_KEYS: readonly string[] = [
  "cwd",
  "harnessDir",
  "identity",
  "priorSessionPath",
  "priorSessionId",
  "operationId",
  "reason",
  "authorizationRef",
  "stoppedSessionIds",
  "attestation",
];

/**
 * The canonical request digest of the recovery's semantic operation fields.
 * Only this fingerprint is compared for a same-operation-id replay.
 *
 * Deliberately excluded: the prior holder's session id and envelope path. Both
 * are DERIVED — the host re-resolves them from the live binding, which its own
 * accepted recovery has since moved — so a digest over them would make an exact
 * retry unrecognizable while adding nothing: a genuine recovery authenticates
 * the prior owner inside the lock, and the replay branch additionally requires
 * the current binding to still be that operation's own result.
 */
function recoveryRequestHash(request: {
  workflowId: string;
  sessionId: string;
  operationId: string;
  reason: string;
  authorizationRef: string;
  stoppedSessionIds: readonly string[];
  attestation?: ActivationAttestation;
}): string {
  return sha256Bytes(
    stableJson({
      workflow_id: request.workflowId,
      session_id: request.sessionId,
      operation_id: request.operationId,
      reason: request.reason,
      authorization_ref: request.authorizationRef,
      stopped_session_ids: [...request.stoppedSessionIds],
      ...(request.attestation === undefined ? {} : { attestation: request.attestation }),
    }),
  );
}

/**
 * The file-authority verdict of the recovery, FIRST and before any payload,
 * version, identity or path is inspected (§4.3). With an ACTIVE execution
 * authority the snapshot and session envelopes are retired as a persistence
 * route: the refusal names the existing DB recovery verb instead of silently
 * running this JSON writer, and the DB route (full execution token + stop
 * attestation) stays the only recovery there.
 */
function assertPrepareRecoveryFileAuthority(harnessRoot: string): void {
  try {
    assertExecutionFileWriteAllowed({ harnessDir: harnessRoot });
  } catch (error) {
    if (error instanceof StoreError && error.code === "execution.direct-write-refused") {
      throw new StoreError(
        error.code,
        `${error.message} Coordinator recovery of a workflow under an ACTIVE execution authority belongs to the ` +
          `existing DB recovery verb (\`mstar session recover\`) with its execution token and stop attestation; ` +
          `this JSON Prepare writer never runs against an active store.`,
      );
    }
    throw error;
  }
}

/**
 * Create the recovery's role-scoped coordinator envelope through exclusive
 * creation. An existing file is reusable only when its validated identity
 * fields match this exact role, workflow, session id and root.
 */
function createRecoveryEnvelope(session: CoordinationSession): { path: string; created: boolean } {
  const path = sessionFilePath(session.harness_root, session.workflow_id, session.role, session.session_id);
  try {
    const created = createSessionEnvelope(session);
    return { path: canonicalTarget(created), created: true };
  } catch (error) {
    if (!(error instanceof CoordinationError) || error.code !== "coordination.identity-mismatch") throw error;
    // The target already exists. A session envelope with the same declared
    // identity is reusable; identity fields, not serialized bytes, are authority.
    let existing: CoordinationSession;
    try {
      if (!lstatSync(path).isFile()) throw error;
      existing = readSessionEnvelope(path);
    } catch {
      throw error;
    }
    if (
      existing.schema_version !== session.schema_version ||
      existing.role !== session.role ||
      existing.session_id !== session.session_id ||
      existing.workflow_id !== session.workflow_id ||
      existing.harness_root !== session.harness_root
    ) {
      throw recoveryRefusal(
        "invalid-request",
        `a coordinator envelope for session ${session.session_id} already exists with a different session identity`,
        { workflow_id: session.workflow_id, session_id: session.session_id },
      );
    }
    return { path: canonicalTarget(path), created: false };
  }
}


/**
 * Reclaim only the role-scoped envelope created by this operation while its
 * session identity still matches. A symlink, non-file or different session is
 * left untouched.
 */
function reclaimRecoveryEnvelope(path: string, expected: CoordinationSession): void {
  let current: CoordinationSession;
  try {
    if (!lstatSync(path).isFile()) return;
    current = readSessionEnvelope(path);
  } catch {
    return; // gone, unreadable or not a regular file: nothing to reclaim
  }
  if (
    current.schema_version !== expected.schema_version ||
    current.role !== expected.role ||
    current.session_id !== expected.session_id ||
    current.workflow_id !== expected.workflow_id ||
    current.harness_root !== expected.harness_root
  ) return;
  try {
    unlinkSync(path);
  } catch {
    /* the recovery failed; a leftover envelope is harmless but never trusted */
  }
}

/**
 * Read the workflow-level recovery view (§3.3). Read-only: no lock, no write.
 * The two byte versions are the tokens `recoverPrepareCoordinator` requires,
 * and `allowed`/`blockers` report the Prepare/no-execution admission exactly as
 * the mutation evaluates it — an inadmissible lifecycle is READABLE here, not
 * an error, so an operator can inspect the workflow before recovering it.
 *
 * A workflow with no recorded coordinator binding refuses (there is no owner to
 * expose and nothing this narrow repair may replace), and so do an
 * unregistered/unreadable snapshot and an unreadable or borrowed compass.
 */
export async function showPrepareCoordinatorRecovery(
  input: Readonly<{ cwd: string; harnessDir: string; workflowId: string }>,
): Promise<PrepareCoordinatorRecoveryView> {
  if (!isPlainObject(input)) throw invalidInput("coordinator recovery view input must be an object");
  requireCwd(input.cwd);
  const harnessRoot = requireProcessRoot(input.cwd, input.harnessDir);
  assertExecutionFileReadAllowed({ harnessDir: harnessRoot });
  assertExactKeys(input as unknown as Record<string, unknown>, ["cwd", "harnessDir", "workflowId"], "coordinator recovery view input");
  const workflowId = safePlanId(input.workflowId, "workflowId");
  const snapshotPath = assertSnapshotPath(harnessRoot, workflowId, snapshotPathOf(harnessRoot, workflowId));
  assertRootRegisterEntry(harnessRoot, workflowId);
  const { snapshot, version, phaseDerived } = readPrepareSnapshot(snapshotPath);
  const coordinator = snapshot.coordination?.coordinator;
  if (coordinator === undefined) {
    throw new CoordinationError(
      "coordination.identity-missing",
      `workflow ${workflowId} has no recorded coordinator; recover-coordinator replaces a binding, so create it with plan bind instead`,
      { workflow_id: workflowId },
    );
  }
  const compass = readRecoveryCompass(harnessRoot, snapshot);
  const lease = snapshot.integration_merge_lease;
  const admission = lease?.holder === coordinator.session_id
    ? prepareAdmission(harnessRoot, workflowId, snapshot)
    : prepareStageAdmission(harnessRoot, workflowId, snapshot, phaseDerived);
  return {
    workflowId,
    priorSessionId: coordinator.session_id,
    snapshotVersion: version,
    compassVersion: compass.version,
    allowed: admission.ok,
    blockers: admission.ok ? [] : [{ code: admission.reason, message: admission.message }],
  };
}

/**
 * Replace the recorded coordinator of a Prepare workflow or an interrupted
 * integration after explicit authorization and an authenticated stop assertion.
 * An integration claim is discarded only when it belongs to the exact recorded
 * predecessor being replaced. No claim is transferred, no row state is changed,
 * and a foreign claim never broadens the Prepare admission.
 *
 * The registered workflow must still be running. The prior envelope must
 * authenticate the recorded coordinator; the acquired replacement must address
 * this workflow and must not appear in the stop assertion. All semantic checks
 * run under the snapshot write lock before creating the replacement envelope.
 *
 * Accepted effect: one role-scoped envelope through exclusive creation, the
 * top-level coordinator binding replaced, one immutable
 * `coordination.identity_recoveries` entry appended, `updated_at` refreshed,
 * and this predecessor's interrupted integration claim removed atomically.
 * Every row, branch anchor, evidence field and other workflow stays unchanged.
 * The old envelope remains as history and stops authorizing when the binding moves.
 */
export async function recoverPrepareCoordinator(
  input: Readonly<{
    cwd: string;
    harnessDir: string;
    identity: ExecutionIdentity;
    priorSessionPath: string;
    priorSessionId: string;
    operationId: string;
    reason: string;
    authorizationRef: string;
    stoppedSessionIds: readonly string[];
    /** Existing operator stop attestation; required for interrupted integration. */
    attestation?: ActivationAttestation;
  }>,
): Promise<RecoverPrepareCoordinatorResult> {
  if (!isPlainObject(input)) throw invalidInput("coordinator recovery input must be an object");
  requireCwd(input.cwd);
  // Canonical authority discrimination precedes every other check (§4.3): the
  // active-store refusal must not be pre-empted by a payload, version or path
  // error, and this writer must never run against an active authority.
  const harnessRoot = requireProcessRoot(input.cwd, input.harnessDir);
  assertPrepareRecoveryFileAuthority(harnessRoot);
  assertExactKeys(input as unknown as Record<string, unknown>, RECOVERY_INPUT_KEYS, "coordinator recovery input");
  // The workflow this recovery addresses is the one the acquired identity
  // names (§3.3): the request carries no separate workflow id, so the scope the
  // identity is validated against is its own — the adapter boundary is what
  // holds the caller's `workflowId` and the host-derived identity together.
  const identity: ExecutionIdentity = input.identity;
  validateExecutionIdentity(identity, {
    workflowId: (identity as unknown as Record<string, unknown>).workflowId as string,
    role: "coordinator",
    planId: null,
  });
  const workflowId = safePlanId(identity.workflowId, "workflowId");
  const operationId = recoveryText(input.operationId, "operationId");
  const reason = recoveryText(input.reason, "reason");
  const authorizationRef = recoveryText(input.authorizationRef, "authorizationRef");
  const priorSessionId = recoveryText(input.priorSessionId, "priorSessionId");
  const stoppedSessionIds = recoveryStopList(input.stoppedSessionIds);
  const attestation = input.attestation === undefined ? undefined : validateActivationAttestation(input.attestation);
  if (attestation !== undefined && attestation.operator.authorizationRef !== authorizationRef) {
    throw recoveryRefusal("unauthorized", "the stop attestation's operator authorization does not match authorizationRef; supply the actual operator-authorized attestation and retry recovery", { field: "attestation.operator.authorizationRef" });
  }
  const attestedAt = attestation === undefined ? undefined : new Date(attestation.attestedAt).toISOString();

  // The new identity's session id names the envelope this recovery creates, so
  // it obeys the same single-safe-component rule every session id does.
  const sessionId = safeSessionId(identity.sessionId) as string;
  if (!isNonEmptyString(input.priorSessionPath) || !isAbsolute(input.priorSessionPath)) {
    // The addressed path is caller-supplied and this refusal is a public
    // diagnostic (CLI JSON, host tool result), so the value is never repeated:
    // the rule is stated with the received form and length instead.
    throw recoveryRefusal(
      "invalid-request",
      "priorSessionPath must be the absolute path of the recorded coordinator envelope \u2014 the received value is " +
        "not an absolute path and is not echoed in this diagnostic",
      {
        form: isNonEmptyString(input.priorSessionPath) ? "relative" : typeof input.priorSessionPath,
        length: isNonEmptyString(input.priorSessionPath) ? input.priorSessionPath.length : 0,
      },
    );
  }
  const priorSessionPath = canonicalTarget(input.priorSessionPath);
  const requestHash = recoveryRequestHash({
    workflowId,
    sessionId,
    operationId,
    reason,
    authorizationRef,
    stoppedSessionIds,
    ...(attestation === undefined ? {} : { attestation }),
  });
  const snapshotPath = assertSnapshotPath(harnessRoot, workflowId, snapshotPathOf(harnessRoot, workflowId));
  const committed = await withStatusWriteLock(snapshotPath, async () => {
    const { snapshot, version, phaseDerived } = readPrepareSnapshot(snapshotPath);

    const recorded = snapshot.coordination?.coordinator;
    if (recorded === undefined) {
      throw recoveryRefusal(
        "not-prepare",
        `workflow ${workflowId} has no recorded coordinator binding \u2014 recovery replaces a recorded binding and never creates one`,
        { workflow_id: workflowId },
      );
    }
    const audit: readonly CoordinationIdentityRecovery[] = snapshot.coordination?.identity_recoveries ?? [];
    // Replay before all live semantic checks: exact operation-id retries serve
    // their immutable receipt only when the request hash still matches.
    const replayedOperation = audit.find((entry) => entry.operation_id === operationId);
    if (replayedOperation !== undefined) {
      if (replayedOperation.request_hash !== requestHash) {
        throw recoveryRefusal(
          "operation-conflict",
          `operation ${operationId} was already recorded for workflow ${workflowId} with a different request \u2014 ` +
            `an operation id names exactly one reviewed recovery`,
          { workflow_id: workflowId, operation_id: operationId, recorded: replayedOperation.request_hash, actual: requestHash },
        );
      }
      if (replayedOperation.session_id !== recorded.session_id) {
        throw recoveryRefusal(
          "operation-conflict",
          `operation ${operationId} was recorded for coordinator session ${replayedOperation.session_id}, but workflow ` +
            `${workflowId} now records ${recorded.session_id} \u2014 the binding was superseded; the recorded receipt is no longer this workflow's state`,
          {
            workflow_id: workflowId,
            operation_id: operationId,
            recorded_session_id: replayedOperation.session_id,
            current_session_id: recorded.session_id,
          },
        );
      }
      const recoveredPath = sessionFilePath(harnessRoot, workflowId, "coordinator", replayedOperation.session_id);
      // The receipt describes a LIVE binding: if its envelope is gone the
      // workflow is broken rather than recovered, and no success may be
      // reported from the record alone. The envelope path stays out of this
      // public diagnostic (§3.3 keeps it in coordinator-owned transport): the
      // already-public workflow and session ids identify it.
      if (!existsSync(recoveredPath)) {
        throw new CoordinationError(
          "coordination.session-not-found",
          `workflow ${workflowId} records recovered coordinator session ${recorded.session_id}, but that binding's ` +
            `envelope is gone \u2014 the binding is broken; do not replay it`,
          { workflow_id: workflowId, session_id: recorded.session_id },
        );
      }
      return {
        replay: true,
        entry: replayedOperation,
        snapshotVersion: version,
        compassVersion: replayedOperation.compass_version,
      } satisfies RecoveryCommit;
    }
    // A recovery replaces a coordinator that can no longer authenticate: naming
    // the CURRENT recorded holder as the replacement is not a recovery. Checked
    // after the replay branch above, because an exact retry legitimately names
    // the holder this operation already replaced.
    if (sessionId === recorded.session_id) {
      throw recoveryRefusal(
        "invalid-request",
        `the replacement identity is the recorded coordinator session ${recorded.session_id} \u2014 a recovery replaces ` +
          `a coordinator that can no longer authenticate and never re-binds the same one`,
        { prior_session_id: recorded.session_id },
      );
    }
    const compass = readRecoveryCompass(harnessRoot, snapshot);
    // The recorded binding must still be authenticated by the envelope the
    // caller pointed at: same canonical file, same session, same workflow, same
    // canonical root, coordinator seat. A caller-chosen credential path can
    // therefore never become the prior owner.
    assertPriorRecoveryOwner(harnessRoot, workflowId, priorSessionPath, priorSessionId, recorded);
    // Explicit operator authorization and stop proof (§3.3): the request names a
    // reason, an authorization reference and the RECORDED prior holder among the
    // stopped sessions. Checked after the owner is authenticated, so an operator
    // who does not hold the prior owner's proof is told that — not that its stop
    // assertion was incomplete.
    if (!stoppedSessionIds.includes(recorded.session_id)) {
      throw recoveryRefusal(
        "unauthorized",
        `the stop assertion does not name the recorded coordinator ${recorded.session_id} \u2014 recovery requires an ` +
          `explicit attestation that the prior holder stopped or reloaded`,
        { prior_session_id: recorded.session_id, stopped_session_ids: [...stoppedSessionIds] },
      );
    }
    if (stoppedSessionIds.includes(sessionId)) {
      throw recoveryRefusal(
        "unauthorized",
        "the replacement coordinator is named as stopped; remove the replacement from the stop assertion and retry recovery",
        { session_id: sessionId },
      );
    }
    const lease = snapshot.integration_merge_lease;
    const ownsInterruptedClaim = lease?.holder === recorded.session_id;
    const admission = ownsInterruptedClaim
      ? prepareAdmission(harnessRoot, workflowId, snapshot)
      : prepareStageAdmission(harnessRoot, workflowId, snapshot, phaseDerived);
    if (!admission.ok) {
      throw recoveryRefusal(
        admission.reason === "execution-started" ? "execution-started" : "not-prepare",
        admission.message,
        admission.details,
      );
    }
    await assertWorkflowRegistrationCommitted(harnessRoot, workflowId);

    const session: CoordinationSession = {
      schema_version: 1,
      role: "coordinator",
      session_id: sessionId,
      workflow_id: workflowId,
      harness_root: harnessRoot,
    };
    const recoveredAt = nowIso();
    if (attestedAt !== undefined && Date.parse(attestedAt) > Date.parse(recoveredAt)) {
      throw recoveryRefusal("unauthorized", "the stop attestation is in the future; supply the observed stop time and retry recovery", { attested_at: attestedAt, recovered_at: recoveredAt });
    }
    if (ownsInterruptedClaim && (attestation === undefined || attestedAt === undefined || lease === undefined
      || !attestation.stoppedSessions.some((entry) => entry.sessionId === recorded.session_id)
      || attestation.stoppedSessions.some((entry) => entry.sessionId === sessionId)
      || !Number.isFinite(Date.parse(lease.claimed_at))
      || Date.parse(lease.claimed_at) > Date.parse(attestedAt))) {
      throw recoveryRefusal(
        "unauthorized",
        "interrupted integration recovery requires the operator's validated stop attestation naming this exact prior holder as stopped or reloaded after its claim; supply workflow recover-coordinator --attestation <absolute-json> and retry. A live, foreign or newer claim is not released",
        { holder: recorded.session_id, claimed_at: lease?.claimed_at, attested_at: attestedAt ?? null },
      );
    }
    const entry: CoordinationIdentityRecovery = {
      operation_id: operationId,
      request_hash: requestHash,
      workflow_id: workflowId,
      prior_session_id: priorSessionId,
      session_id: sessionId,
      authorization_ref: authorizationRef,
      reason,
      stopped_session_ids: [...stoppedSessionIds],
      ...(attestedAt === undefined ? {} : { attested_at: attestedAt }),
      snapshot_version_before: version,
      compass_version: compass.version,
      recovered_at: recoveredAt,
    };
    let envelope = "";
    let created = false;
    // The envelope is created INSIDE this locked section and the snapshot
    // commit is the atomic binding step. A failure between them is not a
    // semantic refusal: it reports failure (never a receipt) and reclaims only
    // the exact envelope this call created, so a retry is lawful.
    try {
      const made = createRecoveryEnvelope(session);
      envelope = made.path;
      created = made.created;
      const next: WorkflowSnapshot = {
        ...snapshot,
        updated_at: nowIso(),
        coordination: {
          // The audit history is taken from disk by value and only APPENDED to:
          // an earlier recovery entry can never be rewritten or dropped here.
          ...(snapshot.coordination ?? { coordinator: recorded }),
          coordinator: { session_id: sessionId, session_file: envelope, bound_at: nowIso() },
          identity_recoveries: [...audit, entry],
        },
      };
      if (ownsInterruptedClaim) delete next.integration_merge_lease;
      await commitSnapshot(harnessRoot, workflowId, snapshotPath, next);
    } catch (error) {
      if (created && envelope !== "") reclaimRecoveryEnvelope(envelope, session);
      throw error;
    }
    const written = readArtifactBytes(snapshotPath);
    if (written === undefined) {
      throw new CoordinationError(
        "coordination.store",
        `snapshot ${snapshotPath} is unreadable after this call committed it`,
        { path: snapshotPath },
      );
    }
    return {
      replay: false,
      entry,
      snapshotVersion: written.version,
      compassVersion: compass.version,
      session,
      envelope,
    } satisfies RecoveryCommit;
  });

  const session: CoordinationSession = committed.session ?? {
    schema_version: 1,
    role: "coordinator",
    session_id: committed.entry.session_id,
    workflow_id: workflowId,
    harness_root: harnessRoot,
  };
  const envelopePath = committed.envelope ?? canonicalTarget(sessionFilePath(harnessRoot, workflowId, "coordinator", committed.entry.session_id));
  return {
    ok: true,
    operation: "recover-coordinator",
    session,
    session_file: envelopePath,
    outcome: "recovered",
    recovery: {
      workflowId,
      priorSessionId: committed.entry.prior_session_id,
      sessionId: committed.entry.session_id,
      operationId: committed.entry.operation_id,
      requestHash: committed.entry.request_hash,
      replay: committed.replay,
      snapshotVersion: committed.snapshotVersion,
      compassVersion: committed.compassVersion,
      recoveredAt: committed.entry.recovered_at,
    },
  };
}

/**
 * What one locked recovery section hands back: the audit entry that now
 * describes the binding, the bytes the caller must record as its tokens, and —
 * only on a fresh recovery — the envelope and session this call created.
 */
type RecoveryCommit = {
  /** `true` when this call replayed a recorded operation and wrote nothing. */
  replay: boolean;
  entry: CoordinationIdentityRecovery;
  /** `sha256:<64 hex>` of the snapshot bytes after this call (or the current ones on replay). */
  snapshotVersion: string;
  /** `sha256:<64 hex>` of the reviewed compass the recovery was authorized against. */
  compassVersion: string;
  session?: CoordinationSession;
  envelope?: string;
};

/**
 * The reviewed compass of one recovery call, read through the one compass
 * reader and re-expressed in this verb's own refusal vocabulary: a missing,
 * unreadable, borrowed or malformed compass makes the workflow non-recoverable
 * in Prepare, so the caller sees `not-prepare` (with the underlying code and
 * message attached) instead of the amendment's own reasons. There is no second
 * compass parser here.
 */
function readRecoveryCompass(harnessRoot: string, snapshot: WorkflowSnapshot): PrepareCompass {
  try {
    return readPrepareCompass(harnessRoot, snapshot);
  } catch (error) {
    if (error instanceof CoordinationError && error.code.startsWith("coordination.prepare-amendment.")) {
      throw recoveryRefusal("not-prepare", error.message, { ...error.details, reason_code: error.code });
    }
    throw error;
  }
}

/** One required non-empty recovery request field (a request-shape refusal). */
function recoveryText(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw recoveryRefusal("invalid-request", `coordinator recovery ${field} is required`, { field });
  }
  return value;
}

/**
 * The stop assertion: a non-empty list of PUBLIC session ids, validated before
 * anything is hashed, stored or echoed.
 *
 * A rejected entry is NEVER repeated in the refusal. These refusals are a public
 * projection (§5: public ids, canonical paths and codes), so a credential-like
 * or path-like value must not travel into a JSON payload, a log line or a
 * caller's transcript: the refusal keeps the stable code and the rule and
 * reports only the entry's POSITION (and, for a string, its length).
 */
function recoveryStopList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw recoveryRefusal(
      "unauthorized",
      "stoppedSessionIds must name at least the prior holder this recovery replaces \u2014 an empty stop assertion is never an authorization",
      { actual: Array.isArray(value) ? "array" : value === undefined ? null : typeof value },
    );
  }
  const ids: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isNonEmptyString(entry)) {
      throw recoveryRefusal("invalid-request", "every stoppedSessionIds entry must be a non-empty session id", {
        index,
        actual: typeof entry,
      });
    }
    // Every entry is hashed into the request digest and persisted in the
    // immutable audit, so it must be a PUBLIC session id under the same
    // single-safe-component/length rule an acquired identity obeys — an
    // arbitrary string (credential-like or path/payload text) is never stored.
    try {
      assertSafeSessionId(entry, "stoppedSessionIds entry");
    } catch {
      throw recoveryRefusal(
        "invalid-request",
        "every stoppedSessionIds entry must be a public session id \u2014 a single safe path component " +
          "([A-Za-z0-9._-]+) of at most 128 characters; the rejected value is not echoed in this diagnostic",
        { index, length: entry.length },
      );
    }
    ids.push(entry);
  }
  return [...new Set(ids)];
}

/**
 * Authenticate the recorded coordinator with the envelope the caller addressed
 * (§3.3): the pointed file must BE the recorded binding — same canonical path,
 * same session id, coordinator seat, this workflow, this canonical root — and
 * the caller's `priorSessionId` must be that same recorded owner. A mismatch in
 * any of those is `foreign-owner`: the caller does not hold the prior owner's
 * proof.
 *
 * Both branches of this refusal are PUBLIC diagnostics (CLI JSON and the host
 * tool result), so neither repeats a rejected value nor an envelope path: the
 * rule, the addressed workflow, the already-public recorded session id and the
 * mismatching dimensions are reported instead. The recorded id is the one
 * `showPrepareCoordinatorRecovery` already publishes as `priorSessionId`.
 */
function assertPriorRecoveryOwner(
  harnessRoot: string,
  workflowId: string,
  priorSessionPath: string,
  priorSessionId: string,
  recorded: CoordinatorBinding,
): void {
  const recordedPath = canonicalTarget(recorded.session_file);
  if (recorded.session_id !== priorSessionId || recordedPath !== priorSessionPath) {
    const mismatched = [
      ...(recorded.session_id !== priorSessionId ? ["recorded session id"] : []),
      ...(recordedPath !== priorSessionPath ? ["recorded envelope"] : []),
    ];
    throw recoveryRefusal(
      "foreign-owner",
      `the envelope this call addresses is not the coordinator workflow ${workflowId} records ` +
        `(session ${recorded.session_id}) \u2014 a recovery replaces only the binding it can authenticate; the ` +
        `addressed envelope path and the caller's session id are not echoed in this diagnostic`,
      { workflow_id: workflowId, expected_session_id: recorded.session_id, mismatched },
    );
  }
  const prior = readSessionEnvelope(priorSessionPath);
  const dimensions = [
    ...(prior.role !== "coordinator" ? ["role"] : []),
    ...(prior.session_id !== priorSessionId ? ["session id"] : []),
    ...(prior.workflow_id !== workflowId ? ["workflow"] : []),
    ...(canonicalizeNearestExisting(prior.harness_root) !== harnessRoot ? ["harness root"] : []),
  ];
  if (dimensions.length > 0) {
    throw recoveryRefusal(
      "foreign-owner",
      `the addressed session envelope does not authenticate the coordinator of workflow ${workflowId} in ` +
        `${harnessRoot} \u2014 the recorded binding cannot be authenticated through it; the envelope path and its ` +
        `values are not echoed in this diagnostic`,
      { workflow_id: workflowId, mismatched: dimensions },
    );
  }
}
