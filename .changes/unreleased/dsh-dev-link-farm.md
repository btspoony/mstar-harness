---
packages: root
---

- **dsh plugin**: dev-time dependency strategy for the `@deepseek-ai/dsh-*` seams switched from committed `peer-stubs/` stand-ins to a **link farm** (`packages/dsh/scripts/setup-dsh-links.ts`, dsh-advisor pattern): the REAL packages from a local dsh source tree (`$DSH_SOURCE_DIR` → `$DSH_HOME/source/current` → `~/.dsh/source/current`) are symlinked into the repo-root `node_modules/@deepseek-ai/` (idempotent; `bun run dsh:link` / `dsh:link:check`; wired into `prepare` before the build). `peerDependencies` stay declared (the host provides them at runtime; marked optional so bun 1.2 does not 404 on the private registry); the `peer-stubs/` workspace was removed.
- **dsh plugin**: CI (validate job) now detects dsh source-tree availability (`$DSH_SOURCE_DIR` / `~/.dsh/source/current`) and skips the dsh test/typecheck steps when absent — dsh is not run in CI.

<!-- CN -->
- **dsh 插件**：`@deepseek-ai/dsh-*` 各 seam 的开发期依赖策略由提交的 `peer-stubs/` 占位包改为 **link farm**（`packages/dsh/scripts/setup-dsh-links.ts`，dsh-advisor 模式）：把本地 dsh 源码树（`$DSH_SOURCE_DIR` → `$DSH_HOME/source/current` → `~/.dsh/source/current`）中的**真实**包 symlink 进仓库根 `node_modules/@deepseek-ai/`（幂等；`bun run dsh:link` / `dsh:link:check`；已接入 `prepare`，位于 build 之前）。`peerDependencies` 保留（运行时由宿主提供；标记 optional 以避免 bun 1.2 访问私有 registry 404）；删除 `peer-stubs/` workspace。
- **dsh 插件**：CI（validate job）现检测 dsh 源码树可用性（`$DSH_SOURCE_DIR` / `~/.dsh/source/current`），不存在时跳过 dsh 测试/typecheck 步骤——CI 不跑 dsh。
