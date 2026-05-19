---
name: mstar-status-residuals
description: Morning Star `{HARNESS_DIR}/status.json` and residual findings SSOT — root-level `residual_findings`, machine severity enum, open/closed/archived lifecycle, `plans[].metadata` branch fields, `notes.json` timeline, `tech_debt_summary`, common jq patterns. Read when reading or writing `.agents/status.json`, registering or closing R# items, PM consolidating QC into residuals, QA verifying closure, or mapping report severity to JSON. Required for `@project-manager` maintaining plan status and residuals; `@qc-specialist*` when PM will register severity; `@qa-engineer` before closing residuals. Not QC checklists (see `mstar-review-qc`). Path symbol `{HARNESS_DIR}` is defined in `mstar-plan-conventions`.
---

## Load order

**Before this skill:** Read `mstar-harness-core` (SKILL.md). If the task touches Git branch metadata (`working_branch`, `spec_integration_branch`) or pre-QC merge, also read **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope

- **`{HARNESS_DIR}/status.json`**: `plans[]` row state, root **`residual_findings`** (open list SSOT), standard `metadata` fields.
- **Residual lifecycle**: open → verified close → **`archived/residuals/<plan-id>.json`**; **severity** enum and QC report tier mapping.
- **`notes.json`**, **`tech_debt_summary`** (optional aggregate view).

**Out of scope:** QC checklists and verdict rules → **`mstar-review-qc`**; report file naming and QC waves → **`mstar-plan-artifacts`**; directory discovery and init → **`mstar-plan-conventions`**.

## Open residual (canonical summary)

- **Canonical**: root **`residual_findings[<plan-id>]`** alongside **`plans`**; **new writes go here only**.
- **`metadata.residual_findings`**: legacy read fallback only — **do not** dual-write for new work.
- Orchestration: trackable items belong in SSOT, not only in chat or a single QC report.

Full fields, jq, and branch metadata on `plans[].metadata` → **`references/status-and-residuals.md`**.

## Templates

Empty-repo copies: **`mstar-plan-conventions/templates/status.empty.json`**, **`templates/notes.empty.json`** (under `skills/mstar-plan-conventions/templates/` in this repo).

## References

- `references/status-and-residuals.md` — full SSOT structure, severity, lifecycle, archive, jq examples.
