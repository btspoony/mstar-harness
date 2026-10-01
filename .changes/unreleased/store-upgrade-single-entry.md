---
category: Changed
packages: cli, commands, engine
---

- Unified `store safe-upgrade` behavior: schema-only stores upgrade without execution migration input; legacy execution migration reports refusals through command envelopes.
- Store safe-upgrade diagnostics for missing, unreadable, or malformed operator-supplied files are stable and do not expose filesystem error text or paths.
- `store safe-upgrade` resumes recorded ACTIVE migrations whose source retirement is incomplete, and uses attempt-specific recovery backup paths so retrying does not collide with a prior attempt.
<!-- CN -->
- 统一 `store safe-upgrade` 行为：仅需升级 schema 的存储无需执行迁移输入；旧版执行迁移的拒绝结果统一通过命令 envelope 返回。
- `store safe-upgrade` 对操作员提供的文件缺失、不可读或格式错误时使用稳定诊断，不泄露文件系统错误文本或路径。
- `store safe-upgrade` 会恢复已记录为 ACTIVE 但来源退役未完成的迁移，并使用按尝试区分的恢复备份路径，避免重试时与前次尝试冲突。
