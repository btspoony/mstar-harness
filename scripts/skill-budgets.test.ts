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

  // One logical line = one line break of any convention. CRLF is one break, and
  // a bare CR is a break too, so a CR-only file cannot pass as a single line.
  test("CRLF and bare CR each end a line", () => {
    const repo = fixture(
      {
        "skills/crlf/SKILL.md": "line 1\r\nline 2\r\n",
        "skills/bare-cr/SKILL.md": "line 1\rline 2\rline 3",
      },
      [
        { file: "skills/bare-cr/SKILL.md", maxLines: 2 },
        { file: "skills/crlf/SKILL.md", maxLines: 2 },
      ],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([
        { kind: "over-budget", file: "skills/bare-cr/SKILL.md", lines: 3, maxLines: 2 },
      ]);
    } finally {
      repo.close();
    }
  });

  // countLines counts logical lines, so a file with no trailing newline reports
  // one more line than `wc -l`. AGENTS.md requires exactly one trailing newline,
  // so a ceiling derived from `wc -l` can only ever be conservative here — never
  // permissive. Pin that direction; do not silently re-derive ceilings from `wc`.
  test("a file with no trailing newline counts one line more than wc -l", () => {
    const repo = fixture(
      { "skills/no-final-newline/SKILL.md": "line 1\nline 2\nline 3" },
      [{ file: "skills/no-final-newline/SKILL.md", maxLines: 2 }],
    );
    try {
      const result = checkSkillBudgets(repo.root, readSkillBudgets(repo.root));
      expect(result.failures).toEqual([
        { kind: "over-budget", file: "skills/no-final-newline/SKILL.md", lines: 3, maxLines: 2 },
      ]);
    } finally {
      repo.close();
    }
  });
});
