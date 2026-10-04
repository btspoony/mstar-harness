import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAMES: Record<string, true> = {
  "morning-star": true,
  "morning-star-harness": true,
  "github:btspoony/mstar-harness": true,
  "@mstar-harness/omp": true,
};
const SKILL_SMOKE = ["mstar-host", "mstar-harness-core", "pm"];
const COMMAND_SMOKE = ["iteration-start", "iteration-drive", "iteration-loop", "codebase-audit"];

/** Parse `omp plugin list --json` output into flat npm + marketplace records. */
export function parseOmpPluginList(raw: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
  if (parsed && typeof parsed === "object") {
    const record = parsed as { plugins?: unknown; npm?: unknown; marketplace?: unknown };
    if (Array.isArray(record.plugins)) return record.plugins as Array<Record<string, unknown>>;
    const entries: Array<Record<string, unknown>> = [];
    for (const key of ["npm", "marketplace"] as const) {
      const group = record[key];
      if (Array.isArray(group)) {
        for (const item of group) {
          if (item && typeof item === "object") entries.push(item as Record<string, unknown>);
        }
      }
    }
    if (entries.length > 0) return entries;
  }
  return [];
}

/** Whether one `omp plugin list` entry is a Morning Star plugin record. */
export function isMorningStarPluginEntry(entry: Record<string, unknown>): boolean {
  const name = typeof entry.name === "string" ? entry.name : "";
  const pathValue = typeof entry.path === "string" ? entry.path : "";
  const manifest = entry.manifest && typeof entry.manifest === "object"
    ? entry.manifest as Record<string, unknown>
    : null;
  const manifestName = typeof manifest?.name === "string" ? manifest.name : "";
  if (Object.hasOwn(PACKAGE_NAMES, name) || Object.hasOwn(PACKAGE_NAMES, manifestName)) return true;
  if (name.includes("morning-star") || manifestName.includes("morning-star")) return true;
  return pathValue.includes("mstar-harness") || pathValue.includes(`${path.sep}morning-star`);
}

/** Find the installed Morning Star plugin in an omp plugin-list response. */
export function findInstalledPlugin(plugins: Array<Record<string, unknown>>) {
  return plugins.find(isMorningStarPluginEntry);
}

function validatePluginTree(pluginRoot: string): string[] {
  const errors: string[] = [];
  const markerPath = path.join(pluginRoot, "plugin.json");
  if (!fs.existsSync(markerPath)) errors.push(`Missing omp plugin marker: ${markerPath}`);
  for (const skill of SKILL_SMOKE) {
    const skillPath = path.join(pluginRoot, "skills", skill, "SKILL.md");
    if (!fs.existsSync(skillPath)) errors.push(`Missing skill: ${skillPath}`);
  }
  for (const command of COMMAND_SMOKE) {
    const commandPath = path.join(pluginRoot, "commands", `${command}.md`);
    if (!fs.existsSync(commandPath)) errors.push(`Missing command: ${commandPath}`);
  }
  const hostRef = path.join(pluginRoot, "skills", "mstar-host", "references", "omp.md");
  if (!fs.existsSync(hostRef)) errors.push(`Missing omp host reference: ${hostRef}`);
  return errors;
}

export type OmpDoctorInput = {
  harnessRepoPath: string;
  scope: "global" | "project";
  ompAvailable: boolean;
  installedPlugins: Array<Record<string, unknown>>;
  localHarnessRepoErrors: string[];
  missingGitignoreEntries: string[];
};

/** Assemble read-only omp doctor findings from host artifacts and CLI probe results. */
export function diagnoseOmpHost(input: OmpDoctorInput): { location: string; errors: string[] } {
  const errors = [...input.localHarnessRepoErrors];
  errors.push(...validatePluginTree(path.join(input.harnessRepoPath, "packages", "omp")));

  if (!input.ompAvailable) {
    errors.push("omp CLI not found on PATH (required for omp target doctor checks).");
  } else {
    const installed = findInstalledPlugin(input.installedPlugins);
    if (!installed) {
      errors.push(
        `Morning Star plugin not found in \`omp plugin list\` (expected one of: ${Object.keys(PACKAGE_NAMES).join(", ")}). Run: mstar-harness init --target omp --scope ${input.scope}`,
      );
    } else if (installed.enabled === false) {
      errors.push(`Morning Star omp plugin is installed but disabled (${String(installed.name)}).`);
    }
  }

  for (const entry of input.missingGitignoreEntries) errors.push(`Missing .gitignore entry: ${entry}`);
  return { location: input.harnessRepoPath, errors };
}
