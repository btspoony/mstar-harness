---
packages: cli, commands
---

- **`harness.scaffold` resolves from the invocation workspace and the pinned harness root.** The handler no longer defaults its root from `process.cwd()`: it uses the `InvocationContext` cwd (an explicit `path` still wins and is resolved against that cwd). Under `mstar mcp --harness <absolute path>`, an omitted `path` scaffolds that exact pinned harness dir verbatim — custom root names included, and ahead of `MSTAR_HARNESS_DIR` or a workspace `.mstarc` — instead of re-discovering a root under `dirname(harnessRoot)`, so a launch checkout and its `.gitignore` are left untouched. Regressions drive two workspaces through the production MCP assembly.

<!-- CN -->
- **`harness.scaffold` 改为从 invocation 工作区与 pin 住的 harness 根解析。** handler 不再把 `process.cwd()` 当作默认根：改用 `InvocationContext` 的 cwd（显式 `path` 仍优先，并以该 cwd 解析）。在 `mstar mcp --harness <绝对路径>` 下，省略 `path` 时原样 scaffold 该 pin 住的 harness 目录——支持自定义根名，且优先于 `MSTAR_HARNESS_DIR` 或工作区的 `.mstarc`——不再在 `dirname(harnessRoot)` 下重新发现根，因此启动检出及其 `.gitignore` 保持不变。回归经生产装配覆盖两个工作区。
