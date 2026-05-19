---
name: mstar-plan-artifacts
description: Morning Star plan artifacts and archives — main plan naming and checkboxes, `{PLAN_DIR}/reports/` QC report naming and tri-review timing (single plan, multi-batch), residual vs main-plan index split, `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` / `{SPECS_DIR}` boundaries, Done row compaction Profile A/B. Read when writing or reading main plans, filing QC reports, maintaining knowledge/iteration indexes, Done compaction, or explaining reports vs status.json. Required for `@project-manager` InReview/QC waves; `@architect` / `@product-manager` for cross-session knowledge; `@qc-specialist*` before writing `reports/**/*.md`. `status.json` SSOT in `mstar-status-residuals`; verdict rules in `mstar-review-qc`.
---

## Load order

**Before this skill:** Read **`mstar-harness-core`**, then **`mstar-plan-conventions`** (path symbols) as needed. For residuals also read **`mstar-status-residuals`**. Pre-QC Git merge → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope

| Topic | Reference |
|-------|-----------|
| Main plan, reports naming, QC waves, residual index order | `references/plan-files-and-reports.md` |
| knowledge / iterations / specs split and README indexes | `references/knowledge-and-designs.md` |
| Done row archive Profile A/B | `references/done-compaction.md` |

**Out of scope:** `status.json` structure → **`mstar-status-residuals`**; branches/worktrees → **`mstar-branch-worktree`**; QC checklist template → **`mstar-review-qc`**.

## References

- `references/plan-files-and-reports.md`
- `references/knowledge-and-designs.md`
- `references/done-compaction.md`
