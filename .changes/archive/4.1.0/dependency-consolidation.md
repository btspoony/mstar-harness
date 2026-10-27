---
category: Harness
packages: root
---

- Consolidated three dependency-upgrade cohorts into one maintained change: the development-dependency group (`@oh-my-pi/pi-coding-agent` 18.12.6, `bun-types` 1.4.4, `@tanstack/react-virtual` 3.14.22, `dsh-llm-fallbacks` 0.6.8, `immer` 11.2.9), the OpenCode V2 SDK cohort (`@opencode/plugin` / `@opencode/schema` 2.1.3 with `effect` 4.0.1), and **react 19** (`react` / `react-dom` 19.3.1 with `@types/react` / `@types/react-dom` 19.3.0) in `packages/cli`, `packages/dsh` and `packages/ui`.
- Aligned `packages/cli/package.json` → `mstar.dshLlmFallbacks` with the installed `dsh-llm-fallbacks` version, so the CLI install spec and the pinned re-add resolve to the same release.
- Removed dependency-version pinning from the test suite: the fallbacks probe now asserts the consumed `llm-fallbacks` **service surface** (member presence + shape) instead of the installed package version, which reddened on every routine bump while proving nothing about the members mstar calls. Pin-vs-installed drift stays covered by `dshFallbacksVersion()` and the install/doctor drift rows.

<!-- CN -->
- 将三组依赖升级合并为一次维护性改动：开发依赖组（`@oh-my-pi/pi-coding-agent` 18.12.6、`bun-types` 1.4.4、`@tanstack/react-virtual` 3.14.22、`dsh-llm-fallbacks` 0.6.8、`immer` 11.2.9）、OpenCode V2 SDK 组（`@opencode/plugin` / `@opencode/schema` 2.1.3 与 `effect` 4.0.1），以及 **react 19**（`packages/cli`、`packages/dsh`、`packages/ui` 中的 `react` / `react-dom` 19.3.1 与 `@types/react` / `@types/react-dom` 19.3.0）。
- 对齐 `packages/cli/package.json` 的 `mstar.dshLlmFallbacks` 与实际安装的 `dsh-llm-fallbacks` 版本，使 CLI 安装 spec 与固定重装落到同一发布版本。
- 移除测试套件对依赖版本的钉死：fallbacks 探针改为断言所消费的 `llm-fallbacks` **服务表面**（成员存在性与形态），而不是已安装包版本——后者在每次常规升级时都会变红，却无法证明 mstar 实际调用的成员仍然存在。钉版本与实装的漂移仍由 `dshFallbacksVersion()` 与 install/doctor 漂移行覆盖。
