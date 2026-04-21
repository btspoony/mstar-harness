# Morning Star (启明星) — Code Agent Harness 全局入口

本文件是 **Morning Star / 启明星** code agent harness 的**全局入口**，描述多角色 agent 工作流在本配置仓库中的组织方式。执行向规则与专题深度内容**不在本文件正文展开**，统一放入 `~/.config/opencode/skills/mstar-*/`（OpenCode / 中性流程）与 `.cursor/skills/mstar-host/`（Cursor 宿主）的 SKILL.md + `references/`。

**单一权威**：执行向规则与专题索引以本文件 + `mstar-*` skills 为准（在未被项目规则覆盖的范围内）。项目工作目录下自 cwd 向上解析的 `AGENTS.md` / `CLAUDE.md`（项目本地 Rules）优先于本文件。

## 宿主入口

| 宿主 | 说明 |
|------|------|
| **OpenCode** | 每会话自动注入本文件；支持内置 `question`、可调 subagent；细节见 **`mstar-host-opencode`** |
| **Cursor** | 通常需通过规则或手动 Read 加载本文件；`/pm` 等指令走 PM 提示词；可用 **Task** 并行拉起 QC 三审；细节见 **`.cursor/skills/mstar-host/SKILL.md`**（`mstar-host-cursor`） |

## 信息源优先级

1. **当前轮次的用户显式指令**
2. **项目级 `AGENTS.md` / `CLAUDE.md`**（自 cwd 向上解析）
3. **本文件**（`~/.config/opencode/AGENTS.md`：Morning Star 全局入口、skill 索引、优先级与护栏）
4. **`mstar-*` skills 正文**（SKILL.md 与 `references/`）
5. **角色提示词**（`~/.config/opencode/agents/*.md`）

**冲突裁决**：同一事实在多层同时出现且仍无法一致解释时，以**当轮用户明确指令**为准；指令未覆盖或相互矛盾时，**暂停并升级人工**，不得擅自择一执行。

## Morning Star Skill 索引（强制加载）

下列 skills 承载 harness 全部执行向规则。**每个角色在开工前须按其必读清单 Read 对应 SKILL.md**（角色必读表见各 `~/.config/opencode/agents/<role>.md` 开场块）。

| Skill | 职责范围 |
|-------|---------|
| **`mstar-harness-core`** | 总入口与不变量：状态机、Spec-Driven 双阶段门禁、Task category、`@explore` 边界、并行规则、Git 分支 / worktree、QC-QA 检出对齐、调度防串扰、升级触发、反模式 |
| **`mstar-plan-conventions`** | `{HARNESS_DIR}` / `{PLAN_DIR}` 发现与初始化、`status.json` SSOT、residual findings（severity 枚举 / 生命周期 / 归档）、`notes.json`、`tech_debt_summary`、`knowledge/` 开发知识库、reports 命名、QC 三审触发时机、Done 瘦身 Profile A/B、工期预估（agent-oriented only） |
| **`mstar-review-qc`** | QC 审查基线：工作流、清单、标准报告 Markdown 模板（YAML frontmatter + Findings 三档 + Summary + Verdict）、高危变更最小检查、门禁（Approve / Request Changes / Needs Discussion）、CI 门禁、residual 留档 |
| **`mstar-routing-eval`** | PM 路由回归（`assets/routing-evals.json`）+ prompt/规则迭代评估 + `Routing Eval Report` 输出模板 |
| **`mstar-coding-behavior`** | 跨角色通用编码行为：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution |
| **`mstar-superpowers-align`** | Morning Star × Superpowers：加载契约、最小声明契约、编排触发短语表、per-role 必用/宜用、`subagent-driven-development` 与 implementer-prompt 降权、QC 三审 × `using-git-worktrees` 叠用约束、张力与消解表 |
| **`mstar-host-opencode`** | OpenCode 宿主：全局规则注入、`question` 工具、`@explore` / `@general`、按角色模型、库文档 Context7 单一协议、按能力选配 MCP、`opencode.json` 密钥占位 |
| **`mstar-host-cursor`** (`.cursor/skills/mstar-host/SKILL.md`) | Cursor 宿主：Task 工具并行 QC 三审、单会话多帽 / 多窗口模式、implement 内禁止递归 Task、结构化 Markdown 澄清兜底 |

## 护栏（不变量）

- 未经用户**明确同意**，不得修改 `~/.config/opencode/opencode.json`、凭据文件或 `secrets.env`（详见 `mstar-host-opencode`）。
- 行为变更必须有对应验证证据；拒绝未记录的破坏性变更。
- 对业务 Git 仓库的可合并改动，默认在功能分支上完成；默认分支直改需 Assignment 显式写 `Branch policy` 例外（见 `mstar-harness-core`）。
- **Dev 三角**：`@fullstack-dev` 后端主导；用户可见 UI / 多文件前端默认由 `@frontend-dev` 主责；独立第二实现轨用 `@fullstack-dev-2`。详见 `~/.config/opencode/agents/project-manager.md`「Dev 三角平衡」。
- **同仓并行写入**：当 ≥2 个可写 subagent 并发修改同一 Git 仓库时，**必须**使用 `git worktree`（或等价独立检出）隔离；详见 `mstar-harness-core` `references/branch-and-worktree.md`。
- **QC / QA 与 feature 检出**：三审与 QA 须在 PM 写明的 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**、**`Review range` / `Diff basis`** 上对齐（三份 QC 与 QA 逐字相同）。
- **工作量与工期表述**：只写 agent-oriented 预估；不得纳入人天 / FTE / 人类日历（见 `mstar-plan-conventions` `references/effort-estimation.md`）。
- **结构化澄清**：宿主提供 `question` 类工具时优先使用；详见各 host skill。
- 执行 Superpowers `writing-plans` 时计划文件落在 `mstar-plan-conventions` 解析到的 `{PLAN_DIR}`，不得默认写入 `docs/superpowers/plans/`。
- 语言约定（PM 编排场景）：Assignment 字段名保持既定英文键名；字段值中的任务描述正文默认可用中文；执行产出与报告默认英文。

## 最小交付循环（非平凡任务）

1. **准备阶段**：`specify → clarify → plan`（含意图门禁）
2. **执行准备**：`plan(locked)` 后执行 `tasks` 拆解
3. **分派到最匹配角色**并 `implement`
4. **审查与验证门禁**（QC 三审 + QA）
5. **复盘沉淀**为可复用规则 / skill 更新

## 升级触发

以下情况应升级到人工决策：

- 验收标准与系统约束冲突
- 方案取舍存在重大风险或产品分歧
- 两次完整实现尝试后仍失败
- 根因无法在合理成本下收敛且继续修改代码风险高于等待人工决策

## 知识库目标

- 保持角色提示词聚焦且稳定。
- 将可复用的流程知识从角色文件中抽离进 `mstar-*` skills。
- 使行为可审计、易演进。
