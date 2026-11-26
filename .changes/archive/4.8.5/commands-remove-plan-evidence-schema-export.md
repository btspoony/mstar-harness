---
category: Removed
packages: commands
---

- **Orphaned plan evidence schema export.** Removed the `PLAN_COMPLETION_EVIDENCE_SCHEMA` export from the private commands package; no package imports it and `plan complete` keeps publishing the same evidence schema.

<!-- CN -->
- **移除孤立的 plan evidence schema 导出。**从私有 commands 包移除 `PLAN_COMPLETION_EVIDENCE_SCHEMA` 导出；没有包导入它，`plan complete` 发布的 evidence schema 不变。
