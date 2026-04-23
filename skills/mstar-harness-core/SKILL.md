---
name: mstar-harness-core
description: Morning Star (启明星) harness 的**强制全局入口** —— 多角色 agent 交付的生命周期、状态机、Spec-Driven 双阶段门禁、Task category 路由、意图门禁、@explore 能力边界、长任务纪律、Git 功能分支与 worktree 隔离、QC/QA 检出上下文对齐、Context7 共享检索协议、Morning Star Skill 索引、护栏不变量、反模式与升级触发。**任何**在本配置仓库下工作的 code agent，在开始**任何非平凡任务之前**都必须 Read 本 skill 与当前任务相关的 `references/`。`@project-manager` 每轮编排前必读；所有实现/审查/QA/运维角色在接受 Assignment 后动手前必读；`@prompt-engineer` 改 prompt/skill 前必读；宿主自动注入的根目录 `AGENTS.md` 的全部作用就是把你指到本 skill。用于 OpenCode、Cursor 或任何多角色 code agent harness；与业务仓库具体技术栈无关。
---

# Morning Star Harness Core（启明星核心）

本 skill 是 **Morning Star / 启明星** code agent harness 的**唯一全局入口与 SSOT**。根目录 `AGENTS.md` 已瘦身为一句"强制读本 skill"的提示；所有执行向规则、skill 索引、护栏不变量与交付循环，全部在此维护。其它 `mstar-*` skill 只承载细分主题的展开；与本 skill **有冲突时，以本 skill 的状态机、门禁与路由表为准**。

## 信息源优先级

1. **当前轮次的用户显式指令**
2. **项目级 `AGENTS.md` / `CLAUDE.md`**（自 cwd 向上解析）
3. **`mstar-*` skills 正文**（本 skill + 其它 `mstar-*` 的 SKILL.md 与 `references/`）
4. **`mstar-roles` skill 的角色正文**（`references/<role>.md`）

**冲突裁决**：同一事实在多层同时出现且仍无法一致解释时，以**当轮用户明确指令**为准；指令未覆盖或相互矛盾时，**暂停并升级人工**，不得擅自择一执行。

## 最小交付循环（非平凡任务）

1. **准备阶段**：`specify → clarify → plan`（含意图门禁）
2. **执行准备**：`plan(locked)` 后执行 `tasks` 拆解
3. **分派到最匹配角色**并 `implement`
4. **审查与验证门禁**（QC 三审 + QA）
5. **复盘沉淀**为可复用规则 / skill 更新

## 适用范围

- 适用于通过 `mstar-roles` skill 加载角色提示词的执行场景（与具体业务仓库无关的流程规则）。
- 专题深度在本 skill 的 `references/` 与其它 `mstar-*` skill；本 SKILL.md 只给**状态机、门禁、不变量、索引**。

## 加载约定（强制）

- **`@project-manager`**：开轮次前**必须** Read 全部 `mstar-*` skills；编排动作与 Assignment 须与本 skill 一致。
- **实现/审查/QA/运维角色**：接到 Assignment 后、动手（写盘或第一次 `git commit`）**之前**，**必须** Read 本 skill 与角色对应的 `mstar-*` skills（各角色对应的必读清单见 `mstar-roles` skill 的 role profiles）。
- 本 skill 与 `references/` 都是**可复核规则**；不得在回报中声称已遵循而实际未读。

## 状态机

任务状态按下列路径流转：

1. `Todo`
2. `InProgress`
3. `InReview`
4. `Done` 或 `Blocked`

**状态权限**：

- `Done` 只能由 `@project-manager` 或 `@qa-engineer` 设置。
- 实现类 agent 可将工作移至 `InReview`，**不可**设为 `Done`。

## Spec-Driven 双阶段门禁（非热修强制）

### A. Prepare：`specify → clarify → plan`

- `specify` — 问题陈述、用户价值、范围/非目标、DoD 草案。
- `clarify` — 关键歧义清单与结论；高影响歧义必须收敛，否则 `Blocked`。
  - **意图核对（Intent gate）**：区分**用户字面表述**与**待解决的真正问题**；手段与目标混淆须在此收敛。
  - **结构化澄清**：宿主提供 `question` 工具时优先使用；否则用结构化正文选项。宿主细节在各自的 `mstar-host` skill。
- `plan` — 技术方案、模块边界/接口契约、风险与回滚点、验证计划。
  - **意图门禁**：锁 plan 前须能书面写清**真实目标 / 成功判据 / 非目标**三项；否则 Prepare 未通过。

### B. Execute：`plan(locked) → tasks → implement`

- `plan(locked)` — 冻结基线；实现中出现新约束时**先回写 plan 再继续**。
- `tasks` — 含依赖顺序、并行标记、完成判据；每任务可追踪到 plan 与验收标准。
  - **并行标签**：若 PM 将 ≥2 条实现轨 **同时** 分派，须在 `Superpowers` 中写入 `dispatching-parallel-agents`；同仓 ≥2 可写并发时叠 `using-git-worktrees`（见 `mstar-superpowers-align` 与本 skill `references/branch-and-worktree.md`）。
- `implement` — 按 tasks 顺序执行并提交自检证据；完成进入 `InReview`。

### 可验证编辑与上下文纪律

- **读后再改**：修改文件前以磁盘内容为准重读（`Read`/等价工具）。
- **小步应用**：Patch 失败**禁止**在同一过时锚点连试；重读、缩小变更单元或拆步。
- **多文件改动**：逐项核对路径与引用，避免未验证的批量替换。

### Hotfix 例外

- 压缩为 `specify(min) → plan(min) → implement`；必须在回报或 plan notes 补记事后 `clarify/RCA`。

详细节点与动作见 `references/phase-gate-playbook.md`。

## Git 功能分支与同仓并发写入（强制）

适用于 cwd 为 **Git 托管的业务/应用仓库** 且本轮会产生仓库内可合并 diff 的任务。**不**用于约束 `~/.config/opencode/`（全局配置对 agent 只读）。

- **唯一分支决策者**：**只有 `@project-manager`** 可以决定分支策略；其他可写角色不得自行新开分支或切回 `main`/`master`。
- **默认保护分支禁直改**：除 Assignment 显式写 `Branch policy: direct on <branch> — <reason>`，禁止在 `main`/`master` 上直接实现功能改动。
- **同仓 ≥2 可写并发**：**必须**使用 `git worktree`（或等价独立检出）隔离；PM 须在 Assignment 写明 `Worktree path` / 检出约定。
- **多 worktree 并行开发 → QC/QA**：派三审前**必须**将全部待审提交归并到**单一 `HEAD`**（通常为 PM 约定的 **plan 集成分支**）；禁止用仅含部分轨变更的开发目录作为 `Review cwd`。
- **三审对齐**：三份 QC Assignment 与 QA Assignment 的 `plan_id`、`Review range` / `Diff basis` **逐字相同**。

完整规则、`Working branch` 字段模板、集成分支推荐编排、三审/QA 检出对齐细则见 **`references/branch-and-worktree.md`**。

## Task category 与角色倾向

`@project-manager` 在 Assignment 写明 **`Task category`**（一个主类 + 可选 `secondary`），驱动"按任务性质选强项"的编排：

| Category | 典型工作 | 倾向角色 |
|----------|----------|----------|
| `visual` | UI/UX/组件/样式/可访问性 | `@frontend-dev`；复杂信息架构前置 `@product-manager` |
| `deep` | 陌生模块摸底、端到端 trace、大范围阅读 | `@explore` 优先，再交 `@fullstack-dev*` 或 `@architect` |
| `quick` | 单文件、文案、小配置、typo | `@general` 或单开发角色；不因体量跳过既定门禁 |
| `logic` | 难算法、并发、一致性、架构取舍 | `@architect` + 开发角色 |
| `ops` | CI/CD、部署、监控、基础设施 | `@ops-engineer` |
| `docs` | 纯 Markdown 规格/PRD（无运行时行为变更） | `@product-manager` / `@architect` |

### `Task category` 与 Prepare 门禁（硬规则）

- **`quick` 从不豁免 Prepare**：非 hotfix 下，无论主类是否为 `quick`，**都必须**完成 `specify → clarify → plan`（及 `tasks`）后再进入 `implement`。`quick` **只**影响「默认倾向哪个执行角色」，**不是**「可跳过 plan / `status.json` / 主 plan 文件」的许可证。
- **禁止滥用 `quick`**：下列任一类工作 **不得** 作为主类标 `quick`（应改用 `logic` / `deep` / `visual` / `ops` 等真实类别，且仍走完整 Prepare）：新增或变更 **CLI 子命令 / 公共 API**；新增或升级 **依赖清单**；**新增测例 + 回归或全量测试**；跨 **≥2 个顶层模块** 或需新 **持久化契约**（导出格式、配置模式等）的改动。
- **已启用 `{HARNESS_DIR}` 时**（见 `mstar-plan-conventions` 目录解析）：非 hotfix 的首次 **implement** 派单前，须已有可引用的 **主 plan 文件**（`{PLAN_DIR}/…`）且 Assignment 的 **`Plan Path`** 指向该真实路径；并须在**同一协调轮次**内把该 `plan_id` 写入 **`{HARNESS_DIR}/status.json`**（或显式写明「本回合先建 plan 与登记后再 invoke implement」且实际执行后再派单）。缺一则 **BLOCKED**，不得 invoke 实现类 subagent。

## 内置 `@explore` 能力边界（强制）

在支持 `@explore` 的宿主（如 OpenCode）上，`@explore` 是**只读、快速的代码库导航 subagent**。

- **禁止代劳交付**：任何已分派到具体角色的 Assignment，承接方**不得**用 `@explore` 代替本角色应完成的**实现、改库、写测试、跑命令取证、写审查结论、写 PRD/架构文档、写 QA 报告**。
- **允许用法**：**短、窄**的只读辅助（定位路径、粗调用关系、关键词检索）；得到线索后立即回到本角色。
- **优先默认**：内置 `glob`/`grep`/`read` 能在合理步数内完成时，**不必**调用 `@explore`。
- **与 PM 分工**：PM 在分派前调用 `@explore` 摸底并写入 Assignment 是**推荐模式**；**分派后**承接方不应把作业转包给 `@explore`。

## 调度防串扰（强制）

- 只有 `@project-manager` 可以决定增加/并行 subagent；承接方**默认不得二次分派**。
- **`Execute as: <role-id>`** = 承接方**亲自**完成本单，**不是**再起同名 subagent 或嵌套同 `subagent_type` 的 Task（禁止**递归误派**）。
- 额外代理仅以 **`Delegation: allowed (...)`** 为准。未显式写时视为 `Delegation: forbidden`。
- Assignment 正文中的 `@xxx` 默认按「文本引用」解释，不视为自动调用命令。
- 承接方若判断必须增加 subagent，应先回报 `Blocked` 请 PM 重分派。
- **Superpowers `subagent-driven-development`**：per-task 子步**勿**用 `@qc-specialist*`；用 `@general` / `generalPurpose` 或 PM 标明的 informal `@qa-engineer`。详见 `mstar-superpowers-align`。

## 长任务纪律

- 非平凡任务须有可追踪清单（plan 的 `tasks` 或等价 Todo），**逐项关门**并保留核对痕迹。
- 承接方长时间无产出或偏离 `Acceptance Criteria` 时，`@project-manager` 应拉回对照 Phase Gate 与任务列表。
- 宣称完成、sign-off 或合并结论前，须满足可核对证据（与 `mstar-superpowers-align` 中 `verification-before-completion` 一致）。

## 并行规则（摘要）

- 独立模块可并行；避免写操作归属重叠。
- 跨领域变更时，先锁定接口契约再并行编码。
- **串行多批** ≠ **全程仅 `fullstack-dev`**：纯后端多单元仍可在 `fullstack-dev` / `fullstack-dev-2` 间串行 round-robin（见 `mstar-roles` skill 的 `project-manager` 角色 Dev 三角 §6）。
- **QC 三审**在 feature 开发完成后执行，三名 reviewer 共用同一组 `Review cwd` / `Working branch` / `plan_id` / `Review range` / `Diff basis`。
- **同一 plan 多 batch**：默认**仅**对整 plan 交付完成跑一轮完整三审；复验波次用新文件名（详见 `mstar-plan-conventions` 与 `mstar-review-qc`）。
- 完整并发/worktree/QC 对齐规则见 `references/branch-and-worktree.md`。

### 并发分派完整性门禁（PM 强制）

当 PM 声明“并发分派”时，必须同时满足**文案并发**与**工具并发**：

- **工具并发定义**：同一调度轮次内，需并发的多个 subagent 调用必须在**同一条 assistant 消息**里一次性发出。
- **QC 三审硬门禁**：`qc-specialist` / `qc-specialist-2` / `qc-specialist-3` 必须在同一条消息内全部发起；只发其中一个不算“三审已并发启动”。
- **禁止误报**：若实际仅发起 1 个调用，状态应标记为 `Blocked` 或 `dispatch incomplete`，不得写“已启动 QC 三审并行”。
- **先自检再发送**：发送前核对“Assignment 条数 = 本条消息中的实际调用条数”；不一致时先补齐再发。

## 分层上下文（大型仓库，可选）

对体量很大的单体或多包仓库，可在业务项目内按目录维护层级 `AGENTS.md`（模块边界、约定、禁区）。由项目维护者按需引入；本 harness 不强制自动生成。

理念层：`references/open-harness-principles.md`。

## 库文档检索协议（Context7，共享）

回答涉及具体框架、SDK、CLI、云服务的 API 与配置问题时，使用本共享协议；不在宿主专属 skill 重复维护。

### 目标与边界

- **目标**：优先使用现行文档，降低版本漂移导致的错误回答。
- **不适用**：纯重构、从零写脚本、业务逻辑排错、代码评审、泛化编程概念。

### 单一路径规则（禁止双跑）

1. **主路径：Context7 MCP（可用时）**
   - 先读 MCP 工具 schema，再调用文档查询工具。
   - 查询句使用用户完整问题；版本相关时选择带版本信息的 library ID。
2. **备用路径：ctx7 CLI（MCP 不可用时）**
   - `npx ctx7@latest library <name> "<user question>"`
   - `npx ctx7@latest docs <libraryId> "<user question>"`
   - 单问题最多 3 次命令；命令中不得包含密钥。

- **禁止**：同一问题内对同一库同时使用 MCP 与 CLI 做重复全量拉取。
- **降级策略**：仅在主路径失败时切换备用路径。

## 升级触发（人工介入）

- 澄清尝试后验收标准仍模糊
- 评审结论冲突且证据强度相当
- 重复实现失败表明缺少的是能力而非努力
- 根因无法在合理成本下收敛且继续修改代码风险高于等待人工决策

升级报告包含：当前状态、可选方案与权衡、推荐路径。

## 反模式

- 角色文件中塞入本应在 skills 中的流程说明导致 prompt 膨胀。
- 在代码中做出隐藏的策略决策而不更新 plan。
- 没有测试或行为证据就声明完成。
- 不改变约束或工具就重复走同一条失败路径。
- 未重读文件即反复 Patch；对 apply 失败用同一过时锚点连试。
- 意图未收敛即实现。
- 将 **`Task category: quick`** 当成可跳过 **`specify → clarify → plan`** 的借口，或把「新 CLI / 新依赖 / 新测试 / 多模块」误标为 **`quick`** 以快进实现（见上节「`Task category` 与 Prepare 门禁」）。
- 省略 `Task category` 导致角色/模型选择错配（除非极简 explore-only 且路由表已唯一）。

## Morning Star Skill 索引

下列 skills 承载 harness 全部执行向规则。角色运行时先按本 skill 进入，再按角色职责按需加载对应 skill。

| Skill | 职责范围 |
|---|---|
| **本 skill `mstar-harness-core`** | 总入口与不变量：状态机、Spec-Driven 双阶段门禁、Task category、`@explore` 边界、并行规则、Git 分支 / worktree、QC-QA 检出对齐、调度防串扰、升级触发、反模式、**Context7 共享检索协议**、宿主入口、最小交付循环 |
| `mstar-plan-conventions` | `{HARNESS_DIR}` / `{PLAN_DIR}` 发现与初始化、`status.json` SSOT、residual findings（severity 枚举 / 生命周期 / 归档）、`notes.json`、`tech_debt_summary`、`knowledge/` 开发知识库、reports 命名、QC 三审触发时机、Done 瘦身 Profile A/B、工期预估（agent-oriented only） |
| `mstar-roles` | 角色提示词总线：`agents/*.md` 仅保留 frontmatter + 参数绑定；完整角色正文在 `mstar-roles` skill 的 `references/`（含重复角色共享 reference） |
| `mstar-review-qc` | QC 审查基线：工作流、清单、标准报告 Markdown 模板（YAML frontmatter + Findings 三档 + Summary + Verdict）、高危变更最小检查、门禁（Approve / Request Changes / Needs Discussion）、CI 门禁、residual 留档 |
| `mstar-routing-eval` | PM 路由回归（`assets/routing-evals.json`）+ prompt/规则迭代评估 + `Routing Eval Report` 输出模板 |
| `mstar-coding-behavior` | 跨角色通用编码行为：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution |
| `mstar-superpowers-align` | Morning Star × Superpowers：加载契约、最小声明契约、编排触发短语表、per-role 必用/宜用、`subagent-driven-development` 与 implementer-prompt 降权、QC 三审 × `using-git-worktrees` 叠用约束、张力与消解表 |

## 宿主的 **mstar-host** 技能以及它们的区别

可以通过宿主加载名为 `mstar-host` 它们同名，但在不同宿主下有不同的描述。

| 宿主 | 启动方式与职责范围 |
|---|---|
| **OpenCode** | 每会话自动注入根目录 `AGENTS.md`（其内容就是把你指到本 skill）；支持内置 `question` 工具、`@explore` / `@general`、按角色模型可调 subagent；差异细节见加载到的 `mstar-host` skill |
| **Cursor** | 不自动注入 `AGENTS.md`；会话启动时先 Read 本 skill；`/pm` 等指令走 PM 角色；可用 **Task** 工具并行拉起 QC 三审；差异细节见宿主加载到的 `mstar-host` skill |
| 其它宿主 | 按宿主支持的 Rules / Skills 机制在会话初始化时强制 Read 本 skill；其它 `mstar-*` skill 按本 skill 的索引表按需加载 |

## 护栏（不变量）

- 未经用户**明确同意**，不得修改 `opencode.json`、凭据文件或 `secrets.env`。
- 行为变更必须有对应验证证据；拒绝未记录的破坏性变更。
- 对业务 Git 仓库的可合并改动，默认在功能分支上完成（除 Assignment 显式写 `Branch policy` 例外）。
- **Dev 三角**：`@fullstack-dev` 后端主导；用户可见 UI / 多文件前端默认由 `@frontend-dev` 主责；独立第二实现轨用 `@fullstack-dev-2`。详见 `mstar-roles` skill 的 `project-manager` 角色「Dev 三角平衡」。
- **同仓并行写入**：当 ≥2 个可写 subagent 并发修改同一 Git 仓库时，**必须**使用 `git worktree`（或等价独立检出）隔离；详见 `references/branch-and-worktree.md`。
- **QC / QA 与 feature 检出**：三审与 QA 须在 PM 写明的 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**、**`Review range` / `Diff basis`** 上对齐（三份 QC 与 QA 逐字相同）。
- **工作量与工期表述**：只写 agent-oriented 预估；不得纳入人天 / FTE / 人类日历（见 `mstar-plan-conventions` `references/effort-estimation.md`）。
- **结构化澄清**：宿主提供 `question` 类工具时优先使用；宿主差异以对应的 `mstar-host` skill 为准。
- 执行 Superpowers `writing-plans` 时计划文件落在 `mstar-plan-conventions` 解析到的 `{PLAN_DIR}`，不得默认写入 `docs/superpowers/plans/`。
- **语言约定**（PM 编排场景）：Assignment 字段名保持既定英文键名；字段值中的任务描述正文默认可用中文；执行产出与报告默认英文。

## 知识库目标

- 保持角色提示词聚焦且稳定（长正文走 `mstar-roles` 的 references）。
- 将可复用的流程知识从角色文件中抽离进 `mstar-*` skills。
- 使行为可审计、易演进；单一 SSOT、skill-name 引用，不散落绝对路径。

## References

- `references/phase-gate-playbook.md` — Phase Gate 执行手册：各阶段角色动作与最小证据要求。
- `references/branch-and-worktree.md` — 功能分支门禁 / 分支协作契约 / 同仓并发 worktree / 多 worktree 并行开发与 QC-QA 衔接 / plan 集成分支推荐编排 / QC-QA 检出上下文对齐。
- `references/open-harness-principles.md` — 意图门禁、Task category、可验证编辑、长任务纪律、分层 `AGENTS.md`、项目根 `AGENTS.md` 维护边界。
- `references/library-docs-protocol.md` — Context7 文档检索共享协议（MCP 优先、CLI 兜底、禁双跑）。
