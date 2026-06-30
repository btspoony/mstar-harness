---
name: mstar-plan-conventions
description: Morning Star (启明星) harness 计划目录约定 —— `{HARNESS_DIR}` / `{PLAN_DIR}` / `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` 发现与初始化（默认 `.mstar/`，兼容 `.agents/`）、`docs/` 与 harness 子树边界、未启用 plan 时的工作方式、Spec 集成分支与多 Plan 实现分支（merge 靶与 PR 合 main）、Superpowers `writing-plans` 落盘门限、工期预估（agent-oriented）。**必须**在读写 `.mstar/` / `.agents/`、初始化 harness、编排含 plan 的任务、或对齐 `metadata.primary_spec` 时 Read；`@project-manager` 开 plan 任务前必读。plan 文件 / status / residual / reports / knowledge → **`mstar-plan-artifacts`**；分支与 QC 检出 → **`mstar-branch-worktree`**。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 本 skill 只约定 **目录与路径**；不突破状态机与门禁。冲突时 **以 `mstar-harness-core` 为准**。

| 你还可能要 Read | 何时 |
|-----------------|------|
| `mstar-plan-artifacts` | 主 plan、reports、`status.json`、residual、InReview/QC 波次、knowledge |
| `mstar-branch-worktree` | Assignment 写分支 / worktree / QC 检出 |
| `mstar-review-qc` | 派 QC 三审（PM 同轮必读） |

## 路径符号（SSOT）

| 符号 | 默认 |
|------|------|
| `{HARNESS_DIR}` | `.mstar/` |
| `{PLAN_DIR}` | `{HARNESS_DIR}/plans/` |
| `{ITERATION_DIR}` | `{HARNESS_DIR}/iterations/` |
| `{KNOWLEDGE_DIR}` | `{HARNESS_DIR}/knowledge/` |
| `{SPECS_DIR}` | `specs/` 优先，否则 `designs/` |

### 解析顺序（找到即停）

1. `.mstar/` → `{HARNESS_DIR}=.mstar/`, `{PLAN_DIR}=.mstar/plans/`
2. 否则 `.agents/` → legacy `{HARNESS_DIR}=.agents/`, `{PLAN_DIR}=.agents/plans/`
3. 否则 `.plans/` 或 `plans/` → 遗留同目录 `{HARNESS_DIR}={PLAN_DIR}`
4. 皆无 → 未启用 plan；进度走对话与 Completion Report

并存时 **`.mstar/` 优先**；仅当项目已有 `.agents/` 且无 `.mstar/` 时继续沿用 `.agents/`。

`{SPECS_DIR}`：有 `specs/` 用之；否则 `designs/`；皆无则建议新建 `specs/`。

## 内容边界（摘要）

| 区域 | 内容 |
|------|------|
| `docs/` | 人类文档：安装、贡献 |
| `{SPECS_DIR}` | 冻结规格 / ADR |
| `{ITERATION_DIR}` | 迭代 compass 快照 |
| `{KNOWLEDGE_DIR}` | 实现 SSOT、可复用设计 |
| `{PLAN_DIR}/` | 主 plan、`reports/` |

单 plan 评审结论、QC 报告 → **`{PLAN_DIR}/reports/`**，非 `docs/`。细则 → **`mstar-plan-artifacts`**。

## 初始化 Plan 目录

PM 在需要持久化追踪时：

1. 建 `.mstar/`、`plans/`、`status.json`（空模板见 **`mstar-plan-artifacts/templates/status.empty.json`**）
2. 可选 `notes.json`（模板 **`mstar-plan-artifacts/templates/notes.empty.json`**）、`reports/README.md`、`knowledge/`、`iterations/`、`specs/`
3. Git：团队交付 **勿** ignore 整个 `{HARNESS_DIR}`（handoff 需 clone 可达）

步骤与 `{HARNESS_DIR}/AGENTS.md` 分层 → **`references/harness-bootstrap-and-agents-layering.md`**。

## Spec 驱动的分支模型（多 Plan · 同一 Spec）

- **Spec 集成分支**：各 Plan 实现 merge 回此线后再视为 Spec 在代码侧集成。
- **Plan 实现分支**：每 `plan_id` 一条（PM 书面）。
- **合入 `main`**：全部 Plans 完成后 **必须 PR**（窄例外见 Assignment `Branch policy`）。
- Git 操作与 QC 单一 `HEAD` → **`mstar-branch-worktree`**。
- `status.json` 登记 `spec_integration_branch` / `merge_target` → **`mstar-plan-artifacts`**。

## Superpowers `writing-plans` 门限

计划写入 **`{PLAN_DIR}`**，**禁止**默认 `docs/superpowers/plans/`。见 **`mstar-superpowers-align`**。

## 状态与权限（摘要）

`Todo` | `InProgress` | `InReview` | `Blocked` | `Done` — **`Done` 仅 PM 或 QA**。字段与 residual → **`mstar-plan-artifacts`**。主 plan checkbox → **`mstar-plan-artifacts`**。

## 未启用 Plan 时

无 plan 目录：PM 用对话追踪；门禁（QC/QA）仍适用；复杂度上升时可建议初始化。

## 实现角色最小阅读

仅需路径符号与 `plans[].metadata` 的 `primary_spec` / `spec_refs` 时：读本 SKILL 至「路径符号」+ **`mstar-plan-artifacts/references/knowledge-and-designs.md`** 即可，**不必**通读 status/residual 全文。

## References

- `references/harness-bootstrap-and-agents-layering.md` — 新仓 harness + AGENTS 分层
- `references/effort-estimation.md` — agent-oriented 工期（禁人天/FTE）
- `references/artifact-storage-paths.md` — **产物存储路径 SSOT**（知识文档、CONCEPTS.md、STRATEGY.md 等落盘位置；`mstar-compound`、`mstar-compound-refresh`、`mstar-strategy` 等技能引用此表，不得本地重定义）

**Plan 工件细则**（主 plan、reports、`status.json`、residual、knowledge、Done 归档、**`templates/`**）→ skill **`mstar-plan-artifacts`**（`references/` 与 `templates/`）。
