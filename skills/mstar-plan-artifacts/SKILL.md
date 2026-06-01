---
name: mstar-plan-artifacts
description: Morning Star plan harness artifacts — `{PLAN_DIR}` main plans and `reports/`, `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` indexes, Done compaction, plus `{HARNESS_DIR}/status.json` and root `residual_findings` (severity SSOT, open/archived lifecycle, `notes.json`). Read when writing plans or QC reports, maintaining knowledge/iteration indexes, reading or writing `status.json` / R#, Done compaction, or mapping QC severity to JSON. Required for `@project-manager` on status, residuals, and InReview/QC waves; `@qc-specialist*` before `reports/**/*.md`; `@qa-engineer` before closing R#. Verdict rules in `mstar-review-qc`; paths in `mstar-plan-conventions`.
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-plan-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, reports naming, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| Done row compaction Profile A/B | `references/done-compaction.md` |
| `status.json`, residual severity, lifecycle, `jq` | `references/status-and-residuals.md` |
| Empty-repo `status.json` / `notes.json` templates | `templates/status.empty.json`, `templates/notes.empty.json` (`templates/README.md`) |
| Tech-debt rollup (read-only) | `scripts/tech-debt-rollup.sh` |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; QC checklist and verdict → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-plan-conventions`**.

## `status.json` and open residual (summary)

- **`{HARNESS_DIR}/status.json`**: `plans[]` row status + root **`residual_findings[<plan-id>]`** (open list **SSOT**).
- **Canonical**: register new findings only at root `residual_findings`; **`metadata.residual_findings`** is legacy read-only — **do not** dual-write.
- **Lifecycle**: open → verified close → **`archived/residuals/<plan-id>.json`**; machine **`severity`** enum in reference.
- **`notes.json`**, optional **`tech_debt_summary`** (rollup view; compute via **`scripts/tech-debt-rollup.sh`**).

Field semantics, severity mapping, archive flow, and `jq` examples → **`references/status-and-residuals.md`**.

**Templates (this skill):** `templates/status.empty.json`, `templates/notes.empty.json` — copy into `{HARNESS_DIR}/` (`templates/README.md`).
