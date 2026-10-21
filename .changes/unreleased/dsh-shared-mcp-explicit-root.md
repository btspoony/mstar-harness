---
category: Harness
packages: root, dsh
---

- **ONE shared MCP connection; the per-agent scoped mount is gone.** The dsh bundle's `mstar-mcp` row is the whole MCP channel for the host: the plugin registers no MCP client of its own, and a subagent shares the connection its parent already has. A per-agent instance could never carry per-call arguments (a dsh gate cannot rewrite tool arguments), so it bought no capability — only one Node process per agent.
- **The control root is DECLARED, never inferred.** It resolves in one ordered rule: the launch pin (`mstar mcp --harness <absolute path>`, else a non-blank `MSTAR_HARNESS_DIR`), then the admitted call's `harness` field; `harness.scaffold` keeps its null-root bootstrap exception, and every other rootless call is refused with `[mcp.control-root-unresolved]` naming the cause and all three recoveries. The launch cwd is the HOST's directory and is no longer a root candidate anywhere — adopting it would root writes on an unrelated project. A pin beats a per-call `harness`, and the invocation workspace now anchors on the root actually used, so cwd-derived paths land under the declared harness.
- **On an unpinned connection `harness` is REQUIRED** on every published tool whose root is not otherwise fixed, so a caller cannot omit the one fact the root resolution needs; a pinned connection keeps the field optional, since the pin is the default.
- **The MCP-only identity wiring is retired.** `--identity-env`, the declared-identity lock, selector stripping and the connection-wide default session id are all gone: the connection carries no identity, a per-call `sessionId` is exactly what the caller passed, and an operation that NEEDS a session identity runs on the dsh native command surface, where it comes from `exec.agent.id`.
- Updated `packages/dsh/README.md` (+ `.zh.md`, `bundle/README.md`) and `skills/mstar-host/references/dsh.md` to describe the shipped surface.

<!-- CN -->
- **整个宿主只共享一条 MCP 连接；按 agent 的 scoped mount 已移除。** dsh bundle 的 `mstar-mcp` 行就是宿主的全部 MCP 通道：插件不自行注册任何 MCP client，subagent 共用父级已有的那条连接。按 agent 的实例本来也拿不到按调用参数（dsh 闸门无法改写工具参数），因此换不来任何能力——只会每个 agent 多一个 Node 进程。
- **control 根是「声明」出来的，绝不推断。** 它按一条有序规则解析：启动钉（`mstar mcp --harness <绝对路径>`，否则非空的 `MSTAR_HARNESS_DIR`），再是被准入这次调用的 `harness` 字段；`harness.scaffold` 保留其空根 bootstrap 例外，其余无根调用一律以 `[mcp.control-root-unresolved]` 拒绝，并点名原因与全部三条恢复路径。启动 cwd 属于**宿主**，不再是任何候选根——采用它会把写入落到不相干的项目上。连接钉优先于按调用的 `harness`，且调用工作区现在锚定在实际使用的那个根上，因此由 cwd 派生的路径落在已声明的 harness 下。
- **未钉的连接上 `harness` 为必填**：凡是根不另有来源的已发布工具都如此，调用方无法漏掉解析所需的这唯一事实；已钉的连接保持该字段可选，因为钉本身就是默认值。
- **仅属 MCP 的身份接线已退役。** `--identity-env`、已声明身份锁、选择器剥离与连接级默认 session id 全部移除：连接不携带身份，线上的 `sessionId` 就是调用方自己传的那个，而**需要**会话身份的操作走 dsh 原生命令面，身份来自 `exec.agent.id`。
- 更新 `packages/dsh/README.md`（含 `.zh.md`、`bundle/README.md`）与 `skills/mstar-host/references/dsh.md`，使其描述实际发布的表面。
