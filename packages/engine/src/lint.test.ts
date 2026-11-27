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
});
