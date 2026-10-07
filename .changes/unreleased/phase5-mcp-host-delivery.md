---
category: Changed
packages: root, commands, cli, opencode, dsh, omp
---

- Corrected package release surfaces, hosted-install dependency specs, CLI option decoding, installed-host MCP doctor paths, request-scoped store selection, child stdin policy, and dashboard lifecycle cleanup; aligned CI consumers with the canonical command definitions.
- Integrated the stdio MCP server into `@mstar-harness/cli` as `mstar mcp`; host configs now launch `npx @mstar-harness/cli mcp`. The standalone MCP package, per-host bundles, and native bridges are removed.
- **MCP health checks host configs, not per-host bundles.** `mstar doctor` MCP inspection now validates each host's real MCP configuration file and its `npx @mstar-harness/cli mcp` launch entry (server entry resolved from `command`/`args` arrays), replacing the retired `build-info.json`/`stdio.js` bundle probes, and refuses runtimes below each packaged target's native floor. `evidence.verify` reports a failed assessment as `ok` data with an `assessmentPassed` flag instead of a `refused` envelope.
- **DSH gains its Cordis MCP client row.** The shipped dsh bundle patch inserts an `mstar-mcp` row (`@deepseek-ai/dsh-mcp-client`, stdio `npx @mstar-harness/cli mcp`, server name `mstar`) next to the plugin row; `mstar-harness doctor --target dsh` parses the profile's Cordis sources structurally (comment-proof) and reports aligned only with the bridge plugin installed. `spawnProcess` normalizes ENOENT to a deterministic `executable not found in $PATH` error, and relative dev-command args resolve against `MSTAR_CLI_PROJECT_ROOT`.
- Documented CLI-based MCP launch paths for the six JSON-backed hosts and OpenCode's plugin-injected config, plus the DSH Cordis YAML follow-up; recorded runtime prerequisites, doctor status meanings, host/session boundaries, and separate installed-host verification.
- Recorded the OpenCode V1 `@opencode-ai/plugin` 1.4.8 pin and removal of the global CLI fallback.

<!-- CN -->
- 修正包发布面、托管安装依赖规格、CLI 选项类型解码、宿主已安装 MCP doctor 路径、请求级 store 选择、子进程 stdin 策略与 dashboard 生命周期清理；CI 命令清单改为读取规范命令定义。
- 将 stdio MCP server 整合进 `@mstar-harness/cli`，以 `mstar mcp` 启动；宿主配置改为运行 `npx @mstar-harness/cli mcp`，并移除独立 MCP 包、宿主专属 bundles 和原生桥接。
- **MCP 健康检查改为校验宿主真实配置。** `mstar doctor` 的 MCP 检查现在验证各宿主实际的 MCP 配置文件及其 `npx @mstar-harness/cli mcp` 启动项（从 `command`/`args` 数组解析服务条目），取代已删除的 `build-info.json`/`stdio.js` bundle 探测，并拒绝低于各打包目标原生最低版本的运行时。`evidence.verify` 对不合格证据改为返回 `ok` 数据并附 `assessmentPassed` 标记，而非 `refused` envelope。
- **DSH 获得 Cordis MCP client 行。** dsh bundle patch 在插件行旁插入 `mstar-mcp` 行（`@deepseek-ai/dsh-mcp-client`，stdio `npx @mstar-harness/cli mcp`，serverName `mstar`）；`mstar-harness doctor --target dsh` 结构化解析 profile 的 Cordis 源（不受注释干扰），仅在桥接插件已安装时报 aligned。`spawnProcess` 将 ENOENT 规范为确定性的 `executable not found in $PATH` 错误；dev 命令相对路径参数按 `MSTAR_CLI_PROJECT_ROOT` 解析。
- 补充六个 JSON 宿主与 OpenCode 插件动态配置的 CLI MCP 启动路径，并记录 DSH Cordis YAML 后续接入；说明运行时前置条件、doctor 状态含义、host/session 边界及独立的已安装宿主验证边界。
- 记录 OpenCode V1 `@opencode-ai/plugin` 1.4.8 pin，并说明已移除全局 CLI 回退。
