/**
 * scripts/rule-duplication.ts — Guard 10 semantics. Pins the cross-file
 * duplicate HARD-rule contract: a rule sentence stated in two files fails with
 * both sites named; a line that *is* a pointer into the canonical skill is
 * exempt while retaining the wording and appending a pointer is not;
 * Markdown-only variation (markers, indentation, backticks) and a leading BOM
 * do not defeat normalization; an allowlisted site is reported as exempt
 * instead of failing; and ordinary repeated prose is never a rule fingerprint.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RULE_DUPLICATION_ALLOWLIST,
  checkRuleDuplication,
  normalizeRuleLine,
  ruleFingerprintHash,
} from "./rule-duplication.ts";

function fixture(
  files: Record<string, string>,
  allowlist: unknown = [],
): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rule-duplication-"));
  const write = (rel: string, content: string): void => {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(RULE_DUPLICATION_ALLOWLIST, `${JSON.stringify(allowlist, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Three consecutive rule lines; every line stays under the 8-word single-line threshold. */
const BLOCK = [
  "- NEVER dispatch subagents from a leaf session.",
  "- MUST keep the assignment identity lock.",
  "- NEVER widen scope without PM approval.",
];

/** One rule sentence: a `NEVER` token and exactly 8 words. */
const RULE = "- NEVER dispatch subagents from a leaf session, ever.";

describe("rule duplication", () => {
  test("the same >=3-line rule block in two files fails with both file:line hits", () => {
    const repo = fixture({
      "skills/a/SKILL.md": `${BLOCK.join("\n")}\n`,
      "skills/b/SKILL.md": `# Other\n\n${BLOCK.join("\n")}\n`,
    });
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].hits).toEqual([
        { file: "skills/a/SKILL.md", line: 1 },
        { file: "skills/b/SKILL.md", line: 3 },
      ]);
    } finally {
      repo.close();
    }
  });

  test("only a line that is the pointer is exempt", () => {
    // A pointer line replaces the wording, so there is nothing left to duplicate.
    const pointerOnly = fixture({
      "skills/a/SKILL.md": `# Rules\n\n${RULE}\n`,
      "skills/b/SKILL.md": `# Rules\n\n→ \`other-skill\` § Section\n`,
    });
    try {
      const result = checkRuleDuplication(pointerOnly.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toEqual([]);
    } finally {
      pointerOnly.close();
    }

    // Retaining the wording and appending a pointer exempts nothing: the second
    // file still states the rule, so the group is a duplicate.
    const appended = fixture({
      "skills/a/SKILL.md": `# Rules\n\n${RULE}\n`,
      "skills/b/SKILL.md": `# Rules\n\n${RULE} → \`other-skill\` § Section\n`,
    });
    try {
      const result = checkRuleDuplication(appended.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].hits).toEqual([
        { file: "skills/a/SKILL.md", line: 3 },
        { file: "skills/b/SKILL.md", line: 3 },
      ]);
    } finally {
      appended.close();
    }

    // An arrow-first line that states a rule of its own is not a pointer either.
    const ruleAfterArrow = "→ `other-skill` § Section — NEVER widen scope without an approved plan.";
    const arrowRule = fixture({
      "skills/a/SKILL.md": `${ruleAfterArrow}\n`,
      "skills/b/SKILL.md": `${ruleAfterArrow}\n`,
    });
    try {
      const result = checkRuleDuplication(arrowRule.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toHaveLength(1);
    } finally {
      arrowRule.close();
    }
  });

  test("a leading BOM does not change line 1's fingerprint", () => {
    const repo = fixture({
      "skills/a/SKILL.md": `\uFEFF${RULE}\n`,
      "skills/b/SKILL.md": `${RULE}\n`,
    });
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].hits).toEqual([
        { file: "skills/a/SKILL.md", line: 1 },
        { file: "skills/b/SKILL.md", line: 1 },
      ]);
    } finally {
      repo.close();
    }
  });

  test("markers, indentation and backticks do not defeat normalization", () => {
    const repo = fixture({
      "skills/a/SKILL.md": `${BLOCK.join("\n")}\n`,
      "skills/b/SKILL.md": [
        "  *   NEVER   dispatch subagents from a leaf session.",
        "> * MUST keep the assignment identity lock.",
        "\t* NEVER widen scope without `PM` approval.",
        "",
      ].join("\n"),
    });
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].hits).toHaveLength(2);
    } finally {
      repo.close();
    }
  });

  test("an allowlisted hit passes and is reported as exempt", () => {
    const hash = ruleFingerprintHash(normalizeRuleLine(RULE));
    const repo = fixture(
      {
        "skills/a/SKILL.md": `${RULE}\n`,
        "skills/b/SKILL.md": `${RULE}\n`,
      },
      [
        {
          file: "skills/a/SKILL.md",
          normalizedHash: hash,
          reason: "skills/a/SKILL.md owns the canonical wording; the copy is frozen history",
        },
      ],
    );
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.allowlistFailures).toEqual([]);
      expect(result.duplicates).toEqual([]);
      expect(result.exemptGroups).toHaveLength(1);
      expect(result.exemptGroups[0].exempt).toEqual([{ file: "skills/a/SKILL.md", line: 1 }]);
    } finally {
      repo.close();
    }

    // An exception whose reason does not name the owning file fails the entry.
    const unreasoned = fixture(
      {
        "skills/a/SKILL.md": `${RULE}\n`,
        "skills/b/SKILL.md": `${RULE}\n`,
      },
      [{ file: "skills/a/SKILL.md", normalizedHash: hash, reason: "frozen history" }],
    );
    try {
      const result = checkRuleDuplication(unreasoned.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.allowlistFailures).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
    } finally {
      unreasoned.close();
    }
  });

  test("ordinary repeated prose never matches — no rule signal, no fingerprint", () => {
    const prose = [
      "The plan keeps the branch in sync with the remote.",
      "The review bundle lands in the harness directory.",
      "The ledger records the task completion.",
    ].join("\n");
    const repo = fixture({
      "skills/a/SKILL.md": `${prose}\n`,
      "skills/b/SKILL.md": `${prose}\n`,
      // A lower-case token is prose too: the rule text stays case-sensitive.
      "skills/c/SKILL.md": "- never dispatch subagents from a leaf session, ever.\n",
      "skills/d/SKILL.md": "- never dispatch subagents from a leaf session, ever.\n",
    });
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
        "skills/c/SKILL.md",
        "skills/d/SKILL.md",
      ]);
      expect(result.duplicates).toEqual([]);
      expect(result.exemptGroups).toEqual([]);
    } finally {
      repo.close();
    }
  });
});
