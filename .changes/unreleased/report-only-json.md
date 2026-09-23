---
category: Changed
packages: engine
---

- Add the standalone `verification/report-only` JSON workflow route for a single named `type: plan` row.
- Require accepted handoff, matching recorded completion-policy evidence, preserved review/QA/findings gates, and atomic Done plus own lease release without integration or merge proof.
- Extend completed reconciliation to replay report-only state without restoring leases or rewriting timestamps.

<!-- CN -->
- 为唯一命名的 `type: plan` 单行工作流增加独立 `verification/report-only` JSON 路由。
- 要求已接受的 handoff、与登记 completion policy 匹配的完成证据，并保留 review/QA/findings 门禁；原子写入 Done 与释放本行 lease，不要求 integration 或 merge proof。
- 扩展已完成 reconcile，在不恢复 lease 或改写时间戳的情况下重放 report-only 状态。
