/**
 * Provider assembly: one Linear MCP entry in, one `IssueProvider` out.
 *
 * The probe, the listing adapter and the write adapter each take their I/O
 * injected; this module is the single place that joins them to the real
 * transport so a host does not have to. Assembling them here rather than in a
 * host is what makes `issue-sync import` and `issue-sync push` work in every
 * environment instead of only where someone wired it by hand.
 *
 * The handshake result is cached for the life of the provider: the probe runs
 * `tools/list`, and both the listing and the write side must resolve their verb
 * through the SAME handshake the probe returned rather than assume their
 * preferred candidate exists. The advertised argument names ride along, so the
 * write side can prove an argument (`removeLabels`) instead of assuming it.
 */
import type { IssueProvider } from "./provider.js";
import { createLinearAdapter, type LinearCallOutcome, type LinearListSide } from "./linear-adapter.js";
import { createLinearProbe, type LinearMcpEntry, type RpcOutcome } from "./linear-probe.js";
import { createLinearWrite, LINEAR_LABEL_VERBS, LINEAR_WRITE_VERBS, type LinearWriteSide } from "./linear-write.js";
import { linearCall, linearRpc, type LinearTransportOptions } from "./linear-transport.js";

export type { LinearTransportOptions };
export { LINEAR_LABEL_VERBS, LINEAR_WRITE_VERBS };

/**
 * Candidate listing verbs, in preference order. The service advertises
 * `list_issues` in the session recorded by the adapter's header (local, its
 * transcript not in this repository); the second name stays as a fallback for a
 * deployment fronting a different revision. A host that lists neither is
 * refused as `linear.list-unimplemented` rather than guessed at.
 */
export const LINEAR_LISTING_VERBS: readonly string[] = ["list_issues", "search_issues"];

export type LinearProviderOptions = LinearTransportOptions & {
  /** The bound team/project; no read and no write widens past it. */
  scope?: { team?: string; project?: string };
  /** Overrides the module candidate sets (tests, and a host that pins a verb). */
  listingVerbs?: readonly string[];
  writeVerbs?: readonly string[];
  labelVerbs?: readonly string[];
};

/** One provider backed by the streamable-HTTP transport. */
export function createLinearProvider(
  options: LinearProviderOptions,
): IssueProvider & Pick<LinearListSide, "listIssues"> & Pick<LinearWriteSide, "discoverLabels"> {
  const verbs = options.listingVerbs ?? LINEAR_LISTING_VERBS;
  const entry: LinearMcpEntry = { url: options.url };
  // Filled by the probe's handshake; `null` means no handshake has run yet, and
  // both sides refuse rather than assuming a verb.
  let listed: string[] | null = null;
  let advertised: Record<string, readonly string[]> = {};

  const probe = createLinearProbe({
    findLinearEntry: () => entry,
    rpc: async (_entry, method): Promise<RpcOutcome> => {
      const outcome = await linearRpc(options, method);
      if (method === "tools/list" && outcome.kind === "ok") {
        if (outcome.tools !== undefined) listed = outcome.tools;
        advertised = { ...advertised, ...(outcome.toolArguments ?? {}) };
      }
      return outcome;
    },
    listingVerbs: verbs,
    deadlineMs: options.deadlineMs,
  });

  const call = async (_entry: { url: string }, request: { tool: string; arguments: Record<string, unknown> }): Promise<LinearCallOutcome> =>
    linearCall(options, request);

  const listing = createLinearAdapter({
    findLinearEntry: () => ({ url: options.url }),
    call,
    listingVerbs: verbs,
    listedVerbs: () => listed,
    scope: options.scope,
  });

  const writing = createLinearWrite({
    findLinearEntry: () => ({ url: options.url }),
    call,
    writeVerbs: options.writeVerbs,
    labelVerbs: options.labelVerbs,
    listedVerbs: () => listed,
    // The schema for a tool the handshake did not describe is UNKNOWN, not
    // empty: `null` makes the write side refuse rather than guess.
    advertisedArguments: (tool) => advertised[tool] ?? null,
    scope: options.scope,
  });

  return {
    probe: () => probe.probe(),
    listIssues: (cursor) => listing.listIssues(cursor),
    applyWrite: (write) => writing.applyWrite(write),
    discoverLabels: () => writing.discoverLabels(),
  };
}
