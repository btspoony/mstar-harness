---
name: mstar-phase-gates
description: "Morning Star (启明星) Spec-Driven 双阶段门禁 —— Prepare（`specify → clarify → plan`）、Execute（`plan(locked) → tasks → implement`；多 task 默认 **`Execution mode: sdd`**）、意图门禁、长期目标优先、分批 roadmap 强制落盘、clarify 核心纪律、hotfix 压缩路径、可验证编辑、Phase Gate 最小证据。**必须**在 PM 判定 gate、首次 implement 派单前、产品/架构参与 Prepare、或解释为何不能跳过 plan/clarify 时 Read；`@project-manager` 每轮编排非 hotfix 任务必读；`@product-manager` / `@architect` 写规格与锁 plan 时必读 Prepare 节；实现角色 Read Execute 与 hotfix 例外即可。Task category 与 `quick` 禁豁免规则仍在 `mstar-harness-core`。实现行为见 `mstar-coding-behavior`；SDD 见 `mstar-sdd`；迭代级活动见 `mstar-iteration`。"
---

## Load order（必读顺序）

**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。** `{PLAN_DIR}` / plan 文件落盘见 **`mstar-plan-conventions`**。冲突时 **以 `mstar-harness-core` 为准**。

## Spec-Driven 双阶段门禁（非热修强制）

### A. Prepare：`specify → clarify → plan`

- **`specify`** — 问题陈述、用户价值、范围/非目标、DoD 草案。
- **`clarify`** — 关键歧义清单与结论；高影响歧义必须收敛，否则 `Blocked`。
  - **意图核对（Intent gate）**：区分**用户字面表述**与**待解决的真正问题**；手段与目标混淆须在此收敛。
  - **结构化澄清**：宿主提供 `question` 工具时优先使用；否则用结构化正文选项。宿主细节在各自的 `mstar-host` skill。
  - **`clarify` 核心纪律（Prepare）**：对 plan/方案的**每个方面**持续核对，直到与用户达成**共享理解**；沿**设计决策树**逐枝下行，**一次只收敛一个决策点**及其依赖，再进入下一枝。
    1. **能查库则查库**：若问题可通过探索代码库（实现、配置、`{SPECS_DIR}`、`{KNOWLEDGE_DIR}`、`{ITERATION_DIR}` 等）得到答案，**先探索、不向用户提问**。
    2. **每问带推荐**：每个仍需用户确认的问题，须给出**推荐答案**（及简短理由），便于快速对齐。
    3. **收口摘要**：`clarify` 结束前列出：已决事项、仍 open 的假设、对 `plan` 的约束。
- **`plan`** — 技术方案、长期目标状态、模块边界/接口契约、风险与回滚点、验证计划。
  - **意图门禁**：锁 plan 前须能书面写清**真实目标 / 成功判据 / 非目标**三项；否则 Prepare 未通过。
  - **长期方案优先**：默认先设计目标状态，再裁剪本轮可交付切片；不得以“临时方案 / 混合方案 / 以后再说”替代目标设计。
  - **Durable Roadmap Gate**：若本轮只做部分范围，plan 必须写明 roadmap（批次、依赖、暂缓项、owner/触发条件、最终完成定义）。只有一句“后续再做 / next plan”视为未通过 plan gate。

### B. Execute：`plan(locked) → tasks → implement`

- **`plan(locked)`** — 冻结基线；实现中出现新约束时**先回写 plan 再继续**。
- **`tasks`** — 含依赖顺序、并行标记、完成判据；每任务可追踪到 plan、roadmap 批次与验收标准。
  - **并行标签**：≥2 条实现轨同时分派 → `Dispatch mode: parallel independent tracks`；同仓可写并发 → `Worktree isolation: required`（清单 **`mstar-branch-worktree`** → **`references/parallel-writable-pre-dispatch.md`**）。
- **`implement`** — 按 tasks 顺序执行；多 task plan **默认** `Execution mode: sdd`（`mstar-sdd`）；hotfix 可 `inline`。完成进入 `InReview`；遵循 **`mstar-coding-behavior`**。

### 可验证编辑与上下文纪律

- **读后再改**：修改文件前以磁盘内容为准重读（`Read`/等价工具）。
- **小步应用**：Patch 失败**禁止**在同一过时锚点连试；重读、缩小变更单元或拆步。
- **多文件改动**：逐项核对路径与引用，避免未验证的批量替换。

### Hotfix 例外

压缩路径与事后补记见下文 **§ Hotfix 例外**（Playbook 末尾）。

## Phase Gate Playbook

执行动作与最小产物见上文 **§ Spec-Driven 双阶段门禁**。本节仅 **Playbook 补充**（不重复 Prepare/Execute 长文）。

### Execute 补充（Playbook 专有）

- **`plan locked`**
  - 最小动作：在 plan 或 notes 记录当前锁定版本（日期或 hash）。
  - **Plan 质量门**（新 plan / 大改）：无 placeholder（`...`、`TBD`、`etc.`）；含 **Global Constraints** 与 per-task **Interfaces**；PM self-review 三问（每 task 可独立验证？依赖顺序清晰？无隐含假设？）— 见 `mstar-plan-artifacts/templates/plan.main.md`。
- **`implement`**
  - 最小产物：实现 diff、自检证据、回报与 handoff；行为准则 → **`mstar-coding-behavior`**；编辑纪律 → 上文「可验证编辑与上下文纪律」。
  - **知识库 / 迭代 compass**：若 `plans[].metadata` 登记了 `primary_spec` / `spec_refs` / `iteration_compass` / `iteration_refs`，**开工前**须阅读并在回报中说明已对齐 → **`mstar-plan-conventions`** · **`mstar-plan-artifacts/references/knowledge-and-designs.md`**。

## 角色职责

- `@project-manager`
  - 负责门禁判定与 Assignment 中的 `Phase Gate Checklist`。
  - 在 `Status Update` 汇报当前 gate 状态。
- 开发角色（`@frontend-dev` / `@fullstack-dev` / `@fullstack-dev-2`）
  - 仅在 Execute gate 放行后开始实现。
  - 发现新约束时先回报并请求回写 plan。
- `@qa-engineer` — when **`QA gate: mandatory`**, L4 per `mstar-roles/references/qa-engineer/acceptance-gate.md`; `pm-acceptance` is PM-only (`qa-trigger-matrix.md`).

## 迭代级活动

per-plan 门禁通过后，PM 在**迭代层面**管理以下活动（不计入 per-plan gate）：

- **迭代启动**（`mstar-iteration` § Phase 1）：锁定迭代范围、**显式 branch policy**（`iteration_base_branch` / `target_branch`）、产出 compass。
- **迭代驱动**（`mstar-iteration` § Phase 2 Autonomous Execute）：per-plan 派发循环（分支→实现→QC→**QA gate**→Done→合并），跨 plan 进度追踪，更新 compass 中各 plan 状态。
- **迭代收口**（`mstar-iteration` § Phase 3 iteration-close）：迭代内所有 plan Done 后，执行一轮知识结晶（`mstar-compound`）沉淀迭代经验，更新 roadmap，标记迭代完成。

per-plan Done 是 per-plan 的闭环终点；compound 是迭代级收口活动，不影响 per-plan 状态判定。

## Plan 目录与审查证据（启用 `{PLAN_DIR}` 时）

- 进入 `InReview` 后，QC/QA 原始过程报告默认落入 `{SDD_DIR}/review/`（**SDD 默认 tri** `qc1`…`qc-consolidated`；**inline** 单席 `qc.md`）。**fix 后默认 targeted re-review**。SDD per-task review 在 implement 波次内完成（`mstar-sdd` task reviewer）。PM 将 durable gate summary 回写主 plan / `status.json`，而不是把 raw reports 作为默认 git 产物。
- 非阻断项与后续技术债：PM 汇总后写入 `{HARNESS_DIR}/status.json` 根级 `residual_findings[<plan-id>]`（**open**，与 `plans` 平级；canonical 见 **`mstar-plan-artifacts` SKILL.md**）；关闭后迁入 `{HARNESS_DIR}/archived/residuals/<plan-id>.json`，与 `mstar-review-qc` 一致。每条 **`severity`** 遵守 **`mstar-plan-artifacts/references/status-and-residuals.md`**「Residual findings：severity（SSOT，机器字段）」。

## 快速判定（PM）

1. `specify` 是否完成？
2. `clarify` 是否完成（高影响歧义是否收敛）？
3. 意图门禁是否满足（真实目标 / 成功判据 / 非目标已写明）？
4. `plan` 是否完成并可引用？
5. 若 plan 涉及 UI 工作：`DESIGN.md` 是否存在且满足声明的 completeness level（见 `mstar-design-md`）？
6. 若分批/暂缓/临时绕行，roadmap 是否落在 plan/status 中，而不是只在对话里？
7. `tasks` 是否完成？
8. Assignment 是否含 **`Task category`**（实现类任务）并与 Owner 一致？
9. 若中途出现 plan drift，是否先回写再继续？
10. 实现说明中是否体现"最小耐久切片 + 手术式改动 + 可验证检查"？

**任一项为「否」时，`Gate decision` 必须是 `blocked`**。

> 迭代级活动（compound / iteration-close）见 `mstar-iteration`；不属于 per-plan gate 判定项。

## Hotfix 例外

- 允许路径：`specify(min) -> plan(min) -> implement`
- 必须补记：
  - 事后 `clarify/RCA`
  - 触发条件、影响范围、修复与回滚摘要

## 最小证据要求

- Prepare 阶段证据：问题定义、歧义结论、plan 链接。
- Execute 阶段证据：tasks 清单、实现自检、审查/验证证据。
- 结论证据：不得仅写"done"，必须可复核（命令、输出、截图或复现步骤）。
