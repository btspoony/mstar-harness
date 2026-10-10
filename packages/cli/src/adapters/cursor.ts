import fs from "node:fs";
import path from "node:path";
import { diagnoseCursorHost, globalInstallPath, projectInstallPath } from "@mstar-harness/commands";
import type { AgentAdapter, Scope } from "../types";
import { resolveProjectRoot } from "../utils";
import {
  REPO_URL,
  ensureLocalHarnessRepo,
  ensureGitCheckout,
  validateLocalHarnessRepo,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
} from "./shared-install";
import { ensureHostPresent } from "./host-presence";

const CURSOR_PLUGIN_LINK = ".cursor/plugins/morning-star-harness";

function ensureCursorPluginCheckout(location: string, dryRun: boolean) {
  return ensureGitCheckout(REPO_URL, location, dryRun);
}

function globalInit(dryRun: boolean) {
  const location = globalInstallPath();
  const notes = ensureLocalHarnessRepo(dryRun);
  notes.push(...ensureCursorPluginCheckout(location, dryRun));
  return { location, notes };
}

function projectInit(dryRun: boolean) {
  const projectRoot = resolveProjectRoot();
  const location = projectInstallPath();
  const notes = ensureLocalHarnessRepo(dryRun);
  notes.push(...ensureCursorPluginCheckout(location, dryRun));
  notes.push(...appendGitignore(projectRoot, [CURSOR_PLUGIN_LINK], dryRun));
  notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
  return { location, notes };
}

function globalDoctor() {
  const diagnostic = diagnoseCursorHost("global");
  return { ...diagnostic, errors: [...validateLocalHarnessRepo(), ...diagnostic.errors] };
}

function projectDoctor() {
  const projectRoot = resolveProjectRoot();
  const diagnostic = diagnoseCursorHost("project");
  const errors = [...validateLocalHarnessRepo(), ...diagnostic.errors];
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.split(/\r?\n/).includes(CURSOR_PLUGIN_LINK)) {
    errors.push(`Missing .gitignore entry: ${CURSOR_PLUGIN_LINK}`);
  }
  for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
    errors.push(`Missing .gitignore entry: ${entry}`);
  }
  return { location: diagnostic.location, errors };
}


export const cursorAdapter: AgentAdapter = {
  target: "cursor",
  mode: "install",
  runInstallInit: async (scope, dryRun) => {
    if (!dryRun) await ensureHostPresent("cursor");
    if (scope === "global") return globalInit(dryRun);
    return projectInit(dryRun);
  },
  runInstallDoctor: (scope) => scope === "global" ? globalDoctor() : projectDoctor(),
};
