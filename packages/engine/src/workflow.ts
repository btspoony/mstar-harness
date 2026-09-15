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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GateResult, Severity, ValidationResult } from "./core.js";
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
import { validatePlanRow, type PlanRow } from "./status.js";
import { assertFsStorePath, getArtifactStore, type ArtifactStore } from "./store.js";

/** Snapshot file name inside `workflows/<id>/` ( — writer contract). */
export const WORKFLOW_SNAPSHOT_FILE = "snapshot.json";

/** Lifecycle status enum ( — terminal set = completed|failed|stopped). */
export const WORKFLOW_LIFECYCLE_STATUSES = ["running", "paused", "completed", "failed", "stopped"] as const;

/** Terminal statuses: snapshot must carry `ended_at` and no dangling leases. */
export const WORKFLOW_TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const;

/** Lifecycle type enum ( — id reuses the orchestration id). */
export const WORKFLOW_LIFECYCLE_TYPES = ["plan", "iteration"] as const;

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
  base?: string;
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
      for (const key of ["base", "integration", "target"] as const) {
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
 * Snapshot scalar fields a phase-advancing caller may additionally change on
 * top of the always-allowed `phase` / `updated_at`. Everything else must come
 * back byte-identical to disk (spec §C4: the writer refuses to drop any plan
 * row, lease, coordination block or track-branch metadata it was not
 * explicitly given authority over).
 */
export type SnapshotField = "status" | "ended_at" | "type" | "started_at";

/**
 * Writer contract (spec §C4). `expectedVersion` is the CAS token — the exact
 * on-disk artifact version (`sha256:<64 hex>`), or `"absent"` for
 * create-only. `createOnly` is the locked `absent` shorthand used by the
 * scaffold/migrate/audit writers: an existing document (even an empty or
 * malformed one) is never silently replaced. `authority` widens the allowed
 * scalar delta; the coordination writer does not go through this function.
 */
export type WriteWorkflowSnapshotOptions = {
  expectedVersion?: string;
  createOnly?: boolean;
  authority?: readonly SnapshotField[];
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
      `expectedVersion must be "absent" or sha256:<64 hex> — got ${JSON.stringify(opts.expectedVersion)}`,
      { expected: opts.expectedVersion },
    );
  }
  if (opts.createOnly === true && opts.expectedVersion !== undefined && opts.expectedVersion !== "absent") {
    throw new CoordinationError(
      "coordination.invalid-input",
      `createOnly implies expectedVersion "absent" — got ${JSON.stringify(opts.expectedVersion)}`,
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
    const required = opts.createOnly === true ? "absent" : opts.expectedVersion;
    if (required !== undefined && required !== currentVersion) {
      throw new CoordinationError(
        "coordination.version-conflict",
        `snapshot ${snapshotPath} is at ${currentVersion}, writer required ${required}`,
        { path: snapshotPath, expected: required, actual: currentVersion },
      );
    }
    const payload = current === undefined ? snapshot : mergeAuthorizedSnapshot(current.payload, snapshot, opts.authority ?? []);
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
 */
function assertCoordinatedSnapshotWriter(stored: unknown, snapshotPath: string, sessionPath: string | undefined): void {
  const coordination = isPlainObject(stored) ? stored.coordination : undefined;
  if (coordination === undefined) return;
  const bound = isPlainObject(coordination) && isPlainObject(coordination.coordinator) ? coordination.coordinator.session_file : undefined;
  if (sessionPath === undefined || typeof bound !== "string" || canonicalTarget(sessionPath) !== canonicalTarget(bound)) {
    throw new CoordinationError(
      "coordination.session-mismatch",
      `snapshot ${snapshotPath} is coordinated — replacement requires --session <coordinator envelope>`,
      { path: snapshotPath, expected: bound, actual: sessionPath },
    );
  }
}

/**
 * Apply the field-scoped delta contract against the stored document: only
 * `phase` + `updated_at` (plus the caller's explicit `authority`) may differ.
 * Every other field — plan rows, leases, the coordination block, track-branch
 * metadata, branch anchors — is taken from disk, so an authorized writer can
 * never drop or rewrite them implicitly.
 */
function mergeAuthorizedSnapshot(
  stored: unknown,
  incoming: WorkflowSnapshot,
  authority: readonly SnapshotField[],
): WorkflowSnapshot {
  if (!isPlainObject(stored)) {
    throw new CoordinationError(
      "coordination.version-conflict",
      "stored workflow snapshot is not an object — refusing a field-scoped rewrite over it",
      {},
    );
  }
  const allowed: string[] = ["phase", "updated_at", ...authority];
  const keys = new Set([...Object.keys(stored), ...Object.keys(incoming as Record<string, unknown>)]);
  const drifted = [...keys].filter(
    (key) =>
      !allowed.includes(key) &&
      stableJson(stored[key]) !== stableJson((incoming as unknown as Record<string, unknown>)[key]),
  );
  if (drifted.length > 0) {
    throw new CoordinationError(
      "coordination.direct-write-refused",
      `refusing snapshot write: field(s) ${drifted.join(", ")} differ from disk — this writer may only change ${allowed.join(", ")}`,
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

export type CloseWorkflowOptions = { endedAt: string };

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
 * A valid terminal snapshot is returned unchanged, including failed/stopped.
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
    if (snapshot.plans.some((row) => row.status !== "Done")) {
      throw new Error("refusing to close workflow: every plan row must be Done");
    }
    const completed: WorkflowSnapshot = { ...snapshot, status: "completed", ended_at: opts.endedAt, updated_at: opts.endedAt };
    // Strict terminal validation refuses both lease kinds without deleting them.
    await validateAndPutWorkflowSnapshot(store, completed, snapshotPath);
    return completed;
  });
}
