---
name: codebase-audit
description: "Read-only codebase survey — a prioritized, evidence-backed review report of what is worth doing. Use standalone or before /iteration-start; scope keywords pick the effort level and focus. Never edits source."
agent: project-manager
input: "[quick|deep] [category|simplify|branch|next|roadmap]"
---

# Audit Codebase

A read-only advisory survey: no source edits, no state machine, no commits. Output is one review report at `{REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md`, written with `mstar audit scaffold` (run-directory flags → `mstar audit scaffold --help`).

## Boot

1. `mstar-harness-core`
2. `mstar-audit` → SKILL.md (common core) + `references/codebase-audit.md` (full-audit variant: nine categories, effort, scope variants, report writing)
3. `mstar-conventions` (path symbols) · `mstar-host` → active host reference (invoke capability; on dsh the large-repo fan-out runs the native `workflow` script from `references/dsh-workflow-scripts.md`)

## Execute

Execute **`mstar-audit`** end to end. Resolve the scope per `references/codebase-audit.md` (`bare` / `quick` / `deep` / category focus / `branch` / `next` / `roadmap` / `simplify`). PM dispatches `@code-reviewer` (`Task category: audit`); that role fans read-only `scout` / `explore` seats out only under the Assignment's delegation grant, and an `@architect` consult for architecture/tech-debt depth folds into its brief.
