import { spawn, type ChildProcess } from "node:child_process";

// A platform opener that never emits `spawn` or `error` would pend the caller
// forever, so the wait for its start is bounded.
const OPENER_TIMEOUT_MS = 5_000;

export function openBrowserBounded(url: string, signal?: AbortSignal): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return startBounded(command, () => spawn(command, args, { stdio: "ignore", shell: false }), signal, OPENER_TIMEOUT_MS);
}

/**
 * Resolve once the opener starts. A missing opener, a stalled start, and an
 * aborted request all stop the wait instead of leaving it pending.
 */
export function startBounded(
  command: string,
  spawnChild: () => ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const unavailable = (detail: string) => Object.assign(
    new Error(`no platform opener (${command}) available: ${detail}`),
    { code: "capability.browser.unavailable" },
  );
  const cancelled = () => Object.assign(new Error("browser opener cancelled"), { code: "command.cancelled" });
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
        return;
      }
      child?.kill();
      reject(error);
    };
    const onAbort = () => finish(cancelled());
    timer = setTimeout(() => finish(unavailable(`did not start within ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawnChild();
    } catch (error) {
      finish(unavailable(error instanceof Error ? error.message : String(error)));
      return;
    }
    child.once("spawn", () => finish());
    child.once("error", (error: NodeJS.ErrnoException) => finish(unavailable(error.message)));
  });
}
