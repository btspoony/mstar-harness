---
category: Fixed
packages: engine
---

- **The engine dist no longer carries a CommonJS interop shim.** `dist/engine.js` shipped `var __require = createRequire(import.meta.url)` plus `__commonJS(…)` wrappers around `debug@4` (reached from `micromark`), whose `require("tty")`/`require("util")` ran while the module graph initialized — a runtime without `import.meta.url` (workerd) failed at startup, so a Worker importing the engine could not deploy at all. The engine build now resolves `debug` to an engine-owned ESM module and the engine acquires `node:sqlite` through a lazy, function-scoped `require`, so neither artifact evaluates a Node require at module scope (#491).
- **`bun run --cwd packages/engine build` asserts the invariant.** The build fails on any `__require(`/`__commonJS(` call or on a `createRequire(import.meta.url)` that is not immediately invoked, instead of shipping a reintroduced shim; the guard runs in CI before the engine tests, which is the same step every consumer build already depends on.

<!-- CN -->
- **engine 产物不再携带 CommonJS interop 垫片。** `dist/engine.js` 曾带 `var __require = createRequire(import.meta.url)` 以及包裹 `debug@4`（经 `micromark` 引入）的 `__commonJS(…)`，其中的 `require("tty")`/`require("util")` 在模块图初始化时即执行——在没有 `import.meta.url` 的运行时（workerd）启动即失败，导入该 engine 的 Worker 完全无法部署。engine 构建现在把 `debug` 解析为 engine 自有的 ESM 模块，并用惰性、函数作用域的 `require` 获取 `node:sqlite`，因此两个产物都不再在模块作用域执行 Node require（#491）。
- **`bun run --cwd packages/engine build` 会断言该不变量。** 构建在出现任何 `__require(`/`__commonJS(` 调用，或出现未被立即调用的 `createRequire(import.meta.url)` 时失败，而不是把重新引入的垫片发出去；该守卫在 CI 中先于 engine 测试运行，即所有消费方构建本就依赖的那一步。

