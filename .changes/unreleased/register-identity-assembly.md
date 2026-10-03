---
category: Harness
packages: root, cli, commands
---

- **CLI session identity now resolves from `--session-id` first, then `MSTAR_HOST_SESSION_ID`, and otherwise remains unset**, with the selected source attributed in the invocation context. Active token-authorized operations accept env-sourced identity as attribution; only the legacy (pre-activation) coordinator bootstrap (`plan bind --coordinator`) is explicit-only and rejects the environment fallback.
- **Ambient environment identity no longer blocks legacy `mstar plan bind --resume`**; that route ignores ambient env and refuses declared identity (`--session-id` or host-supplied).
- **MCP command contracts now state that `sessionId` is supplied by the caller on each call, except legacy `plan bind --resume`, which refuses declared identity and ignores ambient environment identity**; route-aware contract rendering does not promise resolution from MCP connection context. The field remains optional in the schema.
- **Active registration refusals for `workflow register`, `workflow evidence`, and `iteration register` list the specific missing fields** and explain CLI/MCP recovery, where to obtain `expect` and `operation`, and the `session.run` child-identity limitation with its recovery path.

<!-- CN -->
- **CLI session identity 现在按 `--session-id` 优先、其次 `MSTAR_HOST_SESSION_ID`、否则未设置的顺序解析**，并在调用上下文中标注所选来源。active token 授权操作接受环境变量来源的身份作为归属信息；只有 legacy（预激活）协调者 bootstrap（`plan bind --coordinator`）仅接受显式身份并拒绝环境回退。
- **环境变量带入的 ambient identity 不再阻止 legacy `mstar plan bind --resume`**；该路由忽略 ambient 环境身份，并拒绝已声明的身份（`--session-id` 或宿主提供的身份）。
- **MCP 命令契约现在说明 `sessionId` 每次调用均由调用方提供，但 legacy `plan bind --resume` 除外：该路由拒绝已声明身份并忽略 ambient 环境身份**；按路由生成的契约不再承诺从 MCP 连接上下文解析该值。Schema 中该字段仍为可选。
- **`workflow register`、`workflow evidence` 和 `iteration register` 的 active 注册拒绝信息会逐项列出缺失字段**，并说明 CLI/MCP 恢复方式、`expect` 与 `operation` 的获取/填写方式，以及 `session.run` 子进程身份限制和相应恢复路径。
