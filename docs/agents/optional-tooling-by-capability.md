# 按能力可选的工具（MCP / Skills）

本文档按**能力维度**列出可选增强项，与 `open-harness-principles.md` 中的「文档检索、可观察验证、结构化探索」等理念对应。是否接入由用户决定；**修改全局 `opencode.json` 须用户明确同意**。

## 能力 → 可选接入

| 能力 | 用途 | 说明 |
|------|------|------|
| **现行文档** | 库/API 随版本变化，减少幻觉 | Context7 类 MCP，或宿主已配置的等价文档工具 |
| **Web 检索** | 时效信息、issue、迁移说明 | 本仓库若已配置搜索类 MCP，避免重复堆多个同类 |
| **代码模式检索** | 跨仓库参考实现 | 例如 `https://mcp.grep.app`；本配置若已有 `grep` MCP 则已覆盖 |
| **仓库图谱 / 影响分析** | 依赖与调用关系、PR 风险 | 例如 GitNexus（本仓库 `opencode.json` 已示例时即用） |
| **浏览器 / E2E 验证** | 用户可见流程、取证 | agent-browser、Playwright 等 skill；与 QA「可观察证据」一致 |
| **Git 工作流** | 原子提交、分支收口 | `git-commit`、`finishing-a-development-branch` 等 |
| **系统化排障** | RCA 再修复 | Superpowers `systematic-debugging`（见 `superpowers-skills.md`） |

## 不建议

- 多个功能重叠的「搜索 MCP」同时常开，浪费上下文与配额。
- 在未跑通本仓库 Phase Gate 的情况下，用更多工具掩盖流程缺口。
