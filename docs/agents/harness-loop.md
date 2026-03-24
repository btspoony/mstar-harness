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

**默认规则**

- 不得在**默认保护分支**（常见名：`main`、`master`；以项目约定为准）上直接实现功能改动，除非 Assignment 含显式例外。
- 例外须在 Assignment 中写明一行：**`Branch policy: direct on <branch> — <reason>`**（典型：团队约定的热修直接打默认分支）。

**角色职责**

- **`@project-manager`**：向 `@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2`、以及会向仓库提交工件的 `@qa-engineer`、会改仓库内文件的 `@ops-engineer`、对**项目仓库**落盘的 `@prompt-engineer` 分派前，核对分支策略；在 Assignment 中写明 **`Working branch`**（沿用已有分支名，或「自 `<base>` 新建 `feature/...` / `fix/...`」）。若用户已指定分支，照抄进 Assignment。
- **实现 / QA / 运维 / prompt（项目侧）**：在**首次**编辑仓库内文件或执行 `git commit` 前，核对当前分支与 Assignment；若未授权 `Branch policy` 且当前在默认分支，则**先**切到 PM 指定的 `Working branch` 或新建 `feature/<topic>` / `fix/<topic>`，再改动。不确定时回报 `@project-manager`，不得静默在默认分支上堆提交。

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
