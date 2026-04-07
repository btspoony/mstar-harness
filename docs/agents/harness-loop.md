# 多 Agent 交付执行循环

本文档定义了 agent 团队处理任务的默认执行生命周期。

## 设计意图

目标是在风险可控的前提下实现高吞吐：

- 让人类专注于意图、取舍和最终验收
- 让 agent 处理实现和常规验证
- 保留足够的结构使后续运行能可靠衔接

## 状态机

任务状态应按以下路径流转：

1. `Todo`
2. `InProgress`
3. `InReview`
4. `Done` 或 `Blocked`

状态权限：

- `Done` 只能由 `@project-manager` 或 `@qa-engineer` 设置。
- 实现类 agent 可将工作移至 `InReview`，不可设为 `Done`。

## 阶段契约

### Spec-Driven 双阶段门禁

为减少“计划偏差导致返工”，默认采用下列两阶段串行门禁。除热修（hotfix）外，不应跳过。

#### A. 准备阶段（Prepare）

固定顺序：`specify -> clarify -> plan`

- `specify`（问题与目标定义）
  - 产出：问题陈述、用户价值、范围/非目标、可观察验收标准（DoD 草案）。
  - 禁止：在目标未清晰前直接写实现方案。
- `clarify`（歧义清理）
  - 产出：关键歧义清单及结论（数据口径、边界条件、异常路径、权限/角色、性能与约束）。
  - 退出条件：高影响歧义（会改变方案或验收）必须收敛，未收敛则标记 `Blocked` 并升级。
  - **意图核对（Intent gate）**：必须区分**用户字面表述**与**待解决的真正问题**；若高影响歧义包含「把手段当目标」或验收与用户真实诉求不一致，须在 `clarify` 收敛后再前进。
- `plan`（实现设计）
  - 产出：技术方案、模块边界/接口契约、风险与回滚点、验证计划。
  - 准入条件：必须引用已完成的 `specify/clarify` 结论；禁止“无澄清输入”的孤立 plan。
  - **意图门禁（Intent gate）**：进入 `plan(locked)` 前，须能书面回答——**(1) 真实目标（可观察结果）**、**(2) 成功判据**、**(3) 非目标（明确不做）**。若只能复述用户原话而答不出上列三点，视为 Prepare 未通过，不得锁定 plan。

#### B. 执行阶段（Execute）

固定顺序：`plan(locked) -> tasks -> implement`

- `plan(locked)`（计划冻结）
  - 要求：进入实现前锁定本轮 plan 版本（可在 notes 记录 hash/date）。
  - 变更规则：实现中若出现新约束，先回写 plan 再继续开发，避免“代码先行、计划滞后”。
- `tasks`（任务拆解）
  - 产出：按用户故事/模块拆解的可执行任务，包含依赖顺序、并行标记、完成判据。
  - 质量门：每个任务必须映射到 plan 条目与验收标准（可追踪）。
- `implement`（开发执行）
  - 要求：开发角色按 tasks 顺序执行并提交自检证据；完成后进入 `InReview`，不得直接置 `Done`。

##### 可验证编辑与上下文纪律

业界常称的「Harness 问题」：模型凭会话内陈旧片段去 Patch，与磁盘不一致导致失败或静默错改。在未使用行级内容哈希类编辑工具时，执行方须用下列纪律补偿：

- **读后再改**：对将被修改的文件，在应用编辑前以**当前磁盘内容**为准重新读取（`Read`/等价工具），禁止仅凭早前对话中的代码块盲改。
- **小步应用**：优先小范围变更；若 Patch/apply 因内容不匹配失败，**禁止**在同一过时锚点上连续重试多次；应重读文件、缩小变更单元或拆分步骤。
- **多文件改动**：逐项核对路径与引用，避免批量替换未经验证。

#### 热修例外

- hotfix 可压缩为 `specify(min) -> plan(min) -> implement`，但必须在回报或 plan notes 补记事后 `clarify/RCA`。

### 1) 意图与范围

负责人：`@project-manager`

必需产出：

- 清晰的问题陈述
- 具有可观察结果的验收标准
- 初始负责人指派

### 2) 探索与设计

负责人：`@explore` + `@architect`（视复杂度可选）

必需产出：

- 现状映射
- 推荐方案与备选方案
- 跨模块工作时的显式接口或边界

**非热修缺陷的最低要求（RCA 门禁）**：在进入实质性代码修改前，应有一份可检验的**根因结论或带证据的假设**（复现步骤、日志/指标片段、相关调用链或数据路径）。禁止在“完全未知根因”的情况下堆叠猜测式补丁；若证据不足，应先缩小范围（加观测、最小复现）再改代码。热修复路径以保持服务为先，但仍须在 plan 或回报中补记事后 RCA。

### Git 功能分支门禁（业务仓库）

适用于 cwd 为 **Git 托管的业务/应用仓库** 且本轮会产生**仓库内可合并 diff** 的任务（代码、业务向测试与 fixture、影响构建或运行时的配置等）。**不**用于约束 `~/.config/opencode/` 全局配置目录（该目录对 agent 只读；落盘仅由用户执行）。

与 PM/可写角色的协同细则（含用户确认话术）见：`~/.config/opencode/docs/agents/branch-collaboration.md`。

#### 默认规则

- 不得在**默认保护分支**（常见名：`main`、`master`；以项目约定为准）上直接实现功能改动，除非 Assignment 含显式例外。
- 例外须在 Assignment 中写明一行：**`Branch policy: direct on <branch> — <reason>`**（典型：团队约定的热修直接打默认分支）。

**`<base>` 与叠分支（stacked branches）**

- 门禁的目标是**不在未授权的默认分支上直接提交**，不是「只能从 `main` 开新分支」。
- 当需要**从已有功能分支继续拆新分支**时，Assignment 应写清**祖先分支** `<base>`，例如：`create feature/foo-part2 from feature/foo`。
- **`<base>` 可取**：`main` / `master`（或项目默认分支名）、任意已存在的 `feature/*` / `fix/*`、远程跟踪分支名、或 **`current`**（表示以执行者检出时的 `HEAD` 为祖先，用于「就在当前分支上再拉一枝」）。
- 若只写 **`Working branch`: `feature/foo`且无「create … from …」**：表示**沿用 / 切到**该已存在分支上开发，不要求新建。
- 若写新建但未写 `<base>`：实现侧应**停下问** `@project-manager`（或按项目 `AGENTS.md` 的默认 base）；**禁止**擅自假设「一定是 `main`」。

#### 角色职责

- **`@project-manager`（唯一分支决策入口）**：向 `@product-manager`（向项目仓库提交产品文档时）、`@architect`（向项目仓库提交技术/架构/契约类文档时）、`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2`、以及会向仓库提交工件的 `@qa-engineer`、会改仓库内文件的 `@ops-engineer`、对**项目仓库**落盘的 `@prompt-engineer` 分派前，核对分支策略；在 Assignment 中写明 **`Working branch`**（沿用已有分支名，或 `create <new-branch> from <base>`，其中 `<base>` 遵守上一节）。若用户已指定分支/祖先，照抄进 Assignment。**只有 `@project-manager` 可以决定是否新开分支、从哪个 `<base>` 开分支。**
- **实现 / QA / 运维 / prompt / product-manager / architect（项目侧）**：在**首次**编辑仓库内文件或执行 `git commit` 前，核对当前分支与 Assignment，并在回报中明确“正在哪个分支上工作”。**禁止自行决定新开分支、禁止自行切回 `main`/`master` 重开分支。**若未授权 `Branch policy` 且当前在默认分支，则仅可按 PM 已写明的 `Working branch` 执行切换/开枝；若 Assignment 未写清或与现场分支不一致，先回报 `@project-manager`，不得擅自处理。

### 3) 实现

负责人：最匹配的开发角色（`@frontend-dev`、`@fullstack-dev`、`@fullstack-dev-2`）

必需产出：

- 代码变更
- 自检证据
- 已更新的计划清单（主 plan 与 `status.json`）

若项目使用 **`{PLAN_DIR}/knowledge/`**：实现前须阅读 `plans[].metadata` 中的 **`primary_spec` / `spec_refs`**（若存在），不得在未对齐知识库设计输入的情况下静默偏离；见 `plan-convention.md`。

### 4) 审查门禁

负责人：QC 审查员 + QA

必需产出：

- QC 结论与可执行的发现
- QA 验证证据
- `@project-manager` 的合并决定

**Plan 留档（启用 `{PLAN_DIR}` 时）**：架构评审与并行 QC 的**书面报告**默认写入 `{PLAN_DIR}/reports/<plan-id>/`（命名与只读约定见 `plan-convention.md`）；**open** residual 登记在 **`status.json`** 的 **`metadata.residual_findings`**，**已关闭**项归档至 **`{PLAN_DIR}/archived/residuals/<plan-id>.json`**，由 PM/QA 与 `review-harness.md` 对齐。

### 5) 经验沉淀

负责人：`@project-manager` + `@prompt-engineer`

必需产出：

- 反复出现的问题更新为可复用指引
- 非平凡失败在 plan notes 中记录根因

## 任务类别（Task category）与角色倾向

`@project-manager` 在 Assignment 中写明 **`Task category`**（**一个主类**，可选注明 `secondary`），用于「按任务性质选强项」的编排。

| Category | 典型工作 | 倾向角色 / 说明 |
|----------|----------|-----------------|
| `visual` | UI/UX/组件/样式/可访问性 | `@frontend-dev`；复杂信息架构可前置 `@product-manager` |
| `deep` | 陌生模块摸底、端到端 trace、大范围阅读 | `@explore` 优先，再交 `@fullstack-dev*` 或 `@architect` |
| `quick` | 单文件、文案、小配置、typo | `@general` 或单开发角色；**不**因体量小跳过既定 QA/QC 门槛（除非流程已允许的例外） |
| `logic` | 难算法、并发、一致性、架构取舍 | `@architect` + 开发角色；必要时加强审查 |
| `ops` | CI/CD、部署、监控、基础设施 | `@ops-engineer` |
| `docs` | 纯 Markdown 规格/PRD（无运行时行为变更） | `@product-manager` / `@architect` 按文档类型 |

**与模型配置**：`opencode.json` 中可为不同 subagent 配置不同 `model`，与「类别 → 强项模型」同向；PM 可在 `Why this agent` 中点名类别与选型理由。

## 内置 `@explore` 能力边界（强制）

OpenCode 的 **`@explore`** 是**只读**、偏快速的代码库导航 subagent，用于**缩短找文件/符号/粗粒度结构**的时间。

- **禁止代劳交付**：任何已分派到具体角色的 Assignment，承接方**不得**用 `@explore` 代替本角色应完成的**实现、改库、写测试、跑命令取证、写审查结论、写 PRD/架构文档、写 QA 报告**等。这些必须由**当前角色**用自身可用工具（`read` / `grep` / `glob` / `edit` / `write` / `bash` 等）完成。
- **允许的用法**：在**陌生或跨模块**时，**短、窄**地调用 `@explore` 做只读辅助（定位路径、粗调用关系、关键词检索）；得到线索后**立即**回到本角色继续——不得把「整票任务」或「主要实现步骤」拆给 `@explore` 连续执行。
- **优先默认**：同一目标能用内置 `glob`/`grep`/`read` 在合理步数内完成时，**不必**调用 `@explore`。
- **与 PM 分工**：由 `@project-manager` 在**分派前**调用 `@explore` 摸底，并把结论写进 Assignment，是推荐模式；**分派完成后**，承接方不应把作业再「转包」给 `@explore`。

## 长任务纪律（Todo / 持续推进）

- 非平凡任务须有可追踪清单（plan 的 `tasks` 或等价 Todo），**逐项关门**并保留核对痕迹。
- 承接方长时间无产出或偏离 `Acceptance Criteria` 时，`@project-manager` 应拉回对照 Phase Gate 与任务列表，而非假设「还在做」。
- 宣称完成、sign-off 或合并结论前，须满足可核对证据（与 `superpowers-skills.md` 中 `verification-before-completion` 一致）。

## 分层上下文（大型仓库，可选）

对体量很大的单体或多包仓库，可在**业务项目**内按目录维护层级 `AGENTS.md`（模块边界、约定、禁区），降低单次加载噪声、帮助执行方只读相关切片。由项目维护者按需引入；本全局 harness **不强制**自动生成此类文件。

理念说明见 `~/.config/opencode/docs/agents/open-harness-principles.md`。

## 可选前置门（大型 / 高歧义任务）

在默认生命周期之上，可按任务风险与不确定性**追加**下列门；由 `@project-manager` 在 Assignment 中写明启用原因与产出，避免小改动被套上全流程。

| 门 | 典型触发 | 负责角色 | 预期产出 |
|----|----------|----------|----------|
| 策略 / 价值对齐 | 目标含糊、多干系人取舍 | `@product-manager`（可并行 `@market-expert`） | 范围、非目标、验收与优先级 |
| 架构 / 数据流锁定 | ≥2 模块、或新 API/数据契约 | `@architect` | 边界、接口契约、风险与回滚点 |
| 体验 / 信息架构 | 新流程、主导航、关键表单 | `@frontend-dev` 或 `@product-manager` | 线框级共识或验收场景列表 |
| 视觉一致性 | 大改版、设计债明显 | `@frontend-dev` | 对照现有设计 tokens/组件库的偏差清单 |

## 与阶段化工作流的对照（概念层）

下列对照仅用于**命名与意图对齐**（不依赖任何外部 CLI）。实际执行仍以本目录状态机与 `@project-manager` 路由表为准。

| 常见“阶段”命名 | OpenCode 落地 |
|----------------|---------------|
| 脑暴 / 0→1 澄清 | `@product-manager` + `@market-expert`（可选） |
| 计划-战略 / CEO 视角 | `@product-manager` 收紧范围与成功标准 |
| 计划-工程 / 架构评审 | `@architect` |
| 计划-设计 / UX  critique | `@frontend-dev` 或 PM 主持的验收场景 |
| 根因调查 | `@explore` + 证据；必要时 `@architect`；再进入实现 |
| 实现 | `@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2` |
| 预合并审查 | QC 三审（或 Hotfix 单审）+ `review-harness.md` |
| 测试与取证 | `@qa-engineer`（含 Report-only 与可见 UI 证据约定） |
| 发版 / 落地 | `@ops-engineer`；大型功能后接健康检查与文档 |
| 生产高危 / 破坏性变更 | `@ops-engineer` + `review-harness.md` 高危清单；Assignment 标注 **high-risk** |
| 第二意见 / 对抗评审 | 已由 QC 三审覆盖；仍冲突则升级人工并按 `升级触发条件` 处理 |

## 并行规则

- 独立模块可并行；避免写操作归属重叠。
- 跨领域变更时，先锁定接口契约再并行编码。
- QC 审查员并行运行，完成后统一汇总。
- **QC 三审**在 **feature 开发完成之后**执行，审查对象仍是 **该 feature 在 `Working branch` 上的状态**；三名 reviewer 须在 **PM 指定的同一「待审检出」上下文**（通常为 **开发回报的实现用 worktree 路径**，见下文「QC 三审、QA 验证与 feature 检出上下文」）上读 diff、跑检查，**禁止**默认用错分支或未对齐的 cwd 代审。
- **@qa-engineer** 做 **验证、跑测试、取证或向业务仓提交测试工件**时，须在 **与待验 feature 一致的检出上下文**进行：使用 Assignment 中的 **`Review cwd` / `Worktree path`**（与 QC handoff 同源，通常为 **同一 feature worktree**）及 **`Working branch`**，**禁止**在未核对路径与分支时在错误目录上宣称通过或产出证据。细则见同下节。

### 同仓并发写入与 Git worktree（强制）

**首要场景是开发阶段**：多条可写流 **并发** 改 **同一仓库** 时，用 worktree 做 **写入侧目录隔离**。下列规则针对该类开发并发；**QC / QA 阶段的检出约定**见下一小节。

当 **`@project-manager` 在同一调度轮次内并发启动多个** subagent（含宿主侧「并行 Task / 并行 subagent」），且 **≥2 个承接方**可能对 **同一 Git 仓库的同一工作区（同一 cwd 检出目录）**产生写文件或 `git commit` 级改动时：

- **必须**为每条并发写流使用 **独立检出目录**：以 **`git worktree`** 隔离（流程与目录安全要求见 Superpowers **`using-git-worktrees`**；未安装插件时仍须达到同等隔离效果，可 Read 该技能文件并按 `git worktree` 手册执行）。
- **必须**与既有分支门禁一致：每个可写承接方的 Assignment 仍须含 PM 已批准的 **`Working branch`** / **`Branch policy`**；在某一 worktree 内 **不得**擅自 `checkout` 到未授权分支或私自新建分支（细则见 `branch-collaboration.md`）。
- **PM 须在 Assignment 中写清**各并发写流的 **检出约定**（例如预期 **`Worktree path`** / 命名规则，或「由承接方按 `using-git-worktrees` 创建并在 Completion Report 回报路径」），避免多代理默认共享同一目录导致互相覆盖、冲突或半写入状态。

**可不强制新开 worktree** 的情形包括：并发流 **全部为只读**；各写入者针对 **不同 Git 仓库根**；或写入 **串行**（同一时刻仅一个代理持有该仓工作区）。

### QC 三审、QA 验证与 feature 检出上下文（强制）

开发在 **feature 分支**上完成（往往在 **独立 worktree** 中实现）后，**QC 审查与 QA 验证针对的都是这份 feature**，而不是 `main` 或任意未对齐的默认 cwd。

- **`@project-manager`** 分派 **QC** 时须在 Assignment 写明与待审实现一致的 **`Working branch`**，并写明 **`Review cwd` / `Worktree path`**：**优先**沿用开发 **Completion Report** 中回报的业务仓 **实现检出路径**（即「该 feature 的 worktree」）；若开发未用 worktree，则写明单一明确的业务仓根路径。若审查需与开发目录 **物理分离** 但仍审 **同一分支**，可指示按 **`using-git-worktrees`** 在 **`Working branch`** 上 **另加** 一个 worktree 专供审查（只读使用业务仓）。
- **三审并行**时，三名 reviewer **共用同一组 `Review cwd` / `Worktree path` + `Working branch` 约定**即可（对业务仓只读分析）；**一般不必**为每位 reviewer 各开一个 worktree，除非宿主或执行环境要求进程级隔离。
- QC 的 **报告落盘**仍仅限 `{PLAN_DIR}/reports/`；上述约定保证 `git diff`、`git log`、lint 与所读文件与 **待合并 feature** 一致。
- **`@project-manager`** 分派 **`@qa-engineer`** 做 **本 feature 的验证**（跑测试、复现、可观察取证、或向业务仓提交测试/配置）时，须在 Assignment 中写明 **同一套** **`Review cwd` / `Worktree path`** 与 **`Working branch`**（可与 QC 分派复用同一字段；若 QC 已用某路径，QA 应 **沿用**，除非 PM 显式改为另一 **同分支** 检出并说明原因）。**@qa-engineer** 在执行业务仓命令前须核对当前目录与分支与 Assignment 一致；**Report-only**、且本轮 **不涉及** 业务仓内命令/路径依赖时，若 Assignment 未写 `Review cwd`，须在回报中说明验证所基于的检出或环境，缺失则 `Blocked` 并请 PM 补全。
- 若 **QA 与同仓其他可写角色并发**提交测试代码，仍须遵守上文「同仓并发写入」的 **worktree** 规则（可为 QA 单开一条写入 worktree，**同一 `Working branch`**，由 PM 在 Assignment 写明）。

### 调度防串扰（强制）

- 只有 `@project-manager` 可以决定增加/并行 subagent；承接方默认不得二次分派。
- Assignment 中的 **`Execute as: @role`**（若旧文案写 **`Owner Agent`** 则与之同义）表示 **当前承接方应以该角色身份亲自完成本单**，**不是**“再 Task 起一个 `@role`”。需要额外代理时，仅以 PM 写明的 **`Delegation: allowed (...)`** 为准。
- Assignment 未显式写 `Delegation: allowed (...)` 时，视为 `Delegation: forbidden`。
- Assignment 正文中的 `@xxx` 默认按“文本引用”解释，不视为自动调用命令。
- 承接方若判断必须增加 subagent 才能继续，应先回报 `Blocked` 并向 PM 申请重分派，禁止自行拉起。
- 并行拓扑与分支隔离只能由 PM 在 Assignment 明确声明；承接方不得自行扩展并行面。
- **`@explore` 不得代劳交付**：承接方不得用 `@explore` 执行本 Assignment 的主工作；仅允许短只读摸底，细则见上文「内置 `@explore` 能力边界」。

## 升级触发条件

以下情况升级到人工决策：

- 澄清尝试后验收标准仍然模糊
- 评审结论冲突且证据强度相当
- 重复实现失败表明缺少的是能力而非努力
- 根因无法在合理成本下收敛且继续修改代码风险高于等待人工决策

升级报告应包含：

- 当前状态
- 可选方案与权衡
- 推荐路径

## 应避免的反模式

- 角色文件中塞入本应在 docs 中的流程说明导致 prompt 膨胀。
- 在代码中做出隐藏的策略决策而不更新 plan。
- 没有测试或行为证据就声明完成。
- 不改变约束或工具就重复走同一条失败路径。
- **未重读文件即反复 Patch**（会话内代码块与磁盘脱节），或对 apply 失败用同一过时锚点连试。
- **意图未收敛即实现**：尚未明确真实目标/成功判据/非目标就分派 `implement`。
- **省略 `Task category`** 导致角色/模型选择与任务性质明显错配（除非极简 explore-only 且路由表已唯一确定）。
