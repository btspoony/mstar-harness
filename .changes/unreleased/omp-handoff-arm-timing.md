---
category: Harness
packages: root, omp
---

- Moved the **coordinator model-handoff arm to the direction lock**: a new iteration now arms `@slow` once the direction is locked and **before** the Phase 1 draft is written, instead of after workflow registration — so the arm always takes the unregistered reservation path, which is the expected state for a new iteration (no register row, no snapshot, no compass) and never a reason to defer the call. No arm/fire logic, refusal code, authority derivation or tool schema changed.
- Renamed the shared new-iteration anchor `iteration-entry` → **`direction-lock`** and moved its carrier to the §1.2 tail: the anchor now fires once the direction is locked and before the compass/plans draft is written, and the three Phase 1 entry routes bind it at that boundary — the interactive route in its own step between the lock and the draft, the autonomous and host-Plan routes through their pre-commit checklists.

<!-- CN -->
- 协调者模型交接的 arm 时点前移至**方向锁定**：新迭代现于方向锁定之后、Phase 1 初稿撰写之前武装 `@slow`，不再在 workflow 登记之后 —— 因此 arm 恒走未登记保留路径，这既是新迭代的预期状态（无 register 行、无快照、无 compass），也不再是推迟该调用的理由。arm/fire 逻辑、拒绝码、权威推导与工具 schema 均未改动。
- 共享新迭代 anchor 由 `iteration-entry` 更名为 **`direction-lock`**，carrier 移至 §1.2 尾部：anchor 现于方向锁定之后、compass/plans 初稿撰写之前触发，三条 Phase 1 入口路线在该边界绑定 —— 交互路线在锁定与初稿之间以独立步骤执行，autonomous 与宿主 Plan 路线经各自 pre-commit 清单携带同一要求。
