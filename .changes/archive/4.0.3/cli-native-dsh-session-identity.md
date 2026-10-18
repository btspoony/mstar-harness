---
packages: cli
---

- **`DSH_SESSION_ID` is a CLI session-identity source.** The resolver now reads the native dsh execution id between the launcher-minted `MSTAR_EXECUTION_IDENTITY` and the legacy ambient `MSTAR_HOST_SESSION_ID`: precedence is `--session-id` > minted tuple > `DSH_SESSION_ID` > `MSTAR_HOST_SESSION_ID` (empty/whitespace ignored). The native value resolves with `sessionIdSource: "env"` and carries no execution tuple, so a dsh-hosted agent reaches the CLI without the per-command `/mstar-execution` workaround; the session-identity help paragraph names the same order.
- Identity-scrubbing test harnesses now pin the native channel out alongside the legacy ones, so their "no identity" and host-fallback cases stay hermetic on a dsh host.

<!-- CN -->
- **`DSH_SESSION_ID` 成为 CLI 会话身份来源。** 解析顺序现为 `--session-id` > 启动器铸造的 `MSTAR_EXECUTION_IDENTITY` > `DSH_SESSION_ID` > 既有环境变量 `MSTAR_HOST_SESSION_ID`（空/纯空白忽略）。原生值以 `sessionIdSource: "env"` 解析且不携带执行元组，dsh 宿主中的 agent 因此无需逐命令使用 `/mstar-execution` 变通；会话身份帮助段落同步列出该顺序。
- 会清洗身份环境的测试夹具现在同时排除该原生通道，使其「无身份」与「回退宿主变量」用例在 dsh 宿主上保持隔离。
