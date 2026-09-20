---
category: Harness
packages: root
---

- Added the **DB coordination authority**: `mutateExecutionPlan` (prepare, progress, residual add/close, handoff, accept, return, integration-start, integration-accept, complete, reconcile) and `mutateExecutionWorkflow` / `recoverExecutionCoordinator` each run inside one SQLite transaction and share their transition rules with the legacy file route, so a plan or workflow mutation advances its own revision and the shared store revision exactly once.
- While execution authority is **active**, the legacy file route is refused at every entry boundary (`execution.direct-write-refused` / `execution.consumer-not-ready`); a store that exists but cannot be read fails closed instead of serving leftover JSON, and no DB failure falls back to files.
- Coordinator recovery is an explicit attested bootstrap: it names the prior holder, adopts only the ownership that revocation orphaned, and never revives an old-epoch lease.

<!-- CN -->
- 新增 **DB 协调权威**：`mutateExecutionPlan`（prepare、progress、residual add/close、handoff、accept、return、integration-start、integration-accept、complete、reconcile）与 `mutateExecutionWorkflow` / `recoverExecutionCoordinator` 的每次操作都在同一个 SQLite 事务内完成，并与旧文件路线共享同一套转换规则，因此一次 plan 或 workflow 变更恰好推进其自身修订号与共享 store 修订号各一次。
- 执行权威处于 **active** 时，旧文件路线在每个入口边界被拒绝（`execution.direct-write-refused` / `execution.consumer-not-ready`）；存在但不可读的 store 直接失败关闭而不再回退到残留 JSON；任何 DB 失败都不会回退到文件。
- 协调者恢复是显式的存证引导：必须命名前任持有者，只接管由撤销该持有者而孤儿化的所有权，且绝不复活旧 epoch 的租约。
