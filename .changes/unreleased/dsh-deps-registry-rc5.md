---
packages: root
---

- **dsh plugin**: dev-time `@deepseek-ai/dsh-*` seam resolution switched from the local **link farm** to the **npm registry** at `0.0.1-rc.5` (bun auto-installs peers via the monorepo-root `.npmrc` `${NPM_TOKEN}`). Removed `scripts/setup-dsh-links.ts` + `dsh:link`/`dsh:link:check` (`prepare` is now build-only); dropped `peerDependenciesMeta.optional` (the old skip-unpublished-peers workaround) and completed the peer set — `dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-conversation`/`dsh-client-ui-slots`/`dsh-invariants`/`dsh-jobs` joined the existing peers (all `^0.0.1-rc.5`); added `keywords: ["dsh", "dsh-plugin"]` and `tests/peer-deps.spec.ts` (registry peer contract, peers-not-optional regression).

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` 各 seam 的开发期解析从本地 **link farm** 切到 **npm registry** `0.0.1-rc.5`（bun 凭 monorepo 根 `.npmrc` 的 `${NPM_TOKEN}` 自动安装 peer）。删除 `scripts/setup-dsh-links.ts` 与 `dsh:link`/`dsh:link:check`（`prepare` 现为纯 build）；移除 `peerDependenciesMeta.optional`（旧的跳过未发布 peer 的 workaround）并补全 peer 集合——`dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-conversation`/`dsh-client-ui-slots`/`dsh-invariants`/`dsh-jobs` 加入既有 peer（全部 `^0.0.1-rc.5`）；新增 `keywords: ["dsh", "dsh-plugin"]` 与 `tests/peer-deps.spec.ts`（registry peer 契约 + peer 不得标 optional 的回归断言）。
