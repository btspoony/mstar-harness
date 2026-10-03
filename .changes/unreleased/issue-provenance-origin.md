---
category: Changed
packages: engine
---

- **Plan provenance is origin-scoped:** only plan-scoped writers can create scoped membership; actor-only links remain unscoped, and historical provenance remains plan-scoped.
- Origin-dependent issue reads refuse outdated stores with the supported `mstar store safe-upgrade` recovery.
- Removed the obsolete `triageIssueExecution`, `closeIssueExecution`, and `linkIssueExecution` exports from the engine API.
- The public `IssueProvenance` type exposes `origin` as `"scoped" | "unscoped"` for typed consumers.

<!-- CN -->
- **Plan provenance 按来源隔离：**只有 plan-scoped 写入能建立 scoped 成员关系；actor-only 链接保持 unscoped，历史 provenance 保持 plan-scoped。
- 依赖 origin 的 issue 读取会拒绝旧 schema，并提示使用公开的 `mstar store safe-upgrade` 恢复入口。
- 移除过时的 `triageIssueExecution`、`closeIssueExecution`、`linkIssueExecution` engine 导出。
- 公开的 `IssueProvenance` 类型通过 `"scoped" | "unscoped"` 声明 `origin`，供类型化调用方使用。
