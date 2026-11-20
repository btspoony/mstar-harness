---
category: Changed
packages: dsh
---

- The bundled `linear-mcp` component row now authenticates with a static bearer resolved by dsh's own credential store: `expandTemplates: true` plus `Authorization: Bearer ${credential:MSTAR_LINEAR_TOKEN}`, staying `disabled: true` by default (enable after storing the token).
- Removed the mstar Linear settings card and the `mstarLinearAuth` OAuth service: no mstar-side Linear authorization surface remains in the dsh plugin.

<!-- CN -->
- 内置的 `linear-mcp` 组件行改用 dsh 自身凭据存储解析的静态 bearer 鉴权：`expandTemplates: true` 加 `Authorization: Bearer ${credential:MSTAR_LINEAR_TOKEN}`，默认仍 `disabled: true`（存入 token 后再启用）。
- 移除 mstar Linear 设置卡片与 `mstarLinearAuth` OAuth 服务：dsh 插件中不再保留任何 mstar 侧的 Linear 授权面。
