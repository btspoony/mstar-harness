---
packages: dsh, engine
---

- **Linear MCP row, shipped disabled.** The dsh profile bundle now inserts a `linear-mcp` client row pointed at
  Linear's hosted server (`transport: streamable-http`, `url: https://mcp.linear.app/mcp`) alongside the existing
  `mstar-mcp` row. It ships with `disabled: true`: Linear needs an OAuth grant or a team-scoped API key only the
  operator can supply, and an enabled row without credentials spends a startup probe on a 401 and logs a failed
  connection every boot. Enable it by overriding the row in the profile (or home) layer — `disabled: false`, plus
  a `headers` entry (`Authorization: Bearer <key>`) when a token is held; tools then appear as
  `mcp__linear__<tool>`. It is not part of the mstar channel: removing it changes nothing about the mstar surface.
- **Mirrored rows refuse an occurrence addressed by id.** `appendOccurrence` now refuses
  `issue.scope-refused` when the target issue carries a non-`local` provider, completing the invariant that
  `captureIssueOn` already enforced on the identity path. Previously a local recurrence could land on an imported
  row by id, and the changelog wording over-claimed the guarantee.

<!-- CN -->
- **Linear MCP 行，默认禁用。** dsh 的 profile bundle 在现有 `mstar-mcp` 行之外，再插入一个指向 Linear 托管服务的
  `linear-mcp` 客户端行（`transport: streamable-http`，`url: https://mcp.linear.app/mcp`）。它以 `disabled: true` 出厂：
  Linear 需要 OAuth 授权或团队级 API key，而只有操作者能提供；未带凭据就启用会让每次启动都用一次探测换回 401，并在日志里
  留下连接失败。启用在 profile（或 home）层覆盖该行即可——`disabled: false`，持有令牌时再加 `headers`
  （`Authorization: Bearer <key>`）；工具随后以 `mcp__linear__<tool>` 出现。它不属于 mstar 通道：删掉它不影响 mstar 面。
- **镜像行拒绝按 id 追加 occurrence。** 当目标 issue 的 provider 不是 `local` 时，`appendOccurrence` 现在以
  `issue.scope-refused` 拒绝，补齐 `captureIssueOn` 已在身份路径上实施的同一条不变量。此前本地复发可以按 id 落到导入行上，
  而 changelog 的措辞把保证说过头了。
