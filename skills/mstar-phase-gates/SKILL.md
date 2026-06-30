---
name: mstar-phase-gates
description: Morning Star (启明星) Spec-Driven 双阶段门禁 —— Prepare（`specify → clarify → plan`）、Execute（`plan(locked) → tasks → implement`）、意图门禁、长期目标优先、分批 roadmap 强制落盘、clarify 核心纪律（共享理解 / 先探索 / 每问推荐答案）、hotfix 压缩路径、可验证编辑、Phase Gate 最小证据。**必须**在 PM 判定 gate、首次 implement 派单前、产品/架构参与 Prepare、或解释为何不能跳过 plan/clarify 时 Read；`@project-manager` 每轮编排非 hotfix 任务必读；`@product-manager` / `@architect` 写规格与锁 plan 时必读 Prepare 节；实现角色 Read Execute 与 hotfix 例外即可。Task category 与 `quick` 禁豁免规则仍在 `mstar-harness-core`。并行 Superpowers 短语见 `mstar-superpowers-align`。
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
  - **并行标签**：若 PM 将 ≥2 条实现轨 **同时** 分派，须在 `Superpowers` 中写入 `dispatching-parallel-agents`；同仓 ≥2 可写并发时叠 `using-git-worktrees`（见 **`mstar-superpowers-align`** 与 **`mstar-branch-worktree`**）。
- **`implement`** — 按 tasks 顺序执行并提交自检证据；完成进入 `InReview`；遵循 **`mstar-coding-behavior`**。

### 可验证编辑与上下文纪律

- **读后再改**：修改文件前以磁盘内容为准重读（`Read`/等价工具）。
- **小步应用**：Patch 失败**禁止**在同一过时锚点连试；重读、缩小变更单元或拆步。
- **多文件改动**：逐项核对路径与引用，避免未验证的批量替换。

### Hotfix 例外

- 压缩为 `specify(min) → plan(min) → implement`；必须在回报或 plan notes 补记事后 **`clarify/RCA`**。

## Phase Gate Playbook

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
  - **结构化澄清**：与用户核对歧义或决策时，`@project-manager`（及直接与用户对话的角色）在**宿主支持**时优先用 `question` 类能力拉齐输入；否则用等价结构化正文。宿主差异细则见当前宿主的 `mstar-host` skill。
  - **`clarify` 核心纪律**（见 **`mstar-phase-gates` SKILL.md** Prepare · `clarify`）：逐方面核对至共享理解；沿设计决策树逐枝、一次一决；能探索代码库则先探索；每问附推荐答案；阶段末汇总已决与仍 open 假设。
- `plan`
  - 目标：给出可执行技术方案与风险控制。
  - 最小产物：目标状态、方案、模块边界/接口契约、风险与回滚、验证计划。
  - **准入**：能书面写出真实目标、成功判据、非目标后再锁 plan（同 `SKILL.md`）。
  - **分批准入**：若计划不是一次性交付完整范围，须写 `Roadmap / Batch Plan`：本批做什么、后续批次做什么、依赖顺序、暂缓项、owner/触发条件、最终 Done 定义；缺失则 `blocked`。

### B. Execute

顺序：`plan locked -> tasks -> implement`

- `plan locked`
  - 目标：冻结本轮基线，防止边做边漂移。
  - 最小动作：在 plan 或 notes 记录当前锁定版本（日期或 hash）。
- `tasks`
  - 目标：把 plan 拆成可执行任务与依赖顺序。
  - 最小产物：任务列表、并行标记、完成判据、映射到验收标准与 roadmap 批次。
  - **PM**：若并行标记对应「多轨同时 implement」，在对外 **Status Update** 与实现 Assignment 的 **`Superpowers`** 中写入 **`dispatching-parallel-agents`**（或同义短语）；同仓多可写并发时叠 **`using-git-worktrees`**（见 `mstar-superpowers-align`）。
- `implement`
  - 目标：按任务执行并提交证据，进入审查。
  - 最小产物：实现 diff、自检证据、回报与 handoff。
  - **行为准则**：执行中遵循 `mstar-coding-behavior`（不静默假设、优先简单方案、只做与任务直接相关的手术式改动、按 `Step -> verify` 推进）。
  - **编辑纪律**：改文件前以磁盘为准重读；Patch 失败则重读、缩小步长，禁止盲试（见 **`mstar-phase-gates` SKILL.md**「可验证编辑与上下文纪律」）。
  - **知识库 / 迭代 compass**：若项目在 `plans[].metadata` 中登记了 `primary_spec` / `spec_refs` / `iteration_compass` / `iteration_refs`，**开工前**须阅读并在回报中说明已对齐；规则见 **`mstar-plan-conventions`** 与 **`mstar-plan-artifacts/references/knowledge-and-designs.md`**。

## 角色职责

- `@project-manager`
  - 负责门禁判定与 Assignment 中的 `Phase Gate Checklist`。
  - 在 `Status Update` 汇报当前 gate 状态。
- 开发角色（`@frontend-dev` / `@fullstack-dev` / `@fullstack-dev-2`）
  - 仅在 Execute gate 放行后开始实现。
  - 发现新约束时先回报并请求回写 plan。
- `@qa-engineer`
  - 在 `InReview` 阶段验证实现与验收映射是否一致。

### C. 知识结晶（Compound）：`Done → compound`（推荐）

`Done` 后，若本轮工作产出了可复用的洞察、模式、或值得沉淀的诊断，由 PM 触发 `mstar-compound`：

- **触发条件**：非平凡 bug 修复、新架构模式、新约定、工具链决策、有意义的排错经验。
- **产物**：`{KNOWLEDGE_DIR}/<category>/<slug>.md` + 可选 `CONCEPTS.md` / `AGENTS.md` 更新。
- **跳过条件**：纯机械性工作（格式化、依赖升级）、修复仅为打字错误。
- **知识维护**：定期或知识库明显膨胀时，PM 触发 `mstar-compound-refresh` 审查/合并/清理过期文档。

细则 → **`mstar-compound`** 与 **`mstar-compound-refresh`**。

## Plan 目录与审查报告（启用 `{PLAN_DIR}` 时）

- 进入 `InReview` 后，QC 书面产出落入 `{PLAN_DIR}/reports/<plan-id>/`（如 `qc1.md` … `qc-consolidated.md`）；**fix 后默认 targeted re-review**（原位更新同文件，不默认 `-rev2`），见 **`mstar-plan-artifacts/references/plan-files-and-reports.md`**。**多 batch**：完整三审**默认在整 plan dev 完成后一次**（非每 batch）。
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
11. `Done` 后，是否产出可复用的知识/模式？若是，是否已触发 `mstar-compound` 沉淀？

任一项为「否」时，`Gate decision` 必须是 `blocked`（第 11 项为推荐项，不影响 gate）。

## Hotfix 例外

- 允许路径：`specify(min) -> plan(min) -> implement`
- 必须补记：
  - 事后 `clarify/RCA`
  - 触发条件、影响范围、修复与回滚摘要

## 最小证据要求

- Prepare 阶段证据：问题定义、歧义结论、plan 链接。
- Execute 阶段证据：tasks 清单、实现自检、审查/验证证据。
- 结论证据：不得仅写"done"，必须可复核（命令、输出、截图或复现步骤）。
