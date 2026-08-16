/**
 * Engine skill-authoring module — frontmatter lint, 5-question body lint,
 * and skill-relative asset-path resolution (thin; roadmap §8.2
 * `skill-authoring` row, §4.5).
 *
 * Source skills (semantic SSOT — this module implements their deterministic
 * rules, it never redefines them; roadmap §8.5 C2):
 * - `mstar-skill-authoring` SKILL.md § Frontmatter Contract — `name` stable
 *   lowercase-hyphen; `description` is the trigger contract (not a workflow
 *   summary), third person.
 * - `mstar-skill-authoring` SKILL.md § Body 必须回答的 5 问 + § 默认 Body
 *   结构 — a SKILL.md body answers five questions via key sections (Load
 *   Order, Workflow, Decision Rules, Evidence, References).
 * - `mstar-skill-authoring` SKILL.md § Skill-relative script and asset
 *   paths ("skill `my-skill` → scripts/do-thing") + `mstar-host` SKILL.md
 *   § Resolve loaded skill root (per-host resolution).
 *
 * The SkillsBench six principles and trigger-contract reasoning stay prompt.
 */
import type { GateResult, Severity, ValidationResult } from "./core.js";
import { lintSkillFrontmatter } from "./lint.js";
import { resolveSkillRoot, type HostId } from "./host.js";

/**
 * Lint a skill file's frontmatter (mstar-skill-authoring § Frontmatter
 * Contract): `name` lowercase-hyphen, `description` present / third-person /
 * not a workflow summary. Re-exports `lint.lintSkillFrontmatter` — the
 * single parser/heuristics implementation (one source of truth; the CLI
 * `mstar skill lint` calls this alias). Violations keep the `lint.frontmatter.*`
 * codes.
 */
export { lintSkillFrontmatter as lintFrontmatter } from "./lint.js";

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** One of the five body questions and the canonical section that answers it
 * (mstar-skill-authoring § Body 必须回答的 5 问 / § 默认 Body 结构). */
export type FiveQuestionSection = {
  key: string;
  label: string;
  question: string;
};

export const FIVE_QUESTION_SECTIONS: readonly FiveQuestionSection[] = [
  { key: "load-order", label: "Load Order", question: "when to load the skill (triggers / exclusions)" },
  { key: "workflow", label: "Workflow", question: "the order of execution and key decision points" },
  { key: "decision-rules", label: "Decision Rules", question: "constraints / invariants that must never be violated" },
  { key: "evidence", label: "Evidence", question: "what a correct result looks like (success criteria / evidence)" },
  { key: "references", label: "References", question: "additional resources to open when the main path is not enough" },
];

const HEADING_RE = /^#{1,6}\s+[^\r\n]+$/;

/**
 * Lint a SKILL.md body for the 5-question contract (mstar-skill-authoring
 * § Body 必须回答的 5 问). Heuristic: each of the five questions must be
 * answered by the presence of its canonical section heading (case-
 * insensitive substring match on heading text, any heading level — so
 * "## Load Order (Required)" and "### Workflow — main path" both match).
 * Content judgment (whether the answer is actually narrow / procedural)
 * stays prompt. Advisory: violations are `low` severity (v1 non-blocking).
 *
 * Violations: `skill-authoring.five-question.<key>` for each uncovered
 * question.
 */
export function lintFiveQuestion(bodyText: string): GateResult {
  const headings = bodyText
    .split(/\r?\n/)
    .filter((line) => HEADING_RE.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim().toLowerCase());
  const violations: ValidationResult[] = [];
  for (const section of FIVE_QUESTION_SECTIONS) {
    const label = section.label.toLowerCase();
    const covered = headings.some((heading) => heading.includes(label));
    if (!covered) {
      violations.push(
        violation(
          "low",
          `skill-authoring.five-question.${section.key}`,
          `body does not answer "${section.question}" \u2014 no "${section.label}" section (mstar-skill-authoring \u00a7 Body \u5fc5\u987b\u56de\u7b54\u7684 5 \u95ee / \u00a7 \u9ed8\u8ba4 Body \u7ed3\u6784)`,
          `add a "## ${section.label}" section covering ${section.question}`,
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Resolve a skill-relative asset path (mstar-skill-authoring § Skill-
 * relative script and asset paths: name assets as skill `<name>` →
 * `scripts/…` / `references/…`; never a literal `skills/<name>/…` path from
 * a consumer cwd) into the host-specific resolution instruction
 * (mstar-host § Resolve loaded skill root). No filesystem access — this is
 * an instruction string an agent reads to find the asset.
 */
export function resolveAssetPath(skillName: string, relPath: string, host: HostId): string {
  return `skill \`${skillName}\` \u2192 ${relPath} (${resolveSkillRoot(host, { skill: skillName, rel: relPath })})`;
}
