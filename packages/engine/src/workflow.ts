/**
 * Engine workflow module - v3 workflow snapshot schema
 * (`workflows/<id>/snapshot.json`), lifecycle status enum, validator, and the
 * whole-rewrite writer.
 *
 * Spec sources (each export cites the plan/brief section it enforces):
 * - Snapshot schema (final): `schema_version: 1` (snapshot-own field;
 *   `version` stays the root-file
 *   discriminator), `id` (= plan id or iteration id), `type: "plan" |
 *   "iteration"`, `status` lifecycle enum (terminal set =
 *   `completed|failed|stopped`; `running|paused` are the active root-listed
 *   states), `started_at` / `ended_at?` (required at terminal) / `updated_at`,
 *   `phase?` (free-form phase-machine label), `plans[]` (legacy PlanRow shape
 *   verbatim - unknown row fields preserved, never re-bucketed),
 *   `execution_policy?` (first-class; keys accepted-but-opaque this
 *   iteration), `integration_merge_lease?` (top-level; the v1 root-`metadata`
 *   home is gone), `branch?` / `integration_worktree_path?` (iteration
 *   anchors - the canonical checkout field; the v1 `control_worktree_path`
 *   key survives only as a read alias in `readWorkflowSnapshot`),
 *   `legacy_metadata?` (catch-all for unmapped v1 root-metadata keys),
 *   `compass_ref?` (relative pointer to the iteration delivery compass).
 * - Mutex shape: `validateIntegrationMergeLease` unchanged (`lease.ts`).
 * - Writer: whole-rewrite under `withStatusWriteLock(snapshotPath)` - the
 *   `.status-write.lockdir` lands inside `workflows/<id>/` (dirname of the
 *   snapshot), no harness-root pollution.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson, type GateResult, type Severity, type ValidationResult } from "./core.js";
import {
  CoordinationError,
  canonicalTarget,
  isNonEmptyString,
  isPlainObject,
  readArtifactBytes,
  validateRowCoordination,
  validateSnapshotCoordination,
  withProtectedWrite,
  type RowValidationRoute,
  type SnapshotCoordination,
} from "./coordination-write.js";
import { validateIntegrationMergeLease, withStatusWriteLock, type IntegrationMergeLease } from "./lease.js";
import { assertSafePathComponent, canonicalizeNearestExisting, resolvePlanDir } from "./path.js";
import { resolveRegisteredPlanFile } from "./plan-path.js";
// Call-time-only cycle with status.ts (status.ts imports the snapshot consts
// from this module): neither module dereferences the other's bindings during
// module evaluation, so the ESM live-binding cycle is safe (see status.ts).
import { registerWorkflowEntryLocked, rowPlanIds, validatePlanRow, validateWorkflowEntry, type PlanRow, type WorkflowEntry } from "./status.js";
import { assertFsStorePath, getArtifactStore, type ArtifactStore } from "./store.js";
import {
  assertExecutionFileReadAllowed,
  assertExecutionFileWriteAllowed,
} from "./store-db.js";

/** Snapshot file name inside `workflows/<id>/` ( - writer contract). */
export const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";

/** Lifecycle status enum ( - terminal set = completed|failed|stopped). */
export const WORKFLOW_LIFECYCLE_STATUSES = ["running", "paused", "completed", "failed", "stopped"] as const;

/** Terminal statuses: snapshot must carry `ended_at` and no dangling leases. */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const;

/** Lifecycle type enum ( - id reuses the orchestration id). */
export const WORKFLOW_LIFECYCLE_TYPES = ["plan", "iteration"] as const;

/**
 * Delivery kinds declared at registration (mstar-artifacts/references/plan-workflow-lifecycle-contract.md
 * §1). The declared kind is recorded at registration and never inferred
 * retroactively; `development` carries the full PR/merge delivery lifecycle,
 * `verification/report-only` follows the explicit completion policy recorded
 * alongside it.
 */
export const WORKFLOW_DELIVERY_KINDS = ["development", "verification/report-only"] as const;

// The literal lives in an acyclic leaf module: coordination.ts reads it at
// module evaluation time for PERSIST_PAYLOAD_CONTRACTS, and this module's own
// import graph reaches coordination.ts — a binding here would be a TDZ.
export { WORKFLOW_SNAPSHOT_PAYLOAD_SCHEMA } from "./persist-payload-schemas.js";

export type WorkflowDeliveryKind = (typeof WORKFLOW_DELIVERY_KINDS)[number];

/**
 * Compound disposition outcomes (contract §4c): `created` / `updated` /
 * reasoned `skipped`. The disposition is recorded on the workflow before the
 * PR head is finalized, so the delivery evidence names the compound outcome
 * it was taken from.
 */
export const WORKFLOW_COMPOUND_OUTCOMES = ["created", "updated", "skipped"] as const;

export type WorkflowCompoundOutcome = (typeof WORKFLOW_COMPOUND_OUTCOMES)[number];

/**
 * Delivery evidence recorded on the snapshot (contract §3 lifecycle stages,
 * §4c/§4d/§4f, seam S3). Each member is recorded by its owner at its own
 * stage through the authorized write seam (`recordWorkflowDelivery`), and the
 * close consultation reads the block for the DECLARED delivery kind - never
 * inferring a kind from which members happen to be present (§1):
 *
 * - `compound` - compound disposition (§4c), recorded before the PR head is
 *   finalized; `skipped` carries the mandatory reason;
 * - `pr` - PR identity recorded at submission (§4d): repo/head/target. A
 *   local commit or a pre-existing unrelated PR does not satisfy it;
 * - `merge` - the PM's verified-merge record (§4f): the provider evidence
 *   they checked. The engine NEVER verifies the remote merge itself;
 * - `completion` - the fulfilment record of the `completion_policy` recorded
 *   at registration (§1) for `verification/report-only` workflows.
 */
export type WorkflowDeliveryEvidence = {
  compound?: { outcome: WorkflowCompoundOutcome; reason?: string };
  pr?: { repo: string; head: string; target: string };
  merge?: { provider: string; evidence: string };
  completion?: { policy: string; evidence: string };
};

export type WorkflowLifecycleStatus = (typeof WORKFLOW_LIFECYCLE_STATUSES)[number];
export type WorkflowLifecycleType = (typeof WORKFLOW_LIFECYCLE_TYPES)[number];

/**
 * First-class lifecycle execution policy ( - keys copied from root
 * `metadata` at migrate; values accepted-but-opaque this iteration, no
 * semantic gate).
 */
export type WorkflowExecutionPolicy = {
  plan_parallelism?: unknown;
  worktree_mode?: unknown;
  push_policy?: unknown;
};

/** Iteration branch anchors ( - from root metadata anchors). */
export type WorkflowBranchAnchors = {
  /**
   * Protected base anchor: the branch the lifecycle starts from (iteration
   * `iteration_base_branch`). Cleanup Rule 2 never deletes it and L1 uses it
   * as the explicit main-worktree residency fallback - it is NEVER a
   * feature/working branch (`registerPlanWorkflow` records the plan's
   * delivery branch under `source`).
   */
  base?: string;
  /**
   * Source branch of a standalone `type: plan` delivery, recorded at
   * registration (`--branch-source`). Semantically a delivery branch, not a
   * protected base anchor: cleanup/L1 consumers keep reading `base`.
   */
  source?: string;
  integration?: string;
  target?: string;
};

/**
 * v3 workflow snapshot (`workflows/<id>/snapshot.json`). Plan rows carry
 * ordinary coordinator-managed metadata; `integration_merge_lease` is the
 * workflow-wide serial merge mutex.
 *
 * Integration worktree path: the canonical member is
 * `integration_worktree_path` - the dedicated integration checkout, on
 * `branch.integration`, distinct from the main worktree. The v1
 * `control_worktree_path` key has NO canonical member: legacy-only
 * documents stay readable through `readWorkflowSnapshot` (in-memory
 * normalization + medium migration diagnostic); writers emit only the
 * canonical shape - no dual writer.
 *
 * Notes dual-home SSOT: a plan row's `notes` array is the
 * LEGACY VERBATIM copy preserved at migrate time - the RUNTIME ledger is
 * `notes.jsonl` in the workflow dir (`migrate.ts` NOTES_LEDGER_FILE). New
 * notes append to the ledger only; row `notes` is read-only legacy and is
 * never a dual-write target, so the two never diverge by construction.
 */
/**
 * The Prepare phase an iteration factually sits in before any plan executes.
 * Single source of truth for the free-form phase label: the registration
 * producer writes it, and the Prepare readers/writers in coordination.ts
 * derive or admit against it. Exported because coordination.ts already
 * imports this module (the reverse import would create a cycle).
 */
export const PREPARE_PHASE = "phase-1-prepare";

/**
 * The forward phase labels an iteration's ABSENT `phase` derives to once
 * execution ownership exists (R3). They are the same stage names the iteration
 * gate transitions to (`iteration.ts` `PhaseTransition`), so a derived label
 * and the gate can never disagree about what stage the work is in: execution
 * underway (`EXECUTE_PHASE`), or every row Done with the close still pending
 * (`CLOSE_PHASE`). A genuinely unstarted iteration derives `PREPARE_PHASE`
 * instead - never the other way round: execution facts are never reset to fit
 * a Prepare label.
 */
export const EXECUTE_PHASE = "phase-2-execute";
export const CLOSE_PHASE = "phase-3-close";

/**
 * The phase derivation for a snapshot that declares NO phase (R3 / #293).
 *
 * A registered iteration whose producer predates the phase declaration (or one
 * registered by hand) carries no `phase` at all. That absence is not a
 * lifecycle state: the state is provable from the facts the document already
 * holds. `deriveLifecyclePhase` reads exactly those facts:
 *
 * - not a running `type: iteration` - a plan snapshot has no phase concept,
 *   and a terminal document carries its own outcome - nothing is derived and
 *   `facts` names why;
 * - running with NO execution progress anywhere - every row remains `Todo`,
 *   no row progress, no `coordination.progress`, and no workflow
 *   `integration_merge_lease` - derives `PREPARE_PHASE`. A prepared row config
 *   or coordinator binding does not itself start execution;
 * - running WITH execution progress derives the applicable FORWARD label:
 *   `CLOSE_PHASE` when every row is `Done`, otherwise `EXECUTE_PHASE`.
 *
 * The result is a pure read - no snapshot byte is touched (`facts` is the
 * provenance a caller can report). This is the ONE definition of "what phase
 * does this document factually sit in"; the registration producer writes
 * `PREPARE_PHASE` at creation for the same reason this derives it for old
 * documents.
 */
export type LifecyclePhaseDerivation = Readonly<{
  /** The derived phase, or `undefined` when the facts prove none. */
  phase: string | undefined;
  /** The lifecycle facts the decision rests on, in stable order (provenance). */
  facts: readonly string[];
}>;

export function deriveLifecyclePhase(snapshot: WorkflowSnapshot): LifecyclePhaseDerivation {
  const facts: string[] = [`type=${snapshot.type}`, `status=${snapshot.status}`];
  if (snapshot.type !== "iteration" || snapshot.status !== "running") {
    return { phase: undefined, facts };
  }
  const ownership: string[] = [];
  if (snapshot.integration_merge_lease !== undefined) ownership.push("workflow integration_merge_lease");
  const rows = Array.isArray(snapshot.plans) ? snapshot.plans : [];
  for (const row of rows) {
    const planId = typeof row.id === "string" && row.id !== "" ? row.id : "(unnamed row)";
    if (row.status !== undefined && row.status !== "Todo") ownership.push(`plan ${planId} status=${String(row.status)}`);
    if (isPlainObject(row.coordination) && row.coordination.progress !== undefined) ownership.push(`plan ${planId} progress`);
  }
  if (ownership.length === 0) {
    return { phase: PREPARE_PHASE, facts: [...facts, `plans=${rows.length}`, "every row Todo", "no execution ownership"] };
  }
  const allDone = rows.length > 0 && rows.every((row) => row.status === "Done");
  return { phase: allDone ? CLOSE_PHASE : EXECUTE_PHASE, facts: [...facts, ...ownership] };
}

export type WorkflowSnapshot = {
  schema_version: 1;
  id: string;
  type: WorkflowLifecycleType;
  status: WorkflowLifecycleStatus;
  started_at: string;
  ended_at?: string;
  updated_at: string;
  phase?: string;
  plans: PlanRow[];
  execution_policy?: WorkflowExecutionPolicy;
  integration_merge_lease?: IntegrationMergeLease;
  branch?: WorkflowBranchAnchors;
  integration_worktree_path?: string;
  legacy_metadata?: Record<string, unknown>;
  compass_ref?: string;
  /**
   * Workflow-level coordinator identity and recovery evidence. Plan rows
   * carry ordinary prepared/progress/completion data.
   */
  coordination?: SnapshotCoordination;
  /**
   * Delivery kind declared at registration (mstar-artifacts/references/plan-workflow-lifecycle-contract.md
   * §1). Recorded by the registration producer; never inferred from runtime
   * behavior or from the presence/absence of other fields.
   */
  delivery_kind?: WorkflowDeliveryKind;
  /** Project register id recorded at registration (contract §3 register row). */
  project?: string;
  /**
   * Explicit completion policy for `verification/report-only` workflows,
   * recorded at registration (contract §1): names the evidence that completes
   * the workflow (e.g. acceptance artifacts or the report location).
   */
  completion_policy?: string;
  /**
   * Delivery evidence collected over the lifecycle (contract §3/§4c/§4d/§4f,
   * seam S3). Optional at the schema level - it is populated stage by stage
   * through `recordWorkflowDelivery` and consulted by the close path (and the
   * read-only phase-6 gate) for the declared `delivery_kind`.
   */
  delivery?: WorkflowDeliveryEvidence;
};


/** True exactly for a single-row standalone development plan workflow (spec A1). */
export function isStandaloneDevelopmentWorkflow(snapshot: WorkflowSnapshot): boolean {
  return (
    snapshot.type === "plan" &&
    snapshot.delivery_kind === "development" &&
    Array.isArray(snapshot.plans) &&
    snapshot.plans.length === 1
  );
}

/** True exactly for a single-row verification/report-only plan workflow (spec A1). */
export function isStandaloneReportOnlyWorkflow(snapshot: WorkflowSnapshot): boolean {
  return (
    snapshot.type === "plan" &&
    snapshot.delivery_kind === "verification/report-only" &&
    Array.isArray(snapshot.plans) &&
    snapshot.plans.length === 1
  );
}

/** Classify row coordination validation: standalone delivery vs integration delivery. */
export function rowValidationRoute(snapshot: WorkflowSnapshot, row: PlanRow): RowValidationRoute {
  if (isStandaloneDevelopmentWorkflow(snapshot) && snapshot.plans[0]?.id === row.id) {
    return "standalone-development";
  }
  if (isStandaloneReportOnlyWorkflow(snapshot) && snapshot.plans[0]?.id === row.id) {
    return "standalone-report-only";
  }
  return "integration";
}



/** Stable JSON for change detection (sorted keys, recursive). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

function validateNonEmptyString(
  violations: ValidationResult[],
  value: unknown,
  field: string,
  missingCode: string,
  invalidCode: string,
): void {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}

/**
 * Integration worktree path value check - shared by the canonical member
 * and the v1 read alias: empty, non-string, or relative (non-absolute)
 * values are rejected under one stable machine code.
 */
function validateWorktreePathValue(violations: ValidationResult[], value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
    violations.push(
      violation(
        "high",
        "workflow.snapshot.invalid-integration-worktree-path",
        `${field} must be a non-empty absolute path \u2014 got ${JSON.stringify(value)}`,
        "record the absolute integration checkout path (integration_worktree_path)",
      ),
    );
  }
}

/**
 * Validate the optional `delivery` block (contract §3/§4c/§4d/§4f): known
 * members only, each member an exact-key object of non-empty strings, the
 * compound outcome inside the recorded enum and `skipped` carrying its
 * mandatory reason. Structural validation only - WHICH members the declared
 * delivery kind requires is the consultation's rule
 * (`consultDeliveryEvidence`), so a partially filled block stays writable
 * while it is being collected.
 *
 * Exported (pure, read-only) for the DB transport's workflow-level `delivery`
 * transition: recording evidence on the execution authority runs the SAME
 * structural rule as the file route's `recordWorkflowDelivery`, so the two
 * writers cannot drift into accepting different evidence shapes.
 */
export function deliveryEvidenceViolations(value: unknown, what: string): ValidationResult[] {
  const violations: ValidationResult[] = [];
  const invalid = (message: string): void => {
    violations.push(violation("medium", "workflow.snapshot.invalid-delivery-evidence", `${what}: ${message}`));
  };
  if (!isPlainObject(value)) {
    invalid("must be an object");
    return violations;
  }
  const members = ["compound", "pr", "merge", "completion"] as const;
  const unknownMembers = Object.keys(value).filter((key) => !(members as readonly string[]).includes(key));
  if (unknownMembers.length > 0) invalid(`unknown member(s) ${unknownMembers.join(", ")} \u2014 expected ${members.join(" | ")}`);

  const compound = value.compound;
  if (compound !== undefined) {
    if (!isPlainObject(compound)) invalid("compound must be an object");
    else {
      const unknown = Object.keys(compound).filter((key) => key !== "outcome" && key !== "reason");
      if (unknown.length > 0) invalid(`compound has unknown key(s) ${unknown.join(", ")}`);
      if (typeof compound.outcome !== "string" || !(WORKFLOW_COMPOUND_OUTCOMES as readonly string[]).includes(compound.outcome)) {
        invalid(`compound.outcome must be one of ${WORKFLOW_COMPOUND_OUTCOMES.join(" | ")} \u2014 got ${JSON.stringify(compound.outcome)}`);
      } else if (compound.outcome === "skipped" && (typeof compound.reason !== "string" || compound.reason.trim() === "")) {
        invalid("compound reason is required when the disposition outcome is 'skipped' (contract \u00a74c)");
      } else if (compound.reason !== undefined && (typeof compound.reason !== "string" || compound.reason.trim() === "")) {
        invalid("compound.reason must be a non-empty string when given");
      }
    }
  }

  const stringMembers: Record<"pr" | "merge" | "completion", readonly string[]> = {
    pr: ["repo", "head", "target"],
    merge: ["provider", "evidence"],
    completion: ["policy", "evidence"],
  };
  for (const member of ["pr", "merge", "completion"] as const) {
    const block = value[member];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      invalid(`${member} must be an object`);
      continue;
    }
    const fields = stringMembers[member];
    const unknown = Object.keys(block).filter((key) => !fields.includes(key));
    if (unknown.length > 0) invalid(`${member} has unknown key(s) ${unknown.join(", ")}`);
    for (const field of fields) {
      if (typeof block[field] !== "string" || block[field].trim() === "") {
        invalid(`${member}.${field} must be a non-empty string`);
      }
    }
  }
  return violations;
}

/** The delivery-evidence members one declared kind records (contract §1/§4c/§4d/§4f). */
export function deliveryEvidenceMembers(kind: WorkflowDeliveryKind): readonly string[] {
  return kind === "development" ? ["compound", "pr", "merge"] : ["completion"];
}

/**
 * Validate a v3 workflow snapshot:
 * enum/type/id checks, `schema_version: 1`, required timestamps, plans[]
 * rows with validated ordinary metadata/coordination, and a validated
 * workflow-level integration merge mutex. Integration worktree path: the
 * canonical member is `integration_worktree_path`; the v1
 * `control_worktree_path` key is a read-only alias whose presence keeps this
 * strict validation a failing gate carrying the migration diagnostic.
 * Both keys present is `workflow.snapshot.conflicting-worktree-paths`.
 * Terminal invariant: `ended_at` is present and no integration mutex remains.
 */
export function validateWorkflowSnapshot(doc: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(doc)) {
    return {
      ok: false,
      violations: [violation("high", "workflow.snapshot.invalid", "workflow snapshot must be an object")],
    };
  }

  if (doc.schema_version === undefined) {
    violations.push(violation("high", "workflow.snapshot.missing-schema-version", "missing required field: schema_version"));
  } else if (doc.schema_version !== 1) {
    violations.push(
      violation(
        "high",
        "workflow.snapshot.invalid-schema-version",
        `schema_version must be 1 \u2014 got ${JSON.stringify(doc.schema_version)} (version is reserved for the root file discriminator)`,
      ),
    );
  }

  // a top-level `version` key is reserved for the root
  // status.json discriminator and must never appear on a snapshot - reject
  // it outright (defense-in-depth: the plan reserves `version`; snapshots
  // use `schema_version`).
  if (doc.version !== undefined) {
    violations.push(
      violation(
        "medium",
        "workflow.snapshot.reserved-version",
        `top-level version is reserved for the root status.json discriminator \u2014 snapshots use schema_version; remove the version key (got ${JSON.stringify(doc.version)})`,
        "remove the version key from the snapshot",
      ),
    );
  }

  validateNonEmptyString(violations, doc.id, "id", "workflow.snapshot.missing-id", "workflow.snapshot.invalid-id");

  if (doc.type === undefined) {
    violations.push(violation("high", "workflow.snapshot.missing-type", "missing required field: type"));
  } else if (typeof doc.type !== "string" || !(WORKFLOW_LIFECYCLE_TYPES as readonly string[]).includes(doc.type)) {
    violations.push(
      violation(
        "medium",
        "workflow.snapshot.invalid-type",
        `type must be one of ${WORKFLOW_LIFECYCLE_TYPES.join(" | ")} \u2014 got ${JSON.stringify(doc.type)}`,
      ),
    );
  }

  if (doc.status === undefined) {
    violations.push(violation("high", "workflow.snapshot.missing-status", "missing required field: status"));
  } else if (typeof doc.status !== "string" || !(WORKFLOW_LIFECYCLE_STATUSES as readonly string[]).includes(doc.status)) {
    violations.push(
      violation(
        "medium",
        "workflow.snapshot.invalid-status",
        `status must be one of ${WORKFLOW_LIFECYCLE_STATUSES.join(" | ")} \u2014 got ${JSON.stringify(doc.status)}`,
      ),
    );
  }

  validateNonEmptyString(violations, doc.started_at, "started_at", "workflow.snapshot.missing-started-at", "workflow.snapshot.invalid-started-at");
  validateNonEmptyString(violations, doc.updated_at, "updated_at", "workflow.snapshot.missing-updated-at", "workflow.snapshot.invalid-updated-at");

  if (doc.ended_at !== undefined) {
    validateNonEmptyString(violations, doc.ended_at, "ended_at", "workflow.snapshot.missing-ended-at", "workflow.snapshot.invalid-ended-at");
  }

  if (doc.phase !== undefined && typeof doc.phase !== "string") {
    violations.push(violation("medium", "workflow.snapshot.invalid-phase", "phase must be a string (free-form phase machine label)"));
  }

  if (doc.plans === undefined) {
    violations.push(violation("high", "workflow.snapshot.missing-plans", "missing required field: plans"));
  } else if (!Array.isArray(doc.plans)) {
    violations.push(violation("high", "workflow.snapshot.invalid-plans", "plans must be an array of legacy plan rows"));
  } else {
    const snapshotDoc = doc as WorkflowSnapshot;
    for (const row of doc.plans) {
      violations.push(...validatePlanRow(row).violations);
      // Row-level coordination is an ordinary prepared/progress/completion
      // record and is validated by its shared domain validator.
      if (isPlainObject(row) && row.coordination !== undefined) {
        const planRow = row as PlanRow;
        const route = rowValidationRoute(snapshotDoc, planRow);
        violations.push(...validateRowCoordination(row.coordination, `plans[${String(row.id)}].coordination`, route));
      }
    }
  }

  // Snapshot-level coordination block (the workflow's coordinator binding).
  if (doc.coordination !== undefined) {
    violations.push(...validateSnapshotCoordination(doc.coordination));
  }

  if (doc.execution_policy !== undefined) {
    if (!isPlainObject(doc.execution_policy)) {
      violations.push(violation("medium", "workflow.snapshot.invalid-execution-policy", "execution_policy must be an object"));
    }
    // Keys (plan_parallelism / worktree_mode / push_policy) are
    // accepted-but-opaque this iteration - no semantic gate.
  }

  if (doc.integration_merge_lease !== undefined) {
    violations.push(...validateIntegrationMergeLease(doc.integration_merge_lease).violations);
  }

  if (doc.branch !== undefined) {
    if (!isPlainObject(doc.branch)) {
      violations.push(violation("medium", "workflow.snapshot.invalid-branch", "branch must be an object"));
    } else {
      for (const key of ["base", "source", "integration", "target"] as const) {
        if (doc.branch[key] !== undefined && (typeof doc.branch[key] !== "string" || doc.branch[key].trim() === "")) {
          violations.push(violation("medium", "workflow.snapshot.invalid-branch", `branch.${key} must be a non-empty string`));
        }
      }
    }
  }

  // Integration worktree path (canonical member + v1 read alias):
  // strict validation never accepts the legacy key - the medium diagnostic
  // keeps `ok` false so the writer refuses; only `readWorkflowSnapshot`
  // normalizes it, in memory. An invalid legacy value never falls back to
  // (or substitutes for) the canonical key.
  const legacyWorktreePath = doc.control_worktree_path;
  const canonicalWorktreePath = doc.integration_worktree_path;
  if (legacyWorktreePath !== undefined && canonicalWorktreePath !== undefined) {
    violations.push(
      violation(
        "high",
        "workflow.snapshot.conflicting-worktree-paths",
        "both integration_worktree_path and the legacy control_worktree_path key are present \u2014 the canonical snapshot carries only integration_worktree_path (refused even when the values are equal)",
        "remove the legacy control_worktree_path key",
      ),
    );
  } else {
    if (canonicalWorktreePath !== undefined) {
      validateWorktreePathValue(violations, canonicalWorktreePath, "integration_worktree_path");
    }
    if (legacyWorktreePath !== undefined) {
      violations.push(
        violation(
          "medium",
          "workflow.snapshot.legacy-control-worktree-path",
          "legacy control_worktree_path is present \u2014 the canonical reader normalizes it to integration_worktree_path in memory; migrate on the next authorized write (writers emit only the canonical key)",
          "rename control_worktree_path to integration_worktree_path on the next authorized write",
        ),
      );
      validateWorktreePathValue(violations, legacyWorktreePath, "control_worktree_path (legacy alias)");
    }
  }

  if (doc.legacy_metadata !== undefined && !isPlainObject(doc.legacy_metadata)) {
    violations.push(violation("medium", "workflow.snapshot.invalid-legacy-metadata", "legacy_metadata must be an object"));
  }

  if (doc.compass_ref !== undefined) {
    validateNonEmptyString(
      violations,
      doc.compass_ref,
      "compass_ref",
      "workflow.snapshot.missing-compass-ref",
      "workflow.snapshot.invalid-compass-ref",
    );
  }

  // Registration-declared fields (mstar-artifacts/references/plan-workflow-lifecycle-contract.md §1/§3):
  // delivery kind is an enum, project/completion_policy are non-empty
  // strings. All optional at the schema level (iteration snapshots and
  // pre-contract snapshots carry none); the registration producer enforces
  // the per-kind requirements at registration time.
  if (doc.delivery_kind !== undefined) {
    if (typeof doc.delivery_kind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(doc.delivery_kind)) {
      violations.push(
        violation(
          "medium",
          "workflow.snapshot.invalid-delivery-kind",
          `delivery_kind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")} \u2014 got ${JSON.stringify(doc.delivery_kind)}`,
        ),
      );
    }
  }
  if (doc.project !== undefined) {
    validateNonEmptyString(violations, doc.project, "project", "workflow.snapshot.missing-project", "workflow.snapshot.invalid-project");
  }
  if (doc.completion_policy !== undefined) {
    validateNonEmptyString(
      violations,
      doc.completion_policy,
      "completion_policy",
      "workflow.snapshot.missing-completion-policy",
      "workflow.snapshot.invalid-completion-policy",
    );
  }
  // Delivery evidence (contract §3/§4c/§4d/§4f): structure only - the
  // per-kind completeness rule lives in `consultDeliveryEvidence`, shared by
  // the close path and the read-only phase-6 gate.
  if (doc.delivery !== undefined) {
    violations.push(...deliveryEvidenceViolations(doc.delivery, "delivery"));
  }

  // Terminal invariants (): ended_at present, no dangling leases.
  const terminal = typeof doc.status === "string" && (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(doc.status);
  if (terminal) {
    if (doc.ended_at === undefined) {
      violations.push(
        violation(
          "high",
          "workflow.snapshot.missing-ended-at",
          `terminal status ${JSON.stringify(doc.status)} requires ended_at \u2014 a terminal snapshot must record when the lifecycle ended`,
        ),
      );
    }
    if (doc.integration_merge_lease !== undefined) {
      violations.push(
        violation(
          "high",
          "workflow.snapshot.terminal-dangling-merge-lease",
          "terminal snapshot must not carry integration_merge_lease (dangling lease) \u2014 release the merge lease before the lifecycle ends",
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Machine code of the v1 read-alias migration diagnostic (`readWorkflowSnapshot`). */
export const LEGACY_WORKTREE_PATH_CODE = "workflow.snapshot.legacy-control-worktree-path";

/**
 * Machine code of the read-time absent-phase derivation diagnostic
 * (`readWorkflowSnapshot`, R3/#293): the document declared no `phase`, and the
 * lifecycle facts derived one. Non-blocking - the derived phase is a read-time
 * view, and the next authorized mutation persists it.
 */
export const DERIVED_PHASE_CODE = "workflow.snapshot.derived-phase";

/**
 * Result of the canonical snapshot read: the validated snapshot plus the
 * non-blocking diagnostics collected while reading (`workflow.snapshot.
 * legacy-control-worktree-path` for v1-shaped documents, `workflow.snapshot.
 * derived-phase` when an absent iteration phase was derived from lifecycle
 * facts). A read with diagnostics is NOT write permission - writers keep
 * strict validation and emit only the canonical shape.
 */
export type WorkflowSnapshotRead = {
  snapshot: WorkflowSnapshot;
  diagnostics: ValidationResult[];
};

/**
 * Canonical snapshot reader (`{WORKFLOW_DIR}/<id>/snapshot.json`): reads
 * `dir/snapshot.json`, validates the raw document, normalizes the single
 * permitted legacy alias (`control_worktree_path` →
 * `integration_worktree_path`) IN MEMORY and returns its medium migration
 * diagnostic separately. Any other validation violation refuses the read
 * (throw) - read acceptance extends only to the migration diagnostic, so
 * this never weakens the strict writer gate. Performs no writes: the
 * source file's bytes are never touched; legacy snapshots migrate on their
 * next authorized read-modify-write through the canonical writer. Missing
 * files, malformed JSON, and non-object documents throw.
 *
 * R3/#293: a running `type: iteration` document that declares NO `phase`
 * (registered by a producer that predates the phase declaration, or by hand)
 * is the `not-prepare` dead end this reader exists to close. The phase is
 * DERIVED from the lifecycle facts the document already holds
 * (`deriveLifecyclePhase`) and returned as a read-time view with the
 * non-blocking `workflow.snapshot.derived-phase` diagnostic - the bytes stay
 * untouched, and the next authorized mutation persists the repair. Nothing is
 * derived for a plan snapshot (no phase concept) or a terminal document.
 */
export class WorkflowSnapshotValidationError extends Error {
  constructor(message: string, readonly violations: ValidationResult[]) { super(message); }
}

export function readWorkflowSnapshot(dir: string): WorkflowSnapshotRead {
  // Canonical authority discrimination precedes the existence/parse/validation
  // work below (spec §4.3): with an ACTIVE execution authority the snapshot is
  // retired as an authority source, so this reader refuses instead of handing
  // leftover JSON to a consumer as validated state. `storeDbPath` normalizes
  // the target to the CONTROL harness root, so a worktree-local file reader
  // cannot dodge the veto.
  assertExecutionFileReadAllowed({ harnessDir: dir });
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) {
    throw new Error(`workflow snapshot not found: ${snapshotPath}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${snapshotPath}: ${(error as Error).message}`);
  }
  return normalizeWorkflowSnapshot(doc, snapshotPath);
}

function normalizeWorkflowSnapshot(doc: unknown, snapshotPath: string): WorkflowSnapshotRead {
  const gate = validateWorkflowSnapshot(doc);
  const migration = gate.violations.filter((v) => v.code === LEGACY_WORKTREE_PATH_CODE);
  const blocking = gate.violations.filter((v) => v.code !== LEGACY_WORKTREE_PATH_CODE);
  if (blocking.length > 0) {
    const detail = blocking.map((v) => `${v.code}: ${v.message}`).join("; ");
    throw new WorkflowSnapshotValidationError(`refusing to read invalid workflow snapshot ${snapshotPath}: ${detail}`, blocking);
  }
  let snapshot: WorkflowSnapshot;
  if (migration.length === 0) {
    snapshot = doc as WorkflowSnapshot;
  } else {
    // In-memory normalization of the single permitted legacy alias.
    const raw = doc as Record<string, unknown>;
    const { control_worktree_path: _legacy, ...rest } = raw;
    snapshot = { ...rest, integration_worktree_path: raw.control_worktree_path } as unknown as WorkflowSnapshot;
    const revalidated = validateWorkflowSnapshot(snapshot);
    if (!revalidated.ok) {
      const detail = revalidated.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
      throw new Error(
        `refusing to read workflow snapshot ${snapshotPath}: legacy normalization produced an invalid document: ${detail}`,
      );
    }
  }
  const diagnostics = [...migration];
  if (snapshot.phase === undefined) {
    // R3/#293 - the absent phase is derived from the lifecycle facts, in
    // memory only. A derived phase is a read-time view: it is reported, never
    // written here, and a derived FORWARD label (execution ownership already
    // exists) is never reset to Prepare.
    const derivation = deriveLifecyclePhase(snapshot);
    if (derivation.phase !== undefined) {
      diagnostics.push(
        violation(
          "medium",
          DERIVED_PHASE_CODE,
          `snapshot ${snapshotPath} declares no phase; the lifecycle facts derive ${derivation.phase} (${derivation.facts.join("; ")})`,
          "no action needed - the derived phase is a read-time view and the next authorized mutation persists it",
        ),
      );
      return { snapshot: { ...snapshot, phase: derivation.phase }, diagnostics };
    }
  }
  return { snapshot, diagnostics };
}

/**
 * Writer contract (spec §C4). `createOnly` is the locked create-only shorthand
 * used by the scaffold/migrate/audit writers: an existing document (even an
 * empty or malformed one) is never silently replaced. Omitting it means
 * replace-whatever-is-there under the snapshot lock — the lock discipline is
 * the serializer, and there is no version token to present.
 *
 * The delta allowed here is `phase` + `updated_at` and nothing else - a
 * coordinator persists its phase projection through this writer without ever
 * gaining a backdoor to row owners, leases, lifecycle scalars or branch
 * anchors. Lifecycle terminal changes belong to `closeWorkflow` (spec §C4).
 */
export type WriteWorkflowSnapshotOptions = {
  createOnly?: boolean;
  /**
   * Canonical coordinator session envelope path (spec §C4). Required when the
   * stored snapshot is coordinated: only the snapshot's own bound coordinator
   * may pass, and the `coordination` block itself is never part of the delta.
   */
  sessionPath?: string;
};

/**
 * Write a workflow snapshot as a field-scoped update of `dir/snapshot.json`
 * under `withStatusWriteLock(snapshotPath)` ( - the `.status-write.lockdir`
 * lands inside `workflows/<id>/`, dirname of the snapshot; no harness-root
 * pollution). The snapshot is validated first - an invalid snapshot throws
 * and nothing is written. `dir` is created recursively. The durable write
 * routes through the active `ArtifactStore` (the store contract: snapshot →
 * `{ kind: "snapshot", key: <workflow id> }`) inside the existing lock - the
 * default FsStore resolves `{WORKFLOW_DIR}/<key>/snapshot.json`, identical
 * to `join(dir, WORKFLOW_SNAPSHOT_FILE)` for canonical callers. The write
 * fails loud when the active FsStore would resolve a different path than
 * the caller's `join(dir, WORKFLOW_SNAPSHOT_FILE)`  - callers
 * whose target root differs from the active store's root MUST
 * `setArtifactStore(createFsStore(root))` first.
 */
export async function writeWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  dir: string,
  opts: WriteWorkflowSnapshotOptions = {},
): Promise<void> {
  // Canonical authority discrimination precedes payload validation and the
  // lock (spec §4.3): with an ACTIVE execution authority the snapshot is
  // retired as a persistence route, so this refuses whatever store the caller
  // injected and before any payload validation. The context is the target
  // dir; `storeDbPath` normalizes it to the CONTROL harness root.
  assertExecutionFileWriteAllowed({ harnessDir: dir });
  const gate = validateWorkflowSnapshot(snapshot);
  if (!gate.ok) {
    const detail = gate.violations.map((v) => v.message).join("; ");
    throw new Error(`refusing to write invalid workflow snapshot: ${detail}`);
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  // Fail-loud path agreement : the lockdir serializes
  // `snapshotPath`; the store put must land on that same file. A divergence
  // (caller target outside the active FsStore root) throws before the dir or
  // lockdir is created - nothing is written anywhere.
  const store = getArtifactStore();
  assertFsStorePath(store, { kind: "snapshot", key: snapshot.id }, snapshotPath);
  // simplify: whole-rewrite snapshot on every state change (temp+rename via
  // writeJson under the workflow lockdir) - the ceiling is O(plans[] × row
  // payload) per write; unbounded inputs already divert to notes.jsonl at
  // migrate time. Upgrade path: append-only delta file or per-row files +
  // compaction when a lifecycle exceeds ~N plans / large per-row payloads.
  // The lockdir mkdir is non-recursive - the snapshot dir must exist before
  // acquisition (the lockdir lands inside `dir`, dirname of the snapshot).
  mkdirSync(dir, { recursive: true });
  // The store put is the durable write inside the lock; the store is never a
  // second lock (architect-locked 2026-08-27: locks stay with callers).
  await withStatusWriteLock(snapshotPath, async () => {
    const current = readArtifactBytes(snapshotPath);
    // Create-only is the writer's own existence rule: an existing document
    // (even an empty or malformed one) is never silently replaced, and the
    // refusal names the create-only intent rather than any version token. An
    // omitted `createOnly` is a replace-whatever-is-there under this lock —
    // the lock discipline is the serializer.
    if (opts.createOnly === true && current !== undefined) {
      throw new CoordinationError(
        "coordination.direct-write-refused",
        `snapshot ${snapshotPath} already exists \u2014 a create-only write never replaces one; remove it explicitly or ` +
          `write without createOnly`,
        { path: snapshotPath },
      );
    }
    const payload = current === undefined ? snapshot : mergePhaseProjection(current.payload, snapshot);
    if (current === undefined) assertNoRecoveryHistoryOnCreate(payload, snapshotPath);
    assertCoordinatedSnapshotWriter(current?.payload, snapshotPath, opts.sessionPath);
    await withProtectedWrite(snapshotPath, "put", () =>
      store.put({ kind: "snapshot", key: snapshot.id, payload }),
    );
  });
}

/**
 * Provenance boundary for the recovery audit (prerequisite contract §3.3).
 *
 * `coordination.identity_recoveries` is written ONLY by
 * `recoverPrepareCoordinator`, which appends one entry under the snapshot write
 * lock after authenticating the prior binding. The ordinary writer pins an
 * EXISTING audit to disk (a replacement cannot drop or rewrite it), but a
 * create-only write has no disk document to pin against: without this boundary
 * a caller could CREATE a snapshot carrying an arbitrary, schema-valid -
 * entirely forged - recovery history that never passed through the recovery
 * transition. Shape validation is not provenance, so the history is refused
 * outright, whatever its shape, and the only door that establishes it is the
 * authorized recovery.
 */
function assertNoRecoveryHistoryOnCreate(payload: unknown, snapshotPath: string): void {
  const coordination = isPlainObject(payload) ? payload.coordination : undefined;
  const recoveries = isPlainObject(coordination) ? coordination.identity_recoveries : undefined;
  if (!Array.isArray(recoveries) || recoveries.length === 0) return;
  throw new CoordinationError(
    "coordination.direct-write-refused",
    `refusing to create snapshot ${snapshotPath} carrying ${recoveries.length} coordination.identity_recoveries ` +
      `entr${recoveries.length === 1 ? "y" : "ies"} \u2014 recovery history is established only by the coordinator ` +
      `recovery transition, and this create-only write proves no such provenance`,
    { path: snapshotPath, recoveries: recoveries.length },
  );
}

/**
 * Coordinated snapshots are replaced only by their own bound coordinator
 * (spec §C4) - the `mstar persist replace snapshot` door authenticates on the
 * session envelope, and a replacement can never add or drop the
 * `coordination` block (the field-scoped merge already pins it to disk).
 * `CloseWorkflowOptions.sessionPath` reaches the same seam, so the refusal
 * names the operation that was refused.
 */
function assertCoordinatedSnapshotWriter(
  stored: unknown,
  snapshotPath: string,
  sessionPath: string | undefined,
  action = "replacement",
): void {
  const coordination = isPlainObject(stored) ? stored.coordination : undefined;
  if (coordination === undefined) return;
  const bound = isPlainObject(coordination) && isPlainObject(coordination.coordinator) ? coordination.coordinator.session_file : undefined;
  if (sessionPath === undefined || typeof bound !== "string" || canonicalTarget(sessionPath) !== canonicalTarget(bound)) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `snapshot ${snapshotPath} is coordinated \u2014 ${action} requires --session <coordinator envelope>`,
      { path: snapshotPath, expected: bound, actual: sessionPath },
    );
  }
}

/**
 * `phase` + `updated_at` are taken from the incoming snapshot (spec §C4 line
 * 152). The stored document remains the source for every other field, while
 * semantic identity, scope, state and authority fields are checked against
 * their stored values before projection. Documentary content may vary, while
 * row execution scope metadata remains write-protected.
 */
function mergePhaseProjection(stored: unknown, incoming: WorkflowSnapshot): WorkflowSnapshot {
  if (!isPlainObject(stored)) {
    throw new CoordinationError(
      "coordination.store",
      "stored workflow snapshot is not an object \u2014 refusing a field-scoped rewrite over it",
      {},
    );
  }
  const protectedFields = [
    "schema_version", "id", "type", "status", "started_at", "ended_at",
    "branch", "integration_worktree_path", "compass_ref", "execution_policy",
    "integration_merge_lease", "delivery_kind", "project",
    "completion_policy",
  ] as const;
  const candidate = incoming as unknown as Record<string, unknown>;
  for (const field of protectedFields) {
    if (candidate[field] !== undefined && !isDeepStrictEqual(candidate[field], stored[field])) {
      throw new CoordinationError(
        "coordination.direct-write-refused",
        `snapshot replacement cannot change workflow ${field}; use its authorized lifecycle operation`,
        { field },
      );
    }
  }
  const incomingCoordination = isPlainObject(candidate.coordination) ? candidate.coordination : {};
  const storedCoordination = isPlainObject(stored.coordination) ? stored.coordination : {};
  if (incomingCoordination.coordinator !== undefined &&
      !isDeepStrictEqual(incomingCoordination.coordinator, storedCoordination.coordinator)) {
    throw new CoordinationError("coordination.direct-write-refused", "snapshot replacement cannot change the coordinator; use workflow recover-coordinator", { field: "coordination.coordinator" });
  }
  const rows = Array.isArray(stored.plans) ? stored.plans : [];
  const incomingRows = Array.isArray(candidate.plans) ? candidate.plans : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (isPlainObject(row) && typeof row.id === "string") byId.set(row.id, row);
  }
  if (incomingRows.length !== rows.length) {
    throw new CoordinationError(
      "coordination.direct-write-refused",
      "snapshot replacement cannot add or remove plan rows; use the authorized workflow amendment operation",
      { field: "plans" },
    );
  }
  const rowFields = ["id", "plan_id", "file", "status", "progress", "revision"] as const;
  const seenRows = new Set<string>();
  for (const row of incomingRows) {
    if (!isPlainObject(row) || typeof row.id !== "string" || seenRows.has(row.id)) {
      throw new CoordinationError("coordination.direct-write-refused", "snapshot replacement contains an unidentified or duplicate plan row", { field: "plans" });
    }
    seenRows.add(row.id);
    const prior = byId.get(row.id);
    if (prior === undefined) {
      throw new CoordinationError("coordination.direct-write-refused", `snapshot replacement cannot add plan row ${row.id}`, { field: "plans", plan_id: row.id });
    }
    for (const field of rowFields) {
      if (row[field] !== undefined && !isDeepStrictEqual(row[field], prior[field])) {
        throw new CoordinationError(
          "coordination.direct-write-refused",
          `snapshot replacement cannot change plan row ${row.id} ${field}; use its authorized lifecycle operation`,
          { field: `plans.${field}`, plan_id: row.id },
        );
      }
    }
    const incomingAuthority = isPlainObject(row.coordination) ? row.coordination : {};
    const storedAuthority = isPlainObject(prior.coordination) ? prior.coordination : {};
    for (const field of ["revision"] as const) {
      if (incomingAuthority[field] !== undefined && !isDeepStrictEqual(incomingAuthority[field], storedAuthority[field])) {
        throw new CoordinationError("coordination.direct-write-refused", `snapshot replacement cannot change plan row ${row.id} coordination.${field}; use its authorized plan operation`, { field: `plans.coordination.${field}`, plan_id: row.id });
      }
    }
    for (const [block, fields] of [
      ["prepared", ["qa_gate", "findings_cleanup", "prepared_by", "prepared_at"]],
      ["progress", ["status", "summary", "evidence_paths", "track_branches"]],
      ["completion", ["source_branch", "source_sha", "worktree_path", "review_base", "review_head", "qc", "qa", "integration", "completed_by", "completed_at"]],
    ] as const) {
      const proposed = isPlainObject(incomingAuthority[block]) ? incomingAuthority[block] : {};
      const held = isPlainObject(storedAuthority[block]) ? storedAuthority[block] : {};
      for (const field of fields) {
        if (proposed[field] !== undefined && !isDeepStrictEqual(proposed[field], held[field])) {
          throw new CoordinationError("coordination.direct-write-refused", `snapshot replacement cannot change plan row ${row.id} coordination.${block}.${field}; use its authorized plan operation`, { field: `plans.coordination.${block}.${field}`, plan_id: row.id });
        }
      }
    }
    const incomingMetadata = isPlainObject(row.metadata) ? row.metadata : {};
    const storedMetadata = isPlainObject(prior.metadata) ? prior.metadata : {};
    for (const field of ["iteration_refs", "spec_integration_branch", "merge_target", "worktree_path", "working_branch"] as const) {
      if (incomingMetadata[field] !== undefined && !isDeepStrictEqual(incomingMetadata[field], storedMetadata[field])) {
        throw new CoordinationError("coordination.direct-write-refused", `snapshot replacement cannot change plan row ${row.id} metadata.${field}`, { field: `plans.metadata.${field}`, plan_id: row.id });
      }
    }
  }
  const allowed = ["phase", "updated_at"];
  const next: Record<string, unknown> = { ...stored };
  for (const key of allowed) {
    const value = candidate[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as WorkflowSnapshot;
}



/**
 * Shared by writers that already hold the snapshot lock. `snapshotPath` is the
 * canonical target of the put: the store boundary refuses an unauthorized
 * write to a protected document, so the write is recorded inside
 * `withProtectedWrite` (spec §C4 - durable protected writes route through the
 * store inside the locked coordination context).
 */
async function validateAndPutWorkflowSnapshot(
  store: ArtifactStore,
  snapshot: WorkflowSnapshot,
  snapshotPath: string,
): Promise<void> {
  const gate = validateWorkflowSnapshot(snapshot);
  if (!gate.ok) {
    const detail = gate.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
    throw new WorkflowSnapshotValidationError(`refusing to write invalid workflow snapshot: ${detail}`, gate.violations);
  }
  await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "snapshot", key: snapshot.id, payload: snapshot }));
}

/** Terminal enum predicate only; callers validate document shape separately. */
export function isTerminalSnapshot(doc: WorkflowSnapshot): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(doc.status);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Delivery-registration inputs every producer declares (contract §1/§4a). */
export type DeliveryRegistrationEvidence = {
  branchSource?: string;
  branchTarget?: string;
  completionPolicy?: string;
};

/**
 * Per-kind registration-evidence coherence (contract §1) - the ONE rule shared
 * by every producer that declares a delivery kind at registration time:
 * `registerPlanWorkflow` (the normal-entry producer), `promoteAuditPlans`
 * (audit promotion) and `migrateHarnessTree` (v1 lift), plus the one-time
 * `declareWorkflowDeliveryKind` backfill for active kind-less snapshots.
 * Lockstep here is the point: a `development` workflow declares BOTH delivery
 * anchors and a `verification/report-only` workflow declares the completion
 * policy that completes it - missing fields are incomplete registration, never
 * an exemption, and a producer that drifted would otherwise mint an
 * unclosable lifecycle. `what` prefixes the refusal (the caller's own name).
 */
export function assertDeliveryRegistrationCoherence(
  kind: WorkflowDeliveryKind,
  evidence: DeliveryRegistrationEvidence,
  what: string,
): void {
  if (kind === "development" && (!nonEmptyString(evidence.branchSource) || !nonEmptyString(evidence.branchTarget))) {
    throw new Error(
      `${what}: a development workflow requires its delivery source and target branches (--branch-source/--branch-target) \u2014 missing branch fields are incomplete registration, not an exempt workflow (contract \u00a71/\u00a74a)`,
    );
  }
  if (kind === "verification/report-only" && !nonEmptyString(evidence.completionPolicy)) {
    throw new Error(
      `${what}: a verification/report-only workflow requires the completion policy (--completion-policy) naming the evidence that completes it (contract \u00a71)`,
    );
  }
  for (const [field, value] of Object.entries({ branchSource: evidence.branchSource, branchTarget: evidence.branchTarget, completionPolicy: evidence.completionPolicy })) {
    if (value !== undefined && !nonEmptyString(value)) {
      throw new Error(`${what}: ${field} must be a non-empty string when given`);
    }
  }
}

/**
 * Delivery-kind evidence consultation (seam S3 - contract §4g + §6 S3): the
 * ONE implementation behind both the read-only Phase-6 gate
 * (`evaluatePostMergeClose`) and the close write path (`closeWorkflow`), so
 * the gate's verdict and the close's refusal can never drift apart. Pure,
 * read-only, no writes; the input snapshot is consumed as read.
 *
 * Only `type: plan` lifecycles consult (an iteration declares no delivery
 * kind - §1); WHEN the consultation runs is the caller's rule, and both
 * callers scope it to a delivered lifecycle: `closeWorkflow` consults the
 * running snapshot it is about to complete, and the Phase-6 gate consults a
 * `completed` terminal snapshot. A `failed`/`stopped` close is therefore never
 * demanded delivery evidence (§5). The DECLARED kind decides the required
 * evidence; nothing is inferred from which fields happen to be present, and a
 * missing field is incomplete registration, never an exemption (§1):
 *
 * - no registered `delivery_kind` → `PHASE6_DELIVERY_KIND_UNREGISTERED` (a
 *   legacy terminal snapshot cannot be backfilled: the register producer is
 *   create-only and preserves the terminal bytes);
 * - `development` → the registered `branch.source`/`branch.target` plus the
 *   collected `delivery` evidence: compound disposition (§4c), PR identity
 *   (§4d) and the PM's verified-merge record (§4f - the engine never verifies
 *   the remote merge itself);
 * - `verification/report-only` → the recorded `completion_policy` plus its
 *   fulfilment record, which must name that same policy (§1).
 *
 * Everything missing is named in one refusal (`PHASE6_DELIVERY_EVIDENCE_INCOMPLETE`)
 * whose fix hint points at the authorized recording seam.
 */
export function consultDeliveryEvidence(snapshot: WorkflowSnapshot): ValidationResult[] {
  if (snapshot.type !== "plan") return [];
  const workflowId = nonEmptyString(snapshot.id) ? snapshot.id : "<unknown>";
  const kind = snapshot.delivery_kind;
  if (typeof kind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(kind)) {
    return [
      violation(
        "high",
        "PHASE6_DELIVERY_KIND_UNREGISTERED",
        `Workflow '${workflowId}' is type 'plan' but carries no registered delivery_kind \u2014 a plan workflow declares its delivery kind at registration (mstar-artifacts/references/plan-workflow-lifecycle-contract.md \u00a71), so this snapshot's delivery evidence cannot be consulted`,
        // The still-active population (audit promotion / the v1 lift minted
        // active snapshots before their producers declared a kind) is repaired
        // by the one-time declaration seam; a TERMINAL snapshot cannot be
        // (declare refuses a closed lifecycle, and the create-only register
        // can never match a terminal registration identity), so its repair
        // stays the explicit owner amendment.
        "Delivery evidence is declared at registration, before execution. A still-ACTIVE kind-less workflow is repaired by the authorized one-time declaration 'mstar workflow evidence --workflow <id> --declare-kind <development|verification/report-only> [--branch-source <b> --branch-target <b> | --completion-policy <text>] [--session <envelope>]' (declared once, never re-declared); a TERMINAL legacy snapshot cannot be backfilled \u2014 'mstar workflow register' is create-only and its registration identity can never match a terminal snapshot \u2014 so repair requires an explicit owner snapshot amendment recording the declared kind (the known affected population \u2014 audit-promotion's grandfathered type: plan snapshots \u2014 is disclosed as a residual by plan QC), then re-run the close / 'mstar iteration gate --phase 6 --workflow <id>'",
      ),
    ];
  }
  const branch = isPlainObject(snapshot.branch) ? snapshot.branch : undefined;
  const delivery = isPlainObject(snapshot.delivery) ? snapshot.delivery : undefined;
  const missing: string[] = [];
  if (kind === "development") {
    if (!nonEmptyString(branch?.source)) missing.push("branch.source");
    if (!nonEmptyString(branch?.target)) missing.push("branch.target");
    if (!isPlainObject(delivery?.compound)) missing.push("delivery.compound (compound disposition, \u00a74c)");
    const pr = isPlainObject(delivery?.pr) ? delivery.pr : undefined;
    if (pr === undefined) {
      missing.push("delivery.pr (PR repo/head/target identity, \u00a74d)");
    } else {
      // §4d: the identity recorded at submission IS the delivery the workflow
      // was registered for. Presence alone let a contradictory pair (a PR for
      // a different head/target) satisfy the close; `repo` is required but its
      // value is the recorder's own (no canonical repo to compare against).
      if (nonEmptyString(branch?.source) && pr.head !== branch.source) {
        missing.push(
          `delivery.pr.head (recorded ${JSON.stringify(pr.head)}, registered branch.source ${JSON.stringify(branch.source)} \u2014 \u00a74d: the recorded PR identity must be the registered delivery)`,
        );
      }
      if (nonEmptyString(branch?.target) && pr.target !== branch.target) {
        missing.push(
          `delivery.pr.target (recorded ${JSON.stringify(pr.target)}, registered branch.target ${JSON.stringify(branch.target)} \u2014 \u00a74d: the recorded PR identity must be the registered delivery)`,
        );
      }
    }
    if (!isPlainObject(delivery?.merge)) missing.push("delivery.merge (PM-recorded verified-merge evidence, \u00a74f)");
  } else {
    const policy = snapshot.completion_policy;
    if (!nonEmptyString(policy)) missing.push("completion_policy (the recorded alternative completion policy, \u00a71)");
    const completion = isPlainObject(delivery?.completion) ? delivery.completion : undefined;
    if (completion === undefined) {
      missing.push("delivery.completion (the fulfilment record of the registered policy, \u00a71)");
    } else if (nonEmptyString(policy) && completion.policy !== policy) {
      missing.push(
        `delivery.completion.policy (\u00a71 \u2014 recorded ${JSON.stringify(completion.policy)}, registered completion_policy ${JSON.stringify(policy)})`,
      );
    }
  }
  if (missing.length === 0) return [];
  const incomplete = (fix: string): ValidationResult =>
    violation(
      "high",
      "PHASE6_DELIVERY_EVIDENCE_INCOMPLETE",
      `Workflow '${workflowId}' declares delivery_kind '${kind}' but its delivery evidence is incomplete \u2014 missing: ${missing.join(", ")} (mstar-artifacts/references/plan-workflow-lifecycle-contract.md \u00a73 lifecycle stages + \u00a74c/\u00a74d/\u00a74f)`,
      fix,
    );
  const record = `Record the missing evidence with 'mstar workflow evidence --workflow ${workflowId} --file <payload.json>' (add --session <coordinator envelope> for a coordinated workflow)`;
  return [
    kind === "development"
      ? incomplete(
          `${record}: the compound disposition (\u00a74c, before the PR head is finalized), the PR identity (\u00a74d, at submission) and the verified-merge record (\u00a74f, the PM's own check \u2014 the engine never verifies the remote merge). Done rows alone are not delivery evidence`,
        )
      : incomplete(`${record}: the fulfilment record must name the registered completion policy and its evidence (\u00a71)`),
  ];
}

/**
 * §R11/A21 the terminal outcomes a close may RECORD. A close never records a
 * non-terminal status, and the three members are the snapshot schema's terminal
 * set - `failed`/`stopped` are the explicit terminal intents #270 requires, and
 * they carry NO successful-delivery precondition (contract §5).
 */
export type CloseWorkflowOutcome = "completed" | "failed" | "stopped";

export type CloseWorkflowOptions = {
  endedAt: string;
  /**
   * The terminal outcome this close records (#270/R11). Default `completed` -
   * the delivery-gated close, whose behavior is unchanged.
   *
   * `failed`/`stopped` record an EXPLICIT terminal intent: every plan row's
   * `Done` state and the declared delivery kind's evidence are NOT consulted
   * (a failure close is never treated as a delivery), and the workflow's own
   * held claims are settled in the same locked snapshot write - a claim whose
   * holder is no longer one of this workflow's recorded session identities AND
   * whose stop a recorded identity-recovery attestation establishes is released
   * (the file route's release is the lease key's absence), while a claim a live
   * holder still holds, or one whose holder no recorded stop or transfer
   * accounts for, refuses the outcome with that holder named.
   * A recorded terminal outcome is never rewritten: a `failed`/`stopped` request
   * against a lifecycle that already records a DIFFERENT terminal status is
   * refused.
   */
  outcome?: CloseWorkflowOutcome;
  /**
   * Canonical coordinator session envelope path (spec §C4). Required when the
   * stored snapshot is coordinated: the close writes the snapshot, so only the
   * snapshot's own bound coordinator may pass. A missing/mismatched envelope
   * refuses the close with `coordination.session-mismatch` before anything is
   * written. Non-coordinated snapshots ignore it; an already-terminal snapshot
   * is returned unchanged (no write, no authorization needed).
   */
  sessionPath?: string;
};

/**
 * The timestamp form a lifecycle close accepts (`YYYY-MM-DD` or RFC3339 with a
 * time), exported for the composed file-authority close, which validates the
 * requested terminal timestamp BEFORE it composes anything (a malformed
 * `endedAt` must refuse before a row is completed, not after).
 */
export function isCloseTimestamp(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(value);
  if (!match) return false;
  // Date.parse normalizes impossible dates such as February 30; compare the
  // calendar date independently of the optional timestamp's UTC offset.
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}


/**
 * Complete the latest snapshot under its write lock. Never releases leases.
 *
 * §3/§5 the `outcome` the caller states decides which terminal write runs:
 *
 * - `completed` (the default, unchanged): every owned row must be `Done` and
 *   the registered delivery kind's evidence is consulted through
 *   `consultDeliveryEvidence` - the SAME pure function the read-only Phase-6
 *   gate runs (contract §4g/§6 S3), so the gate's verdict and this refusal can
 *   never disagree. An incomplete delivery throws with every missing item named
 *   and ZERO writes: the snapshot stays `running` and the root entry stays
 *   registered, so the workflow remains resumable. The local close never
 *   verifies a remote merge (§4f keeps that as the PM's separate check).
 * - `failed`/`stopped` (#270/R11/A21): an explicit terminal intent, recorded
 *   WITHOUT any successful-delivery precondition - no row-`Done` requirement, no
 *   delivery-evidence consultation (a failure close is never treated as a
 * delivery; the Phase-6 gate passes such a snapshot by the same rule). A
 * failed/stopped close may settle the workflow mutex only when coordinator
 * recovery records that the exact mutex holder stopped; live or unattested
 * holders remain protected.
 *
 * A valid terminal snapshot is returned unchanged - including `failed`/`stopped`
 * (idempotent preservation: nothing is rewritten, not even the timestamp). Two
 * requests behave exactly that way: the RESTATEMENT of the status the lifecycle
 * already records (the residue a crash between the terminal write and the root
 * cleanup leaves - the next normal close continues that cleanup without
 * replaying work or resetting `ended_at`), and a `completed` close over a
 * `failed`/`stopped` outcome, which is returned as THAT outcome (R10: an
 * existing result is never rewritten as `completed`). A `failed`/`stopped`
 * request against a lifecycle that records a different terminal status is
 * REFUSED - a closed lifecycle is never amended (§5).
 *
 * A coordinated snapshot is closed only by its own bound coordinator
 * (spec §C4) - the same envelope seam as `writeWorkflowSnapshot` - so a plan
 * actor or a bare CLI call can never complete a lifecycle it does not own. The
 * authorization precedes the claim settle, so an unauthorized address releases
 * nothing.
 */
export async function closeWorkflow(workflowId: string, dir: string, opts: CloseWorkflowOptions): Promise<WorkflowSnapshot> {
  // Canonical authority discrimination precedes every payload check below and
  // the unchanged-snapshot shortcut (spec §4.3).
  assertExecutionFileWriteAllowed({ harnessDir: dir });
  const outcome = opts.outcome ?? "completed";
  if (outcome !== "completed" && outcome !== "failed" && outcome !== "stopped") {
    throw new Error(`outcome must be one of completed | failed | stopped \u2014 got ${JSON.stringify(opts.outcome)}`);
  }
  if (!isCloseTimestamp(opts.endedAt)) {
    throw new Error("endedAt must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();
  const ref = { kind: "snapshot" as const, key: workflowId };
  assertFsStorePath(store, ref, snapshotPath);
  mkdirSync(dir, { recursive: true });
  return withStatusWriteLock(snapshotPath, async () => {
    const doc = await store.get(ref);
    if (doc === undefined) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
    const { snapshot } = normalizeWorkflowSnapshot(doc, snapshotPath);
    if (snapshot.id !== workflowId) {
      throw new Error(`workflow snapshot identity mismatch: expected ${workflowId}, got ${snapshot.id}`);
    }
    if (isTerminalSnapshot(snapshot)) {
      // The restatement and the ordinary `completed` read are the no-write
      // paths above; recording a DIFFERENT terminal status here would be
      // amending a closed lifecycle, so it is refused before the write path.
      if (outcome === "completed" || outcome === snapshot.status) return snapshot;
      throw new CoordinationError(
        "coordination.invalid-transition",
        `workflow ${workflowId} is ${snapshot.status} \u2014 a closed lifecycle is never amended, and its history stays exactly as ` +
          `it was recorded`,
        { workflow_id: workflowId, status: snapshot.status, requested: outcome },
      );
    }
    // Authorization sits on the write path only: a terminal snapshot returned
    // above is never written. For a coordinated snapshot the stored payload
    // (not the normalized view) carries the `coordination` block, exactly as
    // the replacement door reads it.
    assertCoordinatedSnapshotWriter(doc, snapshotPath, opts.sessionPath, "close");
    if (outcome === "completed") {
      if (snapshot.plans.some((row) => row.status !== "Done")) {
        throw new Error("refusing to close workflow: every plan row must be Done");
      }
      const deliveryViolations = consultDeliveryEvidence(snapshot);
      if (deliveryViolations.length > 0) {
        const detail = deliveryViolations
          .map((v) => `${v.code}: ${v.message}${v.fix !== undefined ? ` (fix: ${v.fix})` : ""}`)
          .join("; ");
        throw new Error(`refusing to close workflow: ${detail}`);
      }
    }
    let closeBase = snapshot;
    const coordinatorSessionId = snapshot.coordination?.coordinator?.session_id;
    const lease = snapshot.integration_merge_lease;
    if (lease !== undefined) {
      const leaseClaimedAt = Date.parse(lease.claimed_at);
      const attestedStopped =
        outcome !== "completed" &&
        coordinatorSessionId !== undefined &&
        lease.holder !== coordinatorSessionId &&
        Number.isFinite(leaseClaimedAt) &&
        (snapshot.coordination?.identity_recoveries ?? []).some((recovery) => {
          const stoppedAt = Date.parse(recovery.attested_at ?? "");
          const recoveredAt = Date.parse(recovery.recovered_at);
          return (
            recovery.workflow_id === workflowId &&
            recovery.prior_session_id === lease.holder &&
            recovery.session_id === coordinatorSessionId &&
            recovery.stopped_session_ids.includes(lease.holder) &&
            !recovery.stopped_session_ids.includes(coordinatorSessionId) &&
            Number.isFinite(stoppedAt) &&
            Number.isFinite(recoveredAt) &&
            leaseClaimedAt <= stoppedAt &&
            stoppedAt <= recoveredAt
          );
        });
      if (!attestedStopped) {
        throw new CoordinationError(
          "coordination.invalid-transition",
          `workflow ${workflowId} cannot become ${outcome} while the integration mutex holder is live or lacks a matching stop attestation at or after this claim; for pre-activation FILE authority, recover the recorded coordinator with \`mstar workflow recover-coordinator --session <prior-coordinator-envelope> --operation-id <id> --reason <reason> --authorization-ref <approved-reference> --stopped <prior-session-id> --attestation <absolute-ActivationAttestation.json>\`, then close as failed or stopped`,
          { workflow_id: workflowId, status: outcome, holder: lease.holder, current_coordinator: coordinatorSessionId ?? null },
        );
      }
      const { integration_merge_lease: _settled, ...withoutMutex } = snapshot;
      closeBase = withoutMutex;
    }
    const closed: WorkflowSnapshot = { ...closeBase, status: outcome, ended_at: opts.endedAt, updated_at: opts.endedAt };
    // Strict terminal validation enforces that the mutex is settled before close.
    await validateAndPutWorkflowSnapshot(store, closed, snapshotPath);
    return closed;
  });
}

// ---------------------------------------------------------------------------
// Delivery evidence recording (mstar-artifacts/references/plan-workflow-lifecycle-contract.md §3/§4c/§4d/
// §4f, seam S3): the authorized write seam that fills the snapshot's
// `delivery` block, stage by stage, before the close consults it.
// ---------------------------------------------------------------------------

export type RecordWorkflowDeliveryOptions = {
  /**
   * Partial delivery-evidence patch: only the named members are merged into
   * the stored block, so the compound disposition, the PR identity and the
   * merge record can be recorded at their own lifecycle stages without
   * rewriting each other. At least one member is required.
   */
  evidence: WorkflowDeliveryEvidence;
  /**
   * Canonical coordinator session envelope path (spec §C4) - the same
   * authority seam `closeWorkflow` uses: a coordinated snapshot is written
   * only by its own bound coordinator. Non-coordinated snapshots have no
   * coordinator to bind and ignore it.
   */
  sessionPath?: string;
  /** Recording timestamp (YYYY-MM-DD or RFC3339). Default: now. */
  at?: string;
};

export type RecordWorkflowDeliveryResult = {
  snapshot: WorkflowSnapshot;
  /** `false` when the recorded evidence already matched disk - nothing was written. */
  written: boolean;
};

/**
 * Record (or extend) the delivery evidence on a `type: plan` workflow's
 * snapshot, under the snapshot write lock: the close path's consultation is
 * only as good as the evidence recorded here, so this is the seam that makes
 * a `development` close possible at all.
 *
 * Refusals (before any write):
 * - a terminal snapshot: delivery evidence is collected BEFORE the close, and
 *   a terminal lifecycle is never amended (§5 - no rewriting a closed
 *   lifecycle);
 * - a lifecycle other than `type: plan`, or one without a registered
 *   `delivery_kind`: the evidence belongs to the declared kind (§1);
 * - evidence the declared kind does not use (e.g. a completion record on a
 *   `development` workflow) - the declared kind is authoritative;
 * - an empty patch or a malformed member: nothing is silently dropped.
 *
 * §365 re-recording delivery is a revisable mutation: the recorded PR identity, the
 * report-only `completion` fulfilment, the compound disposition and the merge
 * record are all data the close consults, so a later recording replaces them
 * rather than being refused. A tampered replay of the SAME operation id is
 * refused by the request-hash conflict instead.
 *
 * §R5/A19 the delivery tail (compound | PR identity | verified-merge record) is
 * EXTERNAL evidence that arrives when it arrives: it is captured whenever it is
 * observed, and the row's `Done` projection is never its ordering
 * prerequisite - the close composes that projection from the same evidence
 * (`closeFileWorkflow`), exactly as the DB close composes it there. The
 * semantic boundary is the CLOSE, which still requires the declared kind's
 * complete evidence against rows it has completed (`consultDeliveryEvidence`),
 * so the ordering is bookkeeping rather than a caller ceremony. The DB route
 * enforces the same rule in `applyDeliveryEvidence`.
 *
 * Grandfathering: a snapshot that already carries delivery evidence while rows
 * are not `Done` is never retro-invalidated; an idempotent re-record returns
 * without consulting row state; `closeWorkflow` / `evaluatePostMergeClose` are
 * unchanged.
 *
 * Idempotent and re-entrant: re-recording the exact stored evidence performs
 * NO write and returns the snapshot as read (the timestamp is untouched), so
 * a retried recording never produces a spurious revision. The write itself
 * routes through the same protected-writer path as the close (the store's
 * locked put inside the snapshot lock).
 */
export async function recordWorkflowDelivery(
  workflowId: string,
  dir: string,
  opts: RecordWorkflowDeliveryOptions,
): Promise<RecordWorkflowDeliveryResult> {
  // Canonical authority discrimination precedes payload validation (spec §4.3).
  assertExecutionFileWriteAllowed({ harnessDir: dir });
  const evidence: unknown = opts.evidence;
  if (!isPlainObject(evidence)) {
    throw new Error("recordWorkflowDelivery: options.evidence must be an object naming at least one delivery-evidence member");
  }
  const members = Object.keys(evidence);
  if (members.length === 0) {
    throw new Error(
      "recordWorkflowDelivery: options.evidence must name at least one of compound | pr | merge | completion",
    );
  }
  // A member is only ever ADDED or replaced by recording: an object-valued
  // member may not carry an absent value, which would silently erase recorded
  // evidence from a protected document instead of leaving it untouched.
  const nonObject = members.filter((member) => !isPlainObject(evidence[member]));
  if (nonObject.length > 0) {
    throw new Error(
      `refusing to record delivery evidence: member(s) ${nonObject.join(", ")} must be objects \u2014 omit a member to leave it untouched`,
    );
  }
  const shapeViolations = deliveryEvidenceViolations(evidence, "evidence");
  if (shapeViolations.length > 0) {
    throw new Error(`refusing to record invalid delivery evidence: ${shapeViolations.map((v) => v.message).join("; ")}`);
  }
  const at = opts.at ?? new Date().toISOString();
  if (!isCloseTimestamp(at)) {
    throw new Error("recordWorkflowDelivery: options.at must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();
  const ref = { kind: "snapshot" as const, key: workflowId };
  assertFsStorePath(store, ref, snapshotPath);
  mkdirSync(dir, { recursive: true });
  return withStatusWriteLock(snapshotPath, async () => {
    const doc = await store.get(ref);
    if (doc === undefined) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
    const { snapshot } = normalizeWorkflowSnapshot(doc, snapshotPath);
    if (snapshot.id !== workflowId) {
      throw new Error(`workflow snapshot identity mismatch: expected ${workflowId}, got ${snapshot.id}`);
    }
    if (isTerminalSnapshot(snapshot)) {
      throw new Error(
        `refusing to record delivery evidence for workflow ${JSON.stringify(workflowId)}: the lifecycle is terminal (${snapshot.status}) \u2014 delivery evidence is recorded before the close and a closed lifecycle is never amended`,
      );
    }
    assertCoordinatedSnapshotWriter(doc, snapshotPath, opts.sessionPath, "delivery-evidence write");
    const kind = snapshot.delivery_kind;
    if (snapshot.type !== "plan" || (kind !== "development" && kind !== "verification/report-only")) {
      throw new Error(
        `refusing to record delivery evidence for workflow ${JSON.stringify(workflowId)}: only a type: plan lifecycle with a registered delivery_kind carries delivery evidence (got type ${JSON.stringify(snapshot.type)} / delivery_kind ${JSON.stringify(kind)}) \u2014 the kind is declared at registration and never inferred (\u00a71)`,
      );
    }
    const allowed = deliveryEvidenceMembers(kind);
    const unused = members.filter((member) => !allowed.includes(member));
    if (unused.length > 0) {
      throw new Error(
        `refusing to record delivery evidence for workflow ${JSON.stringify(workflowId)}: member(s) ${unused.join(", ")} do not belong to the declared delivery_kind '${kind}' (expected ${allowed.join(" | ")})`,
      );
    }
    const stored = isPlainObject(snapshot.delivery) ? snapshot.delivery : {};
    // A submitted PR is the registered delivery identity and is immutable;
    // report-only completion basis is frozen once a row is Done.
    const doneRows = snapshot.plans.some((row) => row.status === "Done");
    const previousPr = isPlainObject(stored.pr) ? stored.pr : undefined;
    const nextPr = isPlainObject(evidence.pr) ? evidence.pr : undefined;
    const branch = isPlainObject(snapshot.branch) ? snapshot.branch : {};
    if (nextPr !== undefined && isNonEmptyString(branch.source) && nextPr.head !== branch.source) {
      throw new CoordinationError(
        "coordination.invalid-transition",
        `workflow ${workflowId} records delivery.pr.head ${JSON.stringify(nextPr.head)}, but the registered delivery source is ${JSON.stringify(branch.source)}`,
        { workflow_id: workflowId },
      );
    }
    if (nextPr !== undefined && isNonEmptyString(branch.target) && nextPr.target !== branch.target) {
      throw new CoordinationError(
        "coordination.invalid-transition",
        `workflow ${workflowId} records delivery.pr.target ${JSON.stringify(nextPr.target)}, but the registered delivery target is ${JSON.stringify(branch.target)}`,
        { workflow_id: workflowId },
      );
    }
    if (
      previousPr !== undefined &&
      nextPr !== undefined &&
      (previousPr.repo !== nextPr.repo || previousPr.head !== nextPr.head || previousPr.target !== nextPr.target)
    ) {
      throw new CoordinationError(
        "coordination.invalid-transition",
        `workflow ${workflowId} records PR identity ${JSON.stringify(previousPr)} once at submission \u2014 ${JSON.stringify(nextPr)} is a different delivery, not an evidence update`,
        { workflow_id: workflowId },
      );
    }
    const previousCompletion = isPlainObject(stored.completion) ? stored.completion : undefined;
    const nextCompletion = isPlainObject(evidence.completion) ? evidence.completion : undefined;
    const completionAccepted =
      snapshot.delivery_kind === "verification/report-only" &&
      doneRows &&
      nonEmptyString(snapshot.completion_policy) &&
      previousCompletion !== undefined &&
      previousCompletion.policy === snapshot.completion_policy &&
      nonEmptyString(previousCompletion.evidence);
    if (
      completionAccepted &&
      previousCompletion !== undefined &&
      nextCompletion !== undefined &&
      (previousCompletion.policy !== nextCompletion.policy || previousCompletion.evidence !== nextCompletion.evidence)
    ) {
      throw new CoordinationError(
        "coordination.completion-frozen",
        `workflow ${workflowId} has accepted completion evidence against its registered policy/reference; the accepted fulfilment cannot be replaced`,
        { workflow_id: workflowId, completion_policy: snapshot.completion_policy },
      );
    }
    const merged = { ...stored, ...evidence } as WorkflowDeliveryEvidence;
    if (isDeepStrictEqual(snapshot.delivery, merged)) {
      return { snapshot, written: false };
    }
    // Delivery-tail evidence may arrive before Done. Once a row is Done, PR
    // identity and report-only completion basis are immutable; other evidence
    // remains recorded through the same merge operation.
    const next: WorkflowSnapshot = { ...snapshot, delivery: merged, updated_at: at };
    await validateAndPutWorkflowSnapshot(store, next, snapshotPath);
    return { snapshot: next, written: true };
  });
}

// ---------------------------------------------------------------------------
// Delivery-kind declaration (mstar-artifacts/references/plan-workflow-lifecycle-contract.md §1/§4a; seam S3
// population): the authorized ONE-TIME backfill for an ACTIVE `type: plan`
// snapshot whose producer predates the kind - audit promotion and the v1 lift
// minted active snapshots without one, which the close consultation (correctly)
// refuses and no create-only producer can repair.
// ---------------------------------------------------------------------------

export type DeclareWorkflowDeliveryKindOptions = {
  /** The declared kind (contract §1). Required - never inferred. */
  deliveryKind: WorkflowDeliveryKind;
  /** Delivery source branch, recorded as `branch.source`. Required for `development`. */
  branchSource?: string;
  /** Delivery target branch, recorded as `branch.target`. Required for `development`. */
  branchTarget?: string;
  /** Completion policy naming the evidence that completes the workflow. Required for `verification/report-only`. */
  completionPolicy?: string;
  /**
   * Canonical coordinator session envelope path (spec §C4) - the same
   * authority seam `closeWorkflow` and `recordWorkflowDelivery` use: a
   * coordinated snapshot is written only by its own bound coordinator. An
   * uncoordinated snapshot has no coordinator binding to authenticate (the
   * historical audit-promotion / migrate population is exactly that), so it
   * keeps the harness-owner stance the close already applies.
   */
  sessionPath?: string;
  /** Declaration timestamp (YYYY-MM-DD or RFC3339). Default: now. */
  at?: string;
};

/**
 * Declare the delivery kind (and its per-kind registration evidence) of an
 * ACTIVE `type: plan` snapshot whose producer declared none - the one-time
 * upgrade seam for the historical population (contract §1/§4a). ONE-TIME by
 * construction: the kind is registration evidence that is never inferred
 * retroactively (§1), so a second declaration is refused even with the same
 * value, and a terminal snapshot is refused outright (§5 - a closed lifecycle
 * is never amended; the legacy terminal dead end keeps its documented
 * owner-amendment path).
 *
 * The declaration carries the kind's own evidence through the shared
 * `assertDeliveryRegistrationCoherence` rule, so it cannot mint an unclosable
 * lifecycle (a `development` kind needs its delivery anchors, a
 * `verification/report-only` kind its completion policy). A supplied delivery
 * anchor either FILLS the missing one or restates the value the snapshot
 * already registers; a contradicting value is refused, so the declaration can
 * never re-point a lifecycle at another delivery. The write lands in the
 * snapshot lock through the same protected writer as the close.
 */
export async function declareWorkflowDeliveryKind(
  workflowId: string,
  dir: string,
  opts: DeclareWorkflowDeliveryKindOptions,
): Promise<WorkflowSnapshot> {
  // Canonical authority discrimination precedes payload validation (spec §4.3).
  assertExecutionFileWriteAllowed({ harnessDir: dir });
  const kind = opts.deliveryKind;
  if (typeof kind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `declareWorkflowDeliveryKind: deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")} \u2014 got ${JSON.stringify(kind)}`,
    );
  }
  assertDeliveryRegistrationCoherence(kind, opts, "declareWorkflowDeliveryKind");
  const at = opts.at ?? new Date().toISOString();
  if (!isCloseTimestamp(at)) {
    throw new Error("declareWorkflowDeliveryKind: options.at must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();
  const ref = { kind: "snapshot" as const, key: workflowId };
  assertFsStorePath(store, ref, snapshotPath);
  mkdirSync(dir, { recursive: true });
  return withStatusWriteLock(snapshotPath, async () => {
    const doc = await store.get(ref);
    if (doc === undefined) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
    const { snapshot } = normalizeWorkflowSnapshot(doc, snapshotPath);
    if (snapshot.id !== workflowId) {
      throw new Error(`workflow snapshot identity mismatch: expected ${workflowId}, got ${snapshot.id}`);
    }
    if (isTerminalSnapshot(snapshot)) {
      throw new Error(
        `refusing to declare a delivery kind for workflow ${JSON.stringify(workflowId)}: the lifecycle is terminal (${snapshot.status}) \u2014 a closed lifecycle is never amended (\u00a75); a terminal snapshot without a registered kind stays on the documented owner-amendment path`,
      );
    }
    assertCoordinatedSnapshotWriter(doc, snapshotPath, opts.sessionPath, "delivery-kind declaration");
    if (snapshot.type !== "plan") {
      throw new Error(
        `refusing to declare a delivery kind for workflow ${JSON.stringify(workflowId)}: only a type: plan lifecycle declares one (got type ${JSON.stringify(snapshot.type)})`,
      );
    }
    if (snapshot.delivery_kind !== undefined) {
      throw new Error(
        `refusing to declare a delivery kind for workflow ${JSON.stringify(workflowId)}: it already declares ${JSON.stringify(snapshot.delivery_kind)} \u2014 the kind is registration evidence, declared once and never re-inferred (\u00a71)`,
      );
    }
    // Existing anchors are preserved (an iteration-shaped `base`/`integration`
    // on an odd snapshot is never dropped); the validated document guarantees
    // string-valued anchor keys. A supplied anchor either FILLS the missing one
    // or restates the registered value - never replaces it: a kind-less
    // historical snapshot may already carry `branch.source`/`branch.target`,
    // and those anchors are the delivery identity its close is consulted
    // against (§1/§3), so a contradicting declaration must not re-point the
    // delivery at another branch. Restating the same value stays allowed
    // (idempotent); a conflicting value is refused with the field named.
    const branch: Record<string, unknown> = isPlainObject(snapshot.branch) ? { ...snapshot.branch } : {};
    for (const [anchor, supplied] of [
      ["source", opts.branchSource],
      ["target", opts.branchTarget],
    ] as const) {
      if (supplied === undefined) continue;
      const registered = branch[anchor];
      if (registered !== undefined && registered !== supplied) {
        throw new Error(
          `refusing to declare a delivery kind for workflow ${JSON.stringify(workflowId)}: branch.${anchor} is already ` +
            `${JSON.stringify(registered)} \u2014 the supplied ${JSON.stringify(supplied)} conflicts with the anchor the snapshot ` +
            `registers, and the registered delivery anchor is never overwritten (\u00a71)`,
        );
      }
      branch[anchor] = supplied;
    }
    const next: WorkflowSnapshot = { ...snapshot, delivery_kind: kind, updated_at: at };
    if (Object.keys(branch).length > 0) next.branch = branch as WorkflowBranchAnchors;
    if (opts.completionPolicy !== undefined) next.completion_policy = opts.completionPolicy;
    await validateAndPutWorkflowSnapshot(store, next, snapshotPath);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Generic registration producer (mstar-artifacts/references/plan-workflow-lifecycle-contract.md §2/§4a,
// seam S1): create-only `type: plan` snapshot + root `workflows[]` entry
// under one lock, mirroring the audit-promotion primitive sequence
// (`promoteAuditPlans`): snapshot create-only → `registerWorkflowEntryLocked`
// → rollback removes only the exact snapshot version this call created.
// ---------------------------------------------------------------------------

/**
 * The plan registration one SELECTED plan document proves (R1, A02): the
 * identity and title the document itself is the authority for. Reading a
 * document resolves and proves facts; it never enrolls anything - no snapshot,
 * no root entry, no catalog row is written here (R1: "research or merely
 * reading an artifact does not enroll it into execution").
 *
 * - `plan.id`: the document's own `plan_id` - the pointer is resolved through
 *   the ONE registered-plan path contract (§4), so the id, the location and
 *   the declared header must agree before the id is used.
 * - `plan.title`: the document's first level-1 heading - the body is the title
 *   authority, exactly as audit promotion reads it (`audit.ts`
 *   `readPlanFileSummary`). A document with no heading proves no title, so the
 *   plan id is the honest fallback rather than a refusal.
 * - `plan.file`: the canonical absolute pointer the §4 resolver returns, so
 *   the row is addressable by the same contract that later resolves it.
 * - `catalogRelativePath`: the same document stated plans-root-relative, which
 *   is the catalog entity location (`catalog-registration.ts`).
 *
 * EVERY form proves the selected document, the fully explicit one included: the
 * §4 resolver runs for every call, so the pointer, the location and the
 * document's own `plan_id` header must agree before any of these values is
 * used, and `catalogRelativePath` is always the plans-root-relative form of the
 * resolved document - never the caller's pointer spelling (an absolute pointer
 * is not a catalog location and is refused as one). A supplied `id`/`title` is
 * a CONSTRAINT on the proven document, not a replacement for it: an id that
 * names a different registered plan and a title that contradicts the document's
 * heading refuse; an omitted one is derived from the document.
 */
export type DerivedPlanRegistration = Readonly<{
  plan: Readonly<{ id: string; title: string; file: string }>;
  /** The catalog location spelling of the same document (plans-root-relative). */
  catalogRelativePath: string;
  /** The facts this derivation resolved; empty when nothing had to be derived. */
  resolvedFrom: readonly Readonly<{ path: string; source: string }>[];
}>;

export function derivePlanRegistration(input: {
  harnessDir: string;
  plan: { id?: string; title?: string; file: string };
}): DerivedPlanRegistration {
  const file = input.plan.file;
  const declaredId = typeof input.plan.id === "string" && input.plan.id.trim() !== "" ? input.plan.id : undefined;
  const declaredTitle =
    typeof input.plan.title === "string" && input.plan.title.trim() !== "" ? input.plan.title : undefined;
  if (typeof file !== "string" || file.trim() === "") {
    throw new Error(
      "derivePlanRegistration: the selected plan document is required - supply plan.file as the registered plan pointer " +
        "(`{PLAN_DIR}/<id>.md` or its canonical absolute path)",
    );
  }
  const harnessRoot = resolve(input.harnessDir);
  // The plan id a pointer names is its file name without the `.md`; a supplied
  // `id` is the CONSTRAINT instead - the §4 resolver below then proves that id,
  // that location and the document's own `plan_id` header are the same
  // registration identity, for the explicit form exactly as for the sparse one.
  const planId = declaredId ?? basename(file).replace(/\.md$/, "");
  const resolved = resolveRegisteredPlanFile({ harnessRoot, planId, file });
  // The body is the title authority (the first level-1 heading); a document
  // that declares no heading proves no title, so the plan id is the honest
  // fallback rather than a refusal.
  const heading = /^# (.+)$/m.exec(readFileSync(resolved.planPath, "utf8"))?.[1]?.trim();
  const documentTitle = heading === undefined || heading === "" ? undefined : heading;
  // A supplied title is a constraint against the document, never a replacement
  // for it: a title that contradicts the heading the selected document states
  // refuses. A document with no heading states no title to contradict, so there
  // the declaration stands (the same reason it is not refused when derived).
  if (declaredTitle !== undefined && documentTitle !== undefined && declaredTitle.trim() !== documentTitle) {
    throw Object.assign(new Error(`derivePlanRegistration: plan ${JSON.stringify(planId)} was declared with title ${JSON.stringify(declaredTitle)}, but the ` + `selected document ${resolved.planPath} states ${JSON.stringify(documentTitle)} - the selected plan document is the ` + "registration authority (R1/section 4), so a supplied title is a constraint against it, never an override"), { code: "workflow.register.title-constraint" });
  }
  const title = documentTitle ?? declaredTitle ?? planId;
  // The catalog entity location is plans-root-relative while the row keeps the
  // §4 canonical pointer: one document, two declared location forms. The
  // relative form is derived from the RESOLVED document for every input form -
  // the caller's pointer spelling (which may be absolute) is never a catalog
  // location.
  const catalogRelativePath = relative(canonicalizeNearestExisting(resolvePlanDir(harnessRoot)), resolved.planPath)
    .split(sep)
    .join("/");
  return {
    plan: { id: planId, title, file: resolved.planPath },
    catalogRelativePath,
    resolvedFrom: [
      {
        path: "plan.file",
        source: `registered plan document ${resolved.planPath} (declared plan_id ${resolved.declaredPlanId})`,
      },
      ...(declaredId === undefined ? [{ path: "plan.id", source: `registered plan document ${resolved.planPath}` }] : []),
      ...(declaredTitle === undefined
        ? [{ path: "plan.title", source: `plan document body of ${resolved.planPath}` }]
        : []),
    ],
  };
}

/** Options for `registerPlanWorkflow`. `harnessDir` is required - the
 * snapshot and `status.json` live under the harness root. */
export type RegisterPlanWorkflowOptions = {
  /** Absolute harness dir that contains `status.json` + `workflows/`. Required. */
  harnessDir: string;
  /**
   * The owned plan (contract §2: one independently owned plan per workflow on
   * the new normal route). `file` is the selected plan document - the §4
   * registered-plan pointer, the one authority every form proves; `id` and
   * `title` are DERIVED from it when omitted (R1), and a supplied value is a
   * CONSTRAINT on the proven document (an id or title the document does not
   * state refuses) rather than a replacement for reading it.
   */
  plan: { file: string; id?: string; title?: string };
  /** Delivery kind declared at registration (contract §1). Required - never inferred. */
  deliveryKind: WorkflowDeliveryKind;
  /** Project register id recorded on the snapshot (contract §3 register row). */
  project?: string;
  /** Source branch of the delivery, recorded as `branch.source`. Required together with `branchTarget` for `development`. */
  branchSource?: string;
  /** Target branch. Required together with `branchSource` for `development`. */
  branchTarget?: string;
  /**
   * Completion policy for `verification/report-only` workflows (contract §1):
   * names the evidence that completes the workflow. Required for that kind.
   */
  completionPolicy?: string;
  /**
   * Pre-existing coordinator binding recorded at registration. Optional -
   * binding a NEW coordinator session stays on the authorized `bind` seam
   * (`coordination.ts`); this only records an already-held binding.
   */
  coordinator?: { session_id: string; session_file: string };
  /** Registration timestamp (YYYY-MM-DD or RFC3339). Default: now. */
  startedAt?: string;
};

export type RegisterPlanWorkflowResult = {
  workflowId: string;
  snapshotPath: string;
  /**
   * True when this call completed a registration whose snapshot already
   * existed (crash between snapshot creation and root registration): the
   * existing snapshot bytes - identity, timestamps, ownership - were kept
   * and only the root entry was written (contract §4b recovery).
   */
  recovered: boolean;
};

/**
 * Compare two snapshots' REGISTRATION IDENTITY by NAMED PRIMITIVE FIELD, never
 * by any serialized form. The identity is the header fields a registration
 * freezes — `id`, `type`, `delivery_kind`, `project`, `completion_policy`,
 * `compass_ref`, the branch anchors `branch.base`/`source`/`integration`/
 * `target`, and the coordinator binding's `session_id`/`session_file` — plus the
 * addressed plan rows as a KEYED collection: each row's declared `id` is the
 * key and its `file` the direct path value. Rows are matched by key, not by
 * enumeration position (no consumer authorizes by row order; rows are located
 * by id), and `title`/`status`/any prose or progress field is outside the
 * identity — a progressed or reordered orphan still recovers.
 *
 * Used by the create-only producers' crash/retry recovery: re-running the
 * producer must not duplicate identity, so a mismatch refuses instead of
 * adopting a foreign registration.
 */
function registrationIdentityMatches(existing: WorkflowSnapshot, candidate: WorkflowSnapshot): boolean {
  const branchField = (snapshot: WorkflowSnapshot, key: "base" | "source" | "integration" | "target"): unknown => {
    const branch = snapshot.branch;
    return isPlainObject(branch) ? branch[key] ?? null : null;
  };
  const coordinatorField = (snapshot: WorkflowSnapshot, key: "session_id" | "session_file"): unknown =>
    snapshot.coordination?.coordinator?.[key] ?? null;
  const rowFileById = (snapshot: WorkflowSnapshot): Map<string, unknown> | null => {
    const rows = snapshot.plans ?? [];
    const map = new Map<string, unknown>();
    for (const row of rows) {
      const id = rowPlanIds(row)[0];
      if (id === undefined || map.has(id)) return null; // a row with no/duplicate id is not a valid registration
      map.set(id, row.file ?? null);
    }
    return map;
  };

  if (
    (existing.id ?? null) !== (candidate.id ?? null) ||
    (existing.type ?? null) !== (candidate.type ?? null) ||
    (existing.delivery_kind ?? null) !== (candidate.delivery_kind ?? null) ||
    (existing.project ?? null) !== (candidate.project ?? null) ||
    (existing.completion_policy ?? null) !== (candidate.completion_policy ?? null) ||
    (existing.compass_ref ?? null) !== (candidate.compass_ref ?? null)
  ) {
    return false;
  }
  for (const anchor of ["base", "source", "integration", "target"] as const) {
    if (branchField(existing, anchor) !== branchField(candidate, anchor)) return false;
  }
  for (const member of ["session_id", "session_file"] as const) {
    if (coordinatorField(existing, member) !== coordinatorField(candidate, member)) return false;
  }
  const left = rowFileById(existing);
  const right = rowFileById(candidate);
  if (left === null || right === null || left.size !== right.size) return false;
  for (const [id, file] of left) {
    if (!right.has(id) || right.get(id) !== file) return false;
  }
  return true;
}

/**
 * The create-only `type: plan` snapshot `registerPlanWorkflow` writes: the
 * owned plan as its single `Todo` row, plus the declared delivery fields.
 * Extracted so the catalog registration journal
 * (`catalog-registration.ts`) recomputes the SAME registration identity for
 * the reviewed request before it publishes a catalog delta - one snapshot
 * definition, no second "which registration is this" source. Timestamps are
 * outside the compared identity, so the clock a caller passes never affects
 * the comparison.
 *
 * The row is derived from the selected plan document (`derivePlanRegistration`,
 * R1): an omitted `id`/`title` is resolved from the document here and a
 * supplied one is proven against it, so the direct producer and the catalog
 * journal derive the identical row from the identical inputs rather than each
 * copying the caller's fields.
 */
export function planWorkflowSnapshot(
  workflowId: string,
  options: RegisterPlanWorkflowOptions,
  startedAt: string,
): WorkflowSnapshot {
  // The row stores the RESOLVED canonical pointer: the caller's spelling is the
  // INPUT the §4 resolver proves and reads, never the persisted value. One
  // canonical form per registered plan is the E07 route-parity contract — the
  // file producer and the DB route must seal the SAME value, so a relative
  // spelling cannot survive into the row.
  const derived = derivePlanRegistration({ harnessDir: options.harnessDir, plan: options.plan }).plan;
  const planRow: PlanRow = { id: options.plan.id ?? derived.id, title: options.plan.title ?? derived.title, file: derived.file, status: "Todo" };
  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: startedAt,
    updated_at: startedAt.slice(0, 10),
    plans: [planRow],
    delivery_kind: options.deliveryKind,
  };
  if (options.project !== undefined) snapshot.project = options.project;
  if (options.completionPolicy !== undefined) snapshot.completion_policy = options.completionPolicy;
  if (options.branchSource !== undefined || options.branchTarget !== undefined) {
    // `branchSource` is the plan's DELIVERY branch (`branch.source`) - never
    // `branch.base`, whose consumers (cleanup Rule 2 protected refs, L1
    // main-residency fallback) treat it as a protected base anchor: writing a
    // feature branch there made the ref undeletable and pointed L1's
    // residency expectation at the feature branch.
    snapshot.branch = {
      ...(options.branchSource !== undefined ? { source: options.branchSource } : {}),
      ...(options.branchTarget !== undefined ? { target: options.branchTarget } : {}),
    };
  }
  if (options.coordinator !== undefined) {
    snapshot.coordination = {
      coordinator: { session_id: options.coordinator.session_id, session_file: options.coordinator.session_file, bound_at: startedAt },
    };
  }
  return snapshot;
}

/**
 * Register a standalone plan workflow (seam S1 - the generic normal-entry
 * producer). Builds the create-only `type: plan` snapshot (workflow id, the
 * owned plan as its single Todo row, project, delivery kind, source/target
 * branches, optional coordinator) and the root `workflows[]` entry, then
 * writes BOTH under one atomic section of the root `withStatusWriteLock`
 * - the same serialization point `registerWorkflow` uses - mirroring
 * `promoteAuditPlans`'s primitive sequence: create-only
 * `writeWorkflowSnapshot` (its snapshot-dir lock nests inside the root lock,
 * root → snapshot is the documented acquisition order) →
 * `registerWorkflowEntryLocked`, with rollback that removes ONLY the exact
 * snapshot version this call created (plus the now-empty workflow dir), so a
 * failed register write is never treated as partial activation success.
 *
 * Refusals (fail-loud, no partial activation):
 * - existing id: the workflow is already registered (snapshot + root entry) -
 *   registration is create-only, never a re-registration;
 * - unreadable root: a malformed/v1 `status.json` refuses (the created
 *   snapshot is rolled back first);
 * - missing required fields: id/plan/delivery-kind shape per the existing
 *   snapshot validators; `development` additionally requires source+target
 *   branches (contract §1 - a development workflow with missing branch
 *   fields is incomplete registration, not an exempt workflow) and
 *   `verification/report-only` requires the completion policy.
 *
 * Crash/retry recovery (contract §4b): a crash between snapshot creation and
 * root registration leaves the snapshot orphaned (no root entry = no
 * activation). Re-running this producer with the same registration identity
 * completes the registration against the EXISTING snapshot bytes - identity,
 * timestamps and ownership are preserved, never rewritten. An existing
 * snapshot with a DIFFERENT registration identity refuses (it belongs to
 * another registration).
 *
 * The caller must pin the artifact store to the harness root first
 * (`setArtifactStore(createFsStore(harnessDir))`) when the active store's
 * root could differ - the routed writers fail loud on a path mismatch.
 */
export async function registerPlanWorkflow(
  workflowId: string,
  options: RegisterPlanWorkflowOptions,
): Promise<RegisterPlanWorkflowResult> {
  if (typeof options.harnessDir !== "string" || options.harnessDir.trim() === "") {
    throw new Error("registerPlanWorkflow: options.harnessDir is required (must contain status.json + workflows/)");
  }
  // Canonical authority discrimination precedes every other check (spec §4.3):
  // the registration writes a snapshot AND a root entry, so with an ACTIVE
  // execution authority it refuses whatever store is active.
  const harnessDir = resolve(options.harnessDir);
  assertExecutionFileWriteAllowed({ harnessDir });
  assertSafePathComponent(workflowId, "workflow id");
  const { plan, deliveryKind } = options;
  if (!isPlainObject(plan)) {
    throw new Error("registerPlanWorkflow: options.plan is required (the selected plan document: {PLAN_DIR}/<id>.md)");
  }
  if (typeof plan.file !== "string" || plan.file.trim() === "") {
    throw new Error(
      "registerPlanWorkflow: options.plan.file is required (the selected plan document - an omitted id/title is derived from it)",
    );
  }
  // `id`/`title` are OPTIONAL intent inputs: an omitted one is derived from
  // the selected document by `planWorkflowSnapshot` (R1), and a supplied one is
  // a CONSTRAINT the derivation proves against that document (a value the
  // document does not state refuses; it never replaces reading it). A supplied
  // value is still validated here too - an empty declaration is malformed
  // input, not an omission.
  for (const field of ["id", "title"] as const) {
    const value = plan[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`registerPlanWorkflow: options.plan.${field} must be a non-empty string when given`);
    }
  }
  if (typeof deliveryKind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(deliveryKind)) {
    throw new Error(
      `registerPlanWorkflow: options.deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")} \u2014 got ${JSON.stringify(deliveryKind)}`,
    );
  }
  // Contract §1: missing branch fields never select or waive a kind - the
  // shared per-kind coherence rule (the same one audit promotion, migrate and
  // the one-time kind declaration enforce).
  assertDeliveryRegistrationCoherence(deliveryKind, options, "registerPlanWorkflow");
  for (const field of ["project", "branchSource", "branchTarget"] as const) {
    const value = options[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new Error(`registerPlanWorkflow: options.${field} must be a non-empty string when given`);
    }
  }
  if (options.coordinator !== undefined) {
    const { coordinator } = options;
    if (typeof coordinator.session_id !== "string" || coordinator.session_id.trim() === "") {
      throw new Error("registerPlanWorkflow: options.coordinator.session_id must be a non-empty string");
    }
    if (typeof coordinator.session_file !== "string" || !isAbsolute(coordinator.session_file)) {
      throw new Error("registerPlanWorkflow: options.coordinator.session_file must be an absolute path");
    }
  }
  const startedAt = options.startedAt ?? new Date().toISOString();
  if (!isCloseTimestamp(startedAt)) {
    throw new Error("registerPlanWorkflow: options.startedAt must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  }

  const statusPath = join(harnessDir, "status.json");
  const workflowDir = join(harnessDir, "workflows", workflowId);
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();

  const snapshot = planWorkflowSnapshot(workflowId, options, startedAt);
  const entry: WorkflowEntry = {
    id: workflowId,
    type: "plan",
    started_at: snapshot.started_at,
    dir: `workflows/${workflowId}`,
  };
  const entryGate = validateWorkflowEntry(entry);
  if (!entryGate.ok) {
    throw new Error(
      `refusing to register invalid workflow entry: ${entryGate.violations.map((v) => v.message).join("; ")}`,
    );
  }

  return withStatusWriteLock(statusPath, async (): Promise<RegisterPlanWorkflowResult> => {
    if (existsSync(snapshotPath)) {
      const rootDoc = readJson(statusPath);
      const workflows = Array.isArray(rootDoc.workflows) ? rootDoc.workflows : [];
      if (workflows.some((candidate) => isPlainObject(candidate) && candidate.id === workflowId)) {
        throw new Error(
          `refusing to register workflow ${JSON.stringify(workflowId)}: it is already registered ` +
            `(snapshot at ${snapshotPath}, root entry in ${statusPath}) \u2014 registration is create-only; ` +
            `remove that workflow before registering again`,
        );
      }
      // Crash/retry recovery (contract §4b): the snapshot exists but the root
      // has no entry - no activation happened. Complete the registration
      // against the EXISTING snapshot bytes; an identity mismatch refuses
      // instead of adopting a foreign registration.
      const existing = readWorkflowSnapshot(workflowDir);
      if (!registrationIdentityMatches(existing.snapshot, snapshot)) {
        throw new Error(
          `refusing to register workflow ${JSON.stringify(workflowId)}: snapshot ${snapshotPath} already exists ` +
            `with a different registration identity \u2014 remove that workflow or register under a different id`,
        );
      }
      const recoveryEntry: WorkflowEntry = {
        id: workflowId,
        type: "plan",
        started_at: existing.snapshot.started_at,
        dir: `workflows/${workflowId}`,
      };
      const recoveryGate = validateWorkflowEntry(recoveryEntry);
      if (!recoveryGate.ok) {
        throw new Error(
          `refusing to register invalid workflow entry: ${recoveryGate.violations.map((v) => v.message).join("; ")}`,
        );
      }
      await registerWorkflowEntryLocked(statusPath, recoveryEntry);
      return { workflowId, snapshotPath, recovered: true };
    }
    let createdVersion: string | undefined;
    try {
      // Create-only (`absent`) under the root lock: the snapshot is written
      // through the routed writer, which validates it and refuses to replace
      // an existing document (spec §C4). The snapshot's own lock nests inside
      // the root lock - root → snapshot is the documented acquisition order.
      await writeWorkflowSnapshot(snapshot, workflowDir, { createOnly: true });
      createdVersion = readArtifactBytes(snapshotPath)?.version;
      await registerWorkflowEntryLocked(statusPath, entry);
    } catch (error) {
      // Roll back ONLY the exact snapshot version this call created, under
      // the snapshot lock: a snapshot another writer changed in the meantime
      // is never deleted.
      if (createdVersion !== undefined) {
        await withStatusWriteLock(snapshotPath, async () => {
          const current = readArtifactBytes(snapshotPath);
          if (current === undefined || current.version !== createdVersion) return;
          const remove = store.delete?.bind(store);
          if (remove !== undefined) {
            await withProtectedWrite(snapshotPath, "delete", () => remove({ kind: "snapshot", key: workflowId }));
          }
        });
      }
      try {
        // Remove the workflow dir only when empty - a concurrent writer's
        // snapshot/rows are never destroyed; rmdirSync throws ENOTEMPTY if
        // content appeared between the readdir and the removal.
        if (readdirSync(workflowDir).length === 0) {
          rmdirSync(workflowDir);
        }
      } catch {
        // Dir non-empty or already gone - leave it; never force-remove.
      }
      throw error;
    }
    return { workflowId, snapshotPath, recovered: false };
  });
}

/** Options for `registerIterationWorkflow`. `harnessDir` is required - the
 * snapshot and `status.json` live under the harness root. */
export type RegisterIterationWorkflowOptions = {
  /** Absolute harness dir that contains `status.json` + `workflows/`. Required. */
  harnessDir: string;
  /** Harness-relative compass ref recorded on the snapshot, e.g. `iterations/<id>/delivery-compass.md`. Required. */
  compassRef: string;
  /** The three iteration branch anchors. All three required. */
  branch: { base: string; integration: string; target: string };
  /** Initial plan rows. At least one. Every row is written `status: "Todo"`. */
  rows: Array<{ id: string; title: string; file: string }>;
  /** Project register id recorded on the snapshot. */
  project?: string;
  /** Registration timestamp (YYYY-MM-DD or RFC3339). Default: now. */
  startedAt?: string;
};

export type RegisterIterationWorkflowResult = {
  workflowId: string;
  snapshotPath: string;
  /**
   * True on orphan recovery: existing snapshot bytes/timestamps are preserved
   * and only the missing root entry is written.
   */
  recovered: boolean;
};

/**
 * The iteration producer's registration identity is compared through the same
 * explicit-field rule as the plan producer (`registrationIdentityMatches`):
 * the header identity fields plus the ordered plan rows. `id` is part of that
 * comparison, so comparing only the path is insufficient, and an already-bound
 * orphan (a candidate never carries a coordinator) refuses rather than silently
 * attaching another owner's workflow. Timestamps stay outside the identity.
 */

/**
 * Normalize the registration input's `compassRef` to the stored contract
 * form: a harness-relative pointer. An absolute path that resolves inside
 * the harness root names the identical reviewed document and is rewritten to
 * its relative POSIX form; anything that would resolve outside the root
 * refuses with the accepted form spelled out. The relative form is kept
 * verbatim (resolved against the root and range-checked, never rewritten).
 *
 * Containment is decided on `canonicalizeNearestExisting` of both sides, so
 * an in-root symlink whose target lies outside the harness is refused here -
 * the same canonical read `readPrepareCompass` performs later - rather than
 * being stored and failing at amendment time.
 */
export function normalizeIterationCompassRef(
  ref: string,
  harnessRoot: string,
  refuse: (detail: string) => Error,
): string {
  const rootCanon = canonicalizeNearestExisting(harnessRoot);
  const prefix = rootCanon.endsWith("/") ? rootCanon : `${rootCanon}/`;
  const contained = (candidate: string): boolean => {
    const canon = canonicalizeNearestExisting(candidate);
    return canon === rootCanon || canon.startsWith(prefix);
  };
  if (isAbsolute(ref)) {
    // Canonical-vs-canonical containment and storage (#301 issue 3 / #304
    // issue 2 remedy): the symlink spelling of either side must not leak into
    // the stored pointer. An EXTERNAL symlink reaching an in-root document
    // stores the canonical in-root relative form; a harness root reached
    // through its own symlink spelling stores the same relative form.
    const canon = canonicalizeNearestExisting(resolve(ref));
    if (canon !== rootCanon && !canon.startsWith(prefix)) {
      throw refuse(
        `options.compassRef resolves outside the harness root - the reviewed compass_ref must address a ` +
          `document inside ${harnessRoot}; store the harness-relative pointer of that compass instead`,
      );
    }
    return relative(rootCanon, canon).split(sep).join("/");
  }
  if (!contained(resolve(harnessRoot, ref))) {
    throw refuse(
      `options.compassRef escapes the harness root - the reviewed compass_ref must address a document inside ` +
        `${harnessRoot}; store the harness-relative pointer of that compass instead`,
    );
  }
  return ref;
}

/**
 * The create-only `type: iteration` snapshot `registerIterationWorkflow`
 * writes: compass ref, the three branch anchors and one `Todo` row per
 * declared plan. Extracted for the same reason as
 * `planWorkflowSnapshot` - the catalog registration journal re-verifies this
 * exact registration identity before it publishes the catalog delta.
 */
export function iterationWorkflowSnapshot(
  workflowId: string,
  options: RegisterIterationWorkflowOptions,
  startedAt: string,
): WorkflowSnapshot {
  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: workflowId,
    type: "iteration",
    status: "running",
    // A freshly registered iteration is factually in Prepare - every row is
    // Todo and registration never authorizes execution (#293 producer fix:
    // the consumer's admission demanded this label the producer never wrote).
    phase: PREPARE_PHASE,
    started_at: startedAt,
    updated_at: startedAt.slice(0, 10),
    compass_ref: options.compassRef,
    branch: { base: options.branch.base, integration: options.branch.integration, target: options.branch.target },
    // Each row stores the RESOLVED canonical pointer (E07 parity with the plan
    // producer): the reviewed spelling is input, and the resolver proves and
    // reads the document it names before anything is written. Only the POINTER is
    // resolved here — the iteration row's id and title are the reviewed
    // declarations, which `derivePlanRegistration` would additionally constrain
    // against the document body (the plan producer's R1 rule, not this route's).
    plans: options.rows.map((r) => ({
      id: r.id,
      title: r.title,
      file: resolveRegisteredPlanFile({ harnessRoot: resolve(options.harnessDir), planId: r.id, file: r.file }).planPath,
      status: "Todo",
      metadata: {
        iteration_refs: [options.compassRef],
        spec_integration_branch: options.branch.integration,
        merge_target: options.branch.integration,
      },
    })),
  };
  if (options.project !== undefined) snapshot.project = options.project;
  return snapshot;
}

/**
 * Register an iteration workflow (seam S1 sibling of `registerPlanWorkflow`).
 * Builds the create-only `type: iteration` snapshot (workflow id, compass
 * ref, the three branch anchors, Todo rows whose `metadata` -
 * `iteration_refs`, `spec_integration_branch`, `merge_target` - is derived
 * from the already-required compass/integration inputs; registration never
 * authorizes implementation) and the root `workflows[]` entry, then writes
 * BOTH under one atomic section of the root `withStatusWriteLock` - the same
 * create-only `writeWorkflowSnapshot(..., { createOnly: true })` →
 * `registerWorkflowEntryLocked` primitive sequence the plan producer uses -
 * with rollback that removes ONLY the exact snapshot version this call
 * created (plus the now-empty workflow dir; a non-empty directory is never
 * force-removed).
 *
 * Refusals (fail-loud, before any write): non-empty `workflowId`
 * (`assertSafePathComponent`), `harnessDir`, `compassRef`, all three branch
 * anchors, `project` when given, and each row's `id`/`title`/`file`;
 * non-empty row array; duplicate row ids; a SUPPLIED row `status` (a
 * requested state transition is never treated as successful registration);
 * `startedAt` must be a valid YYYY-MM-DD / RFC3339 timestamp. Rows are
 * constructed from the declared fields - untrusted row objects are never
 * spread. Every row `file` is resolved through the one registered-plan path
 * contract (§4): only a canonical absolute or a normalized harness-relative
 * pointer to the configured `{PLAN_DIR}/<id>.md` is accepted, and the snapshot
 * persists that canonical absolute path.
 *
 * Already-registered refusals: inside the root lock, an existing entry for
 * the requested id refuses BEFORE either branch - including a stale entry
 * whose snapshot is missing. This producer is not the low-level upsert and
 * does not repair/repoint an existing identity. Malformed/v1 roots refuse
 * without replacing their bytes.
 *
 * Crash/retry recovery: a snapshot without its root entry (an orphan)
 * re-registers only when its registration identity matches (`registrationIdentityMatches`) -
 * the existing snapshot's bytes and timestamps are preserved verbatim and
 * the root entry is written with the orphan's `started_at` (`recovered:
 * true`). A differing identity (including a mismatched snapshot id or an
 * existing coordinator binding) refuses; a failed recovery root write never
 * deletes the orphan.
 *
 * The caller must pin the artifact store to the harness root first
 * (`setArtifactStore(createFsStore(harnessDir))`) when the active store's
 * root could differ - the routed writers fail loud on a path mismatch.
 */
export async function registerIterationWorkflow(
  workflowId: string,
  options: RegisterIterationWorkflowOptions,
): Promise<RegisterIterationWorkflowResult> {
  const refuse = (detail: string): Error =>
    new Error(`registerIterationWorkflow: ${detail}`);
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw refuse("options must be an object (harnessDir, compassRef, branch, rows)");
  }
  if (typeof options.harnessDir !== "string" || options.harnessDir.trim() === "") {
    throw refuse("options.harnessDir is required (must contain status.json + workflows/)");
  }
  // Canonical authority discrimination precedes every other check (spec §4.3).
  const harnessDir = resolve(options.harnessDir);
  assertExecutionFileWriteAllowed({ harnessDir });
  assertSafePathComponent(workflowId, "workflow id");
  if (typeof options.compassRef !== "string" || options.compassRef.trim() === "") {
    throw refuse("options.compassRef must be a non-empty string");
  }
  // The Prepare amendment's reader (`readPrepareCompass`) consumes a
  // harness-relative pointer; an absolute spelling of the same in-root
  // document is the identical reviewed compass, so it is normalized here -
  // the stored form is always the relative contract form and a registered
  // snapshot is amendable by construction (I-000243 disposition (a)). A
  // pointer that cannot name a document inside this harness root is refused
  // before any write, with the accepted form in the diagnostic.
  const compassRef = normalizeIterationCompassRef(options.compassRef, harnessDir, refuse);
  if (typeof options.branch !== "object" || options.branch === null || Array.isArray(options.branch)) {
    throw refuse("options.branch must be an object (base, integration, target)");
  }
  for (const anchor of ["base", "integration", "target"] as const) {
    const value = options.branch[anchor];
    if (typeof value !== "string" || value.trim() === "") {
      throw refuse(`options.branch.${anchor} must be a non-empty string`);
    }
  }
  if (options.project !== undefined && (typeof options.project !== "string" || options.project.trim() === "")) {
    throw refuse("options.project must be a non-empty string when given");
  }
  const rows = options.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw refuse("options.rows must be a non-empty array of { id, title, file }");
  }
  const seenRowIds = new Set<string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw refuse("each row must be an object ({ id, title, file })");
    }
    for (const field of ["id", "title", "file"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        throw refuse(`each row.${field} must be a non-empty string`);
      }
    }
    if ("status" in row) {
      throw refuse(
        `row ${JSON.stringify(row.id)} supplies a status \u2014 rows are always written status "Todo"; ` +
          "a state transition is requested through the lifecycle seams, never at registration",
      );
    }
    if (seenRowIds.has(row.id)) {
      throw refuse(`duplicate row id ${JSON.stringify(row.id)} \u2014 plan row ids are unique per workflow`);
    }
    seenRowIds.add(row.id);
  }
  const startedAt = options.startedAt ?? new Date().toISOString();
  if (!isCloseTimestamp(startedAt)) {
    throw refuse("options.startedAt must be a valid YYYY-MM-DD date or RFC3339 timestamp");
  }
  // One registered-plan path contract (prerequisite contract §4): the resolver
  // validates the pointer BEFORE any write (a repository-relative
  // `.mstar/plans/<id>.md` input or an escape refuses here), and the snapshot
  // row keeps the caller's DECLARED spelling — the same rule the plan-type
  // snapshot follows. The validation is the boundary, not a re-spelling: a
  // stored pointer is only ever re-resolved against the same harness root.
  const resolvedRows = rows.map((row) => {
    resolveRegisteredPlanFile({ harnessRoot: harnessDir, planId: row.id, file: row.file });
    return { id: row.id, title: row.title, file: row.file };
  });

  const statusPath = join(harnessDir, "status.json");
  const workflowDir = join(harnessDir, "workflows", workflowId);
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();

  const snapshot = iterationWorkflowSnapshot(workflowId, { ...options, compassRef, rows: resolvedRows }, startedAt);

  const entry: WorkflowEntry = {
    id: workflowId,
    type: "iteration",
    started_at: snapshot.started_at,
    dir: `workflows/${workflowId}`,
  };
  const entryGate = validateWorkflowEntry(entry);
  if (!entryGate.ok) {
    throw new Error(
      `refusing to register invalid workflow entry: ${entryGate.violations.map((v) => v.message).join("; ")}`,
    );
  }

  return withStatusWriteLock(statusPath, async (): Promise<RegisterIterationWorkflowResult> => {
    // Already-registered refusal BEFORE both branches - including a stale
    // entry whose snapshot is missing: an existing identity is never
    // repaired, re-pointed or duplicated.
    const rootDoc = readJson(statusPath);
    const workflows = Array.isArray(rootDoc.workflows) ? rootDoc.workflows : [];
    if (workflows.some((candidate) => isPlainObject(candidate) && candidate.id === workflowId)) {
      throw new Error(
        `refusing to register workflow ${JSON.stringify(workflowId)}: it is already registered ` +
          `(root entry in ${statusPath}) \u2014 registration is create-only; ` +
          "remove that workflow before registering again",
      );
    }
    if (existsSync(snapshotPath)) {
      // Crash/retry recovery: the snapshot exists but the root has no entry -
      // no activation happened. Complete the registration against the
      // EXISTING snapshot bytes; an identity mismatch refuses instead of
      // adopting a foreign registration.
      const existing = readWorkflowSnapshot(workflowDir);
      // The stored spelling of a compass pointer may predate normalization
      // (pre-normalization absolute form) or differ by symlink spelling;
      // both name the same reviewed document. Project both sides to the
      // canonical relative form before the identity comparison so a spelling
      // delta recovers the orphan instead of refusing, while a genuinely
      // different document still mismatches. A ref that cannot be normalized
      // keeps its raw spelling on both sides and compares verbatim.
      const identityProjection = (candidate: WorkflowSnapshot): WorkflowSnapshot => {
        if (!isNonEmptyString(candidate.compass_ref)) return candidate;
        let normalized: string;
        try {
          normalized = normalizeIterationCompassRef(candidate.compass_ref, harnessDir, (detail) => new Error(detail));
        } catch {
          return candidate;
        }
        return {
          ...candidate,
          compass_ref: normalized,
          plans: candidate.plans.map((row) => {
            const metadata = row.metadata as Record<string, unknown> | undefined;
            const refs = metadata?.iteration_refs;
            if (!Array.isArray(refs) || !refs.includes(candidate.compass_ref)) return row;
            return {
              ...row,
              metadata: {
                ...metadata,
                iteration_refs: refs.map((entry) => (entry === candidate.compass_ref ? normalized : entry)),
              },
            };
          }),
        };
      };
      if (
        existing.snapshot.id !== workflowId ||
        !registrationIdentityMatches(identityProjection(existing.snapshot), identityProjection(snapshot))
      ) {
        throw new Error(
          `refusing to register workflow ${JSON.stringify(workflowId)}: snapshot ${snapshotPath} already exists ` +
            "with a different registration identity \u2014 remove that workflow or register under a different id",
        );
      }
      const recoveryEntry: WorkflowEntry = {
        id: workflowId,
        type: "iteration",
        started_at: existing.snapshot.started_at,
        dir: `workflows/${workflowId}`,
      };
      const recoveryGate = validateWorkflowEntry(recoveryEntry);
      if (!recoveryGate.ok) {
        throw new Error(
          `refusing to register invalid workflow entry: ${recoveryGate.violations.map((v) => v.message).join("; ")}`,
        );
      }
      await registerWorkflowEntryLocked(statusPath, recoveryEntry);
      return { workflowId, snapshotPath, recovered: true };
    }
    let createdVersion: string | undefined;
    try {
      // Create-only (`absent`) under the root lock: the snapshot is written
      // through the routed writer, which validates it and refuses to replace
      // an existing document (spec §C4). The snapshot's own lock nests inside
      // the root lock - root → snapshot is the documented acquisition order.
      await writeWorkflowSnapshot(snapshot, workflowDir, { createOnly: true });
      createdVersion = readArtifactBytes(snapshotPath)?.version;
      await registerWorkflowEntryLocked(statusPath, entry);
    } catch (error) {
      // Roll back ONLY the exact snapshot version this call created, under
      // the snapshot lock: a snapshot another writer changed in the meantime
      // is never deleted.
      if (createdVersion !== undefined) {
        await withStatusWriteLock(snapshotPath, async () => {
          const current = readArtifactBytes(snapshotPath);
          if (current === undefined || current.version !== createdVersion) return;
          const remove = store.delete?.bind(store);
          if (remove !== undefined) {
            await withProtectedWrite(snapshotPath, "delete", () => remove({ kind: "snapshot", key: workflowId }));
          }
        });
      }
      try {
        // Remove the workflow dir only when empty - a concurrent writer's
        // snapshot/rows are never destroyed; rmdirSync throws ENOTEMPTY if
        // content appeared between the readdir and the removal.
        if (readdirSync(workflowDir).length === 0) {
          rmdirSync(workflowDir);
        }
      } catch {
        // Dir non-empty or already gone - leave it; never force-remove.
      }
      throw error;
    }
    return { workflowId, snapshotPath, recovered: false };
  });
}
