---
packages: cli
---

- **`mstar mcp --harness <absolute path>` pins the control root.** When the mounting process names a root, every call uses that path verbatim as `resolved.controlRoot` instead of probing `process.cwd()`; without the flag the existing cwd probe is unchanged. A relative path is a usage refusal (exit 2) whose message names the absolute requirement. This lets one installed plugin serve many repositories without hard-coding a checkout.

<!-- CN -->
- **`mstar mcp --harness <绝对路径>` 固定 control root。** 挂载进程给出根路径时，每次调用都原样使用它作为 `resolved.controlRoot`，不再探测 `process.cwd()`；未传该 flag 时既有 cwd 探测保持不变。相对路径是 usage 拒绝（exit 2），消息点名绝对路径要求。这样同一份已安装插件可以服务多个仓库，无需写死某个检出目录。
