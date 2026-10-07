---
category: Harness
packages: root, engine
---

- Execution authority lives in store.db: ordinary primary-coordinator prepare/progress/complete and workflow transitions use atomic SQLite transactions, CAS and receipts; per-row PM identity/transfer/execution-lease admission is removed.
- Registration atomically publishes catalog delta, ordinary workflow/row metadata, root membership and receipt. Catalog edits do not silently relocate registered plan pointers; no sealed Assignment is required.
- Added the authoritative execution read route: workflow/plan state is read from the store in one read transaction, and a missing, staged, corrupt or busy authority refuses (`execution.consumer-not-ready`) instead of degrading to leftover root/snapshot JSON, newest-workflow guessing or dashboard projections. While the authority is active the retired file writes are refused at every entry boundary.
- Added the execution migration protocol — read-only preview, staged apply, one-shot activation behind a deferred-surface barrier, manifest-addressed retirement and whole-store restore — with crash-safe per-item progress, an abort that can only touch staged data, and a backup that freezes the file-native bodies a SQLite copy does not carry (ledgers, identity index, cursors, launch journal, history chunks, selection body) together with their accepted-record identities.
- Completion is witnessed by a sealed Git proof instead of refs alone (checkout/git/common-dir identity, `HEAD` and its refs, the index, every tracked path's content and mode, the directory listings a new untracked path changes, merge/rebase sentinels, the object inventory). It is re-read from the filesystem with no child process and no await immediately before the completion transaction, so a worktree, index, untracked or object-store change inside that window refuses without a `Done`, a receipt or a released lease.
- Added the execution coverage substrate: a closed 18-surface inventory with a byte codec per surface, and a validator that recomputes coverage from the retained bytes — hashing every named witness and deriving each result hash from what the bytes say — so an invented result, a changed byte, a borrowed or unpinned witness, a foreign workflow identity or a mislabelled capability refuses as `execution.coverage-incomplete`.
- An injected `ArtifactStore` (`setArtifactStore` / `--store` / `MSTAR_STORE_MODULE`) is served behind a guard that refuses the root register, a workflow snapshot and their `json` aliases while the canonical control root's authority is active; the control root is resolved from the process, never from the injector's own claim.
- Updated `mstar-artifacts` `references/status-and-residuals.md`: the transport split (active DB authority vs pre-activation file route) is now stated where the v2 file shapes, lease fields and lockdir prose are introduced, instead of only in the later coordination section — remaining snapshot-as-SSOT references are scoped to the pre-activation transport or legacy history.

<!-- CN -->
- 执行权威位于 store.db：普通 primary coordinator prepare/progress/complete 与 workflow 转换使用原子 SQLite 事务、CAS 和收据；逐行 PM 身份/转交/execution lease 准入已移除。
- 注册原子发布 catalog delta、普通 workflow/row metadata、根成员关系与收据。Catalog 编辑不静默移动登记的 plan 指针；不要求 sealed Assignment。
- 新增权威执行读取路由：workflow/plan 状态在一个读事务内取自 store；权威缺失、处于 staged、损坏或繁忙时以 `execution.consumer-not-ready` 拒绝，而**不**降级到残留的 root/snapshot JSON、猜测最新 workflow 或看板投影。权威 active 时，已退役的文件写入在每个入口边界被拒绝。
- 新增执行迁移协议：只读预览、分段应用、在「无遗留面」屏障后一次性激活、按 manifest 寻址的退役、整库恢复；逐项进度崩溃安全，abort 只能作用于分段态，备份会冻结 SQLite 副本不携带的文件原生正文（ledger、身份索引、游标、启动日志、历史分片、选择正文）及其已接受记录身份。
- 完成态以 **sealed Git proof** 见证（checkout/git/common-dir 身份、`HEAD` 及其 ref、index、每条 tracked 路径的内容与模式、新 untracked 文件会改变的目录条目、merge/rebase 哨兵、对象清单），并在完成事务前**仅从文件系统**重读（无子进程、无 await）：该窗口内工作树、index、untracked 或对象库的任何变化都会拒绝，不产生 `Done`、回执或租约释放。
- 新增执行覆盖基底：18 个 surface 的闭合清单与逐 surface 字节 codec，以及**从留存字节重算**覆盖的校验器（对每个命名 witness 重新哈希、据字节内容推导 result hash）——伪造结果、字节变更、借用或未 pin 的 witness、外来 workflow 身份、错标能力，均以 `execution.coverage-incomplete` 拒绝。
- 经 `setArtifactStore` / `--store` / `MSTAR_STORE_MODULE` 注入的 `ArtifactStore` 由门禁包装：当规范化控制根的执行权威为 active 时，其 `put`/`get`/`delete` 拒绝根 register、workflow snapshot 及二者的 `json` 别名；该控制根从进程侧解析，绝不采信注入方自述的 root。
- 更新 `mstar-artifacts` `references/status-and-residuals.md`：transport 划分（active DB 权威 vs pre-activation 文件路线）现已在 v2 文件形状、lease 字段与 lockdir 正文的引入处说明，而非只出现在后文协调节——其余 snapshot 权威表述均限定在 pre-activation transport 或 legacy 历史。
