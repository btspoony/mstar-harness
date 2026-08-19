---
name: mstar-plan-artifacts
description: "Morning Star plan harness artifacts — `{PLAN_DIR}` main plans and durable review summaries, `{SDD_DIR}/review/` ephemeral QC/QA bundles, `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` indexes, plus `{HARNESS_DIR}/status.json` (v2 root register) / `{WORKFLOW_DIR}/<id>/snapshot.json` (plan rows + leases) and `{PROJECT_DIR}/<id>/residuals.json` (residual register; severity SSOT, open/close lifecycle). Read when writing plans or QC/QA review bundles, maintaining knowledge/iteration indexes, reading or writing status/snapshot/register, or mapping QC severity to JSON. Required for `@project-manager` on status, residuals, and InReview/QC waves; `@qc-specialist*` before writing review bundle reports; `@qa-engineer` before closing R# when `QA gate: mandatory`. Verdict rules: leaf → `mstar-roles/references/qc-specialist/report-template.md`; PM → `mstar-review-qc`."
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-plan-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, review bundle naming, durable summaries, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| Plan template (Global Constraints, Interfaces) | `templates/plan.main.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| `status.json` (v2 root), workflow snapshots, project register, residual severity / lifecycle, engine-check queries | `references/status-and-residuals.md` |
| Empty-repo `status.json` template | `templates/status.empty.json` (`templates/README.md`) |
| Tech-debt rollup (read-only) | `mstar status tech-debt [path]` (engine `techDebtRollup`; see `references/status-and-residuals.md`) |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; leaf QC checklist and verdict → **`mstar-roles/references/qc-specialist/`**; PM QC orchestration → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-plan-conventions`**.

## `status.json`, workflow snapshots, and open residual (summary)

- **`{HARNESS_DIR}/status.json` (v2)**: active-lifecycle register — `{ version: 2, updated_at, workflows[] }`. Each entry points at its snapshot dir (`dir: workflows/<id>`); terminal lifecycles are unregistered after the snapshot write.
- **`{WORKFLOW_DIR}/<id>/snapshot.json`**: per-lifecycle running state — `plans[]` rows (legacy PlanRow shape verbatim) + per-row `execution_lease` + top-level `integration_merge_lease` / `execution_policy` / `branch` anchors / `control_worktree_path`.
- **`{PROJECT_DIR}/<id>/residuals.json`**: open residual register, `entries[<plan-id>]` arrays — the **open-list SSOT** (severity enum + lifecycle semantics verbatim; project-less flows use `_default`).
- **Canonical**: register new findings only in the project register (`projects/<id>/residuals.json`); v1 root `residual_findings` is legacy read-only — migrate via `mstar migrate`, do not dual-write.

> **Engine check (when available):** run `mstar status validate <path>` (or `import { validateStatus } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Fail-loud handoff**: findings must pass `validateResidual` (per entry) / `validateProjectRegister` (register) before registration; snapshots and the v2 root pass `validateWorkflowSnapshot` / `validateStatus` (`mstar status validate`); malformed → reject + rewrite → **`references/status-and-residuals.md`** (“Fail-loud handoff contract”).
- **Lifecycle**: open → verified close **in place** in the register (`lifecycle` / `closed_at` / `closure_note`); machine **`severity`** enum in reference. v1 `archived/residuals/` + `archive-residuals` are retired.

- **Findings cleanup**: Assignment **`Findings cleanup: zero-residual | allow-residual`** (the `metadata.findings_cleanup` mirror is deleted); iteration Phase 2 defaults to **`zero-residual`** → **`references/status-and-residuals.md`** (“Findings cleanup modes”).

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--project <id>] [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the Findings cleanup mode above against the plan's register entries. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **`{WORKFLOW_DIR}/<id>/notes.jsonl`**: per-workflow append-only notes ledger (runtime); snapshot plan-row `notes` is the legacy verbatim copy. **Tech-debt rollup**: `mstar status tech-debt <project-dir>` over the project registers — **`references/status-and-residuals.md`**.
- **Iteration Phase 2 leases** (snapshot: `control_worktree_path`, `plans[].execution_lease`, top-level `integration_merge_lease`): field semantics → **`references/status-and-residuals.md`** (“Iteration execution leases”); Phase 2 execution checklist → **`mstar-iteration`** `references/phase-2-worktree-lease.md`; full protocol prose (single copy) → **`mstar-engine-legacy`** `references/lease-protocol.md`.

> **Engine check (when available):** run `mstar lease verify --workflow <id> [--plan <plan-id>]` or `mstar lease verify-integration --workflow <id>` (or import `validateExecutionLease` / `validateIntegrationMergeLease` from `@mstar-harness/engine` in a host hook) to validate the iteration leases above on the workflow snapshot (execution_lease / integration_merge_lease). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

Field semantics, severity mapping, findings cleanup modes, archive flow, and `jq` examples → **`references/status-and-residuals.md`**.

**Templates (this skill):** `templates/status.empty.json` — the **v2 shape** (`version: 2`, `updated_at`, `workflows: []`); copy into `{HARNESS_DIR}/` (`templates/README.md`).

## Workflow

产物生命周期主链：主 plan 落盘 `{PLAN_DIR}`（命名见 `references/plan-files-and-reports.md`）→ 实现推进时更新 workflow snapshot（`workflows/<id>/snapshot.json` 的 `plans[]` 行 + 根 `status.json` `workflows[]` 登记）→ 审查波次产出 `{SDD_DIR}/review/` bundle（raw QC/QA reports）+ durable gate summary 回写主 plan / snapshot → 关闭后 residual **in place** close in the project register（`projects/<id>/residuals.json`）。索引（`{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` / `{PLAN_DIR}`）随产物更新。

## Decision Rules

- residual **severity** 是机器字段 SSOT（`references/status-and-residuals.md`）；每条新 finding 只登记 project register（`projects/<id>/residuals.json` → `entries[<plan-id>]`），v1 根级 `residual_findings` 仅 legacy 只读，**禁止**双写。
- **`Findings cleanup: zero-residual`** 默认（迭代 Phase 2）：可修 findings 当轮 fix → re-review 清干净；仅真 blocker 可 defer 且须 Durable Roadmap。
- 登记前必须过 `validateResidual` / `validateProjectRegister` / `validateStatus`（fail-loud handoff）；malformed → reject + rewrite。

## Evidence

正确结果 = 可复核产物链：`{SDD_DIR}/review/` 审查 bundle 落盘 + 主 plan / workflow snapshot 的 durable gate summary + residual 生命周期（open → verified close **in place** in the register）。拒绝「仅对话声称」。

## References

- `references/plan-files-and-reports.md` — 主 plan / review bundle 命名、QC 波次、durable summaries
- `references/status-and-residuals.md` — `status.json` (v2), workflow snapshots, project register, residual severity / lifecycle / engine-check queries
- `references/knowledge-and-designs.md` — knowledge / iterations / specs 边界与索引
