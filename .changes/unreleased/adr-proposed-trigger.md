---
category: Changed
packages: root
---

- Give `proposed/` an admission rule and a trigger: a decision not implemented this round that must outlive the current plan or iteration is written to `proposed/` before implementation, while a decision implemented in the same change goes straight to `implemented/`.
- `clarify` now judges ADR admission at its closing summary and marks qualifying decisions as `ADR-candidate`, without writing a file; plan lock lands a deferred candidate as a `proposed/` record, while an implemented one writes nothing until its `Done`-time `## Review Gate Summary` pointer.
- `mstar-iteration` Phase 1 writes an unstarted selected direction back as a proposal, and the change that implements one promotes it to `implemented/` with its `ADR:` pointer following the new path.

<!-- CN -->
- 为 `proposed/` 补上准入规则与触发点：本轮不实施、须跨本轮存活的决策在实施前写入 `proposed/`；同一变更内实施的决策直接进 `implemented/`。
- `clarify` 收口摘要判定 ADR 准入，把符合条件的已决事项标为 `ADR-candidate`，不落盘；锁 plan 时把跨轮次的候选落地为 `proposed/` 记录，本轮实施的候选此时不写，等 `Done` 前的 `## Review Gate Summary` 指针承载。
- `mstar-iteration` Phase 1 把已入选但未开工的方向写回提案，实施它的变更在同一变更内提升为 `implemented/`，`ADR:` 指针跟随新路径。
