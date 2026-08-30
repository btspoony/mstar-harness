---
category: dsh
packages: dsh
---

- Bump `@deepseek-ai/dsh-*` host peers to `^0.1.2-alpha.2` and migrate the client half off the removed `dsh-client-runtime` onto `dsh-client-store` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` / `dsh-client-ui-chat` (alpha.2 Remote/store seams). Drop `host-apiproxy` from the client-bundle INLINE_SAFE allowlist. Badge `0.1.2-alpha.2`.
- Bump `dsh-llm-fallbacks` to `^0.4.0-alpha.1`: its 25 peers re-anchor to `^0.1.2-alpha.2` (and `dsh-client-runtime` is dropped upstream), so the lock collapses to a single `0.1.2-alpha.2` dsh line.
- Demote `dsh-llm-fallbacks` to a dev-time-only dependency: dsh `0.1.2-alpha.2` natively covers subagent customization, so the fallbacks capability is strictly optional. `src/` carries zero imports of the package (runtime and type — the consumed surface is mirrored by local structural types kept in sync by the probe's exact-keys gate), `package.json` keeps it only under `devDependencies`, and `dist/` carries no import and no type reference. The activation contract is unchanged (separate second-command install).
- Refresh `@deepseek-ai/cordis` to `4.0.2` in the lock (host peers `^4.0.2`; the stale `4.0.1` pin predated the alpha.2 graph).

<!-- CN -->
- 将 `@deepseek-ai/dsh-*` host peer 升到 `^0.1.2-alpha.2`，客户端 half 从已移除的 `dsh-client-runtime` 迁到 `dsh-client-store` / `dsh-client-ui-conversation` / `dsh-client-ui-renderer` / `dsh-client-ui-chat`（alpha.2 Remote/store 缝）。客户端 bundle INLINE_SAFE 去掉 `host-apiproxy`。badge 更新为 `0.1.2-alpha.2`。
- 升级 `dsh-llm-fallbacks` 至 `^0.4.0-alpha.1`：其 25 个 peer 重新锚定到 `^0.1.2-alpha.2`（上游同时移除 `dsh-client-runtime`），lock 收敛为单一 `0.1.2-alpha.2` dsh 线。
- 将 `dsh-llm-fallbacks` 降级为开发期依赖：dsh `0.1.2-alpha.2` 原生覆盖 subagent 定制，fallbacks 能力因此严格可选。`src/` 对该包零导入（运行时与类型——被消费面由本地结构类型镜像，经探测的 exact-keys 闸门保持同步），`package.json` 仅在 `devDependencies` 携带它，`dist/` 无导入也无类型引用。激活契约不变（独立的第二条命令安装）。
- lock 中 `@deepseek-ai/cordis` 刷新到 `4.0.2`（host peer 为 `^4.0.2`；陈旧的 `4.0.1` 钉定早于 alpha.2 图）。
