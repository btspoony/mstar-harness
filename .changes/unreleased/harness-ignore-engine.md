---
category: Changed
packages: engine
---

- Added the exported **`hasHarnessRootDeclaration(content)`** predicate to the engine path module: a mechanical, read-only line scan (trimmed, blank/comment lines skipped, `^!?/?\.(?:mstar|agents)(?:\/|$)`) that recognizes a harness-root rule of either layout, including a leading slash, a negation and a partial declaration. `.mstarc` alone, comments and unrelated paths do not declare, and no glob, escaping or precedence semantics are introduced.
- **`validateGitignore`** now returns `gitignore.author-declared` for a declared file regardless of the detected harness kind, before any missing-entry computation, and proposes no rewrite or normalization. A missing file stays `gitignore.missing`; an undeclared file still reports `gitignore.missing-entries` with the canonical entries it lacks. The canonical-completeness success branch (`gitignore.ok`) and its per-kind completion tie-break were retired as unreachable — canonical content is itself a declaration.

<!-- CN -->
- 在 engine path 模块新增导出谓词 **`hasHarnessRootDeclaration(content)`**：机械、只读的逐行扫描（按 trim 识别、跳过空行与注释行、匹配 `^!?/?\.(?:mstar|agents)(?:\/|$)`），可识别两种布局的 harness 根规则，包括前导斜杠、否定与部分声明；单独 `.mstarc`、注释与无关路径不构成声明，且不引入 glob、转义或优先级语义。
- **`validateGitignore`** 对已声明的文件在缺失条目计算之前即返回 `gitignore.author-declared`（与检测到的 harness kind 无关），且不提出任何重写或规范化。文件缺失仍为 `gitignore.missing`；未声明文件仍以 `gitignore.missing-entries` 列出其缺少的 canonical 条目。canonical 完整性成功分支（`gitignore.ok`）及其按 kind 的补齐择一逻辑因不可达而退役——canonical 正文本身即构成声明。
