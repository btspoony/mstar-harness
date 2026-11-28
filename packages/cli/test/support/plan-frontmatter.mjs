/**
 * The one shared plan-fixture renderer for cli tests: every migrated test
 * writes plan documents through this renderer so the front-matter contract
 * shape is maintained in exactly one place.
 * see docs/knowledge/conventions/plan-frontmatter-declarations.md
 */

/** Render a plan markdown whose declarations live in the front matter fence. */
export function planFrontMatter(planId, body, fields = {}) {
  return [
    "---",
    `plan_id: ${planId}`,
    ...(fields.title === undefined ? [] : [`title: ${fields.title}`]),
    `execution: ${fields.execution ?? "sdd"}`,
    `working_branch: ${fields.working_branch ?? "main"}`,
    `main_worktree_branch: ${fields.main_worktree_branch ?? "main"}`,
    `delivery_kind: ${fields.delivery_kind ?? "development"}`,
    `status: ${fields.status ?? "InProgress"}`,
    "---",
    "",
    body,
  ].join("\n");
}
