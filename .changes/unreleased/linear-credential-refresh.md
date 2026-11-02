---
packages: engine, commands, cli
---

- **An expired Linear credential is refreshed instead of sent.** `issue-sync import`
  used to hand the stored access token over whether or not it had expired, so a
  routine expiry surfaced as an access-denied that named nothing — while the
  refresh token beside it was still usable. The import now refreshes first and
  stores the replacement, and a host that cannot refresh refuses with
  `linear.reauth-required` naming `mstar linear auth`. A credential that is merely
  inside the refresh window is still used, because it works until it expires.
- **The credential records the client it belongs to.** A refresh exchange must
  present the registered client id and cannot derive it from the token, so
  discarding it after login had already made every stored refresh token unusable.
  It is written with the credential and carried by the token set.
- **`linear.auth` declares the effects it performs**: it reads configuration,
  writes host state and opens a browser. It also stays off the MCP surface — the
  flow needs a human in a browser, so a tool call would block on an authorization
  nobody is watching.

<!-- CN -->
- **过期的 Linear 凭据会被刷新，而不是直接送出。** 此前 `issue-sync import` 不管访问令牌是否过期都直接使用，
  于是一次普通的过期表现为一个说不清原因的被拒——旁边的 refresh token 其实还能用。现在导入路径会先刷新并写回新令牌；
  无法刷新的宿主以 `linear.reauth-required` 拒绝并指明 `mstar linear auth`。仅处于刷新窗口内的凭据仍会直接使用，
  因为在到期前它确实有效。
- **凭据会记录它所属的客户端。** 刷新交换必须出示注册的 client id，而它无法从令牌本身推导——登录后丢弃它已经
  让所有已存储的 refresh token 变成不可用。现在它与凭据一同写入，并由令牌集携带。
- **`linear.auth` 声明它实际执行的效果**：读取配置、写入宿主状态、打开浏览器。它同时不进入 MCP 表面——
  该流程需要人在浏览器里完成，工具调用只会卡在一个没人看着的授权上。
