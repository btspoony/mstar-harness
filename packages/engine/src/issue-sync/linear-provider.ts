/**
 * Provider assembly: one Linear MCP entry in, one `IssueProvider` out.
 *
 * The probe and the adapter each take their I/O injected; this module is the
 * single place that joins them to the real transport so a host does not have to.
 * Assembling them here rather than in a host is what makes `issue-sync import`
 * work in every environment instead of only where someone wired it by hand.
 *
 * The handshake result is cached for the life of the provider: the probe runs
 * `tools/list`, and the adapter must list with the verb that handshake actually
 * returned rather than assume its preferred candidate exists.
 */
import type { IssueProvider } from "./provider.js";
import { createLinearAdapter, type LinearCallOutcome, type LinearListSide } from "./linear-adapter.js";
import { createLinearProbe, type LinearMcpEntry, type RpcOutcome } from "./linear-probe.js";
import { linearCall, linearRpc, type LinearTransportOptions } from "./linear-transport.js";

export type { LinearTransportOptions };

/**
 * Candidate listing verbs, in preference order. The service advertises
 * `list_issues`, which was verified with an authenticated `tools/list`; the
 * second name stays as a fallback for a deployment fronting a different
 * revision. A host that lists neither is refused as
 * `linear.list-unimplemented` rather than guessed at.
 */
export const LINEAR_LISTING_VERBS: readonly string[] = ["list_issues", "search_issues"];

export type LinearProviderOptions = LinearTransportOptions & {
  /** The bound team/project; the listing never widens past it. */
  scope?: { team?: string; project?: string };
  /** Overrides the module candidate set (tests, and a host that pins the verb). */
  listingVerbs?: readonly string[];
};

/** One provider backed by the streamable-HTTP transport. */
export function createLinearProvider(options: LinearProviderOptions): IssueProvider & Pick<LinearListSide, "listIssues"> {
  const verbs = options.listingVerbs ?? LINEAR_LISTING_VERBS;
  const entry: LinearMcpEntry = { url: options.url };
  // Filled by the probe's handshake; `null` means no handshake has run yet, and
  // the adapter refuses rather than assuming a verb.
  let listed: string[] | null = null;

  const probe = createLinearProbe({
    findLinearEntry: () => entry,
    rpc: async (_entry, method): Promise<RpcOutcome> => {
      const outcome = await linearRpc(options, method);
      if (method === "tools/list" && outcome.kind === "ok" && outcome.tools !== undefined) listed = outcome.tools;
      return outcome;
    },
    listingVerbs: verbs,
    deadlineMs: options.deadlineMs,
  });

  const listing = createLinearAdapter({
    findLinearEntry: () => ({ url: options.url }),
    call: async (_entry, request): Promise<LinearCallOutcome> => linearCall(options, request),
    listingVerbs: verbs,
    listedVerbs: () => listed,
    scope: options.scope,
  });

  return { probe: () => probe.probe(), listIssues: (cursor) => listing.listIssues(cursor) };
}
