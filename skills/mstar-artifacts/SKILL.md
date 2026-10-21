---
name: mstar-artifacts
description: "Plan artifacts: main plans, durable review summaries, QC/QA bundles, workflow state/config/progress/evidence, issue capture, residual severity. Read when authoring or mapping them."
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, review bundle naming, durable summaries, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| Plan template (Global Constraints, Interfaces) | `templates/plan.main.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| ACTIVE execution rows, coordinator configuration/progress/completion and CAS, issue capture, residual severity/lifecycle | `references/status-and-residuals.md` |
| Plan-level workflow lifecycle: delivery-kind declaration, stages, evidence contracts, engine seams | `references/plan-workflow-lifecycle-contract.md` (closing amendment **File-route retirement** is the live route) |
| Open-issue rollup (read-only) | `mstar status tech-debt` (issue-store rollup; see `references/status-and-residuals.md`) |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; leaf QC checklist and verdict → **`mstar-roles/references/qc-specialist/`**; PM QC orchestration → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-conventions`**.

## Execution authority, migration sources, and open residual (summary)

- **ACTIVE root register**: `{HARNESS_DIR}/store.db` (`execution_registry` + `execution_meta.root_updated_at`), read through `mstar status validate` (no path; a path is refused). The PM-facing close caller is post-merge `mstar status workflow-close --workflow <id>` — one store transaction writes the terminal workflow state and unregisters the workflow (procedure → `mstar-iteration/references/phase-6-post-merge-close.md` §6.1–§6.2; route semantics → the lifecycle contract's **File-route retirement** amendment).
- **ACTIVE workflow / plan state**: `execution_workflows`, `execution_plans`, workflow-wide `execution_integration_leases`, coordinator `execution_sessions` and registered `execution_inputs` in the store; read through `mstar plan show` / `mstar status validate`. Rows contain ordinary source metadata/configuration/progress/completion; per-row execution leases are removed. Main/control is Git-derived.
- **Migration sources / retained history**: read-only root/snapshot/session inputs; `mstar store upgrade` preserves original execution-source bytes and standalone `mstar migrate` staging is retired. Historical shapes → **`mstar-engine-legacy`** `references/migration-source-shapes.md` (no execution route or live writer).
- **Persist surface**: the user-facing persist family and engine `ArtifactKind` accept `review` and `json` only. No internal status/snapshot file writer or runtime file-state fallback remains.
- **Project registers**: migration history only; shapes/provenance → **`mstar-engine-legacy`** `references/migration-source-shapes.md`. **Open items are issues in `{HARNESS_DIR}/store.db`** → **`mstar-project-governance`「Issue capture」**.
- **Canonical**: capture confirmed findings as **issues** (plan-linked `mstar plan issue-add`, unscoped `mstar issue add`; recurrence appends an occurrence); the register is not a write target. Legacy execution imports use `mstar store upgrade`; project register import uses the separate reviewed `mstar store migrate` flow. Never dual-write.

> **Engine check (when available):** run `mstar status validate` (ACTIVE authority and tokens; no path argument). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Fail-loud handoff**: capture validates input at the domain boundary and refuses malformed submissions (nothing written) → **`references/status-and-residuals.md`** (“Fail-loud handoff contract”); historical document validation → **`mstar-engine-legacy`** `references/migration-source-shapes.md`.
- **Lifecycle**: an issue is **open** until a §4 closure authority retires it (`resolved` / `waived` / `duplicate` / `superseded`); current machine severity and issue-disposition semantics → `references/status-and-residuals.md`; historical closure shapes → **`mstar-engine-legacy`** `references/migration-source-shapes.md`.

- **Findings cleanup:** coordinator prepare records `zero-residual | allow-residual`, default **allow-residual**. Leaf Assignments mirror the effective mode for evidence duties, not admission sealing → `references/status-and-residuals.md`.

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the Findings cleanup mode above against the **open issues linked to the plan** in `{HARNESS_DIR}/store.db`. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **`{WORKFLOW_DIR}/<id>/notes.jsonl`**: plain append-only runtime notes, not accepted-operation authority; duplicate IDs/submissions append again. Historical plan-row arrays stay read-only. Append/read semantics → **`references/status-and-residuals.md`**; `mstar status tech-debt` reads open issues in the store.
- **Iteration safety:** source metadata supplies checkout scope; atomic coordinator transactions/CAS protect state, while workflow-wide integration merge exclusion protects real serial merges (`execution_integration_leases`). Fields → `references/status-and-residuals.md`; procedure → `mstar-iteration/references/phase-2-worktree-lease.md`.

> **Engine check:** `mstar worktree check` is the one engine-enforced checkout command (per-plan L1, workflow `--entry`, and L2), including integration merge-lease state. It is an engine-enforced subset, not a mutation substitute, a per-row admission ceremony, or clearance of the full pre-dispatch checklist.

Current field semantics, severity mapping, findings cleanup and issue closure → **`references/status-and-residuals.md`**; migration-source shapes → **`mstar-engine-legacy`** `references/migration-source-shapes.md`.

**Templates (this skill):** `templates/plan.main.md` only (`templates/README.md`). Bootstrap is `mstar harness scaffold` then `mstar store init`; there is no empty status template.

## Workflow

Write the main plan under `{PLAN_DIR}` → primary coordinator advances its explicitly selected rows through ordinary domain operations → raw review bundle and durable summaries → capture confirmed findings as linked issues → direct complete with QC/QA and declared-route proof → the workflow's outer delivery/close obligations. ACTIVE identity/session/token defaults may be derived when unambiguous; explicit constraints still validate. Registration/unregistration stays workflow-owned on the ACTIVE store route (lifecycle contract, **File-route retirement** amendment).

## Decision Rules

- Residual severity is the machine-field SSOT (`references/status-and-residuals.md`); capture each new finding as an issue (plan-scoped `mstar plan issue-add`, otherwise `mstar issue add`; recurrence appends an occurrence). Historical files are read-only, never dual-write targets → **`mstar-engine-legacy`** `references/migration-source-shapes.md`.
- **`Findings cleanup: allow-residual`** 默认（迭代 Phase 2）：open issue 先捕获（计划链接）再披露（清单 + severity + 跟踪位置；close 面另含 blocker-defer 标记）；unresolved `critical` 仍阻断 Approve；`zero-residual` 为显式 opt-in —— 细则 → **`references/status-and-residuals.md`**「Findings cleanup modes」。
- 捕获前必须过 engine 域校验（fail-loud handoff）；迁移 register 文档过 `validateResidual` / `validateProjectRegister`；malformed → reject + rewrite。
- **Only domain writers mutate rows/issues:** the ACTIVE coordinator contract is the only execution route. Validators never substitute for a write. Do not hand-write root `status.json` or workflow snapshots; those files are migration sources / retained history. The user-facing persist family is `review` / `json` only. Session references are lookups and tokens are CAS constraints, not bearer credentials; neither goes into a leaf Assignment.

## Evidence

正确结果 = 可复核产物链：`{SDD_DIR}/review/` 审查 bundle 落盘 + 主 plan 的 durable gate summary + store 执行行（`mstar plan show`）+ issue 生命周期（捕获 → §4 关闭权威关闭，`mstar issue list` 可复核）。拒绝「仅对话声称」。

## References

- `references/plan-files-and-reports.md` — 主 plan / review bundle 命名、QC 波次、durable summaries
- `references/status-and-residuals.md` — ACTIVE execution fields, coordinator configuration/progress/completion, issue capture and current severity/lifecycle; migration-source shapes live in **`mstar-engine-legacy`** `references/migration-source-shapes.md`
- `references/knowledge-and-designs.md` — knowledge / iterations / specs 边界与索引
- `references/plan-workflow-lifecycle-contract.md` — plan-level workflow lifecycle contract: delivery-kind declaration, stages, evidence contracts, engine seams; closing amendment **File-route retirement**
