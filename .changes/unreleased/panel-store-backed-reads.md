---
category: Changed
packages: engine, commands, dsh
---

- **engine**: add `dashboard-view`, holding the generic dashboard request layer (`dashboardFilters`, `readDashboardView`, `dashboardFailure`) that every transport shares. `queryDashboard` / `withStoreRead` are unchanged.
- **commands**: the dashboard transport keeps only its URL route table and re-exports the shared layer from the engine — no second copy of the query validation.
- **dsh**: the workflow panel renders from the control-root `store.db` authorities instead of the last model-emitted engine-status payload, and polls a new `mstar/panelSnapshot` endpoint while its tab is visible. The panel now has three tabs — 任务迭代 / 项目路线图 / 事件记录: the agents tab, its page and its projection are removed, the two event partitions are merged into one chronological flow, and a new roadmap page renders the direction, goals and milestone↔issue membership with four distinct absence states. `mstar/engineStatus` no longer answers reads; the catalog emission, `mstar/selectWorkflow` and the durable selection are unchanged. The three catalog facts no dashboard DTO carries (iteration gate, knowledge digest, resolved selection) ride the snapshot as `retained` and disclose their own build instant, separate from the store-read time.

<!-- CN -->
- **engine**：新增 `dashboard-view`，承载各传输共用的 dashboard 请求层（`dashboardFilters`、`readDashboardView`、`dashboardFailure`）。`queryDashboard` / `withStoreRead` 语义不变。
- **commands**：dashboard 传输层只保留 URL 路由表，请求校验与执行改为从 engine 重导出，不再有第二份实现。
- **dsh**：工作流面板改为从控制根 `store.db` 的权威数据渲染，不再渲染模型最后发射的 engine-status 快照，并在页签可见时轮询新的 `mstar/panelSnapshot` 端点。面板改为三个页签——任务迭代 / 项目路线图 / 事件记录：代理执行页签及其页面与投影被移除，事件记录的两栏合并为按时间倒序的单一流，新增的项目路线图页渲染方向、目标与里程碑↔issue 归属，并区分四种缺席态。`mstar/engineStatus` 不再提供读取；catalog 发射、`mstar/selectWorkflow` 与持久选择记录均未改变。dashboard DTO 不携带的三项 catalog 事实（迭代门禁、知识摘要、已解析的选择）随快照以 `retained` 提供，并各自披露其构建时刻，与 store 读取时刻区分。
