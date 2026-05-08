import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ALL_ROLES } from "../constants";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, normalizeModelList, resolveProjectRoot } from "../utils";

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
const MORNING_STAR_PLUGIN = "morning-star@git+https://github.com/btspoony/mstar-harness.git";

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
  let hasMorningStar = false;
  for (const item of existing) {
    if (typeof item !== "string") continue;
    const plugin = item.trim();
    if (!plugin) continue;
    const isMorningStar = plugin.startsWith("morning-star@git+https://github.com/btspoony/mstar-harness.git");
    if (isMorningStar) {
      if (!hasMorningStar) {
        result.push(plugin);
        hasMorningStar = true;
      }
      continue;
    }
    if (!result.includes(plugin)) result.push(plugin);
  }
  if (!hasMorningStar) result.push(MORNING_STAR_PLUGIN);
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
  const hasMorningStar = plugins.some(
    (item) => typeof item === "string" && item.startsWith("morning-star@git+https://github.com/btspoony/mstar-harness.git"),
  );
  if (!hasMorningStar) errors.push("Missing morning-star plugin entry in `plugin`.");

  const agent = ensureObject(config.agent);
  for (const roleId of ALL_ROLES) {
    const role = ensureObject(agent[roleId]);
    if (typeof role.model !== "string" || !role.model.trim()) {
      errors.push(`Missing model for role: ${roleId}`);
    }
  }
  return errors;
}

export const opencodeAdapter: AgentAdapter = {
  target: "opencode",
  getAvailableModels: () => getOpencodeModels(),
  resolveConfigPath: (scope, outputPath) => resolveOpencodeConfigPath(scope, outputPath),
  mutateConfigForInit: (config, assignments) => {
    const withSchema = ensureConfigSchema(config);
    const withPlugin = updatePluginList(withSchema);
    return applyAssignments(withPlugin, assignments);
  },
  validateConfig: (config) => validateSetup(config),
  printPostSetupSummary: () => {
    console.log(`Schema: ${OPENCODE_CONFIG_SCHEMA} (ensured)`);
    console.log(`Plugin: ${MORNING_STAR_PLUGIN} (ensured, deduplicated)`);
  },
};
