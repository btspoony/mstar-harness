/**
 * Local SDD test-evidence facility (locked CLI evidence contract): input
 * collectors, the capture runner and the read-only
 * `sdd evidence capture|verify` commands.
 *
 * Division of labor (locked): the pure engine owns schema, digests over
 * supplied facts and comparison; this module alone reads files/Git,
 * launches the child, streams logs and stores the evidence bundle. Four
 * outputs stay separate everywhere — integrity, outcome, applicability and
 * coverage (always review-required).
 *
 * Capture is a new developer entry for an ALREADY-AUTHORIZED argv: it
 * resolves and gates the dispatched context (source cwd, launch, artifact
 * target) before any child, records literal argv without shell synthesis,
 * streams raw stdout/stderr into fixed-name logs under
 * `{SDD_DIR}/evidence/<run-uuid>/`, and finalizes a finished record with
 * the tagged outcome. POSIX linux/darwin only for capture; verify is
 * read-only and portable.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { performance } from "node:perf_hooks";
import pc from "picocolors";
import type { Command } from "commander";
import {
  assessSddEvidenceReuse,
  checkSddAction,
  evidenceInputDigest,
  readHarnessVersion,
  resolveSddExecutionContext,
  SddScriptError,
  validateSddEvidenceRecord,
  writeJson,
  type EvidenceArtifactFact,
  type EvidenceAssessment,
  type EvidenceCaptureRequest,
  type EvidenceEnvironmentKey,
  type EvidenceInputEntry,
  type EvidenceInputSnapshot,
  type EvidenceInputSpec,
  type EvidenceLimits,
  type EvidenceOutcome,
  type EvidenceToolFingerprint,
  type SddEvidenceRecord,
} from "@mstar-harness/engine";

export type CollectEvidenceInputsOptions = {
  cwd: string;
  inputs: readonly EvidenceInputSpec[];
  argv: readonly string[];
  environmentKeys: readonly EvidenceEnvironmentKey[];
  limits: EvidenceLimits;
};

export type EvidenceTargetRequest = {
  cwd: string;
  expectedHead: string;
  rationale: string;
};

// ---------------------------------------------------------------------------
// Fixed v1 constants (mirrors of the engine schema ceilings).
// ---------------------------------------------------------------------------

const EVIDENCE_SCHEMA = "mstar.sdd-evidence/v1";
const TIMEOUT_DEFAULT_MS = 600000;
const TIMEOUT_MIN_MS = 1;
const TIMEOUT_MAX_MS = 3600000;
const LOG_STREAM_CAP = 8388608;
const INPUT_BYTES_CAP = 536870912;
const INPUT_ENTRIES_CAP = 10000;
const INPUT_MS_CAP = 30000;
const SNAPSHOT_BYTES_CAP = 2097152;
const SNAPSHOT_RESERVED_BYTES = 262144;
const GIT_PROBE_TIMEOUT_MS = 5000;
const GIT_PROBE_CAP_BYTES = 8 * 1024 * 1024;
const MAX_GIT_PROBES_PER_SNAPSHOT = 8;
const MAX_PATH_ENTRIES = 256;
const MAX_PATH_UTF8_BYTES = 65536;
const READ_CHUNK_BYTES = 64 * 1024;
const REQUEST_FILE_CAP_BYTES = 512 * 1024;
const RECORD_FILE_CAP_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_ROOTS = 1024;
const MAX_AC_IDS = 128;
const MAX_ARGV_ARGS = 256;
const MAX_ARG_CODE_UNITS = 65536;
const MAX_ARGV_UTF8_BYTES = 262144;
const MAX_STRING = 4096;
const MAX_DIAGNOSTIC = 512;
const MAX_UNKNOWN_MESSAGES = 255;
const TERM_GRACE_MS = 2000;
const DRAIN_MS = 2000;
const ARTIFACT_READ_DEADLINE_MS = 10000;
const ENVIRONMENT_KEYS: readonly EvidenceEnvironmentKey[] = ["CI", "NODE_ENV", "TZ", "LANG"];
const INPUT_PURPOSES: readonly EvidenceInputSpec["purpose"][] = ["source", "test", "fixture", "config", "dependency"];
const REQUEST_KEYS: readonly string[] = ["context", "taskId", "coverage", "inputs", "environmentKeys", "timeoutMs"];

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;

const CAPTURE_USAGE =
  "usage: mstar sdd evidence capture --request <absolute-task-request.json> -- <executable> [args...]";
const VERIFY_USAGE =
  "usage: mstar sdd evidence verify --sdd-dir <absolute-dir> --plan <id> --task <id> --run <uuid> [--target <absolute-target.json>]";

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function usageError(message: string): SddScriptError {
  return new SddScriptError(message, 2);
}

function gateError(message: string): SddScriptError {
  return new SddScriptError(message, 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdLike(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STRING &&
    value.trim() === value &&
    SAFE_COMPONENT_RE.test(value)
  );
}

/** Declared input roots: nonempty POSIX repo-relative paths without globs. */
function isInputSpecPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/[*?[\]]/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function errnoLabel(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : (error as Error | null)?.message?.slice(0, 120) ?? "EUNKNOWN";
}

function bound(text: string, max = MAX_DIAGNOSTIC): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function v1Limits(timeoutMs: number = TIMEOUT_DEFAULT_MS): EvidenceLimits {
  return {
    timeoutMs,
    maxLogBytesPerStream: LOG_STREAM_CAP,
    maxInputBytes: INPUT_BYTES_CAP,
    maxInputEntries: INPUT_ENTRIES_CAP,
    maxInputMs: INPUT_MS_CAP,
    maxSnapshotBytes: SNAPSHOT_BYTES_CAP,
  };
}

/** Runtime metadata string: never launches a version probe. */
function runnerRuntimeVersion(): string {
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  return `node=${process.version};bun=${bunVersion ?? "absent"}`;
}

function signalExitNumber(signal: string): number {
  return (os.constants.signals as Record<string, number>)[signal] ?? 0;
}

/** Cap diagnostics: at most 255 sorted unique messages plus one truncation marker. */
function capDiagnostics(messages: string[]): string[] {
  const unique = [...new Set(messages.filter((m) => typeof m === "string" && m.length > 0).map((m) => bound(m)))].sort();
  if (unique.length <= MAX_UNKNOWN_MESSAGES) return unique;
  return [...unique.slice(0, MAX_UNKNOWN_MESSAGES), "diagnostics-truncated: additional diagnostics were dropped"];
}

/**
 * Cap captureErrors at the record schema bound: keep the first 255 events
 * in arrival order plus one explicit overflow marker, so an overflowing
 * capture still finalizes a valid record instead of failing record
 * self-validation after the child already ran.
 */
function capCaptureErrors(messages: string[]): string[] {
  if (messages.length <= MAX_UNKNOWN_MESSAGES) return messages;
  return [
    ...messages.slice(0, MAX_UNKNOWN_MESSAGES),
    `capture.errors-truncated: ${messages.length - MAX_UNKNOWN_MESSAGES} additional capture errors were dropped`,
  ];
}

// ---------------------------------------------------------------------------
// Usage validation (capture request, argv, collector options).
// ---------------------------------------------------------------------------

function validateArgvUsage(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw usageError(`${CAPTURE_USAGE}\n  The argv after -- is passed to the child literally (no shell).`);
  }
  if (typeof argv[0] !== "string" || argv[0].trim() === "") {
    throw usageError(`${CAPTURE_USAGE}\n  argv[0] must be a non-empty executable.`);
  }
  if (argv.length > MAX_ARGV_ARGS) {
    throw usageError(`${CAPTURE_USAGE}\n  argv accepts at most ${MAX_ARGV_ARGS} arguments.`);
  }
  let totalBytes = 0;
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_CODE_UNITS) {
      throw usageError(`${CAPTURE_USAGE}\n  each argv element must be a string of at most ${MAX_ARG_CODE_UNITS} code units.`);
    }
    totalBytes += Buffer.byteLength(arg, "utf8");
  }
  if (totalBytes > MAX_ARGV_UTF8_BYTES) {
    throw usageError(`${CAPTURE_USAGE}\n  argv totals ${totalBytes} UTF-8 bytes, over the ${MAX_ARGV_UTF8_BYTES}-byte limit.`);
  }
}

function validateCoverageUsage(coverage: unknown): void {
  if (!isPlainObject(coverage)) throw usageError("evidence capture request.coverage must be a JSON object");
  const acIds = coverage.acIds;
  if (!Array.isArray(acIds) || acIds.length === 0 || acIds.length > MAX_AC_IDS) {
    throw usageError(`evidence capture request.coverage.acIds must be a nonempty array of at most ${MAX_AC_IDS} ids`);
  }
  for (const id of acIds) {
    if (!isIdLike(id)) throw usageError("evidence capture request.coverage.acIds entries must be nonempty trimmed ids without path semantics");
  }
  if (typeof coverage.behavior !== "string" || coverage.behavior.length === 0 || coverage.behavior.length > MAX_STRING) {
    throw usageError("evidence capture request.coverage.behavior must be a nonempty string");
  }
  if (coverage.declaration !== "reviewed" && coverage.declaration !== "unknown") {
    throw usageError('evidence capture request.coverage.declaration must be "reviewed" or "unknown"');
  }
  for (const key of ["sourceRationale", "dependencyRationale", "runtimeRationale", "environmentRationale"] as const) {
    const value = coverage[key];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING) {
      throw usageError(`evidence capture request.coverage.${key} must be a nonempty string`);
    }
  }
}

function validateInputSpecsUsage(inputs: unknown): EvidenceInputSpec[] {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUT_ROOTS) {
    throw usageError(`evidence capture request.inputs must be a nonempty array of at most ${MAX_INPUT_ROOTS} roots`);
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const spec of inputs) {
    if (!isPlainObject(spec)) throw usageError("evidence capture request.inputs entries must be JSON objects");
    if (!isInputSpecPath(spec.path)) {
      throw usageError(
        `evidence capture request.inputs path must be a nonempty POSIX repo-relative path without absolute, backslash, dot, dot-dot or glob components; got ${JSON.stringify(spec.path ?? null)}`,
      );
    }
    if (spec.kind !== "file" && spec.kind !== "directory") {
      throw usageError('evidence capture request.inputs kind must be "file" or "directory"');
    }
    if (!(INPUT_PURPOSES as readonly string[]).includes(spec.purpose as string)) {
      throw usageError(`evidence capture request.inputs purpose must be one of ${INPUT_PURPOSES.join("/")}`);
    }
    if (seen.has(spec.path)) throw usageError(`evidence capture request.inputs contains duplicate root "${spec.path}"`);
    seen.add(spec.path);
    paths.push(spec.path);
  }
  for (const candidate of paths) {
    const parts = candidate.split("/");
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const ancestor = parts.slice(0, i).join("/");
      if (seen.has(ancestor)) {
        throw usageError(`evidence capture request.inputs contains overlapping roots: "${ancestor}" and "${candidate}"`);
      }
    }
  }
  return inputs as EvidenceInputSpec[];
}

/**
 * Structural usage validation of the immutable capture request. Omitting
 * `environmentKeys` is a usage error (exit 2) — there is no normalization
 * default to a reviewed declaration.
 */
function validateRequestUsage(request: unknown): EvidenceCaptureRequest {
  if (!isPlainObject(request)) throw usageError("evidence capture request must be a JSON object");
  // Reject unknown request keys BEFORE any child runs: the engine would only
  // reject them at record finalization, after the child already executed.
  for (const key of Object.keys(request)) {
    if (!(REQUEST_KEYS as readonly string[]).includes(key)) {
      throw usageError(`evidence capture request has unknown key "${key}"; expected keys: ${REQUEST_KEYS.join(", ")}`);
    }
  }
  const context = request.context;
  if (!isPlainObject(context)) throw usageError("evidence capture request.context must be a JSON object");
  if (typeof context.planId !== "string" || context.planId.length === 0 || !SAFE_COMPONENT_RE.test(context.planId)) {
    throw usageError("evidence capture request.context.planId must be a single safe path component");
  }
  if (typeof context.workingBranch !== "string" || context.workingBranch.trim() === "") {
    throw usageError("evidence capture request.context.workingBranch must be a nonempty string");
  }
  for (const key of ["controlHarnessRoot", "featureCwd", "planFile", "sddDir"] as const) {
    const value = context[key];
    if (typeof value !== "string" || value.trim() === "" || !isAbsolute(value)) {
      throw usageError(`evidence capture request.context.${key} must be a nonempty absolute path`);
    }
  }
  if (!isIdLike(request.taskId)) {
    throw usageError("evidence capture request.taskId must be a nonempty trimmed id without path semantics");
  }
  validateCoverageUsage(request.coverage);
  const inputs = validateInputSpecsUsage(request.inputs);
  if (!Array.isArray(request.environmentKeys)) {
    throw usageError(
      `${CAPTURE_USAGE}\n  request.environmentKeys is required (explicit [] when intentionally selecting none); there is no omission default.`,
    );
  }
  const keys = request.environmentKeys as unknown[];
  if (keys.length > ENVIRONMENT_KEYS.length || new Set(keys).size !== keys.length || keys.some((key) => !(ENVIRONMENT_KEYS as readonly string[]).includes(key as string))) {
    throw usageError(`evidence capture request.environmentKeys must be unique members of ${ENVIRONMENT_KEYS.join("/")}`);
  }
  if (request.timeoutMs !== undefined) {
    const timeout = request.timeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < TIMEOUT_MIN_MS || timeout > TIMEOUT_MAX_MS) {
      throw usageError(`evidence capture request.timeoutMs must be an integer between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS}`);
    }
  }
  return { ...(request as unknown as EvidenceCaptureRequest), inputs };
}

type ValidatedCollectorOptions = {
  cwd: string;
  inputs: readonly EvidenceInputSpec[];
  requestedTool: string;
  environmentKeys: readonly EvidenceEnvironmentKey[];
  limits: EvidenceLimits;
};

/**
 * Malformed collector options reject with the shared usage error (exit 2)
 * BEFORE any collection. Fixture-sized limits are accepted while positive
 * and bounded by the v1 ceilings; byte/entry totals must be at least 2 and
 * the snapshot-byte limit at least the 262144-byte diagnostics reserve.
 */
function validateCollectorOptions(options: CollectEvidenceInputsOptions): ValidatedCollectorOptions {
  const fail = (detail: string): SddScriptError => usageError(`usage: collectEvidenceInputs: ${detail}`);
  if (typeof options?.cwd !== "string" || options.cwd.length === 0 || !isAbsolute(options.cwd)) {
    throw fail("cwd must be a nonempty absolute path");
  }
  if (!Array.isArray(options.argv) || options.argv.length === 0 || typeof options.argv[0] !== "string" || options.argv[0].trim() === "") {
    throw fail("argv must be [executable] with a nonempty argv[0]");
  }
  const inputs = validateInputSpecsUsage(options.inputs);
  if (!Array.isArray(options.environmentKeys)) {
    throw fail("environmentKeys must be an array (explicit [] when selecting none)");
  }
  const keys = options.environmentKeys as unknown[];
  if (keys.length > ENVIRONMENT_KEYS.length || new Set(keys).size !== keys.length || keys.some((key) => !(ENVIRONMENT_KEYS as readonly string[]).includes(key as string))) {
    throw fail(`environmentKeys must be unique members of ${ENVIRONMENT_KEYS.join("/")}`);
  }
  const limits = options.limits;
  if (!isPlainObject(limits)) throw fail("limits must be a JSON object");
  const ceilings: Array<[string, number, number]> = [
    ["timeoutMs", TIMEOUT_MIN_MS, TIMEOUT_MAX_MS],
    ["maxLogBytesPerStream", 1, LOG_STREAM_CAP],
    ["maxInputBytes", 2, INPUT_BYTES_CAP],
    ["maxInputEntries", 2, INPUT_ENTRIES_CAP],
    ["maxInputMs", 1, INPUT_MS_CAP],
    ["maxSnapshotBytes", SNAPSHOT_RESERVED_BYTES, SNAPSHOT_BYTES_CAP],
  ];
  for (const [key, min, max] of ceilings) {
    const value = limits[key as keyof EvidenceLimits];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw fail(`limits.${key} must be an integer between ${min} and ${max}`);
    }
  }
  return {
    cwd: options.cwd,
    inputs,
    requestedTool: options.argv[0]!,
    environmentKeys: options.environmentKeys,
    limits: options.limits,
  };
}

// ---------------------------------------------------------------------------
// Bounded snapshot collection.
// ---------------------------------------------------------------------------

type PassContext = {
  bytesLeft: number;
  entriesLeft: number;
  entryByteBudget: number;
  retainedBytes: number;
  unknowns: string[];
  unstable: boolean;
  stop: boolean;
  deadline: number;
  timeExceeded: boolean;
  bytesLimitNoted: boolean;
};

type PassResult = {
  entries: EvidenceInputEntry[];
  tool: EvidenceToolFingerprint;
  environment: Record<string, string | null>;
  unknowns: string[];
  unstableReads: boolean;
};

type Boundary = {
  repoCommonDir: string | null;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  dirtyStatusSha256: string | null;
  unknowns: string[];
};

function remainingMs(deadline: number): number {
  return deadline - performance.now();
}

function checkDeadline(ctx: PassContext): boolean {
  if (ctx.timeExceeded) return false;
  if (remainingMs(ctx.deadline) <= 0) {
    ctx.timeExceeded = true;
    ctx.stop = true;
    ctx.unknowns.push("input.limit.time: snapshot deadline exceeded before collection finished");
    return false;
  }
  return true;
}

function pushEntry(ctx: PassContext, entries: EvidenceInputEntry[], entry: EvidenceInputEntry): void {
  if (ctx.stop) return;
  if (ctx.entriesLeft <= 0) {
    ctx.stop = true;
    ctx.unknowns.push(`input.limit.entries: entry budget exhausted before ${entry.path}`);
    return;
  }
  const cost = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  if (ctx.retainedBytes + cost > ctx.entryByteBudget) {
    ctx.stop = true;
    ctx.unknowns.push(`input.limit.snapshot-bytes: entry retention stopped after ${entries.length} entries`);
    return;
  }
  ctx.retainedBytes += cost;
  ctx.entriesLeft -= 1;
  entries.push(entry);
  if (ctx.entriesLeft === 0) {
    ctx.stop = true;
    ctx.unknowns.push(`input.limit.entries: entry budget exhausted after ${entry.path}`);
  }
}

function missingEntry(relPath: string): EvidenceInputEntry {
  return { path: relPath, kind: "missing", sha256: null, bytes: null, executable: null, linkText: null, resolvedRelativePath: null, error: null };
}

function directoryEntry(relPath: string): EvidenceInputEntry {
  return { path: relPath, kind: "directory", sha256: null, bytes: null, executable: null, linkText: null, resolvedRelativePath: null, error: null };
}

function unknownEntry(relPath: string, error: string): EvidenceInputEntry {
  return { path: relPath, kind: "unknown", sha256: null, bytes: null, executable: null, linkText: null, resolvedRelativePath: null, error: bound(error) };
}

function symlinkErrorEntry(relPath: string, linkText: string, error: string): EvidenceInputEntry {
  return { path: relPath, kind: "symlink", sha256: null, bytes: null, executable: null, linkText, resolvedRelativePath: null, error: bound(error) };
}

/**
 * Read + hash a regular file with no-follow semantics, bounded 64 KiB
 * chunks, the shared byte budget and a before/after metadata identity
 * check. Returns the failure label instead of throwing on ordinary
 * filesystem errors; budget is consumed only on success.
 */
async function readAndHash(
  absPath: string,
  expectedSize: number,
  ctx: PassContext,
): Promise<{ sha256: string; bytes: number } | { failure: string }> {
  if (ctx.bytesLeft < expectedSize) {
    return { failure: `input.limit.bytes: byte budget exhausted before ${absPath}` };
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(absPath, (fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) as number);
  } catch (error) {
    return { failure: `open failed: ${errnoLabel(error)}` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { failure: "not a regular file" };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let read = 0;
    while (read < stat.size) {
      if (!checkDeadline(ctx)) return { failure: "input.limit.time: snapshot deadline exceeded during read" };
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, stat.size - read), null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
      ctx.unstable = true;
      return { failure: `input.concurrent-change: ${absPath} metadata changed during read` };
    }
    if (read !== stat.size) return { failure: "incomplete read" };
    ctx.bytesLeft -= stat.size;
    return { sha256: hash.digest("hex"), bytes: stat.size };
  } catch (error) {
    return { failure: `read failed: ${errnoLabel(error)}` };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function fileEntry(
  relPath: string,
  absPath: string,
  lstat: fs.Stats,
  ctx: PassContext,
): Promise<EvidenceInputEntry> {
  const executable = (lstat.mode & 0o111) !== 0;
  const hashed = await readAndHash(absPath, lstat.size, ctx);
  if ("failure" in hashed) {
    noteByteLimit(ctx, hashed.failure);
    if (hashed.failure.startsWith("input.concurrent-change")) ctx.unknowns.push(bound(hashed.failure));
    return unknownEntry(relPath, hashed.failure);
  }
  return { path: relPath, kind: "file", sha256: hashed.sha256, bytes: hashed.bytes, executable, linkText: null, resolvedRelativePath: null, error: null };
}

/** One bounded pass-level marker for byte-budget exhaustion (entry errors carry the per-file detail). */
function noteByteLimit(ctx: PassContext, failure: string): void {
  if (failure.startsWith("input.limit.bytes") && !ctx.bytesLimitNoted) {
    ctx.bytesLimitNoted = true;
    ctx.unknowns.push("input.limit.bytes: byte budget exhausted before one or more declared inputs");
  }
}

/**
 * Symlink entries record linkText plus either resolved-target file facts
 * (target resolves inside the cwd to a regular file) or an explicit error
 * with null facts. Directory symlinks are never descended.
 */
async function symlinkEntry(
  relPath: string,
  absPath: string,
  cwdReal: string,
  ctx: PassContext,
): Promise<EvidenceInputEntry> {
  let linkText: string;
  try {
    linkText = await fsp.readlink(absPath);
  } catch (error) {
    return symlinkErrorEntry(relPath, "", `readlink failed: ${errnoLabel(error)}`);
  }
  let real: string | null = null;
  try {
    real = await fsp.realpath(absPath);
  } catch (error) {
    const code = errnoLabel(error);
    return symlinkErrorEntry(relPath, linkText, code === "ELOOP" ? "symlink loop" : "dangling symlink");
  }
  const inside = real === cwdReal || real.startsWith(`${cwdReal}/`);
  if (!inside) return symlinkErrorEntry(relPath, linkText, "symlink target outside feature cwd");
  let targetStat: fs.Stats;
  try {
    targetStat = await fsp.lstat(real);
  } catch (error) {
    return symlinkErrorEntry(relPath, linkText, `symlink target lstat failed: ${errnoLabel(error)}`);
  }
  if (!targetStat.isFile()) return symlinkErrorEntry(relPath, linkText, "symlink target is not a regular file");
  const hashed = await readAndHash(real, targetStat.size, ctx);
  if ("failure" in hashed) {
    noteByteLimit(ctx, hashed.failure);
    if (hashed.failure.startsWith("input.concurrent-change")) ctx.unknowns.push(bound(hashed.failure));
    return symlinkErrorEntry(relPath, linkText, hashed.failure);
  }
  const resolvedRelative = relative(cwdReal, real);
  return {
    path: relPath,
    kind: "symlink",
    sha256: hashed.sha256,
    bytes: hashed.bytes,
    executable: (targetStat.mode & 0o111) !== 0,
    linkText,
    resolvedRelativePath: resolvedRelative,
    error: null,
  };
}

async function walkDirectory(
  relPath: string,
  absPath: string,
  cwdReal: string,
  ctx: PassContext,
  entries: EvidenceInputEntry[],
): Promise<void> {
  if (ctx.stop || !checkDeadline(ctx)) return;
  let dir: fs.promises.Dir;
  try {
    dir = await fsp.opendir(absPath);
  } catch (error) {
    ctx.unknowns.push(bound(`opendir failed for ${relPath}: ${errnoLabel(error)}`));
    return;
  }
  try {
    // Incremental enumeration: collect at most the names the remaining
    // entry budget can still retain, sorted per directory.
    const names: string[] = [];
    for (;;) {
      const dirent = await dir.read();
      if (dirent === null) break;
      names.push(dirent.name);
      if (names.length >= ctx.entriesLeft || ctx.stop) break;
    }
    names.sort();
    for (const name of names) {
      if (ctx.stop || !checkDeadline(ctx)) return;
      const childRel = `${relPath}/${name}`;
      const childAbs = join(absPath, name);
      let childStat: fs.Stats;
      try {
        childStat = await fsp.lstat(childAbs);
      } catch (error) {
        pushEntry(ctx, entries, unknownEntry(childRel, `lstat failed: ${errnoLabel(error)}`));
        continue;
      }
      if (childStat.isDirectory()) {
        pushEntry(ctx, entries, directoryEntry(childRel));
        await walkDirectory(childRel, childAbs, cwdReal, ctx, entries);
      } else if (childStat.isSymbolicLink()) {
        pushEntry(ctx, entries, await symlinkEntry(childRel, childAbs, cwdReal, ctx));
      } else if (childStat.isFile()) {
        pushEntry(ctx, entries, await fileEntry(childRel, childAbs, childStat, ctx));
      } else {
        pushEntry(ctx, entries, unknownEntry(childRel, `not a regular file (mode ${childStat.mode.toString(8)})`));
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
}

async function collectRoot(
  spec: EvidenceInputSpec,
  cwdReal: string,
  ctx: PassContext,
  entries: EvidenceInputEntry[],
): Promise<void> {
  if (ctx.stop || !checkDeadline(ctx)) return;
  const absPath = resolvePath(cwdReal, spec.path);
  let stat: fs.Stats | null = null;
  let lstatError: string | null = null;
  try {
    stat = await fsp.lstat(absPath);
  } catch (error) {
    lstatError = errnoLabel(error);
  }
  if (lstatError !== null) {
    pushEntry(ctx, entries, lstatError === "ENOENT" ? missingEntry(spec.path) : unknownEntry(spec.path, `lstat failed: ${lstatError}`));
    return;
  }
  if (stat!.isDirectory()) {
    if (spec.kind !== "directory") {
      pushEntry(ctx, entries, unknownEntry(spec.path, `requested kind ${spec.kind} but found directory`));
      return;
    }
    pushEntry(ctx, entries, directoryEntry(spec.path));
    await walkDirectory(spec.path, absPath, cwdReal, ctx, entries);
    return;
  }
  if (stat!.isSymbolicLink()) {
    if (spec.kind === "directory") {
      pushEntry(ctx, entries, unknownEntry(spec.path, "requested kind directory but found symlink"));
      return;
    }
    pushEntry(ctx, entries, await symlinkEntry(spec.path, absPath, cwdReal, ctx));
    return;
  }
  if (stat!.isFile()) {
    if (spec.kind !== "file") {
      pushEntry(ctx, entries, unknownEntry(spec.path, `requested kind ${spec.kind} but found file`));
      return;
    }
    pushEntry(ctx, entries, await fileEntry(spec.path, absPath, stat!, ctx));
    return;
  }
  pushEntry(ctx, entries, unknownEntry(spec.path, `not a regular file (mode ${stat!.mode.toString(8)})`));
}

/**
 * Resolve the requested tool on this pass without executing probes: an
 * explicit path resolves against the cwd; a bare name scans the inherited
 * PATH (empty entries resolve to the cwd) within 256 entries / 65536
 * UTF-8 bytes. The hash consumes the same shared byte budget, before the
 * declared inputs.
 */
async function resolveTool(cwdReal: string, requested: string, ctx: PassContext): Promise<EvidenceToolFingerprint> {
  const base = {
    requested,
    platform: process.platform,
    arch: process.arch,
    runnerRuntimeVersion: runnerRuntimeVersion(),
  };
  let candidate: string | null = null;
  let resolutionError: string | null = null;
  if (requested.includes("/")) {
    const absPath = resolvePath(cwdReal, requested);
    let stat: fs.Stats | null = null;
    try {
      stat = await fsp.lstat(absPath);
    } catch (error) {
      resolutionError = `tool resolve failed: ${errnoLabel(error)}`;
    }
    if (stat !== null) {
      if (!stat.isFile()) resolutionError = `tool resolve failed: not a regular file: ${absPath}`;
      else candidate = absPath;
    }
  } else {
    const pathValue = process.env.PATH ?? "";
    const segments = pathValue.split(":");
    let pathBytes = 0;
    let scanned = 0;
    let overflow = false;
    for (const segment of segments) {
      pathBytes += Buffer.byteLength(segment, "utf8") + 1;
      if (pathBytes > MAX_PATH_UTF8_BYTES || scanned >= MAX_PATH_ENTRIES) {
        overflow = true;
        break;
      }
      scanned += 1;
      const dir = segment === "" ? cwdReal : segment;
      const candidatePath = join(dir, requested);
      let stat: fs.Stats | null = null;
      try {
        stat = await fsp.lstat(candidatePath);
      } catch {
        continue;
      }
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        candidate = candidatePath;
        break;
      }
    }
    if (candidate === null) {
      resolutionError = overflow
        ? `tool-resolution-limit: PATH exceeds ${MAX_PATH_ENTRIES} entries or ${MAX_PATH_UTF8_BYTES} bytes; no executable resolved`
        : `tool resolve failed: not found on PATH: ${requested}`;
    }
  }
  if (candidate === null) {
    if (resolutionError !== null && resolutionError.startsWith("tool-resolution-limit")) {
      ctx.unknowns.push(bound(`tool.resolution-limit: ${resolutionError}`));
    }
    return { ...base, resolvedPath: null, sha256: null, bytes: null, error: bound(resolutionError ?? "tool resolve failed") };
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    return { ...base, resolvedPath: candidate, sha256: null, bytes: null, error: bound(`tool hash failed: ${errnoLabel(error)}`) };
  }
  const hashed = await readAndHash(candidate, stat.size, ctx);
  if ("failure" in hashed) {
    if (hashed.failure.startsWith("input.concurrent-change")) ctx.unknowns.push(bound(hashed.failure));
    return { ...base, resolvedPath: candidate, sha256: null, bytes: null, error: bound(hashed.failure) };
  }
  return { ...base, resolvedPath: candidate, sha256: hashed.sha256, bytes: hashed.bytes, error: null };
}

function collectEnvironment(
  environmentKeys: readonly EvidenceEnvironmentKey[],
  unknowns: string[],
): Record<string, string | null> {
  const environment: Record<string, string | null> = {};
  for (const key of environmentKeys) {
    const value = process.env[key];
    if (value === undefined) environment[key] = null;
    else if (value.length > MAX_STRING) {
      environment[key] = null;
      unknowns.push(`input.limit.environment-value: ${key} value exceeds ${MAX_STRING} characters and was not copied`);
    } else environment[key] = value;
  }
  return environment;
}

async function collectPass(
  cwdReal: string,
  inputs: readonly EvidenceInputSpec[],
  requestedTool: string,
  environmentKeys: readonly EvidenceEnvironmentKey[],
  perPassBytes: number,
  perPassEntries: number,
  maxSnapshotBytes: number,
  deadline: number,
): Promise<PassResult> {
  const ctx: PassContext = {
    bytesLeft: perPassBytes,
    entriesLeft: perPassEntries,
    entryByteBudget: Math.max(0, maxSnapshotBytes - SNAPSHOT_RESERVED_BYTES),
    retainedBytes: 0,
    unknowns: [],
    unstable: false,
    stop: false,
    deadline,
    timeExceeded: false,
    bytesLimitNoted: false,
  };
  const tool = await resolveTool(cwdReal, requestedTool, ctx);
  const environment = collectEnvironment(environmentKeys, ctx.unknowns);
  const entries: EvidenceInputEntry[] = [];
  for (const spec of inputs) {
    if (ctx.stop) break;
    await collectRoot(spec, cwdReal, ctx, entries);
  }
  checkDeadline(ctx);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, tool, environment, unknowns: capDiagnostics(ctx.unknowns), unstableReads: ctx.unstable };
}

/**
 * One bounded Git identity probe set (common dir, HEAD, branch, dirty
 * status). Every probe runs direct argv with GIT_OPTIONAL_LOCKS=0, a
 * min(5 s, remaining) timeout and an 8 MiB output cap, and never fetches
 * or mutates. Probe failure is an explicit unknown, never evidence of
 * cleanliness.
 */
function gitBoundary(cwd: string, deadline: number, probeCount: { value: number }): Boundary {
  const unknowns: string[] = [];
  const probe = (args: string[], encoding: "utf8" | "buffer"): { ok: true; out: string | Buffer } | { ok: false; error: string } => {
    if (probeCount.value >= MAX_GIT_PROBES_PER_SNAPSHOT) {
      return { ok: false, error: `git probe budget of ${MAX_GIT_PROBES_PER_SNAPSHOT} per snapshot exhausted` };
    }
    probeCount.value += 1;
    const remaining = remainingMs(deadline);
    if (remaining <= 0) return { ok: false, error: "input.limit.time: no time remains for git probes" };
    try {
      const out = execGit(args, cwd, Math.min(GIT_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(remaining))), encoding);
      return { ok: true, out };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message =
        code === "ENOENT"
          ? "git executable not found"
          : code === "ENOBUFS"
            ? `output exceeded the ${GIT_PROBE_CAP_BYTES}-byte probe cap`
            : bound(String((error as Error).message), 200);
      return { ok: false, error: message };
    }
  };

  let repoCommonDir: string | null = null;
  const common = probe(["rev-parse", "--git-common-dir"], "utf8");
  if (common.ok) {
    const value = common.out.toString().trim();
    if (value !== "") {
      try {
        repoCommonDir = fs.realpathSync(resolvePath(cwd, value));
      } catch {
        unknowns.push("git.probe.common-dir: cannot canonicalize the git common dir");
      }
    } else {
      unknowns.push("git.probe.common-dir: empty output");
    }
  } else {
    unknowns.push(`git.probe.common-dir: ${common.error}`);
  }

  let head: string | null = null;
  const headProbe = probe(["rev-parse", "HEAD"], "utf8");
  if (headProbe.ok) {
    const value = headProbe.out.toString().trim();
    if (GIT_OID_RE.test(value)) head = value;
    else unknowns.push("git.probe.head: unexpected output");
  } else {
    unknowns.push(`git.probe.head: ${headProbe.error}`);
  }

  let branch: string | null = null;
  const branchProbe = probe(["rev-parse", "--abbrev-ref", "HEAD"], "utf8");
  if (branchProbe.ok) {
    const value = branchProbe.out.toString().trim();
    if (value === "") unknowns.push("git.probe.branch: empty output");
    else branch = value === "HEAD" ? null : value;
  } else {
    unknowns.push(`git.probe.branch: ${branchProbe.error}`);
  }

  let dirty: boolean | null = null;
  let dirtyStatusSha256: string | null = null;
  const status = probe(["status", "--porcelain=v1", "-z", "--untracked-files=all"], "buffer");
  if (status.ok) {
    dirty = status.out.length > 0;
    dirtyStatusSha256 = createHash("sha256").update(status.out).digest("hex");
  } else {
    unknowns.push(`git.probe.status: ${status.error}`);
  }

  return { repoCommonDir, head, branch, dirty, dirtyStatusSha256, unknowns };
}

function execGit(args: string[], cwd: string, timeoutMs: number, encoding: "utf8" | "buffer"): string | Buffer {
  // Direct argv, no shell; GIT_OPTIONAL_LOCKS=0 keeps every probe read-only.
  // stdio stays piped so probe stderr (e.g. non-Git dirs) never leaks.
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: timeoutMs,
    maxBuffer: GIT_PROBE_CAP_BYTES,
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  }) as string | Buffer;
}

/**
 * Collect one input snapshot: exactly two consecutive passes of the
 * declared roots plus tool/env with bounded Git identity observations at
 * the snapshot boundaries. The second pass is the retained snapshot; a
 * pass/boundary mismatch or unstable read marks the snapshot unstable with
 * an explicit concurrent-change unknown. Ordinary filesystem/probe
 * failures are honest unknown facts, never throws.
 */
export async function collectEvidenceInputs(options: CollectEvidenceInputsOptions): Promise<EvidenceInputSnapshot> {
  const validated = validateCollectorOptions(options);
  const deadline = performance.now() + validated.limits.maxInputMs;
  let cwdReal: string;
  try {
    cwdReal = fs.realpathSync(validated.cwd);
  } catch {
    cwdReal = resolvePath(validated.cwd);
  }
  const perPassBytes = Math.floor(validated.limits.maxInputBytes / 2);
  const perPassEntries = Math.floor(validated.limits.maxInputEntries / 2);
  const passState = {
    cwdReal,
    inputs: validated.inputs,
    requestedTool: validated.requestedTool,
    environmentKeys: validated.environmentKeys,
    perPassBytes,
    perPassEntries,
    maxSnapshotBytes: validated.limits.maxSnapshotBytes,
  };
  const probes = { value: 0 };

  const startBoundary = gitBoundary(cwdReal, deadline, probes);
  const pass1 = await collectPass(cwdReal, validated.inputs, validated.requestedTool, validated.environmentKeys, perPassBytes, perPassEntries, validated.limits.maxSnapshotBytes, deadline);
  const endBoundary = gitBoundary(cwdReal, deadline, probes);
  const pass2 = await collectPass(cwdReal, validated.inputs, validated.requestedTool, validated.environmentKeys, perPassBytes, perPassEntries, validated.limits.maxSnapshotBytes, deadline);

  // Pass comparison happens over the canonical projection (entries, tool
  // without the transient resolvedPath, environment) before stable/unknown
  // fields are added — no self-referential stability comparison.
  const projectionOf = (pass: PassResult): string =>
    JSON.stringify({
      entries: pass.entries,
      tool: { ...pass.tool, resolvedPath: undefined },
      environment: pass.environment,
    });
  const boundaryStable =
    startBoundary.repoCommonDir === endBoundary.repoCommonDir &&
    startBoundary.head === endBoundary.head &&
    startBoundary.branch === endBoundary.branch;
  const stable = projectionOf(pass1) === projectionOf(pass2) && boundaryStable && !pass1.unstableReads && !pass2.unstableReads;

  const unknowns = capDiagnostics([
    ...startBoundary.unknowns,
    ...pass1.unknowns,
    ...endBoundary.unknowns,
    ...pass2.unknowns,
    ...(stable ? [] : ["input.concurrent-change: pass projection or git boundary mismatch between snapshot boundaries"]),
  ]);

  const snapshot: EvidenceInputSnapshot = {
    repoCommonDir: endBoundary.repoCommonDir ?? startBoundary.repoCommonDir,
    head: endBoundary.head ?? startBoundary.head,
    branch: endBoundary.branch ?? startBoundary.branch,
    dirty: endBoundary.dirty,
    dirtyStatusSha256: endBoundary.dirtyStatusSha256,
    entries: pass2.entries,
    tool: pass2.tool,
    environment: pass2.environment,
    unknowns,
    stable,
    digest: "",
  };
  snapshot.digest = evidenceInputDigest(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Retained artifact facts.
// ---------------------------------------------------------------------------

async function artifactFact(artifactPath: string, deadline: number): Promise<EvidenceArtifactFact> {
  const slot = basename(artifactPath) === "stdout.log" ? "stdout.log" : "stderr.log";
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: slot, state: "missing", bytes: null, sha256: null };
    return { path: slot, state: "other", bytes: null, sha256: null };
  }
  if (lstat.isSymbolicLink()) return { path: slot, state: "symlink", bytes: null, sha256: null };
  if (!lstat.isFile()) return { path: slot, state: "other", bytes: null, sha256: null };
  if (remainingMs(deadline) <= 0) return { path: slot, state: "unreadable", bytes: null, sha256: null };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fsp.open(artifactPath, (fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) as number);
  } catch {
    return { path: slot, state: "unreadable", bytes: null, sha256: null };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { path: slot, state: "other", bytes: null, sha256: null };
    // An oversized regular file keeps its observed size but hash null; it
    // fails size verification later without reading the whole content.
    if (stat.size > LOG_STREAM_CAP) return { path: slot, state: "regular", bytes: stat.size, sha256: null };
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let read = 0;
    while (read < stat.size) {
      if (remainingMs(deadline) <= 0) return { path: slot, state: "unreadable", bytes: null, sha256: null };
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, stat.size - read), null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      read += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
      return { path: slot, state: "unreadable", bytes: null, sha256: null };
    }
    if (read !== stat.size) return { path: slot, state: "unreadable", bytes: null, sha256: null };
    return { path: slot, state: "regular", bytes: read, sha256: hash.digest("hex") };
  } catch {
    return { path: slot, state: "unreadable", bytes: null, sha256: null };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read-only facts for the two fixed logs of a retained run directory:
 * exactly one fact per fixed slot, no-follow opens, a shared 10 s read
 * deadline and per-read identity checks. Never writes.
 */
export async function collectEvidenceArtifacts(runDir: string): Promise<EvidenceArtifactFact[]> {
  const deadline = performance.now() + ARTIFACT_READ_DEADLINE_MS;
  return [await artifactFact(join(runDir, "stdout.log"), deadline), await artifactFact(join(runDir, "stderr.log"), deadline)];
}

// ---------------------------------------------------------------------------
// Capture runner.
// ---------------------------------------------------------------------------

type LogStat = { fd: number; stored: number; hash: ReturnType<typeof createHash>; truncated: boolean; closed: boolean; writeFailed: boolean };

type ChildRun = {
  outcome: EvidenceOutcome;
  exitCode: number;
  captureErrors: string[];
  logs: { stdout: { bytes: number; sha256: string; truncated: boolean }; stderr: { bytes: number; sha256: string; truncated: boolean } };
};

function openExclusiveLog(logPath: string): number {
  const flags = (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)) as number;
  const fd = fs.openSync(logPath, flags, 0o600);
  try {
    const fstat = fs.fstatSync(fd);
    const lstat = fs.lstatSync(logPath);
    if (fstat.ino !== lstat.ino || fstat.dev !== lstat.dev) {
      throw new Error(`evidence log identity mismatch after open: ${logPath}`);
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * Spawn once (shell false, resolved feature cwd, inherited environment,
 * owned POSIX process group), stream raw output into the stored logs up to
 * the per-stream cap while draining to the terminal sink, and settle once:
 * normal exit settles on child + streams closed; timeout / parent
 * SIGINT/SIGTERM escalate TERM → KILL with bounded grace and drain; a
 * direct-child exit with descendant-held pipes gets the bounded drain
 * timer, then the same escalation while retaining the direct outcome.
 */
function runChild(
  featureCwd: string,
  argv: readonly string[],
  beforeTool: EvidenceToolFingerprint,
  beforeUnknowns: readonly string[],
  timeoutMs: number,
  logFds: { stdout: number; stderr: number },
): Promise<ChildRun> {
  return new Promise((resolveRun) => {
    const captureErrors: string[] = [];
    const stats: Record<"stdout" | "stderr", LogStat> = {
      stdout: { fd: logFds.stdout, stored: 0, hash: createHash("sha256"), truncated: false, closed: false, writeFailed: false },
      stderr: { fd: logFds.stderr, stored: 0, hash: createHash("sha256"), truncated: false, closed: false, writeFailed: false },
    };
    let settled = false;
    let firstOutcome: EvidenceOutcome | null = null;
    let spawnError: NodeJS.ErrnoException | null = null;
    let directExit: { code: number | null; signal: string | null } | null = null;
    let drainIncomplete = false;
    let sinkBroken = false;
    let child: ChildProcess | null = null;
    const timers: NodeJS.Timeout[] = [];

    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };
    const killGroup = (signal: NodeJS.Signals): void => {
      const pid = child?.pid;
      if (pid !== undefined && pid > 0) {
        try {
          process.kill(-pid, signal);
        } catch {
          // the group may already be gone
        }
      }
    };
    const destroyStreams = (): void => {
      try {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      } catch {
        // streams may already be destroyed
      }
    };
    const settleNow = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.stdout.removeListener("drain", resumeBoth);
      process.stderr.removeListener("drain", resumeBoth);
      process.stdout.removeListener("error", onSinkError);
      process.stderr.removeListener("error", onSinkError);

      let outcome: EvidenceOutcome;
      let exitCode: number;
      if (spawnError !== null) {
        const code = typeof spawnError.code === "string" ? spawnError.code : "ESPAWN";
        outcome = { kind: "spawn-error", code };
        exitCode = code === "ENOENT" ? 127 : 1;
      } else if (firstOutcome?.kind === "timeout") {
        outcome = { kind: "timeout" };
        exitCode = 124;
      } else if (firstOutcome?.kind === "interrupted") {
        outcome = firstOutcome;
        exitCode = firstOutcome.signal === "SIGINT" ? 130 : 143;
      } else if (directExit !== null && directExit.signal !== null) {
        outcome = { kind: "signal", signal: directExit.signal };
        exitCode = 128 + signalExitNumber(directExit.signal);
      } else {
        const code = directExit?.code ?? 0;
        outcome = { kind: "exit", code };
        exitCode = code ?? 0;
      }
      if (drainIncomplete) {
        captureErrors.push(bound(`capture.drain-incomplete: descendant-held pipes did not drain within the ${DRAIN_MS} ms budget`));
      }
      if (sinkBroken) {
        captureErrors.push("capture.sink-error: terminal sink failed; continued bounded local capture");
      }
      if (outcome.kind === "exit" && outcome.code === 0 && (stats.stdout.truncated || stats.stderr.truncated || captureErrors.length > 0)) {
        exitCode = 1;
      }
      resolveRun({
        outcome,
        exitCode,
        captureErrors,
        logs: {
          stdout: { bytes: stats.stdout.stored, sha256: stats.stdout.hash.digest("hex"), truncated: stats.stdout.truncated },
          stderr: { bytes: stats.stderr.stored, sha256: stats.stderr.hash.digest("hex"), truncated: stats.stderr.truncated },
        },
      });
    };
    const maybeSettle = (): void => {
      if (settled) return;
      if (spawnError !== null) {
        settleNow();
        return;
      }
      if (directExit !== null && stats.stdout.closed && stats.stderr.closed) settleNow();
    };
    const escalate = (signal: NodeJS.Signals): void => {
      killGroup(signal);
      timers.push(setTimeout(() => killGroup("SIGKILL"), TERM_GRACE_MS));
      timers.push(setTimeout(() => destroyStreams(), TERM_GRACE_MS + DRAIN_MS));
      timers.push(setTimeout(() => settleNow(), TERM_GRACE_MS + DRAIN_MS + TERM_GRACE_MS));
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      if (firstOutcome === null) {
        firstOutcome = { kind: "interrupted", signal: signal as "SIGINT" | "SIGTERM" };
        escalate(signal);
      }
    };
    const resumeBoth = (): void => {
      try {
        child?.stdout?.resume();
        child?.stderr?.resume();
      } catch {
        // streams may be gone
      }
    };
    const onSinkError = (): void => {
      if (!sinkBroken) sinkBroken = true;
    };

    // No executable path could be established within the resolution bound:
    // retain the spawn-error attempt without inventing an execution.
    if (beforeTool.resolvedPath === null && beforeUnknowns.some((message) => message.startsWith("tool.resolution-limit"))) {
      stats.stdout.closed = true;
      stats.stderr.closed = true;
      resolveRun({
        outcome: { kind: "spawn-error", code: "ERESOLUTIONLIMIT" },
        exitCode: 1,
        captureErrors,
        logs: {
          stdout: { bytes: 0, sha256: stats.stdout.hash.digest("hex"), truncated: false },
          stderr: { bytes: 0, sha256: stats.stderr.hash.digest("hex"), truncated: false },
        },
      });
      return;
    }

    try {
      child = spawn(beforeTool.resolvedPath ?? (argv[0] as string), argv.slice(1), {
        cwd: featureCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: true,
      });
    } catch (error) {
      spawnError = error as NodeJS.ErrnoException;
      stats.stdout.closed = true;
      stats.stderr.closed = true;
      settleNow();
      return;
    }

    const wireStream = (slot: "stdout" | "stderr"): void => {
      const stream = slot === "stdout" ? child!.stdout : child!.stderr;
      const stat = stats[slot];
      stream!.on("data", (chunk: Buffer) => {
        const room = LOG_STREAM_CAP - stat.stored;
        if (room > 0) {
          const take = room >= chunk.length ? chunk : chunk.subarray(0, room);
          try {
            fs.writeSync(stat.fd, take);
            stat.hash.update(take);
            stat.stored += take.length;
            if (take.length < chunk.length) stat.truncated = true;
          } catch (error) {
            stat.truncated = true;
            stat.writeFailed = true;
            captureErrors.push(bound(`capture.log-write-error: ${slot}: ${(error as Error).message}`));
          }
        } else {
          stat.truncated = true;
        }
        if (!sinkBroken) {
          const sink = slot === "stdout" ? process.stdout : process.stderr;
          const flowed = sink.write(chunk);
          if (!flowed) stream!.pause();
        }
      });
      stream!.on("close", () => {
        stat.closed = true;
        maybeSettle();
      });
      stream!.on("error", (error: Error) => {
        captureErrors.push(bound(`capture.stream-error: ${slot}: ${error.message}`));
        stat.closed = true;
        maybeSettle();
      });
    };
    wireStream("stdout");
    wireStream("stderr");

    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      settleNow();
    });
    child.on("exit", (code, signal) => {
      directExit = { code, signal };
      if (stats.stdout.closed && stats.stderr.closed) {
        maybeSettle();
        return;
      }
      // The direct child is gone but descendants hold the pipes: bounded
      // drain, then the same escalation while keeping the direct outcome.
      timers.push(
        setTimeout(() => {
          if (settled) return;
          drainIncomplete = true;
          escalate("SIGTERM");
        }, DRAIN_MS),
      );
    });

    timers.push(
      setTimeout(() => {
        if (firstOutcome === null) {
          firstOutcome = { kind: "timeout" };
          escalate("SIGTERM");
        }
      }, timeoutMs),
    );
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.stdout.on("drain", resumeBoth);
    process.stderr.on("drain", resumeBoth);
    process.stdout.on("error", onSinkError);
    process.stderr.on("error", onSinkError);
  });
}

/**
 * Final write of the record file. Immediately before the atomic replace the
 * file-boundary contract's recheck runs: the record path must still sit
 * inside the canonical SDD dir, both ancestors below it must still be real
 * directories (never a symlink or file swap that would redirect the write),
 * and the leaf itself must be a regular file or absent.
 */
function writeRecordAtomic(sddDir: string, runDir: string, recordPath: string, record: SddEvidenceRecord): void {
  const withinSdd = relative(sddDir, recordPath);
  if (withinSdd === "" || withinSdd.startsWith("..") || isAbsolute(withinSdd)) {
    throw new Error(`evidence record path is outside the canonical SDD dir: ${recordPath}`);
  }
  for (const ancestor of [dirname(runDir), runDir]) {
    let ancestorStat: fs.Stats;
    try {
      ancestorStat = fs.lstatSync(ancestor);
    } catch (error) {
      throw new Error(`evidence ancestor dir missing before finalize: ${ancestor} (${(error as Error).message})`);
    }
    if (!ancestorStat.isDirectory()) {
      throw new Error(`evidence ancestor is not a real directory: ${ancestor}`);
    }
  }
  try {
    const lstat = fs.lstatSync(recordPath);
    if (!lstat.isFile()) {
      throw new Error(`evidence record path is not a regular file: ${recordPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  writeJson(recordPath, record);
}

/**
 * Capture one already-authorized check. Throws `SddScriptError` only when
 * no durable attempt can be created (usage exit 2, gate refusal exit 1,
 * attempt/log creation failure exit 1); once a running record exists it
 * retains/finalizes the record and returns its nonzero exit code. A
 * finalization write failure throws with the run dir in the message and
 * preserves the running artifacts.
 */
export async function captureSddEvidence(
  request: EvidenceCaptureRequest,
  argv: readonly string[],
): Promise<{ runDir: string; record: SddEvidenceRecord; exitCode: number }> {
  validateArgvUsage(argv);
  const validatedRequest = validateRequestUsage(request);
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw usageError(
      `sdd evidence capture supports POSIX linux/darwin only in v1 (read-only verify is portable); refusing before spawn on ${process.platform}`,
    );
  }

  // Phase 1: resolve + gate the dispatched context. Refusal before child;
  // no implicit cwd correction for a mislocated hosted leaf.
  const resolved = resolveSddExecutionContext(validatedRequest.context);
  const cwdGate = checkSddAction(resolved, { kind: "source", cwd: process.cwd() });
  if (!cwdGate.ok) {
    throw gateError(
      `sdd evidence capture refused: ${cwdGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}`,
    );
  }
  const launchGate = checkSddAction(resolved, { kind: "launch", cwd: process.cwd() });
  if (!launchGate.ok) {
    throw gateError(
      `sdd evidence capture refused: ${launchGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}`,
    );
  }
  const evidenceDir = join(resolved.sddDir, "evidence");
  const artifactGate = checkSddAction(resolved, { kind: "artifact", cwd: process.cwd(), target: evidenceDir });
  if (!artifactGate.ok) {
    throw gateError(
      `sdd evidence capture refused: ${artifactGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}`,
    );
  }

  // Phase 2: exclusive attempt directory, before snapshot, exclusive logs,
  // running record. Anything failing here leaves no durable attempt.
  const runId = randomUUID();
  const runDir = join(evidenceDir, runId);
  const recordPath = join(runDir, "record.json");
  const limits = v1Limits(validatedRequest.timeoutMs ?? TIMEOUT_DEFAULT_MS);
  try {
    let evidenceStat: fs.Stats | null = null;
    try {
      evidenceStat = fs.lstatSync(evidenceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (evidenceStat !== null && !evidenceStat.isDirectory()) {
      throw gateError(`evidence parent is not a real directory: ${evidenceDir}`);
    }
    if (evidenceStat === null) fs.mkdirSync(evidenceDir);
    fs.mkdirSync(runDir);

    const startedAt = new Date().toISOString();
    const before = await collectEvidenceInputs({
      cwd: resolved.featureCwd,
      inputs: validatedRequest.inputs,
      argv,
      environmentKeys: validatedRequest.environmentKeys,
      limits,
    });
    const stdoutFd = openExclusiveLog(join(runDir, "stdout.log"));
    const stderrFd = openExclusiveLog(join(runDir, "stderr.log"));

    const record: SddEvidenceRecord = {
      schema: EVIDENCE_SCHEMA,
      producer: { name: "mstar-harness", version: readHarnessVersion() },
      runId,
      request: {
        context: resolved,
        taskId: validatedRequest.taskId,
        coverage: validatedRequest.coverage,
        inputs: validatedRequest.inputs,
        environmentKeys: [...validatedRequest.environmentKeys],
        ...(validatedRequest.timeoutMs !== undefined ? { timeoutMs: validatedRequest.timeoutMs } : {}),
      },
      command: { argv: [...argv], cwd: resolved.featureCwd },
      startedAt,
      endedAt: null,
      state: "running",
      outcome: { kind: "running" },
      before,
      after: null,
      logs: {
        stdout: { path: "stdout.log", bytes: 0, sha256: null, truncated: false },
        stderr: { path: "stderr.log", bytes: 0, sha256: null, truncated: false },
      },
      limits,
      captureErrors: [],
      counts: null,
    };
    writeRecordAtomic(resolved.sddDir, runDir, recordPath, record);

    // Phases 3-5: spawn, stream, bounded timeout/signal handling.
    const run = await runChild(resolved.featureCwd, argv, before.tool, before.unknowns, limits.timeoutMs, { stdout: stdoutFd, stderr: stderrFd });

    // Phase 6: post snapshot, close/hash logs, atomically finalize.
    let after: EvidenceInputSnapshot;
    try {
      after = await collectEvidenceInputs({
        cwd: resolved.featureCwd,
        inputs: validatedRequest.inputs,
        argv,
        environmentKeys: validatedRequest.environmentKeys,
        limits,
      });
    } finally {
      try {
        fs.closeSync(stdoutFd);
      } catch {}
      try {
        fs.closeSync(stderrFd);
      } catch {}
    }
    record.outcome = run.outcome;
    record.captureErrors = capCaptureErrors(run.captureErrors);
    record.after = after;
    record.logs.stdout = { path: "stdout.log", bytes: run.logs.stdout.bytes, sha256: run.logs.stdout.sha256, truncated: run.logs.stdout.truncated };
    record.logs.stderr = { path: "stderr.log", bytes: run.logs.stderr.bytes, sha256: run.logs.stderr.sha256, truncated: run.logs.stderr.truncated };
    record.endedAt = new Date().toISOString();
    record.state = "finished";

    const selfGate = validateSddEvidenceRecord(record);
    if (!selfGate.ok) {
      throw new Error(
        `evidence finalization produced an invalid record for ${runDir}: ${selfGate.violations.map((violation) => `${violation.code}: ${violation.message}`).join("; ")}`,
      );
    }
    try {
      writeRecordAtomic(resolved.sddDir, runDir, recordPath, record);
    } catch (error) {
      throw new Error(`evidence finalization write failed for ${runDir}: ${(error as Error).message}`);
    }
    return { runDir, record, exitCode: run.exitCode };
  } catch (error) {
    // No durable attempt may exist yet: the running record is written only
    // after the logs; an empty attempt directory is removed best-effort.
    if (!fs.existsSync(recordPath)) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Read-only verify internals.
// ---------------------------------------------------------------------------

function loadJsonFileUsage(pathValue: string | undefined, what: string): Record<string, unknown> {
  if (!pathValue || !isAbsolute(pathValue)) {
    throw usageError(`${what} must be an absolute path to a JSON file; got ${JSON.stringify(pathValue ?? "")}`);
  }
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(pathValue);
  } catch {
    throw usageError(`no such ${what} file: ${pathValue}`);
  }
  if (!lstat.isFile()) throw usageError(`${what} file is not a regular file: ${pathValue}`);
  if (lstat.size > REQUEST_FILE_CAP_BYTES) {
    throw usageError(`${what} file exceeds the ${REQUEST_FILE_CAP_BYTES}-byte read cap: ${pathValue}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(pathValue, "utf8"));
  } catch (error) {
    throw usageError(`${what} file is not valid JSON: ${pathValue} (${(error as Error).message})`);
  }
  if (!isPlainObject(doc)) throw usageError(`${what} file must contain a JSON object: ${pathValue}`);
  return doc;
}

function loadTargetRequest(pathValue: string): EvidenceTargetRequest {
  const doc = loadJsonFileUsage(pathValue, "--target");
  const cwd = doc.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw usageError("--target cwd must be a nonempty absolute path");
  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.statSync(cwd);
  } catch {
    throw usageError(`--target cwd does not exist or is not a directory: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) throw usageError(`--target cwd is not a directory: ${cwd}`);
  if (typeof doc.expectedHead !== "string" || !GIT_OID_RE.test(doc.expectedHead)) {
    throw usageError("--target expectedHead must be a lowercase 40/64-hex Git OID");
  }
  if (typeof doc.rationale !== "string" || doc.rationale.length === 0 || doc.rationale.length > MAX_STRING) {
    throw usageError("--target rationale must be a nonempty string");
  }
  return { cwd, expectedHead: doc.expectedHead, rationale: doc.rationale };
}

function ioFailureAssessment(message: string): EvidenceAssessment {
  return {
    integrity: { ok: false, violations: [{ ok: false, severity: "high", code: "evidence.incomplete", message: bound(message, 1024) }] },
    outcome: "unknown",
    applicability: "uncertain",
    coverage: "review-required",
    changedInputs: [],
    reasons: ["evidence.integrity"],
  };
}

/** Canonical (realpath) form when the path exists; lexical resolution otherwise. */
function canonicalExisting(pathValue: string): string {
  try {
    return fs.realpathSync(pathValue);
  } catch {
    return resolvePath(pathValue);
  }
}

type VerifyInvocation = {
  sddDir: string;
  planId: string;
  taskId: string;
  runId: string;
  targetPath?: string;
};

/**
 * Read-only verification: never executes the recorded child, discovery or
 * version probe, never writes an assessment artifact, and performs no
 * historical lease/source-checkout validation. Record reads are capped at
 * 8 MiB; a truncated/oversized record yields a structured non-success
 * assessment, never a JSON success.
 *
 * Canonical-path containment (locked verify path): the invoked sdd dir must
 * canonicalize to the plan's own location — basename equal to the expected
 * plan, parent named "sdd", under the canonical control root recorded in
 * `record.request.context`. A mismatch is refused with the usage error class
 * (exit 2) BEFORE any record path is dereferenced, so a relocated or copied
 * bundle directory is never assessed.
 */
async function runEvidenceVerify(invocation: VerifyInvocation): Promise<EvidenceAssessment> {
  const canonicalSddDir = canonicalExisting(invocation.sddDir);
  if (basename(canonicalSddDir) !== invocation.planId) {
    throw usageError(
      `${VERIFY_USAGE}\n  --sdd-dir must be the canonical plan SDD dir whose basename is the plan id "${invocation.planId}"; got ${invocation.sddDir}`,
    );
  }
  if (basename(dirname(canonicalSddDir)) !== "sdd") {
    throw usageError(`${VERIFY_USAGE}\n  --sdd-dir must sit under an "sdd" dir of the canonical control harness; got ${invocation.sddDir}`);
  }
  const runDir = join(canonicalSddDir, "evidence", invocation.runId);
  const recordPath = join(runDir, "record.json");

  let record: unknown;
  try {
    const lstat = fs.lstatSync(recordPath);
    if (!lstat.isFile()) throw new Error("evidence record is not a regular file");
    if (lstat.size > RECORD_FILE_CAP_BYTES) {
      throw new Error(`evidence record exceeds the ${RECORD_FILE_CAP_BYTES}-byte read cap; never a truncated JSON success`);
    }
    record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ioFailureAssessment(`evidence record not found: ${recordPath}`);
    }
    return ioFailureAssessment(`evidence record unreadable: ${(error as Error).message}`);
  }

  // Control-root half of the containment gate: the canonical parent chain of
  // the invoked sdd dir must land on the canonical control root recorded at
  // capture time. A record too broken to carry a context stays on the
  // structured integrity lanes (it can never verify successfully anyway).
  if (isPlainObject(record)) {
    const request = (record as { request?: unknown }).request;
    const context = isPlainObject(request) ? (request as { context?: unknown }).context : null;
    const controlRoot =
      isPlainObject(context) && typeof (context as { controlHarnessRoot?: unknown }).controlHarnessRoot === "string"
        ? (context as { controlHarnessRoot: string }).controlHarnessRoot
        : null;
    if (controlRoot !== null && dirname(dirname(canonicalSddDir)) !== controlRoot) {
      throw usageError(
        `${VERIFY_USAGE}\n  --sdd-dir ${canonicalSddDir} is not under the canonical control root recorded in the record context (${controlRoot}); a relocated or copied evidence bundle is refused`,
      );
    }
  }

  const facts = await collectEvidenceArtifacts(runDir);
  const expected = { planId: invocation.planId, taskId: invocation.taskId, runId: invocation.runId };

  if (invocation.targetPath === undefined) {
    return assessSddEvidenceReuse(record, facts, expected);
  }

  // Only a schema-valid record can define the target collection lane; a
  // malformed record short-circuits to a structured uncertain assessment.
  const schemaGate = validateSddEvidenceRecord(record);
  if (!schemaGate.ok) {
    return assessSddEvidenceReuse(record, facts, expected);
  }
  const targetRequest = loadTargetRequest(invocation.targetPath);
  const parsed = record as SddEvidenceRecord;
  const target = await collectEvidenceInputs({
    cwd: targetRequest.cwd,
    inputs: parsed.request.inputs,
    argv: parsed.command.argv,
    environmentKeys: parsed.request.environmentKeys,
    limits: v1Limits(),
  });
  // The CLI owns the explicit expectation failure: a mismatched observed
  // HEAD becomes a named target unknown consumed by the comparison lane.
  if (target.head !== null && target.head !== targetRequest.expectedHead) {
    target.unknowns.push("target.expected-head-mismatch");
  }
  return assessSddEvidenceReuse(record, facts, expected, target);
}

// ---------------------------------------------------------------------------
// Command registration.
// ---------------------------------------------------------------------------

function failEvidence(error: unknown, context: string): void {
  if (error instanceof SddScriptError) {
    console.error(pc.red(`${context} failed: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  console.error(pc.red(`${context} failed: ${(error as Error).message}`));
  process.exitCode = 1;
}

/**
 * Register `sdd evidence capture` and `sdd evidence verify` beside the
 * existing sdd commands. The old `sdd exec` surface is untouched.
 */
export function registerSddEvidenceCommands(sddCommand: Command): void {
  const evidenceCommand = sddCommand
    .command("evidence")
    .description(
      "Capture and verify SDD test evidence bundles (developer-authorized checks; capture runs POSIX linux/darwin only, verify is read-only and portable)",
    );

  evidenceCommand
    .command("capture")
    .description(
      "Run an already-authorized check once and retain its raw evidence under {SDD_DIR}/evidence/<run-uuid> " +
        "(literal argv, no shell; exit: child code preserved, missing executable 127, timeout 124, signals 128+n, gate/IO 1, usage 2)",
    )
    .option("--request <path>", "Absolute path to the immutable task capture request JSON")
    .argument("[argv...]", "Child executable + args placed after -- (passed through unchanged)")
    .action(async (argv: string[], options: { request?: string }) => {
      try {
        if (!options.request) throw usageError(CAPTURE_USAGE);
        if (argv.length === 0) {
          throw usageError(`${CAPTURE_USAGE}\n  The argv after -- is passed to the child literally (no shell).`);
        }
        const requestDoc = loadJsonFileUsage(options.request, "--request");
        const request = validateRequestUsage(requestDoc);
        const result = await captureSddEvidence(request, argv);
        // Prefixed evidence paths on stderr — never an acceptance-success label.
        console.error(`evidence run: ${result.runDir}`);
        console.error(`evidence record: ${join(result.runDir, "record.json")}`);
        process.exitCode = result.exitCode;
      } catch (error) {
        failEvidence(error, "sdd evidence capture");
      }
    });

  evidenceCommand
    .command("verify")
    .description(
      "Read-only integrity/applicability assessment of a retained evidence bundle (never runs the recorded child; " +
        "no-target exit 0 means complete integrity only; with --target exit 0 means reuse candidate)",
    )
    .option("--sdd-dir <path>", "Absolute path to the plan's SDD dir")
    .option("--plan <id>", "Expected plan id")
    .option("--task <id>", "Expected task id")
    .option("--run <uuid>", "Expected run id (canonical RFC4122 v4 UUID)")
    .option("--target <path>", "Absolute path to an EvidenceTargetRequest JSON for applicability assessment")
    .action(async (options: { sddDir?: string; plan?: string; task?: string; run?: string; target?: string }) => {
      try {
        if (!options.sddDir || !options.plan || !options.task || !options.run) throw usageError(VERIFY_USAGE);
        if (!isAbsolute(options.sddDir)) throw usageError(`${VERIFY_USAGE}\n  --sdd-dir must be an absolute path`);
        if (!SAFE_COMPONENT_RE.test(options.plan)) throw usageError(`${VERIFY_USAGE}\n  --plan must be a single safe path component`);
        if (!isIdLike(options.task)) throw usageError(`${VERIFY_USAGE}\n  --task must be a nonempty trimmed id without path semantics`);
        if (!UUID_V4_RE.test(options.run)) throw usageError(`${VERIFY_USAGE}\n  --run must be a canonical lowercase RFC4122 v4 UUID`);
        if (options.target !== undefined && !isAbsolute(options.target)) {
          throw usageError(`${VERIFY_USAGE}\n  --target must be an absolute path`);
        }
        const assessment = await runEvidenceVerify({
          sddDir: options.sddDir,
          planId: options.plan,
          taskId: options.task,
          runId: options.run,
          targetPath: options.target,
        });
        // Exactly one JSON assessment on stdout; the verifier never writes
        // an assessment artifact.
        console.log(JSON.stringify(assessment));
        if (options.target === undefined) {
          console.error(`evidence verify: integrity only; outcome=${assessment.outcome}; acceptance not assessed`);
          process.exitCode = assessment.integrity.ok ? 0 : 1;
        } else if (assessment.applicability === "candidate") {
          console.error("reuse candidate; coverage review required");
          process.exitCode = 0;
        } else {
          process.exitCode = 1;
        }
      } catch (error) {
        failEvidence(error, "sdd evidence verify");
      }
    });
}
