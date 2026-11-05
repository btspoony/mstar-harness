---
category: Harness
packages: root,engine,commands
---

- **A running workflow's operation receipts are no longer count-capped.** `execution.receipt-retention-exhausted` is gone: a RUNNING workflow refused its next ordinary plan or workflow operation once it retained 256 receipts, and the only recovery it named was to close or adopt the workflow and start a new one — a route an unfinished lifecycle cannot take without discarding the work it still holds. Every retained receipt is a replay anchor, so the engine never evicts one to make room; retention is now bounded by the lifecycle itself (the terminal mutation still prunes the set to exactly its own receipt) and by the store-epoch purge. Exact replay, changed-intent conflicts, CAS, authorization and normal terminal behavior are unchanged.

<!-- CN -->
- **运行中工作流的操作回执不再有数量上限。** `execution.receipt-retention-exhausted` 已移除：此前 RUNNING 工作流在保留 256 条回执后，会拒绝其下一条普通计划或工作流级操作，且给出的唯一恢复路径是关闭或收养该工作流再新建——未完成的生命周期无法采用，因为那会丢弃它仍然持有的工作。每条保留回执都是重放锚点，引擎绝不会为腾空间丢弃任何一条；保留范围现由生命周期本身（终态变更的裁剪仍只保留它自己的回执）与 store epoch 清理界定。精确重放、变更意图冲突、CAS、授权与正常终态行为完全不变。
