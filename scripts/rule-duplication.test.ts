/**
 * scripts/rule-duplication.ts — Guard 10 semantics. Pins the cross-file
 * duplicate HARD-rule contract: a rule sentence stated in two files fails with
 * both sites named; a line that *is* a pointer into the canonical skill is
 * exempt while retaining the wording and appending a pointer is not;
 * Markdown-only variation (markers, indentation, backticks) and a leading BOM
 * do not defeat normalization; an allowlisted site is reported as exempt
 * instead of failing; and ordinary repeated prose is never a rule fingerprint.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RULE_DUPLICATION_ALLOWLIST,
  checkRuleDuplication,
  normalizeRuleLine,
  readRuleDuplicationAllowlist,
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
          file: "skills/b/SKILL.md",
          normalizedHash: hash,
          reason: "skills/a/SKILL.md owns the canonical wording; this copy is frozen history",
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
      expect(result.exemptGroups[0].exempt).toEqual([{ file: "skills/b/SKILL.md", line: 1 }]);
    } finally {
      repo.close();
    }

    // An exception whose reason names no owner fails the entry.
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

  test("an allowlist reason names the owner, never just the entry's own file", () => {
    const hash = ruleFingerprintHash(normalizeRuleLine(RULE));
    const read = (reason: string) => {
      const repo = fixture(
        {
          "skills/a/SKILL.md": `${RULE}\n`,
          "skills/b/SKILL.md": `${RULE}\n`,
        },
        [{ file: "skills/b/SKILL.md", normalizedHash: hash, reason }],
      );
      try {
        return readRuleDuplicationAllowlist(repo.root);
      } finally {
        repo.close();
      }
    };

    // The owner is another skill file: naming that path is the owner claim.
    const ownerPath = read("skills/a/SKILL.md owns the canonical wording; this copy is frozen history");
    expect(ownerPath.failures).toEqual([]);
    expect(ownerPath.entries).toHaveLength(1);

    // This entry is itself the owner: its own file plus the word `owner` passes.
    const selfOwned = read("skills/b/SKILL.md is the owner; the duplicate site was retired");
    expect(selfOwned.failures).toEqual([]);
    expect(selfOwned.entries).toHaveLength(1);

    // Naming only the covered file identifies no owner, so the entry fails.
    const selfNamed = read("skills/b/SKILL.md keeps a frozen copy");
    expect(selfNamed.entries).toEqual([]);
    expect(selfNamed.failures).toHaveLength(1);
    expect(selfNamed.failures[0]).toContain("skills/b/SKILL.md");
  });

  test("an allowlist entry whose site is gone is reported by name", () => {
    const hash = ruleFingerprintHash(normalizeRuleLine(RULE));
    const staleHash = ruleFingerprintHash("- NEVER retire a rule site.");
    const repo = fixture(
      {
        "skills/a/SKILL.md": `${RULE}\n`,
        "skills/b/SKILL.md": `${RULE}\n`,
      },
      [
        { file: "skills/b/SKILL.md", normalizedHash: hash, reason: "skills/a/SKILL.md owns the canonical wording" },
        { file: "skills/a/SKILL.md", normalizedHash: staleHash, reason: "skills/b/SKILL.md owns the retired wording" },
      ],
    );
    try {
      const result = checkRuleDuplication(repo.root, [
        "skills/a/SKILL.md",
        "skills/b/SKILL.md",
      ]);
      expect(result.allowlistFailures).toHaveLength(1);
      expect(result.allowlistFailures[0]).toContain("skills/a/SKILL.md");
      expect(result.allowlistFailures[0]).toContain(staleHash);
      expect(result.allowlistFailures[0]).toContain("matches no scanned rule site");
      // The live entry still exempts its site; the stale row never joins a group.
      expect(result.duplicates).toEqual([]);
      expect(result.exemptGroups).toHaveLength(1);
    } finally {
      repo.close();
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

describe("Guard 10 blocking (drift-lint executable)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const SCRIPT = join(REPO_ROOT, "scripts/drift-lint.ts");
  /** Inputs the executable reads before Guard 10 runs; a missing one aborts the run. */
  const REQUIRED_INPUTS = [
    "packages/engine/src/index.ts",
    "packages/cli/package.json",
    "packages/cli/src/command-adapter.ts",
    "README.md",
    "README_CN.md",
  ];

  /** Run the guard executable over a temp repo carrying only Guard 10 inputs. */
  function runGuard10(
    allowlist: unknown[],
    populate: (dir: string) => void,
  ): { status: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "drift-guard10-"));
    try {
      for (const rel of [...REQUIRED_INPUTS, RULE_DUPLICATION_ALLOWLIST]) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(
          dest,
          rel === RULE_DUPLICATION_ALLOWLIST
            ? `${JSON.stringify(allowlist, null, 2)}\n`
            : readFileSync(join(REPO_ROOT, rel), "utf8"),
        );
      }
      populate(dir);
      try {
        execFileSync("bun", [SCRIPT], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return { status: 0, stderr: "" };
      } catch (error) {
        const err = error as { status?: number; stderr?: string };
        return { status: err.status ?? 0, stderr: String(err.stderr ?? "") };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeSkill(dir: string, skill: string, content: string): void {
    const dest = join(dir, "skills", skill, "SKILL.md");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }

  test("a duplicated rule group exits non-zero and names both sites", () => {
    const { status, stderr } = runGuard10([], (dir) => {
      for (const skill of ["mstar-alpha", "mstar-beta"]) writeSkill(dir, skill, `${RULE}\n`);
    });
    expect(status).toBe(1);
    // A failure row (not the old `advisory:` notice) is what enters `failures` and exits non-zero.
    expect(stderr).toMatch(/✗ Guard 10 duplicate HARD rules/);
    expect(stderr).toContain("skills/mstar-alpha/SKILL.md:1");
    expect(stderr).toContain("skills/mstar-beta/SKILL.md:1");
  });

  test("a partially allowlisted group names its exempt sites on the failure row", () => {
    const { status, stderr } = runGuard10(
      [
        {
          file: "skills/mstar-gamma/SKILL.md",
          normalizedHash: ruleFingerprintHash(normalizeRuleLine(RULE)),
          reason: "skills/mstar-gamma/SKILL.md keeps a frozen copy; skills/mstar-alpha/SKILL.md owns the rule",
        },
      ],
      (dir) => {
        for (const skill of ["mstar-alpha", "mstar-beta", "mstar-gamma"]) {
          writeSkill(dir, skill, `${RULE}\n`);
        }
      },
    );
    expect(status).toBe(1);
    const row = stderr.split("\n").find((line) => line.includes("Guard 10 duplicate HARD rules")) ?? "";
    expect(row).toContain("skills/mstar-alpha/SKILL.md:1");
    expect(row).toContain("skills/mstar-beta/SKILL.md:1");
    expect(row).toContain("1 exempt: skills/mstar-gamma/SKILL.md:1");
  });

  test("a symlinked skill file is skipped, not read into the guards", () => {
    const outside = mkdtempSync(join(tmpdir(), "drift-symlink-target-"));
    try {
      const target = join(outside, "SKILL.md");
      writeFileSync(target, `${RULE}\n`);
      // Were the symlink collected, it would pair with mstar-alpha and fail as
      // a duplicate group; the regular copy alone must not.
      const { stderr } = runGuard10([], (dir) => {
        writeSkill(dir, "mstar-alpha", `${RULE}\n`);
        const link = join(dir, "skills", "mstar-beta", "SKILL.md");
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link);
      });
      expect(stderr).not.toMatch(/✗ Guard 10 duplicate HARD rules/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
