---
category: Harness
packages: root
---

- Added **Guard 10** to `bun run validation:drift`: a cross-file duplicate-HARD-rule fingerprint. It groups the rule wording shared by two or more `skills/**` files and reports the whole group, so a re-vendored rule sentence is visible before its copies drift apart. A candidate counts when a tight block of ≥3 consecutive lines carries a rule signal, or a single ≥8-word line carries `NEVER` / `MUST` / `MUST NOT` / `HARD` (or is made only of upper-case words). Normalization strips list markers, blockquote markers, whitespace and inline-code backticks while preserving the case of the rule text.
- Guard 10 is **advisory in this release**: it prints the measured duplicate-group count plus each group's sites, and `scripts/rule-duplication.allowlist.json` records accepted exceptions as `{ file, normalizedHash, reason }` (a reason must name the file it covers). Blocking resumes once the pointerization plan prunes the known corpus copies.
- Guard 9's line ceilings count logical lines: a file with no trailing newline reports one line more than `wc -l`. Both remaining non-compliant skill files now end with exactly one newline.

<!-- CN -->
- 在 `bun run validation:drift` 中新增 **Guard 10**：跨文件 HARD 规则指纹。它把两个及以上 `skills/**` 文件共享的规则文本归为一组并整组报告，让被重复搬运的规则句在副本彼此漂移之前就暴露出来。判定条件为：连续 ≥3 行的紧凑块携带规则信号，或单行 ≥8 词且包含 `NEVER` / `MUST` / `MUST NOT` / `HARD`（或整行仅由大写单词构成）。归一化会去掉列表标记、引用标记、多余空白与行内代码反引号，但保留规则文本的大小写。
- 本次发布中 Guard 10 为**建议级**：它打印实测的重复组数量及每组的具体位置，`scripts/rule-duplication.allowlist.json` 以 `{ file, normalizedHash, reason }` 记录已接受的例外（`reason` 必须点明所覆盖的文件）。待指针化计划清理现有语料副本后，该守卫恢复为阻断级。
- Guard 9 的行数上限按逻辑行计数：无尾换行的文件比 `wc -l` 多算一行。现存两个不合规的 skill 文件现已补齐恰好一个尾换行。
