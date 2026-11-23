---
category: Changed
packages: root
---

- **The whole-tree comment corpus floor is retired.** CI runs the changed-lines comment ratchet only; a per-root lower bound on the unclassified-comment count could not tell a detector regression from a genuine cleanup, and every honest cleanup needed a workflow edit to lower it. Detector behavior is pinned by `packages/cli/test/lint-cli.test.ts` (unclassified detection, `why:` acceptance, doc-block handling, the `--diff-base` ratchet), and the ratchet's base order and selection pipeline are unchanged.

<!-- CN -->
- **全树注释语料下限（floor）退役。** CI 只运行按变更行收紧的注释 ratchet；未分类注释数量的每根下界无法区分检测器回归与真实清理，而每次真实清理都要改工作流把下界调低。检测器行为改由 `packages/cli/test/lint-cli.test.ts` 钉住（未分类检出、`why:` 接受、doc block 处理、`--diff-base` ratchet），ratchet 的基准解析顺序与文件选择管线不变。
