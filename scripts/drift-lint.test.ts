/**
 * scripts/drift-lint.ts — guard semantics (QC fix wave: W-1/F-001, W-2,
 * S-1/F-002). Pins the committed guard behavior that previously had zero
 * automated coverage:
 * - checkBilingualPairing (guard 2 pairing logic) — all four change sets.
 * - evaluateBilingualGuard — the CI fail-loudly contract (GITHUB_ACTIONS
 *   env injection): a null range fails in CI, skips locally; an empty range
 *   (direct-to-main push) skips by design; a non-empty range runs the check.
 * - extractCategoryRowTokens (guard 1) — the docs/cli.md `<category>` row
 *   yields exactly AUDIT_CATEGORIES; fabricated tokens are kept for the
 *   membership check; `Category` / `<category>` placeholders are filtered.
 * - citesKnowledgeConventions (W-2) — the exemption is anchored to the
 *   cited token itself (the citation path starts with `conventions/`);
 *   proximity alone no longer exempts unrelated citations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AUDIT_CATEGORIES } from "../packages/engine/src/index.ts";
import {
  checkBilingualPairing,
  citesKnowledgeConventions,
  evaluateBilingualGuard,
  extractCategoryRowTokens,
  isGitHubActions,
} from "./drift-lint.ts";

describe("checkBilingualPairing — README pairing logic (guard 2)", () => {
  test("both READMEs changed passes", () => {
    expect(checkBilingualPairing(["README.md", "README_CN.md", "docs/cli.md"])).toEqual([]);
  });

  test("neither README changed passes", () => {
    expect(checkBilingualPairing(["docs/cli.md", "scripts/drift-lint.ts"])).toEqual([]);
  });

  test("empty change list passes", () => {
    expect(checkBilingualPairing([])).toEqual([]);
  });

  test("only README.md changed fails naming the missing CN file", () => {
    const failures = checkBilingualPairing(["README.md"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README.md changed but README_CN.md did not");
  });

  test("only README_CN.md changed fails naming the missing EN file", () => {
    const failures = checkBilingualPairing(["README_CN.md"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README_CN.md changed but README.md did not");
  });
});

describe("evaluateBilingualGuard — CI fail-loudly vs local skip (W-1/F-001)", () => {
  test("null range + GITHUB_ACTIONS fails loudly with a fetch-depth hint", () => {
    const out = evaluateBilingualGuard(null, { ci: true });
    if (out.status !== "failed") throw new Error(`expected failed, got ${out.status}`);
    expect(out.failures.length).toBe(1);
    expect(out.failures[0]).toContain("fetch-depth: 0");
  });

  test("null range + non-CI skips silently", () => {
    const out = evaluateBilingualGuard(null, { ci: false });
    if (out.status !== "skipped") throw new Error(`expected skipped, got ${out.status}`);
  });

  test("empty range (direct-to-main push) skips by design even in CI", () => {
    const out = evaluateBilingualGuard([], { ci: true });
    if (out.status !== "skipped") throw new Error(`expected skipped, got ${out.status}`);
    expect(out.reason).toContain("empty range");
  });

  test("non-empty range runs the pairing check in CI", () => {
    const unpaired = evaluateBilingualGuard(["README.md"], { ci: true });
    if (unpaired.status !== "checked") throw new Error(`expected checked, got ${unpaired.status}`);
    expect(unpaired.failures.length).toBe(1);
    const paired = evaluateBilingualGuard(["README.md", "README_CN.md"], { ci: true });
    if (paired.status !== "checked") throw new Error(`expected checked, got ${paired.status}`);
    expect(paired.failures).toEqual([]);
  });

  test("GITHUB_ACTIONS env var injection flips the guard to fail-loudly", () => {
    const prev = process.env.GITHUB_ACTIONS;
    try {
      process.env.GITHUB_ACTIONS = "true";
      expect(isGitHubActions()).toBe(true);
      const ciOut = evaluateBilingualGuard(null);
      if (ciOut.status !== "failed") throw new Error(`expected failed, got ${ciOut.status}`);
      process.env.GITHUB_ACTIONS = "false";
      expect(isGitHubActions()).toBe(false);
      const localOut = evaluateBilingualGuard(null);
      if (localOut.status !== "skipped") throw new Error(`expected skipped, got ${localOut.status}`);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
    }
  });
});

describe("extractCategoryRowTokens — docs/cli.md `<category>` row (guard 1)", () => {
  test("real docs/cli.md <category> row yields exactly AUDIT_CATEGORIES", () => {
    const cliMd = readFileSync(join(import.meta.dir, "..", "docs", "cli.md"), "utf8");
    const row = cliMd.split(/\r?\n/).find((l) => /^\|\s*`<category>`\s*\|/.test(l));
    expect(row).toBeDefined();
    expect(extractCategoryRowTokens(row!)).toEqual([...AUDIT_CATEGORIES]);
  });

  test("fabricated token is kept for the membership check (extraction is faithful)", () => {
    const row = "| `<category>` | recon then focus: `bug`, `deps` | all nine |";
    expect(extractCategoryRowTokens(row)).toEqual(["bug", "deps"]);
  });

  test("plan-field `Category` reference and `<category>` placeholder are filtered", () => {
    const row = "| `<category>` | plan `Category` field values: `bug` | all nine |";
    expect(extractCategoryRowTokens(row)).toEqual(["bug"]);
  });
});

describe("citesKnowledgeConventions — anchored exemption (W-2)", () => {
  const idxOf = (text: string, token: string) => text.indexOf(token);

  test("knowledge `conventions/<file>` citation is exempt", () => {
    const text = "spec: knowledge `conventions/skill-content-porting-discipline.md`";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("plain conventions/<file> (no knowledge prefix) is exempt", () => {
    const text = "spec: conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("parenthesized conventions/<file> is exempt", () => {
    const text = "(conventions/skill-content-porting-discipline.md)";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("x-conventions/<file> is NOT exempt (citation path must start with conventions/)", () => {
    const text = "spec: x-conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });

  test("sub/conventions/<file> is NOT exempt (citation path must start with conventions/)", () => {
    const text = "spec: sub/conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });

  test("unrelated skills/<file> citation is NOT exempt", () => {
    const text = "spec: skills/mstar-foo.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "mstar-foo.md"))).toBe(false);
  });

  test("nearby unrelated token is no longer swallowed by a prior conventions/ mention", () => {
    // The old 60-char proximity window exempted `missing.md` here because
    // "conventions/" appeared within 60 chars before it; the anchored check
    // exempts only the token immediately preceded by "conventions/".
    const text = "knowledge `conventions/real-doc.md`\n\nspec: typo'd missing.md on an adjacent line";
    expect(citesKnowledgeConventions(text, idxOf(text, "missing.md"))).toBe(false);
  });

  test("token on the next line after conventions/ is NOT exempt (path is broken)", () => {
    const text = "spec: conventions/\nskill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });
});
