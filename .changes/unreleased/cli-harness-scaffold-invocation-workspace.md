---
packages: cli, commands
---

- **`harness.scaffold` resolves from the invocation workspace.** The handler no longer defaults its root from `process.cwd()`: it uses the `InvocationContext` cwd (an explicit `path` still wins and is resolved against that cwd). Under `mstar mcp --harness <absolute path>` — whose resolver anchors the invocation workspace at `dirname(harnessRoot)` — a scaffold targets the pinned workspace instead of the launch checkout, and a foreign checkout's `.gitignore` is left untouched. A regression drives two workspaces through the production MCP assembly.

<!-- CN -->
- **`harness.scaffold` 改为从 invocation 工作区解析根。** handler 不再把 `process.cwd()` 当作默认根：改用 `InvocationContext` 的 cwd（显式 `path` 仍优先，并以该 cwd 解析）。在 `mstar mcp --harness <绝对路径>` 下（其 resolver 把 invocation 工作区锚定到 `dirname(harnessRoot)`），scaffold 落在 pinned 工作区而非启动检出，外部检出的 `.gitignore` 保持不变。回归经生产装配覆盖两个工作区。
