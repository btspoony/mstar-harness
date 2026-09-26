import {
  DSH_BIN,
  DSH_DUMP_FLAG,
  DSH_FALLBACKS_LOADER_NAME,
  DSH_FALLBACKS_SPEC,
  DSH_HOME_ENV,
  DSH_HOME_SUBDIR,
  DSH_INSTALL_HINT,
  DSH_PLUGIN_SPECS,
  DSH_PROFILE,
  DSH_PROFILE_FLAG,
  DSH_PROFILES_DIR,
  diagnoseDshHost,
  dshLoaderName,
  fallbacksVersionDrifted,
  isDshAvailable,
  parseDshLoaderEntries,
  resolveDshProfileDir,
} from "@mstar-harness/commands";
import { runCliCommand } from "../exec";
import type { AgentAdapter, InstallInitFlags, Scope } from "../types";

export { DSH_FALLBACKS_LOADER_NAME, DSH_HOME_ENV, DSH_HOME_SUBDIR, DSH_PROFILE, DSH_PROFILES_DIR };

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
// Read-only discovery, dump parsing, and doctor assembly live in
// `@mstar-harness/commands` host-health. This adapter keeps the subprocess
// boundary and the `plugin add` writes.

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

/** Run dsh with args; dry-run never spawns a subprocess (preview only).
 * `timeoutMs` bounds the child so a hung dsh/pnpm surfaces as an error
 * instead of blocking the CLI forever. `env: process.env` is required —
 * dsh is resolved from PATH (Bun does not inherit the ambient env into
 * execFileSync by default); dropping it breaks dsh discovery. */
function runDsh(args: string[], dryRun: boolean, timeoutMs: number): string {
  return runCliCommand([DSH_BIN, ...args], { dryRun, timeoutMs, env: process.env });
}

/** Install orchestration for the dsh target. `scope` is accepted for the
 * shared AgentAdapter contract but has no dsh surface: dsh profiles live
 * machine-globally under $DSH_HOME/profiles, so the flow is identical for
 * global and project scopes. */
function runInit(scope: Scope, dryRun: boolean, initFlags?: InstallInitFlags) {
  const notes: string[] = [];
  const profileDir = resolveDshProfileDir();

  // Fail-loud when the dsh bin is absent: without it there is nothing an
  // init can complete (deliberate divergence from omp's note-and-continue,
  // whose local repo clone/link side effects still make progress).
  //
  // Dry-run is a pure preview contract (PM ruling on T1 review M1/M2): it
  // never probes installed state, never fails on a missing bin, and always
  // previews the full add list — the output is identical regardless of the
  // machine's install state. (Task 3 documents this.)
  if (!dryRun && !isDshAvailable(() => runDsh(["--version"], false, DSH_LOCAL_TIMEOUT_MS))) {
    throw new Error(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
  }

  // Probe installed state from the composed loader tree: same binary, same
  // home resolution as `add`, so the probe can never disagree with install.
  const installed = new Set<string>();
  const disabledLoaderNames = new Set<string>();
  if (!dryRun) {
    try {
      const entries = parseDshLoaderEntries(
        runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG], dryRun, DSH_LOCAL_TIMEOUT_MS),
      );
      if (entries === null) {
        // Format drift in the dump: degrade loudly instead of misreporting
        // everything as uninstalled. Duplicate `add` is a pinned no-op
        // (probe 2026-08-17), so the install stays idempotent.
        notes.push("Warning: could not parse installed plugins from dump (unexpected format); proceeding with add (idempotent).");
      } else {
        for (const entry of entries) {
          installed.add(entry.name);
          if (!entry.enabled) disabledLoaderNames.add(entry.name);
        }
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
    if (!dryRun && (installed.has(spec) || installed.has(dshLoaderName(spec)))) {
      const isFallbacks = spec === DSH_FALLBACKS_SPEC;
      const disabledRow = disabledLoaderNames.has(spec) || disabledLoaderNames.has(dshLoaderName(spec));
      // The enclosing condition already proved this spec's row is present, so
      // drift is the only reason to fall through to the versioned re-add.
      const needsVersionAlign = isFallbacks && fallbacksVersionDrifted(profileDir) && !disabledRow;
      if (!needsVersionAlign) {
        notes.push(`skipped-existing: ${spec} (already installed in profile ${DSH_PROFILE})`);
        continue;
      }
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

function runDoctor(scope: Scope): { location: string; errors: string[]; notes: string[] } {
  void scope;
  return diagnoseDshHost((args) => runDsh(args, false, DSH_LOCAL_TIMEOUT_MS));
}

export const dshAdapter: AgentAdapter = {
  target: "dsh",
  mode: "install",
  runInstallInit: (scope, dryRun, initFlags) => runInit(scope, dryRun, initFlags),
  runInstallDoctor: (scope) => runDoctor(scope),
};
