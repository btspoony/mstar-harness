---
packages: cli
---

- **`mstar mcp --identity-env <NAME>` declares the default session-id channel.** When the flag is present, the stdio resolver reads the named environment variable (empty/whitespace ignored), satisfies a required `sessionId` selector at admission, and supplies `resolved.sessionId`; a per-call `sessionId` still wins. Without the flag the server reads no environment identity, so the existing "ignore ambient identity" contract is unchanged. A malformed declared value is not repaired: it reaches the same safe-session-id guard as a per-call value and refuses loudly. The declared default applies to the whole connection, so per-caller identity needs an explicit `sessionId` or its own scoped mount.

<!-- CN -->
- **`mstar mcp --identity-env <NAME>` 声明默认会话身份通道。** 传入该 flag 时，stdio 解析器读取指定环境变量（空/纯空白忽略），在输入准入阶段满足必需的 `sessionId`，并作为 `resolved.sessionId` 提供；每次调用的 `sessionId` 仍然优先。未传该 flag 时不读取任何环境身份，既有「忽略环境身份」契约保持不变。畸形的声明值不会被修补：它与其他身份一样经过同一个安全 session-id 门禁并明确拒绝。声明的默认值作用于整条连接，因此按调用方区分的身份需要显式 `sessionId` 或各自独立的 scoped mount。
