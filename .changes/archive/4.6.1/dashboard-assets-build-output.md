---
category: Fixed
packages: root, commands
---

- **The dashboard asset module is a gitignored build output again.** `packages/commands/src/dashboard/assets.generated.ts` was tracked even though its bytes depend on the bundler version, so any local `cli:build` or `typecheck:src` on a bun other than the pinned 1.4.0 left a 430 KB generated diff in `git status`. Nothing names that path from a host config — it is inlined into the CLI bundle — so tracking it bought nothing and cost every local build a dirty tree. `packages/commands` now regenerates it in its own `build` and `test` scripts before compiling, so a fresh checkout and every CI job that builds that package still get the module; the repository `.gitignore` names it.
- **The committed-bundle record now states the boundary it was missing.** Only `hooks/*.mjs` are tracked bundles, because a host config references those paths inside the checkout; a generated module with no such reference stays a build output.

<!-- CN -->
- **dashboard 资源模块重新成为被 gitignore 的构建产物。** `packages/commands/src/dashboard/assets.generated.ts` 曾被跟踪，但其字节随 bundler 版本变化，因此任何在非 pinned 1.4.0 的 bun 上执行的本地 `cli:build` 或 `typecheck:src` 都会在 `git status` 里留下 430 KB 的生成差异。没有任何宿主配置按路径引用它（它被内联进 CLI 产物），跟踪它没有收益，只让每次本地构建都脏。现在 `packages/commands` 在自己的 `build` 与 `test` 脚本里先生成该模块再编译，因此全新检出与每一个构建该包的 CI 任务仍能拿到它；仓库 `.gitignore` 已列出该路径。
- **committed bundle 记录补上了缺失的边界。** 只有 `hooks/*.mjs` 是被跟踪的 bundle，因为宿主配置在 checkout 内按路径引用它们；没有这类引用的生成模块属于构建产物。
