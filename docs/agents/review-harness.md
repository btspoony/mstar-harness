# QC 审查基线

本文档定义了所有 QC 审查员的共享基线。三份 QC 角色提示词（`agents/qc-specialist.md`、`agents/qc-specialist-2.md`、`agents/qc-specialist-3.md`）在流程、门禁与要点上应与本文一致且彼此对齐：**共用正文以 `agents/qc-specialist.md` 为准**；`-2` / `-3` 仅保留 frontmatter、开场白中的 Reviewer 编号、`## 并行审查时本 reviewer 的侧重` 一节，以及 Completion Report 模板里的 **Agent** 名。

## 共享基线（所有审查员）

每位 QC 审查员必须检查：

- 行为回归是否已被显式确认
- 阻塞级安全或数据一致性风险是否已被识别
- 变更行为的测试覆盖是否充分
- 若启用功能分支策略：变更分支与 Assignment 的 **`Working branch` / `Branch policy`** 是否一致

## 标准审查工作流

1. 使用 `@explore` 构建变更上下文。
2. 检查 `git diff` 及相关历史；若 Assignment 启用功能分支策略，核对当前分支与 **`Working branch` / `Branch policy`** 一致（无授权则不应在默认分支上堆功能改动）。
3. 运行对应语言的 lint 和静态分析。
4. 按本文档审查清单进行人工审查。
5. 产出带严重等级和证据的结构化发现。

## 共享审查清单

### 代码质量

- [ ] 命名清晰且一致。
- [ ] 职责没有过度混合。
- [ ] 错误处理显式且可执行。
- [ ] 注释说明意图，而非实现细节的琐碎描述。

### 安全与正确性

- [ ] 输入已验证，边界检查显式。
- [ ] 无明显的注入/路径遍历/权限问题。
- [ ] 敏感数据处理方式恰当。
- [ ] 不变量和状态转换逻辑连贯。
- [ ] LLM/Agent 边界：不可信输入未直接驱动特权操作；提示注入面已识别。

### 性能与可靠性

- [ ] 热路径避免了可避免的开销。
- [ ] 资源生命周期处理正确。
- [ ] 无界操作的风险已被处理。
- [ ] 退化和失败行为可观测。

### 可维护性

- [ ] 契约和接口仍然易于理解。
- [ ] 引入依赖有充分理由。
- [ ] 破坏性变更附带迁移指引。
- [ ] 优先复用而非重复逻辑。

## 标准输出模板

```markdown
# Code Review Report

## Reviewer Metadata
- Reviewer: @qc-specialist | @qc-specialist-2 | @qc-specialist-3
- Review Perspective: {role-specific primary focus}
- Report Timestamp: {ISO-8601}

## Scope
- Files reviewed: {count}
- Commit range: {hash..hash}
- Tools run: {list}

## Findings
### 🔴 Critical
- {issue} -> {fix}

### 🟡 Warning
- {issue} -> {fix}

### 🟢 Suggestion
- {improvement}

## Source Trace
- Finding ID: {F-001}
- Source Type: {git-diff | linter | static-analysis | doc-rule | manual-reasoning}
- Source Reference: {command/snippet/file}
- Confidence: High | Medium | Low

## Summary
| Severity | Count |
|----------|-------|
| 🔴 Critical | {n} |
| 🟡 Warning | {n} |
| 🟢 Suggestion | {n} |

**Verdict**: Approve | Request Changes | Needs Discussion
```

## 高危变更与破坏性操作（运维 / 数据 / 生产）

适用于：`@ops-engineer` 主导的迁移、生产配置变更、数据删除或批量变更、证书轮转、共享环境上的破坏性脚本等。`@project-manager` 应在 Assignment 中标注 **high-risk** 并写清允许的目录与环境。

**最小检查（未满足则应 `Needs Discussion` 或 `Request Changes`）**

- [ ] 影响范围与维护窗口（或对用户的影响）已写明。
- [ ] 回滚步骤可执行且已评审。
- [ ] 备份、快照或等价恢复手段已确认（如适用）。
- [ ] 变更与验证步骤可审计（命令、流水线或 runbook 引用，而非一次性黑箱）。
- [ ] 涉及应用代码时仍走默认开发门禁（QC/QA），不因“只是运维”而跳过。

## 门禁规则

- 存在未解决的 `Critical` → `Request Changes`
- 无 `Critical` 但有高影响的未解决取舍 → `Needs Discussion`
- 否则 → `Approve`

## Residual Findings 留档门禁

- 当阻断项（`Critical`）修复后仍有未关闭 `Warning`/`Suggestion`/技术债，不得仅在对话中口头说明，必须留档。
- **启用 plan 管理且存在 `plan-id` 时**：优先将 residual 清单写入 `{PLAN_DIR}/status.json` 的 **`metadata.residual_findings[<plan-id>]`**（字段与严重等级见 `plan-convention.md`），与 QC 报告目录 `{PLAN_DIR}/reports/<plan-id>/` 交叉引用。
- 备选：写入对应主 plan 文档（`Plan Path`）的固定小节；若无 `{PLAN_DIR}`，则写入项目认可的进度载体或 `notes`（结构化条目）。
- 每条 residual finding 至少包含：`id`、`title`、`severity`、`source`、`scope`、`decision`（defer/accept/risk-accepted）、`owner`、`target milestone/date`、`tracking link`。
- `Approve with residuals` 仅在无未关闭 `Critical` 时允许，且 PM 汇总结论中必须包含 residual 清单与跟踪位置。
- 未完成 residual 留档，不应进入最终 `Done` 收口。

## 证据规则

- Critical 发现必须包含触发条件、影响范围和修复建议。
- 低置信度发现必须包含后续验证步骤。
- 跨任务反复出现的发现应标记为重复模式。
