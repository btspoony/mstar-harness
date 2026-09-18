---
name: mstar-artifacts
description: "Morning Star plan harness artifacts — `{PLAN_DIR}` main plans and durable review summaries, `{SDD_DIR}/review/` ephemeral QC/QA bundles, `{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` indexes, plus `{HARNESS_DIR}/status.json` (v2 root register) / `{WORKFLOW_DIR}/<id>/snapshot.json` (plan rows + leases + plan-scoped `coordination`/session/handoff/revision semantics) and `{PROJECT_DIR}/<id>/residuals.json` (residual register; severity SSOT, open/close lifecycle). Read when writing plans or QC/QA review bundles, maintaining knowledge/iteration indexes, reading or writing status/snapshot/register, or mapping QC severity to JSON. Required for `@project-manager` on status, residuals, and InReview/QC waves; `@qc-specialist*` before writing review bundle reports; `@qa-engineer` before closing R# when `QA gate: mandatory`. Verdict rules: leaf → `mstar-roles/references/qc-specialist/report-template.md`; PM → `mstar-review-qc`."
---

## Load order

**Before first Read of this skill: Read `mstar-harness-core` (SKILL.md), and `mstar-conventions` when path symbols matter.** Git branch / worktree / QC checkout → **`mstar-branch-worktree`**. On conflict, **`mstar-harness-core` wins**.

## Scope (plan directory artifacts)

| Topic | See |
|-------|-----|
| Main plan, review bundle naming, durable summaries, QC waves, residual and plan index order | `references/plan-files-and-reports.md` |
| Plan template (Global Constraints, Interfaces) | `templates/plan.main.md` |
| knowledge / iterations / specs boundaries and indexes | `references/knowledge-and-designs.md` |
| `status.json` (v2 root), workflow snapshots, plan-scoped `coordination` / session / handoff / revision schema, **issue store** capture pointer, project register (migration history), residual severity / lifecycle, engine-check queries | `references/status-and-residuals.md` |
| Plan-level workflow lifecycle: delivery-kind declaration, stages, evidence contracts, engine seams | `references/plan-workflow-lifecycle-contract.md` |
| Empty-repo `status.json` template | `templates/status.empty.json` (`templates/README.md`) |
| Open-issue rollup (read-only) | `mstar status tech-debt` (issue-store rollup; see `references/status-and-residuals.md`) |

**Out of scope:** branch and QC/QA checkout alignment → **`mstar-branch-worktree`**; leaf QC checklist and verdict → **`mstar-roles/references/qc-specialist/`**; PM QC orchestration → **`mstar-review-qc`**; `{HARNESS_DIR}` discovery and init → **`mstar-conventions`**.

## `status.json`, workflow snapshots, and open residual (summary)

- **`{HARNESS_DIR}/status.json` (v2)**: active-lifecycle register — `{ version: 2, updated_at, workflows[] }`. Each entry points at its snapshot dir (`dir: workflows/<id>`); terminal lifecycles are unregistered after the snapshot write. The PM-facing close caller is the post-merge `mstar status workflow-close --workflow <id>` (ordering: terminal snapshot write first, root unregister second → `mstar-iteration/references/phase-6-post-merge-close.md` §6.1–§6.2).
- **`{WORKFLOW_DIR}/<id>/snapshot.json`**: per-lifecycle running state — `plans[]` rows (legacy PlanRow shape verbatim) + per-row `execution_lease` + top-level `integration_merge_lease` / `execution_policy` / `branch` anchors / `integration_worktree_path` (the dedicated integration checkout; the main worktree / control root is derived from Git, never recorded in the snapshot).
- **`{PROJECT_DIR}/<id>/residuals.json`**: project register — **migration history** (severity enum + lifecycle semantics verbatim; project-less flows use `_default`). **Open items are issues in `{HARNESS_DIR}/store.db`** → capture duty → **`mstar-project-governance`「Issue capture」**.
- **Canonical**: capture confirmed findings as **issues** (plan-linked `mstar plan issue-add`, unscoped `mstar issue add`; recurrence appends an occurrence); the register is not a write target — v1 root `residual_findings` and the register document are legacy/migration only — migrate via `mstar migrate`, do not dual-write.

> **Engine check (when available):** run `mstar status validate <path>` (or `import { validateStatus } from "@mstar-harness/engine"` in a host hook). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **Fail-loud handoff**: the capture path validates the capture input at the domain boundary and refuses a malformed submission (nothing written); migrated register documents pass `validateResidual` (per entry) / `validateProjectRegister` (register); snapshots and the v2 root pass `validateWorkflowSnapshot` / `validateStatus` (`mstar status validate`); malformed → reject + rewrite → **`references/status-and-residuals.md`** (“Fail-loud handoff contract”).
- **Lifecycle**: an issue is **open** until a §4 closure authority retires it (`resolved` / `waived` / `duplicate` / `superseded`); migrated register records keep the in-place `lifecycle` / `closed_at` / `closure_note` shape; machine **`severity`** enum in reference. v1 `archived/residuals/` + `archive-residuals` are retired.

- **Findings cleanup**: Assignment **`Findings cleanup: zero-residual | allow-residual`** (the `metadata.findings_cleanup` mirror is deleted); iteration Phase 2 defaults to **`allow-residual`** (capture + disclose duties apply) → **`references/status-and-residuals.md`** (“Findings cleanup modes”).

> **Engine check (when available):** run `mstar status findings-cleanup <plan-id> [--mode zero-residual|allow-residual]` (or import `findingsCleanupGate` from `@mstar-harness/engine` in a host hook) to enforce the Findings cleanup mode above against the **open issues linked to the plan** in `{HARNESS_DIR}/store.db`. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

- **`{WORKFLOW_DIR}/<id>/notes.jsonl`**: per-workflow append-only notes ledger (runtime); snapshot plan-row `notes` is the legacy verbatim copy. **Tech-debt rollup**: `mstar status tech-debt` over the open issues in the store — **`references/status-and-residuals.md`**.
- **Iteration Phase 2 leases** (snapshot: `integration_worktree_path`, `plans[].execution_lease`, top-level `integration_merge_lease`): field semantics → **`references/status-and-residuals.md`** (“Iteration execution leases”); Phase 2 execution checklist → **`mstar-iteration`** `references/phase-2-worktree-lease.md`; full protocol prose (single copy) → **`mstar-engine-legacy`** `references/lease-protocol.md`.
- **Plan-scoped coordination is a domain-call surface**: plan-row `coordination` block (`prepared` / `revision` / `duplicate-holder`), session JSON, handoff record, and `--expect <revision>` semantics have their **single runtime home** in **`references/status-and-residuals.md`**; flag shapes and exit codes → **`mstar-use-cli`**; route semantics → **`mstar-iteration`** `references/plan-scoped-pm.md`. Every plan-row mutation goes through the verbs (`mstar plan bind | show | prepare | progress | issue-add | issue-close | handoff | accept | return | integration-start | integration-accept | complete | reconcile`) — hand-editing snapshot rows, or writing findings/register files outside those verbs, is **not** an authorized path.

> **Engine check (when available):** run `mstar lease verify --workflow <id> [--plan <plan-id>]` or `mstar lease verify-integration --workflow <id>` (or import `validateExecutionLease` / `validateIntegrationMergeLease` from `@mstar-harness/engine` in a host hook) to validate the iteration leases above on the workflow snapshot (execution_lease / integration_merge_lease). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

Field semantics, severity mapping, findings cleanup modes, archive flow, and `jq` examples → **`references/status-and-residuals.md`**.

**Templates (this skill):** `templates/status.empty.json` — the **v2 shape** (`version: 2`, `updated_at`, `workflows: []`); copy into `{HARNESS_DIR}/` (`templates/README.md`).

## Workflow

产物生命周期主链：主 plan 落盘 `{PLAN_DIR}`（命名见 `references/plan-files-and-reports.md`）→ 实现推进时经 **domain call** 更新 workflow snapshot 的 `plans[]` 行（scoped 路线：`mstar plan progress | handoff | complete --session <session.json> [--expect <revision>]`；直接文件编辑仅限 CLI 缺失的 legacy 路线），根 `status.json` `workflows[]` 的登记/注销由生命周期动词负责（如 `mstar status workflow-close`）→ 审查波次产出 `{SDD_DIR}/review/` bundle（raw QC/QA reports）+ durable gate summary 回写主 plan / snapshot → 确认的 finding 捕获为 issue（`mstar plan issue-add` / `mstar issue add`），关闭走 §4 关闭权威。索引（`{KNOWLEDGE_DIR}` / `{ITERATION_DIR}` / `{PLAN_DIR}`）随产物更新。

## Decision Rules

- residual **severity** 是机器字段 SSOT（`references/status-and-residuals.md`）；每条新 finding 捕获为 **issue**（计划内 `mstar plan issue-add`，计划外 `mstar issue add`；重复出现追加 occurrence）；register 与 v1 根级 `residual_findings` 都是 legacy/迁移只读，**禁止**双写。
- **`Findings cleanup: allow-residual`** 默认（迭代 Phase 2）：open issue 先捕获（计划链接）再披露（清单 + severity + 跟踪位置；close 面另含 blocker-defer 标记）；unresolved `critical` 仍阻断 Approve；`zero-residual` 为显式 opt-in —— 细则 → **`references/status-and-residuals.md`**「Findings cleanup modes」。
- 捕获前必须过 engine 域校验（fail-loud handoff）；迁移 register 文档过 `validateResidual` / `validateProjectRegister` / `validateStatus`；malformed → reject + rewrite。
- **计划行 / issue 只经 domain call 修改**：scoped 路线使用 `mstar plan …` 动词（带 `--session` 与 `--expect`），手写 snapshot / 写 register 会被拒（`coordination.direct-write-refused` / `coordination.scoped-writer-required` / `coordination.store`）；只读校验器（`mstar lease verify` / `mstar worktree check`）是检查而非修改替代。

## Evidence

正确结果 = 可复核产物链：`{SDD_DIR}/review/` 审查 bundle 落盘 + 主 plan / workflow snapshot 的 durable gate summary + issue 生命周期（捕获 → §4 关闭权威关闭，`mstar issue list` 可复核）。拒绝「仅对话声称」。

## References

- `references/plan-files-and-reports.md` — 主 plan / review bundle 命名、QC 波次、durable summaries
- `references/status-and-residuals.md` — `status.json` (v2), workflow snapshots, plan-scoped coordination (bind / revision / session / handoff / reconcile), issue capture pointer, migrated project register, residual severity / lifecycle / engine-check queries
- `references/knowledge-and-designs.md` — knowledge / iterations / specs 边界与索引
- `references/plan-workflow-lifecycle-contract.md` — plan-level workflow lifecycle contract: delivery-kind declaration, stages, evidence contracts, engine seams
