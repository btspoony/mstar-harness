---
packages: root, cli, engine, commands
---

- **The external half of the dashboard is removed.** The `sync-binding` screen, its `#sync-binding` route and navigation entry, the `/api/sync-binding` read, the `querySyncBinding` engine view, the shell-chrome nav key and both locales' copy are gone end to end; a stale `#sync-binding` address now lands on the overview and a stale `/api/sync-binding` request answers the dashboard's structured `not-found`. The dashboard renders the local `store.db` only — the issues/detail, issue-flow, workflows/detail, iterations/detail, roadmap, projects and overview reads keep answering.

<!-- CN -->
- **移除 dashboard 的对外集成半边。** `sync-binding` 页面、它的 `#sync-binding` 路由与导航项、`/api/sync-binding` 读取、engine 的 `querySyncBinding` 视图、shell chrome 的导航键以及两种语言的文案已端到端删除；旧的 `#sync-binding` 地址现在落在总览页，旧的 `/api/sync-binding` 请求返回 dashboard 的结构化 `not-found`。dashboard 只渲染本地 `store.db` —— issues/detail、issue-flow、workflows/detail、iterations/detail、roadmap、projects 与 overview 读取保持可用。
