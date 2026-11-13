---
category: Harness
packages: root
---

- **`@mstar-harness/judgment` now reaches the engine only through its package entry** and exposes `normalizeTypeSafeResponse` with its `NormalizedTypeSafeResponse` type on the public surface; the `../../engine/src/mstarc.js` source-relative import is gone.
- The existing normalizer suite plus a built-package import smoke prove the export; no forwarding test suite was added.

<!-- CN -->
- **`@mstar-harness/judgment` 现仅通过 package 入口访问引擎**，并在公开表面上导出 `normalizeTypeSafeResponse` 及其 `NormalizedTypeSafeResponse` 类型；`../../engine/src/mstarc.js` 这种源码相对导入已移除。
- 由既有 normalizer 测试套件加一次构建产物导入冒烟证明该导出；未新增转发型测试套件。
