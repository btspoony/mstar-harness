---
category: Documentation
packages: cli
---

- **The persist suite states its engine-build ordering requirement.** `packages/cli/AGENTS.md` now documents the package test flow (`bun run test`: engine build, package build, `bun test`) and that no suite may run beside a concurrent `bun run --cwd packages/engine build`, because the suites resolve `@mstar-harness/engine` through `packages/engine/dist` while that build starts with `rm -rf dist`. `packages/cli/test/persist.test.ts` repeats the requirement in its header, so the file explains its own precondition instead of depending on a rebuild that nothing near it mentioned. No assertion and no build step changed.

<!-- CN -->
- **persist 套件写明其 engine 构建顺序前提。** `packages/cli/AGENTS.md` 现记录包测试流程（`bun run test`：engine 构建、本包构建、`bun test`），以及任何套件都不得与 `bun run --cwd packages/engine build` 并发运行——各套件经 `packages/engine/dist` 解析 `@mstar-harness/engine`，而该构建首步即 `rm -rf dist`。`packages/cli/test/persist.test.ts` 在文件头重申该前提，使文件自述运行条件，而不是依赖附近没有任何说明的重建。断言与构建步骤均未改变。
