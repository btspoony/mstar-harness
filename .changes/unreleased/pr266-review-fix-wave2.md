---
category: Harness
packages: root
---

- **Dashboard rows scope by their own workflow** (PR #266 review RV-1): projection plan/lease rows are matched by the tables' own `(workflow_id, plan_id)` key — the same plan id under a plan workflow and an iteration workflow no longer attaches the other workflow's lease, status, progress or pin revision in the workflows view or the iteration execution overlay.
- **Symlink cross-harness register writes are vetoed** (PR #266 review RV-2): a pre-activation register reached through a symlink that lands on another harness's active or unreadable issue authority is refused by the landed context (`project.register.retired` / `store.authority-unavailable`) in all three enforcing copies (ZCode hook, omp gate, dsh store-authority); both contexts pre-activation keep the §7 legacy register path.
- **Catalog imports never leave a silent prefix** (PR #266 review RV-3): a mid-plan `importCatalog` failure rethrows `catalog.import-partial` carrying exactly the applied receipts and the resume instruction — the applied proposals are journalled progress, and re-running the same reviewed plan with the same operationId converges to the full plan exactly once.
- **OpenCode plugin declares its Node floor** (PR #266 review RV-4): `@mstar-harness/opencode` `engines` now requires `node >=24.18.0` (`node:sqlite`) alongside Bun, and the package INSTALL/README name the floor.

<!-- CN -->
- **Dashboard 行按所属 workflow 取数**（PR #266 评审 RV-1）：projection 的 plan/lease 行改用表自身的 `(workflow_id, plan_id)` 键匹配——同一 plan id 同时存在于 plan workflow 与 iteration workflow 时，workflows 视图与 iteration 执行 overlay 不再附着另一个 workflow 的 lease、状态、进度或 pin revision。
- **拒绝符号链接跨 harness 的 register 写入**（PR #266 评审 RV-2）：pre-activation register 经符号链接落到另一 harness 的 active/不可读 issue authority 时，由落点上下文拒绝（`project.register.retired` / `store.authority-unavailable`），三份执行副本（ZCode hook、omp gate、dsh store-authority）语义一致；双方都 pre-activation 时保留 §7 legacy register 路径。
- **目录导入不再留下静默前缀**（PR #266 评审 RV-3）：`importCatalog` 中途失败改以 `catalog.import-partial` 显式抛出，携带已应用的 receipt 与恢复指引——已应用部分是持久化的 journal 进度，用同一 operationId 重跑同一评审 plan 即可幂等收敛到完整 plan、恰好一次。
- **OpenCode 插件声明 Node 版本下限**（PR #266 评审 RV-4）：`@mstar-harness/opencode` 的 `engines` 在 Bun 之外新增 `node >=24.18.0`（`node:sqlite`），包内 INSTALL/README 同步写明该下限。
