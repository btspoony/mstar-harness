/**
 * Provider adapter contract: the narrow surface through which the engine knows
 * an external issue system. The host owns credentials and the MCP transport, so
 * this interface carries neither. A write verb is deliberately absent while the
 * surface is read-only: an interface member with zero exercising implementations
 * cannot be proven safe, and adding it later is purely additive.
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
 * which case `index` is the only handle. The ingest run REPORTS a failure like
 * this as stranded and still advances its cursor: a missing required field is
 * not repaired by re-reading the same page, so one such item must never cap
 * every later page (I-000948). Only a retryable ledger-level failure holds the
 * cursor.
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
   * `items`, and the failures are reported as stranded while the cursor still
   * advances (I-000948) — contract §2 "Cursor advance and the overlap window"
   * reserves the cursor hold for retryable ledger failures.
   */
  failures?: readonly ProviderItemFailure[];
};

/**
 * The normalized remote payload one push writes. `description` is Markdown and
 * carries the correlation marker; every field is derived from binding scope and
 * local content, so no credential and no machine path can reach it.
 */
export type ProviderWritePayload = {
  title: string;
  description: string;
  /** Linear priority band per D7: 1 Urgent / 2 High / 3 Medium / 4 Low. */
  priority: number;
  /** Linear workflow state name per D7 (Todo / In Progress / Done / Canceled),
      redirectable through `[linear.mapping]` `disposition` for team-specific
      workflow names. */
  state: string;
  /** Mapped kind label name (kind→label intent, preserved from r2), resolved by
      the adapter against the discovered workspace label set and sent as
      `addLabels`. Absent when kind maps to no label. */
  labels?: string[];
  /** The mstar-written label this update REPLACES (from `last_kind_label`), sent
      as `removeLabels`. Removal is required for a mapped-kind update; a handshake
      schema lacking the argument refuses the update before any write. Absent on
      create. */
  removeLabels?: string[];
};

/** One write per call, mirroring the one-page-per-call read shape; M1 is linear only. */
export type ProviderWrite =
  | { kind: "create"; payload: ProviderWritePayload }
  | { kind: "update"; externalId: string; payload: ProviderWritePayload };

/**
 * The three-valued outcome no caller may collapse. `refused` is provably NOT
 * delivered (safe to retry); `ambiguous` was sent but unconfirmed, so a retry
 * could duplicate a create and the caller must reconcile instead; `confirmed`
 * carries the identity the provider actually returned.
 */
export type ProviderWriteReceipt =
  | { kind: "confirmed"; externalId: string; updatedAt: string | null }
  | { kind: "refused"; code: string; cause: string }
  | { kind: "ambiguous"; cause: string };

/**
 * The host implements this per provider. No credential crosses this
 * boundary: no member, parameter or result type carries a token field.
 */
export interface IssueProvider {
  /** Can this repo reach the bound provider right now, and if not, why not? */
  probe(): Promise<ProbeResult>;
  /** Cursor-paginated listing; the only read this iteration. */
  listIssues(cursor: string | null): Promise<ProviderPage>;
  /**
   * One write per call. The member lives HERE — not on a push-private transport
   * type — because this interface is the one place the engine knows a provider;
   * a second write interface would give the Linear adapter two authorities.
   */
  applyWrite(write: ProviderWrite): Promise<ProviderWriteReceipt>;
}
