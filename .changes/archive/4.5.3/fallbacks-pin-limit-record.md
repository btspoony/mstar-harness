---
category: Documentation
packages: root
---

- **The `dsh-llm-fallbacks` dependency boundary is recorded, not gated.** The pin stays two hand-written literals — the `packages/dsh` devDependency and the CLI's `mstar.dshLlmFallbacks` read at runtime by `dshFallbacksVersion()` — moved together in one change, because no test, validator or release surface compares them and a comparison test would only assert two copies of one string. The decision record is `docs/adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md`, which also accepts the dev-only nested React 18 that the package's `react ^18` peer brings in: `packages/dsh/src` never imports the package and its `./client` surface is not mounted into the dashboard React tree. The seeds knowledge page points at the record instead of restating it.

<!-- CN -->
- **`dsh-llm-fallbacks` 的依赖边界改为记录，而非设闸。** 该 pin 仍是两处手写字面量——`packages/dsh` 的开发依赖，以及 CLI 的 `mstar.dshLlmFallbacks`（由 `dshFallbacksVersion()` 在运行时读取）——必须在同一次改动中一起移动，因为没有测试、校验器或发布面会比较二者，而对比测试只能断言「两份同一个字符串相等」。决策记录为 `docs/adr/implemented/architecture/2026-11-12-fallbacks-dependency-boundaries.md`，其中也接受了该包 `react ^18` peer 带来的、仅存在于开发期的嵌套 React 18：`packages/dsh/src` 从不导入该包，其 `./client` 面也未挂进 dashboard 的 React 树。seeds 知识页只指向该记录，不再复述理由。
