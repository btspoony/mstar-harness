---
name: mstar-plan-conventions
description: Morning Star (启明星) harness 计划目录约定 —— `{HARNESS_DIR}` / `{PLAN_DIR}` / `{SDD_DIR}` / `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` / `{SPECS_DIR}` 发现与初始化（默认 `.mstar/`，兼容 `.agents/`）、`docs` 与 harness 子树边界、review bundle、未启用 plan 时的工作方式、Spec 集成分支与多 Plan 实现分支（显式 base / merge 靶 / PR target）、Morning Star plan-writing path gate、工期预估（agent-oriented）。**必须**在读写 `.mstar/` / `.agents/`、初始化 harness、编排含 plan 的任务、或对齐 `metadata.primary_spec` 时 Read；`@project-manager` 开 plan 任务前必读。plan 文件 / status / residual / review bundle / knowledge → **`mstar-plan-artifacts`**；分支与 QC 检出 → **`mstar-branch-worktree`**。
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** 本 skill 只约定 **目录与路径**；不突破状态机与门禁。冲突时 **以 `mstar-harness-core` 为准**。

| 你还可能要 Read | 何时 |
|-----------------|------|
| `mstar-plan-artifacts` | 主 plan、review bundle 摘要、`status.json`、residual、InReview/QC 波次、knowledge |
| `mstar-branch-worktree` | Assignment 写分支 / worktree / QC 检出 |
| `mstar-review-qc` | 派 QC（PM 同轮必读；SDD 强制 tri） |
| `mstar-sdd` | PM 执行 `Execution mode: sdd` 的 implement 波次 |

## 路径符号（SSOT）

| 符号 | 默认 |
|------|------|
| `{HARNESS_DIR}` | `.mstar/` |
| `{PLAN_DIR}` | `{HARNESS_DIR}/plans/` |
| `{SDD_DIR}` | `{HARNESS_DIR}/sdd/<plan-id>/`（SDD 运行时 scratch + review bundle；gitignored） |
| `{ITERATION_DIR}` | `{HARNESS_DIR}/iterations/` |
| `{KNOWLEDGE_DIR}` | `{HARNESS_DIR}/knowledge/` |
| `{SPECS_DIR}` | `{HARNESS_DIR}/specs/`（默认）；解析见下文「`{SPECS_DIR}` 解析」 |

### `{HARNESS_DIR}` 解析顺序（找到即停）

1. `.mstar/` → `{HARNESS_DIR}=.mstar/`, `{PLAN_DIR}=.mstar/plans/`
2. 否则 `.agents/` → legacy `{HARNESS_DIR}=.agents/`, `{PLAN_DIR}=.agents/plans/`
3. 否则 `.plans/` 或 `plans/` → 遗留同目录 `{HARNESS_DIR}={PLAN_DIR}`
4. 皆无 → 未启用 plan；进度走对话与 Completion Report

并存时 **`.mstar/` 优先**；仅当项目已有 `.agents/` 且无 `.mstar/` 时继续沿用 `.agents/`。

### `{SPECS_DIR}` 解析（找到非空目录即停）

1. `{HARNESS_DIR}/specs/`（默认 `.mstar/specs/`）
2. `docs/specs/`
3. `specs/`（仓库根）

**空目录规则**：候选路径存在但无任何文件 → 视为不存在，继续下一候选。

**创建默认**：全部缺失或皆空 → 创建并使用 `{HARNESS_DIR}/specs/`（统一落在 `.mstar/` 下）。**禁止**在 greenfield init 时优先创建裸仓库根 `specs/`。

**Legacy（仅兼容读）**：若以上皆无内容，但 `{HARNESS_DIR}/designs/` 或仓库根 `designs/` **非空**，可作 `{SPECS_DIR}` 使用；init 时**不**新建 `designs/`。

可选项目选择：部分 spoke 仓库另跟踪 `{HARNESS_DIR}/roadmap.md` — **非**默认 tracked；仅在项目 opt-in 时提及。

## 内容边界（摘要）

| 区域 | 内容 |
|------|------|
| `docs/` | 人类文档：安装、贡献 |
| `{SPECS_DIR}` | 冻结规格 / ADR |
| `{ITERATION_DIR}` | 迭代 package（compass + guides/specs） |
| `{KNOWLEDGE_DIR}` | 实现 SSOT、可复用设计 |
| `{PLAN_DIR}/` | 主 plan、durable gate summaries、可选 residual prose |

单 plan 的 QC/QA **原始过程报告**默认进入 **`{SDD_DIR}/review/`**（gitignored review bundle），非 `docs/`，也不默认进入 `{PLAN_DIR}`。主 plan 仅保留 durable gate summary；R# open 状态以 `{HARNESS_DIR}/status.json` 为 SSOT。细则 → **`mstar-plan-artifacts`**。

## 初始化 Plan 目录

PM 在需要持久化追踪时：

1. 建 `.mstar/`、`plans/`、`status.json`（空模板见 **`mstar-plan-artifacts/templates/status.empty.json`**）
2. 可选 `notes.json`（模板 **`mstar-plan-artifacts/templates/notes.empty.json`**）、`knowledge/`、`iterations/`、`{HARNESS_DIR}/specs/`、`sdd/`（空目录占位；运行时 per-plan 子目录由 `mstar-sdd/scripts/sdd-workspace` 创建）
3. 项目根 `.gitignore` 追加 Morning Star **进程产物**忽略集（见下文「Git 跟踪策略」）— CLI `init` 可自动添加
4. Git：**进程本地、结果共享** — 默认跟踪 `{HARNESS_DIR}/AGENTS.md`、`{KNOWLEDGE_DIR}/**`、`{SPECS_DIR}/**`；`plans/`、`iterations/`、`status.json` 等为**本地会话 SSOT**，默认 gitignored。跨 clone 持久 handoff = knowledge + specs + `{HARNESS_DIR}/AGENTS.md`（及根 `CONCEPTS.md` / `STRATEGY.md` 若使用）；须跨 clone 的 residual 须提升（compound）或写入 tracked results — **勿**默认 `git add` `status.json` / `plans/`。

步骤与 `{HARNESS_DIR}/AGENTS.md` 分层 → **`references/harness-bootstrap-and-agents-layering.md`**。

## Git 跟踪策略（进程 vs 结果）

**原则**：进程留在本地；结果与团队共享。

**默认 tracked（`{HARNESS_DIR}` 下）**：

- `{HARNESS_DIR}/AGENTS.md`
- `{KNOWLEDGE_DIR}/**`
- `{HARNESS_DIR}/specs/`（即解析后的 `{SPECS_DIR}` 在 harness 下的默认落点）

**默认 gitignored（`{HARNESS_DIR}` 下）**：

- `archived/`
- `iterations/`
- `plans/`
- `sdd/`
- `notes.json`
- `status.json`

Legacy `.agents/` 项目：将上表路径前缀 `.mstar/` 换为 `.agents/`。

**Canonical `.gitignore` snippet**（skills 与 CLI `init` 对齐）：

```gitignore
# Morning Star harness (.mstar/)
# Principle: process stays local; results are shared with the team.
# Ignored (process / coordination):
.mstar/archived/
.mstar/iterations/
.mstar/plans/
.mstar/sdd/
.mstar/notes.json
.mstar/status.json
# Tracked (results): .mstar/AGENTS.md, .mstar/knowledge/, .mstar/specs/
```

Legacy `.agents/` 等价：

```gitignore
# Morning Star harness (.agents/) — legacy
.agents/archived/
.agents/iterations/
.agents/plans/
.agents/sdd/
.agents/notes.json
.agents/status.json
# Tracked (results): .agents/AGENTS.md, .agents/knowledge/, .agents/specs/
```

## Spec 驱动的分支模型（多 Plan · 同一 Spec）

- **Iteration base branch**：创建 Spec/iteration 集成分支的祖先分支或 ref；必须显式记录，不能默认 `main` / `master`。
- **Spec 集成分支**：从 `iteration_base_branch` 创建；各 Plan 实现 merge 回此线后再视为 Spec 在代码侧集成。
- **Plan 实现分支**：每 `plan_id` 一条（PM 书面）。
- **PR target**：全部 Plans 与 iteration-close 完成后，向显式 `target_branch` 提 PR（窄例外见 Assignment `Branch policy`）。
- Git 操作与 QC 单一 `HEAD` → **`mstar-branch-worktree`**。
- `status.json` 登记 root `metadata.iteration_base_branch` / `metadata.target_branch`，以及 plan `metadata.spec_integration_branch` / `merge_target` → **`mstar-plan-artifacts`**。

**解析顺序**（`mstar-iteration` §2.3）：`status.json` metadata → compass frontmatter → 向用户确认。**禁止**因仓库默认分支名为 `main`/`master` 就自动采用。

## Plan-Writing Path Gate

Plans are written to **`{PLAN_DIR}`** when persistent plan tracking is enabled. Do not introduce external default plan directories.

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

**Plan 工件细则**（主 plan、review bundle / durable summaries、`status.json`、residual、knowledge、Done 归档、**`templates/`**）→ skill **`mstar-plan-artifacts`**（`references/` 与 `templates/`）。
