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
  formatPluginVersionDoctorNote,
  ompEntryVersion,
  PLUGIN_VERSION_SHAPE_RE,
  globalInstallPath as cursorGlobalInstallPath,
  projectInstallPath as cursorProjectInstallPath,
  findInstalledPlugin,
} from "@mstar-harness/commands";
import { DSH_HOME_ENV, DSH_HOME_SUBDIR } from "./adapters/dsh";
import { detectCodexPluginVersion } from "./adapters/codex";
import { listInstalledPlugins } from "./adapters/omp";

function detectOmpPluginVersion(): string | null {
  const entry = findInstalledPlugin(listInstalledPlugins());
  return entry ? ompEntryVersion(entry) : null;
}

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
      discovered = detectOmpPluginVersion();
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
  formatPluginVersionDoctorNote,
  ompEntryVersion,
};
