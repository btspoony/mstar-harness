---
category: Changed
packages: engine, commands
---

- `plan issue-add` now derives plan-owned project association for each finding and reports independently invalid entries with their array indexes before capture begins.
- DB issue capture and plan linking remain composed in one transaction, with occurrence keys retained as stable event identities across retries.

<!-- CN -->
- `plan issue-add` 现在为每条发现推导计划所属项目，并在开始捕获前按数组索引汇总独立无效项。
- 数据库 issue 捕获与计划关联仍在同一事务中组合完成，并在重试时保留 occurrence key 作为稳定事件身份。
