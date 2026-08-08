---
category: Fixed
packages: root, opencode
---

- OpenCode plugin hooks no longer abort-log on non-string `task`/`write` args: Assignment and `status.json` validators refuse non-string input before `.match` / `path.resolve`, and the `tool.execute.before` hook snapshots `prompt`/`filePath` once (avoids getter/Proxy type flips).

<!-- CN -->
- OpenCode 插件钩子不再因非 string 的 `task`/`write` 参数刷 abort 日志：Assignment 与 `status.json` 校验在 `.match` / `path.resolve` 前拒绝非 string 输入，且 `tool.execute.before` 对 `prompt`/`filePath` 只读取一次（避免 getter/Proxy 类型翻转）。
