---
category: Harness
packages: root
---

- Added **Guard 11** to `bun run validation:drift`: it reports every GFM `paragraph` node whose position spans more than one physical line, with `file:startLine-endLine`, so a wrapped paragraph stays visible and countable in diffs. Only `paragraph` nodes are judged — lists, tables, fenced code and YAML frontmatter are never reported — and width is not judged, so a long single line passes. A hard break (`\` or two trailing spaces) is content, not a paragraph boundary, so the paragraph around it still reports as multi-line.
- Guard 11 is **advisory in this release**: it prints the measured count plus `file:startLine-endLine` samples without failing `validation:drift`. The current corpus holds **142 multi-line paragraphs across 45 of 127 `skills/**` files**. The rule binds new and modified paragraphs immediately — they must be single-line — while an existing wrapped paragraph is reflowed when its file is next edited, so the count shrinks as files are touched and no whole-corpus reformat commit is needed.
- `scripts/markdown-wrap.test.ts` is listed in the CI `Test scripts` file set, so the guard's semantics can never silently stop running.

<!-- CN -->
- 在 `bun run validation:drift` 中新增 **Guard 11**：报告所有位置跨多个物理行的 GFM `paragraph` 节点，并给出 `file:startLine-endLine`，让被折行的段落始终在 diff 中可见、可数。只判定 `paragraph` 节点——列表、表格、围栏代码块与 YAML frontmatter 永不报告——也不判定行宽，因此单行再长也通过。硬换行（`\` 或行尾两个空格）属于内容而非段落边界，带硬换行的段落仍按多行报告。
- 本次发布中 Guard 11 为**建议级**：它打印实测数量及 `file:startLine-endLine` 样例，但不让 `validation:drift` 失败。当前语料共有 **142 个多行段落，分布在 127 个 `skills/**` 文件中的 45 个**。规则立即约束**新增与修改**的段落——必须单行；存量段落在其所在文件下次被编辑时顺势重排，因此计数随文件被触碰而递减，无需一次全仓重排提交。
- `scripts/markdown-wrap.test.ts` 已加入 CI `Test scripts` 文件集，该守卫的语义不会静默停止运行。
