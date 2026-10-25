/**
 * Formatting that has to be identical in both hosts.
 *
 * Pure string work: no DOM, no clock, no locale lookup. The honesty rules that
 * matter survive from the dashboard's `web/format.ts` — a stored timestamp is
 * shown verbatim, and an absent one says so instead of borrowing the read time.
 * The parts D30 removed (migration provenance, evidence JSON, external-link
 * validation) are deliberately **not** carried over: nothing renders them.
 */

/** The copy for a value the record does not carry. */
export const UNKNOWN_DATE = "Date unknown";

/** The copy for a value the read did not determine (never `0`, never blank). */
export const NOT_KNOWN = "Not known";

/** The copy for a concept this subject does not declare (IA §5 `absent`). */
export const NOT_DECLARED = "Not declared";

/**
 * A stored timestamp, verbatim. Precision is never re-formatted — a date stays a
 * date and a timestamp keeps its time — and an absent value says `UNKNOWN_DATE`
 * rather than the import/read time, because those are different facts.
 */
export function formatDate(value: string | null | undefined): string {
  const lexeme = typeof value === "string" ? value.trim() : "";
  return lexeme === "" ? UNKNOWN_DATE : lexeme;
}

/**
 * One long-text field: the stored text with its line breaks preserved and no
 * interpretation. Empty text is `null` so the caller renders its own absence
 * arm rather than an empty paragraph.
 */
export function longText(value: string | null | undefined): string | null {
  const lexeme = typeof value === "string" ? value.trim() : "";
  return lexeme === "" ? null : lexeme;
}

/** `done/total` as the row prints it, or `null` when there is no measured total. */
export function progressText(progress: { done: number; total: number } | null): string | null {
  return progress === null ? null : `${progress.done}/${progress.total}`;
}

/** A count and its noun, pluralized: `1 issue` / `2 issues`. */
export function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A value that may be absent in three different ways. The caller passes the copy
 * for each, because "the record carries no owner" and "the read could not tell"
 * are not the same sentence (IA §5 rule 4).
 */
export function textOr(value: string | null | undefined, whenAbsent: string): string {
  const lexeme = typeof value === "string" ? value.trim() : "";
  return lexeme === "" ? whenAbsent : lexeme;
}

/**
 * The projection state, as the one fact the product renders about its own read
 * authority (`Overview`'s footer line; IA §8.2).
 *
 * The timestamps the read carries (`builtAt`, `checkedAt`) and the revision
 * counters are **not** returned: IA §8.1 removes them from the UI, and the
 * state plus the named reasons answer the only question a reader acts on.
 */
export type ProjectionState =
  | { kind: "current" }
  | { kind: "stale"; reasons: readonly string[] }
  | { kind: "unavailable"; reasons: readonly string[] };

/** Map one read projection to that state. Reasons are the sources' own messages. */
export function projectionState(projection: {
  generation: number | null;
  freshness: "current" | "stale" | "unavailable";
  diagnostics: ReadonlyArray<{ sourceKey: string; message: string }>;
}): ProjectionState {
  const reasons = projection.diagnostics.map((diagnostic) => `${diagnostic.sourceKey}: ${diagnostic.message}`);
  if (projection.freshness === "current") return { kind: "current" };
  if (projection.freshness === "stale") return { kind: "stale", reasons };
  return { kind: "unavailable", reasons };
}

/** Whether a projection can carry projected rows at all. */
export function projectionUnavailable(projection: { generation: number | null }): boolean {
  return projection.generation === null;
}
