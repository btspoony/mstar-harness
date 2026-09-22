---
category: Harness
packages: opencode
---

- **OpenCode native session association:** derive the execution identity only from the native hook `sessionID` plus an independently acquired `MSTAR_EXECUTION_IDENTITY` scope, carry it into a real shared-CLI invocation, drop the legacy identity/root channels, and refuse missing, blank, malformed, copied or stale associations as explicit operational exclusions. The write hook keeps reporting `decision-only`, because its API has no veto channel.

<!-- CN -->
- **OpenCode 原生会话关联：**执行身份只来自原生 hook `sessionID` 加独立获取的 `MSTAR_EXECUTION_IDENTITY` scope，并真正带入共享 CLI 调用；同时清除 legacy 身份/根通道；缺失、空白、畸形、被复制或过期的关联一律作为显式操作排除处理。写入 hook 因 API 无 veto 通道仍如实标记为 `decision-only`。
