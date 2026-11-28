---
category: Changed
packages: root
---

- **Removed the unclassified comment corpus carried by the 5.0 merge across 168 files.** Descriptive `note:` / `why:` / `invariant:` blocks with no resolvable anchor are deleted, and no comment was re-prefixed. Comment-stripped transpiler output is byte-identical for every touched file, so behavior is unchanged.

<!-- CN -->
- **清理 5.0 合并带入的 168 个文件中的未分类注释。** 删除没有可解析锚点的 `note:` / `why:` / `invariant:` 描述性注释块，未改写任何前缀。所有改动文件去除注释后的转译输出逐字节一致，行为不变。
