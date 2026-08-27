---
category: Harness
packages: root
---
- mstar-dispatch-gates: role-binding field check now resolves the host column via `mstar-host` §Detect active host tool-shape detection; config paths and repo content are explicitly forbidden as host signals (prevents applying another host's dispatch key, e.g. OpenCode `subagent`, to an omp session whose task tool schema uses `agent`).

<!-- CN -->
- mstar-dispatch-gates：角色绑定字段自检的宿主列改由 `mstar-host` §Detect active host 的 tool-shape 检测裁决，明确禁止以 config 路径/仓库内容判定宿主（防止把其他宿主的派发键名——如 OpenCode 的 `subagent`——误用到 task 工具 schema 为 `agent` 的 omp 会话）。
