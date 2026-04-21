# 开源 Agent Harness 理念（Morning Star）

## 定位

本文归纳从公开 agent harness 实践中提炼的**流程理念**，并已写入 `mstar-harness-core`、`~/.config/opencode/agents/project-manager.md` 等，作为本配置的默认行为约定。

## 已内化的原则（执行时必须遵守）

| 理念 | 含义 | 在本仓库的落点 |
|------|------|----------------|
| **意图优先于字面** | 先弄清「用户真正要达成什么」，再分类与分派 | `mstar-harness-core` SKILL.md「意图门禁」；PM「第一性原理」与 `clarify` |
| **先准备再实现** | 访谈式规划、锁范围、再写代码 | Prepare：`specify -> clarify -> plan`；Execute：`plan locked -> tasks -> implement` |
| **按任务类别选能力与模型** | 视觉/深读/快改/硬逻辑等用不同强项 | `mstar-harness-core` SKILL.md「Task category」；Assignment 字段 **`Task category`**；宿主侧按角色配置 model（如 OpenCode 的 `opencode.json`） |
| **可验证编辑** | 减少「凭记忆 Patch」导致的漂移与损坏 | `mstar-harness-core` SKILL.md「可验证编辑与上下文纪律」：读后再改、失败则重读 |
| **持续推进与可核对完成** | 长任务有清单、有关门证据，避免空转 | `mstar-superpowers-align` 的 `verification-before-completion`；PM 对 `tasks`/Phase Gate 的拉回 |
| **编码行为约束（轻量）** | 降低静默假设、过度设计与无关改动 | `mstar-coding-behavior`：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution |
| **并行与边界** | 多线任务不踩同一写归属、不绕过分支门禁；**开发**阶段同仓多可写并发须独立 **`git worktree`**；**QC / QA** 在 **同一检出**（`Review cwd`）与 **同一 `plan_id` + `Review range` / `Diff basis`** 上审查与验证，保证三票同一功能 | `mstar-harness-core` SKILL.md「并行规则」与 `references/branch-and-worktree.md`；`mstar-review-qc`；`mstar-superpowers-align` 的 **`using-git-worktrees`** |
| **分层上下文（可选）** | 大仓库用目录级 `AGENTS.md` 降噪；根 `AGENTS.md` 维护边界见下文专节 | `mstar-harness-core` SKILL.md「分层上下文」；由业务项目维护者按需添加 |
| **结构化澄清（按宿主）** | 向用户澄清/抉择时，**有 `question` 类能力则优先**；否则结构化正文；长问兜底 | `mstar-harness-core` SKILL.md「Spec-Driven」下 `clarify`；`mstar-host-opencode`；`.cursor/skills/mstar-host/`；`~/.config/opencode/agents/project-manager.md` |

## 与常见 harness 说法的对照（帮助理解角色分工）

| 常见说法 | 本仓库实体 |
|----------|------------|
| 总编排 | `@project-manager` |
| 规划/访谈 | `@product-manager` / `@architect` + Prepare 阶段 |
| category 路由 | **`Task category`** + 路由表 + 子代理选择 |
| 持续推进 / 不半途而废 | Phase Gate + Todo/`tasks` + 验证门禁 |
| 行级哈希锚定编辑 | 本仓库以 **读后再改 + 小步 Patch** 纪律落实（见 `mstar-harness-core`） |

## 项目根 `AGENTS.md` 写什么、不写什么（建议）

业务仓库根目录（或分层中的目录级）`AGENTS.md` 适合承载：**长期有效的规则、技术栈约束、工作流门禁**；不宜承载易变状态或已另有 SSOT 的内容，以免双轨漂移。

### 宜放入

- 技术栈与架构边界（变更时更新）
- 开发与验证命令、目录布局、命名约定
- 与 harness 对齐的**持久**规则（分支策略引用、**`{HARNESS_DIR}`** / **`{PLAN_DIR}`** 路径说明等）

### 不宜放入（应指向专门落点）

| 内容 | 更合适的落点 |
|------|----------------|
| 详细计划状态、阻塞列表、当前 sprint 叙述 | `{HARNESS_DIR}/status.json`（及可选 `{HARNESS_DIR}/notes.json` 程序时间线） |
| 规格正文、枚举定义、API 契约全文 | 项目约定的冻结规格目录（如 `docs/spec/`、`.agents/designs/...`，名称自定） |
| 某一 plan 的评审稿、gap 分析、实施笔记 | `{HARNESS_DIR}/knowledge/`（并维护索引 README，见 `mstar-plan-conventions`） |
| 临时 workaround、仅本轮有效的结论 | 主 plan 文件或 knowledge，收口后提炼再考虑进 `AGENTS.md` |

### 更新前自检（避免污染单一权威）

- 是否为**持久规则**，而非一两次性的当前状态？
- 是否适用于**整个项目**，而非单个 plan？
- 是否与冻结规格**重复**？若重复，应改为「引用路径」而非粘贴全文。
- 是否其实属于 **`{HARNESS_DIR}/status.json`**（状态、门禁摘要、时间线）？

### 典型信息源层级（模板）

项目可自定义目录名；逻辑顺序常为：

1. **冻结规格 / 设计权威**（版本化、显式变更流程）
2. **根 `AGENTS.md`** — 项目级规则与约定
3. **`{HARNESS_DIR}/status.json`** — 当前执行状态与 open residual 的 SSOT
4. **`{HARNESS_DIR}/knowledge/`** — 支撑实施的上下文文档

若 `AGENTS.md` 与冻结规格冲突，**以规格为准**，并修订 `AGENTS.md` 对齐。细节分工与可到达性要求见 `mstar-plan-conventions`。

## 延伸阅读

- 按能力选配 MCP/skills：`mstar-host-opencode`「可选工具」节
- Superpowers 与门禁对齐：`mstar-superpowers-align`
- 库文档检索与宿主差异（降噪、避免双轨冲突）：`mstar-host-opencode`「库文档检索」节 / `.cursor/skills/mstar-host/`
- 跨角色编码行为准则（轻量、可复用）：`mstar-coding-behavior`
