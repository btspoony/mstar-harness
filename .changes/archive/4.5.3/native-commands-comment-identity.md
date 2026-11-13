---
packages: dsh
---

- **The `native-commands.ts` identity comment now states the shipped route.** The header claimed the shared MCP connection carries no identity; it carries a per-call `sessionId`, published because the bundle launches `mstar mcp --trust-caller-session-id`, and that value is a bearer identity the engine resolves to the caller's own coordinator binding. Without the flag the selector stays unpublished and a supplied one is refused. The native surface stays the host-proven route and the only one reaching plugin-local state; the registration list is unchanged.

<!-- CN -->
- **`native-commands.ts` 的身份注释改为描述出厂路径。** 文件头原称共享 MCP 连接不携带任何身份；实际它携带按调用传入的 `sessionId`——因为 bundle 以 `mstar mcp --trust-caller-session-id` 启动，该选择器因此被发布，其值是一条 bearer 身份，引擎据此解析调用者自己的 coordinator binding；没有该 flag 时选择器不发布，传入即被拒绝。原生面仍是宿主可证明的路径，也是唯一能触达插件本地状态的路径；工具注册列表未变。
