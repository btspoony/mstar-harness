import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, readJson, writeJson } from "../utils";
import { resolveProjectRoot } from "../utils";
import {
  HARNESS_REPO_PATH,
  PLUGIN_NAME,
  ensureLocalHarnessRepo,
  ensureSymlink,
  validateLocalHarnessRepo,
  validateSymlink,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
  homeRelativeSourcePath,
} from "./shared-install";

const MARKETPLACE_NAME = "personal";
const MARKETPLACE_DISPLAY_NAME = "Personal";
const GLOBAL_MARKETPLACE_PATH = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const PLUGIN_CATEGORY = "Productivity";
const CODEX_PLUGIN_LINK = ".codex/plugins/mstar-harness";
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

const CODEX_ITERATION_SKILL_NAMES = [
  "iteration-start",
  "iteration-drive",
  "iteration-loop",
] as const;

const GLOBAL_ITERATION_SKILLS_WARNING =
  "Codex iteration commands (iteration-start / iteration-drive / iteration-loop) are installed as project-local skills under .agents/skills/ only. Global install skips them to avoid polluting other code agents. Re-run with --scope project to enable.";

type MarketplaceEntry = {
  name: string;
  source: {
    source: "local";
    path: string;
  };
  policy: {
    installation: "AVAILABLE";
    authentication: "ON_INSTALL";
  };
  category: string;
};

function globalMarketplacePath() {
  return GLOBAL_MARKETPLACE_PATH;
}

function projectMarketplacePath() {
  return path.join(resolveProjectRoot(), ".agents", "plugins", "marketplace.json");
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

function mstarEntry(scope: Scope): MarketplaceEntry {
  const sourcePath =
    scope === "global"
      ? homeRelativeSourcePath(HARNESS_REPO_PATH)
      : `./${CODEX_PLUGIN_LINK}`;
  return {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: sourcePath,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: PLUGIN_CATEGORY,
  };
}

function normalizeMarketplace(raw: Record<string, unknown>) {
  const next = ensureObject(raw);
  next.name = MARKETPLACE_NAME;
  const iface = ensureObject(next.interface);
  if (typeof iface.displayName !== "string" || !iface.displayName.trim()) {
    iface.displayName = MARKETPLACE_DISPLAY_NAME;
  }
  next.interface = iface;
  if (!Array.isArray(next.plugins)) {
    next.plugins = [];
  }
  return next;
}

function upsertEntry(raw: Record<string, unknown>, scope: Scope) {
  const next = normalizeMarketplace(raw);
  const plugins = (next.plugins as unknown[]).filter((entry) => {
    return !(
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { name?: unknown }).name === PLUGIN_NAME
    );
  });
  plugins.push(mstarEntry(scope));
  next.plugins = plugins;
  return next;
}

function findEntry(raw: Record<string, unknown>) {
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  return plugins.find((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { name?: unknown }).name === PLUGIN_NAME
    );
  }) as Record<string, unknown> | undefined;
}

function validateEntryShape(entry: Record<string, unknown> | undefined, scope: Scope, marketplacePath: string) {
  const errors: string[] = [];
  if (!entry) {
    errors.push(`Missing ${PLUGIN_NAME} entry in ${marketplacePath}.`);
    return errors;
  }
  const source = ensureObject(entry.source);
  const expectedSourcePath = mstarEntry(scope).source.path;
  if (source.source !== "local") errors.push("Codex marketplace entry source.source must be `local`.");
  if (source.path !== expectedSourcePath) {
    errors.push(`Codex marketplace entry source.path must be ${expectedSourcePath}.`);
  }
  const policy = ensureObject(entry.policy);
  if (policy.installation !== "AVAILABLE") errors.push("Codex marketplace entry policy.installation must be AVAILABLE.");
  if (policy.authentication !== "ON_INSTALL") errors.push("Codex marketplace entry policy.authentication must be ON_INSTALL.");
  if (entry.category !== PLUGIN_CATEGORY) errors.push(`Codex marketplace entry category must be ${PLUGIN_CATEGORY}.`);
  return errors;
}

function marketplacePath(scope: Scope) {
  if (scope === "global") return globalMarketplacePath();
  return projectMarketplacePath();
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
  for (const skillName of CODEX_ITERATION_SKILL_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    notes.push(ensureSymlink(source, linkPath, dryRun));
  }
  const gitignoreEntries = CODEX_ITERATION_SKILL_NAMES.map(iterationSkillGitignoreEntry);
  notes.push(...appendGitignore(projectRoot, gitignoreEntries, dryRun));
  notes.push(
    "Installed Codex project-scoped iteration skills under .agents/skills/ (iteration-start, iteration-drive, iteration-loop) — symlinked to harness commands/*.md.",
  );
  return notes;
}

function validateIterationSkillLinks() {
  const errors: string[] = [];
  const projectRoot = resolveProjectRoot();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = gitignore.split(/\r?\n/);
  for (const skillName of CODEX_ITERATION_SKILL_NAMES) {
    const source = iterationCommandSourcePath(skillName);
    const linkPath = projectIterationSkillLinkPath(skillName);
    errors.push(...validateSymlink(source, linkPath));
    const entry = iterationSkillGitignoreEntry(skillName);
    if (!lines.includes(entry)) errors.push(`Missing .gitignore entry: ${entry}`);
  }
  return errors;
}

function runInit(scope: Scope, dryRun: boolean) {
  const pathToMarketplace = marketplacePath(scope);
  const current = readJson(pathToMarketplace);
  const next = upsertEntry(current, scope);
  const existingEntry = findEntry(current);
  const notes = ensureLocalHarnessRepo(dryRun);
  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    notes.push(ensureSymlink(HARNESS_REPO_PATH, path.join(projectRoot, CODEX_PLUGIN_LINK), dryRun));
    notes.push(...appendGitignore(projectRoot, [CODEX_PLUGIN_LINK, ".codex/agents/*.toml"], dryRun));
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(...ensureIterationSkillLinks(dryRun));
  } else {
    notes.push(GLOBAL_ITERATION_SKILLS_WARNING);
  }
  notes.push(...ensureAgentLinks(scope, dryRun));
  if (!dryRun) writeJson(pathToMarketplace, next);
  notes.push(existingEntry ? `Updated ${PLUGIN_NAME} local marketplace entry.` : `Added ${PLUGIN_NAME} local marketplace entry.`);
  notes.push(`Source path: ${mstarEntry(scope).source.path}`);
  notes.push(`Install after init: codex plugin add ${PLUGIN_NAME} --marketplace ${MARKETPLACE_NAME}`);
  return {
    location: pathToMarketplace,
    notes,
  };
}

function runDoctor(scope: Scope) {
  const pathToMarketplace = marketplacePath(scope);
  const errors = validateLocalHarnessRepo();
  if (!fs.existsSync(pathToMarketplace)) {
    return { location: pathToMarketplace, errors: [...errors, `Missing Codex marketplace: ${pathToMarketplace}`] };
  }
  const marketplace = readJson(pathToMarketplace);
  if (marketplace.name !== MARKETPLACE_NAME) {
    errors.push(`Codex personal marketplace name must be ${MARKETPLACE_NAME}.`);
  }
  errors.push(...validateEntryShape(findEntry(marketplace), scope, pathToMarketplace));
  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    errors.push(...validateSymlink(HARNESS_REPO_PATH, path.join(projectRoot, CODEX_PLUGIN_LINK)));
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    const lines = gitignore.split(/\r?\n/);
    if (!lines.includes(CODEX_PLUGIN_LINK)) errors.push(`Missing .gitignore entry: ${CODEX_PLUGIN_LINK}`);
    if (!lines.includes(".codex/agents/*.toml")) errors.push("Missing .gitignore entry: .codex/agents/*.toml");
    for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
      errors.push(`Missing .gitignore entry: ${entry}`);
    }
    errors.push(...validateIterationSkillLinks());
  }
  errors.push(...validateAgentLinks(scope));
  return { location: pathToMarketplace, errors };
}

export const codexAdapter: AgentAdapter = {
  target: "codex",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
