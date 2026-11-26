import { constants } from "node:os";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
export type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  stdinMode?: "inherit" | "ignore";
  signal: AbortSignal;
};
export type ProcessResult = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
/**
 * Classify a spawn failure. Runtime ENOENT messages differ per platform/Bun
 * build (thrown synchronously or delivered on the error event), so both are
 * normalized to one deterministic string.
 *
 * why: the spawn error names argv[0] even when the working directory is what
 * vanished, so the error itself cannot tell the two apart. Probe the directory
 * instead — otherwise a stale workspace is reported as a missing binary and the
 * suggested repair (install the tool) cannot succeed.
 */
export function spawnFailure(error: unknown, request: Pick<ProcessRequest, "argv" | "cwd">): Error {
  if (error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
    if (!existsSync(request.cwd)) {
      return Object.assign(new Error(`working directory not found: ${request.cwd}`), { code: "process.cwd-not-found", exitCode: 1, details: { cwd: request.cwd } });
    }
    const executable = request.argv[0]!;
    return Object.assign(new Error(`executable not found in $PATH: ${executable}`), { code: "process.not-found", exitCode: 127, executable });
  }
  return error as Error;
}

/** Run one admitted argv vector without shell interpretation or protocol-fd inheritance. */
export function spawnProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal.aborted) {
    return Promise.reject(Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" }));
  }
  if (request.argv.length === 0) {
    return Promise.reject(new TypeError("process argv must include an executable"));
  }
  const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
  let child: ChildProcess | undefined;
  let settled = false;
  let abortTimer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    request.signal.removeEventListener("abort", abort);
    if (abortTimer !== undefined) clearTimeout(abortTimer);
  };
  const finish = (result: ProcessResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(result);
  };
  const abort = () => {
    if (child === undefined || child.pid === undefined) return;
    child.kill("SIGTERM");
    abortTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
    abortTimer.unref();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    child = nodeSpawn(request.argv[0]!, request.argv.slice(1), {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: [request.stdin !== undefined ? "pipe" : request.stdinMode === "ignore" ? "ignore" : "inherit", "pipe", "pipe"],
    });
  } catch (error) {
    cleanup();
    reject(spawnFailure(error, request));
    return promise;
  }
  if (request.signal.aborted) abort();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => {
    cleanup();
    settled = true;
    reject(spawnFailure(error, request));
  });
  child.once("close", (exitCode, signal) => finish({
    exitCode: exitCode ?? (signal ? 128 + ((constants.signals as Record<string, number>)[signal] ?? 0) : 1),
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
  // A child that exits before draining stdin makes this write fail with EPIPE;
  // that race is expected, so the stream error must not reach the process-level handler.
  child.stdin?.on("error", () => {});
  if (request.stdin !== undefined) child.stdin?.end(request.stdin);
  return promise;
}
