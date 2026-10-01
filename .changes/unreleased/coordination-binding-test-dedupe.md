---
category: Harness
packages: root, engine
---

- Removed the reintroduced duplicate `binding` test group (a byte-identical 420-line copy) from `packages/engine/test/coordination.test.ts`; the eight binding contracts remain owned by `packages/engine/test/coordination-bind.test.ts`, and production coordination code plus shared fixtures are unchanged.

<!-- CN -->
- 从 `packages/engine/test/coordination.test.ts` 移除重新引入的重复 `binding` 测试组（420 行字节级相同副本）；八个 binding 契约继续由 `packages/engine/test/coordination-bind.test.ts` 独家持有，生产 coordination 代码与共享 fixtures 均不变。
