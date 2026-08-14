/**
 * scripts/ci-dep-guard.ts — dep-tree guard semantics (qc2 F-004).
 *
 * The CI workflow pipes `npm ls --workspace @mstar-harness/opencode
 * --omit=dev` into `bun run ci:dep-guard`; this test pins the pattern
 * against realistic `npm ls` output lines — scoped `@inquirer/*` packages
 * MUST match (the roadmap's named anti-pattern), while `@commander-js/…`-style
 * names and bare tokens MUST NOT false-positive.
 */
import { describe, expect, test } from "bun:test";
import { findForbiddenDeps } from "./ci-dep-guard.ts";

describe("ci-dep-guard — opencode dep-tree forbidden packages (qc2 F-004)", () => {
  test("scoped @inquirer/* packages are caught (the slice-3 gap)", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
└── @inquirer/prompts@8.4.2
`;
    const hits = findForbiddenDeps(tree);
    expect(hits.some((h) => h.includes("@inquirer/prompts@8.4.2"))).toBe(true);
  });

  test("@inquirer/core and @inquirer/type are caught too", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
├── @inquirer/core@10.1.1
└── @inquirer/type@3.1.1
`;
    const hits = findForbiddenDeps(tree);
    expect(hits.some((h) => h.includes("@inquirer/core@10.1.1"))).toBe(true);
    expect(hits.some((h) => h.includes("@inquirer/type@3.1.1"))).toBe(true);
  });

  test("bare inquirer and commander lines are caught (unchanged slice-3 behavior)", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
├── commander@14.0.3
└── inquirer@10.0.0
`;
    const hits = findForbiddenDeps(tree);
    expect(hits.some((h) => h.includes("commander@14.0.3"))).toBe(true);
    expect(hits.some((h) => h.includes("inquirer@10.0.0"))).toBe(true);
  });

  test("@commander-js scoped names do NOT false-positive", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
└── @commander-js/reader@1.2.3
`;
    expect(findForbiddenDeps(tree)).toEqual([]);
  });

  test("bare tokens with wordy suffixes do NOT false-positive", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
└── commanderjs@1.0.0
└── inquirer-core@2.0.0
`;
    expect(findForbiddenDeps(tree)).toEqual([]);
  });

  test("clean tree and empty input pass", () => {
    const tree = `@mstar-harness/opencode@1.8.8 /repo/packages/opencode
├── @opencode-ai/plugin@1.4.8
└── @mstar-harness/engine@1.8.8
`;
    expect(findForbiddenDeps(tree)).toEqual([]);
    expect(findForbiddenDeps("")).toEqual([]);
  });
});
