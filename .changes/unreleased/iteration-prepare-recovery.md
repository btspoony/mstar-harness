---
category: Harness
packages: root
---

- **Iteration registration now records `phase-1-prepare` and stores a harness-relative `compass_ref`**: the producer normalizes an absolute in-root spelling to the contract form and refuses pointers that escape the harness root (symlink-safe), so every newly registered workflow is amendable by construction.
- **Prepare commands recover legacy snapshots instead of dead-ending**: `workflow show-prepare` reports derivable state (`derived`) when the phase label is absent or the stored compass pointer is absolute-but-in-root, and the next `workflow amend-prepare` adopts both in its ordinary locked write — a present non-Prepare phase is still refused, never rewritten, and real execution facts (leases, non-`Todo` rows) keep refusing first.

<!-- CN -->
- **迭代登记现在写入 `phase-1-prepare` 并存储仓库相对的 `compass_ref`**：生产者把根内绝对路径规范化为契约形式，拒绝逃逸 harness 根的指针（含符号链接），新登记的 workflow 天然可修订。
- **Prepare 命令对遗留快照自愈而非死路**：`workflow show-prepare` 在阶段标签缺失或指南针指针为根内绝对路径时报告 `derived`，下一条普通 `workflow amend-prepare` 在既有锁内写中一并采纳——已存在的非 Prepare 阶段仍然拒绝且绝不改写，真实执行事实（lease、非 `Todo` 行）依旧先行拒绝。
