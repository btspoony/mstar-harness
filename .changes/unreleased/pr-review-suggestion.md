---
category: Harness
packages: root, engine, commands
---

- PR-review findings may now carry one optional GitHub `suggestion` block for a local single-line repair — one file, one hunk, one line, mechanically safe, and only after reading the surrounding code; the fence holds replacement text only, stays anchored to the finding's single `RIGHT` line, and is posted verbatim as part of the inline body.
- When GitHub rejects inline comments with 422, the folded summary body strips the `suggestion` fence (the summary has no line anchor) and emits an omission marker when nothing else remains.

<!-- CN -->
- PR 审查 finding 现可携带一个可选的 GitHub `suggestion` 块，仅用于局部单行修复——单文件、单 hunk、单行、机械安全，且必须先阅读周边代码；fence 内只含替换文本，锚定该 finding 唯一的 `RIGHT` 行，并作为 inline 正文的一部分逐字发布。
- GitHub 以 422 拒绝 inline 评论时，折叠进 summary 的正文会移除 `suggestion` fence（summary 没有行锚点），若其余内容为空则输出省略标记。
