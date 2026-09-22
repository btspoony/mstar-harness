---
category: Harness
packages: root
---

- Fixed the **store read intent** refusing `store.corrupt` ("unable to open database file") on a WAL store whose journal SQLite's own clean close had already folded into the database file: a read-only connection creates the `-shm` index itself but can never create the `-wal` SQLite reads a WAL database through, so that empty journal is put back before the open. The committed state is untouched — in that shape the database file IS the whole committed state — and a journal a writer already owns is never overwritten.
- That shape is reached by ordinary use, not only by a copy without sidecars: this runtime completes a closed connection's cleanup (checkpoint, then remove the empty sidecars) when the closed handle is collected, so any read after a writer close could refuse on Bun.
- Added the store lifecycle regression to `execution-store.test.ts`: the fixture's journal is folded in through the runtime's own handle cleanup and the committed authority must still be served, read-only.
- Dropped the two `store-db.test.ts` cases that pinned the runner's version **strings** against literal regexes, and the version plumbing that only they used: both rejected supported newer runtimes (Node v24.21.0 today, Bun 1.10 / Node 25 next) while testing no behavior. Real admission stays covered by the below-floor refusal assertions and the 9 scenarios run under both real runtimes.

<!-- CN -->
- 修复 **store 读取意图**在 WAL store 的日志已被 SQLite 自身干净关闭折入数据库文件后仍拒绝 `store.corrupt`（"unable to open database file"）的问题：只读连接可自行创建 `-shm` 索引，但永远无法创建 SQLite 读取 WAL 数据库所依赖的 `-wal`，因此在打开前补回该空日志。已提交状态不受影响——该形态下数据库文件本身即全部已提交状态——且写入者已持有的日志绝不被覆盖。
- 该形态来自常规使用，并非仅出现在缺 sidecar 的副本中：本运行时会在被关闭的连接句柄被回收时才完成其清理（checkpoint，随后删除空 sidecar），因此在 Bun 上任何写入关闭之后的读取都可能被拒绝。
- 在 `execution-store.test.ts` 新增该 store 生命周期回归：通过运行时自身的句柄清理折入 fixture 的日志，已提交权威仍须以只读方式被服务。
- 删除 `store-db.test.ts` 中两个断言运行器版本**字符串**匹配固定正则的用例，以及仅供它们使用的版本插件代码：二者都会误拒受支持的更新运行时（如今的 Node v24.21.0，将来的 Bun 1.10 / Node 25），且不验证任何行为。真实运行时准入仍由 below-floor 拒绝断言与两种真实运行时下的 9 个场景覆盖。
