---
category: Harness
packages: opencode
---

- **OpenCode native session association:** derive execution identity only from the native hook session, refuse missing or unsafe identity, revalidate session references against the current authority, and report the write hook honestly as `decision-only` because its API has no veto channel.

<!-- CN -->
- **OpenCode 原生会话关联：**执行身份只从原生 hook 会话获取，缺失或不安全的身份直接拒绝；会话引用必须针对当前 authority 重新校验；由于 hook API 没有 veto 通道，写入能力如实标记为 `decision-only`。
