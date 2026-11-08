---
category: Harness
packages: cli
---

- The `MCP control-root admission class` suite no longer fails intermittently in `test-cli-suite-a`. The A/B isolation test compared full directory byte snapshots of a SQLite store, which is unstable in two directions: a read-only open leaves `-wal`/`-shm` beside the store (so an unrelated read looks like a write), and an unflushed write can live only in the WAL (so a real write looks like no change). It now asserts the store's row counts — `issues` and `store_operations` — which are exactly what "the capture did not reach this root" means.
- A companion test pins the contract the new assertion relies on: a read-only store open leaves those row counts untouched.

<!-- CN -->
- `MCP control-root admission class` 套件不再在 `test-cli-suite-a` 中间歇失败。A/B 隔离测试原本比较 SQLite store 的完整目录字节快照，这在两个方向上都不稳定：只读打开会在 store 旁留下 `-wal`/`-shm`（于是无关的读取看起来像一次写入），而未落盘的写入可能只存在于 WAL 中（于是真实写入看起来毫无变化）。现在改为断言 store 的行数 —— `issues` 与 `store_operations` —— 这正是"capture 没有到达该根"的含义。
- 新增一个伴随测试锁定新断言所依赖的契约：只读打开 store 不会改变这些行数。
