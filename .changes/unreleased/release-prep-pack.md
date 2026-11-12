---
category: Fixed
packages: root
---

- **Release prep packs the build, not an empty `dist`.** The `Typecheck + pack (release sanity)` step ran `npm pack` for `@mstar-harness/cli` and `@mstar-harness/opencode` after `bun run typecheck` alone. Both packages ship `files: ["dist"]` and no `prepack` hook, so the tarballs it inspected carried no build output. The step now runs `bun run cli:build` and `bun run opencode:build` before the two `npm pack` lines, so the artifact sanity it claims covers what actually ships. CI owns the execution of this workflow; the plan branch does not run it, so the first real check is the next "Release prep" run.

<!-- CN -->
- **Release prep 打包的是构建产物，而不是空的 `dist`。** `Typecheck + pack (release sanity)` 步骤此前仅在 `bun run typecheck` 之后对 `@mstar-harness/cli` 与 `@mstar-harness/opencode` 运行 `npm pack`。这两个包都只声明 `files: ["dist"]` 且没有 `prepack` 钩子，因此它检查的 tarball 不含任何构建输出。该步骤现在在两条 `npm pack` 之前运行 `bun run cli:build` 与 `bun run opencode:build`，使其声称的产物健全性覆盖真正发布的字节。该 workflow 由 CI 执行；本计划分支不运行它，因此第一次真实检查是下一次 "Release prep" 运行。
