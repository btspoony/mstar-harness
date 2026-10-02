---
category: Harness
packages: root
---

- Removed the unused tracked root `specs/` directory: `{SPECS_DIR}` resolution picks `{HARNESS_DIR}/specs/` first, so the root copy was shadowed, shipped in no package, and referenced nowhere.

<!-- CN -->
- 移除未被使用的根 `specs/` 跟踪目录：`{SPECS_DIR}` 解析始终优先选中 `{HARNESS_DIR}/specs/`，该根目录副本从未被解析、不随任何包发布、亦无任何引用。
