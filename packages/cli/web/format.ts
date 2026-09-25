/**
 * Dashboard formatting helpers.
 *
 * Pure string work: no Preact, no DOM, no clock. The honesty rules the design
 * fixes (DESIGN.md "Colors and typography" and "History and chart honesty")
 * therefore stay checkable without a renderer.
 */
import type { IssueDetail } from "@mstar-harness/engine";

/**
 * One provenance row as the detail DTO carries it. Derived from the exported
 * DTO instead of a second declaration, and named here because the engine's read
 * boundary publishes the row types through `IssueDetail`, not individually.
 */
type IssueProvenance = IssueDetail["provenance"][number];

/** DESIGN.md copy for a date the record does not carry. */
export const UNKNOWN_DATE = "Date unknown";

/**
 * The stored timestamp lexeme, verbatim: precision is never re-formatted, and
 * an absent historical date says "Date unknown" rather than the recording or
 * import time.
 */
export function formatDate(value: string | null | undefined): string {
  const lexeme = typeof value === "string" ? value.trim() : "";
  return lexeme === "" ? UNKNOWN_DATE : lexeme;
}

/** Red marks critical/high severity only; the text label carries the meaning. */
export function severityTone(severity: string): "danger" | "neutral" {
  return severity === "critical" || severity === "high" ? "danger" : "neutral";
}

/**
 * Green means resolved only: waved/duplicate/superseded are terminal but are
 * not successes, so they stay visually distinct from resolved.
 */
export function dispositionTone(disposition: string): "success" | "terminal" | "neutral" {
  if (disposition === "resolved") return "success";
  if (disposition === "open") return "neutral";
  return "terminal";
}

/**
 * One migration/source label for an imported record (issue contract §3): the
 * recorded legacy path plus the project/bucket/entry identity, each part only
 * when the migration row actually carries it. `null` means the issue has no
 * migration provenance -- nothing is labelled migrated without evidence.
 */
export function migrationNote(provenance: readonly IssueProvenance[]): string | null {
  const row = provenance.find(
    (entry) =>
      entry.kind === "migration" ||
      entry.legacyEntryId !== null ||
      entry.legacyBucket !== null ||
      entry.legacyProject !== null,
  );
  if (row === undefined) return null;
  const bucket = [row.legacyProject, row.legacyBucket]
    .filter((part): part is string => part !== null && part !== "")
    .join(" / ");
  const entry = row.legacyEntryId === null || row.legacyEntryId === "" ? "" : ` #${row.legacyEntryId}`;
  const identity = bucket === "" && entry === "" ? "" : ` (${bucket}${entry})`;
  return `Imported from ${row.target}${identity}`;
}

/**
 * A link only for a validated http/https URL: a stored `javascript:` or `data:`
 * value renders as nothing rather than as an executable link (plan D2 security
 * boundary, DESIGN.md "History and chart honesty").
 */
export function externalLinkHref(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Stored JSON evidence as plain text. An empty object/array or absent value is
 * nothing to show; everything else is rendered as text by the caller, never as
 * HTML or Markdown.
 */
export function evidenceText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  const json = JSON.stringify(value, null, 2);
  return json === undefined || json === "{}" || json === "[]" ? null : json;
}

/**
 * A structured API failure as visible copy: what failed, from the dashboard's
 * own vocabulary, plus the safe next action. The server already scrubs local
 * paths and never sends a stack or credential.
 */
export function failureText(code: string, message: string): string {
  if (code === "store.not-initialized") {
    return `${message} — initialize the issue store with the CLI, then reload.`;
  }
  if (code === "store.not-active") {
    return `${message} — the store is staged, not active; complete the CLI activation, then reload.`;
  }
  if (code.startsWith("store.") || code.startsWith("projection.")) {
    return `${message} — fix the store state with the CLI, then reload.`;
  }
  return `${message} (${code})`;
}
