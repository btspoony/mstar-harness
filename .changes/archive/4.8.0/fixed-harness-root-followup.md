---
category: Harness
packages: root, engine, commands
---

- **Linked-worktree scaffold:** `harness scaffold` now targets the Git main worktree, so a linked checkout no longer creates a `.mstar` the resolver never reads.
- **Per-call roots for state families:** `persist.write/get/list/delete` and `dashboard` publish a validated `harness` selector, so a shared MCP server can reach their stores instead of refusing every call with no usable recovery.
- Decision follow-up to `docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md`.

<!-- CN -->
- **linked worktree scaffold**：`harness scaffold` 现在写入 Git 主 worktree，linked checkout 不再创建解析器永远不会读取的本地 `.mstar`。
- **状态类命令的按调用根**：`persist.write/get/list/delete` 与 `dashboard` 发布经校验的 `harness` 选择器，共享 MCP 服务不再对每次调用都以无可执行恢复拒绝。
- 这是 `docs/adr/proposed/architecture/2026-11-20-fixed-harness-root.md` 的后续修复。
