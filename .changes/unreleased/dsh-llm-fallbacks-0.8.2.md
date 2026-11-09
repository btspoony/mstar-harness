---
packages: dsh
---

- **`dsh-llm-fallbacks` `0.7.0` → `0.8.2`** in the `@mstar-harness/dsh` devDependency and in the CLI install pin (`mstar.dshLlmFallbacks`), which `mstar init --target dsh` installs and `doctor` compares against; both pins move together and `bun.lock` resolves `dsh-llm-fallbacks@0.8.2` (its peers are the already-declared `^0.2.2-rc.1` corridor).
- **0.8.0 replaces the two-block config with named virtual chains.** Role rows keep identity plus an optional `chain` pointer; `fallback`, `roles.rules`, `roles.default` and the v1 `rootChain`/top-level `timeSlots` keys are removed (v1 configs upgrade in memory at read), and the `llm-fallbacks` service no longer exposes `resolveRole`. The adapter's structural mirror and service-surface probe drop `resolveRole`, the `EffectiveRole` mirror follows the v2 shape (`chain?: string`, no `fallback`), the advisory's legacy-key message and the README's legacy-key list follow upstream's `detectLegacyKeys` set, and the installed-deployment spec reads the seed payload as `{ list }`.
- **The seeds write path moves to the 0.8.x settings contract.** Upstream now persists roles through `settings.mutate(ns, pathOps)` and reads the stored user section through `settings.describe()`; the real-fallbacks test harness's settings fake models that pair instead of the retired `update` patch-merge, so the installed-deployment e2e converges (13 mstar role seeds persisted).

<!-- CN -->
- **`dsh-llm-fallbacks` `0.7.0` → `0.8.2`**：`@mstar-harness/dsh` 开发依赖与 CLI 安装 pin（`mstar.dshLlmFallbacks`，即 `mstar init --target dsh` 安装、`doctor` 比对的那一版）同步变更；`bun.lock` 解析为 `dsh-llm-fallbacks@0.8.2`（其 peer 即已声明的 `^0.2.2-rc.1` 走廊）。
- **0.8.0 将两段式配置替换为命名虚拟链。** 角色行保留身份加可选 `chain` 指针；`fallback`、`roles.rules`、`roles.default` 与 v1 的 `rootChain`/顶层 `timeSlots` 键被移除（v1 配置在读取时内存升级），`llm-fallbacks` 服务不再暴露 `resolveRole`。适配器的结构镜像与服务面探测去掉 `resolveRole`，`EffectiveRole` 镜像跟进 v2 形态（`chain?: string`，无 `fallback`），采纳建议的遗留键文案与 README 的遗留键清单跟随上游 `detectLegacyKeys` 集合，安装端到端 spec 以 `{ list }` 读取种子载荷。
- **种子写入路径切换到 0.8.x settings 契约。** 上游现经 `settings.mutate(ns, pathOps)` 持久化角色、经 `settings.describe()` 读取已存 user 段；real-fallbacks 测试 harness 的 settings fake 改为模拟这对接口（此前是已退役的 `update` patch-merge），安装端到端 e2e 因此收敛（13 个 mstar 角色 seed 落盘）。
