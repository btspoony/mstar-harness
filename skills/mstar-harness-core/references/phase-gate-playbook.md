# Phase Gate Playbook（Morning Star）

本手册将 `specify -> clarify -> plan -> tasks -> implement` 变成可执行动作，供 `@project-manager`、开发与 QA 在日常交付中快速对齐。

## 适用范围

- 非热修（non-hotfix）任务默认强制执行全链路门禁。
- 热修可走压缩路径，但必须补事后 `clarify/RCA` 记录。

## 两阶段门禁

### A. Prepare

顺序：`specify -> clarify -> plan`

- `specify`
  - 目标：定义问题、范围、验收。
  - 最小产物：问题陈述、目标用户价值、非目标、DoD 草案。
- `clarify`
  - 目标：收敛会影响方案或验收的歧义。
  - 最小产物：歧义清单 + 结论；若未收敛则 `blocked`。
  - **意图**：区分字面请求与真实目标；手段/目标混淆须在此收敛（见本 skill `SKILL.md` Intent gate）。
  - **结构化澄清**：与用户核对歧义或决策时，`@project-manager`（及直接与用户对话的角色）在**宿主支持**时（如 OpenCode 的 `question` 工具）**优先**用结构化提问拉齐输入；否则用等价结构化正文；细则见 `mstar-host-opencode` 与 `.cursor/skills/mstar-host/`。
- `plan`
  - 目标：给出可执行技术方案与风险控制。
  - 最小产物：方案、模块边界/接口契约、风险与回滚、验证计划。
  - **准入**：能书面写出真实目标、成功判据、非目标后再锁 plan（同 `SKILL.md`）。

### B. Execute

顺序：`plan locked -> tasks -> implement`

- `plan locked`
  - 目标：冻结本轮基线，防止边做边漂移。
  - 最小动作：在 plan 或 notes 记录当前锁定版本（日期或 hash）。
- `tasks`
  - 目标：把 plan 拆成可执行任务与依赖顺序。
  - 最小产物：任务列表、并行标记、完成判据、映射到验收标准。
  - **PM**：若并行标记对应「多轨同时 implement」，在对外 **Status Update** 与实现 Assignment 的 **`Superpowers`** 中写入 **`dispatching-parallel-agents`**（或同义短语）；同仓多可写并发时叠 **`using-git-worktrees`**（见 `mstar-superpowers-align`）。
- `implement`
  - 目标：按任务执行并提交证据，进入审查。
  - 最小产物：实现 diff、自检证据、回报与 handoff。
  - **行为准则**：执行中遵循 `mstar-coding-behavior`（不静默假设、优先简单方案、只做与任务直接相关的手术式改动、按 `Step -> verify` 推进）。
  - **编辑纪律**：改文件前以磁盘为准重读；Patch 失败则重读、缩小步长，禁止盲试（见 `SKILL.md`「可验证编辑与上下文纪律」）。
  - **知识库**：若项目启用 `{HARNESS_DIR}/knowledge/` 且当前计划在 `{HARNESS_DIR}/status.json` 的 `plans[].metadata` 中登记了 `primary_spec` / `spec_refs`，**开工前**须阅读并在回报中说明已对齐；规则见 `mstar-plan-conventions`「`{HARNESS_DIR}/knowledge/` 开发过程知识库」。

## 角色职责

- `@project-manager`
  - 负责门禁判定与 Assignment 中的 `Phase Gate Checklist`。
  - 在 `Status Update` 汇报当前 gate 状态。
- 开发角色（`@frontend-dev` / `@fullstack-dev` / `@fullstack-dev-2`）
  - 仅在 Execute gate 放行后开始实现。
  - 发现新约束时先回报并请求回写 plan。
- `@qa-engineer`
  - 在 `InReview` 阶段验证实现与验收映射是否一致。

## Plan 目录与审查报告（启用 `{PLAN_DIR}` 时）

- 进入 `InReview` 后，QC 书面产出按 `mstar-plan-conventions` 落入 `{PLAN_DIR}/reports/<plan-id>/`（如 `*-qc1.md` … `*-qc-consolidated.md`）；勿与主 plan 文件混写为「唯一草稿」后又删，保留可追溯历史。**多 batch 的同一 plan**：完整 QC 三审**默认在整 plan dev 完成后一次**（非每 batch），见 `mstar-plan-conventions`「QC 三审触发时机」。
- 非阻断项与后续技术债：PM 汇总后写入 `{HARNESS_DIR}/status.json` 的 `metadata.residual_findings[<plan-id>]`（**open**）；关闭后迁入 `{HARNESS_DIR}/archived/residuals/<plan-id>.json`，与 `mstar-review-qc` 一致。每条 **`severity`** 遵守 `mstar-plan-conventions`「Residual findings：severity（SSOT，机器字段）」。

## 快速判定（PM）

1. `specify` 是否完成？
2. `clarify` 是否完成（高影响歧义是否收敛）？
3. 意图门禁是否满足（真实目标 / 成功判据 / 非目标已写明）？
4. `plan` 是否完成并可引用？
5. `tasks` 是否完成？
6. Assignment 是否含 **`Task category`**（实现类任务）并与 Owner 一致？
7. 若中途出现 plan drift，是否先回写再继续？
8. 实现说明中是否体现"最小解法 + 手术式改动 + 可验证检查"？

任一项为「否」时，`Gate decision` 必须是 `blocked`。

## Hotfix 例外

- 允许路径：`specify(min) -> plan(min) -> implement`
- 必须补记：
  - 事后 `clarify/RCA`
  - 触发条件、影响范围、修复与回滚摘要

## 最小证据要求

- Prepare 阶段证据：问题定义、歧义结论、plan 链接。
- Execute 阶段证据：tasks 清单、实现自检、审查/验证证据。
- 结论证据：不得仅写"done"，必须可复核（命令、输出、截图或复现步骤）。
