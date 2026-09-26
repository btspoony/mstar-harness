import { diagnoseKimiHost, kimiManagedRoot } from "@mstar-harness/commands";
import type { AgentAdapter, Scope } from "../types";

/**
 * Kimi Code install-mode adapter (minimal, probe-pinned 2026-09-08 on
 * kimi-code 0.41.0):
 *
 * - Kimi manages the Morning Star plugin through the TUI (`/plugins install`)
 *   copying it under `$KIMI_CODE_HOME/plugins/managed/`; the kimi CLI has no
 *   plugin subcommand, so there is no CLI-driven install/mutation to run.
 * - init is therefore notes-only and harmless: it performs zero mutations
 *   (the shared AgentAdapter install-init contract only requires
 *   `{ location, notes }`) and points at the TUI install path.
 * - doctor does NOT require the kimi binary (there is no plugin surface to
 *   probe) and never errors on an absent install; diagnostics are assembled
 *   by the shared read-only host-health module.
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
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
