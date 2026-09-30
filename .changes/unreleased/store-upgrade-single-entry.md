---
category: Changed
packages: commands
---

- Unified `store upgrade` behavior: schema-only stores upgrade without execution migration input; legacy execution migration reports refusals through command envelopes.
- Store upgrade diagnostics for missing, unreadable, or malformed operator-supplied files are stable and do not expose filesystem error text or paths.
<!-- CN -->
- 统一 `store upgrade` 行为：仅需升级 schema 的存储无需执行迁移输入；旧版执行迁移的拒绝结果统一通过命令 envelope 返回。
- `store upgrade` 对操作员提供的文件缺失、不可读或格式错误时使用稳定诊断，不泄露文件系统错误文本或路径。
