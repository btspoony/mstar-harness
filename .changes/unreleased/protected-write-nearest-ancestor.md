---
category: Changed
packages: engine
---

- Fixed the protected-write boundary: `canonicalTarget` now resolves the nearest existing ancestor and re-appends the missing tail instead of falling back to the lexical path, so a `json` alias through a symlinked parent can no longer create a not-yet-existing `snapshot.json` / `status.json` / `residuals.json` outside the protected classification.

<!-- CN -->
- 修复受保护写入边界：`canonicalTarget` 现在解析最近的存在祖先并回接缺失尾段，不再回退到词法路径，因此经由符号链接父目录的 `json` 别名无法再在受保护分类之外创建尚不存在的 `snapshot.json` / `status.json` / `residuals.json`。
