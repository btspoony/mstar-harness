---
name: mstar-artifacts
description: "Morning Star plan artifacts: main plans, durable review summaries, ephemeral QC/QA bundles, workflow state/configuration/progress/completion evidence, issue capture and residual severity. Read when authoring these artifacts, mapping QC severity, or reading/writing workflow state. PM QC orchestration belongs to mstar-review-qc; leaf verdict methods belong to mstar-roles."
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, review bundle naming, durable summaries, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| Plan template (Global Constraints, Interfaces) | `templates/plan.main.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| Root register, workflow snapshots, coordinator configuration/progress/completion and CAS, issue capture, residual severity/lifecycle | `references/status-and-residuals.md` |
| Plan-level workflow lifecycle: delivery-kind declaration, stages, evidence contracts, engine seams | `references/plan-workflow-lifecycle-contract.md` |
| Empty-repo `status.json` template | `templates/status.empty.json` (`templates/README.md`) |
| Open-issue rollup (read-only) | `mstar status tech-debt` (issue-store rollup; see `references/status-and-residuals.md`) |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; leaf QC checklist and verdict → **`mstar-roles/references/qc-specialist/`**; PM QC orchestration → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-conventions`**.

## `status.json`, workflow snapshots, and open residual (summary)

- **`{HARNESS_DIR}/status.json` (v2)**: active-lifecycle register — `{ version: 2, updated_at, workflows[] }`. Each entry points at its snapshot dir (`dir: workflows/<id>`); terminal lifecycles are unregistered after the snapshot write. The PM-facing close caller is the post-merge `mstar status workflow-close --workflow <id>` (ordering: terminal snapshot write first, root unregister second → `mstar-iteration/references/phase-6-post-merge-close.md` §6.1–§6.2).
- Workflow state contains rows with ordinary source metadata/configuration/progress/completion, top-level integration_merge_lease/execution_policy/branch/integration_worktree_path. Main/control is Git-derived; per-row execution leases are removed.
- **`{PROJECT_DIR}/<id>/residuals.json`**: project register — **migration history** (severity enum + lifecycle semantics verbatim; project-less flows use `_default`). **Open items are issues in `{HARNESS_DIR}/store.db`** → capture duty → **`mstar-project-governance`「Issue capture」**.
- **Canonical**: capture confirmed findings as **issues** (plan-linked `mstar plan issue-add`, unscoped `mstar issue add`; recurrence appends an occurrence); the register is not a write target — v1 root `residual_findings` and the register document are legacy/migration only — migrate via `mstar migrate`, do not dual-write.

> **Engine check (when available):** run `mstar status validate <path>` (or `import { validateStatus } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Fail-loud handoff**: the capture path validates the capture input at the domain boundary and refuses a malformed submission (nothing written); migrated register documents pass `validateResidual` (per entry) / `validateProjectRegister` (register); snapshots and the v2 root pass `validateWorkflowSnapshot` / `validateStatus` (`mstar status validate`); malformed → reject + rewrite → **`references/status-and-residuals.md`** (“Fail-loud handoff contract”).
- **Lifecycle**: an issue is **open** until a §4 closure authority retires it (`resolved` / `waived` / `duplicate` / `superseded`); migrated register records keep the in-place `lifecycle` / `closed_at` / `closure_note` shape; machine **`severity`** enum in reference. v1 `archived/residuals/` + `archive-residuals` are retired.

- **Findings cleanup:** coordinator prepare records `zero-residual | allow-residual`, default **allow-residual**. Leaf Assignments mirror the effective mode for evidence duties, not admission sealing → `references/status-and-residuals.md`.

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the Findings cleanup mode above against the **open issues linked to the plan** in `{HARNESS_DIR}/store.db`. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **`{WORKFLOW_DIR}/<id>/notes.jsonl`**: per-workflow append-only notes ledger (runtime); snapshot plan-row `notes` is the legacy verbatim copy. **Tech-debt rollup**: `mstar status tech-debt` over the open issues in the store — **`references/status-and-residuals.md`**.
- **Iteration safety:** source metadata supplies checkout scope; atomic coordinator transactions/CAS protect state, while top-level integration_merge_lease protects real serial merges. Fields → references/status-and-residuals.md; procedure → mstar-iteration/references/phase-2-worktree-lease.md.

> **Engine check:** mstar worktree check validates L1/L2 checkout facts; mstar lease verify-integration checks workflow merge exclusion. Neither is a mutation substitute or per-row admission ceremony.

Field semantics, severity mapping, findings cleanup modes, archive flow, and `jq` examples → **`references/status-and-residuals.md`**.

**Templates (this skill):** `templates/status.empty.json` — the **v2 shape** (`version: 2`, `updated_at`, `workflows: []`); copy into `{HARNESS_DIR}/` (`templates/README.md`).

## Workflow

Write the main plan under `{PLAN_DIR}` → primary coordinator advances its explicitly selected rows through ordinary domain operations → raw review bundle and durable summaries → capture confirmed findings as linked issues → direct complete with QC/QA and declared-route proof → the workflow's outer delivery/close obligations. ACTIVE identity/session/token defaults may be derived when unambiguous; explicit constraints still validate. Pre-activation uses the coordinator envelope and row revision. Registration/unregistration stays workflow-owned.

## Decision Rules

- residual **severity** 是机器字段 SSOT（`references/status-and-residuals.md`）；每条新 finding 捕获为 **issue**（计划内 `mstar plan issue-add`，计划外 `mstar issue add`；重复出现追加 occurrence）；register 与 v1 根级 `residual_findings` 都是 legacy/迁移只读，**禁止**双写。
- **`Findings cleanup: allow-residual`** 默认（迭代 Phase 2）：open issue 先捕获（计划链接）再披露（清单 + severity + 跟踪位置；close 面另含 blocker-defer 标记）；unresolved `critical` 仍阻断 Approve；`zero-residual` 为显式 opt-in —— 细则 → **`references/status-and-residuals.md`**「Findings cleanup modes」。
- 捕获前必须过 engine 域校验（fail-loud handoff）；迁移 register 文档过 `validateResidual` / `validateProjectRegister` / `validateStatus`；malformed → reject + rewrite。
- **Only domain writers mutate rows/issues:** file and ACTIVE routes share the coordinator contract; validators never substitute for a write. Session references are lookups and tokens CAS constraints, not bearer credentials; neither goes into a leaf Assignment.

## Evidence

正确结果 = 可复核产物链：`{SDD_DIR}/review/` 审查 bundle 落盘 + 主 plan / workflow snapshot 的 durable gate summary + issue 生命周期（捕获 → §4 关闭权威关闭，`mstar issue list` 可复核）。拒绝「仅对话声称」。

## References

- `references/plan-files-and-reports.md` — 主 plan / review bundle 命名、QC 波次、durable summaries
- `references/status-and-residuals.md` — root/workflow fields, coordinator configuration/progress/completion, issue capture and residual severity/lifecycle
- `references/knowledge-and-designs.md` — knowledge / iterations / specs 边界与索引
- `references/plan-workflow-lifecycle-contract.md` — plan-level workflow lifecycle contract: delivery-kind declaration, stages, evidence contracts, engine seams
