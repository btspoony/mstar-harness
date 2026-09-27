---
category: Changed
packages: root, commands, cli, opencode, dsh, omp
---

- Corrected package release surfaces, hosted-install dependency specs, CLI option decoding, installed-host MCP doctor paths, request-scoped store selection, child stdin policy, and dashboard lifecycle cleanup; aligned CI consumers with the canonical command definitions.
- Integrated the stdio MCP server into `@mstar-harness/cli` as `mstar mcp`; host configs now launch `npx @mstar-harness/cli mcp`. The standalone MCP package, per-host bundles, and native bridges are removed.

<!-- CN -->
- 修正包发布面、托管安装依赖规格、CLI 选项类型解码、宿主已安装 MCP doctor 路径、请求级 store 选择、子进程 stdin 策略与 dashboard 生命周期清理；CI 命令清单改为读取规范命令定义。
- 将 stdio MCP server 整合进 `@mstar-harness/cli`，以 `mstar mcp` 启动；宿主配置改为运行 `npx @mstar-harness/cli mcp`，并移除独立 MCP 包、宿主专属 bundles 和原生桥接。
