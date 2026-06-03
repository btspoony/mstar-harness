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

const CURSOR_PLUGIN_NAME = "mstar-harness";
const CURSOR_PLUGIN_MARKER = ".cursor-plugin/plugin.json";

function globalInstallPath() {
  return path.join(os.homedir(), ".cursor", "plugins", "local", CURSOR_PLUGIN_NAME);
}

function projectInstallPath() {
  return path.join(resolveProjectRoot(), ".cursor", "plugins", CURSOR_PLUGIN_NAME);
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
  notes.push(...appendGitignore(projectRoot, [".cursor/plugins/mstar-harness"], dryRun));
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
  if (!gitignore.split(/\r?\n/).includes(".cursor/plugins/mstar-harness")) {
    errors.push("Missing .gitignore entry: .cursor/plugins/mstar-harness");
  }
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
