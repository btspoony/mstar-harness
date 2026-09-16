/**
 * Engine workflow module — v3 workflow snapshot schema
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
 *   verbatim — unknown row fields preserved, never re-bucketed),
 *   `execution_policy?` (first-class; keys accepted-but-opaque this
 *   iteration), `integration_merge_lease?` (top-level; the v1 root-`metadata`
 *   home is gone), `branch?` / `integration_worktree_path?` (iteration
 *   anchors — the canonical checkout field; the v1 `control_worktree_path`
 *   key survives only as a read alias in `readWorkflowSnapshot`),
 *   `legacy_metadata?` (catch-all for unmapped v1 root-metadata keys),
 *   `compass_ref?` (relative pointer to the iteration delivery compass).
 * - Lease shape delegation: `validateExecutionLease` /
 *   `validateIntegrationMergeLease` unchanged (`lease.ts`).
 * - Writer: whole-rewrite under `withStatusWriteLock(snapshotPath)` — the
 *   `.status-write.lockdir` lands inside `workflows/<id>/` (dirname of the
 *   snapshot), no harness-root pollution.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readJson, type GateResult, type Severity, type ValidationResult } from "./core.js";
import {
  CoordinationError,
  canonicalTarget,
  isArtifactVersion,
  isPlainObject,
  readArtifactBytes,
  validateRowCoordination,
  validateSnapshotCoordination,
  withProtectedWrite,
  type SnapshotCoordination,
} from "./coordination-write.js";
import { validateExecutionLease, validateIntegrationMergeLease, withStatusWriteLock, type IntegrationMergeLease } from "./lease.js";
import { assertSafePathComponent } from "./path.js";
// Call-time-only cycle with status.ts (status.ts imports the snapshot consts
// from this module): neither module dereferences the other's bindings during
// module evaluation, so the ESM live-binding cycle is safe (see status.ts).
import { registerWorkflowEntryLocked, validatePlanRow, validateWorkflowEntry, type PlanRow, type WorkflowEntry } from "./status.js";
import { assertFsStorePath, getArtifactStore, type ArtifactStore } from "./store.js";

/** Snapshot file name inside `workflows/<id>/` ( — writer contract). */
export const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";

/** Lifecycle status enum ( — terminal set = completed|failed|stopped). */
export const WORKFLOW_LIFECYCLE_STATUSES = ["running", "paused", "completed", "failed", "stopped"] as const;

/** Terminal statuses: snapshot must carry `ended_at` and no dangling leases. */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const;

/** Lifecycle type enum ( — id reuses the orchestration id). */
export const WORKFLOW_LIFECYCLE_TYPES = ["plan", "iteration"] as const;

/**
 * Delivery kinds declared at registration (plan-workflow-lifecycle-contract
 * §1). The declared kind is recorded at registration and never inferred
 * retroactively; `development` carries the full PR/merge delivery lifecycle,
 * `verification/report-only` follows the explicit completion policy recorded
 * alongside it.
 */
export const WORKFLOW_DELIVERY_KINDS = ["development", "verification/report-only"] as const;

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
 * close consultation reads the block for the DECLARED delivery kind — never
 * inferring a kind from which members happen to be present (§1):
 *
 * - `compound` — compound disposition (§4c), recorded before the PR head is
 *   finalized; `skipped` carries the mandatory reason;
 * - `pr` — PR identity recorded at submission (§4d): repo/head/target. A
 *   local commit or a pre-existing unrelated PR does not satisfy it;
 * - `merge` — the PM's verified-merge record (§4f): the provider evidence
 *   they checked. The engine NEVER verifies the remote merge itself;
 * - `completion` — the fulfilment record of the `completion_policy` recorded
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
 * First-class lifecycle execution policy ( — keys copied from root
 * `metadata` at migrate; values accepted-but-opaque this iteration, no
 * semantic gate).
 */
export type WorkflowExecutionPolicy = {
  plan_parallelism?: unknown;
  worktree_mode?: unknown;
  push_policy?: unknown;
};

/** Iteration branch anchors ( — from root metadata anchors). */
export type WorkflowBranchAnchors = {
  /**
   * Protected base anchor: the branch the lifecycle starts from (iteration
   * `iteration_base_branch`). Cleanup Rule 2 never deletes it and L1 uses it
   * as the explicit main-worktree residency fallback — it is NEVER a
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
 * v3 workflow snapshot (`workflows/<id>/snapshot.json`) — final schema
 * (). `plans[]` rows are the legacy PlanRow shape verbatim;
 * per-row `execution_lease` stays on the row, `integration_merge_lease` is
 * top-level.
 *
 * Integration worktree path: the canonical member is
 * `integration_worktree_path` — the dedicated integration checkout, on
 * `branch.integration`, distinct from the main worktree. The v1
 * `control_worktree_path` key has NO canonical member: legacy-only
 * documents stay readable through `readWorkflowSnapshot` (in-memory
 * normalization + medium migration diagnostic); writers emit only the
 * canonical shape — no dual writer.
 *
 * Notes dual-home SSOT: a plan row's `notes` array is the
 * LEGACY VERBATIM copy preserved at migrate time — the RUNTIME ledger is
 * `notes.jsonl` in the workflow dir (`migrate.ts` NOTES_LEDGER_FILE). New
 * notes append to the ledger only; row `notes` is read-only legacy and is
 * never a dual-write target, so the two never diverge by construction.
 */
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
   * Snapshot-level coordination block ( — scoped plan-PM coordination).
   * Present only on a coordinated lifecycle: it carries the workflow's
   * coordinator binding (session id + canonical envelope path). The block
   * is validated strictly (`validateSnapshotCoordination`) and may only be
   * changed by the locked coordination writer.
   */
  coordination?: SnapshotCoordination;
  /**
   * Delivery kind declared at registration (plan-workflow-lifecycle-contract
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
   * seam S3). Optional at the schema level — it is populated stage by stage
   * through `recordWorkflowDelivery` and consulted by the close path (and the
   * read-only phase-6 gate) for the declared `delivery_kind`.
   */
  delivery?: WorkflowDeliveryEvidence;
};

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
 * Integration worktree path value check — shared by the canonical member
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
 * mandatory reason. Structural validation only — WHICH members the declared
 * delivery kind requires is the consultation's rule
 * (`consultDeliveryEvidence`), so a partially filled block stays writable
 * while it is being collected.
 */
function deliveryEvidenceViolations(value: unknown, what: string): ValidationResult[] {
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

/**
 * Validate a v3 workflow snapshot document ( — final schema):
 * enum/type/id checks, `schema_version: 1`, required timestamps, `plans[]`
 * rows validated by the legacy `validatePlanRow` with row-level
 * `execution_lease` shape delegated to `validateExecutionLease`,
 * `integration_merge_lease` shape delegated to
 * `validateIntegrationMergeLease`, `execution_policy` keys accepted-but-
 * opaque. Integration worktree path: the canonical member is
 * `integration_worktree_path`; the v1 `control_worktree_path` key is a
 * read-only alias whose presence keeps this STRICT validation a failing
 * gate carrying the medium `workflow.snapshot.legacy-control-worktree-path`
 * migration diagnostic (read acceptance is not write permission — the
 * canonical reader is the only consumer that normalizes it, in memory);
 * both keys present is `workflow.snapshot.conflicting-worktree-paths`
 * (high), even when the values are equal. Terminal invariant: `status` ∈
 * completed|failed|stopped ⇒ `ended_at` present AND no row carries
 * `execution_lease` AND no `integration_merge_lease` (no dangling leases).
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
  // status.json discriminator and must never appear on a snapshot — reject
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
    for (const row of doc.plans) {
      violations.push(...validatePlanRow(row).violations);
      if (isPlainObject(row) && row.execution_lease !== undefined) {
        violations.push(...validateExecutionLease(row.execution_lease).violations);
      }
      // Row-level coordination block (scoped plan coordination) — strict:
      // unknown keys, malformed handoffs/progress/bindings are refused here
      // so a malformed coordination state can never be persisted.
      if (isPlainObject(row) && row.coordination !== undefined) {
        violations.push(...validateRowCoordination(row.coordination, `plans[${String(row.id)}].coordination`));
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
    // accepted-but-opaque this iteration — no semantic gate.
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
  // strict validation never accepts the legacy key — the medium diagnostic
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

  // Registration-declared fields (plan-workflow-lifecycle-contract §1/§3):
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
  // Delivery evidence (contract §3/§4c/§4d/§4f): structure only — the
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
    if (Array.isArray(doc.plans)) {
      for (const row of doc.plans) {
        if (isPlainObject(row) && row.execution_lease !== undefined) {
          violations.push(
            violation(
              "high",
              "workflow.snapshot.terminal-dangling-execution-lease",
              `terminal snapshot must not carry a row execution_lease (dangling lease) \u2014 release every lease before the lifecycle ends`,
            ),
          );
        }
      }
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
 * Result of the canonical snapshot read: the validated snapshot plus the
 * non-blocking diagnostics collected while reading (currently only the
 * `workflow.snapshot.legacy-control-worktree-path` migration diagnostic for
 * v1-shaped documents). A read with diagnostics is NOT write permission —
 * writers keep strict validation and emit only the canonical shape.
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
 * (throw) — read acceptance extends only to the migration diagnostic, so
 * this never weakens the strict writer gate. Performs no writes: the
 * source file's bytes are never touched; legacy snapshots migrate on their
 * next authorized read-modify-write through the canonical writer. Missing
 * files, malformed JSON, and non-object documents throw.
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
  if (migration.length === 0) {
    return { snapshot: doc as WorkflowSnapshot, diagnostics: [] };
  }
  // In-memory normalization of the single permitted legacy alias.
  const raw = doc as Record<string, unknown>;
  const { control_worktree_path: _legacy, ...rest } = raw;
  const normalized = { ...rest, integration_worktree_path: raw.control_worktree_path } as unknown as WorkflowSnapshot;
  const revalidated = validateWorkflowSnapshot(normalized);
  if (!revalidated.ok) {
    const detail = revalidated.violations.map((v) => `${v.code}: ${v.message}`).join("; ");
    throw new Error(
      `refusing to read workflow snapshot ${snapshotPath}: legacy normalization produced an invalid document: ${detail}`,
    );
  }
  return { snapshot: normalized, diagnostics: migration };
}

/**
 * Writer contract (spec §C4). `expectedVersion` is the CAS token — the exact
 * on-disk artifact version (`sha256:<64 hex>`), or `"absent"` for
 * create-only. `createOnly` is the locked `absent` shorthand used by the
 * scaffold/migrate/audit writers: an existing document (even an empty or
 * malformed one) is never silently replaced.
 *
 * Omitting `expectedVersion` means create-only, NOT "replace whatever is
 * there": there is no missing-version compatibility fallback, so an existing
 * snapshot still refuses with `coordination.expected-version-required`.
 *
 * The delta allowed here is `phase` + `updated_at` and nothing else — a
 * coordinator persists its phase projection through this writer without ever
 * gaining a backdoor to row owners, leases, lifecycle scalars or branch
 * anchors. Lifecycle terminal changes belong to `closeWorkflow` (spec §C4).
 */
export type WriteWorkflowSnapshotOptions = {
  expectedVersion?: string;
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
 * under `withStatusWriteLock(snapshotPath)` ( — the `.status-write.lockdir`
 * lands inside `workflows/<id>/`, dirname of the snapshot; no harness-root
 * pollution). The snapshot is validated first — an invalid snapshot throws
 * and nothing is written. `dir` is created recursively. The durable write
 * routes through the active `ArtifactStore` (the store contract: snapshot →
 * `{ kind: "snapshot", key: <workflow id> }`) inside the existing lock — the
 * default FsStore resolves `{WORKFLOW_DIR}/<key>/snapshot.json`, identical
 * to `join(dir, WORKFLOW_SNAPSHOT_FILE)` for canonical callers. The write
 * fails loud when the active FsStore would resolve a different path than
 * the caller's `join(dir, WORKFLOW_SNAPSHOT_FILE)`  — callers
 * whose target root differs from the active store's root MUST
 * `setArtifactStore(createFsStore(root))` first.
 */
export async function writeWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  dir: string,
  opts: WriteWorkflowSnapshotOptions = {},
): Promise<void> {
  const gate = validateWorkflowSnapshot(snapshot);
  if (!gate.ok) {
    const detail = gate.violations.map((v) => v.message).join("; ");
    throw new Error(`refusing to write invalid workflow snapshot: ${detail}`);
  }
  if (opts.expectedVersion !== undefined && !isArtifactVersion(opts.expectedVersion)) {
    throw new CoordinationError(
      "coordination.invalid-input",
      `expectedVersion must be "absent" or sha256:<64 hex> \u2014 got ${JSON.stringify(opts.expectedVersion)}`,
      { expected: opts.expectedVersion },
    );
  }
  if (opts.createOnly === true && opts.expectedVersion !== undefined && opts.expectedVersion !== "absent") {
    throw new CoordinationError(
      "coordination.invalid-input",
      `createOnly implies expectedVersion "absent" \u2014 got ${JSON.stringify(opts.expectedVersion)}`,
      { expected: opts.expectedVersion },
    );
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  // Fail-loud path agreement : the lockdir serializes
  // `snapshotPath`; the store put must land on that same file. A divergence
  // (caller target outside the active FsStore root) throws before the dir or
  // lockdir is created — nothing is written anywhere.
  const store = getArtifactStore();
  assertFsStorePath(store, { kind: "snapshot", key: snapshot.id }, snapshotPath);
  // simplify: whole-rewrite snapshot on every state change (temp+rename via
  // writeJson under the workflow lockdir) — the ceiling is O(plans[] × row
  // payload) per write; unbounded inputs already divert to notes.jsonl at
  // migrate time. Upgrade path: append-only delta file or per-row files +
  // compaction when a lifecycle exceeds ~N plans / large per-row payloads.
  // The lockdir mkdir is non-recursive — the snapshot dir must exist before
  // acquisition (the lockdir lands inside `dir`, dirname of the snapshot).
  mkdirSync(dir, { recursive: true });
  // The store put is the durable write inside the lock; the store is never a
  // second lock (architect-locked 2026-08-27: locks stay with callers).
  await withStatusWriteLock(snapshotPath, async () => {
    const current = readArtifactBytes(snapshotPath);
    const currentVersion = current?.version ?? "absent";
    // Create-only is the default: an omitted token can create but never
    // replace, so no caller reaches a locked CAS by accident (spec §C4 — no
    // missing-version compatibility fallback).
    const required = opts.createOnly === true ? "absent" : opts.expectedVersion ?? "absent";
    if (required !== currentVersion) {
      const missingToken = opts.createOnly !== true && opts.expectedVersion === undefined;
      throw new CoordinationError(
        missingToken ? "coordination.expected-version-required" : "coordination.version-conflict",
        missingToken
          ? `snapshot ${snapshotPath} already exists \u2014 replace it with an explicit expectedVersion (its current version is ${currentVersion}) or write a new snapshot`
          : `snapshot ${snapshotPath} is at ${currentVersion}, writer required ${required}`,
        { path: snapshotPath, expected: required, actual: currentVersion },
      );
    }
    const payload = current === undefined ? snapshot : mergePhaseProjection(current.payload, snapshot);
    assertCoordinatedSnapshotWriter(current?.payload, snapshotPath, opts.sessionPath);
    await withProtectedWrite(snapshotPath, "put", () =>
      store.put({ kind: "snapshot", key: snapshot.id, payload }),
    );
  });
}

/**
 * Coordinated snapshots are replaced only by their own bound coordinator
 * (spec §C4) — the `mstar persist replace snapshot` door authenticates on the
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
 * Apply the field-scoped delta contract against the stored document: only
 * `phase` + `updated_at` may differ (spec §C4 line 152). Every other field —
 * plan rows, leases, the coordination block, branch anchors, lifecycle
 * scalars — is taken from disk, so this writer can never drop or rewrite them
 * implicitly, and lifecycle terminal changes stay on `closeWorkflow`.
 */
function mergePhaseProjection(stored: unknown, incoming: WorkflowSnapshot): WorkflowSnapshot {
  if (!isPlainObject(stored)) {
    throw new CoordinationError(
      "coordination.version-conflict",
      "stored workflow snapshot is not an object \u2014 refusing a field-scoped rewrite over it",
      {},
    );
  }
  const allowed: string[] = ["phase", "updated_at"];
  const keys = new Set([...Object.keys(stored), ...Object.keys(incoming as Record<string, unknown>)]);
  const drifted = [...keys].filter(
    (key) =>
      !allowed.includes(key) &&
      stableJson(stored[key]) !== stableJson((incoming as unknown as Record<string, unknown>)[key]),
  );
  if (drifted.length > 0) {
    throw new CoordinationError(
      "coordination.direct-write-refused",
      `refusing snapshot write: field(s) ${drifted.join(", ")} differ from disk \u2014 this writer may only change ${allowed.join(", ")}`,
      { fields: drifted, allowed },
    );
  }
  const next: Record<string, unknown> = { ...stored };
  for (const key of allowed) {
    const value = (incoming as unknown as Record<string, unknown>)[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as WorkflowSnapshot;
}



/**
 * Shared by writers that already hold the snapshot lock. `snapshotPath` is the
 * canonical target of the put: the store boundary refuses an unauthorized
 * write to a protected document, so the write is recorded inside
 * `withProtectedWrite` (spec §C4 — durable protected writes route through the
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

/**
 * Delivery-kind evidence consultation (seam S3 — contract §4g + §6 S3): the
 * ONE implementation behind both the read-only Phase-6 gate
 * (`evaluatePostMergeClose`) and the close write path (`closeWorkflow`), so
 * the gate's verdict and the close's refusal can never drift apart. Pure,
 * read-only, no writes; the input snapshot is consumed as read.
 *
 * Only `type: plan` lifecycles consult (an iteration declares no delivery
 * kind — §1). The DECLARED kind decides the required evidence; nothing is
 * inferred from which fields happen to be present, and a missing field is
 * incomplete registration, never an exemption (§1):
 *
 * - no registered `delivery_kind` → `PHASE6_DELIVERY_KIND_UNREGISTERED` (a
 *   legacy terminal snapshot cannot be backfilled: the register producer is
 *   create-only and preserves the terminal bytes);
 * - `development` → the registered `branch.source`/`branch.target` plus the
 *   collected `delivery` evidence: compound disposition (§4c), PR identity
 *   (§4d) and the PM's verified-merge record (§4f — the engine never verifies
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
        `Workflow '${workflowId}' is type 'plan' but carries no registered delivery_kind \u2014 a plan workflow declares its delivery kind at registration (plan-workflow-lifecycle-contract \u00a71), so this snapshot's delivery evidence cannot be consulted`,
        // Truthful recovery (the register verb is a dead end here):
        // `registerPlanWorkflow` is create-only and its recovery identity
        // (status + delivery_kind) can never match a terminal snapshot, so
        // the remediation names the owner snapshot amendment instead.
        "Delivery evidence is declared at registration, before execution \u2014 'mstar workflow register' cannot backfill a terminal snapshot (create-only; snapshot bytes are preserved, so re-registration refuses), leaving a legacy terminal snapshot without a delivery_kind outside this gate's automated recovery: repair requires an explicit owner snapshot amendment recording the declared kind (the known affected population \u2014 audit-promotion's grandfathered type: plan snapshots \u2014 is disclosed as a residual by plan QC), then re-run the close / 'mstar iteration gate --phase 6 --workflow <id>'",
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
    if (!isPlainObject(delivery?.pr)) missing.push("delivery.pr (PR repo/head/target identity, \u00a74d)");
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
      `Workflow '${workflowId}' declares delivery_kind '${kind}' but its delivery evidence is incomplete \u2014 missing: ${missing.join(", ")} (plan-workflow-lifecycle-contract \u00a73 lifecycle stages + \u00a74c/\u00a74d/\u00a74f)`,
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

export type CloseWorkflowOptions = {
  endedAt: string;
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

function isCloseTimestamp(value: string): boolean {
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
 * A valid terminal snapshot is returned unchanged, including failed/stopped
 * (idempotent preservation — nothing is rewritten, not even the timestamp).
 * A coordinated snapshot is closed only by its own bound coordinator
 * (spec §C4) — the same envelope seam as `writeWorkflowSnapshot` — so a plan
 * actor or a bare CLI call can never complete a lifecycle it does not own.
 *
 * Before the terminal write the close consults the registered delivery
 * kind's evidence through `consultDeliveryEvidence` — the SAME pure function
 * the read-only Phase-6 gate runs (contract §4g/§6 S3), so the gate's verdict
 * and this refusal can never disagree. An incomplete delivery (a
 * `development` workflow without its compound disposition / PR identity /
 * verified-merge record, a `verification/report-only` workflow without the
 * fulfilment of its recorded completion policy) throws with every missing
 * item named and ZERO writes: the snapshot stays `running` and the root entry
 * stays registered, so the workflow remains resumable. The local close never
 * verifies a remote merge (§4f keeps that as the PM's separate check) and
 * never releases leases.
 */
export async function closeWorkflow(workflowId: string, dir: string, opts: CloseWorkflowOptions): Promise<WorkflowSnapshot> {
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
    if (isTerminalSnapshot(snapshot)) return snapshot;
    // Authorization sits on the write path only: a terminal snapshot returned
    // above is never written. For a coordinated snapshot the stored payload
    // (not the normalized view) carries the `coordination` block, exactly as
    // the replacement door reads it.
    assertCoordinatedSnapshotWriter(doc, snapshotPath, opts.sessionPath, "close");
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
    const completed: WorkflowSnapshot = { ...snapshot, status: "completed", ended_at: opts.endedAt, updated_at: opts.endedAt };
    // Strict terminal validation refuses both lease kinds without deleting them.
    await validateAndPutWorkflowSnapshot(store, completed, snapshotPath);
    return completed;
  });
}

// ---------------------------------------------------------------------------
// Delivery evidence recording (plan-workflow-lifecycle-contract §3/§4c/§4d/
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
   * Canonical coordinator session envelope path (spec §C4) — the same
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
  /** `false` when the recorded evidence already matched disk — nothing was written. */
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
 *   a terminal lifecycle is never amended (§5 — no rewriting a closed
 *   lifecycle);
 * - a lifecycle other than `type: plan`, or one without a registered
 *   `delivery_kind`: the evidence belongs to the declared kind (§1);
 * - evidence the declared kind does not use (e.g. a completion record on a
 *   `development` workflow) — the declared kind is authoritative;
 * - an empty patch or a malformed member: nothing is silently dropped.
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
    const allowed = kind === "development" ? ["compound", "pr", "merge"] : ["completion"];
    const unused = members.filter((member) => !allowed.includes(member));
    if (unused.length > 0) {
      throw new Error(
        `refusing to record delivery evidence for workflow ${JSON.stringify(workflowId)}: member(s) ${unused.join(", ")} do not belong to the declared delivery_kind '${kind}' (expected ${allowed.join(" | ")})`,
      );
    }
    const stored = isPlainObject(snapshot.delivery) ? snapshot.delivery : {};
    const merged = { ...stored, ...evidence } as WorkflowDeliveryEvidence;
    if (stableJson(snapshot.delivery ?? null) === stableJson(merged)) {
      return { snapshot, written: false };
    }
    const next: WorkflowSnapshot = { ...snapshot, delivery: merged, updated_at: at };
    await validateAndPutWorkflowSnapshot(store, next, snapshotPath);
    return { snapshot: next, written: true };
  });
}

// ---------------------------------------------------------------------------
// Generic registration producer (plan-workflow-lifecycle-contract §2/§4a,
// seam S1): create-only `type: plan` snapshot + root `workflows[]` entry
// under one lock, mirroring the audit-promotion primitive sequence
// (`promoteAuditPlans`): snapshot create-only → `registerWorkflowEntryLocked`
// → rollback removes only the exact snapshot version this call created.
// ---------------------------------------------------------------------------

/** Options for `registerPlanWorkflow`. `harnessDir` is required — the
 * snapshot and `status.json` live under the harness root. */
export type RegisterPlanWorkflowOptions = {
  /** Absolute harness dir that contains `status.json` + `workflows/`. Required. */
  harnessDir: string;
  /** The owned plan (contract §2: one independently owned plan per workflow on the new normal route). */
  plan: { id: string; title: string; file: string };
  /** Delivery kind declared at registration (contract §1). Required — never inferred. */
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
   * Pre-existing coordinator binding recorded at registration. Optional —
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
   * existing snapshot bytes — identity, timestamps, ownership — were kept
   * and only the root entry was written (contract §4b recovery).
   */
  recovered: boolean;
};

/**
 * Identity subset compared on recovery (contract §4b: re-running the producer
 * must not duplicate identity). Timestamps (`started_at`/`updated_at`/`bound_at`)
 * are excluded by design — the orphaned snapshot's timestamps are preserved,
 * not rewritten, and a retry does not fail merely because the clock moved.
 */
function planWorkflowRegistrationIdentity(snapshot: WorkflowSnapshot): string {
  const coordinator = snapshot.coordination?.coordinator;
  return stableJson({
    type: snapshot.type,
    status: snapshot.status,
    delivery_kind: snapshot.delivery_kind ?? null,
    project: snapshot.project ?? null,
    completion_policy: snapshot.completion_policy ?? null,
    branch: snapshot.branch ?? null,
    plans: snapshot.plans,
    coordinator: coordinator ? { session_id: coordinator.session_id, session_file: coordinator.session_file } : null,
  });
}

/**
 * Register a standalone plan workflow (seam S1 — the generic normal-entry
 * producer). Builds the create-only `type: plan` snapshot (workflow id, the
 * owned plan as its single Todo row, project, delivery kind, source/target
 * branches, optional coordinator) and the root `workflows[]` entry, then
 * writes BOTH under one atomic section of the root `withStatusWriteLock`
 * — the same serialization point `registerWorkflow` uses — mirroring
 * `promoteAuditPlans`'s primitive sequence: create-only
 * `writeWorkflowSnapshot` (its snapshot-dir lock nests inside the root lock,
 * root → snapshot is the documented acquisition order) →
 * `registerWorkflowEntryLocked`, with rollback that removes ONLY the exact
 * snapshot version this call created (plus the now-empty workflow dir), so a
 * failed register write is never treated as partial activation success.
 *
 * Refusals (fail-loud, no partial activation):
 * - existing id: the workflow is already registered (snapshot + root entry) —
 *   registration is create-only, never a re-registration;
 * - unreadable root: a malformed/v1 `status.json` refuses (the created
 *   snapshot is rolled back first);
 * - missing required fields: id/plan/delivery-kind shape per the existing
 *   snapshot validators; `development` additionally requires source+target
 *   branches (contract §1 — a development workflow with missing branch
 *   fields is incomplete registration, not an exempt workflow) and
 *   `verification/report-only` requires the completion policy.
 *
 * Crash/retry recovery (contract §4b): a crash between snapshot creation and
 * root registration leaves the snapshot orphaned (no root entry = no
 * activation). Re-running this producer with the same registration identity
 * completes the registration against the EXISTING snapshot bytes — identity,
 * timestamps and ownership are preserved, never rewritten. An existing
 * snapshot with a DIFFERENT registration identity refuses (it belongs to
 * another registration).
 *
 * The caller must pin the artifact store to the harness root first
 * (`setArtifactStore(createFsStore(harnessDir))`) when the active store's
 * root could differ — the routed writers fail loud on a path mismatch.
 */
export async function registerPlanWorkflow(
  workflowId: string,
  options: RegisterPlanWorkflowOptions,
): Promise<RegisterPlanWorkflowResult> {
  if (typeof options.harnessDir !== "string" || options.harnessDir.trim() === "") {
    throw new Error("registerPlanWorkflow: options.harnessDir is required (must contain status.json + workflows/)");
  }
  assertSafePathComponent(workflowId, "workflow id");
  const { plan, deliveryKind } = options;
  if (!isPlainObject(plan)) {
    throw new Error("registerPlanWorkflow: options.plan is required (the owned plan: id, title, file)");
  }
  for (const field of ["id", "title", "file"] as const) {
    if (typeof plan[field] !== "string" || plan[field].trim() === "") {
      throw new Error(`registerPlanWorkflow: options.plan.${field} must be a non-empty string`);
    }
  }
  if (typeof deliveryKind !== "string" || !(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(deliveryKind)) {
    throw new Error(
      `registerPlanWorkflow: options.deliveryKind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")} \u2014 got ${JSON.stringify(deliveryKind)}`,
    );
  }
  // Contract §1: missing branch fields never select or waive a kind. A
  // development workflow declares its delivery path at registration.
  if (deliveryKind === "development" && (typeof options.branchSource !== "string" || options.branchSource.trim() === "" || typeof options.branchTarget !== "string" || options.branchTarget.trim() === "")) {
    throw new Error(
      "registerPlanWorkflow: a development workflow requires --branch-source and --branch-target at registration \u2014 missing branch fields are incomplete registration, not an exempt workflow",
    );
  }
  if (deliveryKind === "verification/report-only" && (typeof options.completionPolicy !== "string" || options.completionPolicy.trim() === "")) {
    throw new Error(
      "registerPlanWorkflow: a verification/report-only workflow requires --completion-policy naming the evidence that completes it (contract \u00a71)",
    );
  }
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

  const harnessDir = resolve(options.harnessDir);
  const statusPath = join(harnessDir, "status.json");
  const workflowDir = join(harnessDir, "workflows", workflowId);
  const snapshotPath = join(workflowDir, WORKFLOW_SNAPSHOT_FILE);
  const store = getArtifactStore();

  const planRow: PlanRow = { id: plan.id, title: plan.title, file: plan.file, status: "Todo" };
  const snapshot: WorkflowSnapshot = {
    schema_version: 1,
    id: workflowId,
    type: "plan",
    status: "running",
    started_at: startedAt,
    updated_at: startedAt.slice(0, 10),
    plans: [planRow],
    delivery_kind: deliveryKind,
  };
  if (options.project !== undefined) snapshot.project = options.project;
  if (options.completionPolicy !== undefined) snapshot.completion_policy = options.completionPolicy;
  if (options.branchSource !== undefined || options.branchTarget !== undefined) {
    // `branchSource` is the plan's DELIVERY branch (`branch.source`) — never
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
      // has no entry — no activation happened. Complete the registration
      // against the EXISTING snapshot bytes; an identity mismatch refuses
      // instead of adopting a foreign registration.
      const existing = readWorkflowSnapshot(workflowDir);
      if (planWorkflowRegistrationIdentity(existing.snapshot) !== planWorkflowRegistrationIdentity(snapshot)) {
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
      // the root lock — root → snapshot is the documented acquisition order.
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
        // Remove the workflow dir only when empty — a concurrent writer's
        // snapshot/rows are never destroyed; rmdirSync throws ENOTEMPTY if
        // content appeared between the readdir and the removal.
        if (readdirSync(workflowDir).length === 0) {
          rmdirSync(workflowDir);
        }
      } catch {
        // Dir non-empty or already gone — leave it; never force-remove.
      }
      throw error;
    }
    return { workflowId, snapshotPath, recovered: false };
  });
}
