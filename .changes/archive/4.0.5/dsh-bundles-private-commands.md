---
packages: dsh
---

- **The dsh artifact no longer peer-depends on the unpublished `@mstar-harness/commands`.** That package is `private` and the release workflow never publishes it, so an installed `@mstar-harness/dsh` resolved a peer that could not exist and the plugin failed at ESM instantiation — before `apply` ran, with no recovery route. It is now a build-time workspace `devDependency` that `bun build` inlines (the build script builds it first, as the CLI build already did); the only `@mstar-harness/*` peer left is the published `@mstar-harness/engine`. The bundled entry grows from 0.31 MB / 37 modules to 1.51 MB / 133 modules. Verified by packing the package and importing it in a clean project that has no mstar packages: `import('@mstar-harness/dsh')` returns its 28 exports with `@mstar-harness/commands` absent, and `packages/dsh/tests/peer-deps.spec.ts` now refuses a peer on any private workspace package.

<!-- CN -->
- **dsh 产物不再 peer 依赖未发布的 `@mstar-harness/commands`。** 该包为 `private`，Release workflow 从不发布它，因此安装后的 `@mstar-harness/dsh` 会去解析一个不可能存在的 peer，插件在 ESM 实例化阶段、`apply` 运行之前就失败，且没有恢复路径。它现为构建期 workspace `devDependency`，由 `bun build` 内联（构建脚本会先构建它，与 CLI 构建既有做法一致）；仅剩的 `@mstar-harness/*` peer 是已发布的 `@mstar-harness/engine`。打包后的入口从 0.31 MB / 37 个模块增至 1.51 MB / 133 个模块。验证方式：打包该包，并在没有任何 mstar 包的干净工程中导入——`import('@mstar-harness/dsh')` 返回 28 个导出且 `@mstar-harness/commands` 不存在；`packages/dsh/tests/peer-deps.spec.ts` 新增断言：peer 不得指向任何 private workspace 包。
