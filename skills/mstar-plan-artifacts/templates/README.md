# Plan harness file templates

Copy these into `{HARNESS_DIR}` when bootstrapping a project. Path symbols (`{HARNESS_DIR}`, `{PLAN_DIR}`, …) → **`mstar-plan-conventions`**. Field semantics and residual lifecycle → **`mstar-plan-artifacts/references/status-and-residuals.md`**. Optional rollup: **`../scripts/tech-debt-rollup.sh`** (read-only; see that reference).

| File | Copy to | Notes |
|------|---------|--------|
| `status.empty.json` | `{HARNESS_DIR}/status.json` | Root `residual_findings` only (see **`mstar-plan-artifacts` SKILL.md**). Replace `updated_at` with the real date. |
| `notes.empty.json` | `{HARNESS_DIR}/notes.json` | Optional program timeline. Replace `updated_at` when first edited. |
