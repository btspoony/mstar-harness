---
category: Changed
packages: commands
---

- **Dashboard views:** Workflow and iteration views now read from the execution authority on ACTIVE harnesses instead of refusing the request. Fixes #354.
- **ACTIVE projection:** Removed an unreachable synthetic plan validator and redundant lease queries; completed plans with retained released leases remain visible without historical ownership.

<!-- CN -->
- **Dashboard 视图：** 工作流和迭代视图现在会在 ACTIVE harness 上从执行权威读取数据，不再拒绝请求。修复 #354。
- **ACTIVE projection：**移除不可达的合成 plan 校验和冗余 lease 查询；保留 released lease 的已完成计划仍可见，且不展示历史归属。
