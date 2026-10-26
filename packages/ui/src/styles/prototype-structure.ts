/**
 * The prototype's per-screen panel composition, captured once so a structural comparison
 * is a diff against a fixture instead of a round of ad-hoc DOM probing.
 *
 * Every entry is what the prototype really has, read from
 * `.mstar/iterations/iter-20261025-frontend-unification/prototypes/design-v1.html`:
 *
 *   [...screen.querySelectorAll(".panel")].map((panel) =>
 *     [...panel.children].map((child) => child.className.split(" ")[0] || child.tagName.toLowerCase()))
 *
 * Two rounds of manual probing produced repeated mistakes that this fixture is meant to
 * prevent: comparing the first child only (which hid that `.wf-summary` had absorbed its
 * siblings), and counting elements (which could not tell `details > table` from a bare
 * table).
 *
 * `null` means "this screen has no such panel".
 */
export type PanelComposition = readonly string[];

export const PROTOTYPE_PANELS: Readonly<Record<string, readonly PanelComposition[]>> = {
  // The active workflow, the trend chart, the residual counts, the milestones, the
  // latest iteration. Note the first one: its plan `table` is a child of the PANEL, after
  // the body, and the fourth carries a `panel-foot`.
  overview: [
    ["panel-head", "panel-body", "table"],
    ["panel-head", "chart-wrap"],
    ["panel-head", "panel-body"],
    ["panel-head", "panel-body", "panel-foot"],
    ["panel-head", "panel-body"],
  ],
  // The trend (chart + disclosure inside `.chart-wrap`) and the filter panel, whose table
  // sits between the filters div and the foot.
  issues: [
    ["panel-head", "chart-wrap"],
    ["panel-head", "div", "table-wrap", "panel-foot"],
  ],
  workflows: [["panel-head", "table-wrap", "panel-foot"]],
  iterations: [["panel-head", "table-wrap", "panel-foot"]],
  // An unclassed div holds the rows, not a `.panel-body`.
  projects: [["panel-head", "div", "panel-foot"]],
};

/**
 * How the prototype nests the disclosure under the issues trend: the `details` is INSIDE
 * `.chart-wrap`, not a sibling of it. Recorded separately because the panel fixture above
 * stops at the panel's direct children.
 */
export const PROTOTYPE_DISCLOSURE_ANCESTRY = ["section.panel", "div.chart-wrap", "details.disc"];

/**
 * Where the disclosure's table sits: `panel > chart-wrap > details > table`.
 */
export const PROTOTYPE_FLOW_TABLE_ANCESTRY = [
  "section.panel",
  "div.chart-wrap",
  "details.disc",
  "table.mini-table",
];
