import { execFileSync } from "node:child_process";
import { runCliCommand } from "./exec";

export type EnsureGlobalCliOpts = {
  version: string;
  dryRun: boolean;
  noGlobalCli: boolean;
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
    const out = execFileSync(CLI_NAME, ["--version"], { encoding: "utf8" });
    return out.trim();
  } catch {
    return null;
  }
}

/** npm install spawn, bounded by a timeout so a stalled registry surfaces
 * as `action: "failed"` instead of hanging init without output. */
function defaultInstall(spec: string): void {
  runCliCommand(["npm", "i", "-g", spec], { timeoutMs: installTimeoutMs() });
}

/**
 * Ensure a matching-version @mstar-harness/cli is installed globally.
 * Synchronous (runCliCommand is sync). Fail-soft: an install throw is
 * returned as `action: "failed"`, never rethrown — init must not fail
 * because the npm global prefix is not writable.
 */
export function ensureGlobalCli(opts: EnsureGlobalCliOpts): EnsureGlobalCliResult {
  const spec = `@mstar-harness/cli@${opts.version}`;
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
  if (current === opts.version) {
    log(`${CLI_NAME} ${current} already on PATH.`);
    return { action: "skipped", reason: "already-matching" };
  }

  try {
    (opts.install ?? defaultInstall)(spec);
    log(`Installed ${spec} globally.`);
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
 * One-line doctor note about the mstar-harness CLI on PATH (SP1-AC6).
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
