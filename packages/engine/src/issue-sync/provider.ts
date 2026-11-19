/**
 * The remote record shapes the sync ledger consumes: what an agent's external
 * issue tools hand back, normalized. mstar has no provider interface and no
 * transport here — the host supplies the tool results, and this module only
 * names the fields the engine reads from them. Nothing in these types carries a
 * credential, a token field, or a machine path.
 */

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
 * which case `index` is the only handle. An ingest run REPORTS a failure like
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
  /** Mapped kind label name (kind→label intent, preserved from r2), sent as
      `addLabels`. Absent when kind maps to no label. */
  labels?: string[];
  /** The mstar-written labels this update REPLACES (from `last_kind_label`),
      sent as `removeLabels`. An unconfirmed earlier update may have left more
      than one of them on the remote, and removing an absent label is a no-op,
      so every recorded label but the desired one is sent. Absent on create. */
  removeLabels?: string[];
};
