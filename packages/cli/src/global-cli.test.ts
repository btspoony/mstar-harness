/**
 * ensureGlobalCli — post-init helper that installs the matching-version
 * @mstar-harness/cli globally. Contract pinned here:
 * - --no-global-cli skips entirely (reason: "flag"), install never called,
 * - --dry-run prints the exact npm command and never spawns (reason: "dry-run"),
 * - a matching `mstar-harness --version` on PATH skips (reason: "already-matching"),
 * - otherwise install is called with the exact pinned spec
 *   `@mstar-harness/cli@<version>` — never latest, never a range,
 * - an install throw is converted to `action: "failed"`, never rethrown.
 * All runners are injected — no live npm registry calls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultDetectVersion, ensureGlobalCli, formatCliDoctorNote, formatVersionSkewWarning } from "./global-cli";
import { readHarnessVersion } from "./utils";

// Synthetic version tokens: the helper only needs a well-formed, distinct
// string to compare — never a real version value.
const SYNTH_VERSION = "0.0.0-synthetic";
const SYNTH_OTHER_VERSION = "0.0.0-synthetic-other";
/** Clearly-published-later token for the skew cases (larger core than any real
 * release this fixture could be compared against). */
const SYNTH_PUBLISHED_LATER = "99.0.0-synthetic";

const BASE = { version: SYNTH_VERSION, dryRun: false, noGlobalCli: false };

// One file-scoped fake-bin dir for EVERY fake binary in this file
// (`mstar-harness`, `npm`, `dsh`). Created once and removed once: each
// fake's absolute path never changes, so a bare-name spawn resolution
// cached by any bun runtime always points at a live file, and per-test
// variants overwrite the SAME file in place (content is re-read on every
// exec). Tests that need "CLI missing on PATH" write an `exit 127` body —
// they must never delete files from this dir mid-run.
const FAKE_BIN_DIR = path.join(tmpdir(), `mstar-cli-test-bin-${process.pid}`);

beforeAll(() => {
  mkdirSync(FAKE_BIN_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(FAKE_BIN_DIR, { recursive: true, force: true });
});

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
    expect(lines.join("\n")).toContain(`npm i -g @mstar-harness/cli@${SYNTH_VERSION}`);
  });

  test("skips when the PATH version already matches (reason: already-matching)", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const result = ensureGlobalCli({ ...BASE, detectVersion: () => SYNTH_VERSION, install });
    expect(result).toEqual({ action: "skipped", reason: "already-matching" });
  });

  test("installs with the exact pinned spec when the PATH version differs", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => SYNTH_OTHER_VERSION,
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: `@mstar-harness/cli@${SYNTH_VERSION}` });
    expect(specs).toEqual([`@mstar-harness/cli@${SYNTH_VERSION}`]);
  });

  test("installs when the CLI is missing on PATH (detectVersion returns null)", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: `@mstar-harness/cli@${SYNTH_VERSION}` });
    expect(specs).toEqual([`@mstar-harness/cli@${SYNTH_VERSION}`]);
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
      spec: `@mstar-harness/cli@${SYNTH_VERSION}`,
      message: "EACCES: permission denied",
    });
  });

  test("fail-soft log classifies the failure and prints the retry spec + doctor hint (F-101)", () => {
    const lines: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: () => {
        throw new Error("EACCES: permission denied");
      },
      log: (line) => lines.push(line),
    });
    expect(result.action).toBe("failed");
    const out = lines.join("\n");
    expect(out).toContain("Global CLI install failed: EACCES: permission denied");
    expect(out).toContain("Failure kind: permission");
    expect(out).toContain(`npm i -g @mstar-harness/cli@${SYNTH_VERSION}`);
    expect(out).toContain("mstar-harness doctor");
  });
});

// ---------------------------------------------------------------------------
// Task 3 doctor note — pure three-state formatter. The detected
// value is injected (a synthetic token here): no PATH probing, no
// subprocesses, no dependence on the machine's PATH.
// ---------------------------------------------------------------------------

describe("formatCliDoctorNote", () => {
  test("missing on PATH names the expected version", () => {
    expect(formatCliDoctorNote(null, SYNTH_VERSION)).toBe(
      `CLI on PATH: mstar-harness not found (expected version ${SYNTH_VERSION})`,
    );
  });

  test("version mismatch shows both versions", () => {
    expect(formatCliDoctorNote(SYNTH_OTHER_VERSION, SYNTH_VERSION)).toBe(
      `CLI on PATH: mstar-harness ${SYNTH_OTHER_VERSION} (expected ${SYNTH_VERSION})`,
    );
  });

  test("matching version", () => {
    expect(formatCliDoctorNote(SYNTH_VERSION, SYNTH_VERSION)).toBe(
      `CLI on PATH: mstar-harness ${SYNTH_VERSION} (matching)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Version-format pin (F-202): `defaultDetectVersion` must return the
// trimmed single-line version string. The file-scoped fake-bin dir holds a
// fake `mstar-harness` emitting a synthetic version token with and without a
// trailing newline (same file overwritten in place); both must yield it.
// ---------------------------------------------------------------------------

describe("defaultDetectVersion", () => {
  test("returns the trimmed single-line version with and without a trailing newline (F-202)", () => {
    const oldPath = process.env.PATH;
    try {
      // PATH prepended once, before the first spawn; the newline variant
      // overwrites the SAME absolute file in place — no dir is created or
      // deleted mid-test, so no spawn depends on re-resolving a moved
      // fake (CI bun 1.2.x determinism).
      writeFakeBin("mstar-harness", `printf "${SYNTH_VERSION}"`);
      process.env.PATH = `${FAKE_BIN_DIR}:${oldPath ?? ""}`;
      expect(defaultDetectVersion()).toBe(SYNTH_VERSION);
      writeFakeBin("mstar-harness", `echo "${SYNTH_VERSION}"`);
      expect(defaultDetectVersion()).toBe(SYNTH_VERSION);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2 wiring — end-to-end `init` harness. Spawns the real CLI entry
// (src/index.ts) in a sandboxed temp dir with the file-scoped fake-bin dir
// (fake `npm` / `dsh` / `kimi` / `mstar-harness` binaries, prepended to the
// child PATH) so the commander `--no-global-cli` boundary, both runInit return
// paths (install-mode + config-mode, the install-mode one with and without a
// reported plugin version) and the global-update refusals are exercised
// without touching a real registry, adapter install, or user config. The fake
// `mstar-harness` reports a non-matching version so the install path is always
// taken deterministically.
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

/** Write an executable sh script into the file-scoped fake-bin dir. */
function writeFakeBin(name: string, body: string): void {
  // Names are compile-time literals from the tests above; the file is
  // anchored to the fake-bin dir by plain concatenation (POSIX-only
  // harness: the scripts are /bin/sh + chmod).
  const file = FAKE_BIN_DIR + "/" + name;
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

describe("init wiring (end-to-end CLI harness)", () => {
  let tmp: string;
  let npmLog: string;
  let dshLog: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "mstar-init-"));
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
      PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}`,
    };
  }

  function fakeNpm(exitCode: number): void {
    writeFakeBin("npm", `printf '%s\\n' "$*" >> "${npmLog}"\nexit ${exitCode}`);
  }

  function fakeDsh(): void {
    writeFakeBin("dsh", `printf '%s\\n' "$*" >> "${dshLog}"\nexit 0`);
  }

  /** Fake opencode reporting a V2 version so the host-presence gate and the
   * generation probe resolve deterministically in tests that run a real
   * config-mode init for the opencode target. */
  function fakeOpencode(): void {
    writeFakeBin("opencode", `echo "opencode v2.0.26"\nexit 0`);
  }

  /** Fake kimi CLI: the install-mode target whose adapter installs the plugin
   * through the host TUI and swallows initFlags, so its install result carries
   * no plugin version at all. */
  function fakeKimi(): void {
    writeFakeBin("kimi", `exit 0`);
  }

  /** Fake mstar-harness reporting a version; default non-matching so the
   * install path is always taken deterministically. */
  function fakeMstarHarness(version = SYNTH_OTHER_VERSION): void {
    writeFakeBin("mstar-harness", `echo "${version}"\nexit 0`);
  }

  /** Fake npm whose latest probe succeeds and whose global install fails. */
  function fakeNpmReportingLatestThenFailInstall(latest: string): void {
    writeFakeBin("npm", `if [ "$1" = "view" ]; then echo "${latest}"; exit 0; fi
printf '%s\\n' "$*" >> "${npmLog}"
exit 1`);
  }

  /** Fake npm that logs its args, then hangs (used with a tiny install
   * timeout to exercise the kill path). The registry probe is answered
   * immediately so only the install is what stalls. */
  function fakeNpmHang(): void {
    writeFakeBin("npm", `if [ "$1" = "view" ]; then exit 0; fi
printf '%s\\n' "$*" >> "${npmLog}"
exec sleep 10`);
  }

  /** Only the `i -g <spec>` invocations: the registry probe shares this binary,
   * so "npm never ran" is not the contract — "no global install ran" is. */
  function installLines(): string[] {
    if (!existsSync(npmLog)) return [];
    return readFileSync(npmLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("i -g "))
      // The neutral npm config flags are plumbing: assertions name the spec.
      .map((line) => line.split(" --userconfig")[0]!);
  }

  /** Fake npm that answers `view <pkg> version` with a published version and
   * logs any other invocation (install path). */
  function fakeNpmReportingLatest(latest: string): void {
    writeFakeBin("npm", `if [ "$1" = "view" ]; then echo "${latest}"; printf '%s\\n' "npm noise on stderr" >&2; exit 0; fi
printf '%s\\n' "$*" >> "${npmLog}"
exit 0`);
  }

  test("the optional probe's stderr never reaches init's output", () => {
    fakeNpmReportingLatest(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("npm noise on stderr");
  });

  test("an older running CLI installs the published latest instead of itself", () => {
    fakeNpmReportingLatest(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the published latest is");
    expect(result.stdout).toContain(SYNTH_PUBLISHED_LATER);
    // The reported defect: a PATH version equal to the stale runner must not
    // make init skip, because what gets installed is the published latest.
    expect(installLines()).toEqual([`i -g @mstar-harness/cli@${SYNTH_PUBLISHED_LATER}`]);
  });

  test("a PATH already at the published latest is left alone", () => {
    fakeNpmReportingLatest(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(SYNTH_PUBLISHED_LATER);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already on PATH");
    expect(installLines()).toEqual([]);
  });

  test("an unreadable registry leaves init quiet on the version question", () => {
    fakeNpm(1);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("the published latest is");
  });

  test("dry-run prints the exact npm command and never spawns npm", () => {
    fakeNpm(0);
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--dry-run", "--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Would run: npm i -g @mstar-harness/cli@${PACKAGE_VERSION}`);
    expect(result.stdout).toContain("Status: ready (dry-run)");
    expect(existsSync(npmLog)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  test("config-mode success installs the exact pinned spec", () => {
    fakeNpm(0);
    fakeMstarHarness();
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed @mstar-harness/cli@${PACKAGE_VERSION} globally.`);
    expect(result.stdout).toContain("Status: configured");
    expect(installLines()).toEqual([`i -g @mstar-harness/cli@${PACKAGE_VERSION}`]);
    // The pairing line names the version the run targeted and the global state.
    expect(existsSync(configPath)).toBe(true);
  });
  test("OpenCode refuses to replace a symlink config and leaves its target untouched", () => {
    fakeOpencode();
    const configPath = path.join(tmp, "linked-opencode.json");
    const targetPath = path.join(tmp, "user-config.json");
    const original = '{"user":"config"}';
    writeFileSync(targetPath, original);
    symlinkSync(targetPath, configPath);
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath, "--no-global-cli"], cliEnv());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).toContain("regular path or resolve the link intentionally");
    expect(readFileSync(targetPath, "utf8")).toBe(original);
  });

  test("config-mode stays exit 0 when the global install fails", () => {
    fakeNpm(1);
    fakeMstarHarness();
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Global CLI install failed:");
    expect(result.stdout).toContain("Status: configured");
  });

  test("install-mode success installs the exact pinned spec", () => {
    fakeNpm(0);
    fakeMstarHarness();
    fakeDsh();
    const result = runInitCli(["--yes", "--target", "dsh"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed @mstar-harness/cli@${PACKAGE_VERSION} globally.`);
    expect(result.stdout).toContain("Status: configured");
    expect(installLines()).toEqual([`i -g @mstar-harness/cli@${PACKAGE_VERSION}`]);
    // The pairing line names the version the run targeted and the global state.
    expect(result.stdout).toMatch(/Plugin version: .+; global CLI: installed @mstar-harness\/cli@/);
  });

  test("install-mode stays exit 0 when the global install fails", () => {
    fakeNpm(1);
    fakeMstarHarness();
    fakeDsh();
    const result = runInitCli(["--yes", "--target", "dsh"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Global CLI install failed:");
    // The pairing line reports what actually happened, never a claimed pairing.
    expect(result.stdout).toMatch(/Plugin version: .+; global CLI: install FAILED for @mstar-harness\/cli@/);
    expect(result.stdout).toContain("Status: configured");
  });

  test("a plugin newer than the CLI on PATH is a refusal, not a success", () => {
    // The published latest is newer, so the plugin installs at that version; the
    // global update then fails, which would leave exactly the reported skew.
    fakeNpmReportingLatestThenFailInstall(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeDsh();
    const result = runInitCli(["--yes", "--target", "dsh"], cliEnv());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--no-global-cli");
    expect(result.stderr).toContain(SYNTH_PUBLISHED_LATER);
  });

  test("config mode refuses a failed global install of a newer published CLI", () => {
    fakeNpmReportingLatestThenFailInstall(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Recovery:");
    expect(result.stderr).toContain(`npm i -g @mstar-harness/cli@${SYNTH_PUBLISHED_LATER}`);
  });

  test("install mode with no plugin version refuses a failed newer-version global update (I-000688)", () => {
    // kimi reports no plugin version, so the refusal must key off the failed
    // global install alone — and name that install as its cause, not plugin skew.
    fakeNpmReportingLatestThenFailInstall(SYNTH_PUBLISHED_LATER);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeKimi();
    const result = runInitCli(["--yes", "--target", "kimi"], cliEnv());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Recovery:");
    expect(result.stderr).toContain(`npm i -g @mstar-harness/cli@${SYNTH_PUBLISHED_LATER}`);
    expect(result.stderr).toContain("--no-global-cli");
    // Not reported as a successful init: no post-install next-step line.
    expect(result.stdout).not.toContain("Next: npx");
  });

  test("--no-global-cli skips the global install entirely", () => {
    fakeNpm(0);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath, "--no-global-cli"], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping global CLI install (--no-global-cli).");
    expect(installLines()).toEqual([]);
  });

  test("a stalled npm install times out and fail-softs with exit 0 (F-201)", () => {
    fakeNpmHang();
    fakeMstarHarness();
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], {
      ...cliEnv(),
      MSTAR_CLI_INSTALL_TIMEOUT_MS: "500",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Global CLI install failed:");
    expect(result.stdout).toContain("Failure kind: npm");
    expect(result.stdout).toContain("Status: configured");
    expect(existsSync(npmLog)).toBe(true);
  });

  test("a matching PATH version skips the install (repeated-init idempotency, F-203)", () => {
    fakeNpm(0);
    fakeMstarHarness(PACKAGE_VERSION);
    fakeOpencode();
    const configPath = path.join(tmp, "opencode.json");
    const result = runInitCli(["--yes", "--target", "opencode", "--output", configPath], cliEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already on PATH");
    expect(result.stdout).toContain("Status: configured");
    expect(installLines()).toEqual([]);
  });
});

describe("published-latest skew warning", () => {
  test("stays silent when the registry could not be read or the versions match", () => {
    expect(formatVersionSkewWarning(SYNTH_VERSION, null)).toBeNull();
    expect(formatVersionSkewWarning(SYNTH_VERSION, SYNTH_VERSION)).toBeNull();
  });

  test("stays silent when the running version is ahead of the published latest", () => {
    // A local or prerelease build ahead of `latest` must not be told to move back.
    expect(formatVersionSkewWarning(SYNTH_PUBLISHED_LATER, SYNTH_OTHER_VERSION)).toBeNull();
    expect(formatVersionSkewWarning(SYNTH_PUBLISHED_LATER, SYNTH_PUBLISHED_LATER)).toBeNull();
  });

  test("names both versions and the pinned-latest recovery", () => {
    const line = formatVersionSkewWarning(SYNTH_VERSION, SYNTH_OTHER_VERSION);
    expect(line).toContain(SYNTH_VERSION);
    expect(line).toContain(SYNTH_OTHER_VERSION);
    expect(line).toContain("@mstar-harness/cli@latest");
  });
});
