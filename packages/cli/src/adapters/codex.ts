import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_MARKETPLACE_NAME as MARKETPLACE_NAME,
  diagnoseCodexHost,
  detectCodexPluginVersion as detectCodexPluginVersionFromHealth,
  parseCodexMarketplaceNames,
} from "@mstar-harness/commands";
import { ensureCodexAgentFile, validateCodexAgentFile } from "./codex-agent-files";
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
 *   no-op). Custom-agent regular files still come from the shared local checkout at
 *   `~/.mstar/harness` (codex only discovers agents from `~/.codex/agents/`,
 *   not from plugin packages).
 * - doctor: validate the local checkout + agent copies, then
 *   check the marketplace is registered and the plugin resolvable via
 *   `codex plugin marketplace list --json` / `codex plugin list --json`.
 *   The repo-bundled `.agents/plugins/marketplace.json` is a release asset of
 *   the harness repo itself; the CLI does not validate its entry shape.
 * - Legacy `~/.agents/plugins/marketplace.json` entries (pre-3.7 "personal"
 *   marketplace) surface as doctor notes, not errors.
 */

const CODEX_BIN = "codex";
const CODEX_INSTALL_HINT = "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.";
const CODEX_LOCAL_TIMEOUT_MS = 10_000;
const CODEX_MARKETPLACE_TIMEOUT_MS = 300_000;


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

const CODEX_AGENT_GITIGNORE = [".codex/agents/*.toml", ".codex/agents/*.toml.*.bak"];

const CODEX_PROJECT_COMMAND_NAMES = [
  "iteration-start",
  "iteration-drive",
  "iteration-loop",
  "codebase-audit",
  "amazing-test-audit",
  "amazing-pr-review",
  "amazing-e2e-check",
] as const;

const GLOBAL_ITERATION_SKILLS_WARNING =
  "Codex project-scoped commands (iteration-start / iteration-drive / iteration-loop / codebase-audit / amazing-test-audit / amazing-pr-review / amazing-e2e-check) are installed as project-local skills under .agents/skills/ only. Global install skips them to avoid polluting other code agents. Re-run with --scope project to enable.";

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

function configuredMarketplaceNames(dryRun: boolean): string[] {
  if (dryRun) return [];
  return parseCodexMarketplaceNames(runCodex(["plugin", "marketplace", "list", "--json"], false, CODEX_LOCAL_TIMEOUT_MS));
}
/** CLI-owned subprocess boundary for the shared read-only Codex version probe. */
export function detectCodexPluginVersion(): string | null {
  return detectCodexPluginVersionFromHealth((args) => runCodex(args, false, CODEX_LOCAL_TIMEOUT_MS));
}


function agentSourcePath(agentName: string) {
  return path.join(HARNESS_REPO_PATH, "codex", "agents", `${agentName}.toml`);
}

function globalAgentFilePath(agentName: string) {
  return path.join(os.homedir(), ".codex", "agents", `${agentName}.toml`);
}

function projectAgentFilePath(agentName: string) {
  return path.join(resolveProjectRoot(), ".codex", "agents", `${agentName}.toml`);
}

function ensureAgentFiles(scope: Scope, dryRun: boolean) {
  const notes: string[] = [];
  for (const agentName of CODEX_AGENT_NAMES) {
    const source = agentSourcePath(agentName);
    const filePath = scope === "global" ? globalAgentFilePath(agentName) : projectAgentFilePath(agentName);
    notes.push(...ensureCodexAgentFile(source, filePath, dryRun));
  }
  return notes;
}

function validateAgentFiles(scope: Scope) {
  const errors: string[] = [];
  for (const agentName of CODEX_AGENT_NAMES) {
    const source = agentSourcePath(agentName);
    const filePath = scope === "global" ? globalAgentFilePath(agentName) : projectAgentFilePath(agentName);
    errors.push(...validateCodexAgentFile(source, filePath, scope));
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
    "Installed Codex project-scoped command skills under .agents/skills/ (iteration-start, iteration-drive, iteration-loop, codebase-audit, amazing-test-audit, amazing-pr-review, amazing-e2e-check) \u2014 symlinked to harness commands/*.md.",
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

  // The shared local checkout stays: codex agent .toml copies (and the Cursor
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
    notes.push(...appendGitignore(projectRoot, CODEX_AGENT_GITIGNORE, dryRun));
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(...ensureIterationSkillLinks(dryRun));
  } else {
    notes.push(GLOBAL_ITERATION_SKILLS_WARNING);
  }
  notes.push(...ensureAgentFiles(scope, dryRun));

  return {
    location: `${CODEX_BIN} marketplaces (config.toml)`,
    notes,
  };
}

function runDoctor(scope: Scope) {
  const diagnostic = diagnoseCodexHost(
    (args) => runCodex(args, false, CODEX_LOCAL_TIMEOUT_MS),
    path.join(os.homedir(), ".agents", "plugins", "marketplace.json"),
  );
  const errors = [...validateLocalHarnessRepo(), ...validateAgentFiles(scope), ...diagnostic.errors];
  const notes = [...diagnostic.notes];
  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    for (const entry of CODEX_AGENT_GITIGNORE) {
      if (!gitignore.split(/\r?\n/).includes(entry)) {
        errors.push(`Missing .gitignore entry: ${entry}. Run: mstar-harness init --target codex --scope project`);
      }
    }
    for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
      errors.push(`Missing .gitignore entry: ${entry}`);
    }
    errors.push(...validateIterationSkillLinks());
  }
  return { location: diagnostic.location, errors, notes };
}

export const codexAdapter: AgentAdapter = {
  target: "codex",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};