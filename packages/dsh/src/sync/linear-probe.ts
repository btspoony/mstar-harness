/**
 * dsh host probe for the Linear MCP entry (binding-config plan Task 3).
 * Implements the engine's `IssueProvider.probe()` contract: one JSON-RPC
 * `initialize` followed by `tools/list` against the Linear entry in the dsh
 * MCP configuration. Outcome → state mapping:
 *
 * - no Linear entry in the configuration                     → `service-absent`
 * - entry present, transport failed or the deadline expired  → `unreachable`
 * - 401/403 or auth-class error                              → `access-denied`
 * - handshake ok AND the updatedAt-filtered listing verb
 *   is actually listed                                       → `ready`
 * - handshake ok but the listing verb is missing             → `service-absent`
 *
 * The last row is the plan's rule (Task 3): "ready" requires the listing verb,
 * not merely two answered calls — a configured service that cannot list issues
 * is not usable. The four states are distinguished purely by the injected
 * outcome of those two calls; this module never learns an engine config shape,
 * never prints a credential and never mutates anything.
 *
 * Two contract facts this adapter must never leak: the transport's own message
 * (it can carry `Authorization: Bearer …`) and the credential itself. Every
 * cause is built from fixed text plus a redacted transport summary.
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
  /**
   * Tool names that satisfy "the listing verb that supports an updatedAt
   * filter" (contract §5 — the exact name is pinned by the authenticated
   * `tools/list` of P3 Task 1). Any one of them must be listed for `ready`.
   */
  listingVerbs: readonly string[];
  /** Per-call deadline in milliseconds; expiry is `unreachable`, never a hang. */
  deadlineMs?: number;
};

/** Default per-call deadline: an MCP handshake is two round trips. */
export const DEFAULT_PROBE_DEADLINE_MS = 5_000;

const REDACTED = "[redacted]";

/**
 * Redact a transport message before it can reach a credential-free `cause`.
 * `ProbeResult.cause` flows to `probe_cause`, the dashboard DTO and the panel,
 * so an upstream error body must not carry a bearer token through it.
 */
export function redactTransportMessage(message: string): string {
  return message
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/("?(?:access_token|refresh_token|api[_-]?key|token|authorization|secret|password)"?\s*[:=]\s*)("?)[^"',;\s]+/gi, `$1$2${REDACTED}`)
    // URL userinfo (`https://user:pass@host`) is a credential class of its own:
    // it survives every header/query rule above because it is neither.
    .replace(/\/\/[^/@\s]+@/g, `//${REDACTED}@`)
    .replace(/\blin_(?:api|oauth)_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, REDACTED)
    .slice(0, 200);
}

/** Map one non-ok handshake outcome to a probe state (see module comment). */
function mapOutcome(outcome: Exclude<RpcOutcome, { kind: "ok" }>): ProbeResult {
  if (outcome.kind === "transport-error") {
    return { state: "unreachable", cause: `unreachable: Linear MCP transport failed (${redactTransportMessage(outcome.message)})` };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return { state: "access-denied", cause: `access-denied: Linear MCP handshake answered ${outcome.status}` };
  }
  return { state: "unreachable", cause: `unreachable: Linear MCP handshake answered HTTP ${outcome.status}` };
}

/** Why the deadline expired, in the contract's own words. */
function timedOut(deadlineMs: number): ProbeResult {
  return { state: "unreachable", cause: `unreachable: Linear MCP handshake timed out after ${deadlineMs}ms` };
}

/**
 * Run `call` under `deadlineMs`. The injected `rpc` owns cancellation (it is
 * the host's transport); this race guarantees `probe()` returns even when it
 * never settles, which is what keeps every readiness caller unblocked.
 *
 * A transport that THROWS is the other half of the same promise: `probe()`
 * returns `Promise<ProbeResult>`, so a rejection would escape the four-state
 * vocabulary. A thrown transport error is therefore caught here and becomes the
 * `transport-error` outcome `mapOutcome` already knows. `call` is a thunk so a
 * SYNCHRONOUS throw is caught by the same boundary.
 */
async function withDeadline(call: () => Promise<RpcOutcome>, deadlineMs: number): Promise<RpcOutcome | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  const settled = Promise.resolve()
    .then(call)
    .catch((error: unknown): RpcOutcome => ({ kind: "transport-error", message: describeThrown(error) }));
  try {
    return await Promise.race([settled, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A thrown transport error as text — never a stack, never a raw body dump. */
function describeThrown(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "the transport threw without a message";
}

/** The first listed tool that satisfies the contract's listing requirement. */
function listingVerbIn(tools: readonly string[] | undefined, verbs: readonly string[]): string | null {
  if (tools === undefined) return null;
  const listed = new Set(tools);
  return verbs.find((verb) => listed.has(verb)) ?? null;
}

/** Create the dsh Linear provider; deps come from the host fiber. */
export function createLinearProbe(deps: LinearProbeDeps): IssueProvider {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
  return {
    async probe(): Promise<ProbeResult> {
      const entry = deps.findLinearEntry();
      if (entry === null) {
        return { state: "service-absent", cause: "service-absent: no Linear entry in the host MCP configuration" };
      }
      const init = await withDeadline(() => deps.rpc(entry, "initialize"), deadlineMs);
      if (init === "timeout") return timedOut(deadlineMs);
      if (init.kind !== "ok") return mapOutcome(init);

      const listing = await withDeadline(() => deps.rpc(entry, "tools/list"), deadlineMs);
      if (listing === "timeout") return timedOut(deadlineMs);
      if (listing.kind !== "ok") return mapOutcome(listing);

      const verb = listingVerbIn(listing.tools, deps.listingVerbs);
      if (verb === null) {
        // Contract §2 `service-absent` is widened here in wording only: the
        // entry is configured but exposes no usable listing capability, so no
        // caller may be told `ready`. The cause names exactly what was missing.
        return {
          state: "service-absent",
          cause: `service-absent: the Linear MCP entry lists no updatedAt-filtered listing verb (looked for ${deps.listingVerbs.join(", ")}; listed ${listing.tools?.length ?? 0} tool(s))`,
        };
      }
      return { state: "ready", cause: `ready: Linear MCP handshake succeeded and lists ${verb}` };
    },
    // The mirror import (P3) owns the listing. A fabricated empty page would be
    // indistinguishable from an empty Linear project, so this refuses by name.
    async listIssues(): Promise<never> {
      throw Object.assign(new Error("[linear.list-unimplemented] Linear issue listing arrives with the mirror import (P3); this build exposes readiness only."), {
        code: "linear.list-unimplemented",
      });
    },
  };
}
