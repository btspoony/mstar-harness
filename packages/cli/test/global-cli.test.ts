/**
 * A failed global-update at the `init` edge must refuse, in both init modes
 * (I-000688):
 * - install mode: the adapter installs no host plugin and ignores `initFlags`,
 *   so no plugin version is ever known — the failure must not need one;
 * - config-only mode: no host plugin is mutated, and the newer CLI on PATH is
 *   what the run promised — the pre-existing refusal this suite pins.
 *
 * The registry probe and the global install are faked on PATH (a fake `npm`),
 * and the fake `mstar-harness` on PATH reports a different version, so the
 * update is attempted and fails deterministically: no live registry, no real
 * global install.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
/** Minimal PATH: no ambient npm/mstar-harness can be resolved ahead of the fakes. */
const ISOLATED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Synthetic "published later" token: only needs a larger core than the running one. */
const PUBLISHED_LATER = "99.0.0-synthetic";
/** Version reported by the fake CLI on PATH: distinct from PUBLISHED_LATER, so the update is attempted. */
const PATH_CLI_VERSION = "0.0.0-synthetic";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeBin(binDir: string, name: string, body: string): void {
  const script = join(binDir, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
}

/**
 * Fake toolchain on PATH: `npm view` publishes a newer version, `npm i -g`
 * fails the way an unwritable global prefix does, and `mstar-harness --version`
 * reports a version that does not match the target.
 */
function fakeBin(hostBinaries: string[]): string {
  const binDir = tempRoot("mstar-global-update-bin-");
  writeBin(binDir, "npm", `if [ "$1" = "view" ]; then echo "${PUBLISHED_LATER}"; exit 0; fi\necho "npm ERR! EACCES: permission denied" >&2\nexit 1`);
  writeBin(binDir, "mstar-harness", `echo "${PATH_CLI_VERSION}"`);
  for (const binary of hostBinaries) writeBin(binDir, binary, `exit 0`);
  return binDir;
}

function cliEnv(pathValue: string, home: string, projectRoot: string): Record<string, string> {
  const env: Record<string, string> = { PATH: pathValue, HOME: home, MSTAR_CLI_PROJECT_ROOT: projectRoot };
  for (const [key, value] of Object.entries(process.env)) {
    if (["MSTAR_HARNESS_DIR", "MSTAR_CONTROL_ROOT", "SDD_DIR", "MSTAR_WORKING_BRANCH", "MSTAR_CLI_PROJECT_ROOT"].includes(key)) continue;
    if (value !== undefined) env[key] = env[key] ?? value;
  }
  return env;
}

function runInit(args: string[], binDir: string, projectRoot: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, "init", ...args], {
    cwd: projectRoot,
    env: cliEnv(`${binDir}:${ISOLATED_PATH}`, tempRoot("mstar-global-update-home-"), projectRoot),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

test("install mode refuses a failed global update with no known plugin version", { timeout: 30_000 }, () => {
  // kimi installs its plugin through the host TUI and ignores initFlags: the
  // install result carries no pluginVersion at all.
  const root = tempRoot("mstar-global-update-kimi-");
  const binDir = fakeBin(["kimi"]);
  const result = runInit(["--target", "kimi", "--yes"], binDir, root);
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("Recovery:");
  expect(output).toContain("--no-global-cli");
  // Not reported as a successful init: no post-install next-step line.
  expect(output).not.toContain("Next: npx");
});

test("config-only mode still refuses a failed global update", { timeout: 30_000 }, () => {
  const root = tempRoot("mstar-global-update-opencode-");
  const binDir = fakeBin(["opencode"]);
  const result = runInit(
    ["--target", "opencode", "--yes", "--scope", "project", "--opencode-generation", "v2"],
    binDir,
    root,
  );
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("Recovery:");
  expect(output).toContain(`npm i -g @mstar-harness/cli@${PUBLISHED_LATER}`);
});
