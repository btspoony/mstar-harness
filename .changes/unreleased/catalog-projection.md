---
category: Harness
packages: root
---

- Added the **catalog authority** in `{HARNESS_DIR}/store.db` (migration 2): project/iteration/plan/document identity, paths, membership, spec/knowledge relations and catalog lifecycle are DB rows, while document bodies stay files and execution routing, leases and frozen inputs stay JSON.
- Replaced the maintained Markdown index obligations (iteration README rows, package Documents tables, specs/knowledge index tables) with **catalog discover / import / register / query** duties; completeness is a DB query, and a missing README is no longer a failure.
- Added the `mstar catalog` verb family (list, show, register, update, link, discover, import, export, reconcile) — verbs and flags live in `--help`.
- Added the **registration journal**: the snapshot/root writes and the catalog delta publish through one recoverable operation (`catalog.registration-pending`, recovered with `mstar catalog reconcile`), and a prepared plan pins its execution input to a catalog revision.
- Added **disposable execution/roadmap projections** (migration 3) with honest freshness and diagnostics, plus the `withStoreRead` read boundary and dashboard DTOs.
- Documented the cross-clone limit: `store.db` is local and gitignored, tracked bodies alone cannot rebuild local catalog history, and discovery reports explicit unknowns. Live index retirement and activation belong to the cutover plan.

<!-- CN -->
- 新增 **catalog 权威**（`{HARNESS_DIR}/store.db`，migration 2）：project/iteration/plan/document 的身份、路径、归属、spec/knowledge 关系与 catalog 生命周期是 DB 行；正文仍是文件，执行路由、lease 与冻结输入仍是 JSON。
- 把需维护的 Markdown 索引义务（迭代 README 行、package Documents 表、specs/knowledge 索引表）替换为 **catalog discover / import / register / query** 职责；完整性改为 DB 查询，README 缺失不再是失败。
- 新增 `mstar catalog` 动词族（list、show、register、update、link、discover、import、export、reconcile）——动词与标志以 `--help` 为准。
- 新增 **registration journal**：snapshot/根 entry 写入与 catalog delta 经同一个可恢复操作发布（`catalog.registration-pending`，用 `mstar catalog reconcile` 收口），且 prepare 的 plan 把执行输入 pin 到某个 catalog revision。
- 新增 **可丢弃的执行/roadmap 投影**（migration 3），诚实报告新鲜度与诊断；新增 `withStoreRead` 读边界与 dashboard DTO。
- 记录跨 clone 限制：`store.db` 本地且默认 gitignored，仅凭 tracked 正文无法重建本地 catalog 历史，discovery 以显式 unknowns 报告。live 索引退役与激活归 cutover plan。
