---
category: Changed
packages: omp
---

- Removed the dead omp validator tool sources (`src/tools/`: `mstar_iteration_gate`, `mstar_worktree_check`, `mstar_status_validate`, `mstar_lease_verify`, `mstar_path_resolve`, `mstar_dispatch_validate`). The build stopped compiling and shipping them when the MCP stdio server moved into the CLI; the same capabilities are served by `npx @mstar-harness/cli mcp` through the packaged `mcp.json` (`iteration.gate`, `worktree.check`, `status.validate`, `lease.verify`, `path.resolve`, `dispatch.validate`). Deleted the omp-side test arms that pinned them (`execution-read` validator suite, `worktree-check`, the `store-cutover` tool route, the bundle-smoke custom-tool probe) and the cross-package arms in `packages/cli/test/tools-v2-smoke.test.ts`; the omp `tool_call` pre-hook coverage is unchanged.

<!-- CN -->
- 移除 omp 校验器工具的死源码（`src/tools/`：`mstar_iteration_gate`、`mstar_worktree_check`、`mstar_status_validate`、`mstar_lease_verify`、`mstar_path_resolve`、`mstar_dispatch_validate`）。自 MCP stdio 服务器并入 CLI 起，构建不再编译和发布它们；同等能力由 `npx @mstar-harness/cli mcp` 经包内 `mcp.json` 提供（`iteration.gate`、`worktree.check`、`status.validate`、`lease.verify`、`path.resolve`、`dispatch.validate`）。同步删除钉住这些工具的 omp 侧测试臂（`execution-read` 校验器套件、`worktree-check`、`store-cutover` 的工具路由、bundle-smoke 的 custom-tool 探针）以及 `packages/cli/test/tools-v2-smoke.test.ts` 中的跨包测试臂；omp `tool_call` pre-hook 覆盖不变。
