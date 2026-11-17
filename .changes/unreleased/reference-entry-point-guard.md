---
category: Harness
packages: root
---

- **Guard 15 keeps reference files discoverable.** `bun run validation:drift` now fails when a `skills/<skill>/references/**` file is not referenced from its own skill, when a `## References` row carrying a path states no trigger (a condition clause, or a table row whose trigger column is empty), or when a cross-skill citation leaves the owner out of the path. The owner must be in the path, not merely named on the line: the shape ``**`owner`** → `references/file.md` `` fails, because the citation alone does not resolve.
- **References resolve by longest existing suffix**, so nested children (`references/qc-specialist/report-template.md`) and colliding basenames (`report-template.md` under two skills) resolve to the file a citation names. An owner prefix disambiguates a collision, then the citing skill's own file; only a genuinely ambiguous basename fails, and the message says which owner path to write.

<!-- CN -->
- **Guard 15 守住 reference 文件的可发现性。** `bun run validation:drift` 现在会在以下情况失败：`skills/<skill>/references/**` 文件未被其所属 skill 引用；带路径的 `## References` 行没有写触发条件（条件子句，或表格行的触发列非空）；跨 skill 引用未把 owner 写进路径。owner 必须出现在路径里，仅仅出现在行内不算：``**`owner`** → `references/file.md` `` 这种形状会失败，因为单看这个引用无法解析。
- **引用按最长已存在后缀解析**，因此嵌套子路径（`references/qc-specialist/report-template.md`）与重名 basename（两个 skill 各有一个 `report-template.md`）都能解析到引用真正指的那个文件。重名先由 owner 前缀消歧，其次落到引用方自己的文件；只有真正无法消歧的 basename 才失败，且报错会写明应改成哪个 owner 路径。
