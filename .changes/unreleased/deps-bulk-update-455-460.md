---
category: Harness
packages: root, cli, dsh
---

- Bulk dev-dependency refresh merging dependabot PRs #455–#460 into one change: GitHub Actions version bumps, @types/node 26, js-yaml 5, vitest 5, katex 0.19, shiki/@shikijs/langs 4.5, `@modelcontextprotocol/client` 2.3.1, simple-icons 16.34, `use-sync-external-store` 1.7, and the `dsh-llm-fallbacks` 0.6.5 pin synced into the engine constant.
- Type checking and declaration emit now run on TypeScript 7 (tsgo); the four AST-based lint scanners keep parsing with TypeScript 5 through the new `typescript5` alias until tsgo ships a `createSourceFile`-style parsing API.

<!-- CN -->
- 批量开发依赖更新，将 dependabot PR #455–#460 合并为一次变更：GitHub Actions 版本提升、@types/node 26、js-yaml 5、vitest 5、katex 0.19、shiki/@shikijs/langs 4.5、`@modelcontextprotocol/client` 2.3.1、simple-icons 16.34、`use-sync-external-store` 1.7，以及 `dsh-llm-fallbacks` 0.6.5 pin 与 engine 常量同步。
- 类型检查与声明产物改用 TypeScript 7（tsgo）；四个基于 AST 的 lint 扫描器在 tsgo 提供 `createSourceFile` 级解析 API 之前，继续通过新增的 `typescript5` 别名使用 TypeScript 5 解析。
