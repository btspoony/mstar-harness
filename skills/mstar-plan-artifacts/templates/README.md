# Plan harness file templates

Copy these into `{HARNESS_DIR}` when bootstrapping a project. Path symbols (`{HARNESS_DIR}`, `{PLAN_DIR}`, …) → **`mstar-plan-conventions`**. Field semantics and residual lifecycle → **`mstar-plan-artifacts/references/status-and-residuals.md`**. Optional rollup: **`../scripts/tech-debt-rollup.sh`** (read-only; see that reference).

| File | Copy to | Notes |
|------|---------|--------|
| `status.empty.json` | `{HARNESS_DIR}/status.json` | Root `residual_findings` only (see **`mstar-plan-artifacts` SKILL.md**). Replace `updated_at` with the real date. Iteration Phase 2 lease fields (`control_worktree_path`, `execution_lease`, `integration_merge_lease`) are added at runtime — not in the empty template. |
| `notes.empty.json` | `{HARNESS_DIR}/notes.json` | Optional program timeline. Replace `updated_at` when first edited. |
| `plans-done.empty.json` | `{HARNESS_DIR}/archived/plans-done.json` | **Profile B only** — `{ "plans": [<plan-id>, ...] }` **only** (`references/done-compaction.md`). Append id on each `Done` compaction; no other keys or object elements. |
