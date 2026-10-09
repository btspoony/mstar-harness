---
category: Changed
packages: cli, commands, engine
---

- `mstar issue <verb> --help` now lists each payload field with its type and conditional requiredness, derived from `ISSUE_PAYLOAD_SCHEMAS` — e.g. `references (requiredWhen: resolved)` — replacing the opaque `Payload fields: payload` line (#420).
- Closure payload requiredness now follows the **effective disposition** end to end: `--disposition` overrides select the required fields at decode time, and static transport schemas keep disposition-conditional fields optional so composed MCP/CLI admission matches `assertClosureAuthority` (#420).

<!-- CN -->
- `mstar issue <verb> --help` 现在逐字段列出 payload 字段名、类型与条件必填性，直接派生自 `ISSUE_PAYLOAD_SCHEMAS`（如 `references (requiredWhen: resolved)`），取代含糊的 `Payload fields: payload`（#420）。
- Closure payload 的必填性现全程跟随**实际 disposition**：`--disposition` 覆写在解码层选择必填字段，静态传输 schema 将 disposition 条件字段保持可选，使 MCP/CLI 组合准入与 `assertClosureAuthority` 一致（#420）。
