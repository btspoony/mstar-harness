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
 *    The ONE writer of a coordinated snapshot is the snapshot CAS writer
 *    (`workflow.ts#writeWorkflowSnapshot`): its field-scoped deltas
 *    (`mergePhaseProjection` — `phase` + `updated_at` only) and its
 *    lease-removal terminal close (`settleStoppedFileClaims`) both land the
 *    whole payload against the stored byte version, so the field-scoped guard
 *    is a property of that writer rather than a rule a second writer can skip.
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

/** Stable refusal codes of ordinary coordinator and protected workflow writes. */
export const COORDINATION_ERROR_CODES = [
  "coordination.harness-not-found",
  "coordination.workflow-not-found",
  "coordination.plan-not-found",
  "coordination.scope-mismatch",
  "coordination.path-mismatch",
  "coordination.session-not-found",
  "coordination.session-role",
  "coordination.invalid-session-id",
  // Identity acquisition refusals (prerequisite contract §3.1/§3.2): a fresh
  // coordinator envelope requires an explicitly acquired identity, so the two
  // ways an adapter-supplied tuple can fail get their own codes instead of
  // overloading `invalid-session-id` (a malformed value) or `scope-mismatch`
  // (an addressing error).
  "coordination.identity-missing",
  "coordination.identity-mismatch",
  "coordination.version-conflict",
  "coordination.invalid-transition",
  "coordination.prepare-status",
  "coordination.progress-phase",
  "coordination.progress-transition",
  "coordination.plan-status",
  "coordination.workflow-not-running",
  "coordination.merge-lease-foreign",
  "coordination.merge-lease-stopped-owner",
  "coordination.findings-open",
  "coordination.completion-frozen",
  "coordination.invalid-input",
  "coordination.forbidden-field",
  "coordination.not-in-git",
  "coordination.git-unavailable",
  "coordination.git-proof",
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
  // JSON Prepare coordinator-recovery refusals (prerequisite contract §3.3):
  // one code per documented reason. Deliberately NOT the DB recovery's verb
  // (`execution-workflow.ts` owns the active-store route with its token and
  // stop attestation) and not an alias of it — this family is file/JSON only.
  "coordination.identity-recovery.invalid-request",
  "coordination.identity-recovery.stale",
  "coordination.identity-recovery.not-prepare",
  "coordination.identity-recovery.execution-started",
  "coordination.identity-recovery.foreign-owner",
  "coordination.identity-recovery.unauthorized",
  "coordination.identity-recovery.operation-conflict",
  // The close's root-removal step (plan-workflow-lifecycle-contract §3 close
  // row): the terminal state is committed, but the root register could not be
  // read as a v2 register, so its entry could not be removed — an explicit
  // PARTIAL close the caller resolves by migrating the register and retrying.
  "coordination.root-register-unwritable",
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
    `${canonical} is a protected coordination document (${kind}); raw store.${operation} is refused. Use plan prepare/progress/issue-add/issue-close/complete or the documented workflow writer for this artifact`,
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

/** Coordinator progress reported for the explicitly addressed row. */
export type PlanProgressStatus = "InProgress" | "InReview" | "Blocked";
export type PlanProgress = {
  status: PlanProgressStatus;
  summary: string;
  evidence_paths: string[];
  track_branches?: string[];
};

/** Hash-pinned reference to a submitted evidence file. */
export type EvidenceRef = { path: string; sha256: string };
export type QaGate = "mandatory" | "pm-acceptance";
export type FindingsCleanupMode = "zero-residual" | "allow-residual";
export type PlanPrepareConfig = {
  worktreePath?: string;
  workingBranch?: string;
  qaGate?: QaGate;
  findingsCleanup?: FindingsCleanupMode;
};
export type CompletionEvidence = {
  source_sha?: string;
  review_base?: string;
  review_head?: string;
  qc: { decision: "Approve" | "Approve with residuals"; reports: string[]; consolidated: string };
  qa: { gate: QaGate; decision: "pass"; report: string };
};
export type IntegrationResultInput = { base_sha: string; result_sha: string };
export type CompletionRecord = {
  source_branch: string | null;
  source_sha: string | null;
  worktree_path: string | null;
  review_base: string | null;
  review_head: string | null;
  qc: { decision: string; reports: EvidenceRef[]; consolidated: EvidenceRef };
  qa: { gate: string; decision: string; report: EvidenceRef };
  integration?: { target_branch: string; worktree_path: string; base_sha: string; result_sha: string; verified_at: string };
  completed_by: string;
  completed_at: string;
};
export type PreparedCoordination = {
  qa_gate: QaGate;
  findings_cleanup: FindingsCleanupMode;
  prepared_by: string;
  prepared_at: string;
};
export type CoordinatorBinding = { session_id: string; session_file: string; bound_at: string };
export type CoordinationIdentityRecovery = {
  operation_id: string; request_hash: string; workflow_id: string; prior_session_id: string;
  session_id: string; authorization_ref: string; reason: string; stopped_session_ids: string[];
  snapshot_version_before: string; compass_version: string; recovered_at: string;
};
export type SnapshotCoordination = {
  coordinator: CoordinatorBinding;
  identity_recoveries?: CoordinationIdentityRecovery[];
};
export type RowCoordination = {
  revision: number;
  prepared?: PreparedCoordination;
  progress?: PlanProgress;
  completion?: CompletionRecord;
};
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

export type RowValidationRoute = "integration" | "standalone-development" | "standalone-report-only";

export function validatePreparedCoordination(value: unknown, what = "coordination.prepared"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.prepared-shape", `${what} must be an object`)];
  const allowed = ["qa_gate", "findings_cleanup", "prepared_by", "prepared_at"];
  const violations = Object.keys(value).filter((key) => !allowed.includes(key)).map((key) =>
    invalid("coordination.row.prepared-field", `${what} has unexpected key: ${key}`));
  if (!["mandatory", "pm-acceptance"].includes(String(value.qa_gate))) violations.push(invalid("coordination.row.prepared-field", `${what}.qa_gate is invalid`));
  if (!["zero-residual", "allow-residual"].includes(String(value.findings_cleanup))) violations.push(invalid("coordination.row.prepared-field", `${what}.findings_cleanup is invalid`));
  for (const key of ["prepared_by", "prepared_at"]) if (!isNonEmptyString(value[key])) violations.push(invalid("coordination.row.prepared-field", `${what}.${key} is required`));
  return violations;
}

function validateCompletionRecord(value: unknown, what: string, route: RowValidationRoute): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.completion-shape", `${what} must be an object`)];
  const allowed = ["source_branch", "source_sha", "worktree_path", "review_base", "review_head", "qc", "qa", "integration", "completed_by", "completed_at"];
  const violations = Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => invalid("coordination.row.completion-field", `${what} has unexpected key: ${key}`));
  const reportOnly = route === "standalone-report-only";
  if (!(reportOnly && value.source_branch === null) && !isNonEmptyString(value.source_branch)) {
    violations.push(invalid("coordination.row.completion-field", `${what}.source_branch must identify the recorded source branch`));
  }
  for (const key of ["completed_by", "completed_at"]) {
    if (!isNonEmptyString(value[key])) violations.push(invalid("coordination.row.completion-field", `${what}.${key} is required`));
  }
  for (const key of ["source_sha", "review_base", "review_head"]) {
    const item = value[key];
    if (!(reportOnly && item === null) && (typeof item !== "string" || !GIT_SHA.test(item))) {
      violations.push(invalid("coordination.row.completion-field", `${what}.${key} must be a full Git object id${reportOnly ? " or null" : ""}`));
    }
  }
  if (!(reportOnly && value.worktree_path === null) && (!isNonEmptyString(value.worktree_path) || !isAbsolute(value.worktree_path))) {
    violations.push(invalid("coordination.row.completion-field", `${what}.worktree_path must be an absolute source checkout${reportOnly ? " or null" : ""}`));
  }
  if (!isPlainObject(value.qc) || !["Approve", "Approve with residuals"].includes(String(value.qc.decision)) || !Array.isArray(value.qc.reports) || value.qc.reports.length === 0) {
    violations.push(invalid("coordination.row.completion-field", `${what}.qc must record approved QC reports`));
  } else {
    for (const [index, report] of value.qc.reports.entries()) violations.push(...validateEvidenceRef(report, `${what}.qc.reports[${index}]`));
    violations.push(...validateEvidenceRef(value.qc.consolidated, `${what}.qc.consolidated`));
  }
  if (!isPlainObject(value.qa) || !["mandatory", "pm-acceptance"].includes(String(value.qa.gate)) || value.qa.decision !== "pass") {
    violations.push(invalid("coordination.row.completion-field", `${what}.qa must record passing acceptance evidence`));
  } else {
    violations.push(...validateEvidenceRef(value.qa.report, `${what}.qa.report`));
  }
  if (route !== "integration" && value.integration !== undefined) {
    violations.push(invalid("coordination.row.completion-field", `${what}.integration is only valid for integration delivery`));
  }
  if (route === "integration" && value.integration === undefined) {
    violations.push(invalid("coordination.row.completion-field", `${what}.integration is required for verified integration delivery`));
  }
  if (value.integration !== undefined) {
    if (!isPlainObject(value.integration)) {
      violations.push(invalid("coordination.row.completion-field", `${what}.integration must be a verified merge record`));
    } else {
      const fields = ["target_branch", "worktree_path", "base_sha", "result_sha", "verified_at"];
      for (const key of Object.keys(value.integration)) if (!fields.includes(key)) violations.push(invalid("coordination.row.completion-field", `${what}.integration has unexpected key: ${key}`));
      for (const key of fields) if (!isNonEmptyString(value.integration[key])) violations.push(invalid("coordination.row.completion-field", `${what}.integration.${key} is required`));
      for (const key of ["base_sha", "result_sha"]) if (typeof value.integration[key] !== "string" || !GIT_SHA.test(value.integration[key])) violations.push(invalid("coordination.row.completion-field", `${what}.integration.${key} must be a full Git object id`));
      if (typeof value.integration.worktree_path !== "string" || !isAbsolute(value.integration.worktree_path)) violations.push(invalid("coordination.row.completion-field", `${what}.integration.worktree_path must be absolute`));
    }
  }
  return violations;
}

export function validateRowCoordination(value: unknown, what = "coordination", route: RowValidationRoute = "integration"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.row.shape", `${what} must be an object`)];
  const allowed = ["revision", "prepared", "progress", "completion"];
  const violations: ValidationResult[] = Object.keys(value).filter((key) => !allowed.includes(key)).map((key) => invalid("coordination.row.field", `${what} has unexpected key: ${key}`));
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) violations.push(invalid("coordination.row.revision", `${what}.revision must be a non-negative integer`));
  if (value.prepared !== undefined) violations.push(...validatePreparedCoordination(value.prepared, `${what}.prepared`));
  if (value.progress !== undefined) violations.push(...validatePlanProgress(value.progress, `${what}.progress`));
  if (value.completion !== undefined) violations.push(...validateCompletionRecord(value.completion, `${what}.completion`, route));
  return violations;
}


/**
 * Validate one stored coordinator-identity recovery record (prerequisite
 * contract §3.3). Strict in the same way the rest of this module is: the key
 * set is exact, every required field must be present and well formed, and the
 * hashes/versions must be the forms this module writes — an append-only audit
 * entry that cannot be read exactly is a malformed document, never a record
 * with optional halves.
 */
export function validateCoordinationIdentityRecovery(
  value: unknown,
  what = "coordination.identity_recoveries[]",
): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.recovery.shape", `${what} must be an object`)];
  const allowed = [
    "operation_id",
    "request_hash",
    "workflow_id",
    "prior_session_id",
    "session_id",
    "authorization_ref",
    "reason",
    "stopped_session_ids",
    "snapshot_version_before",
    "compass_version",
    "recovered_at",
  ];
  const violations: ValidationResult[] = [];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.recovery.field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  for (const key of [
    "operation_id",
    "workflow_id",
    "prior_session_id",
    "session_id",
    "authorization_ref",
    "reason",
    "recovered_at",
  ]) {
    if (!isNonEmptyString(value[key])) {
      violations.push(invalid("coordination.recovery.field", `${what}.${key} must be a non-empty string`));
    }
  }
  if (typeof value.request_hash !== "string" || !SHA256_HEX.test(value.request_hash)) {
    violations.push(invalid("coordination.recovery.hash", `${what}.request_hash must be a bare sha256 hex digest`));
  }
  for (const key of ["snapshot_version_before", "compass_version"]) {
    if (typeof value[key] !== "string" || !HASH_RE.test(value[key])) {
      violations.push(invalid("coordination.recovery.version", `${what}.${key} must be a "sha256:<64 hex>" version`));
    }
  }
  const stopped = value.stopped_session_ids;
  if (!Array.isArray(stopped) || stopped.length === 0) {
    violations.push(invalid("coordination.recovery.stopped", `${what}.stopped_session_ids must be a non-empty array`));
  } else if (stopped.some((entry) => !isNonEmptyString(entry))) {
    violations.push(
      invalid("coordination.recovery.stopped", `${what}.stopped_session_ids entries must be non-empty strings`),
    );
  }
  return violations;
}

/**
 * Validate a snapshot's top `coordination` block (spec §C2) plus its
 * coordinator-identity recovery history.
 */
export function validateSnapshotCoordination(value: unknown, what = "coordination"): ValidationResult[] {
  if (!isPlainObject(value)) return [invalid("coordination.snapshot.shape", `${what} must be an object`)];
  const violations: ValidationResult[] = [];
  const allowed = ["coordinator", "identity_recoveries"];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    violations.push(invalid("coordination.snapshot.field", `${what} has unexpected key(s): ${extra.join(", ")}`));
  }
  if (value.coordinator === undefined) {
    violations.push(invalid("coordination.snapshot.field", `${what}.coordinator is required`));
  } else {
    violations.push(...validateBinding(value.coordinator, `${what}.coordinator`));
  }
  if (value.identity_recoveries !== undefined) {
    if (!Array.isArray(value.identity_recoveries)) {
      violations.push(invalid("coordination.snapshot.field", `${what}.identity_recoveries must be an array`));
    } else {
      value.identity_recoveries.forEach((entry, index) => {
        violations.push(...validateCoordinationIdentityRecovery(entry, `${what}.identity_recoveries[${String(index)}]`));
      });
    }
  }
  return violations;
}

/** Hash-pinned evidence reference for an absolute path, read from disk. */
export function evidenceRefOf(filePath: string): EvidenceRef {
  return { path: canonicalTarget(filePath), sha256: sha256Bytes(readFileSync(filePath)) };
}



