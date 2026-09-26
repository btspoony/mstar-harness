---
category: Harness
packages: root, cli, commands
---

- **CLI command surface**: non-installer commands are now generated from the canonical `@mstar-harness/commands` definitions. `mstar init` remains the installer. Parser failures return a version-1 usage envelope and exit 2; command outcomes keep their documented exit codes, including SDD task 3 and child 124/127/128+n.
- **Runtime session selectors and generated bundle**: `plan.bind` uses runtime invocation identity instead of a request field, declared CLI session selectors reach the handler context, and `packages/commands/dist` is generated locally rather than tracked.

<!-- CN -->
- **CLI 命令面**：除安装器以外的命令现由规范的 `@mstar-harness/commands` 定义生成。`mstar init` 仍是安装器。解析失败返回 version-1 用法信封并退出 2；命令结果保留已记录的退出码，包括 SDD task 的 3 以及子进程的 124/127/128+n。
- **运行时会话选择器与生成包**：`plan.bind` 使用调用上下文运行时身份而非请求字段，CLI 声明的会话选择器会传递至处理器上下文，`packages/commands/dist` 由本地构建生成而不再跟踪。
