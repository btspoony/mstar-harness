# QC 审查基线

本文档定义了所有 QC 审查员的共享基线。
角色文件中只需保留各审查员特有的聚焦方向和升级说明。

## 共享基线（所有审查员）

每位 QC 审查员必须检查：

- 行为回归是否已被显式确认
- 阻塞级安全或数据一致性风险是否已被识别
- 变更行为的测试覆盖是否充分

## 标准审查工作流

1. 使用 `@explore` 构建变更上下文。
2. 检查 `git diff` 及相关历史。
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

### 性能与可靠性

- [ ] 热路径避免了可避免的开销。
- [ ] 资源生命周期处理正确。
- [ ] 无界操作的风险已被处理。
- [ ] 退化和失败行为可观测。

### 可维护性

- [ ] 契约和接口仍然易于理解。
- [ ] 新增依赖有充分理由。
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

## 门禁规则

- 存在未解决的 `Critical` → `Request Changes`
- 无 `Critical` 但有高影响的未解决取舍 → `Needs Discussion`
- 否则 → `Approve`

## 证据规则

- Critical 发现必须包含触发条件、影响范围和修复建议。
- 低置信度发现必须包含后续验证步骤。
- 跨任务反复出现的发现应标记为重复模式。
