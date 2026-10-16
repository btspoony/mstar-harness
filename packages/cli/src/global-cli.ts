import { compareSemver } from "@mstar-harness/commands";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCliCommand } from "./exec";

export type EnsureGlobalCliOpts = {
  version: string;
  dryRun: boolean;
  noGlobalCli: boolean;
  /** Published `latest`, when it was probed: a newer published version is what
   * gets installed, so a stale npx resolution cannot leave the operator on an
   * older CLI. `undefined` (not probed) keeps `version`. */
  latest?: string | null;
  /** Return current mstar-harness version on PATH, or null if missing. */
  detectVersion?: () => string | null;
  /** Run `npm i -g @mstar-harness/cli@<version>`. Throw on failure. */
  install?: (spec: string) => void;
  log?: (line: string) => void;
};

export type EnsureGlobalCliResult =
  | { action: "skipped"; reason: "flag" | "dry-run" | "already-matching" }
  | { action: "installed"; spec: string }
  | { action: "failed"; spec: string; message: string };

const CLI_NAME = "mstar-harness";
const CLI_PACKAGE = "@mstar-harness/cli";
/** Registry probe ceiling (ms): a slow or offline registry must not delay init. */
const LATEST_PROBE_TIMEOUT_MS = 2_000;
/** npm install timeout (ms): a stalled registry must surface as an error
 * instead of hanging init without output. Mirrors the dsh adapter's
 * DSH_ADD_TIMEOUT_MS convention; overridable via env so tests can shrink
 * it to exercise the kill path. */
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_INSTALL_TIMEOUT_ENV = "MSTAR_CLI_INSTALL_TIMEOUT_MS";

/** Install-path timeout: env override wins, else the conservative default. */
function installTimeoutMs(): number {
  const raw = process.env[NPM_INSTALL_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return NPM_INSTALL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NPM_INSTALL_TIMEOUT_MS;
}

/**
 * Spawn `mstar-harness --version`; any failure (missing binary, non-zero)
 * means not on PATH. Shared default for `ensureGlobalCli` and the doctor
 * CLI-on-PATH note — one probe, no duplicated spawn code.
 */
export function defaultDetectVersion(): string | null {
  try {
    // env: process.env — bun 1.2.x resolves bare command names against the
    // PATH captured at process startup unless env is passed explicitly, so
    // a mid-process PATH change (tests) would be invisible. Explicit
    // inheritance is the documented execFileSync default; same pattern as
    // adapters/dsh.ts runDsh.
    const out = execFileSync(CLI_NAME, ["--version"], { encoding: "utf8", env: process.env });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve `npm` outside the working tree. A checkout can prepend its own
 * `node_modules/.bin` to PATH, which would let that checkout choose the npm this
 * command runs; every PATH entry inside the working directory is skipped.
 */
function resolveTrustedNpm(): string {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm prepends `node_modules/.bin` for every ANCESTOR of the working
  // directory, so filtering by the cwd alone still accepts a checkout's own npm
  // when init runs from a subdirectory. Every ancestor is excluded, by realpath
  // where one is resolvable.
  const ancestors = new Set<string>();
  let dir = process.cwd();
  for (;;) {
    ancestors.add(dir);
    try {
      ancestors.add(fs.realpathSync(dir));
    } catch {
      // an unresolvable ancestor contributes its literal path only
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const insideCheckout = (candidate: string): boolean => {
    let resolved = candidate;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      // a missing entry keeps its literal path
    }
    for (const ancestor of ancestors) {
      if (resolved === ancestor || resolved.startsWith(ancestor + path.sep)) return true;
    }
    return false;
  };
  for (const entry of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (entry === "") continue;
    const dir = path.resolve(entry);
    if (insideCheckout(dir)) continue;
    const candidate = path.join(dir, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return executable; // last resort: the platform's own resolution
}

/** npm install spawn, bounded by a timeout so a stalled registry surfaces
 * as `action: "failed"` instead of hanging init without output. Runs from a
 * neutral directory so the project's npm config cannot steer a global install. */
function defaultInstall(spec: string): void {
  runCliCommand([resolveTrustedNpm(), "i", "-g", spec], {
    cwd: tmpdir(),
    timeoutMs: installTimeoutMs(),
  });
}

/**
 * Published `latest` version of this package, or null when it cannot be read.
 * A warm npm cache can serve an older resolution to `npx <pkg>` — the CLI then
 * runs a stale version and every step it takes (including the global install
 * below) is version-skewed with no visible sign, so init states the skew and
 * installs the published version instead of the stale one.
 * Offline, stalled, or unreadable: null, and the caller stays quiet.
 */
export function detectPublishedLatest(): string | null {
  try {
    // `--prefer-online` revalidates the packument: the same stale npm cache
    // that can hand `npx` an old resolution would otherwise answer this probe
    // with the very tag this check exists to catch.
    // `--prefer-online` revalidates the packument; the user/global configs are
    // neutralized and the probe runs outside the working tree so neither the
    // checkout's npm config nor its PATH can steer the answer.
    const out = execFileSync(
      resolveTrustedNpm(),
      [
        "view",
        "--prefer-online",
        `${CLI_PACKAGE}`,
        "version",
        "--userconfig",
        "/dev/null",
        "--globalconfig",
        "/dev/null",
      ],
      {
        // An optional probe must not print: capture both streams so an offline
        // or misconfigured registry stays silent, as documented.
        stdio: ["ignore", "pipe", "pipe"],
        cwd: tmpdir(),
        encoding: "utf8",
        env: process.env,
        timeout: LATEST_PROBE_TIMEOUT_MS,
      },
    );
    const value = out.trim();
    return value === "" || value === "undefined" ? null : value;
  } catch {
    return null;
  }
}

/**
 * One-line warning when the CLI that is running is not the published `latest`,
 * or null when it matches or the registry could not be read. Kept separate from
 * `ensureGlobalCli` so the network probe sits at the CLI edge and the install
 * helper stays injectable without a live registry.
 */
/**
 * The version `init` installs: the published `latest` when it is higher than the
 * running one, else the running version. A leading (or equal) prerelease is never
 * downgraded, so this is also the version the host install must pin.
 */
export function chooseCliVersion(version: string, latest: string | null): string {
  if (latest === null) return version;
  return compareSemver(latest, version) > 0 ? latest : version;
}

export function formatVersionSkewWarning(version: string, latest: string | null): string | null {
  // Only a version BEHIND the published latest is skew: a local (or prerelease)
  // build ahead of it must not be told to move backwards.
  if (latest === null || compareSemver(latest, version) <= 0) return null;
  return (
    `Warning: this CLI is ${CLI_PACKAGE}@${version}; the published latest is ${latest}. ` +
    `A cached npx resolution can run an older CLI, and every step of this init follows the CLI that ran \u2014 ` +
    `re-run with \`npx ${CLI_PACKAGE}@latest init \u2026\`.`
  );
}

/**
 * Ensure a matching-version @mstar-harness/cli is installed globally.
 * Synchronous (runCliCommand is sync). Fail-soft: an install throw is
 * returned as `action: "failed"`, never rethrown — init must not fail
 * because the npm global prefix is not writable.
 */
export function ensureGlobalCli(opts: EnsureGlobalCliOpts): EnsureGlobalCliResult {
  // A published version newer than the one running is what the operator asked
  // for (an unpinned `npx` spec means latest), so it is what gets installed.
  const newer = chooseCliVersion(opts.version, opts.latest ?? null) === opts.version ? null : opts.latest!;
  const target = newer ?? opts.version;
  const spec = `@mstar-harness/cli@${target}`;
  const log = opts.log ?? ((line: string) => console.log(line));

  if (opts.noGlobalCli) {
    log("Skipping global CLI install (--no-global-cli).");
    return { action: "skipped", reason: "flag" };
  }

  if (opts.dryRun) {
    log(`Would run: npm i -g ${spec}`);
    return { action: "skipped", reason: "dry-run" };
  }

  const current = (opts.detectVersion ?? defaultDetectVersion)();
  if (current === target) {
    log(`${CLI_NAME} ${current} already on PATH.`);
    return { action: "skipped", reason: "already-matching" };
  }

  try {
    (opts.install ?? defaultInstall)(spec);
    log(
      newer === null
        ? `Installed ${spec} globally.`
        : `Installed ${spec} globally (this run was ${opts.version}; ${newer} is the published latest).`,
    );
    return { action: "installed", spec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = /EACCES|EPERM/.test(message) ? "permission" : "npm";
    log(`Global CLI install failed: ${message}`);
    log(`Failure kind: ${kind} (retry: npm i -g ${spec})`);
    log(`Hint: run \`mstar-harness doctor\` to check the CLI on PATH.`);
    return { action: "failed", spec, message };
  }
}

/**
 * One-line doctor note about the mstar-harness CLI on PATH.
 * Informational only: `runDoctor` prints it for every target without adding
 * it to doctor errors and without changing the exit code. Three states:
 * missing on PATH, present with a different version (both versions shown),
 * present and matching.
 */
export function formatCliDoctorNote(detected: string | null, expected: string): string {
  if (detected === null) {
    return `CLI on PATH: ${CLI_NAME} not found (expected version ${expected})`;
  }
  if (detected !== expected) {
    return `CLI on PATH: ${CLI_NAME} ${detected} (expected ${expected})`;
  }
  return `CLI on PATH: ${CLI_NAME} ${detected} (matching)`;
}
