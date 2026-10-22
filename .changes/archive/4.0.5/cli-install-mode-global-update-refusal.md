---
packages: cli
---

- **Install-mode `init` refuses a failed newer-version global update.** When a newer published CLI was chosen and the global install failed, `init` now ends with the refusal and its recovery route for every install-mode target — including the adapters that install their plugin through the host's own CLI/TUI and ignore `initFlags`, where no plugin version is ever known. Previously only that case printed the failure and exited 0, leaving the CLI on PATH at the running version while the run reported success.

<!-- CN -->
- **安装模式的 `init` 在较新版本全局更新失败时改为拒绝。** 当选中了更新的已发布 CLI 而全局安装失败时，`init` 现在对所有安装模式 target 都以该拒绝及其恢复路径结束——包括通过宿主自身 CLI/TUI 安装插件、忽略 `initFlags` 的适配器（它们从不报告插件版本）。此前只有这种情形会打印失败并以 0 退出，PATH 上的 CLI 仍是运行中的版本，而这次运行却报告成功。
