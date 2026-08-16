---
name: mstar-plan-artifacts
description: "Morning Star plan harness artifacts — `{PLAN_DIR}` main plans and durable review summaries, `{SDD_DIR}/review/` ephemeral QC/QA bundles, `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` indexes, Done compaction, plus `{HARNESS_DIR}/status.json` and root `residual_findings` (severity SSOT, open/archived lifecycle, `notes.json`). Read when writing plans or QC/QA review bundles, maintaining knowledge/iteration indexes, reading or writing `status.json` / R#, Done compaction, or mapping QC severity to JSON. Required for `@project-manager` on status, residuals, and InReview/QC waves; `@qc-specialist*` before writing review bundle reports; `@qa-engineer` before closing R# when `QA gate: mandatory`. Verdict rules: leaf → `mstar-roles/references/qc-specialist/report-template.md`; PM → `mstar-review-qc`. Paths in `mstar-plan-conventions`."
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-plan-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, review bundle naming, durable summaries, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| Plan template (Global Constraints, Interfaces) | `templates/plan.main.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| Done row compaction Profile A/B | `references/done-compaction.md` |
| `status.json`, residual severity, lifecycle, `jq` | `references/status-and-residuals.md` |
| Empty-repo `status.json` / `notes.json` / Profile B `plans-done.json` templates | `templates/status.empty.json`, `templates/notes.empty.json`, `templates/plans-done.empty.json` (`templates/README.md`) |
| Tech-debt rollup (read-only) | engine `techDebtRollup` import (no CLI form; see `references/status-and-residuals.md`) |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; leaf QC checklist and verdict → **`mstar-roles/references/qc-specialist/`**; PM QC orchestration → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-plan-conventions`**.

## `status.json` and open residual (summary)

- **`{HARNESS_DIR}/status.json`**: `plans[]` row status + root **`residual_findings[<plan-id>]`** (open list **SSOT**).
- **Canonical**: register new findings only at root `residual_findings`; **`metadata.residual_findings`** is legacy read-only — **do not** dual-write.

> **Engine check (when available):** run `mstar status validate <path>` (or `import { validateStatus } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Fail-loud handoff**: findings must pass `validateResidual` (per entry) / `validateStatus` (whole file) before registration; malformed → reject + rewrite → **`references/status-and-residuals.md`** (“Fail-loud handoff contract”).
- **Lifecycle**: open → verified close → **`archived/residuals/<plan-id>.json`**; machine **`severity`** enum in reference.

> **Engine check (when available):** run `mstar status archive-residuals <plan-id>` (or `import { archiveResiduals } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Findings cleanup**: Assignment **`Findings cleanup: zero-residual | allow-residual`** (+ optional `metadata.findings_cleanup`); iteration Phase 2 defaults to **`zero-residual`** → **`references/status-and-residuals.md`** (“Findings cleanup modes”).

> **Engine check (when available):** import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook to enforce the cleanup mode above. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **`notes.json`**, optional **`tech_debt_summary`** (rollup view; compute via engine `techDebtRollup` — **`references/status-and-residuals.md`**).
- **Iteration Phase 2 leases** (`metadata.control_worktree_path`, `plans[].execution_lease`, `metadata.integration_merge_lease`): claim-before-`InProgress`, resume vs steal, orphan recovery → **`references/status-and-residuals.md`** (“Iteration execution leases”).

> **Engine check (when available):** run `mstar lease verify <plan-id>` (or `import { validateExecutionLease } from "@mstar-harness/engine"` in a host hook — `validateIntegrationMergeLease` is import-only; no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

Field semantics, severity mapping, findings cleanup modes, archive flow, and `jq` examples → **`references/status-and-residuals.md`**.

**Templates (this skill):** `templates/status.empty.json`, `templates/notes.empty.json` — copy into `{HARNESS_DIR}/` (`templates/README.md`).

## Workflow

产物生命周期主链：主 plan 落盘 `{PLAN_DIR}`（命名见 `references/plan-files-and-reports.md`）→ 实现推进时更新 `{HARNESS_DIR}/status.json`（`plans[]` 行 + root `residual_findings`）→ 审查波次产出 `{SDD_DIR}/review/` bundle（raw QC/QA reports）+ durable gate summary 回写主 plan / status → 关闭后 residual 归档 `{HARNESS_DIR}/archived/residuals/<plan-id>.json` → Done 行 compaction（Profile A/B，`references/done-compaction.md`）。索引（`{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` / `{PLAN_DIR}`）随产物更新。

## Decision Rules

- residual **severity** 是机器字段 SSOT（`references/status-and-residuals.md`）；每条新 finding 只登记 root `residual_findings`，`metadata.residual_findings` 仅 legacy 只读，**禁止**双写。
- **`Findings cleanup: zero-residual`** 默认（迭代 Phase 2）：可修 findings 当轮 fix → re-review 清干净；仅真 blocker 可 defer 且须 Durable Roadmap。
- 登记前必须过 `validateResidual` / `validateStatus`（fail-loud handoff）；malformed → reject + rewrite。

## Evidence

正确结果 = 可复核产物链：`{SDD_DIR}/review/` 审查 bundle 落盘 + 主 plan / `status.json` 的 durable gate summary + residual 生命周期间档（open → verified close → archived）+ Done 行 compaction 完成。拒绝「仅对话声称」。

## References

- `references/plan-files-and-reports.md` — 主 plan / review bundle 命名、QC 波次、durable summaries
- `references/status-and-residuals.md` — `status.json`、residual severity / lifecycle / `jq`
- `references/done-compaction.md` — Done 行 compaction Profile A/B
- `references/knowledge-and-designs.md` — knowledge / iterations / specs 边界与索引
