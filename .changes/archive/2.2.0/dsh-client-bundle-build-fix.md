---
packages: root
---

- **dsh plugin**: fixed the broken `@mstar-harness/dsh` build gate — the web client bundle (`dist/client.js`) is now emitted by the full build. Root causes: `tsconfig.json` `types` omitted `react` (TS7026: no `JSX.IntrinsicElements` for the panel `.tsx` sources) and the `@deepseek-ai/dsh-client-*` peer-stub workspace links were missing from `node_modules` (TS2307), which failed the build's final `bunx tsc` step and left the client bundle absent. The typecheck gate is green again; `dsh --profile web` boots with the plugin's `/plugins/@mstar-harness/dsh/client.js` registered and served.

<!-- CN -->
- **dsh 插件**：修复 `@mstar-harness/dsh` 构建门禁——完整构建现可产出 web 客户端 bundle（`dist/client.js`）。根因：`tsconfig.json` 的 `types` 缺少 `react`（TS7026：面板 `.tsx` 源码无 `JSX.IntrinsicElements`），且 `@deepseek-ai/dsh-client-*` peer-stub workspace 链接缺失（TS2307），导致构建末尾的 `bunx tsc` 失败、客户端 bundle 缺失。类型检查门禁已恢复绿色；`dsh --profile web` 正常启动，插件 `/plugins/@mstar-harness/dsh/client.js` 已注册并可服务。
