---
category: Changed
packages: engine, commands, cli
---

- Exported the lifecycle-branch fact type from the engine package entry point for the commands consumer.
- Removed the retired file-route Prepare recovery suite and `lease.verify-integration` setup-verb test cases; surviving L1 lease coverage remains in `worktree check`.
- ACTIVE iteration registration now canonicalizes compass references to harness-relative paths and refuses paths that escape the harness, including through symlinks.

<!-- CN -->
- 从 engine 包入口导出了 lifecycle branch fact 类型，供 commands consumer 使用。
- 删除了已退役的 file-route Prepare recovery suite 和 `lease.verify-integration` setup verb 测试；保留的 L1 lease 覆盖由 `worktree check` 提供。
- ACTIVE iteration registration 现在会将 compass reference 规范化为相对于 harness 的路径，并拒绝越出 harness 的路径（包括经由符号链接越界）。
