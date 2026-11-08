---
packages: dsh
---

- Raised `dsh-llm-fallbacks` from `0.6.13` to `0.7.0` in the dsh plugin devDependency and in the CLI install pin (`mstar.dshLlmFallbacks` in `packages/cli/package.json`), which `mstar init --target dsh` installs and doctor compares against; both pins move together and `bun.lock` resolves `dsh-llm-fallbacks@0.7.0`.
- 0.7.0 rewrites upstream routing — only the virtual `FallbacksChain/Auto` adapter is a fallback path, the `agent/request` / `agent/request-error` listeners are gone, and the `automatch` / `override` / `authorized-route` modules are removed. That rewrite is external to this repo.
- The consumed surface is unchanged: every `FallbacksService` member, `presetRoles`, and the seed types the plugin mirrors still resolve, so no source or mirror adaptation was needed — the fallbacks specs and the dsh install end-to-end spec pass against 0.7.0 unchanged.

<!-- CN -->
- 将 dsh 插件 devDependency 与 CLI 安装 pin（`packages/cli/package.json` 的 `mstar.dshLlmFallbacks`，即 `mstar init --target dsh` 安装、doctor 比对的那一版）从 `0.6.13` 提升到 `0.7.0`；两处 pin 同步变更，`bun.lock` 解析为 `dsh-llm-fallbacks@0.7.0`。
- 0.7.0 重写了上游路由 —— 只有虚拟的 `FallbacksChain/Auto` 适配器属于回退路径，`agent/request` / `agent/request-error` 监听器已移除，`automatch` / `override` / `authorized-route` 模块已删除；该重写在本仓库之外。
- 被消费的接口未变：插件镜像的每个 `FallbacksService` 成员、`presetRoles` 与种子类型仍可解析，因此无需改动源码或镜像 —— fallbacks 各 spec 与 dsh 安装端到端 spec 在 0.7.0 下原样通过。
