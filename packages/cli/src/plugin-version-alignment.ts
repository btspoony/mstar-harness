import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scope, Target } from "./types";
import { resolveProjectRoot } from "./utils";
import { compareSemver } from "./version-compare";
import { PLUGIN_NAME } from "./adapters/shared-install";
import { detectCodexPluginVersion } from "./adapters/codex";
import { DSH_HOME_ENV, DSH_HOME_SUBDIR, DSH_PROFILE, DSH_PROFILES_DIR } from "./adapters/dsh";
import { globalInstallPath as cursorGlobalInstallPath, projectInstallPath as cursorProjectInstallPath } from "./adapters/cursor";
import { findInstalledPlugin, listInstalledPlugins } from "./adapters/omp";

/**
 * plugin-version-alignment — one shared home for the CLI ↔ host-plugin
 * version-alignment check (plan 20260908-cli-plugin-version-alignment, batch 2).
 *
 * `mstar-harness doctor` prints exactly one informational alignment line for
 * the selected target: per-host discovery (`detectInstalledPluginVersion`)
 * finds the highest installed Morning Star plugin version, and
 * `formatPluginVersionDoctorNote` renders the four states (aligned / CLI
 * newer / plugin newer / not installed). The note is the same tier as the
 * CLI-on-PATH note: it goes to stdout as advice, never into `errors`, and
 * never changes the exit code.
 *
 * Per-host discovery is local-read-only (no network):
 *   - opencode: filesystem scan of the OpenCode package cache
 *     (`~/.cache/opencode/packages/@mstar-harness/<spec>/node_modules/@mstar-harness/opencode/package.json`,
 *     highest spec wins; no documented cache-dir env override, so the default
 *     root is hardcoded with an injectable parameter for tests);
 *   - cursor: tolerant manifest read (`.cursor-plugin/plugin.json` →
 *     `package.json`) at the scope-appropriate install path (path helpers
 *     re-used from the cursor adapter; project scope falls back to the global
 *     install when the project checkout is absent — the note is advisory and
 *     must not under-report a global-only install);
 *   - codex: `codex plugin list --json` installed entry for
 *     `morning-star-harness@mstar-repo` (subprocess + entry parser live in
 *     the codex adapter; parse-level tests cover the JSON layer);
 *   - omp: `omp plugin list --json` via the omp adapter's
 *     `listInstalledPlugins`/`findInstalledPlugin`; version = entry
 *     `version` → `manifest.version` → package.json at the entry path;
 *   - dsh: package.json read in the ONE profile the dsh adapter operates on
 *     (fixed default profile `web` under `$DSH_HOME`/`~/.dsh`; link installs
 *     resolve naturally by reading through the symlinked dir);
 *   - kimi: `$KIMI_CODE_HOME/plugins/managed/**` (default `~/.kimi-code`)
 *     scanned to depth 3 for a `morning-star-harness` plugin root; tolerant
 *     manifest read (`.kimi-plugin/plugin.json` → `plugin.json` →
 *     `package.json`);
 *   - zcode: cache scan moved here verbatim from the zcode adapter
 *     (`<cacheRoot>/<marketplace>/morning-star-harness/<version>/`).
 *
 * Every discoverer is no-throw: absent/unreadable installs report `null`
 * (the standard not-installed note). Multiple installs resolve to the
 * highest semver via the shared `compareSemver`.
 */

/** Reportable version shape: anchored `X.Y.Z` with optional `-prerelease`.
 * Moved from the zcode adapter (which only applied it to cache dirs) and now
 * used as the validity gate for every discovered version: discovery only
 * needs a stable `X.Y.Z[-pre]` shape for semver ordering, not release
 * validation (deliberately looser than the §9-strict `RELEASE_VERSION_RE`
 * release gate in `scripts/release-surfaces.ts`). */
const PLUGIN_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Highest-semver winner over shape-valid candidates. */
function highestVersion(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  if (current === null || compareSemver(candidate, current) > 0) return candidate;
  return current;
}

/** Shape-valid `version` string from one parsed JSON file, or `null`. */
function versionFromJsonFile(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string" && PLUGIN_VERSION_SHAPE_RE.test(version.trim())) return version.trim();
  } catch {
    // Malformed JSON: fall through to null.
  }
  return null;
}

/** First candidate manifest under `dir` carrying a shape-valid `version`. */
function readTolerantVersion(dir: string, manifestRelPaths: readonly string[]): string | null {
  for (const rel of manifestRelPaths) {
    const version = versionFromJsonFile(path.join(dir, rel));
    if (version !== null) return version;
  }
  return null;
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

function defaultOpencodePackagesRoot(): string {
  // No documented cache-dir override in the opencode source (not local);
  // hardcoded default + injectable root parameter for tests.
  return path.join(os.homedir(), ".cache", "opencode", "packages");
}

/** Highest installed `@mstar-harness/opencode` version across all cached
 * spec dirs (`<packagesRoot>/@mstar-harness/<spec>/node_modules/@mstar-harness/opencode/package.json`). */
export function detectOpencodePluginVersion(packagesRoot: string = defaultOpencodePackagesRoot()): string | null {
  let specs: fs.Dirent[];
  try {
    specs = fs.readdirSync(path.join(packagesRoot, "@mstar-harness"), { withFileTypes: true });
  } catch {
    return null;
  }
  let highest: string | null = null;
  for (const spec of specs) {
    if (!spec.isDirectory()) continue;
    const pkgJson = path.join(packagesRoot, "@mstar-harness", spec.name, "node_modules", "@mstar-harness", "opencode", "package.json");
    highest = highestVersion(highest, versionFromJsonFile(pkgJson));
  }
  return highest;
}

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

/** Manifest locations inside a cursor plugin checkout, in preference order. */
const CURSOR_MANIFEST_PATHS = [".cursor-plugin/plugin.json", "package.json"] as const;

/** Plugin version from a cursor install root (tolerant manifest read). */
export function detectCursorPluginVersion(pluginRoot: string): string | null {
  return readTolerantVersion(pluginRoot, CURSOR_MANIFEST_PATHS);
}

/** Scope-appropriate cursor discovery with a global fallback: project scope
 * prefers `<project>/.cursor/plugins/morning-star-harness`, but a global-only
 * install still must surface the CLI ↔ plugin comparison (the note is
 * advisory; scope purity must not turn drift into a false "not installed").
 * `paths` is injectable so tests never touch the real home/project root. */
export function detectCursorPluginVersionForScope(
  scope: Scope,
  paths?: { project?: string; global?: string },
): string | null {
  if (scope !== "global") {
    const projectVersion = detectCursorPluginVersion(paths?.project ?? cursorProjectInstallPath());
    if (projectVersion !== null) return projectVersion;
  }
  return detectCursorPluginVersion(paths?.global ?? cursorGlobalInstallPath());
}

// ---------------------------------------------------------------------------
// zcode (discovery moved verbatim from the zcode adapter)
// ---------------------------------------------------------------------------

const ZCODE_PLUGINS_CACHE_ROOT = path.join(os.homedir(), ".zcode", "cli", "plugins", "cache");
/** Manifest locations inside a zcode cache version dir, in preference order. */
const ZCODE_MANIFEST_PATHS = [".zcode-plugin/plugin.json", "plugin.json"] as const;

/** Manifest `version` from a zcode cache version dir, or `null` (caller falls
 * back to the directory name). */
function readZcodeManifestVersion(versionDir: string): string | null {
  return readTolerantVersion(versionDir, ZCODE_MANIFEST_PATHS);
}

/**
 * Highest installed Morning Star plugin version under the ZCode plugin cache
 * (`<cacheRoot>/<marketplace>/morning-star-harness/<version>/`, any
 * marketplace id). Manifest `version` field wins over the directory name;
 * multiple versions resolve to the highest semver. Absent or unreadable
 * installs report as `null` — the doctor alignment note stays informational,
 * never an error. `cacheRoot` is injectable so tests never touch the real
 * home directory.
 */
export function detectZcodePluginVersion(cacheRoot: string = ZCODE_PLUGINS_CACHE_ROOT): string | null {
  let marketplaceEntries: fs.Dirent[];
  try {
    marketplaceEntries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let highest: string | null = null;
  for (const marketplace of marketplaceEntries) {
    if (!marketplace.isDirectory()) continue;
    const pluginRoot = path.join(cacheRoot, marketplace.name, PLUGIN_NAME);
    let versionEntries: fs.Dirent[];
    try {
      versionEntries = fs.readdirSync(pluginRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) continue;
      const manifest = readZcodeManifestVersion(path.join(pluginRoot, versionEntry.name));
      const candidate = manifest ?? (PLUGIN_VERSION_SHAPE_RE.test(versionEntry.name) ? versionEntry.name : null);
      highest = highestVersion(highest, candidate);
    }
  }
  return highest;
}

// ---------------------------------------------------------------------------
// dsh
// ---------------------------------------------------------------------------

function defaultDshHome(): string {
  return process.env[DSH_HOME_ENV] ?? path.join(os.homedir(), DSH_HOME_SUBDIR);
}

/** Installed `@mstar-harness/dsh` version in the dsh profile the adapter
 * actually operates on — the fixed default profile `web` under `$DSH_HOME`,
 * else `~/.dsh`. Deliberately scoped to ONE profile (Greptile P1): the doctor
 * compares the CLI against what `mstar-harness init --target dsh` installs
 * and its update hint re-adds, so a version in an unrelated profile (e.g.
 * `headless`) must not win. Link installs resolve naturally: reading through
 * the symlinked dir lands on the target package manifest. */
export function detectDshPluginVersion(dshHome: string = defaultDshHome()): string | null {
  return versionFromJsonFile(
    path.join(dshHome, DSH_PROFILES_DIR, DSH_PROFILE, "node_modules", "@mstar-harness", "dsh", "package.json"),
  );
}

// ---------------------------------------------------------------------------
// kimi
// ---------------------------------------------------------------------------

const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";
const KIMI_PLUGINS_DIR = "plugins";
const KIMI_MANAGED_DIR = "managed";
/** Managed plugin roots sit at most this many directory levels below
 * `plugins/managed` (documented `$KIMI_CODE_HOME/plugins/managed/**` layout). */
const KIMI_SCAN_DEPTH = 3;
/** Tolerant manifest locations inside a kimi managed plugin root. */
const KIMI_MANIFEST_PATHS = [".kimi-plugin/plugin.json", "plugin.json", "package.json"] as const;

function defaultKimiCodeHome(): string {
  return process.env[KIMI_CODE_HOME_ENV] ?? path.join(os.homedir(), ".kimi-code");
}

/** The kimi managed-plugins root (`$KIMI_CODE_HOME/plugins/managed`). Shared
 * by the kimi adapter (doctor location) and discovery. */
export function kimiManagedRoot(kimiCodeHome: string = defaultKimiCodeHome()): string {
  return path.join(kimiCodeHome, KIMI_PLUGINS_DIR, KIMI_MANAGED_DIR);
}

/** Directories (recursive, depth-bounded) under `root`; unreadable branches
 * are skipped silently (discovery is no-throw). */
function listDirsToDepth(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      out.push(child);
      if (depth + 1 < maxDepth) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

/** Morning Star plugin version under `$KIMI_CODE_HOME/plugins/managed`:
 * scan to depth 3 for a `morning-star-harness` plugin root, tolerant manifest
 * read, highest semver wins. Not installed → `null`. */
export function detectKimiPluginVersion(kimiCodeHome: string = defaultKimiCodeHome()): string | null {
  const managedRoot = kimiManagedRoot(kimiCodeHome);
  let highest: string | null = null;
  for (const dir of listDirsToDepth(managedRoot, KIMI_SCAN_DEPTH)) {
    if (path.basename(dir) !== PLUGIN_NAME) continue;
    highest = highestVersion(highest, readTolerantVersion(dir, KIMI_MANIFEST_PATHS));
  }
  return highest;
}

// ---------------------------------------------------------------------------
// omp + codex (delegated to the adapters that own the subprocess surface)
// ---------------------------------------------------------------------------

/** Version precedence for one `omp plugin list` entry: entry `version` →
 * `manifest.version` → package.json at the entry path (pure — exported for
 * parse-level tests; no omp subprocess). */
export function ompEntryVersion(entry: Record<string, unknown>): string | null {
  const direct = typeof entry.version === "string" ? entry.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(direct)) return direct;
  const manifest = entry.manifest && typeof entry.manifest === "object" ? (entry.manifest as Record<string, unknown>) : null;
  const manifestVersion = typeof manifest?.version === "string" ? manifest.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(manifestVersion)) return manifestVersion;
  const entryPath = typeof entry.path === "string" ? entry.path : "";
  if (entryPath === "") return null;
  return versionFromJsonFile(path.join(entryPath, "package.json"));
}

/** Morning Star plugin version from `omp plugin list --json` (adapter-owned
 * subprocess + entry matching). */
export function detectOmpPluginVersion(): string | null {
  const entry = findInstalledPlugin(listInstalledPlugins());
  if (!entry) return null;
  return ompEntryVersion(entry);
}

/** Dispatcher: per-target installed Morning Star plugin version (see module
 * doc for per-host sources). Result is shape-gated in one place; `null` when
 * absent, unreadable, or shape-invalid (standard not-installed note). */
export function detectInstalledPluginVersion(target: Target, scope: Scope = "project"): string | null {
  let discovered: string | null;
  switch (target) {
    case "opencode":
      discovered = detectOpencodePluginVersion();
      break;
    case "cursor":
      discovered = detectCursorPluginVersionForScope(scope);
      break;
    case "codex":
      discovered = detectCodexPluginVersion();
      break;
    case "zcode":
      discovered = detectZcodePluginVersion();
      break;
    case "omp":
      discovered = detectOmpPluginVersion();
      break;
    case "dsh":
      discovered = detectDshPluginVersion();
      break;
    case "kimi":
      discovered = detectKimiPluginVersion();
      break;
    default:
      // No-throw contract (QC F-007): an out-of-contract target must not
      // surface as a TypeError from doctor — it degrades to `null`, so the
      // caller prints the target's standard not-installed line.
      discovered = null;
      break;
  }
  if (discovered === null) return null;
  const version = discovered.trim();
  return PLUGIN_VERSION_SHAPE_RE.test(version) ? version : null;
}

// ---------------------------------------------------------------------------
// Note builder
// ---------------------------------------------------------------------------

/** Per-host plugin-update hint for the CLI-newer state (full sentence tail).
 * codex shapes verified against `codex plugin --help` (2026-09-08): there is
 * no `codex plugin upgrade` — refresh the marketplace snapshot, then add the
 * plugin again. */
const PLUGIN_UPDATE_HINTS: Record<Target, string> = {
  opencode: "update the Morning Star plugin (@mstar-harness/opencode) and restart OpenCode.",
  cursor: "update the Morning Star plugin checkout (git pull, or re-run mstar-harness init --target cursor).",
  codex: "update the Morning Star plugin: codex plugin marketplace upgrade, then codex plugin add morning-star-harness@mstar-repo.",
  zcode: "update the Morning Star plugin in ZCode (Settings \u2192 Plugin Management \u2192 update from the mstar-local marketplace).",
  omp: "update the Morning Star plugin: omp plugin install @mstar-harness/omp.",
  dsh: "update the Morning Star plugin: re-run mstar-harness init --target dsh (re-adds @mstar-harness/dsh in the web profile).",
  kimi: "update the Morning Star plugin via the Kimi TUI: /plugins install.",
};

/** Per-host not-installed note (install hint, no drift direction implied). */
const NOT_INSTALLED_NOTES: Record<Target, string> = {
  opencode: "No installed Morning Star plugin found under ~/.cache/opencode/packages/ (run mstar-harness init --target opencode to add @mstar-harness/opencode).",
  cursor: "No installed Morning Star plugin found under ~/.cursor/plugins/ (run mstar-harness init --target cursor).",
  codex: "No installed Morning Star plugin found in `codex plugin list` (install: codex plugin add morning-star-harness@mstar-repo).",
  zcode: "No installed Morning Star plugin found under ~/.zcode/cli/plugins/cache/ (install from the mstar-local marketplace).",
  omp: "No installed Morning Star plugin found in `omp plugin list` (install: omp plugin install @mstar-harness/omp).",
  dsh: "No installed Morning Star plugin found under ~/.dsh/profiles/ (run mstar-harness init --target dsh to add @mstar-harness/dsh).",
  kimi: "No installed Morning Star plugin found under $KIMI_CODE_HOME/plugins/managed (install via the Kimi TUI: /plugins install).",
};

/**
 * The single doctor alignment line comparing the running CLI version with
 * the installed plugin version for `target`. Informational only: callers
 * print it — never add it to `errors`, never let it affect the exit code.
 * Four states: aligned, CLI newer (per-host plugin update hint), plugin
 * newer (update the global CLI), nothing installed (install hint only).
 */
export function formatPluginVersionDoctorNote(target: Target, cliVersion: string, installed: string | null): string {
  if (installed === null) {
    return NOT_INSTALLED_NOTES[target];
  }
  const diff = compareSemver(cliVersion, installed);
  if (diff === 0) return `Plugin/CLI versions aligned (${installed}).`;
  if (diff > 0) {
    return `CLI ${cliVersion} is newer than installed plugin ${installed} \u2014 ${PLUGIN_UPDATE_HINTS[target]}`;
  }
  return `Installed plugin ${installed} is newer than CLI ${cliVersion} \u2014 update the global CLI: npm i -g @mstar-harness/cli@latest (or @${installed}).`;
}
