---
packages: cli, engine
---

- **Every authorization network call has a deadline.** Discovery, registration,
  the code exchange and the refresh are all round trips inside an interactive
  login; a black-holed endpoint used to leave the operator watching a spinner with
  no end. Each one now fails after 30 seconds with the reason instead.
- **The copied watermark cannot move backwards.** `replanItem` already refuses to
  open a cycle for an older revision, but the revision an apply records is the
  caller's own argument: recording one older than the watermark would make a
  replayed page look fresh again on the next run.

<!-- CN -->
- **授权的每次网络调用都有超时。** 发现、注册、换码与刷新都是交互式登录中的往返；
  此前一个被黑洞掉的端点会让操作者无限等待。现在它们都会在 30 秒后带着原因失败。
- **已复制水位不会倒退。** `replanItem` 已拒绝为更旧的版本开启循环，但 apply 记录哪个版本由调用方决定：
  记录一个比水位更旧的版本，会让重放的旧页面在下次运行时重新显得新鲜。
