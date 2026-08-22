/**
 * Engine workflow module — v3 workflow snapshot schema
 * (`workflows/<id>/snapshot.json`), lifecycle status enum, validator, and the
 * whole-rewrite writer.
 *
 * Spec sources (each export cites the plan/brief section it enforces):
 * - Snapshot schema (final): plan `20260819-workflow-engine-core.md` Task 2 —
 *   `schema_version: 1` (snapshot-own field; `version` stays the root-file
 *   discriminator), `id` (= plan id or iteration id), `type: "plan" |
 *   "iteration"`, `status` lifecycle enum (terminal set =
 *   `completed|failed|stopped`; `running|paused` are the active root-listed
 *   states), `started_at` / `ended_at?` (required at terminal) / `updated_at`,
 *   `phase?` (free-form phase-machine label), `plans[]` (legacy PlanRow shape
 *   verbatim — unknown row fields preserved, never re-bucketed),
 *   `execution_policy?` (first-class; keys accepted-but-opaque this
 *   iteration), `integration_merge_lease?` (top-level; the v1 root-`metadata`
 *   home is gone), `branch?` / `control_worktree_path?` (iteration anchors),
 *   `legacy_metadata?` (catch-all for unmapped v1 root-metadata keys),
 *   `compass_ref?` (relative pointer to the iteration delivery compass).
 * - Lease shape delegation: `validateExecutionLease` /
 *   `validateIntegrationMergeLease` unchanged (`lease.ts`).
 * - Writer: whole-rewrite under `withStatusWriteLock(snapshotPath)` — the
 *   `.status-write.lockdir` lands inside `workflows/<id>/` (dirname of the
 *   snapshot), no harness-root pollution.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, Severity, ValidationResult } from "./core.js";
import { writeJson } from "./core.js";
import { validateExecutionLease, validateIntegrationMergeLease, withStatusWriteLock, type IntegrationMergeLease } from "./lease.js";
import { validatePlanRow, type PlanRow } from "./status.js";

/** Snapshot file name inside `workflows/<id>/` (plan Task 2 — writer contract). */
export const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";

/** Lifecycle status enum (plan Task 2 — terminal set = completed|failed|stopped). */
export const WORKFLOW_LIFECYCLE_STATUSES = ["running", "paused", "completed", "failed", "stopped"] as const;

/** Terminal statuses: snapshot must carry `ended_at` and no dangling leases. */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const;

/** Lifecycle type enum (plan Task 2 — id reuses the orchestration id). */
export const WORKFLOW_LIFECYCLE_TYPES = ["plan", "iteration"] as const;

export type WorkflowLifecycleStatus = (typeof WORKFLOW_LIFECYCLE_STATUSES)[number];
export type WorkflowLifecycleType = (typeof WORKFLOW_LIFECYCLE_TYPES)[number];

/**
 * First-class lifecycle execution policy (plan Task 2 — keys copied from root
 * `metadata` at migrate; values accepted-but-opaque this iteration, no
 * semantic gate).
 */
export type WorkflowExecutionPolicy = {
  plan_parallelism?: unknown;
  worktree_mode?: unknown;
  push_policy?: unknown;
};

/** Iteration branch anchors (plan Task 2 — from root metadata anchors). */
export type WorkflowBranchAnchors = {
  base?: string;
  integration?: string;
  target?: string;
};

/**
 * v3 workflow snapshot (`workflows/<id>/snapshot.json`) — final schema
 * (plan Task 2). `plans[]` rows are the legacy PlanRow shape verbatim;
 * per-row `execution_lease` stays on the row, `integration_merge_lease` is
 * top-level.
 *
 * Notes dual-home SSOT (qc wave-1 S-e): a plan row's `notes` array is the
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
  control_worktree_path?: string;
  legacy_metadata?: Record<string, unknown>;
  compass_ref?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Validate a v3 workflow snapshot document (plan Task 2 — final schema):
 * enum/type/id checks, `schema_version: 1`, required timestamps, `plans[]`
 * rows validated by the legacy `validatePlanRow` with row-level
 * `execution_lease` shape delegated to `validateExecutionLease`,
 * `integration_merge_lease` shape delegated to
 * `validateIntegrationMergeLease`, `execution_policy` keys accepted-but-
 * opaque. Terminal invariant: `status` ∈ completed|failed|stopped ⇒
 * `ended_at` present AND no row carries `execution_lease` AND no
 * `integration_merge_lease` (no dangling leases).
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

  // QC wave-1 S-a: a top-level `version` key is reserved for the root
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
    }
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
      for (const key of ["base", "integration", "target"] as const) {
        if (doc.branch[key] !== undefined && (typeof doc.branch[key] !== "string" || doc.branch[key].trim() === "")) {
          violations.push(violation("medium", "workflow.snapshot.invalid-branch", `branch.${key} must be a non-empty string`));
        }
      }
    }
  }

  if (doc.control_worktree_path !== undefined) {
    validateNonEmptyString(
      violations,
      doc.control_worktree_path,
      "control_worktree_path",
      "workflow.snapshot.missing-control-worktree-path",
      "workflow.snapshot.invalid-control-worktree-path",
    );
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

  // Terminal invariants (plan Task 2): ended_at present, no dangling leases.
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

/**
 * Write a workflow snapshot as a whole-rewrite of `dir/snapshot.json` under
 * `withStatusWriteLock(snapshotPath)` (plan Task 2 — the `.status-write.lockdir`
 * lands inside `workflows/<id>/`, dirname of the snapshot; no harness-root
 * pollution). The snapshot is validated first — an invalid snapshot throws
 * and nothing is written. `dir` is created recursively.
 */
export async function writeWorkflowSnapshot(snapshot: WorkflowSnapshot, dir: string): Promise<void> {
  const gate = validateWorkflowSnapshot(snapshot);
  if (!gate.ok) {
    const detail = gate.violations.map((v) => v.message).join("; ");
    throw new Error(`refusing to write invalid workflow snapshot: ${detail}`);
  }
  const snapshotPath = join(dir, WORKFLOW_SNAPSHOT_FILE);
  // simplify: whole-rewrite snapshot on every state change (temp+rename via
  // writeJson under the workflow lockdir) — the ceiling is O(plans[] × row
  // payload) per write; unbounded inputs already divert to notes.jsonl at
  // migrate time. Upgrade path: append-only delta file or per-row files +
  // compaction when a lifecycle exceeds ~N plans / large per-row payloads.
  // The lockdir mkdir is non-recursive — the snapshot dir must exist before
  // acquisition (the lockdir lands inside `dir`, dirname of the snapshot).
  mkdirSync(dir, { recursive: true });
  await withStatusWriteLock(snapshotPath, () => {
    writeJson(snapshotPath, snapshot);
  });
}
