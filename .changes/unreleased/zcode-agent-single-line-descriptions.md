---
packages: root, opencode
---
- Converted all 14 repo-root agent shells (`agents/*.md`) to **single-line quoted English `description` frontmatter**. ZCode's flat agent frontmatter parser does not support `|-` block scalars — it parsed the literal string `|-` as the description and silently dropped the nested `tools`/`permission` maps, leaving plugin agent entries with a broken trigger description. Wording is unchanged (the existing English line is reused verbatim); `mode`/`tools`/`permission` are preserved for OpenCode semantics.

<!-- CN -->
- 将 14 个仓库根 agent 壳文件(`agents/*.md`)的 frontmatter 统一改为**单行带引号的英文 `description`**。ZCode 的平铺 agent frontmatter 解析器不支持 `|-` 块标量——会把字面量 `|-` 解析成 description,并静默丢弃嵌套的 `tools`/`permission` 映射,导致插件 agent 条目的触发描述损坏。措辞不变(逐字复用现有英文行);`mode`/`tools`/`permission` 为 OpenCode 语义,保持原样。
