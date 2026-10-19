---
category: Harness
packages: root, cli, engine
---

- **An identity-locked MCP connection refuses identity override.** A server launched with `--identity-env` (a scoped per-agent mount) publishes no session selector on its tools and strips a caller-supplied `sessionId` before admission, so every call runs under the connection identity the launcher declared — a caller can no longer pass a valid foreign session id and act inside that identity's authority. Generic unbound connections keep the documented per-call `sessionId` selector.
- **The `MSTAR_HARNESS_DIR` recovery works everywhere the refusal names it.** The engine's harness-root resolution honours a non-blank `MSTAR_HARNESS_DIR` before its linked-checkout refusal, so the recovery the MCP control-root refusal advertises also resolves on a linked checkout whose main worktree cannot be read.

<!-- CN -->
- **身份锁定的 MCP 连接拒绝身份覆盖。** 以 `--identity-env` 启动的服务器（scoped per-agent 挂载）不再在工具上发布 session selector，并在准入前剥离调用方提供的 `sessionId`，因此每次调用都以 launcher 声明的连接身份运行——调用方无法再传入一个有效的外来 session id 并在该身份的权限内操作。通用未绑定连接保留文档化的 per-call `sessionId` 选择器。
- **`MSTAR_HARNESS_DIR` 恢复路径在拒绝消息提及的每种场景下都可用。** 引擎的 harness 根解析在 linked-checkout 拒绝之前先读取非空白的 `MSTAR_HARNESS_DIR`，因此 MCP control-root 拒绝所宣告的恢复方式，在主 worktree 不可读的 linked checkout 上同样生效。
