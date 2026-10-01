/**
 * scripts/skill-eval/runner.ts — subprocess execution
 * (Spec A1 run stage).
 *
 * Executes a prepared, frozen manifest selection through argv-array
 * subprocesses (no shell, no string interpolation), captures evidence per
 * run unit, and maintains a resumable scheduler whose completed run IDs —
 * never inferred "latest sessions" — drive interrupted-run continuation.
 *
 * Contracts implemented here (Spec A1):
 * - The child cwd is explicitly a per-unit copy of the prepared case fixture;
 * the prompt goes to the child over a file-backed stdin and stdout/stderr
 * are file streams (events.jsonl / stderr.txt raw bytes preserved).
 * - Thread IDs are captured from thread.started events only; resume uses the
 * exact captured ID with the same case/variant/workspace/sandbox and
 * rejects cross-arm or ephemeral resume. Resume identity is checked
 * state-vs-evidence: thread id from a fresh re-scan of preserved turn-1
 * events, cwd/sandbox from preserved turn-1 argv.json (C-W4).
 * - Timed-out children are terminated (SIGTERM, then SIGKILL after a grace
 * period; direct child only — see README known limits); stderr, exit code
 * and signal are preserved either way. Re-executed turns archive the
 * previous attempt's raw bytes under aborted/ instead of deleting them.
 * - The event adapter tolerates unknown records and malformed JSON lines
 * (raw bytes are always retained in events.jsonl) and never invents usage:
 * missing counters stay null with an explicit reason, and the per-turn vs
 * cumulative basis stays "unknown" until a real smoke verifies attribution.
 * - Grades are pass | fail | unverified | infrastructure_error; assertions
 * without adjudicable evidence are unverified — never silent passes.
 * - Infrastructure failures and unverified evidence keep their place in the
 * attempted denominator and dominate the exit code (2), ahead of assertion
 * failures (1); only all-verified passes exit 0. Nothing here marks the
 * overall plan Done: unit tests on synthetic adapters prove scheduler and
 * parser correctness only (AC4 honesty separation).
 *
 * All model-facing behavior flows through the injected `SpawnFn` seam; the
 * bundled unit tests run entirely on synthetic adapters (tagged "synthetic").
 */
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalJson,
  canonicalRunId,
  computeConfigHash,
  disposableRootContainmentErrors,
  deriveDisposableRepoRoot,
  REPEATS_ALLOWED,
  sha256Hex,
  SMOKE_CASE_COUNT,
  validateRunSplit,
  VARIANT_IDS,
  type AssertionKind,
  type CaseSplit,
  type EvalManifest,
  type GroupedFactsSpec,
  type Io,
  type PreparedManifestCase,
  type RunSplit,
  type SandboxMode,
} from "./manifest.ts";

// ---------------------------------------------------------------------------
// Schema constants and grades
// ---------------------------------------------------------------------------

export const RUNNER_SCHEMA_VERSION = 1;

export const UNIT_GRADES = ["pass", "fail", "unverified", "infrastructure_error"] as const;
export type UnitGrade = (typeof UNIT_GRADES)[number];

export const USAGE_BASES = ["per_turn", "cumulative", "unknown"] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

export const READ_EVIDENCE_KINDS = ["observed_tool_read", "declared_only", "unknown"] as const;
export type ReadEvidence = (typeof READ_EVIDENCE_KINDS)[number];

const AUTH_FAILURE_RE =
  /\b(unauthori[sz]ed|authentication|not logged in|invalid api key|api key|quota|rate limit|401|403)\b/i;
const THREAD_STARTED_RE = /^thread[._-]?started$/i;
const TURN_COMPLETED_RE = /^turn[._-]?completed$/i;
const FAILURE_EVENT_RE = /^(error|turn[._-]?failed)$/i;
const TOOL_ACTIVITY_RE =
  /(command_execution|tool_call|tool_use|function_call|local_shell_call|mcp_tool_call|shell_command|exec_command|file_read|read_file)/i;

// ---------------------------------------------------------------------------
// IO seam (extends Task 1's Io with the directory ops the runner needs)
// ---------------------------------------------------------------------------

export interface RunnerIo extends Io {
  readDir(path: string): string[];
  isFile(path: string): boolean;
  copyFile(from: string, to: string): void;
  removeDeep(path: string): void;
  rename(from: string, to: string): void;
}

export const nodeRunnerIo: RunnerIo = {
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  },
  ensureDir: (path) => mkdirSync(path, { recursive: true }),
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
  readDir: (path) => readdirSync(path),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  copyFile: (from, to) => {
    mkdirSync(resolve(to, ".."), { recursive: true });
    copyFileSync(from, to);
  },
  removeDeep: (path) => rmSync(path, { recursive: true, force: true }),
  rename: (from, to) => renameSync(from, to),
};

// ---------------------------------------------------------------------------
// Spawn seam: argv-array only, file-backed stdio, explicit cwd
// ---------------------------------------------------------------------------

export interface SpawnRequest {
  file: string;
  argv: readonly string[];
  cwd: string;
 /** File whose bytes become the child's stdin (the case prompt). */
  stdinFile: string;
 /** events.jsonl — raw child stdout bytes are appended here. */
  stdoutFile: string;
 /** stderr.txt — raw child stderr bytes are appended here. */
  stderrFile: string;
  timeoutMs: number;
}

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;

export { nodeLaunch as defaultLaunchFn } from "./node-launch.ts";

// ---------------------------------------------------------------------------
// Argv builders (Spec A1 shapes) + hard flag guards
// ---------------------------------------------------------------------------

export function rejectForbiddenFlags(
  argv: readonly string[],
  context: string,
  opts: { allowEphemeral?: boolean } = {},
): void {
  if (argv.includes("--last")) {
    throw new Error(`${context}: forbidden flag --last (Spec A1: resume never uses --last)`);
  }
  if (!opts.allowEphemeral && argv.includes("--ephemeral")) {
    throw new Error(`${context}: forbidden flag --ephemeral (Spec A1: only on non-resumable first turns)`);
  }
}

/**
 * First turn: `codex -a never exec --json --ignore-user-config --sandbox
 * <sandbox> --skip-git-repo-check --cd <fixture> --output-last-message
 * <final> [-`+`-ephemeral] -`. Resumable cases must NOT get --ephemeral;
 * single-turn cases may (Spec A1).
 */
export function buildFirstTurnArgv(opts: {
  cliPath: string;
  sandbox: SandboxMode;
  fixtureDir: string;
  finalPath: string;
  resumable: boolean;
}): string[] {
  const argv = [
    opts.cliPath,
    "-a",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--sandbox",
    opts.sandbox,
    "--skip-git-repo-check",
    "--cd",
    opts.fixtureDir,
    "--output-last-message",
    opts.finalPath,
  ];
  if (!opts.resumable) argv.push("--ephemeral");
  argv.push("-");
 // --ephemeral is legal here exactly when the case is single-turn.
  rejectForbiddenFlags(argv, "first-turn argv", { allowEphemeral: !opts.resumable });
  return argv;
}

/**
 * Resume: parent exec options precede `resume` because resume help does not
 * list --cd/--sandbox (Spec A1). Never --last, never --ephemeral. The thread
 * id is the exact captured thread.started value — never "--last".
 */
export function buildResumeArgv(opts: {
  cliPath: string;
  sandbox: SandboxMode;
  fixtureDir: string;
  finalPath: string;
  threadId: string;
}): string[] {
  const argv = [
    opts.cliPath,
    "-a",
    "never",
    "exec",
    "--json",
    "--ignore-user-config",
    "--sandbox",
    opts.sandbox,
    "--cd",
    opts.fixtureDir,
    "resume",
    opts.threadId,
    "--output-last-message",
    opts.finalPath,
    "-",
  ];
  rejectForbiddenFlags(argv, "resume argv");
  return argv;
}

export interface ResumeGuardInput {
  unitId: string;
  /**
 * Thread id from INDEPENDENT evidence: the fresh re-scan of the preserved
 * turn-1 events (not the scheduler state)..
 */
  recordedThreadId: string | null;
 /** True when the first turn ran with --ephemeral (single-turn case). */
  turn1Ephemeral: boolean;
 /** Planned resume identity from the scheduler request for this unit. */
  planned: { unitId: string; threadId: string; cwd: string; sandbox: string };
  /**
 * Recorded identity from preserved turn-1 `argv.json` (`--cd` / `--sandbox`
 * values) — never echoed back from the same state object the planned values
 * come from, so the cross-arm comparisons can actually fail (C-W4).
 */
  recordedCwd: string | null;
  recordedSandbox: string | null;
}

/**
 * Typed evidence-integrity rejection : thrown by the resume
 * guard for cross-arm/ephemeral/tampered resume. Callers classify on this
 * type — never on error-message text, which refactors cannot silently break.
 */
export class ResumeRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRejectionError";
  }
}

/**
 * Rejects cross-arm resume (thread id / unit identity / cwd / sandbox that
 * does not belong to this exact unit) and ephemeral resume. Throws
 * {@link ResumeRejectionError} naming the violated rule; the caller never
 * spawns on throw. `recorded*` values must come from preserved turn-1
 * evidence (argv.json + event re-scan), not from the scheduler state, so
 * every comparison is state-vs-evidence rather than self-comparison.
 */
export function assertResumeAllowed(input: ResumeGuardInput): void {
  if (input.recordedThreadId === null || input.recordedThreadId === "") {
    throw new ResumeRejectionError(
      `resume rejected for ${input.planned.unitId}: no thread id in the preserved turn-1 evidence (thread.started was never observed)`,
    );
  }
  if (input.turn1Ephemeral) {
    throw new ResumeRejectionError(
      `ephemeral resume rejected for ${input.planned.unitId}: ephemeral first turns cannot be resumed`,
    );
  }
  if (input.planned.unitId !== input.unitId) {
    throw new ResumeRejectionError(
      `cross-arm resume rejected: planned unit ${input.planned.unitId} does not match recorded unit ${input.unitId}`,
    );
  }
  if (input.planned.threadId !== input.recordedThreadId) {
    throw new ResumeRejectionError(
      `cross-arm resume rejected: planned thread id ${JSON.stringify(input.planned.threadId)} does not match the id in preserved turn-1 evidence ${JSON.stringify(input.recordedThreadId)}`,
    );
  }
  if (input.recordedCwd !== null && input.planned.cwd !== input.recordedCwd) {
    throw new ResumeRejectionError(
      `cross-arm resume rejected: resume cwd differs from the turn-1 argv.json cwd for ${input.unitId}`,
    );
  }
  if (input.recordedSandbox !== null && input.planned.sandbox !== input.recordedSandbox) {
    throw new ResumeRejectionError(
      `cross-arm resume rejected: resume sandbox differs from the turn-1 argv.json sandbox for ${input.unitId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Event adapter: tolerant parsing, raw bytes preserved on disk by the caller
// ---------------------------------------------------------------------------

export interface ParsedEventRecord {
  line: number;
  raw: string;
  json: Record<string, unknown> | null;
  parseError: string | null;
}

export interface UsageObservation {
  line: number;
  eventId: string | null;
  usage: Record<string, number>;
}

/** Observed outcome of one invocation call: unsupported encodings stay `unknown`. */
export type InvocationOutcome = "failed" | "succeeded" | "unknown";

export interface InvocationCallObservation {
  line: number;
  /** Invocation identity (item id, then outer event id); null = absent (honest unknown). */
  identity: string | null;
  itemType: string;
  phase: "single" | "started" | "completed";
  /** Observed failure only; unsupported failure shapes are NOT coerced to success. */
  failed: boolean;
  outcome: InvocationOutcome;
  /** Observable constituent lookups beyond the envelope itself (bundled shell commands). */
  bundledLookups: number;
  /** The payload shape could not be decomposed → bundled accounting is unknown. */
  bundleUnknown: boolean;
}

export interface EventStreamScan {
  threadId: string | null;
  usageEvents: UsageObservation[];
  authFailure: { line: number; detail: string } | null;
  toolActivityObserved: boolean;
  malformedRecords: number;
  unknownRecords: number;
  warnings: string[];
  /**
   * Bounded-resolution invocation accounting. A start/completed pair sharing
   * one invocation identity is ONE call; a record without any identity is an
   * honest unknown — listed individually, never zero-filled, never deduped.
   */
  invocationCalls: InvocationCallObservation[];
  /** Distinct identities observed (+1 per identity-less record). */
  countedInvocations: number;
  /** Observed failures among the counted calls (unsupported shapes excluded). */
  failedInvocations: number;
  /** Counted calls whose outcome could not be determined from the record shape. */
  unknownOutcomeInvocations: number;
  /** Counted calls whose invocation identity was absent. */
  unknownIdentityCalls: number;
  /** Read-shaped invocations among the counted calls (type-based count, not lookup depth). */
  readShapedInvocations: number;
  /** Observable constituent lookups bundled inside counted envelopes. */
  bundledLookups: number;
  /** Counted calls whose internal bundle could not be decomposed. */
  bundleUnknownCalls: number;
}

export function parseEventLines(raw: string): ParsedEventRecord[] {
  const records: ParsedEventRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        records.push({
          line: i + 1,
          raw: line,
          json: null,
          parseError: `record is not a JSON object: ${parsed === null ? "null" : typeof parsed}`,
        });
      } else {
        records.push({ line: i + 1, raw: line, json: parsed as Record<string, unknown>, parseError: null });
      }
    } catch (error) {
      records.push({ line: i + 1, raw: line, json: null, parseError: (error as Error).message });
    }
  }
  return records;
}

function eventIdOf(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const item = (json.item ?? null) as Record<string, unknown> | null;
  const raw = json.id ?? item?.id ?? null;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

function eventIdOfRecord(record: ParsedEventRecord): string | null {
  return eventIdOf(record.json);
}

/**
 * Invocation identity for bounded-resolution dedupe: prefers the item's own
 * id (the invocation's identity) over the outer event id — the envelope ids
 * of an invocation's started and completed phases may differ.
 */
function invocationIdOfRecord(record: ParsedEventRecord): string | null {
  if (!record.json) return null;
  const item = (record.json.item ?? null) as Record<string, unknown> | null;
  const raw = item !== null && typeof item === "object" ? item.id : null;
  if (typeof raw === "string" && raw !== "") return raw;
  return eventIdOfRecord(record);
}

const SUCCESS_STATUS_ENCODINGS = new Set(["completed", "succeeded", "success", "ok"]);

/**
 * Observed outcome from the VERIFIED shapes only: an explicit `failed`
 * status, a verified success status, or a numeric exit code. Anything else —
 * including a status spelling this adapter does not recognize — stays
 * `unknown`; it is never coerced into a known success or a known zero-failure.
 */
function invocationOutcomeOf(json: Record<string, unknown>, item: Record<string, unknown> | null): InvocationOutcome {
  const status = item !== null && typeof item.status === "string" ? item.status : typeof json.status === "string" ? json.status : null;
  if (status === "failed") return "failed";
  if (status !== null && SUCCESS_STATUS_ENCODINGS.has(status)) return "succeeded";
  const exit = item !== null ? item.exit_code ?? item.exitCode : json.exit_code ?? json.exitCode;
  if (typeof exit === "number") return exit === 0 ? "succeeded" : "failed";
  return "unknown";
}

const SHELL_COMMAND_ITEM_TYPES = new Set(["command_execution", "local_shell_call", "shell_command", "exec_command"]);
/** Generic tool envelopes whose internal call bundle cannot be decomposed here. */
const OPAQUE_TOOL_ITEM_TYPES = new Set(["tool_call", "function_call", "mcp_tool_call"]);

/**
 * Observable constituent lookups inside one counted envelope. A shell line
 * (`cmd && cmd2`) bundles several causal commands; argv arrays are one
 * command. An opaque tool envelope has an unknown internal bundle, and
 * is reported as such rather than assumed to be a single lookup.
 */
function constituentLookups(itemType: string, item: Record<string, unknown> | null): { bundled: number; unknown: boolean } {
  if (OPAQUE_TOOL_ITEM_TYPES.has(itemType)) return { bundled: 0, unknown: true };
  if (item === null) return { bundled: 0, unknown: true };
  const command = item.command;
  if (Array.isArray(command)) return { bundled: 0, unknown: false };
  if (typeof command === "string" && command.trim() !== "") {
    const parts = command.split(/&&|\|\||;|\n|\|/).map((part) => part.trim()).filter((part) => part !== "");
    return { bundled: Math.max(0, parts.length - 1), unknown: false };
  }
  // file_read / read_file are single-lookup types; other read-shaped item
  // types carry payloads this adapter cannot decompose.
  if (itemType === "file_read" || itemType === "read_file") return { bundled: 0, unknown: false };
  return { bundled: 0, unknown: true };
}

export function scanEventRecords(records: ParsedEventRecord[]): EventStreamScan {
  const scan: EventStreamScan = {
    threadId: null,
    usageEvents: [],
    authFailure: null,
    toolActivityObserved: false,
    malformedRecords: 0,
    unknownRecords: 0,
    warnings: [],
    invocationCalls: [],
    countedInvocations: 0,
    failedInvocations: 0,
    unknownOutcomeInvocations: 0,
    unknownIdentityCalls: 0,
    readShapedInvocations: 0,
    bundledLookups: 0,
    bundleUnknownCalls: 0,
  };
  const seenIdentities = new Map<string, number>();
  /** Merges one observation into its already-counted identity (never a second call). */
  const mergeInto = (existing: InvocationCallObservation, observation: InvocationCallObservation): void => {
    if (observation.outcome === "failed" && existing.outcome !== "failed") {
      if (existing.outcome === "unknown") scan.unknownOutcomeInvocations -= 1;
      existing.outcome = "failed";
      existing.failed = true;
      scan.failedInvocations += 1;
    } else if (observation.outcome === "succeeded" && existing.outcome === "unknown") {
      existing.outcome = "succeeded";
      scan.unknownOutcomeInvocations -= 1;
    }
    if (READ_ITEM_TYPES.has(observation.itemType) && !READ_ITEM_TYPES.has(existing.itemType)) {
      existing.itemType = observation.itemType;
      scan.readShapedInvocations += 1;
    }
    if (observation.bundledLookups > existing.bundledLookups) {
      scan.bundledLookups += observation.bundledLookups - existing.bundledLookups;
      existing.bundledLookups = observation.bundledLookups;
    }
    if (observation.bundleUnknown && !existing.bundleUnknown) {
      existing.bundleUnknown = true;
      scan.bundleUnknownCalls += 1;
    }
  };
  const countNew = (observation: InvocationCallObservation): void => {
    scan.countedInvocations += 1;
    if (observation.identity === null) scan.unknownIdentityCalls += 1;
    if (observation.outcome === "failed") scan.failedInvocations += 1;
    if (observation.outcome === "unknown") scan.unknownOutcomeInvocations += 1;
    if (READ_ITEM_TYPES.has(observation.itemType)) scan.readShapedInvocations += 1;
    scan.bundledLookups += observation.bundledLookups;
    if (observation.bundleUnknown) scan.bundleUnknownCalls += 1;
  };
  for (const record of records) {
    if (record.parseError !== null) {
      scan.malformedRecords += 1;
      scan.warnings.push(`malformed JSON at line ${record.line} (raw bytes retained): ${record.parseError}`);
      continue;
    }
    const json = record.json!;
    const type = typeof json.type === "string" ? json.type : "";
    const item = (json.item ?? null) as Record<string, unknown> | null;
    const itemType = item && typeof item.type === "string" ? item.type : "";

    if (THREAD_STARTED_RE.test(type)) {
      const id = json.thread_id;
      if (typeof id === "string" && id !== "") {
        if (scan.threadId !== null && scan.threadId !== id) {
          scan.warnings.push(`multiple distinct thread ids observed (line ${record.line}); keeping the first`);
        } else {
          scan.threadId = id;
        }
      } else {
        scan.unknownRecords += 1;
        scan.warnings.push(`thread.started record at line ${record.line} carries no usable thread_id (tolerated)`);
      }
      continue;
    }
    if (TURN_COMPLETED_RE.test(type)) {
      const usageRaw = json.usage;
      if (usageRaw !== null && typeof usageRaw === "object" && !Array.isArray(usageRaw)) {
        const numeric: Record<string, number> = {};
        for (const [key, value] of Object.entries(usageRaw as Record<string, unknown>)) {
          if (typeof value === "number") numeric[key] = value;
        }
        scan.usageEvents.push({ line: record.line, eventId: eventIdOf(json), usage: numeric });
      }
 // turn.completed without a usage object => absent usage; nothing recorded.
      continue;
    }
    if (FAILURE_EVENT_RE.test(type)) {
      const message = json.message ?? (json.error as Record<string, unknown> | undefined)?.message ?? "";
      const detail = typeof message === "string" ? message : JSON.stringify(message);
      if (AUTH_FAILURE_RE.test(detail)) {
        scan.authFailure = { line: record.line, detail };
      }
      continue;
    }
    if (TOOL_ACTIVITY_RE.test(type) || TOOL_ACTIVITY_RE.test(itemType)) {
      scan.toolActivityObserved = true;
 // Bounded-resolution accounting: dedupe start/completed pairs by
 // invocation identity; identity-less records stay individual unknowns.
      const identity = invocationIdOfRecord(record);
      const itemTypeForCall = itemType || type;
      const phase: InvocationCallObservation["phase"] = /item[._-]?started$/i.test(type)
        ? "started"
        : /item[._-]?completed$/i.test(type)
          ? "completed"
          : "single";
      const outcome = invocationOutcomeOf(json, item);
      const bundle = constituentLookups(itemTypeForCall, item);
      const observation: InvocationCallObservation = {
        line: record.line,
        identity,
        itemType: itemTypeForCall,
        phase,
        failed: outcome === "failed",
        outcome,
        bundledLookups: bundle.bundled,
        bundleUnknown: bundle.unknown,
      };
      if (identity === null) {
        scan.invocationCalls.push(observation);
        countNew(observation);
      } else {
        const seenAt = seenIdentities.get(identity);
        if (seenAt === undefined) {
          seenIdentities.set(identity, scan.invocationCalls.length);
          scan.invocationCalls.push(observation);
          countNew(observation);
        } else {
          mergeInto(scan.invocationCalls[seenAt]!, observation);
        }
      }
      continue;
    }
    scan.unknownRecords += 1;
    scan.warnings.push(`unknown event record at line ${record.line} (type ${JSON.stringify(type || "<none>")}); tolerated, raw bytes retained`);
  }
  return scan;
}

export function scanEventStream(raw: string): EventStreamScan {
  return scanEventRecords(parseEventLines(raw));
}

const TURN_FAILED_RE = /^turn[._-]?failed$/i;

/** One turn's event stream as read from disk, with readability evidence. */
export interface UnitTurnStream {
  turn: number;
  threadId: string | null;
  /** false = the event artifact could not be read at all (missing/unreadable). */
  readable: boolean;
  records: ParsedEventRecord[];
}

/**
 * Unit-scope invocation accounting (Task 2 R1/R5): identity is deduplicated
 * across the unit's turns under the turn's thread identity, so a start phase
 * in turn 1 and its completed phase in turn 2 count once. Terminal evidence
 * (`turn.completed` / `turn.failed`) is tracked per stream: a missing,
 * empty, unterminated, or unreadable stream cannot establish accounting
 * completeness, so a zero-call total from such a stream is never a pass.
 */
export interface UnitInvocationAccounting {
  envelopes: number;
  bundledLookups: number;
  effectiveLookups: number;
  failed: number;
  unknownOutcome: number;
  unknownIdentity: number;
  readShaped: number;
  unrecognizedRecords: number;
  malformedRecords: number;
  unreadableTurns: number[];
  emptyTurns: number[];
  /** Readable, non-empty streams with no terminal completion/failure marker. */
  unterminatedTurns: number[];
  bundleUnknownCalls: number;
  /** Identities observed across turns without a thread scope to bind them. */
  scopeUnknownIdentities: string[];
}

export function accountUnitInvocations(streams: UnitTurnStream[]): UnitInvocationAccounting {
  const accounting: UnitInvocationAccounting = {
    envelopes: 0,
    bundledLookups: 0,
    effectiveLookups: 0,
    failed: 0,
    unknownOutcome: 0,
    unknownIdentity: 0,
    readShaped: 0,
    unrecognizedRecords: 0,
    malformedRecords: 0,
    unreadableTurns: [],
    emptyTurns: [],
    unterminatedTurns: [],
    bundleUnknownCalls: 0,
    scopeUnknownIdentities: [],
  };
  interface ScopeEntry { itemType: string; outcome: InvocationOutcome; bundled: number; bundleUnknown: boolean }
  const byScope = new Map<string, ScopeEntry>();
  const unscopedIdentities = new Set<string>();
  const countNew = (entry: ScopeEntry, identity: string | null): void => {
    accounting.envelopes += 1;
    if (identity === null) accounting.unknownIdentity += 1;
    if (entry.outcome === "failed") accounting.failed += 1;
    if (entry.outcome === "unknown") accounting.unknownOutcome += 1;
    if (READ_ITEM_TYPES.has(entry.itemType)) accounting.readShaped += 1;
    accounting.bundledLookups += entry.bundled;
    if (entry.bundleUnknown) accounting.bundleUnknownCalls += 1;
  };
  for (const stream of streams) {
    if (!stream.readable) {
      accounting.unreadableTurns.push(stream.turn);
      continue;
    }
    if (stream.records.length === 0) {
      accounting.emptyTurns.push(stream.turn);
      continue;
    }
    const sawTerminal = stream.records.some((record) => {
      const type = record.json !== null && typeof record.json.type === "string" ? record.json.type : "";
      return TURN_COMPLETED_RE.test(type) || TURN_FAILED_RE.test(type);
    });
    if (!sawTerminal) accounting.unterminatedTurns.push(stream.turn);
    const scan = scanEventRecords(stream.records);
    accounting.unrecognizedRecords += scan.unknownRecords;
    accounting.malformedRecords += scan.malformedRecords;
    for (const observation of scan.invocationCalls) {
      if (observation.identity === null) {
        countNew({ itemType: observation.itemType, outcome: observation.outcome, bundled: observation.bundledLookups, bundleUnknown: observation.bundleUnknown }, null);
        continue;
      }
      if (stream.threadId === null) unscopedIdentities.add(observation.identity);
      const key = `${stream.threadId ?? "<no-thread>"}::${observation.identity}`;
      const existing = byScope.get(key);
      if (existing === undefined) {
        const entry: ScopeEntry = { itemType: observation.itemType, outcome: observation.outcome, bundled: observation.bundledLookups, bundleUnknown: observation.bundleUnknown };
        byScope.set(key, entry);
        countNew(entry, observation.identity);
        continue;
      }
      // Same scoped invocation identity across the unit's turns: one call;
      // failure and read-shape merge onto the already-counted entry.
      if (observation.outcome === "failed" && existing.outcome !== "failed") {
        if (existing.outcome === "unknown") accounting.unknownOutcome -= 1;
        existing.outcome = "failed";
        accounting.failed += 1;
      } else if (observation.outcome === "succeeded" && existing.outcome === "unknown") {
        existing.outcome = "succeeded";
        accounting.unknownOutcome -= 1;
      }
      if (READ_ITEM_TYPES.has(observation.itemType) && !READ_ITEM_TYPES.has(existing.itemType)) {
        existing.itemType = observation.itemType;
        accounting.readShaped += 1;
      }
      if (observation.bundledLookups > existing.bundled) {
        accounting.bundledLookups += observation.bundledLookups - existing.bundled;
        existing.bundled = observation.bundledLookups;
      }
      if (observation.bundleUnknown && !existing.bundleUnknown) {
        existing.bundleUnknown = true;
        accounting.bundleUnknownCalls += 1;
      }
    }
  }
  accounting.scopeUnknownIdentities = [...unscopedIdentities];
  accounting.effectiveLookups = accounting.envelopes + accounting.bundledLookups;
  return accounting;
}

/**
 * Item types whose typed fields can carry an observed tool/file read (schema
 * verified against the real round-1 smoke streams: reads surface as
 * `command_execution` items whose `command` is the observed shell argv;
 * array-shaped commands from synthetic/other adapters are joined). Agent
 * messages, error notices, thread/turn bookkeeping and file-change records
 * are NOT read-shaped.
 */
const READ_ITEM_TYPES = new Set([
  "command_execution",
  "file_read",
  "read_file",
  "tool_call",
  "function_call",
  "local_shell_call",
  "mcp_tool_call",
  "shell_command",
  "exec_command",
]);

/**
 * Typed command text of a read-shaped record, or null. Matches ONLY the
 * observed command argv (`item.command`, string or string array) — never the
 * whole serialized record. A command whose *output* merely mentions the
 * needle (e.g. `find .` listing a filename) is not an observed read; neither
 * is an agent message claiming one.
 */
function observedReadCommandText(record: ParsedEventRecord): string | null {
  if (!record.json) return null;
  const item = (record.json.item ?? null) as Record<string, unknown> | null;
  if (!item || typeof item !== "object") return null;
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!READ_ITEM_TYPES.has(itemType)) return null;
  const command = item.command;
  if (typeof command === "string" && command !== "") return command;
  if (Array.isArray(command)) {
    const joined = command.filter((c) => typeof c === "string").join(" ").trim();
    return joined === "" ? null : joined;
  }
  return null;
}

export interface ToolReadHit {
  turn: number;
  line: number;
  eventId: string | null;
}

/**
 * Search parsed event records for an OBSERVED read of the needle: only
 * read-shaped item records count, and only their typed command field is
 * searched (C-W1/QC-wave-1: matched to the verified real event schema —
 * `command_execution.command` argv — instead of raw substring over the whole
 * serialized record).
 */
export function findToolReadRecord(records: ParsedEventRecord[], needle: string, turn: number): ToolReadHit | null {
  for (const record of records) {
    const commandText = observedReadCommandText(record);
    if (commandText === null) continue;
    if (commandText.includes(needle)) {
      return { turn, line: record.line, eventId: eventIdOfRecord(record) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface TurnMetrics {
  runId: string;
  turn: number;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  threadId: string | null;
  usageEvents: UsageObservation[];
 /** Aggregate counters stay null unless the usage basis is verified. */
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reason: string | null };
  usageBasis: UsageBasis;
  readEvidence: ReadEvidence;
 /** Bounded-resolution invocation accounting, straight from this turn's event scan (raw observations, not attribution; unit-scope dedupe is graded by the assertion). */
  invocations: { counted: number; failed: number; unknownOutcome: number; unknownIdentity: number; readShaped: number; bundled: number; bundleUnknown: number; unrecognized: number };
 /** Declared bootstrap context for this case ("warm"/"cold"); null = the case declares none. */
  resolutionContext: "warm" | "cold" | null;
 /** Loaded-bytes accounting: labelled bytes, null with reason until verifiable. */
  bytesLoaded: { bytes: number | null; unit: "bytes"; reason: string | null };
 /** Cost only with observed usage AND a recorded price source; otherwise null. */
  costUsd: { amount: number | null; reason: string };
  adapterWarnings: string[];
}

const BYTES_UNVERIFIED_REASON =
  "file-read byte accounting requires a verified event schema; unverified until real smoke (Spec A1)";

function buildTurnMetrics(args: {
  runId: string;
  turn: number;
  elapsedMs: number;
  spawn: SpawnResult;
  scan: EventStreamScan;
  finalPresent: boolean;
  resolutionContext: "warm" | "cold" | null;
}): TurnMetrics {
  const { runId, turn, elapsedMs, spawn: spawnResult, scan } = args;
  let usageReason: string;
  if (scan.usageEvents.length === 0) {
    usageReason = "no usage events found in the event stream";
  } else {
    usageReason =
      "usage basis cannot be attributed per-turn vs cumulative from the stream; unverified until real smoke (per-event values preserved in usageEvents)";
  }
  const readEvidence: ReadEvidence = scan.toolActivityObserved
    ? "observed_tool_read"
    : args.finalPresent
      ? "declared_only"
      : "unknown";
  return {
    runId,
    turn,
    elapsedMs,
    exitCode: spawnResult.code,
    signal: spawnResult.signal,
    timedOut: spawnResult.timedOut,
    spawnError: spawnResult.spawnError,
    threadId: scan.threadId,
    usageEvents: scan.usageEvents,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, reason: usageReason },
    usageBasis: "unknown",
    readEvidence,
    invocations: {
      counted: scan.countedInvocations,
      failed: scan.failedInvocations,
      unknownOutcome: scan.unknownOutcomeInvocations,
      unknownIdentity: scan.unknownIdentityCalls,
      readShaped: scan.readShapedInvocations,
      bundled: scan.bundledLookups,
      bundleUnknown: scan.bundleUnknownCalls,
      unrecognized: scan.unknownRecords,
    },
    resolutionContext: args.resolutionContext,
    bytesLoaded: { bytes: null, unit: "bytes", reason: BYTES_UNVERIFIED_REASON },
    costUsd: { amount: null, reason: "no recorded price source; cost stays null (Spec A1)" },
    adapterWarnings: scan.warnings,
  };
}

// ---------------------------------------------------------------------------
// Scheduler state
// ---------------------------------------------------------------------------

export interface AssertionGrade {
  assertionId: string;
  kind: AssertionKind;
  grade: "pass" | "fail" | "unverified";
  evidence: { turn?: number; line?: number; eventId?: string | null; file?: string; detail: string };
}

export interface UnitGrading {
  unitId: string;
  grade: UnitGrade;
  assertions: AssertionGrade[];
  notes: string[];
}

export interface TurnRecord {
  runId: string;
  turn: number;
  argv: string[];
  status: "completed" | "infrastructure_error";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  infrastructureReason: string | null; // timeout | auth_failure | nonzero_exit | spawn_error
  threadId: string | null;
  metrics: TurnMetrics;
  artifacts: { prompt: string; events: string; stderr: string; final: string; metrics: string; argv: string };
}

export interface UnitRecord {
  unitId: string;
  caseId: string;
  variant: string;
  repeat: number;
  caseSplit: CaseSplit;
  cwd: string;
  sandbox: SandboxMode;
  resumable: boolean;
  turn1Ephemeral: boolean;
  threadId: string | null;
 /** null = pending (unit started but not graded — safe to resume). */
  grade: UnitGrade | null;
  failureReason: string | null;
  turns: Record<string, TurnRecord>;
  grading: UnitGrading | null;
  fixtureDiff: { created: string[]; modified: string[]; deleted: string[]; diffFile: string } | null;
}

export interface SchedulerState {
  schemaVersion: typeof RUNNER_SCHEMA_VERSION;
  manifestPath: string;
  manifestHash: string;
  requested: { split: RunSplit; variants: string[]; repeats: number };
  interleaveSeed: number;
  units: Record<string, UnitRecord>;
}

function persistState(io: RunnerIo, statePath: string, state: SchedulerState): void {
 // Write temp + rename so a crash mid-write cannot corrupt resumable state.
  const tmp = `${statePath}.tmp`;
  io.writeText(tmp, `${JSON.stringify(state, null, 2)}\n`);
  io.rename(tmp, statePath);
}

// ---------------------------------------------------------------------------
// Deterministic interleaved scheduling (manifest.interleaveSeed)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScheduledUnit {
  caseId: string;
  variant: string;
  repeat: number;
}

/**
 * Repeat-major interleaving: every repeat-1 unit runs before any repeat-2
 * unit; inside a repeat the (case, variant) pairs are shuffled with the
 * manifest's deterministic interleave seed.
 */
export function scheduleOrder(
  cases: readonly { id: string }[],
  variants: readonly string[],
  repeats: number,
  interleaveSeed: number,
): ScheduledUnit[] {
  const pairs = [...cases]
    .map((c) => c.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap((caseId) => VARIANT_IDS.filter((v) => variants.includes(v)).map((variant) => ({ caseId, variant })));
  const rand = mulberry32(interleaveSeed);
  const order: ScheduledUnit[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const shuffled = [...pairs];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const pair of shuffled) order.push({ ...pair, repeat });
  }
  return order;
}

// ---------------------------------------------------------------------------
// Fixture workspace + diff
// ---------------------------------------------------------------------------

/** Copy the prepared fixture into a fresh per-unit workspace, verifying the frozen per-file hashes. */
function copyPreparedFixture(io: RunnerIo, runDir: string, caseRec: PreparedManifestCase, workspace: string): void {
  for (const file of caseRec.fixture.files) {
    const source = join(runDir, "fixtures", caseRec.id, file.path);
    if (!io.exists(source)) {
      throw new Error(`prepared fixture file missing: ${source} (run against a manifest prepared by this task's prepare stage)`);
    }
    const actual = sha256Hex(io.readText(source));
    if (actual !== file.sha256) {
      throw new Error(`prepared fixture file hash mismatch for ${source}: frozen ${file.sha256} != actual ${actual}`);
    }
    io.writeText(join(workspace, file.path), io.readText(source));
  }
}

function walkWorkspace(io: RunnerIo, dir: string, prefix: string): string[] {
  if (!io.exists(dir)) return [];
  const out: string[] = [];
  for (const entry of io.readDir(dir)) {
    const abs = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (io.isFile(abs)) out.push(rel);
    else out.push(...walkWorkspace(io, abs, rel));
  }
  return out.sort();
}

export interface FixtureDiffResult {
  created: string[];
  modified: string[];
  deleted: string[];
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
}

export function diffWorkspace(io: RunnerIo, workspace: string, before: Record<string, string>): FixtureDiffResult {
  const afterPaths = walkWorkspace(io, workspace, "");
  const afterHashes: Record<string, string> = {};
  for (const rel of afterPaths) afterHashes[rel] = sha256Hex(io.readText(join(workspace, rel)));
  const created: string[] = [];
  const modified: string[] = [];
  for (const rel of afterPaths) {
    if (!(rel in before)) created.push(rel);
    else if (before[rel] !== afterHashes[rel]) modified.push(rel);
  }
  const deleted = Object.keys(before)
    .filter((rel) => !(rel in afterHashes))
    .sort();
  return { created, modified, deleted, beforeHashes: { ...before }, afterHashes };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

interface GradingContext {
  caseRec: PreparedManifestCase;
  unit: UnitRecord;
  io: RunnerIo;
  diff: FixtureDiffResult;
}

function lastCompletedTurn(unit: UnitRecord): TurnRecord | null {
  const turns = Object.values(unit.turns)
    .filter((t) => t.status === "completed")
    .sort((a, b) => a.turn - b.turn);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

function gradeFinalAssertion(
  ctx: GradingContext,
  assertionId: string,
  kind: "final_contains" | "final_not_contains",
  value: string,
): AssertionGrade {
  const turn = lastCompletedTurn(ctx.unit);
  if (!turn) {
    return {
      assertionId,
      kind,
      grade: "unverified",
      evidence: { detail: "no completed turn produced a final message; semantic outcome stays unverified until evidence adjudicated" },
    };
  }
  let content: string | null = null;
  try {
    content = ctx.io.readText(turn.artifacts.final);
  } catch {
    content = null;
  }
  if (content === null) {
    return {
      assertionId,
      kind,
      grade: "unverified",
      evidence: { turn: turn.turn, file: turn.artifacts.final, detail: "final.md missing; outcome unverified until evidence adjudicated" },
    };
  }
  const contains = content.includes(value);
  const pass = kind === "final_contains" ? contains : !contains;
  return {
    assertionId,
    kind,
    grade: pass ? "pass" : "fail",
    evidence: {
      turn: turn.turn,
      file: turn.artifacts.final,
      detail: pass
        ? `final message ${kind === "final_contains" ? "contains" : "excludes"} ${JSON.stringify(value)}`
        : `final message did not ${kind === "final_contains" ? "contain" : "exclude"} ${JSON.stringify(value)}`,
    },
  };
}

function collectTurnRecords(unit: UnitRecord, io: RunnerIo): { turn: number; records: ParsedEventRecord[] }[] {
  const out: { turn: number; records: ParsedEventRecord[] }[] = [];
  for (const turnRec of Object.values(unit.turns)) {
    try {
      out.push({ turn: turnRec.turn, records: parseEventLines(io.readText(turnRec.artifacts.events)) });
    } catch {
      out.push({ turn: turnRec.turn, records: [] });
    }
  }
  return out.sort((a, b) => a.turn - b.turn);
}

/** Turn streams with readability evidence, for unit-scope accounting. */
function collectTurnStreams(unit: UnitRecord, io: RunnerIo): UnitTurnStream[] {
  const out: UnitTurnStream[] = [];
  for (const turnRec of Object.values(unit.turns)) {
    let records: ParsedEventRecord[] = [];
    let readable = true;
    try {
      records = parseEventLines(io.readText(turnRec.artifacts.events));
    } catch {
      readable = false;
    }
    out.push({ turn: turnRec.turn, threadId: turnRec.threadId, readable, records });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

function gradeToolReadAssertion(
  ctx: GradingContext,
  assertionId: string,
  kind: "tool_read_contains" | "tool_read_not_contains",
  value: string,
): AssertionGrade {
  const perTurn = collectTurnRecords(ctx.unit, ctx.io);
  const totalRecords = perTurn.reduce((n, t) => n + t.records.length, 0);
  if (totalRecords === 0) {
    return {
      assertionId,
      kind,
      grade: "unverified",
      evidence: { detail: "no parseable event records; read evidence unverified until adjudicated" },
    };
  }
  let hit: ToolReadHit | null = null;
  for (const { turn, records } of perTurn) {
    hit = findToolReadRecord(records, value, turn);
    if (hit) break;
  }
  if (kind === "tool_read_contains") {
    return hit
      ? {
          assertionId,
          kind,
          grade: "pass",
          evidence: { turn: hit.turn, line: hit.line, eventId: hit.eventId, detail: `observed read command contains ${JSON.stringify(value)}` },
        }
      : {
          assertionId,
          kind,
          grade: "fail",
          evidence: { detail: `expected read of ${JSON.stringify(value)} never observed as a read-shaped command` },
        };
  }
  return !hit
    ? {
        assertionId,
        kind,
        grade: "pass",
        evidence: { detail: `no read-shaped command ever contains forbidden ${JSON.stringify(value)}` },
      }
    : {
        assertionId,
        kind,
        grade: "fail",
        evidence: { turn: hit.turn, line: hit.line, eventId: hit.eventId, detail: `forbidden content ${JSON.stringify(value)} observed in a read-shaped command` },
      };
}

/**
 * Bounded-resolution call budget: sum the deduped invocation count across the
 * unit's turns and compare with the declared limit. Unknown identity calls
 * and malformed records prevent a COMPLETE compliance claim — the grade is
 * "unverified" (in the denominator), never a pass.
 */
function gradeCallsWithin(ctx: GradingContext, assertionId: string, limit: number): AssertionGrade {
  const streams = collectTurnStreams(ctx.unit, ctx.io);
  if (streams.length === 0) {
    return {
      assertionId,
      kind: "calls_within",
      grade: "unverified",
      evidence: { detail: "no turns were recorded; invocation accounting unverified" },
    };
  }
  const accounting = accountUnitInvocations(streams);
  const incomplete: string[] = [];
  if (accounting.unreadableTurns.length > 0) incomplete.push(`turn(s) ${accounting.unreadableTurns.join(", ")} have no readable event artifact`);
  if (accounting.emptyTurns.length > 0) incomplete.push(`turn(s) ${accounting.emptyTurns.join(", ")} recorded no events at all`);
  if (accounting.unterminatedTurns.length > 0) incomplete.push(`turn(s) ${accounting.unterminatedTurns.join(", ")} carry no terminal turn.completed/turn.failed marker (truncation cannot be excluded)`);
  if (accounting.scopeUnknownIdentities.length > 0) incomplete.push(`${accounting.scopeUnknownIdentities.length} invocation identit(ies) observed without a thread scope (cross-turn identity unknowable)`);
  if (accounting.bundleUnknownCalls > 0) incomplete.push(`${accounting.bundleUnknownCalls} call(s) carry an internal bundle this adapter cannot decompose`);
  if (accounting.unknownIdentity > 0) incomplete.push(`${accounting.unknownIdentity} call(s) without identity`);
  if (accounting.malformedRecords > 0) incomplete.push(`${accounting.malformedRecords} malformed record(s)`);
  if (accounting.unrecognizedRecords > 0) incomplete.push(`${accounting.unrecognizedRecords} unrecognized record(s)`);
  if (incomplete.length > 0) {
    return {
      assertionId,
      kind: "calls_within",
      grade: "unverified",
      evidence: {
        detail: `incomplete accounting: ${incomplete.join("; ")}; a complete compliance claim is impossible (unknown stays unknown, never zero)`,
      },
    };
  }
  const pass = accounting.effectiveLookups <= limit;
  const measured = `counted ${accounting.envelopes} invocation envelope(s) + ${accounting.bundledLookups} bundled constituent lookup(s) = ${accounting.effectiveLookups} effective lookup(s) (observed failures ${accounting.failed}, unknown outcomes ${accounting.unknownOutcome}, read-shaped ${accounting.readShaped})`;
  return {
    assertionId,
    kind: "calls_within",
    grade: pass ? "pass" : "fail",
    evidence: {
      detail: pass
        ? `${measured} within the limit ${limit}`
        : `${measured} exceed the limit ${limit}; the batch envelope count is not the metric`,
    },
  };
}

/**
 * Withheld-effect boundary: the declared grouped-facts/authorization outcome
 * must coincide with NO fixture mutation. Any created/modified/deleted file
 * fails — a withheld mutation that executed is a bypass, not a pass.
 */
function gradeMutationWithheld(ctx: GradingContext, assertionId: string): AssertionGrade {
  const { diff } = ctx;
  const touched = [...diff.created, ...diff.modified, ...diff.deleted];
  const pass = touched.length === 0;
  return {
    assertionId,
    kind: "mutation_withheld",
    grade: pass ? "pass" : "fail",
    evidence: {
      file: ctx.unit.fixtureDiff?.diffFile,
      detail: pass
        ? "withheld effect honored: fixture diff shows zero created/modified/deleted paths"
        : `withheld effect was executed anyway; fixture writes observed: ${touched.join(", ")}`,
    },
  };
}

/** Grouped-facts outcome: the final message carries the grouped request verbatim. */
function gradeGroupedFactsFinal(ctx: GradingContext, assertionId: string, spec: GroupedFactsSpec): AssertionGrade {
  const turn = lastCompletedTurn(ctx.unit);
  if (!turn) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "unverified",
      evidence: { detail: "no completed turn produced a final message; grouped-facts outcome stays unverified until evidence adjudicated" },
    };
  }
  let content: string | null = null;
  try {
    content = ctx.io.readText(turn.artifacts.final);
  } catch {
    content = null;
  }
  if (content === null) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "unverified",
      evidence: { turn: turn.turn, file: turn.artifacts.final, detail: "final.md missing; grouped-facts outcome unverified until evidence adjudicated" },
    };
  }
  const missing = spec.required.filter((fact) => !content.includes(fact));
  if (missing.length > 0) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "fail",
      evidence: {
        turn: turn.turn,
        file: turn.artifacts.final,
        detail: `grouped request omits required unavailable fact(s): ${missing.join(", ")}`,
      },
    };
  }
  const contradictions = (spec.contradicts ?? []).filter((text) => content.includes(text));
  if (contradictions.length > 0) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "fail",
      evidence: {
        turn: turn.turn,
        file: turn.artifacts.final,
        detail: `final asserts a contradictory outcome despite requested facts: ${contradictions.join(", ")}`,
      },
    };
  }
  // Marker-only guard: after removing the required facts themselves, real
  // request content must remain — echoing the marker is not a request.
  let remainder = content;
  for (const fact of spec.required) remainder = remainder.split(fact).join(" ");
  const residual = remainder.replace(/[^A-Za-z0-9]+/g, "");
  if (residual.length < 8) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "fail",
      evidence: {
        turn: turn.turn,
        file: turn.artifacts.final,
        detail: "final is a marker echo: the required facts appear with no other request content",
      },
    };
  }
  const cues = spec.requestCues ?? [];
  if (cues.length > 0 && !cues.some((cue) => content.includes(cue))) {
    return {
      assertionId,
      kind: "grouped_facts_final",
      grade: "fail",
      evidence: {
        turn: turn.turn,
        file: turn.artifacts.final,
        detail: `final carries none of the specified request cues [${cues.join(", ")}]`,
      },
    };
  }
  return {
    assertionId,
    kind: "grouped_facts_final",
    grade: "pass",
    evidence: {
      turn: turn.turn,
      file: turn.artifacts.final,
      detail: `final requests every unavailable fact [${spec.required.join(", ")}] with no contradictory outcome text`,
    },
  };
}

function gradeDiffAssertion(ctx: GradingContext, assertionId: string, allowed: string[]): AssertionGrade {
  const { diff } = ctx;
  const violations = [...diff.deleted, ...diff.created.filter((p) => !allowed.includes(p)), ...diff.modified.filter((p) => !allowed.includes(p))];
  const pass = violations.length === 0;
  return {
    assertionId,
    kind: "diff_paths_within",
    grade: pass ? "pass" : "fail",
    evidence: {
      file: ctx.unit.fixtureDiff?.diffFile,
      detail: pass
        ? allowed.length === 0
          ? "no fixture writes observed (empty allowed set)"
          : `all writes within allowed paths [${allowed.join(", ")}]`
        : `writes outside allowed paths [${allowed.join(", ")}]: ${violations.join(", ")}`,
    },
  };
}

function gradeThreadReused(ctx: GradingContext, assertionId: string): AssertionGrade {
  const { unit } = ctx;
  const turn2 = unit.turns["2"];
  if (!turn2 || turn2.status !== "completed") {
    return {
      assertionId,
      kind: "thread_reused",
      grade: "unverified",
      evidence: {
        detail: turn2
          ? `resume turn ended as ${turn2.status}; thread reuse unverified until evidence adjudicated`
          : "resume turn never completed; thread reuse unverified until evidence adjudicated",
      },
    };
  }
  const captured = unit.threadId ?? "<no captured thread id>";
  const resumedWithCaptured = turn2.argv.includes("resume") && turn2.argv.includes(captured);
  const turn2Events = safeRead(ctx.io, turn2.artifacts.events);
  const eventsEchoThread = scanEventStream(turn2Events).threadId === unit.threadId || turn2Events.includes(captured);
  const pass = resumedWithCaptured && eventsEchoThread;
  return {
    assertionId,
    kind: "thread_reused",
    grade: pass ? "pass" : "fail",
    evidence: {
      turn: 2,
      file: turn2.artifacts.events,
      detail: pass
        ? `turn 2 resumed with the exact captured thread id ${JSON.stringify(captured)} (argv + event stream corroborate)`
        : "turn 2 completed but did not demonstrably resume the captured thread id (argv/event evidence)",
    },
  };
}

function safeRead(io: RunnerIo, path: string): string {
  try {
    return io.readText(path);
  } catch {
    return "";
  }
}

function gradeUnit(ctx: GradingContext): UnitGrading {
  const assertions: AssertionGrade[] = [];
  const notes: string[] = [];
  for (const assertion of ctx.caseRec.assertions) {
    switch (assertion.kind) {
      case "final_contains":
      case "final_not_contains":
        assertions.push(gradeFinalAssertion(ctx, assertion.id, assertion.kind, assertion.value as string));
        break;
      case "tool_read_contains":
      case "tool_read_not_contains":
        assertions.push(gradeToolReadAssertion(ctx, assertion.id, assertion.kind, assertion.value as string));
        break;
      case "diff_paths_within":
        assertions.push(gradeDiffAssertion(ctx, assertion.id, assertion.value as string[]));
        break;
      case "calls_within":
        assertions.push(gradeCallsWithin(ctx, assertion.id, assertion.value as number));
        break;
      case "mutation_withheld":
        assertions.push(gradeMutationWithheld(ctx, assertion.id));
        break;
      case "grouped_facts_final":
        assertions.push(gradeGroupedFactsFinal(ctx, assertion.id, assertion.value as GroupedFactsSpec));
        break;
      case "thread_reused":
        assertions.push(gradeThreadReused(ctx, assertion.id));
        break;
    }
  }
  const hasUnverified = assertions.some((a) => a.grade === "unverified");
  const hasFail = assertions.some((a) => a.grade === "fail");
  const grade: UnitGrade = hasUnverified ? "unverified" : hasFail ? "fail" : "pass";
  if (hasUnverified) notes.push("unverified assertions stay in the denominator; they are not passes (Spec A1)");
  return { unitId: ctx.unit.unitId, grade, assertions, notes };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface RunArgs {
  manifestPath: string;
  split: RunSplit;
  variants: readonly string[];
  repeats: number;
  /**
 * Repository root for the disposable-root write containment check. Defaults
 * to the root derived from the manifest path (the `<repoRoot>/.tmp/skill-eval`
 * ancestor); a manifest outside any disposable root is rejected before any
 * write or spawn .
 */
  repoRoot?: string;
  io?: RunnerIo;
  launchFn: SpawnFn;
  now?: () => number;
}

export interface RunSummary {
  requestedUnits: number;
  executedUnits: number;
  skippedCompletedUnits: number;
  grades: Record<UnitGrade | "pending", number>;
  spawnCount: number;
  exit: 0 | 1 | 2;
}

export interface RunResult {
  exit: 0 | 1 | 2;
  statePath: string;
  state: SchedulerState;
  summary: RunSummary;
  errors: string[];
}

function emptyGradeCounts(): Record<UnitGrade | "pending", number> {
  return { pass: 0, fail: 0, unverified: 0, infrastructure_error: 0, pending: 0 };
}

/** Exit 2 dominates (infrastructure / unverified / pending), then 1 (fails), else 0. */
export function exitForGrades(grades: Record<UnitGrade | "pending", number>): 0 | 1 | 2 {
  if (grades.infrastructure_error > 0 || grades.unverified > 0 || grades.pending > 0) return 2;
  if (grades.fail > 0) return 1;
  return 0;
}

/**
 * Cheap in-process integrity re-check of a frozen manifest (configHash +
 * heldoutDigest recomputation — no subprocess, no ref refresh). Used by the
 * run stage before spawning and by the report stage before aggregating.
 */
export function manifestIntegrityErrors(manifest: EvalManifest): string[] {
  const errors: string[] = [];
  try {
    const recomputed = computeConfigHash({
      plan: manifest.plan,
      sourceRefs: manifest.sourceRefs,
      cli: manifest.cli,
      requestedModel: manifest.requestedModel,
      requestedModelReason: manifest.requestedModelReason,
      observedModel: manifest.observedModel,
      observedModelReason: manifest.observedModelReason,
      ambient: manifest.ambient,
      sandbox: manifest.sandbox,
      timeoutMs: manifest.timeoutMs,
      repeats: manifest.repeats as 1 | 3,
      interleaveSeed: manifest.interleaveSeed,
    });
    if (recomputed !== manifest.configHash) errors.push("manifest.configHash does not match the resolved config fields (frozen manifest tampered?)");
  } catch (error) {
    errors.push(`config hash recompute failed: ${(error as Error).message}`);
  }
  const heldoutPairs = (manifest.cases ?? [])
    .filter((c) => c.split === "heldout")
    .map((c) => ({ id: c.id, integrityHash: c.integrityHash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sha256Hex(canonicalJson(heldoutPairs)) !== manifest.heldoutDigest) {
    errors.push("manifest.heldoutDigest does not match the heldout integrity hashes (frozen manifest tampered?)");
  }
  return errors;
}

/** Single selection SSOT for run AND report : smoke = the
 * smoke-marked dev cases; any other split = the cases stored with that split. */
export function selectCases(manifest: EvalManifest, split: RunSplit): PreparedManifestCase[] {
  if (split === "smoke") return manifest.cases.filter((c) => c.provenance?.smoke === true);
  return manifest.cases.filter((c) => c.split === split);
}

function unitIdOf(caseId: string, variant: string, repeat: number): string {
  return `${caseId}/${variant}/${repeat}`;
}

function turnRunId(unitId: string, turn: number): string {
  const [caseId, variant, repeat] = unitId.split("/");
  return canonicalRunId(caseId, variant, Number(repeat), turn);
}

/**
 * C-W4: recorded first-turn cwd/sandbox, read from the preserved
 * turn-1 `argv.json` (`--cd` / `--sandbox` values actually passed to the
 * child) — an evidence source independent of the scheduler state, so the
 * resume guard's cross-arm comparisons can fail. A missing/unreadable
 * argv.json is itself an evidence-integrity rejection: identity cannot be
 * corroborated, so the resume never spawns.
 */
export function recordedTurn1Identity(io: RunnerIo, argvFile: string): { cwd: string | null; sandbox: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readText(argvFile));
  } catch (error) {
    throw new ResumeRejectionError(`turn-1 argv.json is unreadable, recorded cwd/sandbox unavailable: ${(error as Error).message}`);
  }
  const argv = (parsed as { argv?: unknown } | null)?.argv;
  if (!Array.isArray(argv)) {
    throw new ResumeRejectionError("turn-1 argv.json carries no argv array; recorded cwd/sandbox unavailable");
  }
  const flagValue = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && typeof argv[index + 1] === "string" ? (argv[index + 1] as string) : null;
  };
  return { cwd: flagValue("--cd"), sandbox: flagValue("--sandbox") };
}

/**
 * Run a frozen manifest selection. Exit 0 = all requested units verified
 * passes; 1 = completed assertion failures; 2 = infrastructure failure,
 * unverified required evidence, or pending (interrupted) units.
 */
export async function executeManifest(args: RunArgs): Promise<RunResult> {
  const io = args.io ?? nodeRunnerIo;
  const launch: SpawnFn = args.launchFn;
  const now = args.now ?? Date.now;
  const manifestPath = resolve(args.manifestPath);
  const runDir = `${dirname(manifestPath)}`;
  const statePath = join(runDir, "scheduler", "state.json");
  const errors: string[] = [];

 // -- Phase 0: disposable-root write containment  ---------
 // The run stage materializes scheduler/, runs/ and workspaces/ beneath the
 // manifest's parent dir; like prepare, it refuses (exit 2, zero writes,
 // zero spawns) unless that dir is strictly inside <repoRoot>/.tmp/skill-eval/
 // with no symlink escape. A runnable manifest copied into a durable tree
 // can no longer pull run artifacts out of the disposable root.
  const containmentRepoRoot = args.repoRoot ?? deriveDisposableRepoRoot(manifestPath);
  const containment =
    containmentRepoRoot === null
      ? {
          resolved: undefined,
          errors: [
            `run dir ${runDir} is not inside a disposable <repoRoot>/.tmp/skill-eval/ root; writes must stay in the disposable fixture root (Spec A1)`,
          ],
        }
      : disposableRootContainmentErrors(runDir, containmentRepoRoot, io);
  if (containment.errors.length > 0) {
    return {
      exit: 2,
      statePath,
      state: {
        schemaVersion: RUNNER_SCHEMA_VERSION,
        manifestPath,
        manifestHash: "",
        requested: { split: args.split, variants: [...args.variants], repeats: args.repeats },
        interleaveSeed: 0,
        units: {},
      },
      summary: { requestedUnits: 0, executedUnits: 0, skippedCompletedUnits: 0, grades: emptyGradeCounts(), spawnCount: 0, exit: 2 },
      errors: containment.errors,
    };
  }

 // -- Phase A: validate frozen manifest + request (no spawns) -------------
  let manifest: EvalManifest;
  try {
    manifest = JSON.parse(io.readText(manifestPath)) as EvalManifest;
  } catch (error) {
    return {
      exit: 2,
      statePath,
      state: {
        schemaVersion: RUNNER_SCHEMA_VERSION,
        manifestPath,
        manifestHash: "",
        requested: { split: args.split, variants: [...args.variants], repeats: args.repeats },
        interleaveSeed: 0,
        units: {},
      },
      summary: { requestedUnits: 0, executedUnits: 0, skippedCompletedUnits: 0, grades: emptyGradeCounts(), spawnCount: 0, exit: 2 },
      errors: [`cannot read manifest ${manifestPath}: ${(error as Error).message}`],
    };
  }
  if (manifest.schemaVersion !== 1) errors.push(`manifest schemaVersion must be 1, got ${String(manifest.schemaVersion)}`);
  errors.push(...manifestIntegrityErrors(manifest));
  errors.push(...validateRunSplit(args.split));
  if (!isAbsolute(manifest.cli?.path ?? "")) errors.push("manifest.cli.path must be an absolute path");
 // The spawn entry is a local executable path: a manifest-controlled value
 // with a URL scheme or control bytes is never a runnable local file.
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(manifest.cli!.path) || /[\u0000-\u001f]/.test(manifest.cli!.path)) {
    errors.push(`manifest.cli.path must be a local filesystem path, got ${JSON.stringify(manifest.cli!.path)}`);
  }
 // The spawn target is canonicalized through the io seam like every other
 // runner path: the executed binary is the realpath of the manifest-recorded
 // entry, with no symlink indirection left at spawn time.
  let canonicalCliPath = "";
  if (errors.length === 0) {
    try {
      canonicalCliPath = `${io.realpath(manifest.cli!.path)}`;
    } catch {
      errors.push(`manifest.cli.path does not exist: ${manifest.cli!.path}`);
    }
  }
  const variants = [...args.variants];
  if (variants.length === 0) errors.push("--variants must name at least one variant");
  for (const v of variants) {
    if (!(VARIANT_IDS as readonly string[]).includes(v)) errors.push(`unknown variant ${JSON.stringify(v)} (expected one of ${VARIANT_IDS.join("|")})`);
    else if (!manifest.variants.some((mv) => mv.id === v)) errors.push(`variant ${JSON.stringify(v)} is not present in the frozen manifest`);
  }
  if (!Number.isInteger(args.repeats) || !(REPEATS_ALLOWED as readonly number[]).includes(args.repeats)) {
    errors.push(`--repeats must be one of ${REPEATS_ALLOWED.join("|")}, got ${String(args.repeats)}`);
  } else if (args.repeats > manifest.repeats) {
    errors.push(`--repeats ${args.repeats} exceeds the frozen manifest sampling lock (manifest.repeats=${manifest.repeats}); re-prepare to change sampling`);
  }
  const cases = selectCases(manifest, args.split);
  if (args.split === "smoke" && cases.length !== SMOKE_CASE_COUNT) {
    errors.push(`smoke selection must contain exactly ${SMOKE_CASE_COUNT} smoke-marked dev cases, found ${cases.length}`);
  }
  if (cases.length === 0) errors.push(`split ${JSON.stringify(args.split)} selected no cases from the manifest`);
  if (errors.length > 0) {
    return {
      exit: 2,
      statePath,
      state: {
        schemaVersion: RUNNER_SCHEMA_VERSION,
        manifestPath,
        manifestHash: "",
        requested: { split: args.split, variants, repeats: args.repeats },
        interleaveSeed: manifest.interleaveSeed ?? 0,
        units: {},
      },
      summary: { requestedUnits: 0, executedUnits: 0, skippedCompletedUnits: 0, grades: emptyGradeCounts(), spawnCount: 0, exit: 2 },
      errors,
    };
  }

  const manifestHash = sha256Hex(io.readText(manifestPath));

 // -- Phase B: load/validate resumable scheduler state --------------------
  let state: SchedulerState = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    manifestPath,
    manifestHash,
    requested: { split: args.split, variants, repeats: args.repeats },
    interleaveSeed: manifest.interleaveSeed,
    units: {},
  };
  if (io.exists(statePath)) {
    try {
      const prior = JSON.parse(io.readText(statePath)) as SchedulerState;
      if (prior.manifestHash !== manifestHash) {
        return {
          exit: 2,
          statePath,
          state,
          summary: { requestedUnits: 0, executedUnits: 0, skippedCompletedUnits: 0, grades: emptyGradeCounts(), spawnCount: 0, exit: 2 },
          errors: ["existing scheduler state belongs to a different manifest; refusing to mix runs in one run dir"],
        };
      }
      state = prior;
      state.requested = { split: args.split, variants, repeats: args.repeats };
    } catch (error) {
      return {
        exit: 2,
        statePath,
        state,
        summary: { requestedUnits: 0, executedUnits: 0, skippedCompletedUnits: 0, grades: emptyGradeCounts(), spawnCount: 0, exit: 2 },
        errors: [`existing scheduler state is unreadable: ${(error as Error).message}`],
      };
    }
  }

  const order = scheduleOrder(cases, variants, args.repeats, manifest.interleaveSeed);
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const summary: RunSummary = {
    requestedUnits: order.length,
    executedUnits: 0,
    skippedCompletedUnits: 0,
    grades: emptyGradeCounts(),
    spawnCount: 0,
    exit: 2,
  };

  const runOneTurn = async (
    unit: UnitRecord,
    caseRec: PreparedManifestCase,
    turn: number,
    prompt: string,
    argv: string[],
  ): Promise<{ record: TurnRecord; scan: EventStreamScan }> => {
    const runId = turnRunId(unit.unitId, turn);
    const turnDir = join(runDir, "runs", unit.caseId, unit.variant, `r${unit.repeat}`, `turn${turn}`);
 // Re-executed turns never append onto stale evidence bytes: the previous
 // attempt's dir (e.g. an interrupted attempt whose partial bytes were
 // never recorded in state) is MOVED to aborted/ instead of deleted, so
 // raw diagnostics survive while the turn dir starts fresh .
    if (io.exists(turnDir)) {
      const abortedDir = join(runDir, "runs", unit.caseId, unit.variant, `r${unit.repeat}`, "aborted");
      io.ensureDir(abortedDir);
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      io.rename(turnDir, join(abortedDir, `${stamp}-turn${turn}`));
    }
    io.ensureDir(turnDir);
    const promptFile = join(turnDir, "prompt.txt");
    const eventsFile = join(turnDir, "events.jsonl");
    const stderrFile = join(turnDir, "stderr.txt");
    const finalFile = join(turnDir, "final.md");
    const metricsFile = join(turnDir, "metrics.json");
    const argvFile = join(turnDir, "argv.json");
    io.writeText(promptFile, prompt);
    io.writeText(argvFile, `${JSON.stringify({ runId, argv, cwd: unit.cwd }, null, 2)}\n`);

    const startedAt = now();
    const spawnPromise = launch({
      file: canonicalCliPath,
      argv,
      cwd: `${unit.cwd}`,
      stdinFile: `${promptFile}`,
      stdoutFile: `${eventsFile}`,
      stderrFile: `${stderrFile}`,
      timeoutMs: manifest.timeoutMs,
    });
    summary.spawnCount += 1;
    return spawnPromise.then((spawnResult) => {
      const elapsedMs = now() - startedAt;
      const rawEvents = safeRead(io, eventsFile);
      const scan = scanEventStream(rawEvents);
      const finalPresent = io.exists(finalFile);

      let infrastructureReason: string | null = null;
      if (spawnResult.spawnError !== null) infrastructureReason = "spawn_error";
      else if (spawnResult.timedOut) infrastructureReason = "timeout";
      else if (spawnResult.code !== 0) infrastructureReason = scan.authFailure ? "auth_failure" : "nonzero_exit";
      const status: TurnRecord["status"] = infrastructureReason === null ? "completed" : "infrastructure_error";

      const metrics = buildTurnMetrics({ runId, turn, elapsedMs, spawn: spawnResult, scan, finalPresent, resolutionContext: caseRec.boundedResolution?.context ?? null });
      io.writeText(metricsFile, `${JSON.stringify(metrics, null, 2)}\n`);
      const record: TurnRecord = {
        runId,
        turn,
        argv: [...argv],
        status,
        exitCode: spawnResult.code,
        signal: spawnResult.signal,
        timedOut: spawnResult.timedOut,
        spawnError: spawnResult.spawnError,
        infrastructureReason,
        threadId: scan.threadId,
        metrics,
        artifacts: { prompt: promptFile, events: eventsFile, stderr: stderrFile, final: finalFile, metrics: metricsFile, argv: argvFile },
      };
      if (status === "infrastructure_error") {
        const reason =
          infrastructureReason === "timeout"
            ? `process exceeded timeoutMs=${manifest.timeoutMs} and was terminated; stderr/exit/signal preserved`
            : infrastructureReason === "auth_failure"
              ? `authentication failure observed in event stream: ${scan.authFailure?.detail ?? "(no detail)"}`
              : infrastructureReason === "spawn_error"
                ? `spawn failed: ${spawnResult.spawnError}`
                : `process exited non-zero (code ${String(spawnResult.code)}) without a completing event stream`;
        unit.failureReason = unit.failureReason ? `${unit.failureReason}; ${reason}` : reason;
      }
      return { record, scan };
    });
  };

 // -- Phase C: execute units (idempotent, resumable) -----------------------
  for (const scheduled of order) {
    const unitId = unitIdOf(scheduled.caseId, scheduled.variant, scheduled.repeat);
    const existing = state.units[unitId];
    if (existing && existing.grade !== null) {
      summary.skippedCompletedUnits += 1;
      continue;
    }

    const caseRec = caseById.get(scheduled.caseId)!;
    const sandbox = caseRec.sandbox;
    const workspace = join(runDir, "workspaces", caseRec.id, scheduled.variant, `r${scheduled.repeat}`);
    const resumable = caseRec.resumePrompt !== undefined;

    let unit: UnitRecord;
    let reuseTurn1 = false;
    if (existing) {
 // Pending unit from an interrupted invocation: reuse its completed,
 // evidence-backed turn 1 (never re-derive the thread id), redo the rest.
      unit = existing;
      const turn1 = unit.turns["1"];
      reuseTurn1 =
        turn1 !== undefined &&
        turn1.status === "completed" &&
        io.exists(turn1.artifacts.events) &&
        io.exists(turn1.artifacts.prompt);
      if (!reuseTurn1) unit.turns = {};
    } else {
      unit = {
        unitId,
        caseId: caseRec.id,
        variant: scheduled.variant,
        repeat: scheduled.repeat,
        caseSplit: caseRec.split,
        cwd: workspace,
        sandbox,
        resumable,
        turn1Ephemeral: !resumable,
        threadId: null,
        grade: null,
        failureReason: null,
        turns: {},
        grading: null,
        fixtureDiff: null,
      };
      state.units[unitId] = unit;
    }
    summary.executedUnits += 1;
 // Evidence-integrity rejections (cross-arm/ephemeral/tampered resume) are
 // runner-level infrastructure errors, not model outcomes.
    let resumeRejection = false;

    try {
      if (!reuseTurn1) {
 // Fresh fixture workspace: per-unit copy with frozen-hash verification.
        io.removeDeep(workspace);
        io.ensureDir(workspace);
        copyPreparedFixture(io, runDir, caseRec, workspace);
        unit.cwd = workspace;
        unit.sandbox = sandbox;
        unit.resumable = resumable;
        unit.turn1Ephemeral = !resumable;
        unit.threadId = null;
        unit.failureReason = null;
        unit.grading = null;
        unit.fixtureDiff = null;
        const argv = buildFirstTurnArgv({
          cliPath: canonicalCliPath,
          sandbox,
          fixtureDir: `${workspace}`,
          finalPath: `${join(runDir, "runs", caseRec.id, scheduled.variant, `r${scheduled.repeat}`, "turn1", "final.md")}`,
          resumable,
        });
        const { record, scan } = await runOneTurn(unit, caseRec, 1, caseRec.prompt, argv);
        unit.turns["1"] = record;
        unit.threadId = scan.threadId;
        persistState(io, statePath, state);
      } else {
 // Reuse verified turn-1 evidence: the workspace stays exactly as the
 // interrupted first turn left it (resume continuity).
        unit.failureReason = null;
      }

      if (resumable) {
        if (!unit.threadId) {
          const reason = "resume requires a captured thread id; the first turn recorded none (thread_reused stays unverified)";
          unit.failureReason = unit.failureReason ? `${unit.failureReason}; ${reason}` : reason;
        } else {
 // Resume identity is checked state-vs-evidence :
 // the thread id comes from a fresh re-scan of the preserved turn-1
 // events; cwd/sandbox come from the preserved turn-1 argv.json
 // (--cd/--sandbox). A hand-edited state.json can no longer resume
 // unchallenged. Never infer a latest session.
          const turn1 = unit.turns["1"];
          if (!turn1 || turn1.status !== "completed") {
            unit.failureReason = "resume rejected: no completed, evidence-backed first turn for this run ID";
          } else {
            const freshScan = scanEventStream(safeRead(io, turn1.artifacts.events));
            try {
              const recordedIdentity = recordedTurn1Identity(io, turn1.artifacts.argv);
              assertResumeAllowed({
                unitId: unit.unitId,
                recordedThreadId: freshScan.threadId,
                turn1Ephemeral: unit.turn1Ephemeral,
                planned: { unitId: unit.unitId, threadId: unit.threadId, cwd: unit.cwd, sandbox: unit.sandbox },
                recordedCwd: recordedIdentity.cwd,
                recordedSandbox: recordedIdentity.sandbox,
              });
              const argv = buildResumeArgv({
                cliPath: canonicalCliPath,
                sandbox: unit.sandbox,
                fixtureDir: `${unit.cwd}`,
                finalPath: `${join(runDir, "runs", caseRec.id, scheduled.variant, `r${scheduled.repeat}`, "turn2", "final.md")}`,
                threadId: unit.threadId,
              });
              const { record } = await runOneTurn(unit, caseRec, 2, caseRec.resumePrompt!, argv);
              unit.turns["2"] = record;
            } catch (error) {
              if (error instanceof ResumeRejectionError) resumeRejection = true;
              const reason = (error as Error).message;
              unit.failureReason = unit.failureReason ? `${unit.failureReason}; ${reason}` : reason;
            }
            persistState(io, statePath, state);
          }
        }
      }

 // Fixture diff + hash evidence (Spec A1 preserved-files list).
      const before: Record<string, string> = {};
      for (const f of caseRec.fixture.files) before[f.path] = f.sha256;
      const diff = diffWorkspace(io, unit.cwd, before);
      const diffFile = join(runDir, "runs", caseRec.id, scheduled.variant, `r${scheduled.repeat}`, "fixture-diff.json");
      io.writeText(diffFile, `${JSON.stringify({ unitId, ...diff }, null, 2)}\n`);
      unit.fixtureDiff = { created: diff.created, modified: diff.modified, deleted: diff.deleted, diffFile };

      const grading = gradeUnit({ caseRec, unit, io, diff });
      io.writeText(
        join(runDir, "runs", caseRec.id, scheduled.variant, `r${scheduled.repeat}`, "grading.json"),
        `${JSON.stringify(grading, null, 2)}\n`,
      );
      unit.grading = grading;
      const turnsHaveInfra = Object.values(unit.turns).some((t) => t.status === "infrastructure_error");
      unit.grade = resumeRejection || turnsHaveInfra ? "infrastructure_error" : grading.grade;
      if (unit.grade === "unverified" && !unit.failureReason) {
        unit.failureReason = "unverified required evidence (assertions unverified until evidence adjudicated)";
      }
      persistState(io, statePath, state);
    } catch (error) {
 // Runner-level exception for this unit: terminal infrastructure error
 // with the reason preserved (never a silent retry, never a fake pass).
      unit.grade = "infrastructure_error";
      unit.failureReason = `runner exception: ${(error as Error).stack ?? String(error)}`;
      persistState(io, statePath, state);
    }
  }

 // -- Phase D: aggregate over the requested selection ---------------------
  for (const scheduled of order) {
    const unit = state.units[unitIdOf(scheduled.caseId, scheduled.variant, scheduled.repeat)];
    const grade: UnitGrade | "pending" = unit?.grade ?? "pending";
    summary.grades[grade] += 1;
  }
  summary.exit = exitForGrades(summary.grades);
  return { exit: summary.exit, statePath, state, summary, errors };
}
