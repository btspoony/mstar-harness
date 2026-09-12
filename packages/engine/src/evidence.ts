/**
 * Pure SDD test-evidence contract: record schema validation, retained
 * artifact verification, deterministic input fingerprinting and reuse
 * assessment.
 *
 * Values in, decisions out. This module performs no filesystem, process,
 * Git or network access; its only host interaction is SHA-256 via
 * `node:crypto`. Malformed unknown records yield `GateResult` violations
 * (never thrown) from the public validators; the typed digest helper
 * throws `TypeError` on out-of-contract direct input instead of guessing.
 *
 * Four separate outputs stay separate everywhere:
 * - integrity — do the retained artifacts match the recorded facts?
 * - outcome — what did the recorded child process actually do?
 * - applicability — may this evidence still back the current declared
 *   inputs?
 * - coverage — always review-required; a machine result never decides it.
 *
 * Applicability follows one fixed first-match order (integrity failure,
 * absent target, unknown/unstable/repository/coverage conditions, failed
 * outcome, known-difference comparison), and provenance-only facts (head,
 * branch, dirty state, tool resolve path) never change the input digest.
 */
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { GateResult, ValidationResult } from "./core.js";
import type { SddExecutionContext } from "./sdd.js";
import { assertSafePathComponent } from "./path.js";

export type EvidenceEnvironmentKey = "CI" | "NODE_ENV" | "TZ" | "LANG";
export type EvidenceInputSpec = {
  path: string;
  kind: "file" | "directory";
  purpose: "source" | "test" | "fixture" | "config" | "dependency";
};
export type EvidenceCoverage = {
  acIds: string[];
  behavior: string;
  declaration: "reviewed" | "unknown";
  sourceRationale: string;
  dependencyRationale: string;
  runtimeRationale: string;
  environmentRationale: string;
};
export type EvidenceLimits = {
  timeoutMs: number;
  maxLogBytesPerStream: number;
  maxInputBytes: number;
  maxInputEntries: number;
  maxInputMs: number;
  maxSnapshotBytes: number;
};
export type EvidenceCaptureRequest = {
  context: SddExecutionContext;
  taskId: string;
  coverage: EvidenceCoverage;
  inputs: EvidenceInputSpec[];
  environmentKeys: EvidenceEnvironmentKey[];
  timeoutMs?: number;
};
export type EvidenceInputEntry = {
  path: string;
  kind: "file" | "directory" | "symlink" | "missing" | "unknown";
  sha256: string | null;
  bytes: number | null;
  executable: boolean | null;
  linkText: string | null;
  resolvedRelativePath: string | null;
  error: string | null;
};
export type EvidenceToolFingerprint = {
  requested: string;
  resolvedPath: string | null;
  sha256: string | null;
  bytes: number | null;
  platform: string;
  arch: string;
  runnerRuntimeVersion: string;
  error: string | null;
};
export type EvidenceInputSnapshot = {
  repoCommonDir: string | null;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  dirtyStatusSha256: string | null;
  entries: EvidenceInputEntry[];
  tool: EvidenceToolFingerprint;
  environment: Partial<Record<EvidenceEnvironmentKey, string | null>>;
  unknowns: string[];
  stable: boolean;
  digest: string;
};
export type EvidenceOutcome =
  | { kind: "running" }
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout" }
  | { kind: "interrupted"; signal: "SIGINT" | "SIGTERM" }
  | { kind: "spawn-error"; code: string };
export type EvidenceLog = {
  path: "stdout.log" | "stderr.log";
  bytes: number;
  sha256: string | null;
  truncated: boolean;
};
export type SddEvidenceRecord = {
  schema: "mstar.sdd-evidence/v1";
  producer: { name: "mstar-harness"; version: string };
  runId: string;
  request: EvidenceCaptureRequest;
  command: { argv: string[]; cwd: string };
  startedAt: string;
  endedAt: string | null;
  state: "running" | "finished";
  outcome: EvidenceOutcome;
  before: EvidenceInputSnapshot;
  after: EvidenceInputSnapshot | null;
  logs: { stdout: EvidenceLog; stderr: EvidenceLog };
  limits: EvidenceLimits;
  captureErrors: string[];
  counts: null;
};
export type EvidenceArtifactFact = {
  path: "stdout.log" | "stderr.log";
  state: "regular" | "missing" | "symlink" | "other" | "unreadable";
  bytes: number | null;
  sha256: string | null;
};
export type EvidenceExpectation = { planId: string; taskId: string; runId: string };
export type EvidenceAssessment = {
  integrity: GateResult;
  outcome: "passed" | "failed" | "incomplete" | "unknown";
  applicability: "not-assessed" | "candidate" | "changed" | "uncertain";
  coverage: "review-required";
  changedInputs: string[];
  reasons: string[];
};

// ---------------------------------------------------------------------------
// Fixed v1 ceilings and shape constants. Retained records always carry these
// exact collection limits (only the effective timeout may differ from the
// default, and then only by explicit request override).
// ---------------------------------------------------------------------------

const EVIDENCE_SCHEMA = "mstar.sdd-evidence/v1";
const PRODUCER_NAME = "mstar-harness";

const ENVIRONMENT_KEYS: readonly EvidenceEnvironmentKey[] = ["CI", "NODE_ENV", "TZ", "LANG"];

const MAX_STRING = 4096;
const MAX_DIAGNOSTIC = 512;
const MAX_CAPTURE_ERRORS = 256;
const MAX_UNKNOWNS = 256;
const MAX_ARGV_ARGS = 256;
const MAX_ARG_CODE_UNITS = 65536;
const MAX_ARGV_UTF8_BYTES = 262144;
const MAX_INPUT_ROOTS = 1024;
const MAX_AC_IDS = 128;
const TIMEOUT_DEFAULT_MS = 600000;
const TIMEOUT_MIN_MS = 1;
const TIMEOUT_MAX_MS = 3600000;
const LOG_STREAM_CAP = 8388608;
const INPUT_BYTES_CAP = 536870912;
const INPUT_ENTRIES_CAP = 10000;
const INPUT_MS_CAP = 30000;
const SNAPSHOT_BYTES_CAP = 2097152;
// Entries are retained from a single pass; the total two-pass entry budget is
// split evenly across the collection passes, so a stored snapshot holds at
// most half of the capture-wide entry ceiling.
const MAX_RETAINED_ENTRIES = INPUT_ENTRIES_CAP / 2;

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const RECORD_KEYS = [
  "schema",
  "producer",
  "runId",
  "request",
  "command",
  "startedAt",
  "endedAt",
  "state",
  "outcome",
  "before",
  "after",
  "logs",
  "limits",
  "captureErrors",
  "counts",
] as const;
const REQUEST_REQUIRED_KEYS = ["context", "taskId", "coverage", "inputs", "environmentKeys"] as const;
const REQUEST_OPTIONAL_KEYS = ["timeoutMs"] as const;
const CONTEXT_KEYS = ["planId", "controlHarnessRoot", "featureCwd", "workingBranch", "planFile", "sddDir"] as const;
const COVERAGE_KEYS = [
  "acIds",
  "behavior",
  "declaration",
  "sourceRationale",
  "dependencyRationale",
  "runtimeRationale",
  "environmentRationale",
] as const;
const INPUT_SPEC_KEYS = ["path", "kind", "purpose"] as const;
const COMMAND_KEYS = ["argv", "cwd"] as const;
const PRODUCER_KEYS = ["name", "version"] as const;
const LOGS_KEYS = ["stdout", "stderr"] as const;
const LOG_KEYS = ["path", "bytes", "sha256", "truncated"] as const;
const LIMITS_KEYS = ["timeoutMs", "maxLogBytesPerStream", "maxInputBytes", "maxInputEntries", "maxInputMs", "maxSnapshotBytes"] as const;
const SNAPSHOT_KEYS = [
  "repoCommonDir",
  "head",
  "branch",
  "dirty",
  "dirtyStatusSha256",
  "entries",
  "tool",
  "environment",
  "unknowns",
  "stable",
  "digest",
] as const;
const ENTRY_KEYS = ["path", "kind", "sha256", "bytes", "executable", "linkText", "resolvedRelativePath", "error"] as const;
const TOOL_KEYS = ["requested", "resolvedPath", "sha256", "bytes", "platform", "arch", "runnerRuntimeVersion", "error"] as const;

const CODE_SCHEMA = "evidence.schema";
const CODE_IDENTITY = "evidence.identity";
const CODE_ARTIFACT_MISSING = "evidence.artifact.missing";
const CODE_ARTIFACT_TYPE = "evidence.artifact.type";
const CODE_ARTIFACT_SIZE = "evidence.artifact.size";
const CODE_ARTIFACT_HASH = "evidence.artifact.hash";
const CODE_INCOMPLETE = "evidence.incomplete";

const INPUT_PURPOSES: readonly EvidenceInputSpec["purpose"][] = ["source", "test", "fixture", "config", "dependency"];
const FACT_STATES: readonly EvidenceArtifactFact["state"][] = ["regular", "missing", "symlink", "other", "unreadable"];

// ---------------------------------------------------------------------------
// Small pure predicates and violation helpers.
// ---------------------------------------------------------------------------

function violation(code: string, message: string): ValidationResult {
  return { ok: false, severity: "high", code, message };
}

function gateOf(violations: ValidationResult[]): GateResult {
  return { ok: violations.length === 0, violations };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringBound(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return isStringBound(value, max) && value.length > 0;
}

/** Nonempty, not padding-only, no path separators or relative components. */
function isIdLike(value: unknown, max: number): value is string {
  return (
    isNonEmptyString(value, max) &&
    value.trim() === value &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isGitOid(value: unknown): value is string {
  return typeof value === "string" && GIT_OID_RE.test(value);
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Declared input roots: nonempty POSIX repo-relative paths without glob characters. */
function isInputSpecPath(value: unknown): value is string {
  if (!isNonEmptyString(value, MAX_STRING)) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/[*?[\]]/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Observed entry/target paths: nonempty repo-relative, no empty/dot components. */
function isRelativeEntryPath(value: unknown): value is string {
  if (!isNonEmptyString(value, MAX_STRING)) return false;
  if (value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function safePlanComponent(value: string): boolean {
  try {
    assertSafePathComponent(value, "plan id");
    return true;
  } catch {
    return false;
  }
}

function requireExactKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  what: string,
  out: ValidationResult[],
): void {
  const actual = new Set(Object.keys(obj));
  const missing = required.filter((key) => !actual.has(key));
  const known = new Set([...required, ...optional]);
  const extra = [...actual].filter((key) => !known.has(key));
  if (missing.length === 0 && extra.length === 0) return;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.slice().sort().join(", ")}`);
  if (extra.length > 0) parts.push(`unknown ${extra.slice().sort().join(", ")}`);
  out.push(violation(CODE_SCHEMA, `${what} has invalid keys: ${parts.join("; ")}`));
}

// ---------------------------------------------------------------------------
// Deterministic canonical serialization and the input digest.
// ---------------------------------------------------------------------------

const MAX_CANON_DEPTH = 32;
const DIGEST_NODE_BUDGET = 100000;

/**
 * Serialize one JSON-compatible value canonically: object keys sorted
 * lexically, arrays in their given order, scalars via `JSON.stringify`,
 * no whitespace. One algorithm shared by producer-side fingerprinting and
 * comparison, so both sides byte-match by construction. Cycles, depth over
 * 32 nesting levels, node-budget exhaustion and non-JSON values throw
 * `TypeError` — unknown-input validators catch and convert to schema
 * violations instead of allocating an unrestricted clone.
 */
function canonicalJson(value: unknown, depth: number, budget: { nodes: number }): string {
  if (depth > MAX_CANON_DEPTH) {
    throw new TypeError(`canonical serialization exceeded ${MAX_CANON_DEPTH} nesting levels (cycle or hostile shape)`);
  }
  budget.nodes -= 1;
  if (budget.nodes < 0) throw new TypeError("canonical serialization exceeded the node budget");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number is not JSON-serializable");
      return JSON.stringify(value);
    default:
      throw new TypeError(`unsupported value of type ${typeof value} is not JSON-serializable`);
    case "object":
      break;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => canonicalJson(item, depth + 1, budget));
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) throw new TypeError("unsupported object is not JSON-serializable");
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, budget)}`);
  return `{${parts.join(",")}}`;
}

/**
 * The digest projection of a snapshot: exactly `{ entries, tool,
 * environment, unknowns, stable }`. Entries are sorted by path and carry
 * every entry field. The tool projection drops `resolvedPath` so an
 * equivalent tool at a new checkout path compares by content. Provenance
 * diagnostics (common dir, HEAD, branch, dirty observations), timestamps
 * and the digest itself are excluded by omission.
 */
function digestProjection(snapshot: EvidenceInputSnapshot): Record<string, unknown> {
  const entries = snapshot.entries.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries: entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      sha256: entry.sha256,
      bytes: entry.bytes,
      executable: entry.executable,
      linkText: entry.linkText,
      resolvedRelativePath: entry.resolvedRelativePath,
      error: entry.error,
    })),
    tool: {
      requested: snapshot.tool.requested,
      sha256: snapshot.tool.sha256,
      bytes: snapshot.tool.bytes,
      platform: snapshot.tool.platform,
      arch: snapshot.tool.arch,
      runnerRuntimeVersion: snapshot.tool.runnerRuntimeVersion,
      error: snapshot.tool.error,
    },
    environment: snapshot.environment,
    unknowns: [...new Set(snapshot.unknowns)].sort(),
    stable: snapshot.stable,
  };
}

/**
 * SHA-256 over the canonical serialization of the snapshot projection.
 * Expects the typed, shape-bounded snapshot; out-of-contract direct input
 * (missing fields, cycles, non-JSON values) throws `TypeError` rather than
 * fabricating a digest. Public unknown-record validators catch that as an
 * `evidence.schema` violation. Never call full record validation from here.
 */
export function evidenceInputDigest(snapshot: EvidenceInputSnapshot): string {
  if (!isPlainObject(snapshot)) throw new TypeError("evidence input snapshot must be a plain object");
  for (const key of ["entries", "tool", "environment", "unknowns", "stable"]) {
    if (snapshot[key] === undefined) {
      throw new TypeError(`evidence input snapshot is missing required field "${key}"`);
    }
  }
  const canonical = canonicalJson(digestProjection(snapshot), 0, { nodes: DIGEST_NODE_BUDGET });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Record schema validation.
// ---------------------------------------------------------------------------

/**
 * Validate one retained evidence record. Malformed unknown input yields
 * `GateResult` violations (all severity high) and never throws. Checks the
 * exact property sets at every object level, the fixed v1 collection
 * limits, state/outcome/endedAt consistency, log slot literals and caps,
 * entry/tool/environment fact rules, command cwd agreement with the
 * recorded context, and recomputation of every snapshot digest.
 */
export function validateSddEvidenceRecord(record: unknown): GateResult {
  const out: ValidationResult[] = [];
  try {
    validateRecord(record, out);
  } catch (error) {
    out.push(violation(CODE_SCHEMA, `record validation failed unexpectedly: ${(error as Error).message}`));
  }
  return gateOf(out);
}

function validateRecord(record: unknown, out: ValidationResult[]): void {
  if (!isPlainObject(record)) {
    out.push(violation(CODE_SCHEMA, "record must be a JSON object"));
    return;
  }
  requireExactKeys(record, RECORD_KEYS, [], "SddEvidenceRecord", out);

  if (record.schema !== EVIDENCE_SCHEMA) {
    out.push(violation(CODE_SCHEMA, `record.schema must be "${EVIDENCE_SCHEMA}"; got ${JSON.stringify(record.schema ?? null)}`));
  }
  validateProducer(record.producer, out);
  if (!isStringBound(record.runId, 36) || !UUID_V4_RE.test(record.runId)) {
    out.push(violation(CODE_SCHEMA, `record.runId must be a canonical lowercase RFC4122 v4 UUID; got ${JSON.stringify(record.runId ?? null)}`));
  }

  const requestState = validateRequest(record.request, out);

  if (isPlainObject(record.command)) {
    requireExactKeys(record.command, COMMAND_KEYS, [], "record.command", out);
    const argv = record.command.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV_ARGS) {
      out.push(violation(CODE_SCHEMA, `record.command.argv must be a nonempty array of at most ${MAX_ARGV_ARGS} arguments`));
    } else {
      let totalBytes = 0;
      argv.forEach((arg, index) => {
        // Elements carry the size bound only: a literal empty argument is
        // legal argv bytes and must not invalidate a genuine capture.
        if (!isStringBound(arg, MAX_ARG_CODE_UNITS)) {
          out.push(violation(CODE_SCHEMA, `record.command.argv[${index}] must be a string of at most ${MAX_ARG_CODE_UNITS} code units`));
        }
        totalBytes += Buffer.byteLength(String(arg), "utf8");
      });
      if (totalBytes > MAX_ARGV_UTF8_BYTES) {
        out.push(violation(CODE_SCHEMA, `record.command.argv totals ${totalBytes} UTF-8 bytes, over the ${MAX_ARGV_UTF8_BYTES}-byte limit`));
      }
    }
    if (!isNonEmptyString(record.command.cwd, MAX_STRING)) {
      out.push(violation(CODE_SCHEMA, "record.command.cwd must be a nonempty string"));
    } else if (isPlainObject(record.request) && record.request.context instanceof Object) {
      const featureCwd = (record.request.context as Record<string, unknown>).featureCwd;
      if (record.command.cwd !== featureCwd) {
        out.push(violation(CODE_SCHEMA, `record.command.cwd must equal the recorded resolved context.featureCwd (${JSON.stringify(featureCwd ?? null)}); got ${JSON.stringify(record.command.cwd)}`));
      }
    }
  } else if (record.command !== undefined) {
    out.push(violation(CODE_SCHEMA, "record.command must be a JSON object"));
  }

  const startedOk = isIsoUtc(record.startedAt);
  if (!startedOk) {
    out.push(violation(CODE_SCHEMA, `record.startedAt must be a valid UTC ISO timestamp; got ${JSON.stringify(record.startedAt ?? null)}`));
  }
  if (record.endedAt !== null && !isIsoUtc(record.endedAt)) {
    out.push(violation(CODE_SCHEMA, `record.endedAt must be null or a valid UTC ISO timestamp; got ${JSON.stringify(record.endedAt)}`));
  }

  const stateOk = record.state === "running" || record.state === "finished";
  if (!stateOk) {
    out.push(violation(CODE_SCHEMA, `record.state must be "running" or "finished"; got ${JSON.stringify(record.state ?? null)}`));
  }
  const outcomeKind = validateOutcome(record.outcome, "record.outcome", out);

  if (stateOk && outcomeKind !== null) {
    if (record.state === "running" && outcomeKind !== "running") {
      out.push(violation(CODE_SCHEMA, `a running record requires outcome kind "running"; got ${JSON.stringify(outcomeKind)}`));
    }
    if (record.state === "finished" && outcomeKind === "running") {
      out.push(violation(CODE_SCHEMA, 'a finished record requires a non-running outcome'));
    }
  }
  if (record.state === "running") {
    if (record.endedAt !== null) out.push(violation(CODE_SCHEMA, 'a running record requires endedAt null'));
    if (record.after !== null) out.push(violation(CODE_SCHEMA, 'a running record requires after null'));
  } else if (record.state === "finished") {
    if (!isIsoUtc(record.endedAt)) {
      out.push(violation(CODE_SCHEMA, "a finished record requires a valid endedAt timestamp"));
    } else if (startedOk && Date.parse(record.endedAt) < Date.parse(record.startedAt as string)) {
      out.push(violation(CODE_SCHEMA, "record.endedAt must not precede record.startedAt"));
    }
    if (record.after === null || record.after === undefined) {
      out.push(violation(CODE_SCHEMA, "a finished record requires an after snapshot"));
    }
  }

  validateSnapshot(record.before, "record.before", requestState?.environmentKeys ?? null, out);
  if (record.state === "finished") {
    validateSnapshot(record.after, "record.after", requestState?.environmentKeys ?? null, out);
  } else if (record.after !== undefined && record.after !== null) {
    out.push(violation(CODE_SCHEMA, 'record.after must be null while the record is running'));
  }

  validateLogs(record.logs, record.state, out);

  validateLimits(record.limits, requestState?.timeoutMs ?? null, out);

  const captureErrors = record.captureErrors;
  if (!Array.isArray(captureErrors) || captureErrors.length > MAX_CAPTURE_ERRORS) {
    out.push(violation(CODE_SCHEMA, `record.captureErrors must be an array of at most ${MAX_CAPTURE_ERRORS} messages`));
  } else {
    captureErrors.forEach((message, index) => {
      if (!isNonEmptyString(message, MAX_DIAGNOSTIC)) {
        out.push(violation(CODE_SCHEMA, `record.captureErrors[${index}] must be a nonempty string of at most ${MAX_DIAGNOSTIC} characters`));
      }
    });
  }

  if (record.counts !== null) {
    out.push(violation(CODE_SCHEMA, "record.counts is null in this schema version; got a non-null value"));
  }
}

function validateProducer(producer: unknown, out: ValidationResult[]): void {
  if (!isPlainObject(producer)) {
    out.push(violation(CODE_SCHEMA, "record.producer must be a JSON object"));
    return;
  }
  requireExactKeys(producer, PRODUCER_KEYS, [], "record.producer", out);
  if (producer.name !== PRODUCER_NAME) {
    out.push(violation(CODE_SCHEMA, `record.producer.name must be "${PRODUCER_NAME}"; got ${JSON.stringify(producer.name ?? null)}`));
  }
  if (!isNonEmptyString(producer.version, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, "record.producer.version must be a nonempty string"));
  }
}

type RequestState = { environmentKeys: string[] | null; timeoutMs: number | null };

function validateRequest(request: unknown, out: ValidationResult[]): RequestState | null {
  if (!isPlainObject(request)) {
    out.push(violation(CODE_SCHEMA, "record.request must be a JSON object"));
    return null;
  }
  requireExactKeys(request, REQUEST_REQUIRED_KEYS, REQUEST_OPTIONAL_KEYS, "record.request", out);

  validateContext(request.context, out);
  if (!isIdLike(request.taskId, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `record.request.taskId must be a nonempty trimmed id without path semantics; got ${JSON.stringify(request.taskId ?? null)}`));
  }
  validateCoverage(request.coverage, out);
  validateInputSpecs(request.inputs, out);

  let environmentKeys: string[] | null = null;
  const rawKeys = request.environmentKeys;
  if (Array.isArray(rawKeys) && rawKeys.length <= ENVIRONMENT_KEYS.length) {
    const unique = new Set<string>(rawKeys as string[]);
    const allKnown = (rawKeys as unknown[]).every((key) => (ENVIRONMENT_KEYS as readonly string[]).includes(key as string));
    if (!allKnown || unique.size !== rawKeys.length) {
      out.push(violation(CODE_SCHEMA, `record.request.environmentKeys must be unique members of ${ENVIRONMENT_KEYS.join("/")}`));
    } else {
      environmentKeys = rawKeys as string[];
    }
  } else if (rawKeys !== undefined) {
    out.push(violation(CODE_SCHEMA, `record.request.environmentKeys must be an array of at most ${ENVIRONMENT_KEYS.length} keys`));
  }

  let timeoutMs: number | null = null;
  if (request.timeoutMs !== undefined) {
    if (typeof request.timeoutMs !== "number" || !Number.isInteger(request.timeoutMs) || request.timeoutMs < TIMEOUT_MIN_MS || request.timeoutMs > TIMEOUT_MAX_MS) {
      out.push(violation(CODE_SCHEMA, `record.request.timeoutMs must be an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`));
    } else {
      timeoutMs = request.timeoutMs;
    }
  }
  return { environmentKeys, timeoutMs };
}

function validateContext(context: unknown, out: ValidationResult[]): void {
  if (!isPlainObject(context)) {
    out.push(violation(CODE_SCHEMA, "record.request.context must be a JSON object"));
    return;
  }
  requireExactKeys(context, CONTEXT_KEYS, [], "record.request.context", out);
  if (!isNonEmptyString(context.planId, MAX_STRING) || !safePlanComponent(context.planId)) {
    out.push(violation(CODE_SCHEMA, `record.request.context.planId must be a single safe path component ([A-Za-z0-9._-]+); got ${JSON.stringify(context.planId ?? null)}`));
  }
  for (const key of ["controlHarnessRoot", "featureCwd", "planFile", "sddDir"] as const) {
    const value = context[key];
    if (!isNonEmptyString(value, MAX_STRING)) {
      out.push(violation(CODE_SCHEMA, `record.request.context.${key} must be a nonempty string`));
    } else if (!value.startsWith("/")) {
      out.push(violation(CODE_SCHEMA, `record.request.context.${key} must be an absolute path; got ${JSON.stringify(value)}`));
    }
  }
  if (!isNonEmptyString(context.workingBranch, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, "record.request.context.workingBranch must be a nonempty string"));
  }
}

function validateCoverage(coverage: unknown, out: ValidationResult[]): void {
  if (!isPlainObject(coverage)) {
    out.push(violation(CODE_SCHEMA, "record.request.coverage must be a JSON object"));
    return;
  }
  requireExactKeys(coverage, COVERAGE_KEYS, [], "record.request.coverage", out);
  const acIds = coverage.acIds;
  if (!Array.isArray(acIds) || acIds.length === 0 || acIds.length > MAX_AC_IDS) {
    out.push(violation(CODE_SCHEMA, `record.request.coverage.acIds must be a nonempty array of at most ${MAX_AC_IDS} ids`));
  } else {
    acIds.forEach((id, index) => {
      if (!isIdLike(id, MAX_STRING)) {
        out.push(violation(CODE_SCHEMA, `record.request.coverage.acIds[${index}] must be a nonempty trimmed id without path semantics`));
      }
    });
  }
  if (!isNonEmptyString(coverage.behavior, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, "record.request.coverage.behavior must be a nonempty string"));
  }
  if (coverage.declaration !== "reviewed" && coverage.declaration !== "unknown") {
    out.push(violation(CODE_SCHEMA, `record.request.coverage.declaration must be "reviewed" or "unknown"; got ${JSON.stringify(coverage.declaration ?? null)}`));
  }
  for (const key of ["sourceRationale", "dependencyRationale", "runtimeRationale", "environmentRationale"] as const) {
    // Presence-only check: the engine never judges the rationale's truth or
    // completeness. An empty selected environment key list still requires the
    // explicit environment rationale that no inherited env input affects the
    // claims; a caller that cannot state it must declare coverage unknown.
    if (!isNonEmptyString(coverage[key], MAX_STRING)) {
      out.push(violation(CODE_SCHEMA, `record.request.coverage.${key} must be a nonempty string`));
    }
  }
}

function validateInputSpecs(inputs: unknown, out: ValidationResult[]): void {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUT_ROOTS) {
    out.push(violation(CODE_SCHEMA, `record.request.inputs must be a nonempty array of at most ${MAX_INPUT_ROOTS} roots; empty inputs are invalid`));
    return;
  }
  inputs.forEach((spec, index) => {
    if (!isPlainObject(spec)) {
      out.push(violation(CODE_SCHEMA, `record.request.inputs[${index}] must be a JSON object`));
      return;
    }
    requireExactKeys(spec, INPUT_SPEC_KEYS, [], `record.request.inputs[${index}]`, out);
    if (!isInputSpecPath(spec.path)) {
      out.push(violation(CODE_SCHEMA, `record.request.inputs[${index}].path must be a nonempty POSIX repo-relative path without absolute, backslash, dot, dot-dot or glob components; got ${JSON.stringify(spec.path ?? null)}`));
    }
    if (spec.kind !== "file" && spec.kind !== "directory") {
      out.push(violation(CODE_SCHEMA, `record.request.inputs[${index}].kind must be "file" or "directory"; got ${JSON.stringify(spec.kind ?? null)}`));
    }
    if (!(INPUT_PURPOSES as readonly string[]).includes(spec.purpose as string)) {
      out.push(violation(CODE_SCHEMA, `record.request.inputs[${index}].purpose must be one of ${INPUT_PURPOSES.join("/")}; got ${JSON.stringify(spec.purpose ?? null)}`));
    }
  });
  // Duplicate or overlapping roots would give enumeration two owners.
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const spec of inputs) {
    if (!isPlainObject(spec) || !isInputSpecPath(spec.path)) continue;
    if (seen.has(spec.path)) {
      out.push(violation(CODE_SCHEMA, `record.request.inputs contains duplicate root "${spec.path}"`));
    }
    seen.add(spec.path);
    paths.push(spec.path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const ancestor = parts.slice(0, i).join("/");
      if (seen.has(ancestor)) {
        out.push(violation(CODE_SCHEMA, `record.request.inputs contains overlapping roots: "${ancestor}" and "${path}"`));
        break;
      }
    }
  }
}

function validateOutcome(outcome: unknown, what: string, out: ValidationResult[]): string | null {
  if (!isPlainObject(outcome)) {
    out.push(violation(CODE_SCHEMA, `${what} must be a JSON object`));
    return null;
  }
  const kind = outcome.kind;
  switch (kind) {
    case "running":
      requireExactKeys(outcome, ["kind"], [], what, out);
      break;
    case "exit":
      requireExactKeys(outcome, ["kind", "code"], [], what, out);
      if (!Number.isInteger(outcome.code)) {
        out.push(violation(CODE_SCHEMA, `${what}.code must be an integer; got ${JSON.stringify(outcome.code ?? null)}`));
      }
      break;
    case "signal":
      requireExactKeys(outcome, ["kind", "signal"], [], what, out);
      if (!isNonEmptyString(outcome.signal, MAX_STRING)) {
        out.push(violation(CODE_SCHEMA, `${what}.signal must be a nonempty string`));
      }
      break;
    case "timeout":
      requireExactKeys(outcome, ["kind"], [], what, out);
      break;
    case "interrupted":
      requireExactKeys(outcome, ["kind", "signal"], [], what, out);
      if (outcome.signal !== "SIGINT" && outcome.signal !== "SIGTERM") {
        out.push(violation(CODE_SCHEMA, `${what}.signal must be "SIGINT" or "SIGTERM"; got ${JSON.stringify(outcome.signal ?? null)}`));
      }
      break;
    case "spawn-error":
      requireExactKeys(outcome, ["kind", "code"], [], what, out);
      if (!isNonEmptyString(outcome.code, MAX_STRING)) {
        out.push(violation(CODE_SCHEMA, `${what}.code must be a nonempty string errno label`));
      }
      break;
    default:
      out.push(violation(CODE_SCHEMA, `${what}.kind must be one of running/exit/signal/timeout/interrupted/spawn-error; got ${JSON.stringify(kind ?? null)}`));
      return null;
  }
  return kind;
}

function validateLogs(logs: unknown, state: unknown, out: ValidationResult[]): void {
  if (!isPlainObject(logs)) {
    out.push(violation(CODE_SCHEMA, "record.logs must be a JSON object"));
    return;
  }
  requireExactKeys(logs, LOGS_KEYS, [], "record.logs", out);
  for (const slot of ["stdout", "stderr"] as const) {
    const log = logs[slot];
    if (!isPlainObject(log)) {
      out.push(violation(CODE_SCHEMA, `record.logs.${slot} must be a JSON object`));
      continue;
    }
    requireExactKeys(log, LOG_KEYS, [], `record.logs.${slot}`, out);
    const expectedPath = slot === "stdout" ? "stdout.log" : "stderr.log";
    if (log.path !== expectedPath) {
      out.push(violation(CODE_SCHEMA, `record.logs.${slot}.path literal must be "${expectedPath}"; got ${JSON.stringify(log.path ?? null)}`));
    }
    if (!isNonNegativeInt(log.bytes) || log.bytes > LOG_STREAM_CAP) {
      out.push(violation(CODE_SCHEMA, `record.logs.${slot}.bytes must be a nonnegative integer of at most ${LOG_STREAM_CAP}`));
    }
    if (typeof log.truncated !== "boolean") {
      out.push(violation(CODE_SCHEMA, `record.logs.${slot}.truncated must be a boolean`));
    }
    if (log.sha256 !== null && !isSha256Hex(log.sha256)) {
      out.push(violation(CODE_SCHEMA, `record.logs.${slot}.sha256 must be null or lowercase 64-hex`));
    }
    if (state === "finished" && !isSha256Hex(log.sha256)) {
      out.push(violation(CODE_SCHEMA, `a finished record requires record.logs.${slot}.sha256`));
    }
  }
}

function validateLimits(limits: unknown, requestTimeoutMs: number | null, out: ValidationResult[]): void {
  if (!isPlainObject(limits)) {
    out.push(violation(CODE_SCHEMA, "record.limits must be a JSON object"));
    return;
  }
  requireExactKeys(limits, LIMITS_KEYS, [], "record.limits", out);
  // The collection limits are fixed v1 constants; records never carry
  // fixture-sized budgets. The effective timeout equals the request
  // override when present, otherwise the fixed default.
  const fixed: [string, unknown, number][] = [
    ["maxLogBytesPerStream", limits.maxLogBytesPerStream, LOG_STREAM_CAP],
    ["maxInputBytes", limits.maxInputBytes, INPUT_BYTES_CAP],
    ["maxInputEntries", limits.maxInputEntries, INPUT_ENTRIES_CAP],
    ["maxInputMs", limits.maxInputMs, INPUT_MS_CAP],
    ["maxSnapshotBytes", limits.maxSnapshotBytes, SNAPSHOT_BYTES_CAP],
  ];
  for (const [key, value, expected] of fixed) {
    if (value !== expected) {
      out.push(violation(CODE_SCHEMA, `record.limits.${key} must be the fixed value ${expected}; got ${JSON.stringify(value ?? null)}`));
    }
  }
  const effectiveTimeout = requestTimeoutMs ?? TIMEOUT_DEFAULT_MS;
  if (limits.timeoutMs !== effectiveTimeout) {
    out.push(violation(CODE_SCHEMA, `record.limits.timeoutMs must agree with record.request.timeoutMs (or the ${TIMEOUT_DEFAULT_MS} default); got ${JSON.stringify(limits.timeoutMs ?? null)}, expected ${effectiveTimeout}`));
  }
}

function validateSnapshot(snapshot: unknown, what: string, environmentKeys: string[] | null, out: ValidationResult[]): void {
  const snapshotMark = out.length;
  if (!isPlainObject(snapshot)) {
    out.push(violation(CODE_SCHEMA, `${what} must be a JSON object or null`));
    return;
  }
  requireExactKeys(snapshot, SNAPSHOT_KEYS, [], what, out);

  if (snapshot.repoCommonDir !== null && !isNonEmptyString(snapshot.repoCommonDir, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `${what}.repoCommonDir must be null or a nonempty string`));
  }
  if (snapshot.head !== null && !isGitOid(snapshot.head)) {
    out.push(violation(CODE_SCHEMA, `${what}.head must be null or a lowercase 40/64-hex Git OID`));
  }
  if (snapshot.branch !== null && !isNonEmptyString(snapshot.branch, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `${what}.branch must be null or a nonempty string`));
  }
  if (snapshot.dirty !== null && typeof snapshot.dirty !== "boolean") {
    out.push(violation(CODE_SCHEMA, `${what}.dirty must be null or a boolean`));
  }
  if (snapshot.dirtyStatusSha256 !== null && !isSha256Hex(snapshot.dirtyStatusSha256)) {
    out.push(violation(CODE_SCHEMA, `${what}.dirtyStatusSha256 must be null or lowercase 64-hex`));
  }

  validateEntries(snapshot.entries, what, out);
  validateTool(snapshot.tool, what, out);

  const environment = snapshot.environment;
  if (!isPlainObject(environment)) {
    out.push(violation(CODE_SCHEMA, `${what}.environment must be a JSON object`));
  } else if (environmentKeys !== null) {
    const actual = Object.keys(environment).sort();
    const expected = environmentKeys.slice().sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      out.push(violation(CODE_SCHEMA, `${what}.environment must have exactly the requested keys [${expected.join(", ")}]; got [${actual.join(", ")}]`));
    }
    for (const [key, value] of Object.entries(environment)) {
      if (value !== null && !isStringBound(value, MAX_STRING)) {
        out.push(violation(CODE_SCHEMA, `${what}.environment["${key}"] must be a string of at most ${MAX_STRING} characters or null`));
      }
    }
  }

  const unknowns = snapshot.unknowns;
  if (!Array.isArray(unknowns) || unknowns.length > MAX_UNKNOWNS) {
    out.push(violation(CODE_SCHEMA, `${what}.unknowns must be an array of at most ${MAX_UNKNOWNS} messages`));
  } else {
    unknowns.forEach((message, index) => {
      if (!isNonEmptyString(message, MAX_DIAGNOSTIC)) {
        out.push(violation(CODE_SCHEMA, `${what}.unknowns[${index}] must be a nonempty string of at most ${MAX_DIAGNOSTIC} characters`));
      }
    });
  }

  if (typeof snapshot.stable !== "boolean") {
    out.push(violation(CODE_SCHEMA, `${what}.stable must be a boolean`));
  }

  if (!isSha256Hex(snapshot.digest)) {
    out.push(violation(CODE_SCHEMA, `${what}.digest must be lowercase 64-hex; got ${JSON.stringify(snapshot.digest ?? null)}`));
    return;
  }
  // Recompute the digest only over a structurally clean snapshot (marked at
  // this snapshot's start, so earlier sibling snapshots cannot suppress it);
  // a hostile shape must never throw out of the validator.
  if (out.length === snapshotMark) {
    validateDigest(snapshot, what, out);
  }
}

function validateEntries(entries: unknown, what: string, out: ValidationResult[]): void {
  if (!Array.isArray(entries)) {
    out.push(violation(CODE_SCHEMA, `${what}.entries must be an array`));
    return;
  }
  if (entries.length > MAX_RETAINED_ENTRIES) {
    out.push(violation(CODE_SCHEMA, `${what}.entries exceeds the retained-entry budget of ${MAX_RETAINED_ENTRIES}`));
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const label = `${what}.entries[${index}]`;
    if (!isPlainObject(entry)) {
      out.push(violation(CODE_SCHEMA, `${label} must be a JSON object`));
      return;
    }
    requireExactKeys(entry, ENTRY_KEYS, [], label, out);
    if (!isRelativeEntryPath(entry.path)) {
      out.push(violation(CODE_SCHEMA, `${label}.path must be a nonempty repo-relative path; got ${JSON.stringify(entry.path ?? null)}`));
    } else if (seen.has(entry.path)) {
      out.push(violation(CODE_SCHEMA, `${what}.entries contains duplicate path "${entry.path}"`));
    } else {
      seen.add(entry.path);
    }
    const nullsOk =
      (entry.sha256 === null || entry.sha256 === undefined) &&
      (entry.bytes === null || entry.bytes === undefined) &&
      (entry.executable === null || entry.executable === undefined) &&
      (entry.linkText === null || entry.linkText === undefined) &&
      (entry.resolvedRelativePath === null || entry.resolvedRelativePath === undefined);
    switch (entry.kind) {
      case "file":
        if (!isSha256Hex(entry.sha256) || !isNonNegativeInt(entry.bytes) || typeof entry.executable !== "boolean" || entry.error !== null) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "file" requires hash, nonnegative bytes, boolean executable and null error`));
        }
        if (entry.linkText !== null || entry.resolvedRelativePath !== null) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "file" must not carry link fields`));
        }
        break;
      case "directory":
      case "missing":
        if (!nullsOk || entry.error !== null) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "${String(entry.kind)}" must carry null hash/bytes/executable/link/error fields`));
        }
        break;
      case "symlink": {
        if (!isNonEmptyString(entry.linkText, MAX_STRING)) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "symlink" requires a nonempty linkText`));
          break;
        }
        const resolvedBranch =
          entry.resolvedRelativePath !== null &&
          entry.resolvedRelativePath !== undefined &&
          isRelativeEntryPath(entry.resolvedRelativePath) &&
          isSha256Hex(entry.sha256) &&
          isNonNegativeInt(entry.bytes) &&
          typeof entry.executable === "boolean" &&
          entry.error === null;
        const errorBranch =
          (entry.resolvedRelativePath === null || entry.resolvedRelativePath === undefined) &&
          entry.sha256 === null &&
          entry.bytes === null &&
          entry.executable === null &&
          isNonEmptyString(entry.error, MAX_STRING);
        if (!resolvedBranch && !errorBranch) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "symlink" requires either resolved target plus file facts, or an error with null hash fields`));
        }
        break;
      }
      case "unknown":
        if (!isNonEmptyString(entry.error, MAX_STRING) || !nullsOk) {
          out.push(violation(CODE_SCHEMA, `${label} of kind "unknown" requires a nonempty error and null fact fields`));
        }
        break;
      default:
        out.push(violation(CODE_SCHEMA, `${label}.kind must be one of file/directory/symlink/missing/unknown; got ${JSON.stringify(entry.kind ?? null)}`));
    }
  });
}

function validateTool(toolFp: unknown, what: string, out: ValidationResult[]): void {
  if (!isPlainObject(toolFp)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool must be a JSON object`));
    return;
  }
  requireExactKeys(toolFp, TOOL_KEYS, [], `${what}.tool`, out);
  if (!isNonEmptyString(toolFp.requested, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool.requested must be a nonempty string`));
  }
  if (toolFp.resolvedPath !== null && !isNonEmptyString(toolFp.resolvedPath, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool.resolvedPath must be null or a nonempty string`));
  }
  if (toolFp.sha256 !== null && !isSha256Hex(toolFp.sha256)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool.sha256 must be null or lowercase 64-hex`));
  }
  if (toolFp.bytes !== null && !isNonNegativeInt(toolFp.bytes)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool.bytes must be null or a nonnegative integer`));
  }
  for (const key of ["platform", "arch", "runnerRuntimeVersion"] as const) {
    if (!isNonEmptyString(toolFp[key], MAX_STRING)) {
      out.push(violation(CODE_SCHEMA, `${what}.tool.${key} must be a nonempty string`));
    }
  }
  if (toolFp.error !== null && !isNonEmptyString(toolFp.error, MAX_STRING)) {
    out.push(violation(CODE_SCHEMA, `${what}.tool.error must be null or a nonempty string`));
  }
  // A completely hashed regular executable carries both hash and bytes and
  // no error; anything less is unknown and must say why.
  const hashed = isSha256Hex(toolFp.sha256) && isNonNegativeInt(toolFp.bytes);
  const unknownFacts = toolFp.sha256 === null && toolFp.bytes === null && isNonEmptyString(toolFp.error, MAX_STRING);
  if (!hashed && !unknownFacts) {
    out.push(violation(CODE_SCHEMA, `${what}.tool must carry both hash and bytes, or null hash/bytes with a nonempty error`));
  }
  if (hashed && toolFp.error !== null) {
    out.push(violation(CODE_SCHEMA, `${what}.tool with a complete hash must not carry an error`));
  }
}

function validateDigest(snapshot: Record<string, unknown>, what: string, out: ValidationResult[]): void {
  try {
    const recomputed = evidenceInputDigest(snapshot as unknown as EvidenceInputSnapshot);
    if (recomputed !== snapshot.digest) {
      out.push(violation(CODE_SCHEMA, `${what}.digest does not match the recomputed fingerprint; the snapshot content and digest disagree`));
    }
  } catch (error) {
    out.push(violation(CODE_SCHEMA, `${what}.digest could not be recomputed: ${(error as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Artifact verification (integrity).
// ---------------------------------------------------------------------------

/**
 * Verify that the retained artifacts match the recorded facts and that the
 * record is complete: exactly one regular-file fact per fixed log slot,
 * exact bytes and hash, finished state, non-truncated logs and no capture
 * errors. A completed nonzero exit with complete artifacts verifies as
 * valid failure evidence — integrity is independent of the recorded
 * outcome. Gate codes are fixed; no hard-blocked override exists.
 */
export function verifySddEvidence(
  record: unknown,
  artifacts: readonly EvidenceArtifactFact[],
  expected: EvidenceExpectation,
): GateResult {
  const schemaGate = validateSddEvidenceRecord(record);
  if (!schemaGate.ok) return schemaGate;
  return verifyValidatedRecord(record as SddEvidenceRecord, artifacts, expected);
}

/**
 * Identity, artifact and completeness checks over an already
 * schema-validated record. Shared by `verifySddEvidence` and
 * `assessSddEvidenceReuse` so each public entry point validates the record
 * exactly once.
 */
function verifyValidatedRecord(
  rec: SddEvidenceRecord,
  artifacts: readonly EvidenceArtifactFact[],
  expected: EvidenceExpectation,
): GateResult {
  const out: ValidationResult[] = [];

  // Identity: the caller-supplied expectation must match the record, and the
  // recorded control layout must compose the expected plan's directory. No
  // historical lease or source-checkout validation happens here.
  const identity: string[] = [];
  if (rec.runId !== expected.runId) identity.push(`runId ${JSON.stringify(expected.runId)}`);
  if (rec.request.taskId !== expected.taskId) identity.push(`taskId ${JSON.stringify(expected.taskId)}`);
  if (rec.request.context.planId !== expected.planId) identity.push(`planId ${JSON.stringify(expected.planId)}`);
  const sddDir = rec.request.context.sddDir;
  if (basename(sddDir) !== expected.planId) {
    identity.push(`sddDir basename must be the expected plan id ${JSON.stringify(expected.planId)}`);
  }
  if (basename(dirname(sddDir)) !== "sdd") {
    identity.push('sddDir parent directory must be named "sdd"');
  }
  if (dirname(dirname(sddDir)) !== rec.request.context.controlHarnessRoot) {
    identity.push("sddDir must sit under the recorded control harness root");
  }
  for (const detail of identity) {
    out.push(violation(CODE_IDENTITY, `evidence identity mismatch: ${detail}`));
  }

  if (!Array.isArray(artifacts)) {
    out.push(violation(CODE_SCHEMA, "artifact facts must be an array"));
    return gateOf(out);
  }
  const bySlot = new Map<string, EvidenceArtifactFact[]>();
  for (const factItem of artifacts) {
    if (!isPlainObject(factItem)) {
      out.push(violation(CODE_SCHEMA, "each artifact fact must be a JSON object"));
      continue;
    }
    if (factItem.path !== "stdout.log" && factItem.path !== "stderr.log") {
      out.push(violation(CODE_SCHEMA, `artifact facts are restricted to the fixed stdout.log/stderr.log slots; got ${JSON.stringify(factItem.path ?? null)}`));
      continue;
    }
    if (!(FACT_STATES as readonly string[]).includes(factItem.state as string)) {
      out.push(violation(CODE_SCHEMA, `artifact fact state must be one of ${FACT_STATES.join("/")}; got ${JSON.stringify(factItem.state ?? null)}`));
      continue;
    }
    if (factItem.bytes !== null && !isNonNegativeInt(factItem.bytes)) {
      out.push(violation(CODE_SCHEMA, `artifact fact ${factItem.path} bytes must be null or a nonnegative integer`));
      continue;
    }
    if (factItem.sha256 !== null && !isSha256Hex(factItem.sha256)) {
      out.push(violation(CODE_SCHEMA, `artifact fact ${factItem.path} sha256 must be null or lowercase 64-hex`));
      continue;
    }
    const slot = bySlot.get(factItem.path) ?? [];
    slot.push(factItem as unknown as EvidenceArtifactFact);
    bySlot.set(factItem.path, slot);
  }

  for (const slot of ["stdout.log", "stderr.log"] as const) {
    const logKey = slot === "stdout.log" ? "stdout" : "stderr";
    const facts = bySlot.get(slot) ?? [];
    if (facts.length === 0) {
      out.push(violation(CODE_ARTIFACT_MISSING, `missing artifact fact for the fixed ${slot} slot`));
      continue;
    }
    if (facts.length > 1) {
      out.push(violation(CODE_ARTIFACT_TYPE, `exactly one fact is required for the fixed ${slot} slot; got ${facts.length}`));
      continue;
    }
    const artifact = facts[0];
    if (artifact.state === "missing") {
      out.push(violation(CODE_ARTIFACT_MISSING, `retained ${slot} is missing`));
      continue;
    }
    if (artifact.state !== "regular") {
      out.push(violation(CODE_ARTIFACT_TYPE, `retained ${slot} is not a verifiable regular file (state ${JSON.stringify(artifact.state)})`));
      continue;
    }
    const recorded = rec.logs[logKey];
    if (artifact.bytes !== recorded.bytes || artifact.bytes > LOG_STREAM_CAP) {
      out.push(violation(CODE_ARTIFACT_SIZE, `retained ${slot} has ${String(artifact.bytes)} bytes; the record requires exactly ${String(recorded.bytes)} within the ${LOG_STREAM_CAP}-byte cap`));
    }
    if (artifact.sha256 !== recorded.sha256) {
      out.push(violation(CODE_ARTIFACT_HASH, `retained ${slot} hash does not match the recorded hash; content was altered or is unverifiable`));
    }
  }

  if (rec.state !== "finished") {
    out.push(violation(CODE_INCOMPLETE, `record state is ${JSON.stringify(rec.state)}; only a finished record can verify complete evidence`));
  }
  if (rec.logs.stdout.truncated || rec.logs.stderr.truncated) {
    out.push(violation(CODE_INCOMPLETE, "a truncated log cannot verify complete evidence"));
  }
  if (rec.captureErrors.length > 0) {
    out.push(violation(CODE_INCOMPLETE, `capture errors prevent complete verification: ${rec.captureErrors.slice(0, 3).join("; ")}`));
  }

  return gateOf(out);
}

// ---------------------------------------------------------------------------
// Reuse assessment (outcome + applicability; coverage is always review).
// ---------------------------------------------------------------------------

function recordedOutcome(rec: SddEvidenceRecord): EvidenceAssessment["outcome"] {
  if (rec.state === "running") return "incomplete";
  const outcome = rec.outcome;
  if (outcome.kind === "exit") return outcome.code === 0 ? "passed" : "failed";
  if (outcome.kind === "spawn-error") return "failed";
  return "incomplete";
}

function entryEquals(a: EvidenceInputEntry, b: EvidenceInputEntry): boolean {
  return (
    a.path === b.path &&
    a.kind === b.kind &&
    a.sha256 === b.sha256 &&
    a.bytes === b.bytes &&
    a.executable === b.executable &&
    a.linkText === b.linkText &&
    a.resolvedRelativePath === b.resolvedRelativePath &&
    a.error === b.error
  );
}

function diffEntryPaths(a: readonly EvidenceInputEntry[], b: readonly EvidenceInputEntry[]): string[] {
  const mapB = new Map(b.map((entry) => [entry.path, entry]));
  const setA = new Set(a.map((entry) => entry.path));
  const diffs: string[] = [];
  for (const entry of a) {
    const other = mapB.get(entry.path);
    if (other === undefined || !entryEquals(entry, other)) diffs.push(entry.path);
  }
  for (const entry of b) {
    if (!setA.has(entry.path)) diffs.push(entry.path);
  }
  return diffs;
}

function toolEquals(a: EvidenceToolFingerprint, b: EvidenceToolFingerprint): boolean {
  return (
    a.requested === b.requested &&
    a.sha256 === b.sha256 &&
    a.bytes === b.bytes &&
    a.platform === b.platform &&
    a.arch === b.arch &&
    a.runnerRuntimeVersion === b.runnerRuntimeVersion &&
    a.error === b.error
  );
}

function environmentEquals(
  a: EvidenceInputSnapshot["environment"],
  b: EvidenceInputSnapshot["environment"],
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false;
  return keysA.every((key) => a[key as EvidenceEnvironmentKey] === b[key as EvidenceEnvironmentKey]);
}

/**
 * Does this snapshot contain facts the collector could not fully observe?
 * Unknown-kind or errored entries, recorded unknowns and an unhashed or
 * unresolved tool are all honest unknowns — they keep the snapshot
 * schema-valid but block a changed/candidate claim.
 */
function snapshotHasUnknowns(snapshot: EvidenceInputSnapshot): boolean {
  return (
    snapshot.unknowns.length > 0 ||
    snapshot.tool.error !== null ||
    snapshot.entries.some((entry) => entry.error !== null || entry.kind === "unknown")
  );
}

/**
 * What the target comparison lane needs from the current target snapshot.
 * `targetLaneOf` is the single place target-shaped reads happen; the caller
 * guards it so a malformed target cannot support comparison and degrades to
 * `unusableTargetLane` (unknown, no target-derived disclosure) instead of
 * throwing out of the public entry point.
 */
type TargetLane = {
  usable: boolean;
  paths: string[];
  toolDiffers: boolean;
  envDiffers: boolean;
  hasUnknowns: boolean;
  unknowns: string[];
  stable: boolean;
  repoCommonDir: string | null;
  head: string | null;
};

const unusableTargetLane: TargetLane = {
  usable: false,
  paths: [],
  toolDiffers: false,
  envDiffers: false,
  hasUnknowns: true,
  unknowns: [],
  stable: false,
  repoCommonDir: null,
  head: null,
};

function targetLaneOf(after: EvidenceInputSnapshot | null, target: EvidenceInputSnapshot): TargetLane {
  return {
    usable: true,
    paths: after !== null ? diffEntryPaths(after.entries, target.entries) : [],
    toolDiffers: after !== null && !toolEquals(after.tool, target.tool),
    envDiffers: after !== null && !environmentEquals(after.environment, target.environment),
    hasUnknowns: snapshotHasUnknowns(target),
    unknowns: target.unknowns,
    stable: target.stable,
    repoCommonDir: target.repoCommonDir,
    head: target.head,
  };
}

/**
 * Assess whether one retained evidence bundle still applies to the current
 * declared inputs. Read-only: no child execution, discovery, version probe
 * or write. The four outputs stay separate — a damaged log or an identity
 * mismatch never rewrites the recorded outcome, and a failed or incomplete
 * run can never become a reuse candidate. `changedInputs` discloses sorted
 * known differing paths (or `$tool`/`$environment`/`$repository` labels)
 * even when an earlier rule already forces uncertainty; no-target mode
 * returns an empty list. Digest equality is consulted only after the
 * preceding first-match checks, so an unknown marker never becomes a false
 * changed/candidate result. A malformed target snapshot is downgraded to
 * the unknown lane instead of throwing.
 */
export function assessSddEvidenceReuse(
  record: unknown,
  artifacts: readonly EvidenceArtifactFact[],
  expected: EvidenceExpectation,
  target?: EvidenceInputSnapshot,
): EvidenceAssessment {
  const schemaGate = validateSddEvidenceRecord(record);
  if (!schemaGate.ok) {
    return { integrity: schemaGate, outcome: "unknown", applicability: "uncertain", coverage: "review-required", changedInputs: [], reasons: ["evidence.integrity"] };
  }
  const integrity = verifyValidatedRecord(record as SddEvidenceRecord, artifacts, expected);
  const rec = record as SddEvidenceRecord;
  const outcome = recordedOutcome(rec);
  const reasons = new Set<string>();
  const changedInputs = new Set<string>();

  if (!integrity.ok) reasons.add("evidence.integrity");
  if (outcome === "failed") reasons.add("outcome.failed");
  if (outcome === "incomplete") reasons.add("outcome.incomplete");

  const after = rec.after;
  const beforeAfterMoved = after !== null && rec.before.digest !== after.digest;
  const beforeAfterPaths = after !== null ? diffEntryPaths(rec.before.entries, after.entries) : [];

  let lane = unusableTargetLane;
  if (target !== undefined) {
    try {
      lane = targetLaneOf(after, target);
    } catch {
      // A malformed target cannot support comparison; treat it as unknown.
      lane = unusableTargetLane;
    }
  }

  // Disclosure: known differences are reported even when an earlier
  // first-match rule already forces uncertainty, so reviewers keep the
  // useful gap without losing the uncertainty. No-target mode stays empty;
  // an unusable target discloses only record-derived movement.
  if (target !== undefined) {
    for (const path of beforeAfterPaths) changedInputs.add(path);
    if (lane.usable) {
      for (const path of lane.paths) changedInputs.add(path);
      if (lane.toolDiffers) changedInputs.add("$tool");
      if (lane.envDiffers) changedInputs.add("$environment");
      if (after !== null && after.repoCommonDir !== null && lane.repoCommonDir !== null && after.repoCommonDir !== lane.repoCommonDir) {
        changedInputs.add("$repository");
      }
    }
  }

  const declarationUnknown = rec.request.coverage.declaration === "unknown";

  let applicability: EvidenceAssessment["applicability"];
  if (target === undefined) {
    // Rules 1-2: an integrity failure is uncertain with or without a target;
    // only an integrity-valid run without a target is not-assessed.
    applicability = integrity.ok ? "not-assessed" : "uncertain";
    reasons.add("target.absent");
    if (snapshotHasUnknowns(rec.before) || (after !== null && snapshotHasUnknowns(after))) reasons.add("input.unknown");
    if (!rec.before.stable || (after !== null && !after.stable) || beforeAfterMoved) reasons.add("input.concurrent-change");
    if (rec.before.repoCommonDir === null || (after !== null && after.repoCommonDir === null)) reasons.add("input.repository");
    if (declarationUnknown) reasons.add("coverage.unknown");
  } else {
    // Rules 3-5: target comparison lanes.
    const recordUnknowns = snapshotHasUnknowns(rec.before) || (after !== null && snapshotHasUnknowns(after));
    const targetUnknown = !lane.usable || lane.hasUnknowns;
    const unstable = !rec.before.stable || (after !== null && !after.stable) || !lane.stable;
    const repoMissing =
      rec.before.repoCommonDir === null || (after !== null && after.repoCommonDir === null) || lane.repoCommonDir === null;
    const repoDifferent =
      after !== null && after.repoCommonDir !== null && lane.repoCommonDir !== null && after.repoCommonDir !== lane.repoCommonDir;
    const targetHeadMissing = lane.usable && lane.head === null;
    if (recordUnknowns || targetUnknown) reasons.add("input.unknown");
    if (targetHeadMissing) reasons.add("input.unknown");
    if (lane.usable && lane.unknowns.includes("target.expected-head-mismatch")) reasons.add("target.expected-head-mismatch");
    if (unstable || beforeAfterMoved) reasons.add("input.concurrent-change");
    if (repoMissing || repoDifferent) reasons.add("input.repository");
    if (declarationUnknown) reasons.add("coverage.unknown");

    if (!integrity.ok) {
      // Rule 1: integrity failure is uncertain whether or not a target exists.
      applicability = "uncertain";
    } else if (recordUnknowns || targetUnknown || unstable || beforeAfterMoved || repoMissing || repoDifferent || targetHeadMissing || declarationUnknown) {
      // Rule 3: any unknown/unstable/repository/coverage condition is
      // uncertain — never a changed/candidate claim.
      applicability = "uncertain";
    } else if (outcome !== "passed") {
      // Rule 4: failed or incomplete proof cannot satisfy a passing criterion.
      applicability = "uncertain";
    } else if (after !== null && (lane.paths.length > 0 || lane.toolDiffers || lane.envDiffers)) {
      // Rule 5: known differences in tested bytes, tool content or selected
      // environment.
      applicability = "changed";
      reasons.add("input.changed");
    } else {
      applicability = "candidate";
      reasons.add("reuse.candidate");
    }
  }

  return {
    integrity,
    outcome,
    applicability,
    coverage: "review-required",
    changedInputs: [...changedInputs].sort(),
    reasons: [...reasons].sort(),
  };
}
