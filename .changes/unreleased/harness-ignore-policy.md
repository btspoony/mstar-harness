---
category: Changed
packages: cli, engine
---

- A `.gitignore` that already states any harness-root rule (`.mstar` or `.agents`, including a leading slash, a negation or a partial rule) is **author-owned**: scaffold, the install fence and `doctor` make no change at all — no append, reorder, dedupe or normalization, and the file bytes stay exactly as written. Unrelated paths and a lone `.mstarc` entry do not declare, and the custom-layout skip is unchanged.
- Added the exported `hasHarnessRootDeclaration(content)` predicate to the engine path module: a mechanical, read-only line scan that recognizes either layout's root rule, including a leading slash, a negation and a partial declaration, and introduces no glob, escaping or precedence semantics.
- `validateGitignore` now returns `gitignore.author-declared` for a declared file before any missing-entry computation and proposes no rewrite. A missing file stays `gitignore.missing`, and an undeclared file still reports the canonical entries it lacks. The canonical-completeness success branch was retired as unreachable, because canonical content is itself a declaration.

<!-- CN -->
- 已声明任一 harness 根规则（`.mstar` 或 `.agents`，含前导斜杠、否定或部分规则）的 `.gitignore` 属**作者所有**：scaffold、安装围栏与 `doctor` 完全不做改动——不追加、不重排、不去重、不规范化，文件字节保持作者原样。无关路径与单独出现的 `.mstarc` 条目不构成声明；自定义布局跳过行为不变。
- 在 engine path 模块新增导出谓词 `hasHarnessRootDeclaration(content)`：机械、只读的逐行扫描，可识别两种布局的根规则（含前导斜杠、否定与部分声明），且不引入 glob、转义或优先级语义。
- `validateGitignore` 现在对已声明文件在任何缺失条目计算之前返回 `gitignore.author-declared`，且不提出任何重写；文件缺失仍为 `gitignore.missing`，未声明文件仍报告其缺少的 canonical 条目。canonical 完整性成功分支已因不可达而退役——canonical 内容本身就是一种声明。
