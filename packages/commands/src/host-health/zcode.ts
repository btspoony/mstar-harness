import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasHarnessRootDeclaration } from "@mstar-harness/engine";
import { resolveProjectRoot } from "./paths.js";

const MARKETPLACE_ID = "mstar-local";
const MARKETPLACE_NAME = "mstar-local";
const GITHUB_REPO = "btspoony/mstar-harness";
const PLUGIN_NAME = "morning-star-harness";
const HARNESS_PROCESS_GITIGNORE = [
  ".mstar/**",
  "!.mstar/AGENTS.md",
  "!.mstar/knowledge/",
  "!.mstar/knowledge/**",
  "!.mstar/specs/",
  "!.mstar/specs/**",
  ".agents/**",
  "!.agents/AGENTS.md",
  "!.agents/knowledge/",
  "!.agents/knowledge/**",
  "!.agents/specs/",
  "!.agents/specs/**",
  ".mstarc",
];
const ZCODE_PLUGIN_MARKER = ".zcode-plugin/plugin.json";
const ZCODE_PLUGIN_CHECKOUT_PROJECT = ".zcode/plugin-checkout";
const ZCODE_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];
const HARNESS_MARKERS = [".codex-plugin/plugin.json", ZCODE_PLUGIN_MARKER, ".omp-plugin/plugin.json"];

type ZcodeScope = "global" | "project";
export type ZcodeDoctorResult = { location: string; errors: string[] };
export type ZcodeHostRoots = {
  pluginsRoot?: string;
  projectRoot?: string;
  harnessRepoPath?: string;
};

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJson(file: string): Record<string, unknown> {
  return ensureObject(JSON.parse(fs.readFileSync(file, "utf8")));
}

function findKnownMarketplace(raw: Record<string, unknown>) {
  const marketplaces = Array.isArray(raw.marketplaces) ? raw.marketplaces : [];
  return marketplaces.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as { id?: unknown }).id === MARKETPLACE_ID) as Record<string, unknown> | undefined;
}

function findMarketplacePlugin(raw: Record<string, unknown>) {
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  return plugins.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as { name?: unknown }).name === PLUGIN_NAME) as Record<string, unknown> | undefined;
}

function validateMarketplaceJson(file: string): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(file)) {
    errors.push(`Missing ZCode marketplace: ${file}`);
    return errors;
  }
  const raw = readJson(file);
  if (raw.name !== MARKETPLACE_NAME) errors.push(`ZCode marketplace name must be ${MARKETPLACE_NAME} (in ${file}).`);
  const entry = findMarketplacePlugin(raw);
  if (!entry) {
    errors.push(`Missing ${PLUGIN_NAME} plugin entry in ${file}.`);
    return errors;
  }
  const source = ensureObject(entry.source);
  if (source.source !== "github") errors.push("ZCode marketplace plugin source.source must be `github`.");
  if (source.repo !== GITHUB_REPO) errors.push(`ZCode marketplace plugin source.repo must be ${GITHUB_REPO}.`);
  return errors;
}

function validateKnownMarketplaces(file: string): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(file)) {
    errors.push(`Missing ZCode known_marketplaces.json: ${file}`);
    return errors;
  }
  const entry = findKnownMarketplace(readJson(file));
  if (!entry) {
    errors.push(`Missing ${MARKETPLACE_ID} entry in ${file}.`);
    return errors;
  }
  if (entry.id !== MARKETPLACE_ID) errors.push(`known_marketplaces entry id must be ${MARKETPLACE_ID}.`);
  const source = ensureObject(entry.source);
  if (source.source !== "github") errors.push("known_marketplaces entry source.source must be github.");
  if (source.repo !== GITHUB_REPO) errors.push(`known_marketplaces entry source.repo must be ${GITHUB_REPO}.`);
  return errors;
}

function validatePluginAgents(pluginRoot: string): string[] {
  const errors: string[] = [];
  const agentsDir = path.join(pluginRoot, "agents");
  if (!fs.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of ZCODE_AGENT_SMOKE_NAMES) {
    const agentPath = path.join(agentsDir, `${agentName}.md`);
    if (!fs.existsSync(agentPath)) errors.push(`Missing plugin agent file: ${agentPath}`);
  }
  return errors;
}

function validateLocalHarnessRepo(harnessRepoPath: string): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(harnessRepoPath)) {
    errors.push(`Missing local harness repo: ${harnessRepoPath}`);
    return errors;
  }
  if (!HARNESS_MARKERS.some((marker) => fs.existsSync(path.join(harnessRepoPath, marker)))) {
    errors.push(`Local harness repo is missing a plugin marker (expected one of: ${HARNESS_MARKERS.join(", ")}).`);
  }
  return errors;
}

function validateGitCheckout(checkoutPath: string): string[] {
  const errors: string[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(checkoutPath);
  } catch {
    errors.push(`Missing checkout directory: ${checkoutPath}`);
    return errors;
  }
  if (stat.isSymbolicLink()) {
    errors.push(`Path must be a real directory, not a symlink: ${checkoutPath}. Run: mstar-harness init --target cursor`);
    return errors;
  }
  if (!fs.existsSync(path.join(checkoutPath, ".git"))) errors.push(`Path is not a git checkout: ${checkoutPath}`);
  const marker = path.join(checkoutPath, ZCODE_PLUGIN_MARKER);
  if (!fs.existsSync(marker)) errors.push(`Missing marker file: ${marker}`);
  return errors;
}

/** Assemble read-only ZCode doctor findings from synthetic or real host roots. */
export function diagnoseZcodeHost(scope: ZcodeScope, roots: ZcodeHostRoots = {}): ZcodeDoctorResult {
  const pluginsRoot = roots.pluginsRoot ?? path.join(os.homedir(), ".zcode", "cli", "plugins");
  const projectRoot = roots.projectRoot ?? resolveProjectRoot();
  const harnessRepoPath = roots.harnessRepoPath ?? path.join(os.homedir(), ".mstar", "harness");
  const knownMarketplacesPath = path.join(pluginsRoot, "known_marketplaces.json");
  const marketplacePath = path.join(pluginsRoot, "marketplaces", MARKETPLACE_ID, "marketplace.json");
  const errors = validateLocalHarnessRepo(harnessRepoPath);

  if (scope === "project") {
    const checkoutPath = path.join(projectRoot, ZCODE_PLUGIN_CHECKOUT_PROJECT);
    errors.push(...validateGitCheckout(checkoutPath));
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    const lines = gitignore.split(/\r?\n/);
    if (!lines.includes(ZCODE_PLUGIN_CHECKOUT_PROJECT)) {
      errors.push(`Missing .gitignore entry: ${ZCODE_PLUGIN_CHECKOUT_PROJECT}`);
    }
    if (!hasHarnessRootDeclaration(gitignore)) {
      for (const entry of HARNESS_PROCESS_GITIGNORE) {
        if (!lines.includes(entry)) errors.push(`Missing .gitignore entry: ${entry}`);
      }
    }
    errors.push(...validatePluginAgents(checkoutPath));
  } else {
    errors.push(...validatePluginAgents(harnessRepoPath));
  }

  errors.push(...validateKnownMarketplaces(knownMarketplacesPath));
  errors.push(...validateMarketplaceJson(marketplacePath));
  return { location: knownMarketplacesPath, errors };
}
