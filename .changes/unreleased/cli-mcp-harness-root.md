---
packages: cli
---

- **`mstar mcp --harness <absolute path>` pins the control root.** When the mounting process names a root, every call uses that path verbatim as `resolved.controlRoot` instead of probing `process.cwd()`; without the flag the existing cwd probe is unchanged. A relative path is a usage refusal (exit 2) whose message names the absolute requirement. This lets one installed plugin serve many repositories without hard-coding a checkout. The flag also sets the **default** root for every registered command's own root selection, not only `controlRoot`, and an explicit per-call `harness` overrides it; the delivery mount contract launches the MCP server with it (see `packages/dsh/bundle/README.md`).

<!-- CN -->
- **`mstar mcp --harness <绝对路径>` 固定 control root。** 挂载进程给出根路径时，每次调用都原样使用它作为 `resolved.controlRoot`，不再探测 `process.cwd()`；未传该 flag 时既有 cwd 探测保持不变。相对路径是 usage 拒绝（exit 2），消息点名绝对路径要求。这样同一份已安装插件可以服务多个仓库，无需写死某个检出目录。该 flag 也为每个已注册命令自身的根选择设定**默认**根路径（不仅是 `controlRoot`），显式传入的 per-call `harness` 会覆盖它；交付侧的挂载契约即用它启动 MCP 服务器（见 `packages/dsh/bundle/README.md`）。
