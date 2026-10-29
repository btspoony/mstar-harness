---
category: Harness
packages: engine
---

- **Ledger resolve→append attribution drift closed (#550):** `appendDshWorkflowEvent` now re-reads the addressed session's coordinator seat inside its own write transaction: appending is authorized only while the source session still holds the ACTIVE coordinator seat of the addressed workflow at the selected epoch. `selectedGeneration` (storeId + epoch) alone could not see an epoch-preserving seat move — `recoverExecutionCoordinator` and a terminal adoption revoke the prior holder without advancing the epoch — so a resolved target could misattribute one in-window event. The refusal names the drift and its recovery (the ledger resolver re-runs on the next event); the refused row stays eligible. Regression drives the mutation through the supported recovery producer and observes the named refusal, never a silent misattribution.

<!-- CN -->
- **台账 resolve→append 归属漂移已关闭（#550）：** `appendDshWorkflowEvent` 现在在自己的写事务内重读目标会话的协调者席位：仅当源会话在所选 epoch 仍持有目标工作流的 ACTIVE 协调者席位时才允许追加。仅凭 `selectedGeneration`（storeId + epoch）无法察觉 epoch 不变的席位变更——`recoverExecutionCoordinator` 与终态采纳都会在不推进 epoch 的情况下撤销原持有者——因此解析出的目标可能把窗口内的一条事件错误归属。拒绝信息写明漂移与恢复路径（台账解析器会在下一条事件重新解析）；被拒行保持可重试。回归测试通过受支持的生产者触发变更，观察到具名拒绝而非静默错误归属。
