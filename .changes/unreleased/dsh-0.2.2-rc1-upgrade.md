---
packages: dsh
---

- Raised the `@deepseek-ai/dsh-*` corridor from `^0.2.1-rc.5` to `^0.2.2-rc.1` (63 `peerDependencies` entries plus five dev-only helper packages), and added `@deepseek-ai/dsh-tool-executor-native@0.2.2-rc.1` as a test-only dev dependency.
- Adapted the test harness to the rewritten tool-execution layer: every boot composition mounts the native tool executor, and the five affected specs execute tool calls through the `ToolBatchInput`/`ToolBatchResult` contract via one shared helper instead of the removed single-call API.
- Updated the client-bundle test loader shim for the new upstream bundle surface (`require.asset(...)` plus the chat bundle's `ctx.get("connection")` read at `apply` time), so the first-party transcript-row spec keeps rendering the real upstream chat bundle.
- Read the optional `agentPresets` registry through a local structural view, since `0.2.2-rc.1` no longer merges the agent-preset registry's `Context` augmentation into this package.

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` 走廊从 `^0.2.1-rc.5` 提升到 `^0.2.2-rc.1`（63 个 `peerDependencies` 条目加五个仅开发依赖的辅助包），并新增测试专用 devDependency `@deepseek-ai/dsh-tool-executor-native@0.2.2-rc.1`。
- 适配重写的工具执行层：每个测试启动组合现在挂载原生工具执行器，五个受影响 spec 通过 `ToolBatchInput`/`ToolBatchResult` 契约经同一个共享 helper 执行工具调用，取代已移除的单次调用 API。
- 更新客户端 bundle 测试加载 shim 以匹配上游新表面（`require.asset(...)`，以及 chat bundle 在 `apply` 时读取的 `ctx.get("connection")`），使 first-party transcript-row spec 继续渲染真实的上游 chat bundle。
- 通过本地结构视图读取可选的 `agentPresets` 注册表，因为 `0.2.2-rc.1` 不再把 agent-preset 注册表的 `Context` augmentation 合并进本包。
