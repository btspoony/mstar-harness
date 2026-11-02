---
packages: engine, cli
---

- **The authorization listener closes on every path.** A failed client
  registration, or a browser that could not be opened, used to leave the callback
  server listening and the CLI alive indefinitely; the timeout was a bare timer
  that a successful login never cleared, so a completed login kept the process
  running until it fired. The listener is now closed on failure, and the timer is
  cleared and unref'd so waiting on a human is never the reason a process stays up.
- **A store at the previous schema can be restored.** Adding `pending_target`
  unconditionally made every restore preview fail on stores that never had the
  column. The inventory reads it only when the schema says it exists.
- **Only a successful apply advances the copied watermark.** A failed or stale
  skip used to promote the planned target into the copied revision, so a copy that
  never happened looked recorded — and the caller's own revision now wins over the
  planned one, because a resumed cycle can copy a newer revision than it planned
  and recording the older one lets a page between them overwrite it.

<!-- CN -->
- **授权监听器在任何路径上都会关闭。** 此前客户端注册失败、或浏览器无法打开时，回调服务器会一直监听、CLI 会一直存活；
  超时是一个裸定时器，成功登录也不会清除它，所以登录完成后进程会挂到它触发为止。现在失败路径会关闭监听器，
  定时器在结束时清除并 unref——等待人工操作永远不会成为进程不退出的原因。
- **停留在上一版 schema 的 store 可以恢复了。** 无条件加入 `pending_target` 会让从未有过该列的 store 的恢复预览全部失败。
  现在只有 schema 表明该列存在时才会读取它。
- **只有成功的 apply 才推进已复制水位。** 此前失败或过期跳过会把计划目标提升为已复制版本，使一次并未发生的复制看起来已完成；
  并且调用方给出的版本优先于计划版本——恢复的循环可能复制到比计划更新的版本，记录旧版本会让夹在两者之间的页面覆盖它。
