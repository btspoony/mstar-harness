---
category: Changed
packages: dsh
---

- Gave every new agent-flow ledger row a **stable record identity built from verified native facts**: durable workflow events carry `eventId` + the source position `{sessionId, streamId, seq}`, where `streamId` is the log's VERIFIED incarnation (derived from the log's immutable head — never the store epoch, never a file mtime) and the id names the session AND the incarnation, so neither a session cross nor a rebuilt log can collide. Live tool-call rows carry `wfc1:<sessionId>:<callId>:<kind>` only when the seam supplies BOTH the carrying session id and a call id — an exec-less or call-less row records without an id instead of emitting `wfc1::`. A session whose log head cannot be read records nothing: no incarnation is invented.
- Made the durable **accepted-identity index** (`agent-flow-ids.jsonl`, one fsynced line per accepted row) the dedup authority, and reduced the cursor sidecar (`workflow-ledger-cursors.json`, v2 `{next, stream}` with v1 read compatibility) to a per-incarnation scan bound. A rebuilt log is scanned from its own floor instead of being skipped by a stale session bound, and an archived or cursor-evicted accepted row is still recognized instead of being appended twice.
- Kept the append, the identity commit and the scan-bound advance in ONE shared-lock critical section (`recordWorkflowEvent`): a crash between them replays into the found id. A PRESENT-but-unreadable cursor or index, a failed identity commit, and a reused identity with different bytes are ADVISORY REFUSALS — no append, no bound advance, and never "accepted" from an unreadable authority.
- Separated the bounded display tail from dedup retention: evicted lines are archived byte-exact into `fsync`ed sealed chunks under `<workflowDir>/agent-flow-history/` (`chunk-NNNNNN.jsonl`, inventoried by `listAgentFlowHistoryChunks`) BEFORE the 500-event tail is rewritten, retried batches are merged by byte overlap so an accepted occurrence is never archived twice, and only rows whose identity is already durable are evicted.

<!-- CN -->
- 为每条新的 agent-flow 账本行引入 **由可验证原生事实构建的稳定记录身份**：持久工作流事件带 `eventId` 与来源位置 `{sessionId, streamId, seq}`，其中 `streamId` 是日志的**已核实化身**（由日志不可变头部推导——绝不是 store epoch，也不是文件 mtime），且 id 同时包含会话与化身，因此跨会话与重建日志都不会碰撞。实时工具调用行仅在同一次观测同时拿到承载会话 id 与 call id 时才带 `wfc1:<sessionId>:<callId>:<kind>`——无 exec/无 callId 的行只记录不带身份，绝不再发 `wfc1::`。日志头部不可读的会话不写入任何行：不臆造化身。
- 把**持久化接受身份索引**（`agent-flow-ids.jsonl`，每条已接受行一行且 `fsync`）作为去重权威，游标旁车（`workflow-ledger-cursors.json`，v2 `{next, stream}`，兼容读取 v1）缩减为按化身的扫描下界。重建日志从自身下界开始扫描，不再被过期的会话下界跳过；已归档或游标被淘汰的已接受行仍能被识别，不会被重复追加。
- 追加、身份提交与扫描下界推进仍在同一个共享锁临界区（`recordWorkflowEvent`）内完成：三者之间崩溃都会重放并命中已存在 id。存在但不可读的游标或索引、身份提交失败、以及字节不同的重用身份，都是 advisory 拒绝——不追加、不推进下界，且绝不把不可读权威当作 accepted。
- 有界展示尾部与去重保留分离：在重写 500 事件尾部之前，被淘汰行先逐字节写入 `fsync` 过的密封分块 `<workflowDir>/agent-flow-history/chunk-NNNNNN.jsonl`（由 `listAgentFlowHistoryChunks` 清点）；崩溃重试按字节重叠合并，保证同一已接受事件不会被归档两次；只有身份已持久的行才会被淘汰。
