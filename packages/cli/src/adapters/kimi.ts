import { diagnoseKimiHost, kimiManagedRoot } from "@mstar-harness/commands";
import type { AgentAdapter, Scope } from "../types";
import { ensureHostPresent } from "./host-presence";

/**
 * Kimi manages the plugin through its TUI. The CLI is nevertheless a required
 * host-presence precondition for real installs; the TUI route follows once the
 * CLI is installed.
 */

const KIMI_INSTALL_HINT = "Install via Kimi TUI: /plugins install";

function runInit(_scope: Scope, _dryRun: boolean): { location: string; notes: string[] } {
  return {
    location: kimiManagedRoot(),
    notes: [KIMI_INSTALL_HINT],
  };
}

function runDoctor(_scope: Scope): { location: string; errors: string[]; notes: string[] } {
  return diagnoseKimiHost();
}

export const kimiAdapter: AgentAdapter = {
  target: "kimi",
  mode: "install",
  runInstallInit: async (scope, dryRun) => {
    if (!dryRun) await ensureHostPresent("kimi");
    return runInit(scope, dryRun);
  },
  runInstallDoctor: (scope) => runDoctor(scope),
};
