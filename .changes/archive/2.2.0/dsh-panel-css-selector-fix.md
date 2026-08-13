---
packages: root
---

- **dsh plugin**: fixed the unstyled MStar workflow panel — CSS Modules hash class names in the web client bundle could start with a digit (FNV-1a → 8-hex, ~62.5% digit-leading), producing illegal selectors (`.20fd0e45_root`) that browsers silently drop (the whole rule is discarded). The client bundle build now escapes digit-leading class selectors at the CSS text layer (WHATWG `CSS.escape`, e.g. `.20fd0e45_root` → `.\32 0fd0e45_root`; DOM class names unchanged) and adds a build-time two-layer assertion (transform + emitted artifact) that no unescaped digit-leading hash selector remains — a regression guard so silent style loss cannot slip through again.

<!-- CN -->
- **dsh 插件**：修复 MStar 工作流面板"无样式"问题——web 客户端 bundle 中 CSS Modules 哈希类名可能以数字开头（FNV-1a → 8 位 hex，约 62.5% 概率），拼出非法选择器（如 `.20fd0e45_root`）被浏览器静默丢弃（整条规则失效）。客户端 bundle 构建现于 CSS 文本层按 WHATWG `CSS.escape` 转义数字开头的类选择器（如 `.20fd0e45_root` → `.\32 0fd0e45_root`；DOM 类名不变），并新增构建期双层断言（transform 层 + 产物 artifact 层）确保无未转义数字开头 hash 选择器残留——防止静默样式丢失再次发生。
