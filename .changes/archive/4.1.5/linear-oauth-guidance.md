---
packages: engine, commands, cli
---

- **`mstar linear auth` — the flow that turns Linear on.** Enabling the bundled
  `linear-mcp` row without a credential used to leave an operator with a 401 and no
  way forward. The command runs the real authorization: it discovers the
  authorization server from the endpoint's own 401 challenge and metadata
  (nothing is hard-coded), registers a client dynamically, authorizes with PKCE
  S256 through the browser, and exchanges the code. `status` reports the stored
  credential's path, scope and expiry as facts; `logout` removes it and says
  whether anything was there. A host that cannot open a browser refuses with
  `linear.auth-unsupported` and names one that can.
- **The credential is host state, stored outside any repository.** It lives at
  `$XDG_CONFIG_HOME/mstar/linear/credential.json` (`MSTAR_LINEAR_CREDENTIAL`
  overrides), directory `0700`, file `0600`, written atomically so a failed write
  leaves the previous credential usable. A corrupt file is reported as
  `unreadable` with the reason; nothing throws on the read path.
- **The import uses it.** `issue-sync import` now takes the stored credential
  first and falls back to `LINEAR_API_KEY` for a headless deployment, so a machine
  that authorized once no longer exports a token. A credential inside the refresh
  window is still used — it is valid until it expires — and a rejected refresh
  reports `linear.reauth-required` naming the command to re-run.

<!-- CN -->
- **`mstar linear auth`——把 Linear 打开的那条流程。** 此前启用自带 `linear-mcp` 行却没有凭据时，操作者只拿到一个
  401，没有任何可用出路。现在该命令执行真正的授权：从端点自身的 401 challenge 与元数据发现授权服务器（不硬编码任何端点）、
  动态注册客户端、经浏览器以 PKCE S256 授权并换取令牌。`status` 如实报告存储凭据的路径、scope 与过期时间；`logout` 删除并
  说明此前是否存在。无法打开浏览器的宿主以 `linear.auth-unsupported` 拒绝，并指出哪些宿主可以。
- **凭据属于宿主状态，存放在仓库之外。** 位于 `$XDG_CONFIG_HOME/mstar/linear/credential.json`
  （`MSTAR_LINEAR_CREDENTIAL` 可覆盖），目录 `0700`、文件 `0600`，原子写入——写失败时旧凭据仍可用。
  文件损坏会以 `unreadable` 报告原因，读取路径绝不抛错。
- **导入会使用它。** `issue-sync import` 现在优先使用存储的凭据，无头部署回退到 `LINEAR_API_KEY`，
  因此授权过一次的机器不再需要导出令牌。处于刷新窗口内的凭据仍会被使用（到期前一直有效）；刷新被拒时报
  `linear.reauth-required` 并指明应重跑的命令。
