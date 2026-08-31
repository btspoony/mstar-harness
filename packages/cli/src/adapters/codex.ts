import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
import { runCliCommand } from "../exec";
import {
  HARNESS_REPO_PATH,
  PLUGIN_NAME,
  REPO_URL,
  ensureLocalHarnessRepo,
  ensureSymlink,
  validateLocalHarnessRepo,
  validateSymlink,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
} from "./shared-install";

/**
 * Codex install flow (repo-marketplace, probed 2026-08-31 on codex-cli 0.144.1):
 *
 * The harness repo ships its own marketplace catalog at
 * `.agents/plugins/marketplace.json` (repo root = marketplace root; the plugin
 * root is the repo root, so the single entry points at `source.path: "./"`).
 * Codex does NOT implicitly discover repo marketplaces from the CWD — the
 * marketplace must be registered once via `codex plugin marketplace add`.
 * Git-sourced marketplaces are cloned by codex into its own snapshot cache
 * (`marketplace upgrade` refreshes), so users no longer need a personal
 * `~/.agents/plugins/marketplace.json` or a CLI-maintained checkout for the
 * marketplace itself.
 *
 * - init: probe for the codex CLI, then `codex plugin marketplace add
 *   <owner/repo> --ref main` (idempotent — an already-added marketplace is a
 *   no-op). Custom-agent symlinks still come from the shared local checkout at
 *   `~/.mstar/harness` (codex only discovers agents from `~/.codex/agents/`,
 *   not from plugin packages).
 * - doctor: validate the local checkout + agent symlinks (as before), then
 *   check the marketplace is registered and the plugin resolvable via
 *   `codex plugin marketplace list --json` / `codex plugin list --json`.
 *   The repo-bundled `.agents/plugins/marketplace.json` is a release asset of
 *   the harness repo itself; the CLI does not validate its entry shape.
 * - Legacy `~/.agents/plugins/marketplace.json` entries (pre-3.7 "personal"
 *   marketplace) surface as doctor notes, not errors.
 */

const CODEX_BIN = "codex";
const CODEX_LOCAL_TIMEOUT_MS = 10_000;
const CODEX_MARKETPLACE_TIMEOUT_MS = 300_000;
/** GitHub shorthand accepted by `codex plugin marketplace add <SOURCE>`. */
const MARKETPLACE_GIT_SOURCE = "btspoony/mstar-harness";
/** Marketplace name = upstream repo's bundled `.agents/plugins/marketplace.json` `name`. */
export const MARKETPLACE_NAME = "mstar-repo";
const CODEX_INSTALL_HINT =
  "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.";

const CODEX_AGENT_NAMES = [
  "product-manager",
  "architect",
  "fullstack-dev",
  "fullstack-dev-2",
  "frontend-dev",
  "qa-engineer",
  "qc-specialist",
  "qc-specialist-2",
  "qc-specialist-3",
  "ops-engineer",
  "writing-specialist",
  "prompt-engineer",
];

const CODEX_PROJECT_COMMAND_NAMES = [
  "iteration-start",
  "iteration-drive",
  "iteration-loop",
  "codebase-audit",
  "amazing-pr-review",
] as const;

const GLOBAL_ITERATION_SKILLS_WARNING =
  "Codex project-scoped commands (iteration-start / iteration-drive / iteration-loop / codebase-audit / amazing-pr-review) are installed as project-local skills under .agents/skills/ only. Global install skips them to avoid polluting other code agents. Re-run with --scope project to enable.";

/** Run codex with args; dry-run never spawns a subprocess. env is spread so
 * the binary resolves from PATH (same contract as the dsh adapter). */
function runCodex(args: string[], dryRun: boolean, timeoutMs: number): string {
  return runCliCommand([CODEX_BIN, ...args], { dryRun, timeoutMs, env: process.env });
}

function codexAvailable(): boolean {
  try {
    runCodex(["--version"], false, CODEX_LOCAL_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Parse `codex plugin marketplace list --json` → marketplace names. */
function configuredMarketplaceNames(dryRun: boolean): string[] {
  if (dryRun) return [];
  const dump = runCodex(["plugin", "marketplace", "list", "--json"], false, CODEX_LOCAL_TIMEOUT_MS);
  const parsed = JSON.parse(dump) as {
    marketplaces?: Array<{ name?: unknown }>;
  };
  const list = Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
  return list
    .map((entry) => (entry && typeof entry.name === "string" ? entry.name : ""))
    .filter((name) => name !== "");
}

/** Parse `codex plugin list --json` → installed plugin ids (`name@marketplace`). */
function installedPluginIds(dryRun: boolean): string[] {
  if (dryRun) return [];
  const dump = runCodex(["plugin", "list", "--json"], false, CODEX_LOCAL_TIMEOUT_MS);
  const parsed = JSON.parse(dump) as {
    installed?: Array<{ pluginId?: unknown }>;
  };
  const list = Array.isArray(parsed.installed) ? parsed.installed : [];
  return list
    .map((entry) => (entry && typeof entry.pluginId === "string" ? entry.pluginId : ""))
    .filter((pluginId) => pluginId !== "");
}

/**
 * Read the legacy personal marketplace (`~/.agents/plugins/marketplace.json`),
 * if it exists, and surface a migration note when it still carries a harness
 * entry. Never throws — the file is user-owned and optional post-cutover.
 */
function legacyPersonalMarketplaceNote(): string | null {
  const legacyPath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
  let raw: string;
  try {
    raw = fs.readFileSync(legacyPath, "utf8");
  } catch {
    // Absent or unreadable: the legacy file is user-owned and optional.
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const hasMstar = plugins.some(
      (entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) && "name" in entry && entry.name === PLUGIN_NAME,
    );
    if (hasMstar) {
      return `Legacy personal marketplace entry found at ${legacyPath} \u2014 the ${PLUGIN_NAME} plugin now installs from the repo marketplace (${MARKETPLACE_GIT_SOURCE}). Remove the entry, then install: codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    }
  } catch {
    // Unparseable user config: leave it alone.
  }
  return null;
}

function agentSourcePath(agentName: string) {
  return path.join(HARNESS_REPO_PATH, "codex", "agents", `${agentName}.toml`);
}

function globalAgentLinkPath(agentName: string) {
  return path.join(os.homedir(), ".codex", "agents", `${agentName}.toml`);
}

function projectAgentLinkPath(agentName: string) {
  return path.join(resolveProjectRoot(), ".codex", "agents", `${agentName}.toml`);
}

function ensureAgentLinks(scope: Scope, dryRun: boolean) {
  const notes: string[] = [];
  for (const agentName of CODEX_AGENT_NAMES) {
    const source = agentSourcePath(agentName);
    const linkPath = scope === "global" ? globalAgentLinkPath(agentName) : projectAgentLinkPath(agentName);
    notes.push(ensureSymlink(source, linkPath, dryRun));
  }
  return notes;
}

function validateAgentLinks(scope: Scope) {
  const errors: string[] = [];
  for (const agentName of CODEX_AGENT_NAMES) {
    const source = agentSourcePath(agentName);
    const linkPath = scope === "global" ? globalAgentLinkPath(agentName) : projectAgentLinkPath(agentName);
    errors.push(...validateSymlink(source, linkPath));
  }
  return errors;
}

function iterationCommandSourcePath(skillName: string) {
  return path.join(HARNESS_REPO_PATH, "commands", `${skillName}.md`);
}

function projectIterationSkillLinkPath(skillName: string) {
  return path.join(resolveProjectRoot(), ".agents", "skills", skillName, "SKILL.md");
}

function iterationSkillGitignoreEntry(skillName: string) {
  return `.agents/skills/${skillName}`;
}

function ensureIterationSkillLinks(dryRun: boolean) {
  const notes: string[] = [];
  const projectRoot = resolveProjectRoot();
  for (const skillName of CODEX_PROJECT_COMMAND_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    notes.push(ensureSymlink(source, linkPath, dryRun));
  }
  const gitignoreEntries = CODEX_PROJECT_COMMAND_NAMES.map(iterationSkillGitignoreEntry);
  notes.push(...appendGitignore(projectRoot, gitignoreEntries, dryRun));
  notes.push(
    "Installed Codex project-scoped command skills under .agents/skills/ (iteration-start, iteration-drive, iteration-loop, codebase-audit, amazing-pr-review) \u2014 symlinked to harness commands/*.md.",
  );
  return notes;
}

function validateIterationSkillLinks() {
  const errors: string[] = [];
  const projectRoot = resolveProjectRoot();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = gitignore.split(/\r?\n/);
  for (const skillName of CODEX_PROJECT_COMMAND_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    errors.push(...validateSymlink(source, linkPath));
    const entry = iterationSkillGitignoreEntry(skillName);
    if (!lines.includes(entry)) errors.push(`Missing .gitignore entry: ${entry}`);
  }
  return errors;
}

function runInit(scope: Scope, dryRun: boolean) {
  const notes: string[] = [];

  // The shared local checkout stays: codex agent .toml symlinks (and the Cursor
  // / omp adapters) materialize from it.
  notes.push(...ensureLocalHarnessRepo(dryRun));

  const marketplaceArgs = ["plugin", "marketplace", "add", REPO_URL, "--ref", "main"];
  if (dryRun) {
    notes.push(`Would run: ${CODEX_BIN} ${marketplaceArgs.join(" ")}`);
  } else {
    if (!codexAvailable()) {
      throw new Error(`${CODEX_BIN} CLI not found on PATH. ${CODEX_INSTALL_HINT}`);
    }
    // Idempotent: re-adding an already-configured marketplace is a no-op
    // (verified locally — output carries alreadyAdded=true, exit 0).
    try {
      const already = configuredMarketplaceNames(false).includes(MARKETPLACE_NAME);
      if (already) {
        notes.push(`Marketplace ${MARKETPLACE_NAME} already configured.`);
      } else {
        runCodex(marketplaceArgs, false, CODEX_MARKETPLACE_TIMEOUT_MS);
        notes.push(`Added marketplace ${MARKETPLACE_NAME} from ${REPO_URL} (ref main).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to add marketplace via ${CODEX_BIN}: ${message}`);
    }
    notes.push(`Next: codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  }

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    notes.push(...appendGitignore(projectRoot, [".codex/agents/*.toml"], dryRun));
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(...ensureIterationSkillLinks(dryRun));
  } else {
    notes.push(GLOBAL_ITERATION_SKILLS_WARNING);
  }
  notes.push(...ensureAgentLinks(scope, dryRun));

  return {
    location: `${CODEX_BIN} marketplaces (config.toml)`,
    notes,
  };
}

function runDoctor(scope: Scope) {
  const errors = validateLocalHarnessRepo();
  const notes: string[] = [];
  const legacyNote = legacyPersonalMarketplaceNote();
  if (legacyNote) notes.push(legacyNote);

  if (!codexAvailable()) {
    errors.push(`${CODEX_BIN} CLI not found on PATH. ${CODEX_INSTALL_HINT}`);
    return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
  }
  try {
    const marketplaces = configuredMarketplaceNames(false);
    if (!marketplaces.includes(MARKETPLACE_NAME)) {
      errors.push(`Marketplace ${MARKETPLACE_NAME} not configured (run init, or: ${CODEX_BIN} plugin marketplace add ${REPO_URL} --ref main).`);
    }
    const installed = installedPluginIds(false);
    const pluginId = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
    if (marketplaces.includes(MARKETPLACE_NAME) && !installed.includes(pluginId)) {
      notes.push(`Plugin not installed yet: ${CODEX_BIN} plugin add ${pluginId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Could not query ${CODEX_BIN} plugin marketplace list: ${message}`);
  }

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
      errors.push(`Missing .gitignore entry: ${entry}`);
    }
    errors.push(...validateIterationSkillLinks());
  }
  errors.push(...validateAgentLinks(scope));
  return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
}

export const codexAdapter: AgentAdapter = {
  target: "codex",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};