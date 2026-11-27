import { describe, expect, test } from "bun:test";
import { findCommentPointers, findUnclassifiedComments, lintIterationCompass } from "./lint.js";

describe("findCommentPointers", () => {
  test("returns path targets with the comment span", () => {
    expect(findCommentPointers("// see docs/lock.md and packages/engine/src/lint.ts\n")).toEqual([
      { line: 1, startLine: 1, endLine: 1, target: "docs/lock.md" },
      { line: 1, startLine: 1, endLine: 1, target: "packages/engine/src/lint.ts" },
    ]);
    expect(findCommentPointers("/*\n * see skills/mstar-coding-behavior/references/comments.md\n */\nconst a = 1;\n")).toEqual([
      { line: 2, startLine: 1, endLine: 3, target: "skills/mstar-coding-behavior/references/comments.md" },
    ]);
  });

  test("a two-line block reports the pointer on its own line", () => {
    expect(findCommentPointers("/*\n * see docs/lock.md */\nconst a = 1;\n")).toEqual([
      { line: 2, startLine: 1, endLine: 2, target: "docs/lock.md" },
    ]);
  });

  test("a trailing sentence mark is not part of the path", () => {
    expect(findCommentPointers("// see docs/lock.md.\n")).toEqual([{ line: 1, startLine: 1, endLine: 1, target: "docs/lock.md" }]);
  });

  test("reads comment text only, never a string literal", () => {
    expect(findCommentPointers('const s = "docs/lock.md";\n')).toEqual([]);
    expect(findCommentPointers("// see docs/lock.md\nconst s = 'packages/engine';\n")).toEqual([
      { line: 1, startLine: 1, endLine: 1, target: "docs/lock.md" },
    ]);
  });

  test("accepts one optional ./ prefix and normalizes it away", () => {
    expect(findCommentPointers("// see ./docs/adr/README.md\n")).toEqual([
      { line: 1, startLine: 1, endLine: 1, target: "docs/adr/README.md" },
    ]);
    expect(findUnclassifiedComments("// see ./docs/adr/README.md\n")).toEqual([]);
  });

  test("path matching is case-sensitive and starts at a root boundary", () => {
    expect(findCommentPointers("// Docs/lock.md\n")).toEqual([]);
    expect(findCommentPointers("// assets/docs/adr/README.md\n")).toEqual([]);
    expect(findUnclassifiedComments("// Docs/lock.md\n")).toHaveLength(1);
    expect(findUnclassifiedComments("// assets/docs/adr/README.md\n")).toHaveLength(1);
  });

  test("an exported API doc block is exempt, like the unclassified finder", () => {
    expect(findCommentPointers("/** see docs/missing.md */\nexport function f() {}\n")).toEqual([]);
    expect(findCommentPointers("/** see docs/missing.md */\nconst x = 1;\n")).toEqual([
      { line: 1, startLine: 1, endLine: 1, target: "docs/missing.md" },
    ]);
  });

  test("leaves the pointer forms the linter cannot resolve out", () => {
    expect(findCommentPointers("// see https://example.com/docs/wire-format\n")).toEqual([]);
    expect(findCommentPointers("// see https://example.com/ADR-0007 for context\n")).toEqual([]);
    expect(findCommentPointers("// ADR-0007 owns this ordering\n")).toEqual([]);
    expect(findCommentPointers("// tracked in #123\n")).toEqual([]);
    expect(findCommentPointers("// issue 123 records the tradeoff\n")).toEqual([]);
    expect(findCommentPointers("// contract \u00a74.2\n")).toEqual([]);
  });

  test("a hash-dialect comment carries its pointer", () => {
    expect(findCommentPointers("# see scripts/comment-gate-select.sh\n", "hash")).toEqual([
      { line: 1, startLine: 1, endLine: 1, target: "scripts/comment-gate-select.sh" },
    ]);
  });
});

const COMPASS_HEAD = `# Iteration compass

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| p1-store | Store authority | Done | |
| p2-board | Planboard | InProgress | depends on p1 |
`;

const COMPASS_STACK_HEAD = `
## PR stack

| # | Accountable plan | Repo / PR | Branch refs | Witnessed base -> head | Readiness | Merge evidence |
|---|---|---|---|---|---|---|
`;

describe("lintIterationCompass", () => {
  test("a Done plan with no PR stack row is reported, naming the plan", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}| s1 | p2-board | o/r #7 | layer <- main | a -> b | reviewing | pending |\n`);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain("p1-store");
  });

  test("every Done plan carrying a row passes", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}| s1 | p1-store | o/r #6 | layer <- main | a -> b | ready | pending |\n| s2 | p2-board | o/r #7 | layer <- s1 | b -> c | reviewing | pending |\n`);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("an em-dash PR cell still counts as a row", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}| s1 | p1-store | \u2014 | layer <- main | a -> b | landed | empty range |\n`);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("a compass without a PR stack section is reported once", () => {
    const result = lintIterationCompass(COMPASS_HEAD);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-section"]);
  });

  test("a later table under the PR stack heading is not a row of the stack", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}
Prose between the real table and an example table.

| name | Accountable plan |
|---|---|
| example | p1-store |
`);
    expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-row"]);
    expect(result.violations[0]?.message).toContain("p1-store");
  });

  test("plan ids compare exactly, so p1 does not account for p_1", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p_1 | Underscored | Done |
| p1 | Plain | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1 | o/r #1 |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain('"p_1"');
  });

  test("prose before the Plans table does not hide its rows", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

This section tracks every plan layer of the iteration.

| plan_id | Name | Status |
|---|---|---|
| p1-store | Store authority | Done |

${COMPASS_STACK_HEAD}| s1 | p2-board | o/r #7 | layer <- main | a -> b | reviewing | pending |
`);
    expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-row"]);
    expect(result.violations[0]?.message).toContain("p1-store");
  });

  test("_p1_ is a literal id, distinct from p1", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| \`_p1_\` | Underscored | Done |
| p1 | Plain | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1 | o/r #1 |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain('"_p1_"');
  });

  test("bold wrapping a cell is formatting, not part of the id", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}| s1 | **p1-store** | \u2014 | layer <- main | a -> b | landed | empty range |
`);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("a code span keeps its contents literal", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p1 | Plain | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | \`**p1**\` | o/r #1 |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain('"p1"');
  });

  test("a code-formatted id keeps its literal marks in the diagnostic", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| \`**p1**\` | Marked | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1 | o/r #1 |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('"**p1**"');
  });

  test("an exactly code-formatted id matches its plan", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p1 | Plain | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | \`p1\` | o/r #1 |
`);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("a code span keeps leading and trailing spaces, so a padded id is another id", () => {
    const paddedStack = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}| s1 | \` p1-store \` | o/r #6 | layer <- main | a -> b | ready | pending |\n`);
    expect(paddedStack.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-row"]);
    expect(paddedStack.violations[0]?.message).toContain('plan "p1-store"');

    const paddedPlan = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| \` p1 \` | Padded | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1 | o/r #1 |
`);
    expect(paddedPlan.violations).toHaveLength(1);
    expect(paddedPlan.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(paddedPlan.violations[0]?.message).toContain('plan " p1 "');
  });

  test("an empty Plans table reports nothing", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
${COMPASS_STACK_HEAD}`);
    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("a plan that is not Done needs no PR stack row", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p2-board | Planboard | InProgress |
${COMPASS_STACK_HEAD}`);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("a fenced example table is not a row of the stack", () => {
    const result = lintIterationCompass(`${COMPASS_HEAD}${COMPASS_STACK_HEAD}
~~~
| s1 | p1-store | o/r #6 | layer <- main | a -> b | landed | merged |
~~~
`);
    expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-row"]);
    expect(result.violations[0]?.message).toContain("p1-store");
  });

  test("an escaped pipe in a Name cell stays cell content, so the Status cell still decides", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status | Notes |
|---|---|---|---|
| p-first | Import A \\| B | Done | |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p-later | o/r #7 |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain('"p-first"');
  });

  test("a PR stack table with no Accountable plan column accounts for nothing", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p-first | Import A | Done |

## PR stack

| Layer | Notes |
|---|---|
| s1 | p-first |
`);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.code).toBe("lint.iteration.pr-stack-missing-row");
    expect(result.violations[0]?.message).toContain('"p-first"');
    // The repair is the header, never a cell under a different column name.
    // see docs/adr/implemented/process/2026-11-27-iteration-layer-publication-lint.md
    expect(result.violations[0]?.message).toContain('"Accountable plan" column');
    expect(result.violations[0]?.fix).toContain("Accountable plan");
  });

  test("an unclosed fence hides the tail without throwing, and the hidden section reports", () => {
    const result = lintIterationCompass(`# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p1-store | Store | Done |

\`\`\`
## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1-store | o/r #6 |
`);
    expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-section"]);
    expect(result.violations[0]?.message).toContain('"p1-store"');
  });

  test("untilPlanId judges only the rows above it, and an id the table lacks leaves the lint's scan unfiltered", () => {
    const compass = `# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p1-store | Store | Done |
| p2-board | Board | Done |
${COMPASS_STACK_HEAD}`;
    const earlier = lintIterationCompass(compass, { untilPlanId: "p2-board" });
    expect(earlier.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-row"]);
    expect(earlier.violations[0]?.message).toContain("p1-store");
    expect(lintIterationCompass(compass, { untilPlanId: "p1-store" })).toEqual({ ok: true, violations: [] });
    // The LINT has no anchor to find, so it scans the whole table. That is the
    // unfiltered rule, not a safe completion window: `plan complete` must not
    // read this as "everything precedes me" (see execution-workflow.test.ts).
    // see docs/adr/implemented/process/2026-11-27-iteration-layer-publication-lint.md
    expect(lintIterationCompass(compass, { untilPlanId: "p9-absent" }).violations).toHaveLength(2);
  });

  test("an absent PR stack section leaves every Done plan unrecorded, and the window still bounds it", () => {
    const compass = `# Iteration compass

## Plans

| plan_id | Name | Status |
|---|---|---|
| p1-store | Store | Done |
| p2-board | Board | Done |
`;
    const all = lintIterationCompass(compass);
    expect(all.violations.map((violation) => violation.code)).toEqual(["lint.iteration.pr-stack-missing-section"]);
    expect(all.violations[0]?.message).toContain('"p1-store"');
    expect(all.violations[0]?.message).toContain('"p2-board"');
    // The earlier-plan window is not widened by the absent table: only the
    // plan above the completing one is named.
    // see docs/adr/implemented/process/2026-11-27-iteration-layer-publication-lint.md
    const earlier = lintIterationCompass(compass, { untilPlanId: "p2-board" });
    expect(earlier.violations[0]?.message).toContain('"p1-store"');
    expect(earlier.violations[0]?.message).not.toContain('"p2-board"');
  });

  test("a Plans table missing a consumed header is a named violation, never an empty obligation", () => {
    for (const [header, missing] of [
      ["| plan_id | Name | State |", "Status"],
      ["| id | Name | Status |", "plan_id"],
    ] as const) {
      const result = lintIterationCompass(`# Iteration compass

## Plans

${header}
|---|---|---|
| p1-store | Store | Done |

## PR stack

| # | Accountable plan | Repo / PR |
|---|---|---|
| s1 | p1-store | o/r #6 |
`);
      expect(result.ok).toBe(false);
      expect(result.violations.map((violation) => violation.code)).toEqual(["lint.iteration.plans-header-missing"]);
      expect(result.violations[0]?.message).toContain(`"${missing}"`);
      expect(result.violations[0]?.fix).toContain(missing);
      // The unreadable column would otherwise read as "no Done plan", so it
      // must never be reported as a satisfied obligation.
      // see docs/adr/implemented/process/2026-11-27-iteration-layer-publication-lint.md
      expect(result.violations[0]?.code).not.toBe("lint.iteration.pr-stack-missing-row");
    }
  });
});
