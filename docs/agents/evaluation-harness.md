# Agent 设计迭代评估

本文档定义了如何迭代调优 `~/.config/opencode/agents/` 中的提示词和工作流。

## 为什么需要这个

没有评估的 prompt 修改容易过拟合到单次对话。
使用小型但可重复的评估体系，让改进提升可靠性，而非仅仅优化风格。

## 迭代循环

1. 定义变更假设。
2. 运行一组固定的代表性任务提示词。
3. 对比变更前后的行为。
4. 记录发现并更新提示词/文档。
5. 重复直到收益趋于平稳。

## 测试集设计

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

## 评分维度

每次运行按 1-5 分评分：

- 路由准确性：正确的 agent、正确的阶段、最少的交接摩擦
- 策略合规性：计划更新、状态流转、签收规则
- 证据质量：具体验证而非模糊声明
- 吞吐量：每轮产出进展，避免不必要的等待
- 鲁棒性：失败或歧义后的恢复质量
- 阶段适度性：任务体量与门禁深度匹配（小改动不套全量“计划评审”链，大改动不跳过 RCA/契约）
- Phase Gate 合规：非 hotfix 不得跳过 `clarify` 与 `tasks`

## Prompt 变更的最低接受标准

提示词/规则变更只有在满足以下条件时才可接受：

- 策略合规性不下降
- 不增加可避免的交接循环
- 至少 3/5 场景中证据质量持平或更好
- 关键场景中 `Phase Gate` 合规率不低于变更前（建议目标：100%）

## 回归记录

当变更导致回归时，记录：

- 提示词版本和变更部分
- 失败的场景
- 可能的根因
- 回滚或后续调整

将此日志保存在相关 plan 文件的 notes 或 failure log 中。

## 评估执行输出约定

当使用 `routing-evals.json` 跑回归时，建议统一输出以下结构，便于横向比较：

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

- 每个失败用例必须对应 `hard_fail_if` 中的具体条目，避免“主观失败”。
- 必须单独报告 `Phase Gate` 相关失败（`clarify/tasks/plan-drift/hotfix-post-rca`）。
- 报告应可回溯到本次评估使用的 `routing-evals.json` 版本。

## 实践指引

- 每次迭代只改变一个主要行为维度。
- 优先删除低价值指令，而非添加更多文本。
- 将评审中反复出现的评论转化为明确的模板或检查。
- 将持久性规则提升到 docs 中；保持角色文件简洁。
