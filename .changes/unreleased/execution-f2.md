---
category: Changed
packages: dsh
---

- Gave every new agent-flow ledger row a **stable record identity**: durable workflow events carry `eventId` + the source position `{sessionId, streamId, seq}` (the log incarnation, never the store epoch) and live tool-call rows carry `wfc1:<sessionId>:<callId>:<kind>`, so one call id in two sessions stays two distinct records while older rows keep their exact bytes.
- Made the workflow-event append and its cursor advance **one shared-lock critical section** (`recordWorkflowEvent`): a fresh cursor is loaded, the record id is looked up in the bounded durable tail, the row is appended and the cursor written atomically — so a crash between append and cursor replays into the found id and only advances the cursor (no duplicate, no loss). An id already present with different bytes and a torn record that could be this event are advisory refusals with no durable advance.
- Bounded display compaction now **archives the evicted lines first**: byte-exact `fsync`ed chunks under `<workflowDir>/agent-flow-history/chunk-NNNNNN.jsonl` (inventoried by `listAgentFlowHistoryChunks`) are written before the 500-event tail is rewritten, and only records whose cursor checkpoint is already durable are evicted — a pending record stays in the dedup window.
- Added the awaited **explicit ledger target** protocol (`WorkflowLedgerTarget` / `ResolveWorkflowLedgerTarget`, `registerWorkflowLedger`'s optional fourth argument): when a resolver is supplied the consumer awaits it at each event boundary, uses only the returned target, records nothing on a `null`/inconsistent target (never falling back to the file-based active set), and serializes processing per source stream so a delayed lookup cannot reorder watermarks.
- Moved the durable cursor store next to the ledger it guards (same workflow dir, same `.ledger-write.lockdir`, same `workflow-ledger-cursors.json` format) so one owner holds both files; the retired harness-root cursor file is still never read.

<!-- CN -->
- 为每条新的 agent-flow 账本行引入 **稳定记录身份**：持久工作流事件带 `eventId` 与来源位置 `{sessionId, streamId, seq}`（日志化身，而非 store epoch），实时工具调用行带 `wfc1:<sessionId>:<callId>:<kind>`，因此两个会话中的同一 call id 仍是两条独立记录；既有旧行保留原始字节。
- 把工作流事件的追加与其游标推进合并为 **同一个共享锁临界区**（`recordWorkflowEvent`）：先加载新鲜游标，再在有界持久尾部按记录 id 查重，然后追加并原子写入游标——因此 append 与游标之间崩溃时，重放会命中已存在的 id 而只推进游标（不重复、不丢失）。已存在但字节不同的 id，以及可能属于该事件的撕裂记录，均以 advisory 拒绝且不推进持久游标。
- 有界展示尾部压缩现在 **先归档被淘汰的行**：在重写 500 事件尾部之前，先把逐字节一致且 `fsync` 过的分块写入 `<workflowDir>/agent-flow-history/chunk-NNNNNN.jsonl`（由 `listAgentFlowHistoryChunks` 清点），并且只淘汰游标检查点已持久的记录——待定记录始终留在去重窗口内。
- 新增可 await 的 **显式账本目标**协议（`WorkflowLedgerTarget` / `ResolveWorkflowLedgerTarget`，`registerWorkflowLedger` 的可选第四参数）：提供 resolver 时，消费者在每个事件边界 await 它并只使用返回的目标；目标为 `null` 或不一致时不写入任何行（绝不回退到基于文件的 active set），且按来源流串行处理，延迟的查找不会打乱水位。
- 把持久游标存储移到它所保护账本的旁边（同一 workflow 目录、同一 `.ledger-write.lockdir`、同一 `workflow-ledger-cursors.json` 格式），由单一 owner 持有这两个文件；已退役的 harness 根游标文件依旧从不读取。
