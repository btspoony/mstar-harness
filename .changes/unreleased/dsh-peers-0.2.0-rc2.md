---
category: Harness
packages: root,dsh
---

- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.0-rc.2` (corridor `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2`: desktop menu-bar bundled dsh install, experimental async Q&A, model-picker fuzzy search, UX/desktop fixes, pi-ai → 0.87.1; deferred until npm published 0.2.0-rc.2). Session format v4 unchanged.
- Renamed the `@deepseek-ai/dsh-*` peers `dsh-agent-presets` → `dsh-agent-preset` and `dsh-code-runtime` → `dsh-ptc-runtime`.
- Migrated the planMode bridge from `agent/session-start` to serial `agent/created`.
- Bumped the `dsh-llm-fallbacks` devDependency `0.5.2` → `0.6.4` (first fallbacks generation matching the `0.2.0-rc.1` peer cohort); the engine `DSH_LLM_FALLBACKS_VERSION` pin moves with it.

<!-- CN -->
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.0-rc.2`（走廊 `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2`：桌面菜单栏 bundled dsh 安装、实验性异步问答、模型选择器模糊搜索、体验/桌面修复、pi-ai → 0.87.1；等 npm 发布 0.2.0-rc.2 后补做）。Session 格式仍为 v4。
- `@deepseek-ai/dsh-*` peer 包更名：`dsh-agent-presets` → `dsh-agent-preset`、`dsh-code-runtime` → `dsh-ptc-runtime`。
- planMode bridge 从 `agent/session-start` 迁移到串行 `agent/created`。
- `dsh-llm-fallbacks` 开发依赖 `0.5.2` → `0.6.4`（首个与 `0.2.0-rc.1` peer 走廊匹配的 fallbacks 代次），engine 侧 `DSH_LLM_FALLBACKS_VERSION` 锁定值同步跟进。
