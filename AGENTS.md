# OpenCode 全局 Rules（单一入口）

OpenCode 将会以本文件作为**全局规则**在每个会话加载。

**单一权威**：执行向规则与专题索引以本文件为准。

项目工作目录下自 cwd 向上解析的 `AGENTS.md` / `CLAUDE.md`（OpenCode 本地 Rules）优先于本文件。

## 护栏

- 未经用户**明确同意**，不得修改 `~/.config/opencode/opencode.json`、凭据文件或 `secrets.env`。详见 `~/.config/opencode/docs/agents/opencode-config-secrets.md` 与 `~/.config/opencode/docs/agents/superpowers-skills.md`。

## 适用范围

- 适用于使用 `~/.config/opencode/agents/*.md` 角色提示词的执行场景。
- 与具体业务仓库无关的流程规则，专题细节写在 `docs/agents/*.md`；本文件给出优先级、最小循环、不变量与专题索引。
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

1. `docs/agents/harness-loop.md` — 端到端任务生命周期、门禁流转；含 RCA、**Spec-Driven 双阶段门禁**、**Git 功能分支门禁**、可选前置门、与常见阶段化工作流的对照。
2. `docs/agents/evaluation-harness.md` — 如何评估和调优 agent 提示词与工作流。
3. `docs/agents/review-harness.md` — QC 共享审查清单、报告模板与门禁规则。
4. `docs/agents/routing-harness.md` — 如何验证 project-manager 的路由行为；配套场景集 `docs/agents/routing-evals.json`。
5. `docs/agents/plan-convention.md` — 计划目录发现、初始化、`status.json`（含 `metadata.residual_findings`）、`reports/<plan-id>/` 审查留档命名与 Git/可到达性策略。
6. `docs/agents/phase-gate-playbook.md` — Phase Gate 执行手册：各阶段角色动作与最小证据要求。
7. `docs/agents/branch-collaboration.md` — 可写角色的分支协作契约与统一确认话术模板。
8. `docs/agents/superpowers-skills.md` — Superpowers 与角色映射、与 harness 的对齐说明；未装插件时见文内「未安装插件时」。
9. `docs/agents/open-harness-principles.md` — 意图门禁、Task category、可验证编辑、长任务纪律、可选分层 `AGENTS.md` 等理念索引。
10. `docs/agents/optional-tooling-by-capability.md` — 按能力可选的 MCP/skills。
11. `docs/agents/library-docs-and-hosts.md` — 库文档检索单一协议（Context7 MCP / ctx7 CLI）、宿主差异、会话降噪；OpenCode 与 Cursor 差异。
12. `docs/agents/opencode-config-secrets.md` — 全局 `opencode.json` 密钥占位 `{env:}` / `{file:}` 与变量名说明；配合 `secrets.env.example`。
13. `docs/agents/effort-estimation.md` — Agent 语境下的工期与工作量口径：**仅** agent 实施（会话/尺码）；**禁止**与人天、FTE、人类日历混在同一 Effort 字段。

### **角色文件**

- 系统编排行为：`~/.config/opencode/agents/project-manager.md`
- 提示词与规则迭代：`~/.config/opencode/agents/prompt-engineer.md`
- 角色执行：`~/.config/opencode/agents/{role}.md`

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
- 语言约定（PM 编排场景）：Assignment 字段名保持既定英文键名；字段值中的任务描述正文默认可用中文。所有执行产出与报告默认英文，除非用户明确要求其他语言。
- 执行 Superpowers `writing-plans` 时，计划文件路径必须遵循 `plan-convention.md` 的 `{PLAN_DIR}` 解析结果；不得默认写入 `docs/superpowers/plans/`。
- **工作量与工期表述**：做计划、写 PRD/架构文档、Assignment 或 Status Update 时，遵循 `effort-estimation.md`：**只写 agent-oriented 预估**；**不得**在同一字段或同一段「预估」中纳入人类时间、人天、FTE 或日历等待（人类排期若有需要，须与 Effort 字段分离撰写）。

## 升级触发

以下情况应升级到人工决策：

- 验收标准与系统约束冲突
- 方案取舍存在重大风险或产品分歧
- 两次完整实现尝试后仍失败

## 知识库目标

- 保持角色提示词聚焦且稳定。
- 将可复用的流程知识从角色文件中抽离。
- 使行为可审计、易演进。
