---
category: Harness
packages: root
---

- **MCP health checks host configs, not per-host bundles.** `mstar doctor` MCP inspection now validates each host's real MCP configuration file and its `npx @mstar-harness/cli mcp` launch entry (server entry resolved from `command`/`args` arrays), replacing the retired `build-info.json`/`stdio.js` bundle probes. `session.recover` reads the main-conversation session identity from `MSTAR_HOST_SESSION_ID` when invoked over the MCP stdio transport, and `evidence.verify` reports a failed assessment as `ok` data with an `assessmentPassed` flag instead of a `refused` envelope.
- **Injected stores keep the engine control-target guard.** `--store` / `MSTAR_STORE_MODULE` store modules now pass through the engine's `guardInjectedStore` wrapper (exported from `@mstar-harness/engine`), so control documents stay unreachable through an injected adapter while an execution authority is active. `resolveStore` also honors `MSTAR_STORE_MODULE` again, and usage errors are emitted as envelope JSON on stdout with commander's native stderr noise suppressed.

<!-- CN -->
- **MCP 健康检查改为校验宿主真实配置。** `mstar doctor` 的 MCP 检查现在验证各宿主实际的 MCP 配置文件及其 `npx @mstar-harness/cli mcp` 启动项（从 `command`/`args` 数组解析服务条目），取代已删除的 `build-info.json`/`stdio.js` bundle 探测。MCP stdio 传输下 `session.recover` 从 `MSTAR_HOST_SESSION_ID` 读取主会话身份；`evidence.verify` 对不合格证据改为返回 `ok` 数据并附 `assessmentPassed` 标记，而非 `refused` envelope。
- **注入 store 保持引擎控制目标防护。** `--store` / `MSTAR_STORE_MODULE` 指定的 store 模块现在统一经过引擎导出的 `guardInjectedStore` 包装：在执行权威处于活动状态时，控制文档仍无法通过注入适配器读写。`resolveStore` 恢复读取 `MSTAR_STORE_MODULE`；usage 错误统一以 envelope JSON 输出到 stdout，并抑制 commander 原生 stderr 噪声。
