/**
 * skill-budgets.ts — Guard 9: per-file line ceilings for the shipped skill
 * Markdown corpus. `scripts/skill-budgets.manifest.json` freezes every file's
 * ceiling at its current size (line count rounded up to a multiple of 10,
 * floor 20). A file that grows past its ceiling fails, and manifest drift
 * fails in both directions: a stale entry hides a deletion, a missing entry
 * hides growth.
 *
 * The ceiling is a guardrail, not a reduction target: a file at or below its
 * ceiling never has to shrink, and raising a ceiling is legal when the PR
 * justifies the words (relocate -> condense -> raise).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

export const SKILL_BUDGETS_MANIFEST = "scripts/skill-budgets.manifest.json";

export type SkillBudget = { file: string; maxLines: number };

export type SkillBudgetFailure = {
  kind: "over-budget" | "manifest-stale" | "budget-missing";
  file: string;
  /** Line count on disk; null when the file does not exist. */
  lines: number | null;
  /** Declared ceiling; null when the file has no manifest entry. */
  maxLines: number | null;
};

export type SkillBudgetResult = {
  filesChecked: number;
  failures: SkillBudgetFailure[];
};

/**
 * Read the manifest (`[{ "file": "skills/<skill>/<path>", "maxLines": N }]`,
 * sorted by path so each skill directory's files stay adjacent). The manifest
 * is SSOT, so an unreadable or malformed one throws instead of yielding an
 * empty budget set.
 */
export function readSkillBudgets(root: string): SkillBudget[] {
  const raw: unknown = JSON.parse(readFileSync(join(root, SKILL_BUDGETS_MANIFEST), "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${SKILL_BUDGETS_MANIFEST} must be an array of { file, maxLines } entries`);
  }
  return raw
    .map((entry) => {
      const { file, maxLines } = (entry ?? {}) as { file?: unknown; maxLines?: unknown };
      if (typeof file !== "string" || !file.startsWith("skills/")) {
        throw new Error(`${SKILL_BUDGETS_MANIFEST}: every entry needs a repo-relative "skills/..." file`);
      }
      if (typeof maxLines !== "number" || !Number.isInteger(maxLines) || maxLines <= 0) {
        throw new Error(`${SKILL_BUDGETS_MANIFEST}: "${file}" needs a positive integer maxLines`);
      }
      return { file, maxLines };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Compare every shipped skill Markdown file against its ceiling. */
export function checkSkillBudgets(root: string, budgets: SkillBudget[]): SkillBudgetResult {
  const ceilings = new Map(budgets.map((budget) => [budget.file, budget.maxLines]));
  const files = readdirSync(join(root, "skills"), { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => `skills/${rel.split(sep).join("/")}`)
    .sort();

  const failures: SkillBudgetFailure[] = [];
  for (const file of files) {
    const lines = countLines(readFileSync(join(root, file), "utf8"));
    const maxLines = ceilings.get(file);
    if (maxLines === undefined) {
      failures.push({ kind: "budget-missing", file, lines, maxLines: null });
      continue;
    }
    ceilings.delete(file);
    if (lines > maxLines) failures.push({ kind: "over-budget", file, lines, maxLines });
  }

  for (const file of [...ceilings.keys()].sort()) {
    failures.push({ kind: "manifest-stale", file, lines: null, maxLines: ceilings.get(file)! });
  }

  return { filesChecked: files.length, failures };
}

/** `wc -l`-equivalent count: newline-separated lines, one trailing newline ignored. */
function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
