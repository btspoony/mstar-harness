import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
import {
  HARNESS_REPO_PATH,
  ensureLocalHarnessRepo,
  ensureSymlink,
  validateLocalHarnessRepo,
  validateSymlink,
  appendGitignore,
} from "./shared-install";

const CURSOR_PLUGIN_NAME = "morning-star-harness";
const CURSOR_PLUGIN_MARKER = ".cursor-plugin/plugin.json";
const CURSOR_PLUGIN_LINK = ".cursor/plugins/morning-star-harness";
const CURSOR_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];

function globalInstallPath() {
  return path.join(os.homedir(), ".cursor", "plugins", "local", CURSOR_PLUGIN_NAME);
}

function projectInstallPath() {
  return path.join(resolveProjectRoot(), CURSOR_PLUGIN_LINK);
}

function validatePluginAgents() {
  const errors: string[] = [];
  const agentsDir = path.join(HARNESS_REPO_PATH, "agents");
  if (!fs.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of CURSOR_AGENT_SMOKE_NAMES) {
    const agentPath = path.join(agentsDir, `${agentName}.md`);
    if (!fs.existsSync(agentPath)) {
      errors.push(`Missing plugin agent file: ${agentPath}`);
      continue;
    }
    const content = fs.readFileSync(agentPath, "utf8");
    if (!/^---\nname:\s/m.test(content)) {
      errors.push(
        `Plugin agent ${agentName}.md must use Cursor-first frontmatter (name, description, model before OpenCode fields).`,
      );
    }
  }
  return errors;
}

function globalInit(dryRun: boolean) {
  const location = globalInstallPath();
  const notes = ensureLocalHarnessRepo(dryRun);
  notes.push(ensureSymlink(HARNESS_REPO_PATH, location, dryRun));
  return { location, notes };
}

function projectInit(dryRun: boolean) {
  const projectRoot = resolveProjectRoot();
  const location = projectInstallPath();
  const notes = ensureLocalHarnessRepo(dryRun);
  notes.push(ensureSymlink(HARNESS_REPO_PATH, location, dryRun));
  notes.push(...appendGitignore(projectRoot, [CURSOR_PLUGIN_LINK], dryRun));
  return { location, notes };
}

function globalDoctor() {
  const location = globalInstallPath();
  const errors = validateLocalHarnessRepo();
  errors.push(...validateSymlink(HARNESS_REPO_PATH, location));
  const marker = path.join(location, CURSOR_PLUGIN_MARKER);
  if (!fs.existsSync(marker)) {
    errors.push(`Missing Cursor plugin marker file: ${marker}`);
  }
  errors.push(...validatePluginAgents());
  return { location, errors };
}

function projectDoctor() {
  const projectRoot = resolveProjectRoot();
  const location = projectInstallPath();
  const errors = validateLocalHarnessRepo();
  errors.push(...validateSymlink(HARNESS_REPO_PATH, location));
  const marker = path.join(location, CURSOR_PLUGIN_MARKER);
  if (!fs.existsSync(marker)) {
    errors.push(`Missing Cursor plugin marker file: ${marker}`);
  }
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.split(/\r?\n/).includes(CURSOR_PLUGIN_LINK)) {
    errors.push(`Missing .gitignore entry: ${CURSOR_PLUGIN_LINK}`);
  }
  errors.push(...validatePluginAgents());
  return { location, errors };
}

export const cursorAdapter: AgentAdapter = {
  target: "cursor",
  mode: "install",
  runInstallInit: (scope, dryRun) => {
    if (scope === "global") return globalInit(dryRun);
    return projectInit(dryRun);
  },
  runInstallDoctor: (scope) => {
    if (scope === "global") return globalDoctor();
    return projectDoctor();
  },
};
