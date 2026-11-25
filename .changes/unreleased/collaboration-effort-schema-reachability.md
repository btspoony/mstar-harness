---
category: Fixed
packages: engine
---

- **A v4 collaboration lane reaches the effort schema.** The ladder's v4 step is guarded by its own ledger
  row instead of running unconditionally, so a lane that already holds the move ledger stops re-proving v3
  and re-running the v4 DDL before the v5 alter.
- **A fenced combined store upgrades past the effort migration.** The cutover fence moves
  `project_milestones` to the collaboration lane and drops the local copy, so migration 23 declares the
  table its body alters and is recorded without running that body when the store's own fence proves the
  move. The same absence without fence evidence is still damage and still refuses.

<!-- CN -->
- **v4 协作 lane 可升级到 effort schema。** ladder 的 v4 步骤改由自身 ledger 行守护，不再无条件执行；
  已持有 move ledger 的 lane 不会在 v5 之前重新证明 v3 并重跑 v4 DDL。
- **已 fence 的合并库可升级越过 effort 迁移。** cutover fence 把 `project_milestones` 迁入协作 lane
  并删除本地表，因此 migration 23 声明其 body 所需的表：库自身的 fence 证明搬移时只记录版本而不执行
  该 body。没有 fence 证据的同类缺失仍属损坏，照旧拒绝。
