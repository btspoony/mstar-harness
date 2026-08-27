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

/** Architect-locked 2026-08-27: runCliCommand already wraps execFileSync with dry-run/timeout/env handling. */
function defaultInstall(spec: string): void {
  runCliCommand(["npm", "i", "-g", spec]);
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
    log(`Global CLI install failed: ${message}`);
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
    return `CLI on PATH: mstar-harness not found (expected version ${expected})`;
  }
  if (detected !== expected) {
    return `CLI on PATH: mstar-harness ${detected} (expected ${expected})`;
  }
  return `CLI on PATH: mstar-harness ${detected} (matching)`;
}
