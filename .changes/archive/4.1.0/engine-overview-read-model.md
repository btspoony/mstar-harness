---
packages: engine,commands
---

- **One aggregated dashboard read answers "what is the state right now".** The engine gains an `overview` view (`/api/overview` on the dashboard transport): one store transaction returns the active workflows with their plans, open residuals by severity with a reconciling total, the resolved project's milestone grouping and latest iteration, and the dated issue flow. Every member is a three-state `OverviewMember` (`read` / `not-applicable` / `unavailable`), so a member the read could not produce carries the store's own reason — never an empty collection and never a `0`. The route accepts only the `project` query field.
- **The two iteration reads disclose facts the store already held.** `IterationDTO.gateStep` marks the furthest iteration lifecycle step the store proves (Start / Execute / Close / PR delivery; `null` when the iteration records no compass) — Merge ready is never marked because no store row records a merge — and `IterationListDTO.attribution` says whether any iteration is attributed to a project, so an empty project feature can be told apart from a feature with no source at all.

<!-- CN -->
- **一次聚合读取回答「当前状态如何」。** engine 新增 `overview` 视图（dashboard 传输层对应 `/api/overview`）：单个事务内返回活跃 workflow 及其 plan、按严重度统计的未关闭残留项与可对账的总数、已解析项目的里程碑分组与最新迭代，以及按日期聚合的 issue 流。每个成员都是三态 `OverviewMember`（`read` / `not-applicable` / `unavailable`），读取失败的成员携带 store 自身的原因，绝不退化为空集合或 `0`。该路由只接受 `project` 查询字段。
- **两个迭代读取披露了 store 中既有的信息。** `IterationDTO.gateStep` 标记 store 可证明的最远迭代生命周期步骤（Start / Execute / Close / PR delivery；无 compass 记录时为 `null`），Merge ready 永不标记，因为没有任何 store 行记录 merge；`IterationListDTO.attribution` 说明是否至少有一个迭代归属到项目，从而把「项目下确实没有迭代」与「该特性没有来源」区分开。
