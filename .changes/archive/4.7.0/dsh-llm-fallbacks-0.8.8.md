---
packages: dsh, cli
---

- **`dsh-llm-fallbacks` pin raised to `0.8.8`, the first release on the `^0.2.2-rc.3` peer corridor.** Both hand-written literals move together as the recorded dependency-boundary rule requires: `@mstar-harness/dsh` devDependency `0.8.6` → `0.8.8` and the CLI install-spec constant `mstar.dshLlmFallbacks` `0.8.2` → `0.8.8` (that literal had drifted a minor behind the package pin). Nothing upgrades an installed host: `doctor --target dsh` reports the older fallbacks row `drifted` until `init --target dsh` re-adds the pinned spec.
- **Audited, not assumed.** `dist/index.d.ts` and `dist/seeds.d.ts` are byte-identical between `0.8.6` and `0.8.8`, so the consumed `FallbacksService` surface and the seed/effective-role types are unchanged and the local structural mirror needs no edit. The cross-version differences are the peer corridor itself (`^0.2.2-rc.1` → `^0.2.2-rc.3`), implementation-side error wrapping, and `dist/subagents-seam.d.ts`, which now reads the flattened `SubagentActivationSpec` (rc.3 extends the start request instead of nesting it). That seam is internal to the plugin: `packages/dsh/src` imports nothing from the package, so no mstar code path changes.
- Workspace verification: the seven `fallbacks-*` / `peer-deps` suites 60 pass with zero skips, and both type gates (`typecheck:src`, `typecheck:tests`) exit clean.

<!-- CN -->
- **`dsh-llm-fallbacks` 固定版本升至 `0.8.8`——首个落在 `^0.2.2-rc.3` peer 走廊上的发布。** 两处手写字面量按已记录的依赖边界规则同组移动：`@mstar-harness/dsh` 开发依赖 `0.8.6` → `0.8.8`，CLI 安装 spec 常量 `mstar.dshLlmFallbacks` `0.8.2` → `0.8.8`（该字面量此前已落后包 pin 一个小版本）。本次不升级任何已安装宿主：在 `init --target dsh` 按新 pin 重新 add 之前，`doctor --target dsh` 会把旧的 fallbacks 行报为 `drifted`。
- **审计结论，而非假设。** `0.8.6` 与 `0.8.8` 的 `dist/index.d.ts`、`dist/seeds.d.ts` 逐字节相同，故被消费的 `FallbacksService` 服务面与 seed/effective-role 类型未变，本地结构镜像无需改动。两版的实质差异是 peer 走廊（`^0.2.2-rc.1` → `^0.2.2-rc.3`）、实现侧的错误包装，以及 `dist/subagents-seam.d.ts`——后者改为读取扁平化的 `SubagentActivationSpec`（rc.3 让 activation spec 直接扩展 start request，而不再嵌套）。该 seam 属插件内部：`packages/dsh/src` 不从该包导入任何东西，因此 mstar 侧零代码路径变化。
- 工作区验证：`fallbacks-*` / `peer-deps` 共七个套件 60 项全通过、零跳过；两个类型门禁（`typecheck:src`、`typecheck:tests`）干净退出。
