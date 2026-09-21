---
category: Harness
packages: root
---

- Added two **prose-hygiene rules** to `mstar-compound`'s knowledge-document quality gate: durable bodies state the rule and the outcome, not the authoring date (timestamps belong to the frontmatter `date` / `last_updated` schema fields), and citations use repo-relative paths or `{HARNESS_DIR}`-style symbols rather than machine-local absolute paths.
- Reinforces the existing `CONCEPTS.md` rule (no status/date/owner fields) at the compound write path.

<!-- CN -->
- 在 `mstar-compound` 的知识文档质量门新增两条**正文卫生规则**：durable 正文陈述规则与结论，不写撰写日期（时间信息属于 frontmatter 的 `date` / `last_updated` schema 字段）；引用使用 repo-relative 路径或 `{HARNESS_DIR}` 等符号，不写机器专属绝对路径。
- 把 `CONCEPTS.md` 既有的「no status/date/owner fields」规则落到 compound 写入路径。
