---
category: Harness
packages: root,engine
---

- **Execution receipt retention**: terminal close and adoption now prune the closed workflow's `execution_operations` receipts inside the same transaction, and an epoch-bump purge statement pins the invariant that an in-place epoch advance never leaves replay-dead receipt rows behind. RUNNING workflows keep every receipt (replay and recovery evidence stay intact); per-workflow accumulation is documented as the deliberate tradeoff tracked by #466.
- **Restore preview declares pruned receipts**: `store execution restore-preview` help, the engine module contract, and `docs/commands.md` now state that receipt retention is an expected source of backup-only `execution` operation rows (restore preserves prior-epoch receipt rows; replay stays current-epoch scoped), so backup-vs-live differences after pruning are declared, not silent.
- **Notes-ledger expectations documented**: `workflow-note append`/`coverage` help and the engine ledger header now state the append-only growth model and the whole-file read costs (id-dedup scan, whole-file coverage hash) as contract behavior.

<!-- CN -->
- **执行回执保留**：terminal close 与 adoption 现在在同一事务内清理已关闭 workflow 的 `execution_operations` 回执；epoch-bump 清理语句固化"原地 epoch 推进不残留 replay 死行"的不变量。RUNNING workflow 保留全部回执（replay 与恢复证据不受影响）；单 workflow 累积按设计线性增长，由 #466 跟踪。
- **恢复预览声明回执差异**：`store execution restore-preview` 帮助、engine 模块契约与 `docs/commands.md` 现在声明回执保留是 backup-only `execution` operation 行的预期来源（restore 保留旧 epoch 回执行；replay 仅限当前 epoch），清理后的备份差异是显式声明的，不再无声。
- **notes 账本预期文档化**：`workflow-note append`/`coverage` 帮助与 engine 账本头部现在写明 append-only 增长模型与整文件读取成本（id 去重扫描、全文件 coverage 哈希）属契约行为。
