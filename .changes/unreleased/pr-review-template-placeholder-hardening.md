---
packages: root, opencode
---

- **PR deep-review report template hardening**: the `Considered & rejected` placeholder no longer embeds the bullet dash inside angle brackets (a posted review rendered literal `<finding>` wrappers verbatim); rejected entries now use `- **<short title>**: rejected — <reason>` with an explicit "never render brackets" rule stated at the template top; empty Plan-to-fix sections collapse to a bare `none` instead of prose.

<!-- CN -->
- **PR 深审报告模板加固**：`Considered & rejected` 占位符不再把 bullet 短横线包进尖括号（此前一条已发布 review 逐字渲染了 `<finding>` 包裹）；拒绝条目改为 `- **<短标题>**: rejected — <理由>`，并在模板顶部显式声明“尖括号仅是填空槽、永不渲染”；无修复计划时 Plan to fix 整块折叠为单独一行 `none` 而非散文。
