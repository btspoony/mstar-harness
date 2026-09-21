---
category: Harness
packages: root
---

- Added the **execution migration protocol**: a read-only preview plus a staged apply (`previewExecutionMigration` / `applyExecutionMigration`) that stages legacy root/snapshot/session evidence without activating, keeps every source byte and issue/catalog row, and leaves the file route as the sole live authority.
- Added the separate crash-safe steps (`activateExecutionMigration` / `retireExecutionSources` / `abortExecutionMigration`): activation is all-or-nothing behind a deferred-surface barrier and advances the global epoch once; retirement moves only the exact root/snapshot files into manifest-addressed history with per-item durable progress; abort is staged-only and cannot touch active data.
- Added whole-store recovery (`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`): the backup carries committed WAL-visible work, a restore requires a matching accepted-loss digest and a current safety backup, and the diagnostic export is inert and credential-free.

<!-- CN -->
- 新增**执行迁移协议**：只读预览加分段应用（`previewExecutionMigration` / `applyExecutionMigration`），在不激活的前提下把旧 root/snapshot/session 证据分段入库，保留全部源文件字节与 issue/catalog 行，并保持文件路线为唯一在线权威。
- 新增相互独立的崩溃安全步骤（`activateExecutionMigration` / `retireExecutionSources` / `abortExecutionMigration`）：激活在「无任何遗留面」屏障之后一次性完成并只推进一次全局 epoch；退役只把确切的 root/snapshot 文件移入按 manifest 寻址的历史并逐项持久化进度；abort 仅作用于分段态，不能触碰活跃数据。
- 新增全库恢复（`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`）：备份包含已提交的 WAL 可见工作，恢复要求匹配的已接受损失摘要与一份当前安全备份，诊断导出为惰性且不含凭据。
