# Plan harness file templates

Copy these into `{HARNESS_DIR}` when bootstrapping a project. Path symbols (`{HARNESS_DIR}`, `{PLAN_DIR}`, …) → **`mstar-conventions`**. Field semantics and residual lifecycle → **`mstar-artifacts/references/status-and-residuals.md`**. Optional rollup: engine `techDebtRollup` import (read-only; see that reference).

| File | Copy to | Notes |
|------|---------|--------|
| `status.empty.json` | `{HARNESS_DIR}/status.json` | The **v2 root register** shape (`version: 2`, `updated_at`, `workflows: []`) — see **`mstar-artifacts` SKILL.md** + `references/status-and-residuals.md`. Replace `updated_at` with the real date. Per-lifecycle snapshot / register / lease fields are created at runtime by engine writers (`workflows/<id>/snapshot.json`, `projects/<id>/residuals.json`) — not in the empty template. |
