---
category: Harness
packages: root, cli
---

- **New `@mstar-harness/omp` npm package**: `omp plugin install @mstar-harness/omp` now works without any local build — the omp hook + six `mstar_*` tools are bundled with the engine **inlined** (zero runtime `@mstar-harness/engine` resolution), fixing `Cannot find package '@mstar-harness/engine'` on third-party installs. Docs (`INSTALL.md`, `README.md`/`README_CN.md`, `mstar-host` omp reference) and the CLI omp adapter now prefer the npm install path; the maintainer `omp plugin link` path is `<repo>/packages/omp` (needs `bun install && bun run engine:build && bun run --cwd packages/omp build` in the checkout).
- **BREAKING (intended)**: repo-root `hooks/` and `tools/` moved into `packages/omp/src/` — the omp hook/tools are now omp-only package surfaces. Anyone relying on repo-root `hooks/pre/mstar-gates.ts` / `tools/mstar_*` paths must use the package (`packages/omp/src/…` sources, `<pkg>/hooks/` + `<pkg>/tools/` in the installed npm tree). The maintainer `omp plugin link` path is now `<repo>/packages/omp` (built) — linking the repo root no longer provides the runtime gates.

<!-- CN -->
- **新增 `@mstar-harness/omp` npm 包**：`omp plugin install @mstar-harness/omp` 现在无需任何本地构建即可工作——omp hook 与六个 `mstar_*` 工具在构建时将引擎**内联打包**（零运行时 `@mstar-harness/engine` 解析），修复第三方安装时的 `Cannot find package '@mstar-harness/engine'`。文档（`INSTALL.md`、`README.md`/`README_CN.md`、`mstar-host` omp 参考）与 CLI omp 适配器均改为优先 npm 安装路径；维护者 `omp plugin link` 路径为 `<repo>/packages/omp`（需先在检出中执行 `bun install && bun run engine:build && bun run --cwd packages/omp build`）。
- **破坏性变更（有意为之）**：仓库根 `hooks/` 与 `tools/` 移入 `packages/omp/src/`——omp hook/tools 现为 omp 专属包表面。依赖仓库根 `hooks/pre/mstar-gates.ts` / `tools/mstar_*` 路径者须改用包内路径（源码 `packages/omp/src/…`，安装后的 npm 树 `<pkg>/hooks/` + `<pkg>/tools/`）。维护者 `omp plugin link` 路径现为 `<repo>/packages/omp`（需先构建）——链接仓库根不再提供运行时门禁。
