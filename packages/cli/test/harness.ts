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

/** Every channel an invoking shell can use to hand this process a leaf seat or
 * an execution identity. A suite that asserts the ABSENCE of one must clear
 * these first: a real leaf shell exports a marker, and a negative control that
 * merely omits it would inherit the shell's value instead of testing nothing. */
export const IDENTITY_CHANNELS = [
  "DSH_MSTAR_LEAF_SEAT",
  "MSTAR_LEAF_SEAT",
  "DSH_SESSION_ID",
  "MSTAR_HOST_SESSION_ID",
  "MSTAR_EXECUTION_IDENTITY",
] as const;

const ambientIdentity = new Map(IDENTITY_CHANNELS.map((key) => [key, process.env[key]]));
const IDENTITY_KEYS: ReadonlySet<string> = new Set(IDENTITY_CHANNELS);

/** Drop the ambient identity channels from THIS process, so a case that sets
 * its own state decides the marker rather than inheriting the shell's. */
export function clearIdentityChannels(): void {
  for (const key of IDENTITY_CHANNELS) delete process.env[key];
}

/** Put the shell's identity channels back (the `afterEach` half of
 * `clearIdentityChannels`), so the snapshot stays the file's only ambient read. */
export function restoreIdentityChannels(): void {
  for (const key of IDENTITY_CHANNELS) {
    const value = ambientIdentity.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Absolute path of the CLI entry source run by every spawned subprocess,
 * unless the suite runs where the CLI is already built: `MSTAR_CLI_ENTRY`
 * then names the built entry `runCli` spawns instead. */
export const SRC_ENTRY: string = join(CLI_ROOT, "src/index.ts");

/** Spawn env with ambient harness env vars pinned out (same as the CLI
 * suites — engine dir resolution must not leak into fixtures).
 * MSTAR_CLI_PROJECT_ROOT / INIT_CWD are pinned too: `resolveCliPath`
 * (audit-002) reads them ahead of PWD, so an ambient value would redirect
 * every relative-path fixture spuriously. TZ stays pinned so a date any
 * fixture records is read in the same frame the child wrote it (an explicit
 * ambient TZ is propagated; the default is UTC). The leaf-seat markers are
 * pinned out as well: a subagent shell exports one, and any registration verb
 * a fixture runs would then refuse with `coordination.leaf-seat` before
 * reaching the behaviour under test. The execution-identity channel is pinned
 * out too: a launcher-set `MSTAR_HOST_SESSION_ID` / `MSTAR_EXECUTION_IDENTITY`
 * / `DSH_SESSION_ID` would otherwise authorize the child as the invoking
 * session. `extra` is applied after the scrub: a string re-pins or adds a
 * variable, `undefined` deletes one (a suite may deliberately re-introduce a
 * scrubbed variable per case). */
export function cliEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key === "MSTAR_HARNESS_DIR" ||
      key === "MSTAR_CONTROL_ROOT" ||
      key === "SDD_DIR" ||
      key === "MSTAR_WORKING_BRANCH" ||
      key === "MSTAR_CLI_PROJECT_ROOT" ||
      key === "INIT_CWD" ||
      IDENTITY_KEYS.has(key)
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

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test.
 * The entry is `MSTAR_CLI_ENTRY` when the suite runs where the CLI is already
 * built, else the source entry. `stdin` is forwarded to the child when given
 * (persist-style suites); `timeout` bounds a child that hangs. `opts.env` is
 * applied through `cliEnv` after its scrub, so an `undefined` value deletes
 * an ambient variable instead of being dropped by a spread. */
export function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; timeout?: number } = {},
): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", process.env.MSTAR_CLI_ENTRY ?? SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: cliEnv(opts.env),
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin !== undefined ? { stdin: new Blob([opts.stdin]) } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
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
