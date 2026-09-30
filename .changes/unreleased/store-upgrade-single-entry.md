---
category: Changed
packages: commands
---

- Unified `store upgrade` behavior: schema-only stores upgrade without execution migration input; legacy execution migration reports refusals through command envelopes.

<!-- CN -->
- 统一 `store upgrade` 行为：仅需升级 schema 的存储无需执行迁移输入；旧版执行迁移的拒绝结果统一通过命令 envelope 返回。
