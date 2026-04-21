---
name: mstar-routing-eval
description: Morning Star (启明星) 路由与 prompt 迭代评估体系 —— (1) PM 路由回归：用 routing-evals.json 验证 `@project-manager` 是否把任务分派给正确的 agent、是否经过正确门禁、是否满足 `must_have_artifacts`、是否触发 `hard_fail_if`；(2) Prompt/规则迭代评估：在不过拟合单次对话的前提下迭代调优 `~/.config/opencode/agents/*.md` 与 `mstar-*` skills，含测试集设计、评分维度、Prompt 变更最低接受标准、回归记录；(3) Routing Eval Report 输出模板（含 phase_gate_compliance_rate）。`@project-manager` 回归本轮路由合规时必读；`@prompt-engineer` 设计/修改提示词、规则或 skill 前必读；任何评估、打分或回归场景引用 routing-evals.json 时必读。场景集数据见本 skill 的 assets/routing-evals.json。
---

# Morning Star Routing & Evaluation Harness

本 skill 合并并取代旧文档 `docs/agents/routing-harness.md`（路由回归）与 `docs/agents/evaluation-harness.md`（迭代评估）。

## 1. PM 路由评估

本节用于验证 `@project-manager` 是否将任务路由到正确的 agent 和门禁。

### 输入

- **场景集**：本 skill 的 **`assets/routing-evals.json`**（首选）；历史路径 `~/.config/opencode/docs/agents/routing-evals.json` 已迁出。
- **路由策略来源**：`~/.config/opencode/agents/project-manager.md`
- **全局约束**：`~/.config/opencode/AGENTS.md` 与 `mstar-harness-core`

### 评估方法

对每个场景：

1. 将实际路由与 `expected_route` 进行比对。
2. 检查所需产出是否已规划并最终产出。
3. 验证没有 `hard_fail_if` 条件被违反。
4. 验证 `Context Loaded` 已声明且包含必要文件。
5. 验证 Assignment 的语言契约：字段名英文、任务正文可中文、执行产出/报告英文（除非用户明确要求其他语言）。
6. 记录路由质量和缺失的证据。

### 评估执行步骤（1-2-3）

1. **准备输入**：加载当前 `assets/routing-evals.json`、`project-manager.md`、`mstar-harness-core`（含 references）。
2. **逐案判定**：按 `expected_route` / `must_have_artifacts` / `hard_fail_if` 打分并记录证据。
3. **输出报告**：按下文 **`Routing Eval Report`** 模板汇总（含 `phase_gate_compliance_rate`）。

### 评分

- `Pass`：路由和产出满足预期，无硬性失败。
- `Borderline`：存在轻微偏差但质量门禁得到保留。
- `Fail`：触发硬性失败条件或跳过关键门禁。

### Phase Gate 评分细则

用于量化 `specify -> clarify -> plan -> tasks -> implement` 合规度。

- `Pass`
  - 非 hotfix：Prepare 与 Execute 门禁均完整通过；无跳步实现。
  - hotfix：允许压缩路径，但已明确事后 `clarify/RCA` 补记安排。
- `Borderline`
  - 门禁顺序总体正确，但存在可修复的轻微缺项（例如 `Phase Gate Checklist` 字段漏写但证据可追溯）。
  - 未出现"先实现后补 gate"的行为。
- `Fail`
  - 非 hotfix 跳过 `clarify` 或 `tasks`。
  - 已知 plan drift 仍继续实现，且无 plan 回写。
  - hotfix 未承诺或未记录事后 `clarify/RCA`。

### 建议量化指标

- `phase_gate_compliance_rate = pass_cases / total_cases`
- 建议门槛：
  - 日常迭代：`>= 0.9`
  - 关键发布前：`= 1.0`

## 2. 回归信号

如果以下情况在两个或以上场景中出现，则说明路由逻辑退化：

- 实现类任务省略了 QA 门禁
- QC 路径相对任务类型被过度或不足使用
- 跨模块工作缺少 architect/探索阶段
- 未按 `specify -> clarify -> plan` 完成准备阶段即进入实现
- `plan` 完成后未进行 `tasks` 拆解就直接实现
- 非热修复任务使用了热修复路径
- 对业务 Git 仓库的实现类分派缺少 **`Working branch`** 或明确的 **`Branch policy`**（见 `mstar-harness-core` `references/branch-and-worktree.md`）
- `Context Loaded` 缺失或缺少必要的 plan 路径
- 非热修缺陷在未记录根因或可证伪假设前大规模改代码
- 生产/高危运维变更缺少回滚说明或高危清单
- 声明 Report-only 的 QA 任务却改动业务逻辑，或无谓触发全量三审
- Assignment 语言契约不一致（字段名漂移为中文、或要求英文报告却回报为中文且无用户豁免）
- 实现类 Assignment **缺少 `Task category`** 或与 **`Execute as`**、`Why this agent` 明显矛盾（或缺少 **`Execute as`**）
- **意图门禁**缺失：Prepare 未书面收敛真实目标/成功判据/非目标即进入开发分派
- **Dev 三角失衡**：在「新 API + 多文件/用户可见 UI」或**可并行的双模块**场景下，长期**仅**派 `@fullstack-dev`、从不派 `@frontend-dev` / `@fullstack-dev-2`，且 Assignment 未写明 `Dev routing: single-stream — …`
- **误把「单轨串行」当「全程仅 fullstack-dev」**：计划写不并行 / 逐波串行，但 PM Task Board 上多行可对等 dev 单元却**无理由**全部 `fullstack-dev`、未按 `project-manager.md` Dev 三角 §6 round-robin，也未写 `Dev owner tie-break: single id — …`
- **并行技能标签缺失**：已下发 **≥2 条并行实现 Assignment**（或 `Dev routing: parallel` / tasks 并行标记）且走 Superpowers 工作流时，**Status Update 或 Assignment 的 `Superpowers` 未**出现 **`dispatching-parallel-agents`**（或同义短语）；或 **同仓 ≥2 可写并发** 却未叠 **`using-git-worktrees`** 与检出约定

## 3. 迭代规则

如果任一场景失败：

- 向用户提议对 `~/.config/opencode/agents/project-manager.md` 或 `mstar-*` skills 的修改（全局配置写入仅由用户本人执行，agent 不得直接落盘）
- 重新运行完整场景集
- 在 plan notes 中记录变更内容及原因

## 4. Prompt/规则迭代评估（独立于单次对话）

### 为什么需要这个

没有评估的 prompt 修改容易过拟合到单次对话。使用小型但可重复的评估体系，让改进提升可靠性，而非仅仅优化风格。

### 迭代循环

1. 定义变更假设（若涉及「库文档怎么查」或宿主差异，先对照 `mstar-host-opencode` 或 `.cursor/skills/mstar-host/`，避免与 Cursor/OpenCode 双轨说明重复或漂移）。
2. 运行一组固定的代表性任务提示词。
3. 对比变更前后的行为。
4. 记录发现并更新提示词/skill 文档。
5. 重复直到收益趋于平稳。

### 测试集设计

维护一组紧凑的提示词，覆盖：

- 小型功能交付
- 中等规模跨模块变更
- 缺陷调查与修复
- 审查密集型路径（含评审意见冲突）
- 提示词/规则重构任务
- 间歇性/高歧义缺陷（RCA 先于大改）
- 用户可见前端回归（需可观察 QA 证据）
- 生产或高危运维变更（回滚与清单）
- QA Report-only（无业务代码改动）

每个测试应指定：

- 预期路由（应使用哪些 agent）
- 预期产出（计划、审查摘要、验证证据）
- 硬性失败条件（缺少 QA、跳过审查等）
- 阶段门禁轨迹（`specify -> clarify -> plan -> tasks -> implement`）

### 评分维度

每次运行按 1-5 分评分：

- 路由准确性：正确的 agent、正确的阶段、最少的交接摩擦
- 策略合规性：计划更新、状态流转、签收规则
- 证据质量：具体验证而非模糊声明
- 吞吐量：每轮产出进展，避免不必要的等待
- 鲁棒性：失败或歧义后的恢复质量
- 阶段适度性：任务体量与门禁深度匹配（小改动不套全量"计划评审"链，大改动不跳过 RCA/契约）
- Phase Gate 合规：非 hotfix 不得跳过 `clarify` 与 `tasks`
- 行为准则合规：是否符合 `mstar-coding-behavior`（显式假设、最小解法、手术式改动、`Step -> verify`）

### Prompt 变更的最低接受标准

提示词/规则变更只有在满足以下条件时才可接受：

- 策略合规性不下降
- 不增加可避免的交接循环
- 至少 3/5 场景中证据质量持平或更好
- 关键场景中 `Phase Gate` 合规率不低于变更前（建议目标：100%）
- 行为准则合规不下降（尤其是"无关改动率"与"不可追溯改动"）

### 回归记录

当变更导致回归时，记录：

- 提示词版本和变更部分
- 失败的场景
- 可能的根因
- 回滚或后续调整

将此日志保存在相关 plan 文件的 notes 或 failure log 中。

## 5. Routing Eval Report（输出模板）

当使用 `assets/routing-evals.json` 跑回归时，建议统一输出以下结构，便于横向比较：

```markdown
# Routing Eval Report

## Run Metadata
- date: YYYY-MM-DD
- ruleset version: {version}
- evaluator: {agent/person}

## Overall
- total_cases: {n}
- pass_cases: {n}
- borderline_cases: {n}
- fail_cases: {n}
- phase_gate_compliance_rate: {pass_cases / total_cases}

## Failed Cases
- {case-id}: {reason}
- {case-id}: {reason}

## Borderline Cases
- {case-id}: {what is missing and why still borderline}

## Regression Signals
- {signal}: {count}

## Recommended Actions
- {doc or prompt change proposal}
```

最小要求：

- 每个失败用例必须对应 `hard_fail_if` 中的具体条目，避免"主观失败"。
- 必须单独报告 `Phase Gate` 相关失败（`clarify/tasks/plan-drift/hotfix-post-rca`）。
- 报告应可回溯到本次评估使用的 `routing-evals.json` 版本。

## 6. 实践指引

- 每次迭代只改变一个主要行为维度。
- 优先删除低价值指令，而非添加更多文本。
- 将评审中反复出现的评论转化为明确的模板或检查。
- 将持久性规则提升到对应 `mstar-*` skill 中；保持角色文件简洁。
- 对"最小解法/手术式改动"建议做抽样 diff 审计，避免 prompt 变更后再次膨胀。

## Assets

- `assets/routing-evals.json` — PM 路由回归场景集（结构：`cases[].prompt / expected_route / must_have_artifacts / hard_fail_if`）。评估时用 `cat` 或 `jq` 读取；**更新场景集须与本 skill 同 PR 维护**以避免版本漂移。
