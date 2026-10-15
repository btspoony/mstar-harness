---
category: Fix
packages: root
---

- Fixed the shared role-agent shells so they load on current omp: the OpenCode-style `tools:` map (`write`/`edit`/`bash: true`) was a no-op where it was honoured and is not a valid omp `tools` value (omp reads a tool-name list), which made omp error while loading the plugin's agents. The map is gone; `mode` and `permission` are unchanged, so OpenCode keeps its seat restrictions.
- Trimmed the reviewer/QC `permission.edit` allow set to the canonical harness roots (`.mstar/sdd/**`, `.mstar/plans/**`) and dropped the unused legacy `.agents/**` and relative in-repo `.worktrees/**` mirrors; permission scope continues to follow the Assignment's report path.

<!-- CN -->
- 修复共享角色 agent 壳，使其可在当前 omp 上加载：OpenCode 风格的 `tools:` 映射（`write`/`edit`/`bash: true`）在被识别处本就是空操作，且不是合法的 omp `tools` 取值（omp 读取的是工具名列表），会导致 omp 加载插件 agents 时报错。该映射已移除；`mode` 与 `permission` 未变，OpenCode 的席位限制仍然生效。
- 将 reviewer/QC 的 `permission.edit` 允许集收敛到规范 harness 根（`.mstar/sdd/**`、`.mstar/plans/**`），移除未使用的 legacy `.agents/**` 与仓库内相对 `.worktrees/**` 镜像；权限范围仍按 Assignment 的报告路径确定。
