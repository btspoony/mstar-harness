---
category: Changed
packages: cli, commands
---

- **`session.run` launches under the caller's verified live coordinator binding and mints no identity.** The launch resolves the claimed session id from `--session-id` or the inherited identity channel and requires it to be the running lifecycle's live coordinator; any other state refuses `session.run-unbound` with the recovery that state actually accepts (ownerless → `plan bind`, foreign/live holder → audited `session recover`, paused → lifecycle resume, failed/stopped → `workflow reopen`, completed → a new lifecycle, unregistered → `workflow register`). No session row or lease is written, and the child carries the verified identity in `MSTAR_EXECUTION_IDENTITY`.
- An MCP connection publishes no caller identity by default, so a `session.run` call must advertise the id it claims: the launcher opts in with `--trust-caller-session-id` and the call supplies `sessionId`. The `mcp --seat` help and the leaf-seat refusal now name that verified binding instead of a minted identity.

<!-- CN -->
- **`session.run` 现在在调用方已验证的实时 coordinator 绑定下启动，不再 mint 身份。** 启动会从 `--session-id` 或继承的身份通道解析所声明的 session id，并要求它就是运行中生命周期的实时 coordinator；其它状态一律以 `session.run-unbound` 拒绝，并给出该状态真正可走的恢复路径（无 owner → `plan bind`，外部/仍存活的持有者 → 经审计的 `session recover`，paused → 生命周期 resume，failed/stopped → `workflow reopen`，completed → 新建生命周期，未注册 → `workflow register`）。此路径不写 session 行或 lease，子进程通过 `MSTAR_EXECUTION_IDENTITY` 携带已验证身份。
- MCP 连接默认不发布调用方身份，因此 `session.run` 调用必须自行声明它主张的 id：启动方需用 `--trust-caller-session-id` 显式开启，调用时提供 `sessionId`。`mcp --seat` 帮助文本与 leaf 席位拒绝文案现在都指向该已验证绑定，而不再是 minted 身份。
