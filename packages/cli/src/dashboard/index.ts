/**
 * Dashboard CLI startup: the `mstar dashboard` command.
 *
 * Owns the command's lifecycle around `startDashboard`: print the resolved URL
 * only after the socket listens, open the browser through a fixed
 * executable/argv opener (never shell interpolation), and close the server
 * exactly once on SIGINT/SIGTERM with a bounded drain. No detached daemon and
 * no persistent workspace state: the process serves until it is signalled.
 */
import { spawn } from "node:child_process";
import { startDashboard, type RunningDashboard } from "./server";

/** Open a URL with the platform opener via fixed argv; no shell involved. */
function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, argv, { stdio: "ignore", detached: false, shell: false });
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      console.error(`dashboard: no platform opener (${opener}) found; open ${url} manually.`);
      return;
    }
    console.error(`dashboard: opener failed: ${error.message}`);
  });
}

/** Run the `mstar dashboard` command in the foreground. */
export async function runDashboard(options: {
  harnessDir: string;
  port: number;
  open?: boolean;
  project?: string;
}): Promise<void> {
  let server: RunningDashboard | null = null;
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.error(`dashboard: received ${signal}; closing server`);
    void (server === null ? Promise.resolve() : server.close()).then(() => {
      process.exit(process.exitCode ?? 0);
    });
  };
  // The handlers are installed before the server starts and stay installed for
  // the whole process life: a repeated signal during the drain must be absorbed
  // by the same idempotent close, never left to the default disposition, which
  // would kill a cleanly-closing server with an unexplained nonzero status.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    server = await startDashboard({
      harnessDir: options.harnessDir,
      port: options.port,
      projectId: options.project,
    });
  } catch (error) {
    console.error(`dashboard: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`dashboard: read-only Morning Star dashboard at ${server.url}`);
  console.log("dashboard: press Ctrl+C to stop");
  if (options.open === true) openBrowser(server.url);
}
