import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, relative, isAbsolute, basename } from "node:path";
import { assessSddEvidenceReuse, checkSddAction, evidenceInputDigest, resolveSddExecutionContext, SddScriptError, validateSddEvidenceRecord, verifySddEvidence, type EvidenceArtifactFact, type EvidenceAssessment, type EvidenceCaptureRequest, type EvidenceEnvironmentKey, type EvidenceInputSnapshot, type EvidenceLimits, type SddExecutionContext, type SddEvidenceRecord } from "@mstar-harness/engine";
import { startDashboard, type CommandEffects } from "@mstar-harness/commands";

type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  stdinMode?: "inherit" | "ignore";
  signal: AbortSignal;
};
type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  stderrBytes: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError: string | null;
};
type InputState = { stdin: string | undefined; consumed: boolean; cwd: string; signal: AbortSignal };
type VerifyRequest = { sddDir: string; planId: string; taskId: string; runId: string; targetPath?: string };
export type McpEffects = Omit<CommandEffects, "captureSddEvidence" | "verifySddEvidence"> & {
  /**
   * Scope one request's transport-supplied stdin content for the duration of
   * `operation`. The value is the primitive string admission extracted for a
   * command that declares the `stdin` effect; no parsed handler value passes
   * through here.
   */
  withInput<T>(stdin: string | undefined, request: { cwd: string; signal: AbortSignal }, operation: () => Promise<T>): Promise<T>;
  captureSddEvidence(requestPath: string, argv: readonly string[]): Promise<{ runDir: string; record: SddEvidenceRecord; exitCode: number }>;
  verifySddEvidence(request: VerifyRequest): Promise<EvidenceAssessment>;
};

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_CAPTURE_REQUEST_BYTES = 1024 * 1024;
const RECORD_SCHEMA = "mstar.sdd-evidence/v1";
const FIXED_LIMITS: EvidenceLimits = {
  timeoutMs: 600000,
  maxLogBytesPerStream: 8 * 1024 * 1024,
  maxInputBytes: 512 * 1024 * 1024,
  maxInputEntries: 10000,
  maxInputMs: 30000,
  maxSnapshotBytes: 2 * 1024 * 1024,
};
const MAX_CAPTURE_LOG_BYTES = FIXED_LIMITS.maxLogBytesPerStream;

export function createMcpEffects(services: Array<{ close(): Promise<void> }>): McpEffects {
  const inputs = new AsyncLocalStorage<InputState>();
  return {
    withInput<T>(stdin: string | undefined, request: { cwd: string; signal: AbortSignal }, operation: () => Promise<T>) {
      return inputs.run({ stdin, consumed: false, ...request }, operation);
    },
    async readInput() {
      const state = inputs.getStore();
      if (state === undefined) throw new Error("MCP stdin effect is outside a request");
      if (state.consumed) throw new Error("MCP input payload can only be consumed once");
      state.consumed = true;
      if (state.stdin === undefined) {
        throw Object.assign(new Error("MCP stdin effect requires an explicit input string"), { code: "command.invalid-input" });
      }
      if (Buffer.byteLength(state.stdin) > MAX_STREAM_BYTES) {
        throw Object.assign(new Error(`MCP stdin payload exceeds ${MAX_STREAM_BYTES} bytes`), { code: "command.invalid-input" });
      }
      return state.stdin;
    },
    async spawn(request: ProcessRequest) {
      const result = await spawnBounded({ ...request, stdinMode: "ignore" });
      if (result.stdoutTruncated || result.stderrTruncated) {
        throw Object.assign(new Error(`child output exceeded ${MAX_STREAM_BYTES} bytes`), { code: "command.effect-unavailable" });
      }
      return { exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    },
    async startDashboard(request) {
      const running = await startDashboard(request);
      const handle = { url: running.url, async close() { await running.close(); } };
      services.push(handle);
      return handle;
    },
    async openBrowser(url) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      await new Promise<void>((resolve, reject) => {
        const child = nodeSpawn(opener, args, { shell: false, stdio: "ignore" });
        child.once("spawn", resolve);
        child.once("error", (error: NodeJS.ErrnoException) => reject(Object.assign(
          new Error(`no platform opener (${opener}) available: ${error.message}`),
          { code: "capability.browser.unavailable" },
        )));
      });
    },
    async captureSddEvidence(requestPath, argv) {
      const request = inputs.getStore();
      if (request === undefined) throw new Error("MCP evidence capture is outside a request");
      return captureEvidence(requestPath, argv, request);
    },
    async verifySddEvidence(request) {
      return verifyEvidence(request);
    },
  };
}
function captureSnapshot(request: EvidenceCaptureRequest, argv: readonly string[]): EvidenceInputSnapshot {
  const environment: EvidenceInputSnapshot["environment"] = {};
  const environmentKeys = Array.isArray(request.environmentKeys)
    ? request.environmentKeys.filter((key): key is EvidenceEnvironmentKey => ["CI", "NODE_ENV", "TZ", "LANG"].includes(key))
    : [];
  for (const key of environmentKeys) environment[key] = process.env[key] ?? null;
  const snapshot: EvidenceInputSnapshot = {
    repoCommonDir: null,
    head: null,
    branch: null,
    dirty: null,
    dirtyStatusSha256: null,
    entries: [],
    tool: {
      requested: argv[0] ?? "<missing>",
      resolvedPath: null,
      sha256: null,
      bytes: null,
      platform: process.platform,
      arch: process.arch,
      runnerRuntimeVersion: process.version,
      error: "MCP capture does not fingerprint runner executables",
    },
    environment,
    unknowns: ["MCP capture does not collect repository or declared-input snapshots"],
    stable: false,
    digest: "",
  };
  snapshot.digest = evidenceInputDigest(snapshot);
  return snapshot;
}

function captureRecord(request: EvidenceCaptureRequest, argv: readonly string[], runId: string, startedAt: string): SddEvidenceRecord {
  const before = captureSnapshot(request, argv);
  return {
    schema: RECORD_SCHEMA,
    producer: { name: "mstar-harness", version: "3.11.2" },
    runId,
    request,
    command: { argv: [...argv], cwd: request.context.featureCwd },
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
    limits: { ...FIXED_LIMITS, timeoutMs: request.timeoutMs ?? FIXED_LIMITS.timeoutMs },
    captureErrors: [],
    counts: null,
  };
}

function readEvidenceRequest(requestPath: string): unknown {
  if (!isAbsolute(requestPath)) throw new SddScriptError("evidence request must be an absolute path", 2);
  const stat = lstatSync(requestPath);
  if (!stat.isFile()) throw new SddScriptError("evidence request must be a regular file", 2);
  if (stat.size > MAX_CAPTURE_REQUEST_BYTES) throw new SddScriptError(`evidence request exceeds ${MAX_CAPTURE_REQUEST_BYTES} bytes`, 2);
  return JSON.parse(readFileSync(requestPath, "utf8")) as unknown;
}

function writeRecordAtomic(sddDir: string, runDir: string, record: SddEvidenceRecord): void {
  const recordPath = join(runDir, "record.json");
  const tempPath = join(runDir, `.record-${randomUUID()}.tmp`);
  const rel = relative(sddDir, recordPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("evidence record path escaped the SDD directory");
  for (const path of [sddDir, dirname(runDir), runDir]) {
    if (!lstatSync(path).isDirectory()) throw new Error(`evidence path is not a real directory: ${path}`);
  }
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    for (const path of [sddDir, dirname(runDir), runDir]) {
      if (!lstatSync(path).isDirectory()) throw new Error(`evidence path changed before record commit: ${path}`);
    }
    try {
      if (!lstatSync(recordPath).isFile()) throw new Error(`evidence record is not a regular file: ${recordPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(tempPath, recordPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function writeExclusiveFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function replaceFileAtomically(path: string, bytes: Buffer): void {
  const parent = dirname(path);
  if (!lstatSync(parent).isDirectory()) throw new Error(`artifact parent is not a real directory: ${parent}`);
  const temporary = join(parent, `.${basename(path)}-${randomUUID()}.tmp`);
  writeExclusiveFile(temporary, bytes);
  try {
    if (!lstatSync(parent).isDirectory()) throw new Error(`artifact parent changed before commit: ${parent}`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function gateFailure(label: string, gate: ReturnType<typeof checkSddAction>): never {
  const details = gate.violations.map(({ code, message }) => `${code}: ${message}`).join("; ");
  throw Object.assign(new SddScriptError(`${label} refused: ${details}`, 1), {
    code: gate.violations[0]?.code ?? "sdd.context.refused",
  });
}

async function captureEvidence(requestPath: string, argv: readonly string[], invocation: InputState) {
  if (argv.length === 0 || argv.length > 256 || typeof argv[0] !== "string" || argv[0].trim() === "") {
    throw new SddScriptError("evidence capture argv must include a nonempty child executable", 2);
  }
  let supplied: unknown;
  try {
    supplied = readEvidenceRequest(requestPath);
  } catch (error) {
    if (error instanceof SddScriptError) throw error;
    throw new SddScriptError(`evidence request unreadable: ${(error as Error).message}`, 2);
  }
  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new SddScriptError("evidence capture request must be a JSON object", 2);
  }
  const candidate = supplied as Record<string, unknown>;
  const contextValue = candidate.context;
  if (contextValue === null || typeof contextValue !== "object" || Array.isArray(contextValue)) {
    throw new SddScriptError("evidence capture request.context must be a JSON object", 2);
  }
  const rawContext = contextValue as SddExecutionContext;
  const rawRequest = { ...candidate, context: rawContext } as unknown as EvidenceCaptureRequest;
  const provisional = captureRecord(rawRequest, argv, randomUUID(), new Date().toISOString());
  const requestGate = validateSddEvidenceRecord(provisional);
  if (!requestGate.ok) throw new SddScriptError(`invalid evidence request: ${requestGate.violations.map(({ code, message }) => `${code}: ${message}`).join("; ")}`, 2);

  const context = await resolveSddExecutionContext(rawContext);
  const request: EvidenceCaptureRequest = { ...rawRequest, context };
  const runId = provisional.runId;
  const startedAt = provisional.startedAt;
  const record = captureRecord(request, argv, runId, startedAt);
  const recordGate = validateSddEvidenceRecord(record);
  if (!recordGate.ok) throw new SddScriptError(`invalid evidence record request: ${recordGate.violations.map(({ code, message }) => `${code}: ${message}`).join("; ")}`, 2);

  const sourceGate = checkSddAction(context, { kind: "source", cwd: invocation.cwd });
  if (!sourceGate.ok) gateFailure("sdd evidence capture", sourceGate);
  const launchGate = checkSddAction(context, { kind: "launch", cwd: invocation.cwd });
  if (!launchGate.ok) gateFailure("sdd evidence capture", launchGate);
  const evidenceDir = join(context.sddDir, "evidence");
  const artifactGate = checkSddAction(context, { kind: "artifact", cwd: invocation.cwd, target: evidenceDir });
  if (!artifactGate.ok) gateFailure("sdd evidence capture", artifactGate);

  let evidenceStat: ReturnType<typeof lstatSync> | undefined;
  try {
    evidenceStat = lstatSync(evidenceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (evidenceStat && !evidenceStat.isDirectory()) throw Object.assign(new Error(`evidence parent is not a real directory: ${evidenceDir}`), { code: "sdd.evidence.artifact-path" });
  if (!evidenceStat) mkdirSync(evidenceDir, { mode: 0o700 });
  const runDir = join(evidenceDir, runId);
  mkdirSync(runDir, { mode: 0o700 });
  let recordWritten = false;
  try {
    const stdoutPath = join(runDir, "stdout.log");
    const stderrPath = join(runDir, "stderr.log");
    writeExclusiveFile(stdoutPath, Buffer.alloc(0));
    writeExclusiveFile(stderrPath, Buffer.alloc(0));
    writeRecordAtomic(context.sddDir, runDir, record);
    recordWritten = true;

    const timeout = new AbortController();
    const timeoutMs = request.timeoutMs ?? FIXED_LIMITS.timeoutMs;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const abortFromRequest = () => timeout.abort(invocation.signal.reason);
    invocation.signal.addEventListener("abort", abortFromRequest, { once: true });
    if (invocation.signal.aborted) abortFromRequest();
    let timedOut = false;
    timeout.signal.addEventListener("abort", () => { timedOut = !invocation.signal.aborted; }, { once: true });
    let result: ProcessResult;
    try {
      result = await spawnBounded({
        argv,
        cwd: context.featureCwd,
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        signal: timeout.signal,
      }, true, MAX_CAPTURE_LOG_BYTES);
    } finally {
      clearTimeout(timer);
      invocation.signal.removeEventListener("abort", abortFromRequest);
    }
    replaceFileAtomically(stdoutPath, result.stdoutBytes);
    replaceFileAtomically(stderrPath, result.stderrBytes);
    record.logs.stdout = { path: "stdout.log", bytes: result.stdoutBytes.byteLength, sha256: hash(result.stdoutBytes), truncated: result.stdoutTruncated };
    record.logs.stderr = { path: "stderr.log", bytes: result.stderrBytes.byteLength, sha256: hash(result.stderrBytes), truncated: result.stderrTruncated };
    record.after = captureSnapshot(request, argv);
    record.endedAt = new Date().toISOString();
    record.state = "finished";
    if (timedOut) {
      record.outcome = { kind: "timeout" };
      result.exitCode = 124;
    } else if (result.spawnError !== null) {
      record.outcome = { kind: "spawn-error", code: result.spawnError };
    } else if (result.signal !== null) {
      record.outcome = { kind: "signal", signal: result.signal };
    } else {
      record.outcome = { kind: "exit", code: result.exitCode ?? 1 };
    }
    const finalized = validateSddEvidenceRecord(record);
    if (!finalized.ok) throw new Error(`MCP capture produced an invalid record: ${finalized.violations.map(({ code, message }) => `${code}: ${message}`).join("; ")}`);
    writeRecordAtomic(context.sddDir, runDir, record);
    return { exitCode: result.exitCode ?? 1, runDir, record };
  } catch (error) {
    if (!recordWritten) rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}

function artifactFact(path: string): EvidenceArtifactFact {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { path: basename(path) as EvidenceArtifactFact["path"], state: "symlink", bytes: null, sha256: null };
    if (!stat.isFile()) return { path: basename(path) as EvidenceArtifactFact["path"], state: "other", bytes: null, sha256: null };
    if (stat.size > MAX_CAPTURE_LOG_BYTES) return { path: basename(path) as EvidenceArtifactFact["path"], state: "regular", bytes: stat.size, sha256: null };
    const bytes = readFileSync(path);
    return { path: basename(path) as EvidenceArtifactFact["path"], state: "regular", bytes: bytes.byteLength, sha256: hash(bytes) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { path: basename(path) as EvidenceArtifactFact["path"], state: "missing", bytes: null, sha256: null }
      : { path: basename(path) as EvidenceArtifactFact["path"], state: "unreadable", bytes: null, sha256: null };
  }
}

function readTargetRequest(pathValue: string): { cwd: string; expectedHead: string; rationale: string } {
  if (!isAbsolute(pathValue)) throw new SddScriptError("evidence target request must be an absolute path", 2);
  const stat = lstatSync(pathValue);
  if (!stat.isFile()) throw new SddScriptError("evidence target request must be a regular file", 2);
  if (stat.size > MAX_CAPTURE_REQUEST_BYTES) throw new SddScriptError(`evidence target request exceeds ${MAX_CAPTURE_REQUEST_BYTES} bytes`, 2);
  const document: unknown = JSON.parse(readFileSync(pathValue, "utf8"));
  if (document === null || typeof document !== "object" || Array.isArray(document)) throw new SddScriptError("evidence target request must be a JSON object", 2);
  const target = document as Record<string, unknown>;
  if (typeof target.cwd !== "string" || !isAbsolute(target.cwd) || !lstatSync(target.cwd).isDirectory()) {
    throw new SddScriptError("evidence target cwd must be an absolute existing directory", 2);
  }
  if (typeof target.expectedHead !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target.expectedHead)) {
    throw new SddScriptError("evidence target expectedHead must be a lowercase 40/64-hex Git OID", 2);
  }
  if (typeof target.rationale !== "string" || target.rationale.length === 0 || target.rationale.length > 4096) {
    throw new SddScriptError("evidence target rationale must be a nonempty string no longer than 4096 characters", 2);
  }
  return { cwd: target.cwd, expectedHead: target.expectedHead, rationale: target.rationale };
}
function verifyEvidence(request: VerifyRequest): EvidenceAssessment {
  const expected = { planId: request.planId, taskId: request.taskId, runId: request.runId };
  let record: unknown = null;
  let facts: EvidenceArtifactFact[] = [];
  if (isAbsolute(request.sddDir) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.runId)) {
    try {
      const sddDir = realpathSync(request.sddDir);
      if (basename(sddDir) === request.planId && basename(dirname(sddDir)) === "sdd") {
        const runDir = join(sddDir, "evidence", request.runId);
        const evidenceDir = join(sddDir, "evidence");
        const recordPath = join(runDir, "record.json");
        if (!lstatSync(evidenceDir).isDirectory() || !lstatSync(runDir).isDirectory()) throw new Error("evidence run path is not a real directory");
        const stat = lstatSync(recordPath);
        if (stat.isFile() && stat.size <= MAX_CAPTURE_REQUEST_BYTES) record = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
        facts = [artifactFact(join(runDir, "stdout.log")), artifactFact(join(runDir, "stderr.log"))];
      }
    } catch {
      // Missing/unreadable evidence remains an integrity failure below.
    }
  }
  if (request.targetPath !== undefined) {
    const targetRequest = readTargetRequest(request.targetPath);
    if (record !== null && validateSddEvidenceRecord(record).ok) {
      const valid = record as SddEvidenceRecord;
      const target = captureSnapshot(valid.request, valid.command.argv);
      target.unknowns.push(`MCP verify cannot collect declared target-input snapshots for ${targetRequest.cwd} at expected head ${targetRequest.expectedHead}`);
      target.digest = evidenceInputDigest(target);
      return assessSddEvidenceReuse(record, facts, expected, target);
    }
  }
  const integrity = verifySddEvidence(record, facts, expected);
  const validRecord = record !== null && typeof record === "object" ? record as SddEvidenceRecord : null;
  const outcome = !integrity.ok || validRecord === null ? "unknown"
    : validRecord.state === "running" ? "incomplete"
      : validRecord.outcome.kind === "exit" && validRecord.outcome.code === 0 ? "passed"
        : validRecord.outcome.kind === "exit" || validRecord.outcome.kind === "spawn-error" ? "failed" : "incomplete";
  return {
    integrity,
    outcome,
    applicability: integrity.ok ? "not-assessed" : "uncertain",
    coverage: "review-required",
    changedInputs: [],
    reasons: integrity.ok ? ["target.absent"] : ["evidence.integrity"],
  };
}
function spawnBounded(request: ProcessRequest, allowTruncation = false, maxStreamBytes = MAX_STREAM_BYTES): Promise<ProcessResult> {
  if (request.signal.aborted) return Promise.reject(Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" }));
  if (request.argv.length === 0) return Promise.reject(new TypeError("process argv must include an executable"));
  if (request.stdin !== undefined && Buffer.byteLength(request.stdin) > MAX_STREAM_BYTES) {
    return Promise.reject(Object.assign(new Error(`child stdin exceeds ${MAX_STREAM_BYTES} bytes`), { code: "command.invalid-input" }));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(request.argv[0]!, request.argv.slice(1), {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: [request.stdin !== undefined ? "pipe" : request.stdinMode === "inherit" ? "inherit" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutTotal = 0;
    let stderrTotal = 0;
    let overflow = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    const abort = () => {
      if (child.pid === undefined) child.once("spawn", terminate);
      else terminate();
    };
    const cleanup = () => {
      request.signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer, which: "stdout" | "stderr") => {
      const next = (which === "stdout" ? stdoutTotal : stderrTotal) + chunk.byteLength;
      if (which === "stdout") stdoutTotal = next;
      else stderrTotal = next;
      const accepted = Math.min(chunk.byteLength, Math.max(0, maxStreamBytes - (next - chunk.byteLength)));
      if (accepted > 0) target.push(chunk.subarray(0, accepted));
      if (next > maxStreamBytes && !overflow) {
        overflow = true;
        terminate();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (allowTruncation) {
        resolve({
          exitCode: error.code === "ENOENT" ? 127 : 1,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutBytes: Buffer.alloc(0),
          stderrBytes: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
          spawnError: error.code ?? "UNKNOWN",
        });
      } else if (error.code === "ENOENT") reject(Object.assign(error, { code: "process.not-found", exitCode: 127 }));
      else reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (overflow && !allowTruncation) {
        reject(Object.assign(new Error(`child ${stdoutTotal > maxStreamBytes ? "stdout" : "stderr"} exceeded ${maxStreamBytes} bytes`), { code: "command.effect-unavailable" }));
        return;
      }
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      resolve({
        exitCode: exitCode ?? (signal ? 128 + ((constants.signals as Record<string, number>)[signal] ?? 0) : 1),
        signal,
        stdout: stdoutBytes.toString("utf8"),
        stderr: stderrBytes.toString("utf8"),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutTotal > stdoutBytes.byteLength,
        stderrTruncated: stderrTotal > stderrBytes.byteLength,
        spawnError: null,
      });
    });
    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
  });
}
