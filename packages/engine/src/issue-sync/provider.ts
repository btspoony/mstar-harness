/**
 * Provider adapter contract (frozen: iterations/iter-20261031-issue-system-binding
 * specs/provider-adapter-contract.md). The engine knows external issue systems
 * only through this interface; the host owns credentials and the MCP transport
 * (compass D3). Read-only iteration: `apply` is deliberately absent until M1 —
 * an interface member with zero exercising implementations cannot be proven
 * safe; adding it later is purely additive.
 */

/**
 * The ONE probe-state vocabulary (frozen contract §2). Every consumer —
 * the dsh adapter, the dashboard DTO, the query-parameter validator — derives
 * from this union instead of restating the four strings.
 */
export type ProbeState = "ready" | "service-absent" | "unreachable" | "access-denied";

/** The four states as a value, for validation and iteration. */
export const PROBE_STATES: readonly ProbeState[] = ["ready", "service-absent", "unreachable", "access-denied"];

/** Why the provider is or is not reachable right now (credential-free). */
export type ProbeResult = {
  state: ProbeState;
  /** Human-readable, credential-free cause naming the missing capability. */
  cause: string;
};

/** Narrow internal issue record pinned by the frozen contract. */
export type ProviderItem = {
  externalId: string;
  title: string;
  description: string;
  state: string;
  priority: string | null;
  labels: string[];
  /** ISO-8601 timestamp. */
  updatedAt: string;
  url: string;
};

/**
 * One item the host could not map at the adapter boundary (contract §2, cursor
 * section): it fails THAT item by identity and lets the rest of the page
 * proceed. `externalId` is null only when the payload did not carry one, in
 * which case `index` is the only handle. A page carrying failures is treated
 * as stranded by the ingest run: the cursor does not advance past it.
 */
export type ProviderItemFailure = {
  /** Zero-based index of the item inside the page. */
  index: number;
  externalId: string | null;
  /** Credential-free cause prepared for the operator. */
  cause: string;
};

/** Cursor-paginated listing page. */
export type ProviderPage = {
  items: ProviderItem[];
  nextCursor: string | null;
  /**
   * Per-item mapping failures. Absent means none; an INGESTABLE page is
   * `items`; the ingest run must not advance past a page whose array is
   * non-empty (contract §2 "Cursor advance and the overlap window").
   */
  failures?: readonly ProviderItemFailure[];
};

/**
 * The host implements this per provider. No credential crosses this
 * boundary: no member, parameter or result type carries a token field.
 */
export interface IssueProvider {
  /** Can this repo reach the bound provider right now, and if not, why not? */
  probe(): Promise<ProbeResult>;
  /** Cursor-paginated listing; the only read this iteration. */
  listIssues(cursor: string | null): Promise<ProviderPage>;
  // Reserved for M1 (one-way push) — see the module comment before adding.
}
