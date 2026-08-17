import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, InstallInitFlags, Scope } from "../types";

// --- dsh CLI surface (probe-pinned 2026-08-17 on dsh 0.1.0-rc.6) ---
// - `--profile <name>` is required and must precede the subcommand:
//   `dsh plugin --help` without it exits 1 with
//   "required option '--profile <name>' not specified".
// - `dsh plugin --profile <name> add <spec>` forwards <spec> to pnpm in the
//   profile dir (writes package.json dependencies, materializes node_modules)
//   and reconciles `dsh.profile.bundles` from the installed state: any
//   dependency whose manifest declares `dsh.bundle` joins the layer stack
//   (appended in dependency order).
// - Duplicate `add` of an already-installed spec is a no-op: pnpm prints
//   "Already up to date", exits 0, and the bundle list is unchanged.
// - Enumeration surface: `dsh --profile <name> --dump-config` prints the
//   composed loader tree and exits 0 without booting a live fiber; each
//   installed bundle shows up as loader entries (`- id: <id>` then a
//   `name: <spec>` line), disabled rows included.
// - There is no `dsh plugin list` subcommand; enumeration goes through
//   --dump-config (or the profile manifest under $DSH_HOME/profiles/<name>).
const DSH_BIN = "dsh";
const DSH_PROFILE = "web";
const DSH_PROFILE_FLAG = "--profile";
const DSH_DUMP_FLAG = "--dump-config";
const DSH_HOME_ENV = "DSH_HOME";
const DSH_HOME_SUBDIR = ".dsh";
const DSH_PROFILES_DIR = "profiles";

/** Install order is the F4 double-command contract: mstar first, fallbacks
 * second (reconcile append order — the fallbacks row lands after the
 * dsh-base/llm-retry layers). The lines are never folded into any patch.
 * Default profile is fixed to `web` (dsh-tui not verified); centralized so a
 * future profile flag changes exactly one place. */
const DSH_PLUGIN_SPECS: readonly string[] = ["@mstar-harness/dsh", "dsh-llm-fallbacks"];
const DSH_FALLBACKS_SPEC = DSH_PLUGIN_SPECS[1];

const DSH_INSTALL_HINT =
  "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.";

/** Run dsh with args; dry-run never spawns a subprocess (preview only). */
function runDsh(args: string[], dryRun: boolean): string {
  if (dryRun) return "";
  // Explicit `env` snapshot: Bun resolves the command against the env's PATH
  // only when `env` is passed (otherwise it uses the startup PATH), which is
  // what lets tests inject a fake dsh via PATH.
  return execFileSync(DSH_BIN, args, { stdio: "pipe", encoding: "utf8", env: process.env });
}

function dshAvailable(): boolean {
  try {
    runDsh(["--version"], false);
    return true;
  } catch {
    return false;
  }
}

/** The `web` profile directory. dsh resolves its home from $DSH_HOME, else
 * `~/.dsh` (observed on this machine). Only used for the reported location;
 * installed-state detection goes through the dsh binary itself. */
function resolveProfileDir(): string {
  const dshHome = process.env[DSH_HOME_ENV] ?? path.join(os.homedir(), DSH_HOME_SUBDIR);
  return path.join(dshHome, DSH_PROFILES_DIR, DSH_PROFILE);
}

/** Loader entry names from a `dsh --profile <name> --dump-config` dump: a
 * flat list of loader entries (`- id: <id>` followed by indented keys), each
 * carrying exactly one `name: <spec>` line right after the id. */
function loaderEntryNames(dump: string): string[] {
  const names: string[] = [];
  let inEntry = false;
  for (const line of dump.split("\n")) {
    if (/^- id: /.test(line)) {
      inEntry = true;
    } else if (inEntry) {
      const match = /^  name: (.+)$/.exec(line);
      if (match) {
        names.push(match[1].trim().replace(/^['"]|['"]$/g, ""));
        inEntry = false;
      } else if (line.trim() !== "" && !line.startsWith("  ")) {
        inEntry = false;
      }
    }
  }
  return names;
}

/** Install orchestration for the dsh target. `scope` is accepted for the
 * shared AgentAdapter contract but has no dsh surface: dsh profiles live
 * machine-globally under $DSH_HOME/profiles, so the flow is identical for
 * global and project scopes. */
function runInit(scope: Scope, dryRun: boolean, initFlags?: InstallInitFlags) {
  const notes: string[] = [];
  const profileDir = resolveProfileDir();

  // Fail-loud when the dsh bin is absent: without it there is nothing an
  // init can complete (deliberate divergence from omp's note-and-continue,
  // whose local repo clone/link side effects still make progress).
  if (!dryRun && !dshAvailable()) {
    throw new Error(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
  }

  // Probe installed state from the composed loader tree: same binary, same
  // home resolution as `add`, so the probe can never disagree with install.
  const installed = new Set<string>();
  if (!dryRun) {
    try {
      for (const name of loaderEntryNames(runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG], dryRun))) {
        installed.add(name);
      }
    } catch (error) {
      // Probe unavailable: degrade to unconditional adds. Duplicate `add` is
      // a pinned no-op (probe 2026-08-17), so the install stays idempotent.
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Warning: could not probe installed plugins (${message}); proceeding with add (idempotent).`);
    }
  }

  for (const spec of DSH_PLUGIN_SPECS) {
    if (spec === DSH_FALLBACKS_SPEC && initFlags?.noFallbacks) {
      notes.push(`skipped-by-flag: ${spec} (--no-fallbacks)`);
      continue;
    }
    if (!dryRun && installed.has(spec)) {
      notes.push(`skipped-existing: ${spec} (already installed in profile ${DSH_PROFILE})`);
      continue;
    }
    const addArgs = ["plugin", DSH_PROFILE_FLAG, DSH_PROFILE, "add", spec];
    if (dryRun) {
      notes.push(`Would run: ${DSH_BIN} ${addArgs.join(" ")}`);
      continue;
    }
    try {
      runDsh(addArgs, dryRun);
      notes.push(`installed: ${spec} (${DSH_BIN} ${addArgs.join(" ")})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install ${spec} via ${DSH_BIN}: ${message}`);
    }
  }

  notes.push(`Profile: ${DSH_PROFILE} at ${profileDir}`);
  notes.push("Verify with: mstar-harness doctor --target dsh");
  notes.push(
    `Alternate manual install: ${DSH_BIN} ${DSH_PROFILE_FLAG} ${DSH_PROFILE} add ${DSH_PLUGIN_SPECS.join(
      ` && ${DSH_BIN} ${DSH_PROFILE_FLAG} ${DSH_PROFILE} add `,
    )}`,
  );

  return { location: profileDir, notes };
}

export const dshAdapter: AgentAdapter = {
  target: "dsh",
  mode: "install",
  runInstallInit: (scope, dryRun, initFlags) => runInit(scope, dryRun, initFlags),
};
