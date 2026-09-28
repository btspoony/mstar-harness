---
packages: root,dsh
---

- Upgraded the `@deepseek-ai/dsh-*` peer cohort to `^0.2.0-rc.1` (corridor `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`: UX polish, optional schedule plugin pack, tool-scheduling recovery export, Windows sandbox permission skill; Session format v4 unchanged).
- Bumped the `dsh-llm-fallbacks` devDependency `0.5.2` → `0.6.4` (first fallbacks generation matching the `0.2.0-rc.1` peer cohort); the engine `DSH_LLM_FALLBACKS_VERSION` pin moves with it.

<!-- CN -->
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.0-rc.1`（走廊 `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1`：体验打磨、定时任务可选插件包、工具调度恢复导出、Windows 沙箱权限技能；Session 格式仍为 v4）。
- `dsh-llm-fallbacks` 开发依赖 `0.5.2` → `0.6.4`（首个与 `0.2.0-rc.1` peer 走廊匹配的 fallbacks 代次），engine 侧 `DSH_LLM_FALLBACKS_VERSION` 锁定值同步跟进。
