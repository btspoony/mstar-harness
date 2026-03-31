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
- `plan`（实现设计）
  - 产出：技术方案、模块边界/接口契约、风险与回滚点、验证计划。
  - 准入条件：必须引用已完成的 `specify/clarify` 结论；禁止“无澄清输入”的孤立 plan。

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

适用于 cwd 为 **Git 托管的业务/应用仓库** 且本轮会产生**仓库内可合并 diff** 的任务（代码、业务向测试与 fixture、影响构建或运行时的配置等）。**不**用于约束仅由用户本人维护的 `~/.config/opencode/` 全局配置（该目录对 agent 只读）。

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
- 已更新的计划清单

### 4) 审查门禁

负责人：QC 审查员 + QA

必需产出：

- QC 结论与可执行的发现
- QA 验证证据
- `@project-manager` 的合并决定

### 5) 经验沉淀

负责人：`@project-manager` + `@prompt-engineer`

必需产出：

- 反复出现的问题更新为可复用指引
- 非平凡失败在 plan notes 中记录根因

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

### 调度防串扰（强制）

- 只有 `@project-manager` 可以决定增加/并行 subagent；承接方默认不得二次分派。
- Assignment 未显式写 `Delegation: allowed (...)` 时，视为 `Delegation: forbidden`。
- Assignment 正文中的 `@xxx` 默认按“文本引用”解释，不视为自动调用命令。
- 承接方若判断必须增加 subagent 才能继续，应先回报 `Blocked` 并向 PM 申请重分派，禁止自行拉起。
- 并行拓扑与分支隔离只能由 PM 在 Assignment 明确声明；承接方不得自行扩展并行面。

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
