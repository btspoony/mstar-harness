/**
 * ensureGlobalCli — post-init helper that installs the matching-version
 * @mstar-harness/cli globally. Contract pinned here (SP1-AC1..AC5):
 * - --no-global-cli skips entirely (reason: "flag"), install never called,
 * - --dry-run prints the exact npm command and never spawns (reason: "dry-run"),
 * - a matching `mstar-harness --version` on PATH skips (reason: "already-matching"),
 * - otherwise install is called with the exact pinned spec
 *   `@mstar-harness/cli@<version>` — never latest, never a range,
 * - an install throw is converted to `action: "failed"`, never rethrown.
 * All runners are injected — no live npm registry calls.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGlobalCli } from "./global-cli";
import { readHarnessVersion } from "./utils";

const BASE = { version: "3.4.0", dryRun: false, noGlobalCli: false };

describe("ensureGlobalCli", () => {
  test("skips entirely when --no-global-cli is set (reason: flag)", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const result = ensureGlobalCli({ ...BASE, noGlobalCli: true, install });
    expect(result).toEqual({ action: "skipped", reason: "flag" });
  });

  test("skips on dry-run (reason: dry-run) and prints the exact npm command", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const lines: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      dryRun: true,
      install,
      log: (line) => lines.push(line),
    });
    expect(result).toEqual({ action: "skipped", reason: "dry-run" });
    expect(lines.join("\n")).toContain("npm i -g @mstar-harness/cli@3.4.0");
  });

  test("skips when the PATH version already matches (reason: already-matching)", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const result = ensureGlobalCli({ ...BASE, detectVersion: () => "3.4.0", install });
    expect(result).toEqual({ action: "skipped", reason: "already-matching" });
  });

  test("installs with the exact pinned spec when the PATH version differs", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => "3.3.0",
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: "@mstar-harness/cli@3.4.0" });
    expect(specs).toEqual(["@mstar-harness/cli@3.4.0"]);
  });

  test("installs when the CLI is missing on PATH (detectVersion returns null)", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: "@mstar-harness/cli@3.4.0" });
    expect(specs).toEqual(["@mstar-harness/cli@3.4.0"]);
  });

  test("install throw becomes action: failed with the error message, never rethrown", () => {
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result).toEqual({
      action: "failed",
      spec: "@mstar-harness/cli@3.4.0",
      message: "EACCES: permission denied",
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2 wiring — end-to-end `init` harness. Spawns the real CLI entry
// (src/index.ts) in a sandboxed temp dir with fake `npm` / `dsh` /
// `mstar-harness` binaries on PATH, so the commander `--no-global-cli`
// boundary and both runInit return paths (install-mode + config-mode) are
// exercised without touching a real registry, adapter install, or user
// config. The fake `mstar-harness` reports a non-matching version so the
// install path is always taken deterministically.
// ---------------------------------------------------------------------------

const CLI_ENTRY = path.join(import.meta.dir, "index.ts");
const PACKAGE_VERSION = readHarnessVersion();

type CliResult = { status: number; stdout: string; stderr: string };

function runInitCli(args: string[], env: Record<string, string>): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, "init", ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Write an executable sh script into binDir. */
function writeFakeBin(binDir: string, name: string, body: string): void {
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

describe("init wiring (end-to-end CLI harness)", () => {
  let tmp: string;
  let binDir: string;
  let npmLog: string;
  let dshLog: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "mstar-init-"));
    binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    npmLog = path.join(tmp, "npm.log");
    dshLog = path.join(tmp, "dsh.log");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function cliEnv(): Record<string, string> {
    return {
      MSTAR_CLI_PROJECT_ROOT: tmp,
      DSH_HOME: path.join(tmp, "dsh-home"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
  }

  function fakeNpm(exitCode: number): void {
    writeFakeBin(binDir, "npm", `printf '%s\\n' "$*" >> "${npmLog}"\nexit ${exitCode}`);
  }

  function fakeDsh(): void {
    writeFakeBin(binDir, "dsh", `printf '%s\\n' "$*" >> "${dshLog}"\nexit 0`);
  }

  /** Non-matching PATH version so the install path is always taken. */
  function fakeMstarHarness(): void {
    writeFakeBin(binDir, "mstar-harness", 'echo "0.0.0-test"\nexit 0');
  }

  test("dry-run prints the exact npm command and never spawns npm (SP1-AC3)", () => {
    fakeNpm(0);
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--dry-run", "--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Would run: npm i -g @mstar-harness/cli@${PACKAGE_VERSION}`);
    expect(result.stdout).toContain("Status: ready (dry-run)");
    expect(existsSync(npmLog)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  test("config-mode success installs the exact pinned spec (SP1-AC5)", () => {
    fakeNpm(0);
    fakeMstarHarness();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed @mstar-harness/cli@${PACKAGE_VERSION} globally.`);
    expect(result.stdout).toContain("Status: configured");
    expect(readFileSync(npmLog, "utf8").trim()).toBe(`i -g @mstar-harness/cli@${PACKAGE_VERSION}`);
    expect(existsSync(configPath)).toBe(true);
  });

  test("config-mode stays exit 0 when the global install fails (SP1-AC4)", () => {
    fakeNpm(1);
    fakeMstarHarness();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Global CLI install failed:");
    expect(result.stdout).toContain("Status: configured");
  });

  test("install-mode success installs the exact pinned spec (SP1-AC5)", () => {
    fakeNpm(0);
    fakeMstarHarness();
    fakeDsh();
    const result = runInitCli(["--yes", "--target", "dsh"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed @mstar-harness/cli@${PACKAGE_VERSION} globally.`);
    expect(result.stdout).toContain("Status: configured");
    expect(readFileSync(npmLog, "utf8").trim()).toBe(`i -g @mstar-harness/cli@${PACKAGE_VERSION}`);
  });

  test("install-mode stays exit 0 when the global install fails (SP1-AC4)", () => {
    fakeNpm(1);
    fakeMstarHarness();
    fakeDsh();
    const result = runInitCli(["--yes", "--target", "dsh"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Global CLI install failed:");
    expect(result.stdout).toContain("Status: configured");
  });

  test("--no-global-cli skips the global install entirely (SP1-AC2)", () => {
    fakeNpm(0);
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath, "--no-global-cli"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping global CLI install (--no-global-cli).");
    expect(existsSync(npmLog)).toBe(false);
  });
});
