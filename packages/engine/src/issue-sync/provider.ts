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
  /** note: mapped kind label name (kind→label intent, preserved from r2), sent as
      `addLabels`. Absent when kind maps to no label. */
  labels?: string[];
  /** note: the mstar-written labels this update REPLACES (from `last_kind_label`),
      sent as `removeLabels`. An unconfirmed earlier update may have left more
      than one of them on the remote, and removing an absent label is a no-op,
      so every recorded label but the desired one is sent. Absent on create. */
  removeLabels?: string[];
};
