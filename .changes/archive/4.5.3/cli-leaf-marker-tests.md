---
category: Fixed
packages: cli
---

- **Leaf-seat test isolation**: the shared CLI test harness now owns one identity-channel list
  (`DSH_MSTAR_LEAF_SEAT`, `MSTAR_LEAF_SEAT`, `DSH_SESSION_ID`, `MSTAR_HOST_SESSION_ID`,
  `MSTAR_EXECUTION_IDENTITY`) with clear/restore helpers, and the registration and MCP-identity suites
  clear those channels before each negative control. A shell that exports a leaf marker no longer turns
  those cases red; the marker is the case's own decision again.

<!-- CN -->
- **Leaf-seat 测试隔离**：CLI 测试共享 harness 现统一持有身份通道列表（`DSH_MSTAR_LEAF_SEAT`、
  `MSTAR_LEAF_SEAT`、`DSH_SESSION_ID`、`MSTAR_HOST_SESSION_ID`、`MSTAR_EXECUTION_IDENTITY`）并提供
  clear/restore 助手；注册与 MCP-identity 套件在每个负向对照用例前清理这些通道。导出了 leaf 标记的
  shell 不再让这些用例变红，标记重新由用例自己决定。
