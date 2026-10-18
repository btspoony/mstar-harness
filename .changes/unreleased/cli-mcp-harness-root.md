---
packages: cli
---

- **`mstar mcp --harness <absolute path>` pins the control root.** When the mounting process names a root, every call uses that path verbatim as `resolved.controlRoot` instead of probing `process.cwd()`; without the flag the existing cwd probe is unchanged. A relative path is a usage refusal (exit 2) whose message names the absolute requirement. This lets one installed plugin serve many repositories without hard-coding a checkout. The flag also sets the **server-owned default** root for every registered command's own root selection, not only `controlRoot`; a command that declares a per-call `harness` accepts an explicit override, while the `persist` family always uses the invocation's server root (the pin, or the cwd probe when unpinned) and takes no per-call harness; the delivery mount contract launches the MCP server with it (see `packages/dsh/bundle/README.md`).

<!-- CN -->
- **`mstar mcp --harness <绝对路径>` 固定 control root。** 挂载进程给出根路径时，每次调用都原样使用它作为 `resolved.controlRoot`，不再探测 `process.cwd()`；未传该 flag 时既有 cwd 探测保持不变。相对路径是 usage 拒绝（exit 2），消息点名绝对路径要求。这样同一份已安装插件可以服务多个仓库，无需写死某个检出目录。该 flag 也为每个已注册命令自身的根选择设定**服务器自有的默认**根路径（不仅是 `controlRoot`）；声明了 per-call `harness` 的命令接受显式覆盖，而 `persist` 命令族始终使用本次调用的服务器根（pin，未 pin 时为 cwd 探测），不接受 per-call harness；交付侧的挂载契约即用它启动 MCP 服务器（见 `packages/dsh/bundle/README.md`）。
