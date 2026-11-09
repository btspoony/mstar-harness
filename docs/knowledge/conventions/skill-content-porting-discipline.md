---
module: skills / skill-content porting
date: 2026-08-15
problem_type: convention
category: conventions
severity: medium
plan_id: 20260815-mstar-knowledge-prose-folds
tags:
  - skill-porting
  - standalone
  - one-home
  - evidence-bar
  - hygiene
applies_when:
  - "Porting content from an external skill repo (e.g. another harness's dev-skills) into mstar-* skills"
  - "Reviewing or planning folds of external prompt/skill material into this repository"
---

# Skill-content porting discipline (external skill → mstar-*)

## Context

Iteration iter-20260815-dsh-skills-adoption folded one external dev-skills survey into seven mstar-* skill files across three plans. The process surfaced four recurring failure modes that a porter must check explicitly — none are caught by tests.

## Guidance

1. **Verify the target file's actual language/style before writing.** A locked plan asserted "English body" for two files whose bodies are zh (review-chain correction, architect pass). Read the target file first; fold in its style (zh body + English term names where the target does so).
2. **Self-referential leakage check.** Folded rubric text itself must pass its own HEAD-resolvability test — the QC catch of the iteration: a hygiene-rubric section shipped with a trailing harness-orchestration aside ("前向引用合法") that no HEAD reader could resolve (fix f9acaf1). Durable skill text never cites plan-relative labels ("T3", "本迭代") or ephemeral artifacts.
3. **No ephemeral citations in durable skill text.** A calibration line citing an SDD task report or naming survey-source families (`dsh-*`) violates standalone + survives nothing (QC fix d5b6857 → point at durable plan evidence, generalize names). Instances/examples cite in-repo artifacts only.
4. **One-home grep before folding.** Confirm the rule does not already live in an adjacent skill; folds use pointers/互指, not copies (enforcement-vs-security lens boundary; complete-proposition single home with a pointer from the knowledge-doc subset).
5. **Evidence per fold (P6).** Each fold carries one concrete application case (a real file or a real past finding class) in the task report — line-budget + grep evidence alone does not prove the rule is usable.
6. **Follow the actual delegated reader.** Moving shared rules or a finding template into a canonical file also changes every non-inheriting seat's read contract: update full-audit prompt ingredients and executable PR-seat prompt generators with absolute loaded-skill paths and exact headings. Verify the real generated prompt and an isolated reader; a parent-skill excerpt probe alone misses this boundary.

## Why This Matters

Skill text is behavior-shaping; a porting defect (wrong language, dead citation, duplicated rule, or missing consumer handoff) ships to every consumer of the harness. Check both the canonical owner and the actual dispatched reader; static validation does not prove model compliance.

## When to Apply

Any task whose diff touches `skills/**` with content sourced from outside this repository — at plan self-review (QC1/QC2 focus lists) and at implementer self-review.

## Examples

- Language/style: `deep-review-lenses.md` zh body — plan corrected in Phase 1 chain, not by QC.
- Self-referential leak: `compound-workflow.md` §3.5 trailing meta removed in fix wave.
- Ephemeral citation: an early `compound-refresh` calibration line was repointed from a task report to a durable plan gate summary (that skill is now `mstar-knowledge` `## Workflow — Maintain`).
- One-home: complete-proposition rule exists exactly twice in `skills/` (SSOT + pointer) — grep-verified by two QC seats.
- Consumer handoff: Ponytail distillation initially updated the canonical investigation/template owners but missed non-inheriting full-audit seats and generated Stage-2 PR seats; direct handoffs and actual generated-output/read-following proof repaired the gap.
- Source representation: preserve the existing ASCII literal convention when adding prompt strings; `\u2014` and a raw em dash render identically, but only the escaped source passes the repository guard. Run that mapped guard without weakening it or rerunning unrelated suites.
