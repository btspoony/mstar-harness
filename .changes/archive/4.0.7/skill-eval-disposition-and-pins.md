---
category: Harness
packages: root
---

- Fixed the **bounded-resolution coverage gate**: `workflow.delivery-anchors` now carries an explicit `excluded` disposition, so every live command route is accounted for.
- Reconciled the **closure inventory**: the per-row `afterSha256` current-byte pins and their three assertions were deleted, not re-frozen — BASE `beforeSha256` provenance and the anchor guards remain the freeze evidence.

<!-- CN -->
- 修复 **bounded-resolution 覆盖门禁**：`workflow.delivery-anchors` 现带有显式 `excluded` 处置，所有 live 命令路由均有归属。
- 清理 **closure 清单**：逐行 `afterSha256` 当前字节 pin 及其三处断言已删除而非重新冻结；BASE `beforeSha256` 溯源与 anchor 守卫仍是冻结证据。
