---
category: Changed
packages: engine, dsh
---

- Added the file-native workflow notes ledger (`appendWorkflowNote`): one canonical line per note, appended under the execution-maintenance exclusion and the per-workflow status lock, with the synchronous current-session assertion as the last step before the fsynced byte write. Migrated legacy lines and the inline plan notes stay byte-for-byte preserved — nothing rewrites, reorders or compacts a retained ledger, and no note becomes a DB event.
- A note's identity is the caller's stable id: the same id with the same body replays without appending, the same id with a changed body refuses, and an id already recorded elsewhere refuses instead of picking a winner. A crash-cut partial line of the record being written is reconciled into exactly one accepted line; an unaccepted prefix that follows the record's own accepted line is healed by removing that prefix only; an unterminated tail that is not that record's partial refuses with every retained byte left in place.
- The retained leaf's trust decision is its open: `O_NOFOLLOW` plus a re-verification of that same descriptor's device/inode **and its bytes**, so a leaf swapped for a symlink, replaced or removed between the read and the commit refuses instead of being followed, truncated or written through.
- Durable writes complete a short write (a capacity-limited descriptor can accept fewer bytes than it was given) and refuse a write that accepts nothing, in both the ledger append and the atomic-replace helper.
- The DSh agent-flow ledger now derives every new row's identity from verified native facts — the log's verified incarnation plus the carrying session and call id — makes the accepted-identity index the dedup authority and the cursor sidecar a per-incarnation scan bound, and keeps the append, the identity commit and the scan-bound advance inside one shared-lock critical section. Display compaction is a single transaction recorded in a transient journal (before/after tail hashes plus the exact archive range), and evicted lines are archived byte-exact into sealed history chunks before the display tail is rewritten.
- Both agent-flow write paths take the same execution-maintenance exclusion as the engine's activation, restore and migration before their own lock, so a plugin write inside that window is refused with a bounded advisory instead of landing in a directory that is being rewritten.

<!-- CN -->
- 新增文件原生 workflow notes ledger（`appendWorkflowNote`）：每条 note 追加一行规范记录，位于执行维护排除与逐 workflow 状态锁之下，同步的当前会话断言是 fsync 字节写入前的最后一步。迁移过来的 legacy 行与内联 plan notes 逐字节保留——不重写、不重排、不压缩已留存 ledger，也不把任何 note 变成 DB 事件。
- note 的身份就是调用方的稳定 id：同 id 同正文重放而不追加，同 id 正文改变则拒绝，已被别处记录的 id 也拒绝而非任选一个。被崩溃截断的「正在写入记录」的不完整行会被修复为恰好一条已接受行；跟在记录自身已接受行之后的不完整前缀只通过删除该前缀治愈；不属于该记录前缀的未终止尾部则拒绝，且所有留存字节原地保留。
- 留存叶的可信判定**就是它的打开方式**：`O_NOFOLLOW` 加上对同一描述符的 device/inode **与字节**复核——因此读与提交之间被换成符号链接、被替换或被删除的叶会被拒绝，而不是被跟随、截断或写入。
- 持久化写入会**写满短写**（受容量限制的描述符可能只接受少于给定长度的字节），并对「一个字节都不接受」的写入拒绝——ledger 追加与原子替换助手都如此。
- DSh agent-flow ledger 现在从**已核验的原生事实**派生每一行的身份（日志的已核验化身 + 承载会话与 call id），把已接受身份索引作为去重权威、把游标副文件降为逐化身的扫描边界，并把追加、身份提交与扫描边界推进放在同一个共享锁临界区内。显示压缩是记录在瞬时日志中的单个事务（尾部前后哈希 + 精确归档区间），被淘汰行在显示尾部重写之前按字节原样归档进密封历史分片。
- 两条 agent-flow 写路径在各自锁之前先取与引擎 activation/restore/migration 相同的执行维护排除，因此该窗口内的插件写入会以有界建议被拒绝，而不会落进正被重写的目录。
