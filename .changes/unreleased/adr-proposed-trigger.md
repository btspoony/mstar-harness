---
category: Changed
packages: root
---

- Give `proposed/` an admission rule and a trigger: a decision not implemented this round that must outlive the current plan or iteration is written to `proposed/` before implementation, while a decision implemented in the same change goes straight to `implemented/`.
- `mstar-phase-gates` § plan now routes that choice before plan lock; `mstar-iteration` Phase 1 writes an unstarted selected direction back as a proposal, and the change that implements one promotes it to `implemented/` with its `ADR:` pointer following the new path.

<!-- CN -->
- 为 `proposed/` 补上准入规则与触发点：本轮不实施、须跨本轮存活的决策在实施前写入 `proposed/`；同一变更内实施的决策直接进 `implemented/`。
- `mstar-phase-gates` § plan 在锁 plan 前分流该选择；`mstar-iteration` Phase 1 把已入选但未开工的方向写回提案，实施它的变更在同一变更内提升为 `implemented/`，`ADR:` 指针跟随新路径。
