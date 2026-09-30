---
category: Harness
packages: root
---

- **MCP session identity:** Identity-consuming commands such as `session.recover` now accept the main-conversation session id as an explicit per-call `sessionId` tool argument, matching the CLI `--session-id` flag. The `MSTAR_HOST_SESSION_ID` environment read has been removed from the MCP resolve path; the existing fail-safe refusal when the parameter is absent is unchanged.

<!-- CN -->
- **MCP 会话身份：** `session.recover` 等消费身份的命令现在接受作为显式单次调用 `sessionId` 工具参数传入的主对话会话 ID，与 CLI `--session-id` 标志保持一致。MCP 解析路径已移除对 `MSTAR_HOST_SESSION_ID` 环境变量的读取；缺少该参数时现有的安全拒绝行为保持不变。
