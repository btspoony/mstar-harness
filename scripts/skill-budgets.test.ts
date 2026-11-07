/**
 * scripts/skill-budgets.ts — Guard 9 semantics. Pins the per-file ceiling
 * contract over the shipped skill Markdown corpus: a file is over budget
 * only above its ceiling, and both directions of manifest drift fail — a
 * stale entry hides a deletion, a missing entry hides growth.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  SKILL_BUDGETS_MANIFEST,
  checkSkillBudgets,
  readSkillBudgets,
  type SkillBudget,
} from "./skill-budgets.ts";

/** Markdown body of `count` lines with a trailing newline (wc -l equivalent). */
function body(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
}

function fixture(
  files: Record<string, string>,
  manifest: SkillBudget[],
): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "skill-budgets-"));
  const write = (rel: string, content: string): void => {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write(SKILL_BUDGETS_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("skill budgets", () => {
  test("a file at exactly its ceiling passes", () => {
    const repo = fixture(
      { "skills/at-ceiling/SKILL.md": body(10), "skills/under/SKILL.md": body(5) },
      [
        { file: "skills/at-ceiling/SKILL.md", maxLines: 10 },
        { file: "skills/under/SKILL.md", maxLines: 20 },
      ],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([]);
      expect(result.filesChecked).toBe(2);
    } finally {
      repo.close();
    }
  });

  test("a file one line over its ceiling fails with file, lines and maxLines", () => {
    const repo = fixture(
      { "skills/over/SKILL.md": body(11), "skills/at-ceiling/SKILL.md": body(10) },
      [
        { file: "skills/over/SKILL.md", maxLines: 10 },
        { file: "skills/at-ceiling/SKILL.md", maxLines: 10 },
      ],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([
        { kind: "over-budget", file: "skills/over/SKILL.md", lines: 11, maxLines: 10 },
      ]);
      expect(result.filesChecked).toBe(2);
    } finally {
      repo.close();
    }
  });

  test("a ceiling for a missing file fails as manifest-stale", () => {
    const repo = fixture(
      { "skills/budgeted/SKILL.md": body(5) },
      [
        { file: "skills/budgeted/SKILL.md", maxLines: 20 },
        { file: "skills/gone/SKILL.md", maxLines: 10 },
      ],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([
        { kind: "manifest-stale", file: "skills/gone/SKILL.md", lines: null, maxLines: 10 },
      ]);
      expect(result.filesChecked).toBe(1);
    } finally {
      repo.close();
    }
  });

  test("a shipped skill file absent from the manifest fails as budget-missing", () => {
    const repo = fixture(
      { "skills/budgeted/SKILL.md": body(5), "skills/unbudgeted/SKILL.md": body(3) },
      [{ file: "skills/budgeted/SKILL.md", maxLines: 20 }],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([
        { kind: "budget-missing", file: "skills/unbudgeted/SKILL.md", lines: 3, maxLines: null },
      ]);
      expect(result.filesChecked).toBe(2);
    } finally {
      repo.close();
    }
  });
});
