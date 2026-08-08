---
category: Fixed
packages: root, opencode
---

- OpenCode plugin entry now default-exports `{ server: MorningStarHarnessPlugin }` so helper function exports are not registered as plugins (fixes `plugin config hook failed: N.config` / `N.dispose` on startup).

<!-- CN -->
- OpenCode 插件入口改为 default export `{ server: MorningStarHarnessPlugin }`，避免辅助函数被当成 plugin 注册（修复启动时 `plugin config hook failed: N.config` / `N.dispose`）。
