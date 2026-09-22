---
category: Harness
packages: root
---

- `mstar-conventions` now states the harness ignore policy: a `.gitignore` that already holds any harness-root rule (`.mstar` or `.agents`, including a leading slash, a negation or a partial rule) is author-owned, so scaffold, the fence and `doctor` make no change at all — no append, reorder, dedupe or normalization, and the file bytes stay as written. Unrelated paths and the lone `.mstarc` entry do not declare. The canonical snippet is only bootstrapped into an undeclared file, and the custom-layout skip is unchanged. The section and its engine-check note name the shared `hasHarnessRootDeclaration` predicate and the `gitignore.author-declared` success code.

<!-- CN -->
- `mstar-conventions` 现在写明 harness ignore 策略：`.gitignore` 只要已含任一 harness 根规则（`.mstar` 或 `.agents`，含前导斜杠、否定或部分规则）即属作者所有，scaffold、fence 与 `doctor` 不做任何改动——不追加、不重排、不去重、不规范化，文件字节保持作者原样。无关路径与单独出现的 `.mstarc` 条目不构成声明。canonical snippet 只 bootstrap 未声明的文件，自定义布局跳过行为不变。该节及其 engine-check 注记同时写明共用的 `hasHarnessRootDeclaration` 谓词与 `gitignore.author-declared` 成功码。
