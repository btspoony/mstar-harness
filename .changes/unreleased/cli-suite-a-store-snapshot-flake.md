---
category: Harness
packages: cli
---

- The `MCP control-root admission class` A/B isolation test no longer compares full directory byte snapshots of a SQLite store. That comparison is unsound by construction in both directions, each verified directly: a read-only open leaves `store.db-wal`/`store.db-shm` beside the store, so an unrelated earlier read looks like a write; and an unflushed write can live only in the WAL, so a real write looks like no change. The assertion now compares the store's row counts — `issues` and `store_operations` — which is what "the capture did not reach this root" means.
- The intermittent `test-cli-suite-a` failure is attributed to the byte comparison: a read-only open creates those sidecars, and whether such a read happened first is decided by state left by whatever ran earlier in the shard. The failing run's assertion diff was not captured, so this is the mechanism consistent with every observation and with the probe, not a directly observed cause. The replacement does not depend on which sidecar-producing path ran: it is correct whether or not a read occurred, and a real write is still caught.
- A companion test pins the contract the new assertion relies on: a read-only store open leaves those row counts untouched.

<!-- CN -->
- `MCP control-root admission class` 的 A/B 隔离测试不再比较 SQLite store 的完整目录字节快照。该比较在构造上两个方向都不成立，且各自已直接验证：只读打开会在 store 旁留下 `store.db-wal`/`store.db-shm`，于是此前无关的读取看起来像一次写入；而未落盘的写入可能只存在于 WAL 中，于是真实写入看起来毫无变化。现在改为断言 store 的行数 —— `issues` 与 `store_operations` —— 这正是"capture 没有到达该根"的含义。
- 间歇失败的 `test-cli-suite-a` 归因于该字节比较：只读打开会创建这些伴生文件，而是否已发生过这样的读取取决于 shard 中更早运行的内容留下了什么状态。失败那一次的断言差异没有被捕获，因此这是与所有观察和探针都一致的机制，而非直接观测到的原因。替换后的断言不依赖具体是哪条产生伴生文件的路径先跑过：无论是否发生过读取它都成立，且真实写入仍会被捕获。
- 新增一个伴随测试锁定新断言所依赖的契约：只读打开 store 不会改变这些行数。
