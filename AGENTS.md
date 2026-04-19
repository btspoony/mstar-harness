# Code agent harness（全局入口）

本文件是**代码智能体（code agent）多角色工作流**的共享规则与专题索引入口。具体**宿主**（OpenCode、Cursor 等）如何自动加载本文件、是否提供子代理或 `question` 工具，见 `**docs/agents/host-opencode.md`** 与 `**docs/agents/host-cursor.md**`。

**单一权威**：执行向规则与专题索引以本文件为准（在未被项目规则覆盖的范围内）。

项目工作目录下自 cwd 向上解析的 `AGENTS.md` / `CLAUDE.md`（项目本地 Rules）优先于本文件。

## 宿主入口（先读对应小节，避免能力假设错误）


| 宿主           | 说明                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **OpenCode** | 每会话注入本文件；支持内置 `question`、可调 subagent；见 `docs/agents/host-opencode.md`                                                      |
| **Cursor**   | 通常需通过规则或手动 Read 加载本文件；`/pm` 等指令走 PM 提示词；可用 **Task** 并行拉起子代理（如 QC 三审）；会话工具与落盘路径与 OpenCode 不同，见 `docs/agents/host-cursor.md` |


库文档检索与宿主差异的共用协议：`docs/agents/library-docs-and-hosts.md`。

## 护栏

- 未经用户**明确同意**，不得修改 `~/.config/opencode/opencode.json`、凭据文件或 `secrets.env`。详见 `~/.config/opencode/docs/agents/opencode-config-secrets.md` 与 `~/.config/opencode/docs/agents/superpowers-skills.md`。

## 适用范围

- 适用于使用 `~/.config/opencode/agents/*.md` 角色提示词的执行场景（与具体业务仓库无关的流程规则）。
- 专题细节在 `docs/agents/*.md`；本文件给出优先级、最小循环、不变量与专题索引。
- 与项目规则冲突时，按下方「信息源优先级」处理。

## 信息源优先级

1. 当前任务中的用户指令
2. 项目级 `AGENTS.md` / `CLAUDE.md`（自 cwd 向上解析）
3. **本文件**（`~/.config/opencode/AGENTS.md`：全局 harness、专题索引、优先级与不变量）
4. `docs/agents/` 下专题文档（`harness-loop.md`、`review-harness.md` 等）
5. 角色提示词（`~/.config/opencode/agents/*.md`）

**冲突裁决**：同一事实在多层同时出现且仍无法一致解释时，以**当轮用户明确指令**为准；指令未覆盖或相互矛盾时，**暂停并升级人工**，不得擅自择一执行。

## 专题文档与角色归属

以下 `docs/agents/` 路径均相对于 `~/.config/opencode/`。在业务项目 cwd 下执行时，请用绝对路径读取 `~/.config/opencode/docs/agents/...`。

### **按任务深入阅读（推荐顺序）**

1. `docs/agents/harness-loop.md` — 端到端任务生命周期、门禁流转；含 RCA、**Spec-Driven 双阶段门禁**、**Git 功能分支门禁**、**开发并发须 `git worktree` 隔离**、**同 plan 多轨并行时推荐先建 plan 集成分支再挂各 worktree**（专节 **「多 worktree 并行开发与 QC / QA 的门禁衔接」** 内 **「推荐默认编排」**）、**多 worktree 并行开发后 QC 前须单一 `HEAD` 快照或拆 scope**、**QC / QA：`Review cwd`、同一 `plan_id` 与 `Review range` / `Diff basis`（三审逐字相同）**、**多 batch 计划下 QC 三审默认在整 plan 完成后一次**（细则见 `plan-convention.md`）、**内置 `@explore` 能力边界**（宿主支持时；禁止承接方用 explore 代做交付）、可选前置门、与常见阶段化工作流的对照。
2. `docs/agents/evaluation-harness.md` — 如何评估和调优 agent 提示词与工作流。
3. `docs/agents/review-harness.md` — QC 共享审查清单、报告模板与门禁规则。
4. `docs/agents/routing-harness.md` — 如何验证 project-manager 的路由行为；配套场景集 `docs/agents/routing-evals.json`。
5. `docs/agents/plan-convention.md` — **`{HARNESS_DIR}`**（默认 `.agents/`，SSOT 与时间线等）与 **`{PLAN_DIR}`**（默认 `{HARNESS_DIR}/plans/`，主 plan 与 `reports/`）的发现与初始化、**`{HARNESS_DIR}/status.json`**（**open** residual、空 `**plan-id` 键移除**、可选 `**metadata.tech_debt_summary`** 技术债一览）、`**{HARNESS_DIR}/archived/residuals/<plan-id>.json**`、可选 `**{HARNESS_DIR}/archived/plans/<plan-id>.json**`（Done 行冷快照与热文件**极简**行）、可选 `**{HARNESS_DIR}/notes.json`**（程序时间线，减轻 `status.json`）、`{PLAN_DIR}/reports/<plan-id>/`、**`{HARNESS_DIR}/knowledge/`** 与 `docs/` 分工、**已提交文档可到达性**（禁仓库外路径、禁仅本机路径）、Git 策略、合并前 SSOT 与事实一致。
6. `docs/agents/phase-gate-playbook.md` — Phase Gate 执行手册：各阶段角色动作与最小证据要求。
7. `docs/agents/branch-collaboration.md` — 可写角色的分支协作契约与统一确认话术模板。
8. `docs/agents/superpowers-skills.md` — Superpowers 映射与 harness 对齐（冲突以 harness / Assignment 为准；`**Delegation` 与 `Superpowers` 清单一致**见该文专节）；未装插件见文内「未安装插件时」。
9. `docs/agents/open-harness-principles.md` — 意图门禁、Task category、可验证编辑、长任务纪律、可选分层 `AGENTS.md`、**项目根 `AGENTS.md` 维护边界与典型信息源层级（模板）**等理念索引。
10. `docs/agents/optional-tooling-by-capability.md` — 按能力可选的 MCP/skills。
11. `docs/agents/library-docs-and-hosts.md` — 库文档检索单一协议（Context7 MCP / ctx7 CLI）、宿主差异、会话降噪。
12. `docs/agents/host-opencode.md` — OpenCode 加载方式、`question`、subagent 等。
13. `docs/agents/host-cursor.md` — Cursor、`/pm`、Task 子代理与 QC 三审对齐、补充编排模式。
14. `docs/agents/opencode-config-secrets.md` — 全局 `opencode.json` 密钥占位 `{env:}` / `{file:}` 与变量名说明；配合 `secrets.env.example`。
15. `docs/agents/effort-estimation.md` — Agent 语境下的工期与工作量口径：**仅** agent 实施（会话/尺码）；**禁止**与人天、FTE、人类日历混在同一 Effort 字段。

### **角色文件**

- 系统编排行为：`~/.config/opencode/agents/project-manager.md`（**Dev 三角**、`PM Task Board`、Assignment / `Dev routing`）
- 提示词与规则迭代：`~/.config/opencode/agents/prompt-engineer.md`
- 角色执行：`~/.config/opencode/agents/{role}.md`（在 OpenCode 下宜与 `opencode.json` 的 `agent.<role>.description` 与同文件 YAML `description` 对齐，便于路由与选角）

**全局配置的落盘变更仅由用户本人执行**；agent 可提议，不得擅自代写敏感配置。

## 最小交付循环（非平凡任务）

1. 准备阶段：`specify -> clarify -> plan`
2. 执行准备：`plan` 锁定后执行 `tasks` 拆解
3. 分派到最匹配角色并 `implement`
4. 审查与验证门禁（QC + QA）
5. 复盘沉淀为可复用规则

## 不变量

- 保持边界显式，避免跨层隐式耦合。
- 行为变更必须有对应验证证据。
- 拒绝未记录的破坏性变更。
- 对业务 Git 仓库的可合并改动，默认在功能分支上完成；默认分支直改需在 Assignment 显式写 `Branch policy` 例外。新开分支的**祖先**由 Assignment 写明（可从 `main`、已有 `feature/*`、或 `current` 叠分支；细则见 `harness-loop.md`）。
- **PM 开发分派（Dev 三角）**：`@fullstack-dev` 后端主导；用户可见 UI / 多文件前端默认由 `@frontend-dev` 主责；独立第二实现轨用 `@fullstack-dev-2`。勿在无 `Dev routing: single-stream — …` 时把「API + 实质 UI」默认单点塞给 `@fullstack-dev`。**`single-stream` 表示不并行多轨，不表示** Task Board 上全程只能 `fullstack-dev`：多批串行仍可按该专题 §6 在双后端轨间 round-robin，除非有锁 Owner 理由。全文见 `agents/project-manager.md`「Dev 三角平衡」。
- **同仓并行写入**：当 **≥2 个可写 subagent** 可能 **并发** 修改 **同一 Git 仓库** 时，**必须** 使用 `**git worktree`**（或等价独立检出）隔离目录，禁止多代理共用同一工作区 cwd；PM 须在 Assignment 写明分支策略与各流检出约定。细则见 `harness-loop.md`「同仓并发写入与 Git worktree」与 `superpowers-skills.md` 中 `**using-git-worktrees**`。（在 Cursor 使用 Task 并行多代理时，仍须遵守各流 **检出与工作区** 约定，禁止多可写者无隔离地共用一个 cwd，见 `host-cursor.md`。）
- **QC / QA 与 feature 检出**：QC 三审与 QA 验证针对 **已完成的 feature**；须在 PM 写明的 `**Review cwd / Worktree path`**、`**Working branch**`、`**plan_id**` 与 `**Review range` / `Diff basis**` 上对齐（**三份 QC 与 QA 的 `plan_id`、`Review range` 须逐字相同**）。**同仓、同一 plan、多 worktree 并行时**，**推荐**先建 **plan 集成分支** 再挂各轨 worktree，QC 前再将各轨 **归并**到 PM 指定为待审的 **`Working branch` / `HEAD`**；**强制**要求：派 QC 前须已可归约为 **单一** `HEAD` 快照（或拆 scope / 分轮次审查），**不得**单填一条开发 worktree 却覆盖未并入该分支的并行轨变更；见 `harness-loop.md`「多 worktree 并行开发与 QC / QA 的门禁衔接」（含 **推荐默认编排**）与「QC 三审、QA 验证与 feature 检出上下文」。**同一 plan 多 batch 时**，完整三审**默认在整 plan dev 完成后一次**（非每 batch），见 `plan-convention.md`。
- 语言约定（PM 编排场景）：Assignment 字段名保持既定英文键名；字段值中的任务描述正文默认可用中文。所有执行产出与报告默认英文，除非用户明确要求其他语言。
- 执行 Superpowers `writing-plans` 时，计划文件路径必须遵循 `plan-convention.md` 的 `{PLAN_DIR}` 解析结果；不得默认写入 `docs/superpowers/plans/`。
- **工作量与工期表述**：做计划、写 PRD/架构文档、Assignment 或 Status Update 时，遵循 `effort-estimation.md`：**只写 agent-oriented 预估**；**不得**在同一字段或同一段「预估」中纳入人类时间、人天、FTE 或日历等待（人类排期若有需要，须与 Effort 字段分离撰写）。
- **结构化澄清**：需要用户补充信息或做取舍时，**在提供 `question` 工具的宿主上优先使用该工具**；否则用结构化正文选项或宿主等价能力；仅当不适于结构化提问（例如需要大段叙述、或连续开放式访谈）时，再用自由正文追问。细则见 `docs/agents/harness-loop.md`（`clarify` 小节）、`docs/agents/phase-gate-playbook.md` 与 `agents/project-manager.md`。OpenCode 用户须自行在 `opencode.json` 中允许 `permission.question`；本仓库 agent 不得擅自改密钥类配置。

## 升级触发

以下情况应升级到人工决策：

- 验收标准与系统约束冲突
- 方案取舍存在重大风险或产品分歧
- 两次完整实现尝试后仍失败

## 知识库目标

- 保持角色提示词聚焦且稳定。
- 将可复用的流程知识从角色文件中抽离。
- 使行为可审计、易演进。