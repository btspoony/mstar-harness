---
category: Removed
packages: cli
---

- **Unused judgment devDependency.** Dropped the unused `@mstar-harness/judgment` devDependency from the CLI package; the CLI source never imports it and its judgment smoke test loads the built package by relative path.

<!-- CN -->
- **移除未使用的 judgment devDependency。**移除 CLI 包中未使用的 `@mstar-harness/judgment` devDependency；CLI 源码从不导入它，judgment 冒烟测试按相对路径加载构建产物。
