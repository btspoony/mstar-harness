---
category: Changed
packages: cli, root
---

- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias. **Caution**: `mstar` is a shared bin namespace — an unrelated third-party npm package named `mstar` claims the same command name, so bare `npx mstar …` only resolves to this CLI where `@mstar-harness/cli` is installed; keep the canonical `mstar-harness` in scripts and use the long name on any collision. Existing global installs obtain the `mstar` shim on their next upgrade: `npm i -g @mstar-harness/cli@latest` (or the bun equivalent) re-links all declared bins.
- **Drift-lint bin-prefix guard**: `validation:drift` now checks the binary prefix of every backticked CLI citation in Engine-check callouts against the declared `bin` names from `packages/cli/package.json` (the manifest is SSOT), so citing a nonexistent executable (e.g. a typo like `mstarr`) fails drift-lint instead of silently passing while the subcommand paths validate.

<!-- CN -->
- **CLI `mstar` bin 别名**：`@mstar-harness/cli` 现随规范名 `mstar-harness` 一起安装第二个可执行文件 `mstar`——两者映射到同一个 `dist/mstar-harness.js` 入口，两个名字可互换（由新增 manifest 测试固定）。`commands/` 中的引用改用 `mstar-harness`（版本稳健：长名存在于每个已发布版本；短别名随本版本发布），`docs/cli.md` 与 README 双语对补充了别名说明。**注意**：`mstar` 属于共享 bin 命名空间——名为 `mstar` 的无关第三方 npm 包声明了同一命令名，未安装 `@mstar-harness/cli` 时裸 `npx mstar …` 只会解析到该第三方工具；脚本中请保持规范名 `mstar-harness`，冲突时用长名。已全局安装旧版的用户，下次升级即可获得 `mstar` shim：`npm i -g @mstar-harness/cli@latest`（或 bun 等价命令）会重链全部已声明 bin。
- **drift-lint 二进制前缀守卫**：`validation:drift` 现在会把 Engine-check callout 中每个反引号 CLI 引用的二进制前缀，与 `packages/cli/package.json` 声明的 `bin` 名称（manifest 为 SSOT）逐一比对，引用不存在的可执行名（如拼写错误 `mstarr`）会导致 drift-lint 失败，而不再是在子命令路径全部校验通过时被静默放过。
