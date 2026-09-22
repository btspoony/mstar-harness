---
category: Harness
packages: opencode
---

- **OpenCode native session association:** derive the execution identity only from the native hook `sessionID` plus an independently acquired `MSTAR_EXECUTION_IDENTITY` scope, learn the session's own reference from its CLI traffic (`--session-ref` / `--resume-ref`), and carry it into a real shared-CLI invocation (`plan show --session-ref` — the session-authorized read that revalidates caller/root/store/epoch/row — otherwise `plan show --workflow/--plan`, otherwise the argument-less `status validate` register read), overwriting the identity channel while removing BOTH legacy keys (`MSTAR_HOST_SESSION_ID`, `MSTAR_HARNESS_DIR`) so the root is only ever the explicit `--harness` flag or the child's cwd, and reporting exactly what each call proved. Missing, blank, malformed, copied or stale associations are explicit operational exclusions; the write hook keeps reporting `decision-only` because its API has no veto channel and never claims a stopped writer or a fence.

<!-- CN -->
- **OpenCode 原生会话关联：**执行身份只来自原生 hook `sessionID` 加独立获取的 `MSTAR_EXECUTION_IDENTITY` scope；引用从该会话自身的 CLI 流量（`--session-ref` / `--resume-ref`）习得，并真正带入共享 CLI 调用（持有引用时走 `plan show --session-ref`——会复核 caller/root/store/epoch/row 的 session-authorized 读，否则 `plan show --workflow/--plan`，再否则无旗标的 `status validate` register 读）；覆盖身份通道的同时移除两个 legacy 键（`MSTAR_HOST_SESSION_ID`、`MSTAR_HARNESS_DIR`），根只来自显式 `--harness` 或子进程 cwd，并如实区分每次调用证明到什么。缺失、空白、畸形、被复制或过期的关联一律是显式操作排除；写入 hook 因 API 无 veto 通道仍标记 `decision-only`，绝不声称已阻止写入或构成 fence。
