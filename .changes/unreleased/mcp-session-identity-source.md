---
category: Harness
packages: root
---

- **MCP session identity:** the `MSTAR_HOST_SESSION_ID` environment fallback has been removed from the MCP resolve path. Identity-consuming commands such as `session.recover` take the main-conversation session id solely via their explicit per-call `sessionId` input (the CLI `--session-id` flag / MCP schema field — parity that already existed); the existing fail-safe refusal when the parameter is absent is unchanged. MCP-invoked identity tests now pin the identity-gate-specific refusals, the wrong-session ownership refusal, and real CLI parse/routing.

<!-- CN -->
- **MCP 会话身份：** MCP 解析路径已移除 `MSTAR_HOST_SESSION_ID` 环境变量回退。`session.recover` 等消费身份的命令仅通过其显式单次调用 `sessionId` 输入（既有的 CLI `--session-id` 标志 / MCP schema 字段对等）获取主对话会话 ID；缺少该参数时现有的安全拒绝行为保持不变。MCP 侧身份测试现已固化身份门专属拒绝、错误会话所有权拒绝与真实 CLI 解析路由。
