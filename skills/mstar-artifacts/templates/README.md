# Plan harness file templates

Copy these into `{HARNESS_DIR}` when bootstrapping a project. Path symbols (`{HARNESS_DIR}`, `{PLAN_DIR}`, …) → **`mstar-conventions`**. Field semantics and residual lifecycle → **`mstar-artifacts/references/status-and-residuals.md`**. Optional rollup: `mstar status tech-debt` (read-only open-issue rollup over the issue store; see that reference).

| File | Copy to | Notes |
|------|---------|--------|
| `status.empty.json` | `{HARNESS_DIR}/status.json` | **Pre-activation bootstrap only**: v2 empty root (`version: 2`, `updated_at`, `workflows: []`); replace `updated_at` with the real date. `scaffoldHarness` retains this create-only seed. ACTIVE root/plan/lease/session authority is store.db, not root/snapshot files; their file route refuses read/write. Project residual registers are unconditionally retired migration history, never runtime-created targets. See **`mstar-artifacts` SKILL.md** + `references/status-and-residuals.md`. |
