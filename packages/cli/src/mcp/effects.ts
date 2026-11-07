import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
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
};
type InputState = { stdin: string | undefined; consumed: boolean; cwd: string; signal: AbortSignal };
export type McpEffects = CommandEffects & {
  /**
   * Scope one request's transport-supplied stdin content for the duration of
   * `operation`. The value is the primitive string admission extracted for a
   * command that declares the `stdin` effect; no parsed handler value passes
   * through here.
   */
  withInput<T>(stdin: string | undefined, request: { cwd: string; signal: AbortSignal }, operation: () => Promise<T>): Promise<T>;
};

const MAX_STREAM_BYTES = 1024 * 1024;

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
      return spawnBounded({ ...request, stdinMode: "ignore" });
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
  };
}
function spawnBounded(request: ProcessRequest): Promise<ProcessResult> {
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
      const accepted = Math.min(chunk.byteLength, Math.max(0, MAX_STREAM_BYTES - (next - chunk.byteLength)));
      if (accepted > 0) target.push(chunk.subarray(0, accepted));
      if (next > MAX_STREAM_BYTES && !overflow) {
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
      if (error.code === "ENOENT") reject(Object.assign(error, { code: "process.not-found", exitCode: 127 }));
      else reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (overflow) {
        reject(Object.assign(new Error(`child ${stdoutTotal > MAX_STREAM_BYTES ? "stdout" : "stderr"} exceeded ${MAX_STREAM_BYTES} bytes`), { code: "command.effect-unavailable" }));
        return;
      }
      resolve({
        exitCode: exitCode ?? (signal ? 128 + ((constants.signals as Record<string, number>)[signal] ?? 0) : 1),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    // A child that exits before draining stdin makes this write fail with EPIPE;
    // that race is expected, so the stream error must not reach the process-level handler.
    child.stdin?.on("error", () => {});
    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
  });
}
