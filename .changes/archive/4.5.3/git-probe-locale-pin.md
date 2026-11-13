---
packages: engine
---

- Pinned **Git probe subprocesses to the C locale**: a translated Git stderr no longer
  changes the fatal-128 classification, so a real repository still resolves under a
  non-English locale.

<!-- CN -->
- **Git 探测子进程固定为 C locale**：翻译后的 Git stderr 不再改变 fatal-128 分类，
  非英文 locale 下真实仓库仍能正确解析。
