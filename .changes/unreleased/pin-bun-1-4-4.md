---
category: Changed
packages: root
---

- **Every workflow and the root manifest pin bun 1.4.4, the interpreter developers run.** CI pinned 1.4.0 while `package.json` still declared `bun@1.4.0` and local checkouts ran 1.4.4, so generated bundles and a few engine suites behaved differently in CI than on the machine reviewing them. One version now: `setup-bun` in `ci.yml`, `plugin-scanner.yml`, `release-prep.yml` and `release.yml`, plus `packageManager`. The committed hook bundles are unchanged — `release:prepare` re-takes them, and CI never compares their bytes.
- **The dashboard bundle test asserts the mount point, not the minified binding name.** The newer bundler renames `createRoot`, so the entry is proved by the `getElementById` mount query and React's `react.element` symbol, both stable across the two minifiers.
- **The CLI build runs the dashboard generator once.** `packages/commands` now owns that step for its own build, so `packages/cli`'s build chain no longer calls it a second time; `typecheck:src` keeps its call because it does not build the commands package.

<!-- CN -->
- **所有 workflow 与根清单统一 pin bun 1.4.4，即开发者实际运行的解释器。** 此前 CI pin 1.4.0、`package.json` 声明 `bun@1.4.0`，而本地检出运行 1.4.4，导致生成产物与部分引擎套件在 CI 与评审机器上表现不一致。现在只有一个版本：`ci.yml`、`plugin-scanner.yml`、`release-prep.yml`、`release.yml` 中的 `setup-bun` 与 `packageManager`。已提交的 hook bundle 不变 —— 由 `release:prepare` 重取，CI 从不比较其字节。
- **dashboard bundle 测试断言挂载点，而不是被压缩改名的绑定。** 新版 bundler 会把 `createRoot` 改名，因此入口改由 `getElementById` 挂载查询与 React 的 `react.element` 符号证明，两者在两个 minifier 下都稳定。
- **CLI 构建只生成一次 dashboard。** 该步骤现由 `packages/commands` 在自身构建中负责，`packages/cli` 的构建链不再重复调用；`typecheck:src` 仍保留调用，因为它不构建 commands 包。
