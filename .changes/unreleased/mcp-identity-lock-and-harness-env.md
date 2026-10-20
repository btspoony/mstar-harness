---
category: Harness
packages: root, cli, engine
---

- **An identity-locked MCP connection refuses identity override.** A server launched with `--identity-env` (a scoped per-agent mount) publishes no session selector on its tools and strips a caller-supplied `sessionId` before admission, so every call runs under the connection identity the launcher declared — a caller can no longer pass a valid foreign session id and act inside that identity's authority. Generic unbound connections keep the documented per-call `sessionId` selector. A locked connection always has a resolved identity: a declared channel whose variable is unset or blank resolves no session id, so that connection stays generic (the per-call selector remains its identity channel) and one launch-time line names the variable, the cause and both recoveries instead of locking a connection with no identity at all. The declared identity is resolved once when the connection is created, so the lock can neither outlive the identity it locks nor appear after the connection became generic.
- **The `MSTAR_HARNESS_DIR` recovery works everywhere the refusal names it.** The engine's harness-root resolution honours a non-blank `MSTAR_HARNESS_DIR` before its linked-checkout refusal, so the recovery the MCP control-root refusal advertises also resolves on a linked checkout whose main worktree cannot be read.

<!-- CN -->
- **身份锁定的 MCP 连接拒绝身份覆盖。** 以 `--identity-env` 启动的服务器（scoped per-agent 挂载）不再在工具上发布 session selector，并在准入前剥离调用方提供的 `sessionId`，因此每次调用都以 launcher 声明的连接身份运行——调用方无法再传入一个有效的外来 session id 并在该身份的权限内操作。通用未绑定连接保留文档化的 per-call `sessionId` 选择器。锁定的连接一定有已解析的身份：声明的通道若变量未设置或为空白，解析不出 session id，该连接保持通用（per-call 选择器仍是其身份通道），并在启动时输出一行指明变量名、成因与两种恢复方式，而不是锁定一个根本没有身份的连接。声明的身份在连接创建时解析一次，因此锁定既不会比它所锁的身份活得更久，也不会在连接已变为通用之后再出现。
- **`MSTAR_HARNESS_DIR` 恢复路径在拒绝消息提及的每种场景下都可用。** 引擎的 harness 根解析在 linked-checkout 拒绝之前先读取非空白的 `MSTAR_HARNESS_DIR`，因此 MCP control-root 拒绝所宣告的恢复方式，在主 worktree 不可读的 linked checkout 上同样生效。
