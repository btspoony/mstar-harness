---
category: Harness
packages: root
---

- **`validate` gate repaired**: the engine builds and typechecks again — the duplicate root `Severity` re-export (core vs issue vocabularies) is resolved to the canonical core path, and the undefined-narrowing / matcher-overload errors in the engine tests and `initializeStore` are fixed with no runtime semantics change. `packages/cli` `typecheck:src` now regenerates the gitignored dashboard asset module first (`scripts/build-web.ts`; deterministic, round-trip-verified), so a fresh checkout typechecks without a full build.

<!-- CN -->
- **`validate` 门禁修复**：engine 重新可构建、可类型检查——根导出 `Severity` 重复（core 与 issue 两套词表）收敛为规范的 core 路径，引擎测试与 `initializeStore` 中的 undefined 收窄 / 匹配器重载错误已修复，运行时语义不变。`packages/cli` 的 `typecheck:src` 现在先生成被 gitignore 的 dashboard 资产模块（`scripts/build-web.ts`；确定性、往返校验），全新检出无需完整构建即可通过类型检查。
