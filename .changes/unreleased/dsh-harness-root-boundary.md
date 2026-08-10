---
packages: root
---

- **dsh plugin**: `HarnessResolver.forWorkspace` now passes `workspaceRoot = the session cwd` (the probe start) — the `{HARNESS_DIR}` probe stops AT the session workspace and never walks up beyond it, so a harness dir above the workspace (e.g. the global `~/.mstar` CLI-install root) is never adopted. The dsh boundary deliberately diverges from the CLI's git-top-level boundary. Explicit `config.harnessDir` still wins outright.

<!-- CN -->
- **dsh 插件**：`HarnessResolver.forWorkspace` 现显式传入 `workspaceRoot = 会话工作区 cwd`（探测起点）——`{HARNESS_DIR}` 探测在会话工作区处停止、永不向上，工作区之上的 harness 目录（如全局 `~/.mstar` CLI 安装根）不再被采纳。dsh 边界与 CLI 的 git top-level 边界有意分叉。显式 `config.harnessDir` 仍全权优先。
