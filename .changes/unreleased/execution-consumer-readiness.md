---
category: Harness
packages: root
---

- Added the **atomic catalog/execution registration** (`commitExecutionRegistration`): one SQLite transaction publishes the reviewed catalog delta, the workflow/plan rows, their sealed frozen inputs, the root membership, the workflow's catalog binding and the committed receipt against the root CAS. A refusal anywhere publishes neither half, a current catalog edit cannot move an accepted frozen input, and a source reopen still replays the recorded receipt.
- Added the **authoritative execution read route** (`readExecutionAuthority` / `resolveExecutionReadRoute` / `readExecutionSource`): workflow/plan state is read from the store in one read transaction, and an authority that is missing, staged, corrupt or busy refuses instead of degrading to leftover root/snapshot JSON, newest-workflow guessing or dashboard projections.
- Routed the source consumers through it: CLI `plan show` / `status validate` / `lease verify` / `iteration gate`, the OMP `status validate` / `iteration gate` / `lease verify` / `worktree check` tools and their pre-hook, the OMP phase-2 and model-handoff extensions, DSh's catalog/store-authority/workflow-selection/dispatch gates, the OpenCode plugin and the ZCode write-gate **source**. Each either reads the DB authority or reports `execution.consumer-not-ready`; `execution.direct-write-refused` keeps refusing the retired protected writes.
- Source readiness only. No installed consumer is switched, no bundle is regenerated or repackaged, no version surface is bumped and no live activation or release is claimed. Deferred session files, side ledgers, packaging parity and installed fencing stay in the 2b backlog; the committed ZCode bundle `hooks/mstar-write-gate.mjs` is knowingly stale against this source and is refreshed with the release round, not here.

<!-- CN -->
- 新增 **catalog/execution 原子注册**（`commitExecutionRegistration`）：同一个 SQLite 事务以根 CAS 为条件发布经评审的 catalog delta、workflow/plan 行、其密封冻结输入、根成员关系、workflow 的 catalog 绑定与已提交回执。任一处拒绝则两半都不发布；当前 catalog 编辑无法移动已接受的冻结输入；源码层重开后仍能重放已记录的回执。
- 新增**权威执行读取路由**（`readExecutionAuthority` / `resolveExecutionReadRoute` / `readExecutionSource`）：workflow/plan 状态在单个读事务中从 store 读取；权威缺失、staged、损坏或忙时一律拒绝，而不是降级到残留的 root/snapshot JSON、猜测最新 workflow 或 dashboard 投影。
- 把源消费方接到该路由：CLI `plan show` / `status validate` / `lease verify` / `iteration gate`、OMP `status validate` / `iteration gate` / `lease verify` / `worktree check` 工具与其 pre-hook、OMP phase-2 与 model-handoff 扩展、DSh 的 catalog/store-authority/workflow-selection/dispatch 门禁、OpenCode 插件以及 ZCode write-gate **源码**。它们要么读取 DB 权威，要么报 `execution.consumer-not-ready`；`execution.direct-write-refused` 继续拒绝已退役的保护写。
- 仅为源码就绪。不切换任何已安装消费方，不重新生成或重新打包 bundle，不推进任何版本面，也不声称 live 激活或发布。延迟的 session 文件、side ledger、打包一致性与已安装隔离仍留在 2b 待办；已提交的 ZCode bundle `hooks/mstar-write-gate.mjs` 相对本源码有意保持陈旧，随 release 轮次刷新，不在此处处理。
