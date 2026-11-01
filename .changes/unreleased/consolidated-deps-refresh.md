---
category: Harness
packages: root
---

- **Consolidated dependency refresh.** Six pending updates land together: `@opencode-ai/plugin` 1.4.8 → 1.19.5,
  `@opencode/plugin` and `@opencode/schema` 2.1.3 → 2.2.1, `effect` 4.0.1 → 4.1.0, `@modelcontextprotocol/client`
  2.3.1 → 2.4.0, the dev-dependency group (`@oh-my-pi/pi-coding-agent` 18.13.3, `@types/node` 26.6.6,
  `@tanstack/react-virtual` 3.14.23, `katex` 0.19.1, `simple-icons` 16.36.0), and the pinned
  `ai-plugin-scanner-action` commit. `bun.lock` is regenerated from `main`; no other dependency moves.
- The `dsh-llm-fallbacks` cohort moves as one: `packages/dsh` now lists 0.6.13 **and** the CLI's
  `mstar.dshLlmFallbacks` pin follows it, so `mstar init --target dsh` installs 0.6.13 instead of pinning the
  previous release beside a newer plugin dependency.

<!-- CN -->
- **合并依赖刷新。** 六项待处理更新一次性落地：`@opencode-ai/plugin` 1.4.8 → 1.19.5、`@opencode/plugin` 与
  `@opencode/schema` 2.1.3 → 2.2.1、`effect` 4.0.1 → 4.1.0、`@modelcontextprotocol/client` 2.3.1 → 2.4.0、
  开发依赖组（`@oh-my-pi/pi-coding-agent` 18.13.3、`@types/node` 26.6.6、`@tanstack/react-virtual` 3.14.23、
  `katex` 0.19.1、`simple-icons` 16.36.0），以及 `ai-plugin-scanner-action` 的提交钉。`bun.lock` 基于 `main`
  重新生成，其余依赖不动。
- `dsh-llm-fallbacks` 同组齐动：`packages/dsh` 升到 0.6.13 的同时，CLI 的 `mstar.dshLlmFallbacks` 钉一并跟随，
  因此 `mstar init --target dsh` 安装的是 0.6.13，不再出现插件依赖已升级、安装钉仍指向旧版的情况。
