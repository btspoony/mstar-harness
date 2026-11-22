import { describe, expect, test } from "bun:test";
import { findCommentPointers, findUnclassifiedComments } from "./lint.js";

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
