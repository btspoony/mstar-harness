---
packages: root,dsh
---

- Renamed the `@deepseek-ai/dsh-*` peers `dsh-agent-presets` → `dsh-agent-preset` and `dsh-code-runtime` → `dsh-ptc-runtime`.
- Migrated the planMode bridge from `agent/session-start` to serial `agent/created`.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.1.7-rc.2` (corridor since `dsh-v0.1.5-rc.2`: Session V4, Messages-only DeepSeek adapter, spill-policy `maxInlineTokens`, Remote `readBytes`, plugin peer-compat checks; rc.2 keeps the consumed type surface additive).

<!-- CN -->
- `@deepseek-ai/dsh-*` peer 包更名：`dsh-agent-presets` → `dsh-agent-preset`、`dsh-code-runtime` → `dsh-ptc-runtime`。
- planMode bridge 从 `agent/session-start` 迁移到串行 `agent/created`。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.1.7-rc.2`（自 `dsh-v0.1.5-rc.2` 起的通道：Session V4、Messages-only DeepSeek adapter、spill-policy `maxInlineTokens`、Remote `readBytes`、插件 peer 兼容检查；rc.2 对已消费类型面保持增量）。
