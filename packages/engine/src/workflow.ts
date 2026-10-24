/**
 * Engine workflow module - v3 workflow snapshot schema
 * (`workflows/<id>/snapshot.json`), lifecycle status enum, validator, and the
 * integration merge mutex shape. The former whole-rewrite file writer is
 * deleted with the file execution route: these documents are read-only
 * migration sources / retained history.
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
 * - Mutex shape: `validateIntegrationMergeLease` (this module).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJson, type GateResult, type Severity, type ValidationResult } from "./core.js";
import {
  isPlainObject,
  validateRowCoordination,
  validateSnapshotCoordination,
  type RowValidationRoute,
  type SnapshotCoordination,
} from "./coordination-write.js";
import { canonicalizeNearestExisting, resolvePlanDir } from "./path.js";
import { canonicalRegisteredPlanPath, resolveRegisteredPlanFile } from "./plan-path.js";
import { validatePlanRow, validateWorkflowEntry, type PlanRow, type WorkflowEntry } from "./status.js";

/** Snapshot file name inside the legacy `workflows/<id>/` document. */
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
 * §4c/§4d/§4f, seam S3). Each member is recorded by its owner through the
 * ACTIVE execution evidence seam at its stage, and the close consultation reads
 * the block for the DECLARED delivery kind - never inferring one from whichever
 * members happen to be present (§1):
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

/**
 * The branch anchors of one lifecycle (`type: plan` and `type: iteration`).
 *
 * A plan workflow records `base` / `work` / `target` (the branch it was created
 * from, its delivery branch, its PR target); an iteration records `base` /
 * `integration` / `target`. `base` is the protected start anchor in both shapes:
 * cleanup Rule 2 never deletes it and L1 uses it as the explicit main-worktree
 * residency fallback - it is NEVER a feature branch.
 */
export type WorkflowBranchAnchors = {
  /** Protected base anchor: the branch the lifecycle starts from (iteration `iteration_base_branch`, a plan's creation/merge anchor). Cleanup Rule 2 never deletes it and L1 uses it as the explicit main-worktree residency fallback - it is NEVER a feature branch. */
  base?: string;
  /** Delivery branch of a `type: plan` workflow (`work` is current, `source` the pre-rename spelling): the PR head and the plan row's working branch. */
  work?: string;
  /** The pre-rename spelling of `work`, still carried by rows registered before the rename. READ-COMPAT ONLY - never write it, and never read it outside `deliveryBranchOf`. */
  source?: string;
  integration?: string;
  target?: string;
};

/**
 * The delivery branch a `branch` object records, resolved through the ONE rule
 * that knows both spellings: `work` is the current key and `source` the key
 * rows registered before the rename carry. Every reader goes through here - a
 * second place reading either key would be a second source of truth for the
 * same field.
 */
export function deliveryBranchOf(branch: unknown): string | undefined {
  if (!isPlainObject(branch)) return undefined;
  if (nonEmptyString(branch.work)) return branch.work;
  return nonEmptyString(branch.source) ? branch.source : undefined;
}

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
    if (row.progress !== undefined && row.progress !== 0) ownership.push(`plan ${planId} progress=${String(row.progress)}`);
    if (isPlainObject(row.coordination) && row.coordination.progress !== undefined) ownership.push(`plan ${planId} progress`);
  }
  if (ownership.length === 0) {
    return { phase: PREPARE_PHASE, facts: [...facts, `plans=${rows.length}`, "every row Todo", "no execution ownership"] };
  }
  const allDone = rows.length > 0 && rows.every((row) => row.status === "Done");
  return { phase: allDone ? CLOSE_PHASE : EXECUTE_PHASE, facts: [...facts, ...ownership] };
}

/** Normative claimed_at form: RFC 3339 UTC with explicit `Z` (ADR field table). */
const DATE_PART = String.raw`\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`;
const RFC3339_Z_RE = new RegExp(String.raw`^${DATE_PART}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`);
/** Repo local-date convention: `YYYY-MM-DD` (used by the real control status.json lease). */
const DATE_ONLY_RE = new RegExp(String.raw`^${DATE_PART}$`);

/**
 * Snapshot top-level `integration_merge_lease` (v3 — relocated from the v1
 * root `metadata.integration_merge_lease`). Absent = unclaimed; writers delete
 * the key on release (never `null`/tombstone).
 */
export type IntegrationMergeLease = {
  holder: string;
  claimed_at: string;
  plan_id: string;
  source_branch: string;
  target_branch: string;
  session_label?: string;
  [key: string]: unknown;
};

/**
 * Validate one snapshot top-level `integration_merge_lease` object
 * (`mstar-engine-legacy/references/migration-source-shapes.md`
 * § "Migration-source top-level fields" — the retired snapshot top-level
 * shape): required `holder` / `claimed_at` / `plan_id` / `source_branch` /
 * `target_branch`; optional `session_label`. Absent = unclaimed; `null` and
 * tombstone objects are invalid (writers delete the key on release).
 * Integration merges into `spec_integration_branch` are serial — one holder
 * at a time (status-and-residuals.md § "Integration merge exclusion (ACTIVE
 * `execution_integration_leases`)").
 */
export function validateIntegrationMergeLease(lease: unknown): GateResult {
  const violations: ValidationResult[] = [];
  if (!isPlainObject(lease)) {
    return {
      ok: false,
      violations: [
        violation(
          "high",
          "lease.merge-lease.invalid",
          "integration_merge_lease must be an object \u2014 absent means unclaimed; null and tombstone objects are invalid; writers delete the key on release",
        ),
      ],
    };
  }
  validateNonEmptyString(
    violations,
    lease.holder,
    "holder",
    "lease.merge-lease.missing-holder",
    "lease.merge-lease.invalid-holder",
  );
  if (lease.claimed_at === undefined) {
    violations.push(violation("high", "lease.merge-lease.missing-claimed-at", "missing required field: claimed_at"));
  } else if (
    typeof lease.claimed_at !== "string" ||
    !(RFC3339_Z_RE.test(lease.claimed_at) || DATE_ONLY_RE.test(lease.claimed_at))
  ) {
    violations.push(
      violation(
        "medium",
        "lease.merge-lease.invalid-claimed-at",
        "claimed_at must be an RFC 3339 UTC timestamp with explicit Z (e.g. 2026-07-22T04:00:00Z) or a YYYY-MM-DD date",
      ),
    );
  }
  validateNonEmptyString(violations, lease.plan_id, "plan_id", "lease.merge-lease.missing-plan-id", "lease.merge-lease.invalid-plan-id");
  validateNonEmptyString(
    violations,
    lease.source_branch,
    "source_branch",
    "lease.merge-lease.missing-source-branch",
    "lease.merge-lease.invalid-source-branch",
  );
  validateNonEmptyString(
    violations,
    lease.target_branch,
    "target_branch",
    "lease.merge-lease.missing-target-branch",
    "lease.merge-lease.invalid-target-branch",
  );
  if (lease.session_label !== undefined && typeof lease.session_label !== "string") {
    violations.push(
      violation(
        "medium",
        "lease.merge-lease.invalid-session-label",
        "session_label must be a string (display only \u2014 never used for ownership comparison)",
      ),
    );
  }
  return { ok: violations.length === 0, violations };
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
   * through the ACTIVE evidence operation and consulted by the close path (and
   * the read-only phase-6 gate) for the declared `delivery_kind`.
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
 * Exported (pure, read-only) for the ACTIVE transport's workflow-level `delivery`
 * transition. The transport applies this shared structural rule before recording
 * evidence, preventing the accepted evidence shape from drifting.
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
      // `work` is the delivery branch a plan workflow records; `source` is the
      // pre-rename spelling old rows still carry, and `integration` the
      // iteration's delivery line. Both spellings stay legal so a row
      // registered before the rename keeps validating unchanged.
      for (const key of ["base", "work", "source", "integration", "target"] as const) {
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

/** Terminal enum predicate only; callers validate document shape separately. */
export function isTerminalSnapshot(doc: WorkflowSnapshot): boolean {
  return (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(doc.status);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Delivery-registration inputs every producer declares (contract §1/§4a). */
export type DeliveryRegistrationEvidence = {
  branchWork?: string;
  branchTarget?: string;
  completionPolicy?: string;
};

/**
 * Per-kind registration-evidence coherence (contract §1) - the ONE rule shared
 * by all registration and migration paths that declare a delivery kind. A
 * `development` workflow declares BOTH delivery anchors and a
 * `verification/report-only` workflow declares the completion policy that
 * completes it. Missing fields are incomplete registration, never an exemption.
 * `what` prefixes the refusal with the caller's operation name.
 */
export function assertDeliveryRegistrationCoherence(
  kind: WorkflowDeliveryKind,
  evidence: DeliveryRegistrationEvidence,
  what: string,
): void {
  if (kind === "development" && (!nonEmptyString(evidence.branchWork) || !nonEmptyString(evidence.branchTarget))) {
    throw new Error(
      `${what}: a development workflow requires its delivery branch and its target branch (--branch-work/--branch-target) \u2014 missing branch fields are incomplete registration, not an exempt workflow (contract \u00a71/\u00a74a)`,
    );
  }
  if (kind === "verification/report-only" && !nonEmptyString(evidence.completionPolicy)) {
    throw new Error(
      `${what}: a verification/report-only workflow requires the completion policy (--completion-policy) naming the evidence that completes it (contract \u00a71)`,
    );
  }
  for (const [field, value] of Object.entries({ branchWork: evidence.branchWork, branchTarget: evidence.branchTarget, completionPolicy: evidence.completionPolicy })) {
    if (value !== undefined && !nonEmptyString(value)) {
      throw new Error(`${what}: ${field} must be a non-empty string when given`);
    }
  }
}

/**
 * Delivery-kind evidence consultation is the shared pure rule used by ACTIVE
 * workflow completion and the read-only Phase-6 gate; neither consumer may
 * duplicate the registered-kind member map or evidence-shape checks.
 *
 * Only `type: plan` lifecycles consult this rule (an iteration declares no
 * delivery kind — §1). The registered kind, never inferred fields, determines
 * required evidence, and missing evidence is incomplete registration:
 *
 * - no registered `delivery_kind` while the lifecycle can still act on it →
 *   `PHASE6_DELIVERY_KIND_UNREGISTERED`; on a TERMINAL header the condition is
 *   accepted history and emits nothing — see the note below;
 * - `development` → registered `branch.work`/`branch.target` (the delivery
 *   branch resolves through `deliveryBranchOf`, so a pre-rename `branch.source`
 *   row closes the same way) plus compound
 *   disposition, PR identity and the PM's verified-merge record;
 * - `verification/report-only` → registered `completion_policy` plus a
 *   fulfilment record naming that same policy.
 *
 * A terminal (`completed`/`failed`/`stopped`) `type: plan` header without a
 * registered kind is a LEGACY snapshot: the kind is fixed at registration, so
 * no operation can add it, and the only recovery the ACTIVE wording can name
 * (close as failed, register a replacement) does not exist for a lifecycle that
 * already closed. Reporting it as an actionable `high` on read-only Phase-6
 * output would be an unclearable violation an operator cannot act on, so it
 * emits nothing here. The ACTIVE paths (registration-time / completion-time
 * callers, which pass a non-terminal header) keep the violation unchanged.
 */
export function consultDeliveryEvidence(snapshot: WorkflowSnapshot): ValidationResult[] {
  if (snapshot.type !== "plan") return [];
  const workflowId = nonEmptyString(snapshot.id) ? snapshot.id : "<unknown>";
  const kind = snapshot.delivery_kind;
  if (typeof kind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(kind)) {
    if (isTerminalSnapshot(snapshot)) return [];
    return [
      violation(
        "high",
        "PHASE6_DELIVERY_KIND_UNREGISTERED",
        `Workflow '${workflowId}' is type 'plan' but carries no registered delivery_kind \u2014 a plan workflow declares its delivery kind at registration (mstar-artifacts/references/plan-workflow-lifecycle-contract.md \u00a71), so this snapshot's delivery evidence cannot be consulted`,
        "Cause: this plan workflow has no registered delivery_kind, so delivery evidence cannot be checked. The kind is fixed at registration and cannot be added to an existing workflow. Close it honestly with `mstar workflow lifecycle --workflow <id> --status failed --reason \"<blocker>\"`, then register a replacement workflow with a new id and the correct declared delivery kind; keep the failed workflow as history.",
      ),
    ];
  }
  const branch = isPlainObject(snapshot.branch) ? snapshot.branch : undefined;
  const delivery = isPlainObject(snapshot.delivery) ? snapshot.delivery : undefined;
  // The delivery branch resolves through the one helper that knows both
  // spellings, so a row registered before the rename closes exactly like one
  // registered after it.
  const deliveryBranch = deliveryBranchOf(branch);
  const missing: string[] = [];
  if (kind === "development") {
    if (!nonEmptyString(deliveryBranch)) missing.push("branch.work");
    if (!nonEmptyString(branch?.target)) missing.push("branch.target");
    if (!isPlainObject(delivery?.compound)) missing.push("delivery.compound (compound disposition, \u00A74c)");
    const pr = isPlainObject(delivery?.pr) ? delivery.pr : undefined;
    if (pr === undefined) {
      missing.push("delivery.pr (PR repo/head/target identity, \u00A74d)");
    } else {
      // §4d: the identity recorded at submission IS the delivery the workflow
      // was registered for. Presence alone let a contradictory pair (a PR for
      // a different head/target) satisfy the close; `repo` is required but its
      // value is the recorder's own (no canonical repo to compare against).
      if (nonEmptyString(deliveryBranch) && pr.head !== deliveryBranch) {
        missing.push(
          `delivery.pr.head (recorded ${JSON.stringify(pr.head)}, registered delivery branch ${JSON.stringify(deliveryBranch)} \u2014 \u00A74d: the recorded PR identity must be the registered delivery)`,
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

/** Inputs for constructing a plan workflow snapshot for the catalog migration path. */
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
  /** The branch the workflow was created from, recorded as `branch.base` (the merge anchor; also L1's explicit main-worktree residency fallback). Optional. */
  branchBase?: string;
  /** The delivery branch of the plan, recorded as `branch.work`: the PR head, normally the plan's own feature branch. Required together with `branchTarget` for `development`. */
  branchWork?: string;
  /** Target branch. Required together with `branchWork` for `development`. */
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



/** Build the validated plan snapshot shape consumed by the catalog journal. */
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
  if (options.branchBase !== undefined || options.branchWork !== undefined || options.branchTarget !== undefined) {
    // `branchBase` is the branch the plan was created from (`branch.base`) -
    // the protected anchor cleanup Rule 2 keeps and L1 reads as its explicit
    // main-worktree residency fallback. `branchWork` is the DELIVERY branch
    // (`branch.work`): writing it into `base` made the feature ref undeletable
    // and pointed L1's residency expectation at the feature branch.
    snapshot.branch = {
      ...(options.branchBase !== undefined ? { base: options.branchBase } : {}),
      ...(options.branchWork !== undefined ? { work: options.branchWork } : {}),
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


/** Inputs for constructing an iteration workflow snapshot for the catalog migration path. */
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



/**
 * Normalize the registration input's `compassRef` to the stored contract
 * form: the canonical harness-relative pointer of the document it names.
 *
 * Both accepted spellings name the SAME existing reviewed document, and the
 * stored value is always that document's canonical relative form - never the
 * caller's spelling, so a repository-relative `.mstar/...` pointer can never
 * be stored as if it were harness-relative (it was, and every later reader
 * joined it under the harness root twice: I-000863). A pointer that names no
 * existing file, or that would resolve outside the root, refuses here - before
 * any row is published - with the accepted forms spelled out.
 *
 * Containment and existence are both decided on `canonicalizeNearestExisting`
 * of the resolved path, so an in-root symlink whose target lies outside the
 * harness is refused here - the same canonical read `readPrepareCompass`
 * performs later - rather than being stored and failing at amendment time.
 * The canonical form WITHOUT that existence proof is
 * `canonicalIterationCompassRef`, for a caller that must decide an idempotent
 * replay before it reads the mutable document (I-000868).
 */
export function normalizeIterationCompassRef(
  ref: string,
  harnessRoot: string,
  refuse: (detail: string) => Error,
): string {
  const canonical = canonicalIterationCompassRef(ref, harnessRoot, refuse);
  const path = canonicalizeNearestExisting(resolve(harnessRoot, canonical));
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw refuse(reviewedCompassMissing(ref, harnessRoot));
  }
  return canonical;
}

/**
 * The same pointer in its canonical stored form, WITHOUT requiring the
 * document to exist: containment and canonical spelling are facts about the
 * pointer, so registration can decide an idempotent operation replay and the
 * request fingerprint before it touches the reviewed document, and prove the
 * document itself only for a genuinely new operation (I-000868).
 */
export function canonicalIterationCompassRef(
  ref: string,
  harnessRoot: string,
  refuse: (detail: string) => Error,
): string {
  const rootCanon = canonicalizeNearestExisting(harnessRoot);
  const prefix = rootCanon.endsWith("/") ? rootCanon : `${rootCanon}/`;
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
  const canon = canonicalizeNearestExisting(resolve(harnessRoot, ref));
  if (canon !== rootCanon && !canon.startsWith(prefix)) {
    throw refuse(
      `options.compassRef escapes the harness root - the reviewed compass_ref must address a document inside ` +
        `${harnessRoot}; store the harness-relative pointer of that compass instead`,
    );
  }
  return relative(rootCanon, canon).split(sep).join("/");
}

/**
 * The refusal of a pointer that names no existing reviewed compass. It names
 * the two accepted forms, and the one trap that produced I-000863: a
 * repository-relative `.mstar/...` pointer is joined under the harness root,
 * so it can only ever name `.mstar/.mstar/...`.
 */
function reviewedCompassMissing(ref: string, harnessRoot: string): string {
  const repoRelative = isAbsolute(ref) ? undefined : /^(?:\.\/)?\.mstar\//.test(ref);
  return (
    `options.compassRef names no existing reviewed compass under ${harnessRoot}` +
    (repoRelative
      ? ` - the pointer ${JSON.stringify(ref)} is repository-relative, but a compass_ref is resolved against the ` +
        `harness root, so it would name a nested ".mstar/.mstar/..." document; drop the leading ".mstar/"`
      : "") +
    `; pass the compass document's absolute path inside the harness root, or its harness-relative pointer ` +
    `(e.g. iterations/<iteration-id>/delivery-compass.md)`
  );
}

/** Build the validated iteration snapshot shape consumed by the catalog journal. */
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
    // producer): the reviewed spelling is input, and the resolver settles the
    // one registered target before anything is written. Only the POINTER is
    // resolved here — the iteration row's id and title are the reviewed
    // declarations, which `derivePlanRegistration` would additionally constrain
    // against the document body (the plan producer's R1 rule, not this route's),
    // and the document itself is proven inside the registration transaction
    // after the operation replay (`assertRegisteredPlanDocuments`).
    plans: options.rows.map((r) => ({
      id: r.id,
      title: r.title,
      file: canonicalRegisteredPlanPath({ harnessRoot: resolve(options.harnessDir), planId: r.id, file: r.file }).planPath,
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

