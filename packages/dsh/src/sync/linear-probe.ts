/**
 * dsh host probe for the Linear MCP entry (binding-config plan Task 3).
 * Implements the engine's `IssueProvider.probe()` contract: one JSON-RPC
 * `initialize` followed by `tools/list` against the Linear entry in the dsh
 * MCP configuration. Outcome → state mapping:
 *
 * - no Linear entry in the configuration  → `service-absent`
 * - entry present, transport failed       → `unreachable`
 * - 401/403 or auth-class error           → `access-denied`
 * - handshake succeeded                   → `ready`
 *
 * The four states are distinguished purely by the injected outcome of those
 * two calls; this module never learns an engine config shape, never prints a
 * credential and never mutates anything. The exact Linear listing tool name
 * is pending P3 Task 1 (contract wording: "the listing verb that supports an
 * updatedAt filter") — readiness here means both handshake calls answered ok.
 */
import type { IssueProvider, ProbeResult } from "@mstar-harness/engine";

/** A configured Linear MCP entry, as the host configuration names it. */
export type LinearMcpEntry = {
  /** Entry transport URL. */
  url: string;
};

/** The outcome of one injected JSON-RPC call. */
export type RpcOutcome =
  | { kind: "ok"; tools?: string[] }
  | { kind: "transport-error"; message: string }
  | { kind: "http-status"; status: number };

/** Host-owned capabilities injected at the MCP boundary (fixture in tests). */
export type LinearProbeDeps = {
  /** Find the configured Linear MCP entry, or `null` when none exists. */
  findLinearEntry(): LinearMcpEntry | null;
  /** Perform one JSON-RPC call against the entry. */
  rpc(entry: LinearMcpEntry, method: "initialize" | "tools/list"): Promise<RpcOutcome>;
};

/** Map one non-ok handshake outcome to a probe state (see module comment). */
function mapOutcome(outcome: RpcOutcome): ProbeResult {
  if (outcome.kind === "transport-error") {
    return { state: "unreachable", cause: `unreachable: Linear MCP transport failed (${outcome.message})` };
  }
  if (outcome.kind === "http-status" && (outcome.status === 401 || outcome.status === 403)) {
    return { state: "access-denied", cause: `access-denied: Linear MCP handshake answered ${outcome.status}` };
  }
  if (outcome.kind === "http-status") {
    return { state: "unreachable", cause: `unreachable: Linear MCP handshake answered HTTP ${outcome.status}` };
  }
  return { state: "ready", cause: "ready: Linear MCP handshake succeeded (initialize + tools/list)" };
}

/** Create the dsh Linear provider; deps come from the host fiber. */
export function createLinearProbe(deps: LinearProbeDeps): IssueProvider {
  return {
    async probe(): Promise<ProbeResult> {
      const entry = deps.findLinearEntry();
      if (entry === null) {
        return { state: "service-absent", cause: "service-absent: no Linear entry in the host MCP configuration" };
      }
      const init = await deps.rpc(entry, "initialize");
      if (init.kind !== "ok") return mapOutcome(init);
      const tools = await deps.rpc(entry, "tools/list");
      if (tools.kind !== "ok") return mapOutcome(tools);
      return mapOutcome(tools);
    },
    // listIssues arrives with the mirror import (P3); the probe-only surface
    // is enough for the read-only readiness display this iteration.
    async listIssues() {
      return { items: [], nextCursor: null };
    },
  };
}
