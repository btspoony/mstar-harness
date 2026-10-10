# Plan harness file templates

Templates in this directory are authored plan shapes, not execution-authority seeds. Path symbols (`{HARNESS_DIR}`, `{PLAN_DIR}`, …) → **`mstar-conventions`**. Field semantics and residual lifecycle → **`mstar-artifacts/references/status-and-residuals.md`**. Optional rollup: `mstar status tech-debt` (read-only open-issue rollup over the issue store; see that reference).

Bootstrap is `mstar harness scaffold` then `mstar store init`. Scaffold does not write a root `status.json`. A workspace that still holds historical file state imports it with `mstar store upgrade` (`mstar migrate` first when the tree is still v1). There is no empty status template.

| File | Use | Notes |
|------|-----|--------|
| `plan.main.md` | main plan shape under `{PLAN_DIR}` | Global Constraints and Interfaces skeleton. Not an execution-state file. |
