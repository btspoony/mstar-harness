---
category: Harness
packages: root, cli, commands
---

- **CLI session identity now resolves from `--session-id` first, then `MSTAR_HOST_SESSION_ID`, and otherwise remains unset**, with the selected source attributed in the invocation context. Coordinator bootstrap (`plan bind --coordinator`) remains an explicit-only exception: it requires `--session-id` and rejects the environment fallback.
- **Ambient environment identity no longer blocks `mstar plan bind --resume`**; explicitly supplied `--session-id` (and host-supplied identity) remains refused on that resume route.
- **MCP command contracts now state that `sessionId` must be supplied by the caller on each call**; route-aware contract rendering no longer promises resolution from MCP connection context. The field remains optional in the schema.
- **Active registration refusals for `workflow register`, `workflow evidence`, and `iteration register` list the specific missing fields** and explain CLI/MCP recovery, where to obtain `expect` and `operation`, and the `session.run` child-identity limitation with its recovery path.

<!-- CN -->
- **CLI session identity 现在按 `--session-id` 优先、其次 `MSTAR_HOST_SESSION_ID`、否则未设置的顺序解析**，并在调用上下文中标注所选来源。协调者 bootstrap（`plan bind --coordinator`）仍是仅接受显式身份的例外：必须传 `--session-id`，并拒绝环境变量回退。
- **环境变量带入的 ambient identity 不再阻止 `mstar plan bind --resume`**；在该 resume 路由中，显式传入的 `--session-id`（以及宿主提供的身份）仍会被拒绝。
- **MCP 命令契约现在说明 `sessionId` 必须由调用方在每次调用中提供**；按路由生成的契约不再承诺从 MCP 连接上下文解析该值。Schema 中该字段仍为可选。
- **`workflow register`、`workflow evidence` 和 `iteration register` 的 active 注册拒绝信息会逐项列出缺失字段**，并说明 CLI/MCP 恢复方式、`expect` 与 `operation` 的获取/填写方式，以及 `session.run` 子进程身份限制和相应恢复路径。
