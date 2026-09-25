---
category: Changed
packages: omp
---

- Restored host session identity injection for shell commands with an idempotency guard, keeping repeated revisions from stacking `MSTAR_HOST_SESSION_ID` exports without touching the `env` input.

<!-- CN -->
- 恢复 shell 命令中的宿主会话身份注入并加入幂等保护，避免重复修订堆叠 `MSTAR_HOST_SESSION_ID` 导出语句，同时不修改 `env` 输入。
