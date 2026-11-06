---
category: Harness
packages: root,engine,commands
---

- **A running workflow's operation receipts are no longer count-capped.** `execution.receipt-retention-exhausted` and the exported `RUNNING_WORKFLOW_OPERATION_RECEIPT_LIMIT` constant are gone, with no compatibility shim: a RUNNING workflow refused its next ordinary plan or workflow operation once it retained 256 receipts, and the only recovery it named was to close or adopt the workflow and start a new one — a route an unfinished lifecycle cannot take without discarding the work it still holds. Every retained receipt is a replay anchor, so the engine never evicts one to make room. Retention is now logical rather than numeric: the store keeps one persistent receipt and its recorded result per committed operation of the active lifecycle, and that set grows with the number of operations and their payloads until logical cleanup runs — the terminal mutation, which prunes the set to exactly its own receipt, or the store-epoch purge, which removes superseded-epoch rows. Both cleanups are SQL `DELETE`s that bound what the store serves; neither promises constant space or a smaller SQLite file on disk. Exact replay, changed-intent conflicts, CAS, authorization and normal terminal behavior are unchanged.

<!-- CN -->
- **运行中工作流的操作回执不再有数量上限。** `execution.receipt-retention-exhausted` 与导出的 `RUNNING_WORKFLOW_OPERATION_RECEIPT_LIMIT` 常量均已移除，且不提供兼容层：此前 RUNNING 工作流在保留 256 条回执后，会拒绝其下一条普通计划或工作流级操作，且给出的唯一恢复路径是关闭或收养该工作流再新建——未完成的生命周期无法采用，因为那会丢弃它仍然持有的工作。每条保留回执都是重放锚点，引擎绝不会为腾空间丢弃任何一条。保留范围现在是逻辑上的而非数量上的：store 为活动生命周期中每个已提交操作保留一条持久回执及其记录结果，该集合随操作数量与载荷大小增长，直到逻辑清理发生——终态变更会把集合裁剪为恰好它自己的回执，store epoch 清理则删除被取代 epoch 的行。两者都是 SQL `DELETE`，只界定 store 对外提供的内容，并不承诺常数空间或 SQLite 文件在磁盘上变小。精确重放、变更意图冲突、CAS、授权与正常终态行为完全不变。
