import { constants } from "node:os";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
export type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  stdinMode?: "inherit" | "ignore";
  signal: AbortSignal;
};
export type ProcessResult = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
/** Runtime ENOENT messages differ per platform/Bun build (thrown synchronously
 * or delivered on the error event); normalize both to one deterministic string. */
function normalizeNotFound(error: unknown, executable: string): Error {
  if (error !== null && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return Object.assign(new Error(`executable not found in $PATH: ${executable}`), { code: "process.not-found", exitCode: 127 });
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
    reject(normalizeNotFound(error, request.argv[0]!));
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
    reject(normalizeNotFound(error, request.argv[0]!));
  });
  child.once("close", (exitCode, signal) => finish({
    exitCode: exitCode ?? (signal ? 128 + ((constants.signals as Record<string, number>)[signal] ?? 0) : 1),
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
  if (request.stdin !== undefined) child.stdin?.end(request.stdin);
  return promise;
}
