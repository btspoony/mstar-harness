import os from "node:os";
import path from "node:path";
import {
  getOpencodeDoctorWarnings,
  isAnyMstarHarnessOpencodeSlot,
  OPENCODE_CONFIG_SCHEMA,
  validateOpencodeConfig,
} from "@mstar-harness/commands";
import { ALL_ROLES } from "../constants";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, resolveProjectRoot } from "../utils";

const MSTAR_OPENCODE_PLUGIN = "@mstar-harness/opencode@latest";

function resolveOpencodeConfigPath(scope: Scope, outputPath?: string) {
  if (outputPath && outputPath.trim()) {
    const raw = outputPath.trim();
    if (path.isAbsolute(raw)) return raw;
    // A relative --output must name a path inside the project root: parent-dir
    // segments are refused outright, so the appended result cannot escape.
    if (raw.split(/[\\/]/).includes("..")) {
      throw new Error(`--output must not contain ".." segments: ${raw}`);
    }
    const root = resolveProjectRoot();
    return root.endsWith(path.sep) ? root + raw : root + path.sep + raw;
  }
  if (scope === "global") {
    const home = os.homedir();
    return `${home}${path.sep}.config${path.sep}opencode${path.sep}opencode.json`;
  }
  const root = resolveProjectRoot();
  return root.endsWith(path.sep) ? `${root}opencode.json` : `${root}${path.sep}opencode.json`;
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

/** Optional advanced path: write role models only when caller supplied assignments. */
function applyAssignments(config: Record<string, unknown>, assignments: Record<string, string>) {
  if (!Object.keys(assignments).length) return config;
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

export const opencodeAdapter: AgentAdapter = {
  target: "opencode",
  mode: "config",
  // No getAvailableModels — default init never calls `opencode models` (that command can hang with no feedback).
  resolveConfigPath: (scope, outputPath) => resolveOpencodeConfigPath(scope, outputPath),
  mutateConfigForInit: (config, assignments) => {
    const withSchema = ensureConfigSchema(config);
    const withPlugin = updatePluginList(withSchema);
    return applyAssignments(withPlugin, assignments);
  },
  validateConfig: (config) => validateOpencodeConfig(config),
  getDoctorWarnings: (config) => getOpencodeDoctorWarnings(config, ALL_ROLES),
  printPostSetupSummary: () => {
    console.log(`Schema: ${OPENCODE_CONFIG_SCHEMA} (ensured)`);
    console.log(`Plugin: ${MSTAR_OPENCODE_PLUGIN} (ensured; legacy git morning-star entries removed)`);
    console.log("Role models: left to OpenCode defaults (set agent.<role>.model in opencode.json only if you want overrides)");
  },
};
