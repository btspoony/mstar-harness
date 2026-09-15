---
category: Harness
packages: root
---

- Added the **`mstar plan` scoped coordination transport**: `bind` (coordinator / workflow+plan / Assignment / `--resume`), `show`, `prepare`, `progress`, `residual-add`, `residual-close`, `handoff`, `accept`, `return`, `integration-start`, `integration-accept`, `complete` and `reconcile`, with JSON on stdout, diagnostics on stderr and the `0` ok / `1` engine refusal / `2` usage exit contract.
- Scoped verbs pin the active `FsStore` to the engine's resolved root before every call, so a process inside a linked feature checkout resolves the **main worktree's** harness instead of its own `.mstar`.
- `mstar harness scaffold` awaits the now-async, store-routed engine bootstrap and pins the store root it resolves.
- Coordinator transition verbs now **carry the `--handoff` id into the engine**, which re-checks it against the row inside its own lock: a handoff replaced between the CLI's read and the mutation can no longer be transitioned by a command that named the old one. The CLI pre-check stays as an early, friendlier refusal.
- Git reads refuse an unanswerable environment as `coordination.git-unavailable` (with the path, command and cause) instead of reporting integration divergence, and are bounded by a 10s timeout so a blocked `git` can no longer pin the row lock until every other writer times out.
- The integration proof reads the first-parent path in **one** `git rev-list` call instead of one subprocess per commit, keeping the lock hold constant on a busy integration branch.
- The findings-cleanup gate is evaluated while holding the register write lock (snapshot → register order), and the workflow merge lease is compared by plan and source branch, so a foreign lease is never reused or released.

<!-- CN -->
- 新增 **`mstar plan` 计划级协调传输层**：`bind`（coordinator / workflow+plan / Assignment / `--resume`）、`show`、`prepare`、`progress`、`residual-add`、`residual-close`、`handoff`、`accept`、`return`、`integration-start`、`integration-accept`、`complete`、`reconcile`；JSON 走 stdout、诊断走 stderr，退出码为 `0` 成功 / `1` 引擎拒绝 / `2` 用法错误。
- `mstar harness scaffold` 现在 await 异步且 store 路由的引擎引导，并固定其解析出的 store 根。
- 协调者转换动词现在把 **`--handoff` id 传入引擎**，由引擎在自己的锁内与行内记录核对：在 CLI 读取与变更之间被替换的 handoff，不再可能被「指名旧 handoff」的命令转换；CLI 侧的预检仅作为更早、更友好的拒绝保留。
- Git 读取在环境无法作答时以 `coordination.git-unavailable` 拒绝（携带路径、命令与原因），不再报告为集成分叉；同时加上 10 秒超时，卡住的 `git` 不再一直占住行锁、拖垮其他写入方。
- 集成证明改为**一次** `git rev-list` 读取 first-parent 路径，不再逐 commit 起子进程，繁忙集成分支上的持锁时间保持恒定。
- findings-cleanup 门在持有 register 写锁时求值（snapshot → register 锁序）；workflow merge lease 按 plan 与 source branch 比对，外来 lease 既不会被复用也不会被释放。
- 计划级动词在每次调用前把活动 `FsStore` 固定到引擎解析出的根，因此在 linked feature checkout 内运行的进程解析到的是**主 worktree** 的 harness，而不是本地 `.mstar`。
