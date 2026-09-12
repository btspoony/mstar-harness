# Phase 1: start（启动迭代）— prepare detail

> Loaded by `mstar-iteration` SKILL.md on the **start** route（启动新迭代 / 重开方向锁定）。**Read `mstar-harness-core` first.** Per-plan gates → **`mstar-phase-gates`**；dispatch 机制 → **`mstar-dispatch-gates`**。Phase 1 在 PM lock 前不算完成（§1.6）。

PM 在新迭代启动时执行。

## 1.1 收集上下文

1. 读 `{ITERATION_DIR}/README.md`（若存在），了解历史迭代
2. 读 `STRATEGY.md`（若存在），对齐战略方向（见 `mstar-strategy`）
3. 读 `{KNOWLEDGE_DIR}/README.md`（若存在），将索引中的 **Active** 行视为 Research 候选（**不**要求阅读全部 knowledge 正文）
4. 如果有未完成的 roadmap 残余（上一迭代标记为 `next` 的 plan），纳入本次迭代范围候选

**非 command 触发**（如直接 skill 加载）时，Phase 1 方向锁定仍须 interactive（grill-me 在 command 层）。

## 1.2 定义迭代范围

与用户/产品对齐后（或按下方 **autonomous** 模式锁定后），确定：

| 字段 | 说明 |
|------|------|
| **Iteration ID** | 唯一标识，推荐 `v<major>.<minor>` 或 `iter-<YYYY-QN>` |
| **范围** | 本迭代要锁定的 spec 点（问题陈述清单） |
| **Plans** | 预期在本迭代中完成的 plan 列表（允许中途增减） |
| **里程碑** | 关键节点与日期 |
| **验收标准** | 迭代级别的 Done 定义 |
| **非目标** | 明确排除在本次迭代外的事项 |
| **Roadmap 上下文** | 本迭代在整体 roadmap 中的位置（current iteration / next iteration） |
| **Delivery branch policy** | `iteration_base_branch`（integration 分支从何处分出）、`spec_integration_branch`、`target_branch`（最终 PR 目标） |
| **Scale budget**（可选） | 仅当 caller **显式**给出或选用 **autonomous** 时适用：`S` = 1 **业务** plan；`M` = 2–3；`L` = 3–4（上限 4）；`XL` = **>4**（5+）。**只计实际业务交付 plan**，不计 harness 流程性工作（Review 链 / QC / QA / compound / close / PR 等）。**interactive 默认不强制** S/M/L/XL。计数细则 → **`references/autonomous-direction-lock.md`** § Scale budget |

### Direction lock modes

compass/plans 初稿落盘前，必须锁定**单一**迭代方向、成功标准、非目标，并确认 delivery branch policy；决策写入 compass `## Scope` / `## Acceptance Criteria` / `## Non-Goals` 与 Delivery Branch Policy。

| Mode | 何时选用 | 行为 |
|------|----------|------|
| **`interactive`** | **默认**（未显式声明 mode 时一律用此） | 与用户/产品**逐问**收敛方向与 branch policy；不得静默默认 `main`/`master` |
| **`autonomous`** | **仅**当 caller / Assignment **显式**声明 `Direction lock mode: autonomous`（或等价书面 opt-in） | 代码优先调研 → 排序候选 → **锁定推荐方向并落盘 rationale**；不因「是否同意该方向」例行问用户。细则 → **`references/autonomous-direction-lock.md`** |

**宿主 Plan UX（interactive）**：若宿主提供 Plan 会话（先写 session plan、后点 Build 才执行 todos）：

- 允许 **先 scaffold 空白 Phase 1 文档/todos**，再以 **用户反馈驱动** 收敛：Agent 探索并写入推荐，**原地更新同一份** session plan；用户提方向/意见，**不以**例行问卷为主路径。
- Branch policy：在 plan 中写推荐值 + rationale（不得静默 `main`/`master`）；用户可用反馈改正；仅在用户明确结束反馈后仍缺字段时再追问。
- 访谈式收敛 **仅**在反馈结束后仍有阻塞缺口时可选发起。
- **禁止**为更新内容再开第二份 session plan。

**非** Plan 会话仍按「收敛后再写 compass/plans 初稿」的默认顺序。此条 **不**改变 autonomous 路径，也 **不**要求非 Plan 宿主先写空文件。

**禁止**：在未显式 opt-in 时自行切换到 `autonomous`（例如仅因读了本 reference 或存在 roadmap next）。

**Branch policy gate（interactive — 默认路径）**：若用户、现有 roadmap、或项目约定未明确 `iteration_base_branch` / `target_branch`，PM 必须检查当前分支并向用户确认（**Plan 会话**走上方「推荐写入 plan + 反馈改正」；非 Plan 仍须确认）。**不得**因为存在 `main` / `master` 就默认从默认分支开 iteration 或向默认分支提 PR。

**Autonomous branch resolve**：仅 `autonomous` 模式；解析顺序与 STOP 规则见 **`references/autonomous-direction-lock.md`**（勿把该顺序套用到 interactive 以跳过向用户确认）。

## 1.3 创建迭代 package + compass

创建 `{ITERATION_DIR}/<iteration-id>/`，写入 **`delivery-compass.md`**（canonical；**禁止**新写根目录 `<id>-delivery-compass.md`）。**必须**使用 `references/iteration-compass-template.md` 完整结构（YAML frontmatter + `## Roadmap Position` + close 占位节）。`end_date` 仅在 iteration-close 填入；禁止用正文 completion prose 替代 frontmatter `status`。按需创建 `guides/`、`specs/` 与 package `README.md`。

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
iteration_base_branch: <branch-or-ref>
target_branch: <branch>
plans: []
---

# <iteration-id> Delivery Compass

## Scope
<本迭代要锁定的 spec 点>

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| <id> | <name> | Todo | |
| ... | ... | ... | |

## Milestones
| Milestone | Target date | Status |
|-----------|-------------|--------|

## Acceptance Criteria
- <迭代级验收项>

## Non-Goals
- <明确排除的事项>

## Roadmap Position
- Current iteration: <what this iteration delivers>
- Next iteration: <what comes next, owner, trigger>

## Delivery Branch Policy

| Field | Value |
|-------|-------|
| iteration_base_branch | <branch-or-ref> |
| spec_integration_branch | iteration/<iteration-id> |
| target_branch | <PR target> |
```

> **Engine check (when available):** import `validateCompassFrontmatter` from `@mstar-harness/engine` in a host hook to validate the compass frontmatter above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 1.4 更新索引

在 `{ITERATION_DIR}/README.md` 中添加**一行**（首次创建时建立表头；**一行 = 一次迭代**，不拆 compass/workspace 双行）：

| Iteration | Path | Description | Status |
|-----------|------|-------------|--------|
| `<iteration-id>` | [`<iteration-id>/`](<iteration-id>/) | `<简短描述>` | `active` |

> **Engine check (when available):** import `assertIndexRowObligations` from `@mstar-harness/engine` in a host hook to assert the index-row obligations above (no CLI form yet). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## 1.5 登记到 v2 状态面（formal iteration 必填）

iteration 正式全流程**必须**登记 `{HARNESS_DIR}/status.json`（v2 根）+ `{WORKFLOW_DIR}/<id>/snapshot.json`：

- 根 `status.json` `workflows[]` 增一条 active entry：`{ "id": "<iteration-id>", "type": "iteration", "started_at", "dir": "workflows/<iteration-id>" }`（engine `registerWorkflow`）。
- snapshot 顶层 `branch` anchors：`base`（= `iteration_base_branch`，创建 `spec_integration_branch` 的祖先 ref——**不是**隐式 `main`）、`integration`（= `spec_integration_branch`）、`target`（= iteration-close 后 PR 的目标分支）。
- 各 plan 行 `metadata.iteration_refs`、`spec_integration_branch`、`merge_target`（`merge_target` 通常为 `spec_integration_branch`）。

compass frontmatter 的 `iteration_base_branch` / `target_branch` **必须与** snapshot `branch` 一致；若仅写在 compass 而 snapshot 缺失，Phase 2 §2.3 同轮 backfill。

## 1.5.5 产物边界（specs · iterations · knowledge）

Phase 1 与 §1.6 须遵守 **`references/iteration-artifact-boundaries.md`**（HARD）：

| 树 | Phase 1（start）主责 | 说明 |
|----|---------------------|------|
| **`{SPECS_DIR}/`** | product-manager、architect | **长期**规范性产出：锁定规格、ADR、契约；plan `primary_spec` / `spec_refs` 主要挂此处 |
| **`{ITERATION_DIR}/`** | product-manager、architect、PM | **`<iteration-id>/` package**（`delivery-compass.md` + 迭代级 specs & guides） |
| **`{KNOWLEDGE_DIR}/`** | **非** start/execute 直写；**`mstar-compound`** @ iteration-close（含 package **提升**） | 可复用实施 SSOT |

**禁止**：product/architect 在 §1.6 向 `{KNOWLEDGE_DIR}/` **新增**；把迭代级草案写入 `{SPECS_DIR}/`（应进 `<iteration-id>/specs/` 或 guides）。

## 1.6 Review & Edit chain（integration 分支前强制）

**Phase 1 在 PM lock 前不算完成**——compass/plans 初稿落盘 ≠ Done。

**Assignment preflight（每次角色 invoke 前，HARD）**：自然语言 / skill 直接触发（非 command 路径）时，本 skill 不依赖 command 层 preflight——**每个** Phase 1 角色派发前，PM 必须运行 assignment preflight（`references/command-shared-invariants.md` 的 warn-only / `enforcement: hard` fail-fast 片段；`enforcement: hard` 时校验失败即阻断派发）。Command 层（`/iteration-start`）走其自身 preflight；本行确保 skill 触发路径门禁不缺失。

派发机制 → **`mstar-dispatch-gates`**（specialist review-and-edit dispatch，**顺序链**）。PM **不得**将迭代 harness 文档 commit 到 `spec_integration_branch`，直到：

1. **product-manager** → **architect** → **writing-specialist** 已按序 invoke 编辑 compass、plans、`{SPECS_DIR}/` 与 **`{ITERATION_DIR}/<iteration-id>/`** package（guides/specs，按需）；**不得**在 start 链向 `{KNOWLEDGE_DIR}/` 新增
2. **writing-specialist** 完成 **corpus hygiene**：仅本轮修改的 `{SPECS_DIR}/` / iteration package 与直接相关 knowledge 引用；错放迁回 **`<iteration-id>/`** package；细则 → **`iteration-corpus-hygiene.md`**、**`iteration-artifact-boundaries.md`**
3. PM 将 compass `status` 设为 `locked`，并确认各 plan 的 Prepare gate（specify / clarify / plan）

**顺序理由**：产品范围与优先级 → 架构与长期契约（specs）→ 行文、规格库卫生与错放纠正（在 PM/architect 定稿后核对受影响文档）。本共享产物链存在真实依赖；独立文档可按 ownership 隔离并行。早期全局探索的既有结果复用，不因每次编辑重新扫全库。OpenCode：plain role id — **`mstar-host/references/opencode.md`** § Role-mention hygiene。

**完成证据** = 磁盘上的 compass / plans / specs / iteration 文档修订 + specs（与既有 knowledge）卫生/归档（如有）+ 索引与 metadata 更新 + compass `status: locked`。**不**要求单独的迭代审查报告——迭代审查的 SSOT 是被编辑的文档本身，无 per-plan QC 式审计链。

**反模式**：PM 线程代替三角色完成全部编辑而不 invoke；或将本链三角色并行派发 —— 见 **`mstar-roles/references/_shared/leaf-executor-core.md`**「Shared anti-recursion NEVER」。
