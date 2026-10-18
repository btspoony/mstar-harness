import { diagnoseCursorHost, globalInstallPath, projectInstallPath } from "@mstar-harness/commands";
import type { AgentAdapter, Scope } from "../types";
import {
  REPO_URL,
  ensureLocalHarnessRepo,
  ensureGitCheckout,
  validateLocalHarnessRepo,
} from "./shared-install";
import { ensureHostPresent } from "./host-presence";

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
  const location = projectInstallPath();
  const notes = ensureLocalHarnessRepo(dryRun);
  notes.push(...ensureCursorPluginCheckout(location, dryRun));
  return { location, notes };
}

function globalDoctor() {
  const diagnostic = diagnoseCursorHost("global");
  return { ...diagnostic, errors: [...validateLocalHarnessRepo(), ...diagnostic.errors] };
}

function projectDoctor() {
  const diagnostic = diagnoseCursorHost("project");
  return { ...diagnostic, errors: [...validateLocalHarnessRepo(), ...diagnostic.errors] };
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
