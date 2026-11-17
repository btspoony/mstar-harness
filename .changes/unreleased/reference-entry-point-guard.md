---
category: Harness
packages: root
---

- **Every References row states when to open its file.** 37 rows across 14 skills carried only a topic description; each now carries a condition derived from the file's own first section. `mstar-coding-behavior` gained rows for the constraint ladder and the comment standard, and the standalone-use note was folded so the file stays at its 70-line ceiling.
- **Cross-skill citations name their owner.** 193 citations of another skill's reference now read `mstar-<owner>/references/<file>.md`; same-skill citations stay bare.
- **Guard 15 keeps reference files discoverable.** `bun run validation:drift` now fails when a `skills/<skill>/references/**` file is not referenced from its own skill, when a `## References` row carrying a path states no trigger (a condition clause, or a table row whose trigger column is empty), or when a cross-skill citation leaves the owner out of the path. The owner must be in the path, not merely named on the line: the shape ``**`owner`** → `references/file.md` `` fails, because the citation alone does not resolve.
- **References resolve by longest existing suffix**, so nested children (`references/qc-specialist/report-template.md`) and colliding basenames (`report-template.md` under two skills) resolve to the file a citation names. An owner prefix disambiguates a collision, then the citing skill's own file; only a genuinely ambiguous basename fails, and the message says which owner path to write.

<!-- CN -->
- **每行 References 都说明何时打开对应文件。** 14 个 skill 的 37 行原先只有主题描述，现在各自带上从目标文件首节推导出的条件。`mstar-coding-behavior` 增加了约束阶梯与注释标准的入口行，并把 standalone 说明并入末句以守住 70 行上限。
- **跨 skill 引用写明 owner。** 193 处引用其他 skill 的 reference 现在写作 `mstar-<owner>/references/<file>.md`；同 skill 引用保持裸路径。
- **Guard 15 守住 reference 文件的可发现性。** `bun run validation:drift` 现在会在以下情况失败：`skills/<skill>/references/**` 文件未被其所属 skill 引用；带路径的 `## References` 行没有写触发条件（条件子句，或表格行的触发列非空）；跨 skill 引用未把 owner 写进路径。owner 必须出现在路径里，仅仅出现在行内不算：``**`owner`** → `references/file.md` `` 这种形状会失败，因为单看这个引用无法解析。
- **引用按最长已存在后缀解析**，因此嵌套子路径（`references/qc-specialist/report-template.md`）与重名 basename（两个 skill 各有一个 `report-template.md`）都能解析到引用真正指的那个文件。重名先由 owner 前缀消歧，其次落到引用方自己的文件；只有真正无法消歧的 basename 才失败，且报错会写明应改成哪个 owner 路径。
