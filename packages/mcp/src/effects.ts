import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { startDashboard, type CommandEffects } from "@mstar-harness/commands";

type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  signal: AbortSignal;
};
type ProcessResult = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
type InputState = { value: unknown; consumed: boolean };
export type McpEffects = Omit<CommandEffects, "captureSddEvidence" | "verifySddEvidence"> & {
  withInput<T>(input: unknown, operation: () => Promise<T>): Promise<T>;
  captureSddEvidence: NonNullable<CommandEffects["captureSddEvidence"]>;
  verifySddEvidence: NonNullable<CommandEffects["verifySddEvidence"]>;
};

const MAX_STREAM_BYTES = 1024 * 1024;

export function createMcpEffects(services: Array<{ close(): Promise<void> }>): McpEffects {
  const inputs = new AsyncLocalStorage<InputState>();
  return {
    withInput<T>(input: unknown, operation: () => Promise<T>) {
      return inputs.run({ value: input, consumed: false }, operation);
    },
    async readInput() {
      const state = inputs.getStore();
      if (state === undefined) throw new Error("MCP stdin effect is outside a request");
      if (state.consumed) throw new Error("MCP input payload can only be consumed once");
      state.consumed = true;
      const record = state.value !== null && typeof state.value === "object" ? state.value as Record<string, unknown> : {};
      if (typeof record.input !== "string") {
        throw Object.assign(new Error("MCP stdin effect requires an explicit input string"), { code: "command.invalid-input" });
      }
      if (Buffer.byteLength(record.input) > MAX_STREAM_BYTES) {
        throw Object.assign(new Error(`MCP stdin payload exceeds ${MAX_STREAM_BYTES} bytes`), { code: "command.invalid-input" });
      }
      return record.input;
    },
    spawn(request: ProcessRequest) {
      return spawnBounded(request);
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
    async captureSddEvidence() {
      throw Object.assign(new Error("MCP capability sdd-evidence.capture is unavailable"), { code: "command.effect-unavailable" });
    },
    async verifySddEvidence() {
      throw Object.assign(new Error("MCP capability sdd-evidence.verify is unavailable"), { code: "command.effect-unavailable" });
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
        shell: false,
        stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      if (child.pid === undefined) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    const cleanup = () => {
      request.signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
    };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const collect = (target: Buffer[], chunk: Buffer, which: "stdout" | "stderr") => {
      const next = (which === "stdout" ? stdoutBytes : stderrBytes) + chunk.byteLength;
      if (which === "stdout") stdoutBytes = next;
      else stderrBytes = next;
      if (next > MAX_STREAM_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
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
        reject(Object.assign(new Error(`child ${stdoutBytes > MAX_STREAM_BYTES ? "stdout" : "stderr"} exceeded ${MAX_STREAM_BYTES} bytes`), { code: "command.effect-unavailable" }));
        return;
      }
      resolve({
        exitCode: exitCode ?? (signal ? 128 + ((constants.signals as Record<string, number>)[signal] ?? 0) : 1),
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (request.stdin !== undefined) child.stdin?.end(request.stdin);
  });
}
