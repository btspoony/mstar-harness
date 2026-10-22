---
packages: omp
---

- **The `mcp-identity` extension makes the HOST session id authoritative.** It revises every eligible `mcp__morning_star_mstar_*` call to carry the calling session's native `sessionId` and REPLACES a caller-supplied value instead of deferring to it. On the opted-in connection (`mcp.json` passes `--trust-caller-session-id`) that wire value becomes the execution identity, so the former "an explicit caller-supplied id is never overridden" rule let any caller execute as another live coordinator session. The extension header, the package README and `skills/mstar-host/references/omp.md` state the new rule.

<!-- CN -->
- **`mcp-identity` 扩展改为以 HOST 会话 id 为准。** 它把调用方会话的原生 `sessionId` 写入每个符合条件的确 `mcp__morning_star_mstar_*` 调用，并**替换**调用方自带的值，而不是让位给它。在所选择的连接上（`mcp.json` 传入 `--trust-caller-session-id`），该线上值会成为执行身份，因此旧的「显式调用方 id 永不被覆盖」规则会让任意调用方以另一个活跃 coordinator 会话的身份执行。扩展头注释、包 README 与 `skills/mstar-host/references/omp.md` 已改为描述新规则。
