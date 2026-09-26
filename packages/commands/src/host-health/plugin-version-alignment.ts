import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemver } from "./version-compare.js";
import { resolveProjectRoot } from "./paths.js";


export type HostTarget = "opencode" | "cursor" | "codex" | "zcode" | "omp" | "dsh" | "kimi";
export type HostScope = "global" | "project";
export const PLUGIN_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_NAME = "morning-star-harness";

function highestVersion(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  if (current === null || compareSemver(candidate, current) > 0) return candidate;
  return current;
}

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
    // Malformed JSON is an absent candidate.
  }
  return null;
}

function readTolerantVersion(dir: string, manifestRelPaths: readonly string[]): string | null {
  for (const rel of manifestRelPaths) {
    const version = versionFromJsonFile(path.join(dir, rel));
    if (version !== null) return version;
  }
  return null;
}

export function detectOpencodePluginVersion(packagesRoot: string = path.join(os.homedir(), ".cache", "opencode", "packages")): string | null {
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

export function detectCursorPluginVersion(pluginRoot: string): string | null {
  return readTolerantVersion(pluginRoot, [".cursor-plugin/plugin.json", "package.json"]);
}

export function detectCursorPluginVersionForScope(
  scope: HostScope,
  paths?: { project?: string; global?: string },
): string | null {
  if (scope !== "global") {
    const project = paths?.project ?? path.join(resolveProjectRoot(), ".cursor", "plugins", "morning-star-harness");
    const projectVersion = detectCursorPluginVersion(project);
    if (projectVersion !== null) return projectVersion;
  }
  const global = paths?.global ?? path.join(os.homedir(), ".cursor", "plugins", "local", "morning-star-harness");
  return detectCursorPluginVersion(global);
}

export function detectZcodePluginVersion(cacheRoot: string = path.join(os.homedir(), ".zcode", "cli", "plugins", "cache")): string | null {
  let marketplaces: fs.Dirent[];
  try {
    marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let highest: string | null = null;
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const pluginRoot = path.join(cacheRoot, marketplace.name, PLUGIN_NAME);
    let versions: fs.Dirent[];
    try {
      versions = fs.readdirSync(pluginRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const root = path.join(pluginRoot, version.name);
      const candidate = readTolerantVersion(root, [".zcode-plugin/plugin.json", "plugin.json"]) ??
        (PLUGIN_VERSION_SHAPE_RE.test(version.name) ? version.name : null);
      highest = highestVersion(highest, candidate);
    }
  }
  return highest;
}

export function detectDshPluginVersion(dshHome: string = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")): string | null {
  return versionFromJsonFile(path.join(dshHome, "profiles", "web", "node_modules", "@mstar-harness", "dsh", "package.json"));
}

export function kimiManagedRoot(kimiCodeHome: string = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code")): string {
  return path.join(kimiCodeHome, "plugins", "managed");
}

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

export function detectKimiPluginVersion(kimiCodeHome: string = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code")): string | null {
  let highest: string | null = null;
  for (const dir of listDirsToDepth(kimiManagedRoot(kimiCodeHome), 3)) {
    if (path.basename(dir) !== PLUGIN_NAME) continue;
    highest = highestVersion(highest, readTolerantVersion(dir, [".kimi-plugin/plugin.json", "plugin.json", "package.json"]));
  }
  return highest;
}

/** Version precedence for one parsed `omp plugin list` entry; no subprocess. */
export function ompEntryVersion(entry: Record<string, unknown>): string | null {
  const direct = typeof entry.version === "string" ? entry.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(direct)) return direct;
  const manifest = entry.manifest && typeof entry.manifest === "object" ? entry.manifest as Record<string, unknown> : null;
  const manifestVersion = typeof manifest?.version === "string" ? manifest.version.trim() : "";
  if (PLUGIN_VERSION_SHAPE_RE.test(manifestVersion)) return manifestVersion;
  const entryPath = typeof entry.path === "string" ? entry.path : "";
  if (!entryPath) return null;
  return versionFromJsonFile(path.join(entryPath, "package.json"));
}

const PLUGIN_UPDATE_HINTS: Record<HostTarget, string> = {
  opencode: "update the Morning Star plugin (@mstar-harness/opencode) and restart OpenCode.",
  cursor: "update the Morning Star plugin checkout (git pull, or re-run mstar-harness init --target cursor).",
  codex: "update the Morning Star plugin: codex plugin marketplace upgrade, then codex plugin add morning-star-harness@mstar-repo.",
  zcode: "update the Morning Star plugin in ZCode (Settings → Plugin Management → update from the mstar-local marketplace).",
  omp: "update the Morning Star plugin: omp plugin install @mstar-harness/omp.",
  dsh: "update the Morning Star plugin: re-run mstar-harness init --target dsh (re-adds @mstar-harness/dsh in the web profile).",
  kimi: "update the Morning Star plugin via the Kimi TUI: /plugins install.",
};
const NOT_INSTALLED_NOTES: Record<HostTarget, string> = {
  opencode: "No installed Morning Star plugin found under ~/.cache/opencode/packages/ (run mstar-harness init --target opencode to add @mstar-harness/opencode).",
  cursor: "No installed Morning Star plugin found under ~/.cursor/plugins/ (run mstar-harness init --target cursor).",
  codex: "No installed Morning Star plugin found in `codex plugin list` (install: codex plugin add morning-star-harness@mstar-repo).",
  zcode: "No installed Morning Star plugin found under ~/.zcode/cli/plugins/cache/ (install from the mstar-local marketplace).",
  omp: "No installed Morning Star plugin found in `omp plugin list` (install: omp plugin install @mstar-harness/omp).",
  dsh: "No installed Morning Star plugin found under ~/.dsh/profiles/ (run mstar-harness init --target dsh to add @mstar-harness/dsh).",
  kimi: "No installed Morning Star plugin found under $KIMI_CODE_HOME/plugins/managed (install via the Kimi TUI: /plugins install).",
};

export function formatPluginVersionDoctorNote(target: HostTarget, cliVersion: string, installed: string | null): string {
  if (installed === null) return NOT_INSTALLED_NOTES[target];
  const diff = compareSemver(cliVersion, installed);
  if (diff === 0) return `Plugin/CLI versions aligned (${installed}).`;
  if (diff > 0) return `CLI ${cliVersion} is newer than installed plugin ${installed} — ${PLUGIN_UPDATE_HINTS[target]}`;
  return `Installed plugin ${installed} is newer than CLI ${cliVersion} — update the global CLI: npm i -g @mstar-harness/cli@latest (or @${installed}).`;
}
