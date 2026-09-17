/**
 * Package-private coordination write layer — NOT a second public API and
 * deliberately NOT re-exported from `index.ts`. It holds the things
 * `coordination.ts` and the routed writers must share without an import
 * cycle (`coordination.ts` → `store.ts`/`workflow.ts` → here):
 *
 * 1. `CoordinationError` + the stable refusal codes (the consumer contract;
 *    wording is not).
 * 2. The private authorization context for protected filesystem writes
 *    (spec §C4): a protected target (`status.json`, a workflow
 *    `snapshot.json`, a project `residuals.json`, reachable directly or via
 *    a `json`/symlink alias) may only be written from inside
 *    `withProtectedWrite(...)` — an authorization that names the canonical
 *    target and the operation, never a caller-supplied boolean.
 *    `FsStore.put/delete` reject everything else with
 *    `coordination.direct-write-refused`.
 * 3. The stored coordination shapes and their strict validators, shared by
 *    `workflow.ts` (which refuses to persist a malformed coordination
 *    block) and `coordination.ts` (which builds them). `workflow.ts` cannot
 *    import `coordination.ts` — that would close an ESM cycle back through
 *    `store.ts` — so the shapes live here, next to the raw-byte artifact
 *    version (`sha256:<64 hex>`, missing = `absent`) used by the CAS
 *    writers.
 *
 * Import discipline: this module imports only `node:*` and `./core.js`
 * (a leaf, type-only here) so it can be imported from `store.ts` without
 * creating an ESM cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ValidationResult } from "./core.js";

/** Stable refusal codes of the scoped coordination surface (spec §C4). */
export const COORDINATION_ERROR_CODES = [
  "coordination.harness-not-found",
  "coordination.workflow-not-found",
  "coordination.plan-not-found",
  "coordination.scope-mismatch",
  "coordination.path-mismatch",
  "coordination.assignment-invalid",
  "coordination.assignment-stale",
  "coordination.not-prepared",
  "coordination.duplicate-holder",
  "coordination.session-mismatch",
  "coordination.session-not-found",
  "coordination.session-role",
  "coordination.version-conflict",
  "coordination.expected-version-required",
  "coordination.invalid-transition",
  "coordination.invalid-input",
  "coordination.forbidden-field",
  "coordination.not-in-git",
  "coordination.git-unavailable",
  "coordination.git-proof",
  "coordination.evidence-stale",
  "coordination.integration-unresolved",
  "coordination.integration-diverged",
  "coordination.local-store-required",
  "coordination.direct-write-refused",
  "coordination.scoped-writer-required",
  "coordination.unknown-operation",
  "coordination.store",
  // Prepare amendment refusals (the guarded Prepare-stage amendment contract
  // § Admission and mutation): one code per documented reason, so a caller
  // branches on the exact refusal instead of parsing the message.
  "coordination.prepare-amendment.stale",
  "coordination.prepare-amendment.invalid-patch",
  "coordination.prepare-amendment.not-prepare",
  "coordination.prepare-amendment.execution-started",
  "coordination.prepare-amendment.duplicate-plan",
  "coordination.prepare-amendment.invalid-plan",
  "coordination.prepare-amendment.compass-mismatch",
  "coordination.prepare-amendment.invalid-worktree",
] as const;

export type CoordinationErrorCode = (typeof COORDINATION_ERROR_CODES)[number];

/**
 * Stable exception of the coordination surface: `code` is the consumer
 * contract, `details` carries the machine-readable context (path, expected,
 * actual, holder, …). Exported publicly from `coordination.ts`.
 */
export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: CoordinationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CoordinationError";
    this.code = code;
    this.details = details;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed string predicate. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** `sha256:<64 lowercase hex>` of the exact bytes handed in. */
export function artifactVersion(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** SHA-256 (bare lowercase hex) of the exact bytes handed in. */
export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Artifact bytes read once: payload + byte version from that same read. */
export type ArtifactBytes = { payload: unknown; version: string };

/**
 * Read an artifact once and derive both payload and version from the same
 * bytes. Missing file → `undefined` (the caller reports `absent`).
 * Malformed JSON throws (never a silent empty document).
 */
export function readArtifactBytes(filePath: string): ArtifactBytes | undefined {
  if (!existsSync(filePath)) return undefined;
  const bytes = readFileSync(filePath);
  const version = artifactVersion(bytes);
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CoordinationError("coordination.store", `Invalid JSON in ${filePath}: ${(error as Error).message}`, {
      path: filePath,
    });
  }
  return { payload, version };
}

/**
 * Canonicalize a target: realpath when it exists (symlinks resolved), else the
 * realpath of its nearest existing ancestor with the missing tail re-attached.
 * Aliases therefore collapse onto the real protected file whether or not the
 * leaf has been created yet, so a `json`/symlink ref can never dodge the
 * boundary. A lexical fallback would do exactly that: a symlinked parent stays
 * unresolved, the alias classifies as unprotected, and `put` creates the
 * protected document through it.
 *
 * The same rule as `path.ts#canonicalizeNearestExisting`, restated here because
 * `path.ts` imports this module (importing back would close an ESM cycle).
 */
export function canonicalTarget(target: string): string {
  const abs = resolve(target);
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(dir)) {
      try {
        return join(realpathSync(dir), ...tail);
      } catch {
        return abs;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return abs; // reached the filesystem root
    tail.unshift(basename(dir));
    dir = parent;
  }
}

/** Protected document class, decided by the caller's resolved path table. */
export type ProtectedWriteKind = "root" | "snapshot" | "register";

/** One live authorization: the canonical target it covers and the operation it permits. */
type WriteAuthorization = { target: string; operation: "put" | "delete" };

const writeAuthorizations = new AsyncLocalStorage<WriteAuthorization[]>();

/**
 * Run `fn` inside the private authorization context for `target`. Only the
 * locked coordination/writer implementation calls this; the context records
 * canonical target + operation, never a caller-supplied boolean, and nested
 * authorizations stack (a residual write authorizes both the snapshot and
 * the register it touches).
 */
export async function withProtectedWrite<T>(
  target: string,
  operation: "put" | "delete",
  fn: () => T | Promise<T>,
): Promise<T> {
  const inherited = writeAuthorizations.getStore() ?? [];
  return writeAuthorizations.run([...inherited, { target: canonicalTarget(target), operation }], async () => fn());
}

/** `true` when the current async context authorized exactly this target+operation. */
export function isWriteAuthorized(target: string, operation: "put" | "delete"): boolean {
  const active = writeAuthorizations.getStore();
  if (active === undefined || active.length === 0) return false;
  const canonical = canonicalTarget(target);
  return active.some((entry) => entry.target === canonical && entry.operation === operation);
}

/**
 * Refuse an un-authorized write to a protected target (spec §C4). The
 * target's class is decided by the store's resolved path table (never by
 * document content, which a caller could shape); the authorization is the
 * private context alone.
 */
export function assertProtectedWriteAuthorized(
  target: string,
  operation: "put" | "delete",
  kind: ProtectedWriteKind,
): void {
  const canonical = canonicalTarget(target);
  if (isWriteAuthorized(canonical, operation)) return;
  throw new CoordinationError(
    "coordination.direct-write-refused",
    `${canonical} is a protected coordination document (${kind}) \u2014 a raw store.${operation} is refused; use the coordination API (bind/prepare/progress/residual/handoff/accept/return/complete) or the locked writer`,
    { path: canonical, operation, kind },
  );
}

/** Exact-key contract: unknown keys anywhere are rejected before mutation. */
export function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new CoordinationError(
      "coordination.forbidden-field",
      `${what} accepts only ${allowed.join(", ")} \u2014 unexpected key(s): ${extra.join(", ")}`,
      { what, unexpected: extra, allowed: [...allowed] },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Stored coordination shapes (spec §C2 / §D)
 * ------------------------------------------------------------------ */

/** Row/progress status a plan session may report (`progress` op). */
export type PlanProgressStatus = "InProgress" | "InReview" | "Blocked";

/** Progress payload a plan session reports on its own row. */
export type PlanProgress = {
  status: PlanProgressStatus;
  summary: string;
  /** Canonical absolute artifacts inside the plan's own plan/SDD area. */
  evidence_paths: string[];
  /** L2 track branches reported for this plan (never main/integration). */
  track_branches?: string[];
};

/** Hash-pinned reference to a submitted evidence file. */
export type EvidenceRef = { path: string; sha256: string };

/** Handoff lifecycle state (`PlanHandoff.state`). */
export type HandoffState = "submitted" | "accepted" | "returned" | "integrating" | "merged" | "completed";

/** QC review outcome recorded on a handoff. */
export type HandoffQc = { decision: string; reports: EvidenceRef[]; consolidated: EvidenceRef };

/** QA verification outcome recorded on a handoff. */
export type HandoffQa = { gate: string; decision: string; report: EvidenceRef };

/** The single integration attempt recorded on a handoff. */
export type HandoffIntegration = {
  target_branch: string;
  worktree_path: string;
  base_sha: string;
  started_at: string;
  result_sha?: string;
  verified_at?: string;
};

/** The durable review package of one plan (spec §B `PlanHandoff`). */
export type PlanHandoff = {
  id: string;
  attempt: number;
  state: HandoffState;
  submitted_by: string;
  submitted_at: string;
  source_branch: string;
  source_sha: string;
  worktree_path: string;
  review_base: string;
  review_head: string;
  qc: HandoffQc;
  qa: HandoffQa;
  accepted_by?: string;
  accepted_at?: string;
  returned_at?: string;
  return_reason?: string;
  integration?: HandoffIntegration;
  completed_at?: string;
};

/** Coordinator-recorded preparation of one plan (spec §D `prepare`). */
export type PreparedCoordination = {
  assignment_path: string;
  assignment_sha256: string;
  plan_sha256: string;
  qa_gate: string;
  findings_cleanup: string;
  prepared_by: string;
  prepared_at: string;
};

/** A bound session: identity + the canonical envelope that proves it. */
export type CoordinatorBinding = { session_id: string; session_file: string; bound_at: string };

/** Snapshot-level coordination block (the workflow's coordinator). */
export type SnapshotCoordination = { coordinator: CoordinatorBinding };

/** Row-level coordination block (one plan). */
export type RowCoordination = {
  revision: number;
  prepared?: PreparedCoordination;
  session?: CoordinatorBinding;
  progress?: PlanProgress;
  handoff?: PlanHandoff;
};

export const HANDOFF_STATES: readonly HandoffState[] = [
  "submitted",
  "accepted",
  "returned",
  "integrating",
  "merged",
  "completed",
];

export const PLAN_PROGRESS_STATUSES: readonly PlanProgressStatus[] = ["InProgress", "InReview", "Blocked"];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function invalid(code: string, message: string): ValidationResult {
  return { ok: false, severity: "high", code, message };
}

function validateBinding(value: unknown, what: string): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.binding-shape", `${what} must be an object`)];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !["session_id", "session_file", "bound_at"].includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.binding-field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (!isNonEmptyString(value.session_id)) {
    violations.push(invalid("coordination.row.binding-field", `${what}.session_id must be a non-empty string`));
  }
  if (!isNonEmptyString(value.session_file) || !isAbsolute(String(value.session_file))) {
    violations.push(invalid("coordination.row.binding-field", `${what}.session_file must be an absolute path`));
  }
  if (!isNonEmptyString(value.bound_at)) {
    violations.push(invalid("coordination.row.binding-field", `${what}.bound_at must be a timestamp`));
  }
  return violations;
}

function validateEvidenceRef(value: unknown, what: string): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.evidence-shape", `${what} must be a hash-pinned reference`)];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !["path", "sha256"].includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.evidence-field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (!isNonEmptyString(value.path) || !isAbsolute(String(value.path))) {
    violations.push(invalid("coordination.row.evidence-field", `${what}.path must be an absolute path`));
  }
  if (!isNonEmptyString(value.sha256) || !SHA256_HEX.test(String(value.sha256))) {
    violations.push(invalid("coordination.row.evidence-field", `${what}.sha256 must be 64 lowercase hex`));
  }
  return violations;
}

/** Validate a stored `PlanProgress` (`status`, `summary`, `evidence_paths`, `track_branches`). */
export function validatePlanProgress(value: unknown, what = "coordination.progress"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.progress-shape", `${what} must be an object`)];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter(
    (key) => !["status", "summary", "evidence_paths", "track_branches"].includes(key),
  );
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.progress-field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (!PLAN_PROGRESS_STATUSES.includes(value.status as PlanProgressStatus)) {
    violations.push(
      invalid("coordination.row.progress-field", `${what}.status must be one of ${PLAN_PROGRESS_STATUSES.join(", ")}`),
    );
  }
  if (!isNonEmptyString(value.summary)) {
    violations.push(invalid("coordination.row.progress-field", `${what}.summary must be a non-empty string`));
  }
  if (!Array.isArray(value.evidence_paths) || !value.evidence_paths.every(isNonEmptyString)) {
    violations.push(invalid("coordination.row.progress-field", `${what}.evidence_paths must be an array of paths`));
  }
  if (value.track_branches !== undefined) {
    if (!Array.isArray(value.track_branches) || !value.track_branches.every(isNonEmptyString)) {
      violations.push(
        invalid("coordination.row.progress-field", `${what}.track_branches must be an array of branch names`),
      );
    }
  }
  return violations;
}

/** Route-aware stored handoff validation (spec A5). Default remains strict integration. */
export type RowValidationRoute = "integration" | "standalone-development";

/** Validate a stored `PlanHandoff`, including its state/field coherence. */
export function validatePlanHandoff(
  value: unknown,
  what = "coordination.handoff",
  route: RowValidationRoute = "integration",
): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.handoff-shape", `${what} must be an object`)];
  const allowed = [
    "id",
    "attempt",
    "state",
    "submitted_by",
    "submitted_at",
    "source_branch",
    "source_sha",
    "worktree_path",
    "review_base",
    "review_head",
    "qc",
    "qa",
    "accepted_by",
    "accepted_at",
    "returned_at",
    "return_reason",
    "integration",
    "completed_at",
  ];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.handoff-field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  const required = [
    "id",
    "attempt",
    "state",
    "submitted_by",
    "submitted_at",
    "source_branch",
    "source_sha",
    "worktree_path",
    "review_base",
    "review_head",
  ];
  for (const key of required) {
    if (value[key] === undefined) {
      violations.push(invalid("coordination.row.handoff-field", `${what}.${key} is required`));
    }
  }
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) {
    violations.push(invalid("coordination.row.handoff-field", `${what}.attempt must be a positive integer`));
  }
  if (!HANDOFF_STATES.includes(value.state as HandoffState)) {
    violations.push(invalid("coordination.row.handoff-field", `${what}.state must be one of ${HANDOFF_STATES.join(", ")}`));
  }
  if (value.id !== undefined && !isNonEmptyString(value.id)) {
    violations.push(invalid("coordination.row.handoff-field", `${what}.id must be a non-empty string`));
  }
  for (const key of ["source_sha", "review_base", "review_head"]) {
    if (value[key] !== undefined && !GIT_SHA.test(String(value[key]))) {
      violations.push(invalid("coordination.row.handoff-field", `${what}.${key} must be a 40-hex git object id`));
    }
  }
  for (const key of ["submitted_at", "accepted_at", "returned_at", "completed_at"]) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) {
      violations.push(invalid("coordination.row.handoff-field", `${what}.${key} must be a timestamp`));
    }
  }
  if (value.worktree_path !== undefined && (!isNonEmptyString(value.worktree_path) || !isAbsolute(String(value.worktree_path)))) {
    violations.push(invalid("coordination.row.handoff-field", `${what}.worktree_path must be an absolute path`));
  }
  if (value.qc !== undefined) {
    if (!isPlainObject(value.qc)) {
      violations.push(invalid("coordination.row.handoff-shape", `${what}.qc must be an object`));
    } else {
      const qc = value.qc;
      const qcExtra = Object.keys(qc).filter((key) => !["decision", "reports", "consolidated"].includes(key));
      if (qcExtra.length > 0) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qc has unexpected key(s): ${qcExtra.join(", ")}`));
      }
      if (!isNonEmptyString(qc.decision)) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qc.decision must be a non-empty string`));
      }
      if (!Array.isArray(qc.reports) || qc.reports.length === 0) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qc.reports must be a non-empty array`));
      } else {
        qc.reports.forEach((ref, index) => {
          violations.push(...validateEvidenceRef(ref, `${what}.qc.reports[${index}]`));
        });
      }
      violations.push(...validateEvidenceRef(qc.consolidated, `${what}.qc.consolidated`));
    }
  }
  if (value.qa !== undefined) {
    if (!isPlainObject(value.qa)) {
      violations.push(invalid("coordination.row.handoff-shape", `${what}.qa must be an object`));
    } else {
      const qa = value.qa;
      const qaExtra = Object.keys(qa).filter((key) => !["gate", "decision", "report"].includes(key));
      if (qaExtra.length > 0) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qa has unexpected key(s): ${qaExtra.join(", ")}`));
      }
      if (!isNonEmptyString(qa.gate)) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qa.gate must be a non-empty string`));
      }
      if (!isNonEmptyString(qa.decision)) {
        violations.push(invalid("coordination.row.handoff-field", `${what}.qa.decision must be a non-empty string`));
      }
      violations.push(...validateEvidenceRef(qa.report, `${what}.qa.report`));
    }
  }
  if (value.integration !== undefined) {
    if (!isPlainObject(value.integration)) {
      violations.push(invalid("coordination.row.handoff-shape", `${what}.integration must be an object`));
    } else {
      const integration = value.integration;
      const integrationAllowed = [
        "target_branch",
        "worktree_path",
        "base_sha",
        "started_at",
        "result_sha",
        "verified_at",
      ];
      const integrationExtra = Object.keys(integration).filter((key) => !integrationAllowed.includes(key));
      if (integrationExtra.length > 0) {
        violations.push(
          invalid("coordination.row.handoff-field", `${what}.integration has unexpected key(s): ${integrationExtra.join(", ")}`),
        );
      }
      for (const key of ["target_branch", "worktree_path", "base_sha", "started_at"]) {
        if (!isNonEmptyString(integration[key])) {
          violations.push(invalid("coordination.row.handoff-field", `${what}.integration.${key} is required`));
        }
      }
      for (const key of ["base_sha", "result_sha"]) {
        if (integration[key] !== undefined && !GIT_SHA.test(String(integration[key]))) {
          violations.push(
            invalid("coordination.row.handoff-field", `${what}.integration.${key} must be a 40-hex git object id`),
          );
        }
      }
      if (integration.result_sha !== undefined && integration.verified_at === undefined) {
        violations.push(
          invalid("coordination.row.handoff-field", `${what}.integration.result_sha requires verified_at`),
        );
      }
    }
  }
  if ((value.state === "integrating" || value.state === "merged" || value.state === "completed") && value.integration === undefined) {
    if (route === "standalone-development" && value.state === "completed") {
      if (value.completed_at === undefined) {
        violations.push(
          invalid("coordination.row.handoff-field", `${what}.state completed requires completed_at for a standalone handoff`),
        );
      }
    } else {
      violations.push(invalid("coordination.row.handoff-field", `${what}.state ${String(value.state)} requires integration`));
    }
  }
  return violations;
}

/** Validate a stored `PreparedCoordination`. */
export function validatePreparedCoordination(value: unknown, what = "coordination.prepared"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.prepared-shape", `${what} must be an object`)];
  const allowed = [
    "assignment_path",
    "assignment_sha256",
    "plan_sha256",
    "qa_gate",
    "findings_cleanup",
    "prepared_by",
    "prepared_at",
  ];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.prepared-field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  for (const key of allowed) {
    if (!isNonEmptyString(value[key])) {
      violations.push(invalid("coordination.row.prepared-field", `${what}.${key} is required`));
    }
  }
  if (value.assignment_path !== undefined && !isAbsolute(String(value.assignment_path))) {
    violations.push(invalid("coordination.row.prepared-field", `${what}.assignment_path must be absolute`));
  }
  for (const key of ["assignment_sha256", "plan_sha256"]) {
    if (value[key] !== undefined && !SHA256_HEX.test(String(value[key]))) {
      violations.push(invalid("coordination.row.prepared-field", `${what}.${key} must be 64 lowercase hex`));
    }
  }
  return violations;
}

/** Validate one plan row's `coordination` object (spec §C2). */
export function validateRowCoordination(
  value: unknown,
  what = "coordination",
  route: RowValidationRoute = "integration",
): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.shape", `${what} must be an object`)];
  const allowed = ["revision", "prepared", "session", "progress", "handoff"];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.row.field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    violations.push(invalid("coordination.row.revision", `${what}.revision must be a non-negative integer`));
  }
  if (value.prepared !== undefined) violations.push(...validatePreparedCoordination(value.prepared, `${what}.prepared`));
  if (value.session !== undefined) violations.push(...validateBinding(value.session, `${what}.session`));
  if (value.progress !== undefined) violations.push(...validatePlanProgress(value.progress, `${what}.progress`));
  if (value.handoff !== undefined) violations.push(...validatePlanHandoff(value.handoff, `${what}.handoff`, route));
  if (value.handoff !== undefined && value.session === undefined) {
    violations.push(invalid("coordination.row.handoff-field", `${what}.handoff requires a bound plan session`));
  }
  return violations;
}

/** Validate a snapshot's top `coordination` block (spec §C2). */
export function validateSnapshotCoordination(value: unknown, what = "coordination"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.snapshot.shape", `${what} must be an object`)];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => key !== "coordinator");
  if (extra.length > 0) {
    violations.push(invalid("coordination.snapshot.field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (value.coordinator === undefined) {
    violations.push(invalid("coordination.snapshot.field", `${what}.coordinator is required`));
  } else {
    violations.push(...validateBinding(value.coordinator, `${what}.coordinator`));
  }
  return violations;
}

/** Hash-pinned evidence reference for an absolute path, read from disk. */
export function evidenceRefOf(filePath: string): EvidenceRef {
  return { path: canonicalTarget(filePath), sha256: sha256Bytes(readFileSync(filePath)) };
}

/** Whether `value` is a well-formed `sha256:<64 hex>` artifact version. */
export function isArtifactVersion(value: unknown): value is string {
  return typeof value === "string" && (value === "absent" || HASH_RE.test(value));
}
