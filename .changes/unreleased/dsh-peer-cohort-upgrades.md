---
packages: root,dsh
---

- Renamed the `@deepseek-ai/dsh-*` peers `dsh-agent-presets` → `dsh-agent-preset` and `dsh-code-runtime` → `dsh-ptc-runtime`.
- Migrated the planMode bridge from `agent/session-start` to serial `agent/created`.
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.1.7-rc.2` (corridor since `dsh-v0.1.5-rc.2`: Session V4, Messages-only DeepSeek adapter, spill-policy `maxInlineTokens`, Remote `readBytes`, plugin peer-compat checks; rc.2 keeps the consumed type surface additive).
- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.0-rc.1` (corridor `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`: UX polish, optional schedule plugin pack, tool-scheduling recovery export, Windows sandbox permission skill; Session format v4 unchanged).
- Bumped the `dsh-llm-fallbacks` devDependency `0.5.2` → `0.6.4` (first fallbacks generation matching the `0.2.0-rc.1` peer cohort); the engine `DSH_LLM_FALLBACKS_VERSION` pin moves with it.

<!-- CN -->
- `@deepseek-ai/dsh-*` peer 包更名：`dsh-agent-presets` → `dsh-agent-preset`、`dsh-code-runtime` → `dsh-ptc-runtime`。
- planMode bridge 从 `agent/session-start` 迁移到串行 `agent/created`。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.1.7-rc.2`（自 `dsh-v0.1.5-rc.2` 起的通道：Session V4、Messages-only DeepSeek adapter、spill-policy `maxInlineTokens`、Remote `readBytes`、插件 peer 兼容检查；rc.2 对已消费类型面保持增量）。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.0-rc.1`（走廊 `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`：体验打磨、定时任务可选插件包、工具调度恢复导出、Windows 沙箱权限技能；Session 格式仍为 v4）。
- `dsh-llm-fallbacks` 开发依赖 `0.5.2` → `0.6.4`（首个与 `0.2.0-rc.1` peer 走廊匹配的 fallbacks 代次），engine 侧 `DSH_LLM_FALLBACKS_VERSION` 锁定值同步跟进。
