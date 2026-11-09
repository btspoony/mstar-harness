---
category: Harness
packages: root
---

- **Knowledge moved to `docs/knowledge/`.** The repository now declares `knowledge_dir=docs/knowledge` in `.mstarc`, so the knowledge corpus is a tracked result instead of a gitignored harness artifact; the 13 retired docs stay in the local, gitignored archive (`.mstar/archived/knowledge/`).
- Live docs that referenced the old `.mstar/knowledge/` path were re-pointed, and the one tracked changelog fragment that cited it was corrected.

<!-- CN -->
- **知识库迁移到 `docs/knowledge/`。** 仓库在 `.mstarc` 声明 `knowledge_dir=docs/knowledge`，知识语料从被忽略的 harness 产物变为可跟踪结果；13 篇已退役文档仍留在本地（被 Git 忽略）的归档树 `.mstar/archived/knowledge/`。
- 引用旧 `.mstar/knowledge/` 路径的 live 文档已改指新位置，一处引用该路径的已跟踪 changelog fragment 同步修正。
