---
packages: engine
---

- **Engine zero-dependency**: pruned the phantom `ajv` runtime dependency (declared but never imported) and dropped `zod` by hand-rolling the compass frontmatter schema validator in `iteration.ts` (behavior preserved — same field semantics, violation codes, and messages; covered by the existing `validateCompassFrontmatter` suite); `@mstar-harness/engine` now has zero external runtime dependencies (`node:*` only), shrinking the install tree for CLI and OpenCode consumers.

<!-- CN -->
- **Engine 零外部依赖**：移除幻影运行时依赖 `ajv`（声明过但从未被 import），并将 `iteration.ts` 的 compass frontmatter schema 校验器手写化以移除 `zod`（行为保持不变——字段语义、违规代码与消息一致，由既有 `validateCompassFrontmatter` 测试覆盖）；`@mstar-harness/engine` 现在零外部运行时依赖（仅 `node:*`），CLI 与 OpenCode 消费者的安装树随之缩小。
