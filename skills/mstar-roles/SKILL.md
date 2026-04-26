---
name: mstar-roles
description: Morning Star (启明星) 的角色提示词总线。把 `agents/*.md` 的正文完全 skill 化：所有角色的完整行为定义都在 `references/`，`agents/*.md` 只保留 frontmatter 与 role 参数绑定。任何一个 Morning Star 角色（`project-manager` / `product-manager` / `architect` / `fullstack-dev` / `fullstack-dev-2` / `frontend-dev` / `qa-engineer` / `qc-specialist*` / `ops-engineer` / `market-expert` / `prompt-engineer`）开工前，都先加载本 skill，再按角色的 `Role parameters` 查参数表并 Read 对应 `references/*.md`。重复角色（`fullstack-dev` 与 `fullstack-dev-2`、`qc-specialist*`）共享同一 reference，参数不同行为不同，绝不复制多份正文。
---

## Load order（必读顺序）

**在同一会话或任务中首次经本 skill 承担 Morning Star 角色时：必须先 Read `mstar-harness-core` skill（SKILL.md，以及本任务将涉及的 `mstar-harness-core/references/`）。** 本 skill 只提供 **角色正文与参数表**；状态机、门禁、路由与 QC-QA 对齐以 **`mstar-harness-core`** 为准。冲突时 **以 `mstar-harness-core` 为准**。

**摘要**：`mstar-harness-core` — 全局 SSOT；`mstar-roles` — `agents/*.md` → `references/<role>.md` 的单一正文入口。

# Morning Star Roles Hub

本 skill 是 Morning Star 的 **角色提示词单一入口**。`agents/*.md` 仅承担 frontmatter 与参数绑定；角色正文权威在本目录 `references/`。

## 使用顺序（每次角色接任务时）

1. 读取当前 `agents/<role>.md` 的 frontmatter 与正文中的 `Role reference` / `Role parameters`。
2. **Read `mstar-harness-core` skill**（本会话尚未加载 harness 核心时**必须先完成**；含本轮任务相关的 `references/`）。
3. 读取本 SKILL.md，把下面的 **Skill dependencies** 与 **参数表** 解析到上下文。
4. Read 对应的 `references/<file>.md`；把正文中的 `{placeholder}` 用你的 `Role parameters` 原地替换。
5. 若 agent 壳层与 reference 冲突，以 **reference** 为准（壳层只定 permission / tools / 身份与参数）。

## Role Reference Mapping

| Agent id | Reference file | Parameterized slots |
|---|---|---|
| `project-manager` | `references/project-manager.md` | — |
| `product-manager` | `references/product-manager.md` | — |
| `architect` | `references/architect.md` | — |
| `fullstack-dev` | `references/fullstack-dev-shared.md` | `role_id`, `track` |
| `fullstack-dev-2` | `references/fullstack-dev-shared.md` | `role_id`, `track` |
| `frontend-dev` | `references/frontend-dev.md` | — |
| `qa-engineer` | `references/qa-engineer.md` | — |
| `qc-specialist` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `qc-specialist-2` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `qc-specialist-3` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `ops-engineer` | `references/ops-engineer.md` | — |
| `market-expert` | `references/market-expert.md` | — |
| `prompt-engineer` | `references/prompt-engineer.md` | — |

## Skill dependencies（所有角色默认适用）

所有角色在开工前都应把以下 skills 视为 **已加载依赖**，按需 Read 对应 SKILL.md 与 `references/`。**`mstar-harness-core` 已在「使用顺序」第 2 步作为全局前置**；下表中其余 skill 按任务阶段 Read。具体哪一条在哪个阶段被用到，由各 reference 自己说明。

| 依赖 skill | 当你的任务涉及… |
|---|---|
| `mstar-harness-core` | 状态机、Spec-Driven 双阶段门禁、Task category、分支 / worktree、QC-QA 检出对齐、调度防串扰 |
| `mstar-plan-conventions` | `{HARNESS_DIR}` / `{PLAN_DIR}` 发现与初始化、`status.json` SSOT、residual findings、knowledge/ 布局、工期预估 |
| `mstar-review-qc` | 工作流、审查清单、报告模板、门禁规则（三审角色必依赖，其它角色读懂门禁即可） |
| `mstar-routing-eval` | PM 路由回归与迭代评估（PM / prompt-engineer 主要依赖） |
| `mstar-coding-behavior` | Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven（所有实现、审查、重构任务） |
| `mstar-superpowers-align` | Morning Star × Superpowers 对齐与消解；`dispatching-parallel-agents` / `using-git-worktrees` 叠用约束 |
| 当前宿主的 `mstar-host` skill | 宿主能力差异（`question` 工具、subagent 调度、Task 并行等）；由各宿主自行提供 |

> **原则**：共享 skill 按名字引用（例：`mstar-harness-core` skill），**不写绝对路径**；宿主差异只用“当前宿主的 `mstar-host` skill”指代，避免把 Cursor/OpenCode 的专属路径塞进共享角色正文。

## 参数表（SSOT）

### Dev track（`fullstack-dev` 家族）

| `role_id` | `track` | 语义 |
|---|---|---|
| `fullstack-dev` | `primary` | 后端主导的主实现轨；Hotfix / 单流小改的默认承接方 |
| `fullstack-dev-2` | `parallel_secondary` | 第二实现轨；与 `fullstack-dev` 并行时承接独立模块 / API / 页面岛 |

说明：`fullstack-dev-shared.md` 中出现的 `{role_id}` / `{track}` 由 agent 的 `Role parameters` 决定；行为共享，"我是哪一轨"只影响边界协调与避免重叠。

### QC reviewer（`qc-specialist*` 家族）

| `role_id` | `reviewer_index` | `focus` | `report_suffix` |
|---|---|---|---|
| `qc-specialist` | `1` | 架构一致性、可维护性、长期演进风险（模块边界、抽象层次、依赖方向、可扩展性） | `qc1` |
| `qc-specialist-2` | `2` | 安全与正确性（输入校验、鉴权边界、敏感数据处理、异常路径、状态一致性） | `qc2` |
| `qc-specialist-3` | `3` | 性能与可靠性（复杂度、热点路径、资源释放、并发风险、退化风险） | `qc3` |

说明：`qc-specialist-shared.md` 中的 `{reviewer_index}` / `{focus}` / `{report_suffix}` / `{role_id}` 从此表按 agent 的 `Role parameters` 查表展开。Completion Report 的 **Agent** 行、报告文件名、commit message 都引用这些参数。

## 维护规则

- 角色行为改动先改 `references/*.md`；参数表（dev track / QC reviewer）改动先改本 SKILL.md。
- 引用其它 Morning Star skill 时，用 **skill 名** + 可选章节 / references 文件名；不写 `~/.config/opencode/...` 路径。
- 新增角色：(1) 在 **Role Reference Mapping** 登记；(2) 若是参数化家族，补进对应参数表；(3) 新增 `references/<role>.md` 或复用共享 reference；(4) 在 `agents/` 下建对应壳层文件。
- 重复角色只改共享 reference，不复制多份正文；角色差异只通过参数表演化。
