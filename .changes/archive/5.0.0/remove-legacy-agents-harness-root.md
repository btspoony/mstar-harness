---
category: Removed
packages: engine,commands
---

- **Removed the legacy `.agents/` harness kind and its `.gitignore` snippet.** `emitGitignoreSnippet()` takes no kind and always returns the `.mstar/` snippet; `detectHarnessKind`, `HarnessKind`, and the legacy `.agents/` snippet exports are gone. A `.agents/` rule in `.gitignore` no longer counts as a harness-root declaration, so scaffold and `validateGitignore` still require `.mstar/`; `.agents/{knowledge,specs,adr}` remain the tracked corpora.

<!-- CN -->
- **移除 legacy `.agents/` harness kind 及其 `.gitignore` snippet。** `emitGitignoreSnippet()` 不再接收 kind，固定返回 `.mstar/` snippet；`detectHarnessKind`、`HarnessKind` 与 legacy `.agents/` snippet 导出已删除。`.gitignore` 中的 `.agents/` 规则不再视为 harness 根声明，因此 scaffold 与 `validateGitignore` 仍要求 `.mstar/`；`.agents/{knowledge,specs,adr}` 仍是 tracked 语料目录。
