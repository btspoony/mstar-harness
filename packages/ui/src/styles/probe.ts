/**
 * The style probe this repository compares against the prototype.
 *
 * Every argument is a CSS selector, and every selector is resolved **inside the screen
 * root**, never the document:
 *
 *  - the prototype keeps all nine screens in the DOM with `hidden` on the inactive ones,
 *    so a document-wide query answers with whichever screen comes first;
 *  - a screen can carry more than one table (the issues screen has the list and the
 *    trend's table alternative), so `thead th` alone can answer for the wrong one.
 *
 * Both mistakes produced phantom differences during the comparison work — a `null` that
 * looked like a missing panel, and a 10px header that looked like a theme-dependent size.
 * Hence one helper, used by both sides, rather than an ad-hoc snippet per round.
 */

export type StyleProbe = {
  /** Where the screen lives: matched on `[data-screen]` first, then filtered to a SECTION. */
  screen: string;
  /**
   * Which attribute names the screen. The prototype marks screens `data-screen`; this
   * product marks them `data-ms-screen`. Probing the wrong one returns `{}` — an empty
   * result that reads like "nothing to report" rather than "wrong attribute".
   */
  attribute?: "data-screen" | "data-ms-screen";
  /** Selector → the properties to report. The selector is scoped to the screen. */
  selectors: Record<string, string>;
  /** Extra qualifier, e.g. a table's class, when the screen holds several of one element. */
  within?: string;
};

/** The properties that actually differ between a correct and an incorrect implementation. */
export const BASELINE_PROPERTIES = ["font-size", "font-weight", "line-height", "color", "padding"] as const;

/**
 * Runs in the page. Returns `{ selector: { property: value } }`, or `null` for a selector
 * that matches nothing — `null` on both sides is a match.
 */
export function probeStyles(spec: StyleProbe): Record<string, Record<string, string> | null> {
  const attribute = spec.attribute ?? "data-screen";
  const screens = Array.from(document.querySelectorAll(`[${attribute}="${spec.screen}"]`));
  const root = screens.find((element) => element.tagName === "SECTION") ?? screens[0];
  if (root === undefined) return {};
  const scope: Element | null =
    spec.within === undefined ? (root as Element) : root.querySelector(spec.within);
  if (scope === null) return {};
  const out: Record<string, Record<string, string> | null> = {};
  for (const [key, selector] of Object.entries(spec.selectors)) {
    const element = scope.querySelector(selector);
    if (element === null) {
      out[key] = null;
      continue;
    }
    const computed = getComputedStyle(element);
    const row: Record<string, string> = {};
    for (const property of BASELINE_PROPERTIES) row[property] = computed.getPropertyValue(property);
    out[key] = row;
  }
  return out;
}

/** The spec used for the list screens: the same five elements on every one of them. */
export const LIST_SCREEN_SPEC: StyleProbe = {
  screen: "issues",
  selectors: {
    heading: ".screen-head h1",
    panelTitle: ".panel-title",
    panelMeta: ".panel-meta",
    tableHeader: "thead th",
    tableCell: "tbody td",
  },
  // Without this the probe reads the trend's table instead of the list's.
  within: "table.table",
};

/** The spec used for the detail screens: the header line and one field pair. */
export const DETAIL_SCREEN_SPEC: StyleProbe = {
  screen: "workflow-detail",
  selectors: {
    title: ".detail-title",
    meta: ".detail-meta",
    fieldLabel: ".field dt",
    fieldValue: ".field dd",
    chip: ".chip",
    breadcrumb: ".breadcrumb",
  },
};
