---
category: Changed
packages: cli
---

- The harness `.gitignore` fence is now author-owned. `missingHarnessProcessGitignoreEntries` returns no entries and `appendHarnessProjectGitignore` writes no bytes for a file stating any harness-root declaration (`hasHarnessRootDeclaration`), so the four `doctor` loops stay silent and `init` never appends to, reorders, dedupes or normalizes an authored policy. Only an undeclared file still receives the canonical entries, and the generic `appendGitignore` used for unrelated plugin rules is unchanged.
- `mstar harness scaffold` short-circuits its default-layout fence the same way: a declared file is reported as skipped and left byte-for-byte unchanged — no append, splice, reorder, partition, negation synthesis or dedupe. The `CANONICAL_NEGATIONS` table and the whole normalization mechanism were retired; the fresh canonical snippet append, the snippet comments/entries, exact workspace-root matching and the custom-layout skip remain.

<!-- CN -->
- harness `.gitignore` fence 现在尊重作者所有权：当文件已声明任一 harness 根规则（`hasHarnessRootDeclaration`）时，`missingHarnessProcessGitignoreEntries` 返回空、`appendHarnessProjectGitignore` 不写任何字节，因此四处 `doctor` 循环保持静默，`init` 不再对作者的策略做追加、重排、去重或规范化。仅未声明的文件仍会收到 canonical 条目；用于无关插件规则的通用 `appendGitignore` 行为不变。
- `mstar harness scaffold` 的默认布局 fence 同样短路：已声明的文件报告为 skipped 并逐字节保持不变——不再追加、拼接、重排、分区、补全否定或去重。`CANONICAL_NEGATIONS` 表与整套规范化机制已退役；新鲜 canonical 片段追加、片段注释/条目、workspace 根精确匹配与自定义布局跳过均保留。
