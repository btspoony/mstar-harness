---
category: Harness
packages: dsh
---

- **The enabled `linear-mcp` row consumes the stored credential.** The row gains `inject: [mstarLinearAuth]` and
  its `headers` is the loader expression `!!js ctx.mstarLinearAuth.authorizationHeaders()`, so the bearer exists
  only in the row's evaluated config - never in the bundle, a profile patch, a settings payload or a log. The new
  `MstarLinearAuth` service (`src/linear-settings.ts`) reads the credential file on every call, silently refreshes
  a due credential from its persisted expiry (one in-flight attempt, coalesced, newer-file-wins, no retry spin)
  and re-mounts the enabled row through the public `Fiber.restart()` seam - no enabled-bit write and no
  `setPluginEnabled` bounce. A rejected refresh is reported as the observed `linear.reauth-required` fact; an
  unknown expiry is reported as unknown, never guessed. Every credential adoption - the first Settings
  authorization, a reauthorization, or a newer file another process wrote - goes through the same service path,
  so a host that booted without a credential arms its schedule on that first grant rather than never refreshing it.
- **The Linear Settings card re-reads host facts at each visit.** The one card store lives for the client plugin,
  so it no longer trusts a cached row enable bit: the card's render re-reads `linearStatus`, and stale facts
  render as unknown, so disabling the row takes the Authorize action away again. A status poll that gets no host
  answer is no longer folded into a terminal `denied`: the card keeps observing for a bounded number of polls,
  then ends the attempt as `unreachable` after re-reading the host facts. A grant that is valid but cannot write
  now offers reauthorization instead of leaving the push refusal pointing at an action the card does not show.

<!-- CN -->
- **启用后的 `linear-mcp` 行会使用已存储的凭据。** 该行增加 `inject: [mstarLinearAuth]`，`headers` 为加载器表达式
  `!!js ctx.mstarLinearAuth.authorizationHeaders()`，因此 bearer 只存在于该行求值后的 config 中 —— 不会进入 bundle、
  profile patch、settings 载荷或日志。新增的 `MstarLinearAuth` 服务（`src/linear-settings.ts`）每次调用都读取凭据文件，
  按持久化的到期时间静默刷新（同一时刻仅一次尝试、合并请求、新文件优先、不空转重试），并通过公开的 `Fiber.restart()`
  重挂启用的行 —— 不写启用位，也不用 `setPluginEnabled` 弹跳。刷新被拒时报告观测到的 `linear.reauth-required` 事实；
  到期时间未知时如实报告未知，绝不猜测。所有凭据采纳 —— 首次 Settings 授权、重新授权、或其他进程写入的更新文件 ——
  都走同一条服务路径，因此启动时没有凭据的宿主会在首次授权后安排刷新，而不是永远不刷新。
- **Linear Settings 卡片每次访问都重新读取宿主事实。** 该卡片 store 的生命周期是整个客户端插件，因此不再信任缓存的
  行启用位：卡片渲染时重新读取 `linearStatus`，过期事实按未知渲染，禁用该行后 Authorize 动作会重新隐藏。状态轮询若
  没有拿到宿主答复，不再直接折叠为终态 `denied`：卡片在有限次数内继续观察，然后重读宿主事实并以 `unreachable` 结束。
  凭据有效但无写权限时，现在会提供重新授权入口，而不是让 push 的拒绝指向卡片并不展示的动作。
