---
category: Changed
packages: cli
---

- **CLI path resolution**: relative path args on the six dev commands (`skill lint`, `lint`, `dispatch validate`, `compound validate`, `design-md validate`, `audit scaffold`) now resolve against the workspace/project root instead of the process cwd — `MSTAR_CLI_PROJECT_ROOT` env override (set by the root `cli:dev` wrapper), else the nearest ancestor `package.json` declaring `workspaces` (monorepo root; array, npm single-glob string like `"./packages/*"`, or object form), else the nearest `package.json` (single-package project root), else cwd-relative terminal fallback. Documented invocations like `bun run cli:dev skill lint skills/mstar-audit` (or `bun run --cwd packages/cli dev skill lint skills/mstar-audit`) now find repo-root skills from any cwd; absolute paths are unchanged.

<!-- CN -->
- **CLI 路径解析**：六个 dev 命令（`skill lint`、`lint`、`dispatch validate`、`compound validate`、`design-md validate`、`audit scaffold`）的相对路径参数改为相对工作区/项目根解析——优先 `MSTAR_CLI_PROJECT_ROOT` 环境变量（由根 `cli:dev` 包装脚本设置），其次向上查找最近声明 `workspaces` 的 `package.json`（monorepo 根；支持数组、npm 单 glob 字符串如 `"./packages/*"` 与对象形式），再其次最近任意 `package.json`（单包项目根），最后回退为相对 cwd。`bun run cli:dev skill lint skills/mstar-audit`（或 `bun run --cwd packages/cli dev skill lint skills/mstar-audit`）等文档化命令现在从任意 cwd 都能找到仓库根的 skills；绝对路径不变。
