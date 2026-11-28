---
category: Fixed
packages: root
---

- **The roadmap's effort cell is asserted through its own hook.** The board's session count carries
  `data-ms-effort`, so the UI test can no longer be satisfied by an unrelated "12" (a catalog revision),
  and the timeline invariant no longer promises an ordering the code does not implement.

<!-- CN -->
- **roadmap 的 effort 单元通过自身 hook 断言。** board 的会话数带上 `data-ms-effort`，UI 测试不再能
  被无关的 "12"（目录 revision）满足；timeline 的 invariant 不再承诺代码未实现的排序。
