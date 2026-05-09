import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ALL_ROLES } from "../constants";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, normalizeModelList, resolveProjectRoot } from "../utils";

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
const MSTAR_OPENCODE_PLUGIN = "@mstar-harness/opencode@latest";

/**
 * Historical git-based `morning-star@git+…` plugin lines for this harness repo.
 * Covers https / ssh / scp-style URLs, with or without `.git`, optional #fragment.
 */
function isLegacyMorningStarGitPlugin(plugin: string): boolean {
  const raw = plugin.trim();
  const match = /^morning-star@git\+(.+)$/i.exec(raw);
  if (!match) return false;
  const spec = match[1].split("#")[0].trim().toLowerCase();
  return (
    /^https?:\/\/github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) ||
    /^ssh:\/\/git@github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) ||
    /^git@github\.com:btspoony\/mstar-harness(\.git)?$/.test(spec)
  );
}

function isMstarHarnessOpencodePlugin(plugin: string): boolean {
  const p = plugin.trim();
  return p === "@mstar-harness/opencode" || p.startsWith("@mstar-harness/opencode@");
}

function isAnyMstarHarnessOpencodeSlot(plugin: string): boolean {
  return isLegacyMorningStarGitPlugin(plugin) || isMstarHarnessOpencodePlugin(plugin);
}

function getOpencodeModels() {
  const raw = execFileSync("opencode", ["models"], { encoding: "utf8" });
  const models = normalizeModelList(raw);
  if (!models.length) throw new Error("`opencode models` returned no model entries.");
  return models;
}

function resolveOpencodeConfigPath(scope: Scope, outputPath?: string) {
  if (outputPath && outputPath.trim()) {
    const raw = outputPath.trim();
    return path.isAbsolute(raw) ? raw : path.join(resolveProjectRoot(), raw);
  }
  if (scope === "global") return path.join(os.homedir(), ".config", "opencode", "opencode.json");
  return path.join(resolveProjectRoot(), "opencode.json");
}

function ensureConfigSchema(config: Record<string, unknown>) {
  const next = ensureObject(config);
  next.$schema = OPENCODE_CONFIG_SCHEMA;
  return next;
}

function updatePluginList(config: Record<string, unknown>) {
  const next = ensureObject(config);
  const existing = Array.isArray(next.plugin) ? next.plugin : [];
  const result: string[] = [];
  for (const item of existing) {
    if (typeof item !== "string") continue;
    const plugin = item.trim();
    if (!plugin) continue;
    if (isAnyMstarHarnessOpencodeSlot(plugin)) continue;
    if (!result.includes(plugin)) result.push(plugin);
  }
  if (!result.includes(MSTAR_OPENCODE_PLUGIN)) result.push(MSTAR_OPENCODE_PLUGIN);
  next.plugin = result;
  return next;
}

function applyAssignments(config: Record<string, unknown>, assignments: Record<string, string>) {
  const next = ensureObject(config);
  const agent = ensureObject(next.agent);
  next.agent = agent;
  for (const [roleId, modelId] of Object.entries(assignments)) {
    const roleConfig = ensureObject(agent[roleId]);
    roleConfig.model = modelId;
    agent[roleId] = roleConfig;
  }
  return next;
}

function validateSetup(config: Record<string, unknown>) {
  const errors: string[] = [];
  if (config.$schema !== OPENCODE_CONFIG_SCHEMA) {
    errors.push(`Missing or invalid $schema (expected: ${OPENCODE_CONFIG_SCHEMA}).`);
  }

  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const hasMstarOpencode = plugins.some(
    (item) => typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim()),
  );
  if (!hasMstarOpencode) errors.push("Missing @mstar-harness/opencode plugin entry in `plugin` (or legacy morning-star git plugin).");

  const agent = ensureObject(config.agent);
  for (const roleId of ALL_ROLES) {
    const role = ensureObject(agent[roleId]);
    if (typeof role.model !== "string" || !role.model.trim()) {
      errors.push(`Missing model for role: ${roleId}`);
    }
  }
  return errors;
}

function getDoctorWarnings(config: Record<string, unknown>): string[] {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const strings = plugins
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const hasNpm = strings.some(isMstarHarnessOpencodePlugin);
  const hasLegacy = strings.some(isLegacyMorningStarGitPlugin);
  if (hasLegacy && !hasNpm) {
    return [
      "Plugin list uses legacy `morning-star@git+…` for this harness; run `mstar-harness init --target opencode` (or `--yes` with model flags) to rewrite to `@mstar-harness/opencode@latest`.",
    ];
  }
  if (hasLegacy && hasNpm) {
    return [
      "Both legacy `morning-star@git+…` and `@mstar-harness/opencode` appear in `plugin`; run `init` again to dedupe and keep a single npm plugin line.",
    ];
  }
  return [];
}

export const opencodeAdapter: AgentAdapter = {
  target: "opencode",
  mode: "config",
  getAvailableModels: () => getOpencodeModels(),
  resolveConfigPath: (scope, outputPath) => resolveOpencodeConfigPath(scope, outputPath),
  mutateConfigForInit: (config, assignments) => {
    const withSchema = ensureConfigSchema(config);
    const withPlugin = updatePluginList(withSchema);
    return applyAssignments(withPlugin, assignments);
  },
  validateConfig: (config) => validateSetup(config),
  getDoctorWarnings: (config) => getDoctorWarnings(config),
  printPostSetupSummary: () => {
    console.log(`Schema: ${OPENCODE_CONFIG_SCHEMA} (ensured)`);
    console.log(`Plugin: ${MSTAR_OPENCODE_PLUGIN} (ensured; legacy git morning-star entries removed)`);
  },
};
