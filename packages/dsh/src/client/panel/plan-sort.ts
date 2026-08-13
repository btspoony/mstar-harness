/**
 * Sidebar / Done-column plan ordering (spec panel-zones §3): the hard-coded
 * digitized sort keys shared by the sidebar plan board (this plan, Task 3)
 * and the canvas Done column (plan 20260810-panel-canvas-zones reuses the
 * same rule). Pure function — no rendering, no state.
 *
 * Keys, compared in order (all DESC):
 *   1. `doneAt` matching /^\d{4}-\d{2}-\d{2}$/ → '.replaceAll('-','')'
 *      digitized (e.g. '2026-08-08' → '20260808'); non-matching (missing /
 *      garbage) → empty key (sorts last).
 *   2. fallback: `id` first 8 chars when /^\d{8}/ → that 8-digit key, DESC.
 *   3. tie-break: `id` lexicographic DESC (deterministic, testable).
 */

/** Sidebar plan cap (spec §5): show ≤5 rows + `+N more`. */
export const PLAN_CAP = 5

/** Residual findings cap (spec §5): show ≤10 rows + overflow hint. */
export const FINDINGS_CAP = 10

const DONE_AT_RE = /^\d{4}-\d{2}-\d{2}$/
const ID_DATE_RE = /^\d{8}/

/** Digitized doneAt key; '' when missing/garbage (empty key sorts last, DESC). */
function doneAtKey(doneAt: string | null): string {
  if (typeof doneAt !== 'string' || !DONE_AT_RE.test(doneAt)) return ''
  return doneAt.replaceAll('-', '')
}

/** First-8-digits id-date key; '' when the id does not start with 8 digits. */
function idDateKey(id: string): string {
  return ID_DATE_RE.test(id) ? id.slice(0, 8) : ''
}

/**
 * Spec §3 comparator (all keys DESC). The digitized keys are 8-digit strings,
 * so plain string DESC comparison is numeric-correct; the id tie-break is
 * plain lexicographic DESC.
 */
export function comparePlans(
  a: { readonly id: string; readonly doneAt: string | null },
  b: { readonly id: string; readonly doneAt: string | null },
): number {
  const aDone = doneAtKey(a.doneAt)
  const bDone = doneAtKey(b.doneAt)
  if (aDone !== bDone) return aDone < bDone ? 1 : -1
  const aDate = idDateKey(a.id)
  const bDate = idDateKey(b.id)
  if (aDate !== bDate) return aDate < bDate ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * Sorted copy in spec §3 order (stable — input order preserved within equal
 * keys, so the result is deterministic for any input).
 */
export function sortPlans<T extends { readonly id: string; readonly doneAt: string | null }>(plans: readonly T[]): T[] {
  return Array.from(plans).sort(comparePlans)
}

/**
 * The「最近一次迭代」recency comparator (plan 20260813-panel-quick-fixes Task
 * 2 — shared by the current-iteration filter in `project-graph.ts`, which
 * previously duplicated this order as a local `moreRecentPlan`). DIFFERENT
 * key order from {@link comparePlans}: the 8-digit id-date prefix is PRIMARY,
 * doneAt SECONDARY — the projection's former `moreRecentPlan` behavior, kept
 * EXACTLY. All keys DESC: `< 0` means `a` is more recent than `b` (id-date
 * prefix, then digitized doneAt, then id lexicographic DESC for
 * determinism).
 */
export function comparePlansByIterationRecency(
  a: { readonly id: string; readonly doneAt: string | null },
  b: { readonly id: string; readonly doneAt: string | null },
): number {
  const aDate = idDateKey(a.id)
  const bDate = idDateKey(b.id)
  if (aDate !== bDate) return aDate < bDate ? 1 : -1
  const aDone = doneAtKey(a.doneAt)
  const bDone = doneAtKey(b.doneAt)
  if (aDone !== bDone) return aDone < bDone ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}
