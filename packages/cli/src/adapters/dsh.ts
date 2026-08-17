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

/** Subprocess timeouts (ms). The `add` call forwards to pnpm over the
 * network, so it gets a conservative ceiling: a stalled registry must
 * surface as an error instead of hanging the CLI without output. Local
 * probe calls (`--version`, `--dump-config`) are bounded tighter. The add
 * timeout is overridable via `MSTAR_DSH_SUBPROCESS_TIMEOUT_MS` (mirrors the
 * engine's MSTAR_GIT_PROBE_TIMEOUT_MS convention; tests shrink it to
 * exercise the kill path). */
const DSH_LOCAL_TIMEOUT_MS = 10_000;
const DSH_ADD_TIMEOUT_MS = 300_000;
const DSH_ADD_TIMEOUT_ENV = "MSTAR_DSH_SUBPROCESS_TIMEOUT_MS";

/** Add-path timeout: env override wins, else the conservative default. */
function addTimeoutMs(): number {
  const raw = process.env[DSH_ADD_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DSH_ADD_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DSH_ADD_TIMEOUT_MS;
}

/** Install order is the F4 double-command contract: mstar first, fallbacks
 * second (reconcile append order — the fallbacks row lands after the
 * dsh-base/llm-retry layers). The lines are never folded into any patch.
 * Default profile is fixed to `web` (dsh-tui not verified); centralized so a
 * future profile flag changes exactly one place. */
const DSH_PLUGIN_SPECS: readonly string[] = ["@mstar-harness/dsh", "dsh-llm-fallbacks"];
const DSH_FALLBACKS_SPEC = DSH_PLUGIN_SPECS[1];

const DSH_INSTALL_HINT =
  "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.";

/** Run dsh with args; dry-run never spawns a subprocess (preview only).
 * `timeoutMs` bounds the child so a hung dsh/pnpm surfaces as an error
 * instead of blocking the CLI forever. */
function runDsh(args: string[], dryRun: boolean, timeoutMs: number): string {
  if (dryRun) return "";
  // Explicit `env` snapshot: Bun resolves the command against the env's PATH
  // only when `env` is passed (otherwise it uses the startup PATH), which is
  // what lets tests inject a fake dsh via PATH.
  return execFileSync(DSH_BIN, args, {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
  });
}

function dshAvailable(): boolean {
  try {
    runDsh(["--version"], false, DSH_LOCAL_TIMEOUT_MS);
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

/** One loader entry from a `--dump-config` dump. `enabled` is false when the
 * entry carries a literal `disabled: true` or `enabled: false` marker: as a
 * standalone 2-space line (the real shapes observed on dsh 0.1.0-rc.6 — the
 * patch-applied `enabled: false` row and the built-in `disabled: true` row)
 * or inline on the `- id:` / `name:` line. `!!js` expressions (e.g.
 * `disabled: !!js process.platform === 'win32'`) are not statically
 * decidable and count as enabled. */
type LoaderEntry = { name: string; enabled: boolean };

/** Literal disable markers that make a loader row statically disabled. */
const DISABLED_MARKERS = /\b(?:disabled: true|enabled: false)\b/;

/** Parse loader entries from a `dsh --profile <name> --dump-config` dump: a
 * flat list of `- id: <id>` entries, each carrying a `name: <spec>` line plus
 * optional keys at the same 2-space indent. Returns null when the dump is
 * non-empty but yields no named entry (or an entry without a `name:` line) —
 * format drift — so callers degrade loudly instead of misreporting the
 * installed state. */
function parseLoaderEntries(dump: string): LoaderEntry[] | null {
  const entries: LoaderEntry[] = [];
  let current: LoaderEntry | null = null;
  for (const line of dump.split("\n")) {
    if (/^- id: /.test(line)) {
      if (current) entries.push(current);
      current = { name: "", enabled: !DISABLED_MARKERS.test(line) };
    } else if (current) {
      const nameMatch = /^  name: (.+)$/.exec(line);
      if (nameMatch) {
        let name = nameMatch[1].trim();
        if (DISABLED_MARKERS.test(line)) {
          current.enabled = false;
          // Inline marker on the name line (drift shape): strip a trailing
          // `, disabled: true` / ` disabled: true` suffix before quote
          // removal so the row still matches its spec.
          name = name.replace(/\s*,?\s*(?:disabled: true|enabled: false)\s*$/, "");
        }
        current.name = name.replace(/^['"]|['"]$/g, "");
      } else if (/^  disabled: true$/.test(line) || /^  enabled: false$/.test(line)) {
        current.enabled = false;
      } else if (line.trim() !== "" && !line.startsWith("  ")) {
        // Top-level line outside the entry block: close the current entry.
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) entries.push(current);
  if (dump.trim() !== "" && (entries.length === 0 || entries.some((entry) => !entry.name))) {
    return null;
  }
  return entries;
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
  //
  // Dry-run is a pure preview contract (PM ruling on T1 review M1/M2): it
  // never probes installed state, never fails on a missing bin, and always
  // previews the full add list — the output is identical regardless of the
  // machine's install state. (Task 3 documents this.)
  if (!dryRun && !dshAvailable()) {
    throw new Error(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
  }

  // Probe installed state from the composed loader tree: same binary, same
  // home resolution as `add`, so the probe can never disagree with install.
  const installed = new Set<string>();
  if (!dryRun) {
    try {
      const entries = parseLoaderEntries(
        runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG], dryRun, DSH_LOCAL_TIMEOUT_MS),
      );
      if (entries === null) {
        // Format drift in the dump: degrade loudly instead of misreporting
        // everything as uninstalled. Duplicate `add` is a pinned no-op
        // (probe 2026-08-17), so the install stays idempotent.
        notes.push("Warning: could not parse installed plugins from dump (unexpected format); proceeding with add (idempotent).");
      } else {
        for (const entry of entries) installed.add(entry.name);
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
      runDsh(addArgs, dryRun, addTimeoutMs());
      notes.push(`installed: ${spec} (${DSH_BIN} ${addArgs.join(" ")})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install ${spec} via ${DSH_BIN}: ${message}`);
    }
  }

  notes.push(`Profile: ${DSH_PROFILE} at ${profileDir}`);
  notes.push("Verify with: mstar-harness doctor --target dsh");
  notes.push(
    `Alternate manual install: ${DSH_BIN} plugin ${DSH_PROFILE_FLAG} ${DSH_PROFILE} add ${DSH_PLUGIN_SPECS.join(
      ` && ${DSH_BIN} plugin ${DSH_PROFILE_FLAG} ${DSH_PROFILE} add `,
    )}`,
  );

  return { location: profileDir, notes };
}

/** Doctor for the dsh install surface: reports each plugin row's capability
 * state with the AC-2 words `uninstalled` / `disabled` / `mounted`
 * (`mounted` = loader row present and not disabled; doctor probes the
 * install surface, it does not boot a live fiber). Issue states
 * (uninstalled/disabled) go to `errors` (the CLI exits 1); every state also
 * gets a worded `notes` line so `mounted` is visible on a healthy run —
 * never implied only by exit code 0. An unusable probe degrades into an
 * explicit error line instead of a silent pass. `scope` is accepted for the
 * shared AgentAdapter contract but has no dsh surface (machine-global
 * profiles), mirroring runInit. */
function runDoctor(scope: Scope): { location: string; errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const profileDir = resolveProfileDir();

  if (!dshAvailable()) {
    errors.push(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
    return { location: profileDir, errors, notes };
  }

  let dump: string;
  try {
    dump = runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG], false, DSH_LOCAL_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Warning: could not probe installed plugins (${message}); cannot verify install state.`);
    return { location: profileDir, errors, notes };
  }

  const entries = parseLoaderEntries(dump);
  if (entries === null) {
    errors.push("Warning: could not parse installed plugins from dump (unexpected format); cannot verify install state.");
    return { location: profileDir, errors, notes };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const spec of DSH_PLUGIN_SPECS) {
    const entry = byName.get(spec);
    const state = !entry ? "uninstalled" : entry.enabled ? "mounted" : "disabled";
    notes.push(`${spec}: ${state}`);
    if (state === "mounted") continue;
    const hint =
      state === "uninstalled"
        ? "Run: mstar-harness init --target dsh"
        : "Enable it (e.g. remove the disable entry from cordis.patch.yml) and re-run doctor.";
    errors.push(`${spec} is ${state}. ${hint}`);
  }
  return { location: profileDir, errors, notes };
}

export const dshAdapter: AgentAdapter = {
  target: "dsh",
  mode: "install",
  runInstallInit: (scope, dryRun, initFlags) => runInit(scope, dryRun, initFlags),
  runInstallDoctor: (scope) => runDoctor(scope),
};
