import os from "node:os";
import path from "node:path";
import type { Scope, Target } from "./types";
import {
  detectCursorPluginVersion,
  detectCursorPluginVersionForScope,
  detectDshPluginVersion,
  detectKimiPluginVersion,
  detectOpencodePluginVersion,
  detectZcodePluginVersion,
  findInstalledPlugin,
  formatPluginVersionDoctorNote,
  isMorningStarPluginEntry,
  ompEntryVersion,
  PLUGIN_VERSION_SHAPE_RE,
  globalInstallPath as cursorGlobalInstallPath,
  projectInstallPath as cursorProjectInstallPath,
} from "@mstar-harness/commands";
import { DSH_HOME_ENV, DSH_HOME_SUBDIR } from "./adapters/dsh";
import { detectCodexPluginVersion } from "./adapters/codex";
import { listInstalledPlugins } from "./adapters/omp";
import { resolveProjectRoot } from "./utils";

/**
 * The Morning Star entries whose install location matches the requested
 * scope. Project-scoped omp installs live under `<project>/.omp/plugins/`;
 * a global install lives under the user's own omp root. An entry with no
 * usable `path` cannot be scoped, so it is never selected by scope — but it
 * survives as a fallback candidate when no scoped entry exists. Comparison
 * is lexical (`path.resolve`), which is sufficient for an informational
 * note; the wrong-scope entries are dropped, never mis-selected.
 */
function ompEntriesInScope(
  plugins: Array<Record<string, unknown>>,
  scope: Scope,
  projectRoot: string | undefined,
): Array<Record<string, unknown>> {
  if (projectRoot === undefined) return plugins;
  const projectPluginsPrefix = path.join(path.resolve(projectRoot), ".omp", "plugins") + path.sep;
  const inScope: Array<Record<string, unknown>> = [];
  const unscoped: Array<Record<string, unknown>> = [];
  for (const entry of plugins) {
    const entryPath = typeof entry.path === "string" ? entry.path : "";
    if (entryPath === "") {
      unscoped.push(entry);
      continue;
    }
    const inProject = path.resolve(entryPath).startsWith(projectPluginsPrefix);
    if (scope === "project" ? inProject : !inProject) inScope.push(entry);
  }
  return [...inScope, ...unscoped];
}

function detectOmpPluginVersion(
  scope: Scope,
  plugins: Array<Record<string, unknown>> = listInstalledPlugins(),
  projectRoot: string | undefined = resolveProjectRoot(),
): string | null {
  // The requested scope decides WHICH install the note describes: an older
  // global entry must not recommend an update while the project-scoped plugin
  // is current (greptile P2). When NO entry matches the requested scope, the
  // previous first-match behavior stands unchanged.
  const morningStar = plugins.filter(isMorningStarPluginEntry);
  const scoped = ompEntriesInScope(morningStar, scope, projectRoot);
  const candidates = scoped.length > 0 ? scoped : morningStar;
  const entry = candidates[0];
  return entry ? ompEntryVersion(entry) : null;
}
export { detectOmpPluginVersion };

/** Preserve CLI-owned subprocess discovery while sharing all read-only host helpers. */
export function detectInstalledPluginVersion(target: Target, scope: Scope = "project"): string | null {
  let discovered: string | null;
  switch (target) {
    case "opencode":
      discovered = detectOpencodePluginVersion();
      break;
    case "cursor":
      discovered = detectCursorPluginVersionForScope(scope, {
        project: cursorProjectInstallPath(),
        global: cursorGlobalInstallPath(),
      });
      break;
    case "codex":
      discovered = detectCodexPluginVersion();
      break;
    case "zcode":
      discovered = detectZcodePluginVersion();
      break;
    case "omp":
      discovered = detectOmpPluginVersion(scope);
      break;
    case "dsh":
      discovered = detectDshPluginVersion(process.env[DSH_HOME_ENV] ?? path.join(os.homedir(), DSH_HOME_SUBDIR));
      break;
    case "kimi":
      discovered = detectKimiPluginVersion();
      break;
    default:
      discovered = null;
      break;
  }
  if (discovered === null) return null;
  const version = discovered.trim();
  return PLUGIN_VERSION_SHAPE_RE.test(version) ? version : null;
}

export {
  detectCursorPluginVersion,
  detectCursorPluginVersionForScope,
  detectDshPluginVersion,
  detectKimiPluginVersion,
  detectOpencodePluginVersion,
  detectZcodePluginVersion,
  findInstalledPlugin,
  formatPluginVersionDoctorNote,
  ompEntryVersion,
};
