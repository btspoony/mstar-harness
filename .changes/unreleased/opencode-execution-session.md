---
category: Harness
packages: opencode
---

- **OpenCode native session association:** derive the execution identity only from the native hook `sessionID` plus an independently acquired `MSTAR_EXECUTION_IDENTITY` scope, carry it into a real shared-CLI invocation (`plan show --session-ref` when this plugin holds the reference, otherwise `plan show --workflow/--plan`, otherwise the argument-less `status validate` register read), overwrite the identity channel and the resolved root while dropping the legacy identity key, and report exactly what each call proved. Missing, blank, malformed, copied or stale associations are explicit operational exclusions; the write hook keeps reporting `decision-only` because its API has no veto channel and never claims a stopped writer or a fence.

<!-- CN -->
- **OpenCode 原生会话关联：**执行身份只来自原生 hook `sessionID` 加独立获取的 `MSTAR_EXECUTION_IDENTITY` scope，并真正带入共享 CLI 调用（插件持有引用时走 `plan show --session-ref`，否则 `plan show --workflow/--plan`，再否则无旗标的 `status validate` register 读）；同时覆盖身份通道与已解析根、移除 legacy 身份键，并如实区分每次调用证明到什么。缺失、空白、畸形、被复制或过期的关联一律是显式操作排除；写入 hook 因 API 无 veto 通道仍标记 `decision-only`，绝不声称已阻止写入或构成 fence。
