---
category: dsh
packages: cli, dsh
---

- **`dsh-llm-fallbacks` upgraded to `0.4.1`** (the line adapted to `@deepseek-ai/dsh-*` `^0.1.2-rc.1`): the repo's devDependency and the dsh adapter's install spec are now the EXACT `0.4.1` (no caret). The unpinned add previously forwarded the dsh CLI's own manifest spec (`^0.3.5`), whose dist re-exports `installSettingsSection` from `@deepseek-ai/dsh-settings` — an export the rc.1 line removed — breaking the installed-artifact boot; the installed dsh e2e specs now also pin the fallbacks add and extend the shipped-surface probe to the native persona channel (`internal/get` + `request.persona`), so a published dist built on the superseded additive-section path is re-added pinned to the repo version instead of silently booting stale.
- Both dsh install e2e specs run green end to end against the real registry (previously failing on the `^0.3.5` re-export break).

<!-- CN -->
- **`dsh-llm-fallbacks` 升级到 `0.4.1`**（适配 `@deepseek-ai/dsh-*` `^0.1.2-rc.1` 的版本线）：仓库 devDependency 与 dsh 适配器的安装 spec 均改为精确 `0.4.1`——此前未钉版本时，`dsh plugin add` 会转发 dsh CLI 自带清单里的 spec（`^0.3.5`），其 dist 将 `installSettingsSection` re-export 自 `@deepseek-ai/dsh-settings`（rc.1 线已移除该导出），导致安装产物启动失败；两个 dsh 安装 e2e 同时把 shipped-surface 探测扩展到原生 persona 通道（`internal/get` + `request.persona`），published 版本若构建自旧 additive-section 路径则重加钉到仓库版本。
- 两个 dsh 安装 e2e 现已端到端全绿（此前因 `^0.3.5` re-export 破裂而失败）。