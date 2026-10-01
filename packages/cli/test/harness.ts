/**
 * Shared spawn harness for CLI integration suites — single source of the
 * subprocess, env-isolation, and temp-directory conventions used by the
 * command-owner test files. Semantics mirror the former slice4-cli.test.ts
 * local helpers (six-variable ambient scrub, TZ-UTC default, cwd-pinned
 * spawn, mkdtemp/rm cleanup).
 *
 * Test-only module: node/bun builtins only, no production imports.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Absolute path of the packages/cli root, derived from this file's location
 * (never from the invoking process's cwd). */
export const CLI_ROOT: string = resolve(import.meta.dir, "..");

/** Absolute path of the CLI entry source run by every spawned subprocess. */
export const SRC_ENTRY: string = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (same as the CLI
 * suites — engine dir resolution must not leak into fixtures).
 * MSTAR_CLI_PROJECT_ROOT / INIT_CWD are pinned too: `resolveCliPath`
 * (audit-002) reads them ahead of PWD, so an ambient value would redirect
 * every relative-path fixture spuriously. TZ stays pinned so a date any
 * fixture records is read in the same frame the child wrote it (an explicit
 * ambient TZ is propagated; the default is UTC). `extra` is applied after
 * the scrub: a string re-pins or adds a variable, `undefined` deletes one
 * (a suite may deliberately re-introduce a scrubbed variable per case). */
export function cliEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "MSTAR_HARNESS_DIR" ||
      key === "MSTAR_CONTROL_ROOT" ||
      key === "SDD_DIR" ||
      key === "MSTAR_WORKING_BRANCH" ||
      key === "MSTAR_CLI_PROJECT_ROOT" ||
      key === "INIT_CWD"
    ) {
      continue;
    }
    if (value !== undefined) env[key] = value;
  }
  env.TZ = process.env.TZ ?? "UTC";
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test.
 * `stdin` is forwarded to the child when given (persist-style suites). */
export function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin !== undefined ? { stdin: new Blob([opts.stdin]) } : {}),
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Temp root under the OS temp dir for `prefix` — the mkdtemp base path. */
export function tmpRoot(prefix: string): string {
  return join(tmpdir(), prefix);
}

/** Temp dir per test, cleaned up after. Sync callbacks clean up on return or
 * throw; async callbacks clean up once the returned promise settles. */
export function withTempDir(prefix: string, fn: (dir: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(tmpRoot(prefix));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let out: void | Promise<void>;
  try {
    out = fn(dir);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (out instanceof Promise) return out.finally(cleanup);
  cleanup();
  return out;
}
