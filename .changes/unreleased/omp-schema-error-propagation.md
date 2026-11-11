---
category: Changed
packages: omp
---

- **The model-handoff start surfaces a stale plugin bundle as its own cause.** Direction-lock's ACTIVE authority read collapsed every thrown store error into the generic `register-invalid` refusal, so a store migrated by a newer build of the plugin's bundled engine told the operator to upgrade the harness while the CLI, the plugin package and the engine source all reported one version. A `store.schema-unsupported`/`store.schema-drift` cause now keeps the engine's own code, carries `loadedEntry` (the module the host actually loaded) and appends the shared incompatible-loaded-build recovery: refresh the installed `@mstar-harness/omp` package, then start a NEW host process so the registration is loaded from it. Every other cause keeps the existing `register-invalid` refusal, and no binding or model action is recorded either way.

<!-- CN -->
- **model-handoff 的 start 现在会把过期的插件 bundle 作为原因直接指出。** 方向锁的 ACTIVE 权威读取原先把所有抛出的 store 错误压平成通用的 `register-invalid` 拒绝，因此当 store 已被更新构建的插件内置引擎迁移过时，操作者被告知去升级 harness，而 CLI、插件包与引擎源码报告的却是同一版本。`store.schema-unsupported`/`store.schema-drift` 原因现在保留引擎自身的错误码、携带 `loadedEntry`（宿主实际加载的模块），并追加共享的「不兼容已加载构建」恢复指引：刷新已安装的 `@mstar-harness/omp` 包，然后启动一个**新的**宿主进程以从该包加载注册。其余原因仍保持既有的 `register-invalid` 拒绝；两种情况下都不会写入绑定或执行模型动作。
