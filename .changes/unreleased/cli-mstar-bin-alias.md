---
category: Changed
packages: cli, root
---

- **CLI `mstar` bin alias**: `@mstar-harness/cli` now installs a second executable, `mstar`, alongside the canonical `mstar-harness` — both map to the same `dist/mstar-harness.js` entry, so the two names are interchangeable (pinned by a new manifest test). `commands/` citations now use `mstar-harness` (version-proof: the long name exists in every released version; the short alias ships with this release), and `docs/cli.md` plus the README pair note the alias.

<!-- CN -->
- **CLI `mstar` bin 别名**：`@mstar-harness/cli` 现随规范名 `mstar-harness` 一起安装第二个可执行文件 `mstar`——两者映射到同一个 `dist/mstar-harness.js` 入口，两个名字可互换（由新增 manifest 测试固定）。`commands/` 中的引用改用 `mstar-harness`（版本稳健：长名存在于每个已发布版本；短别名随本版本发布），`docs/cli.md` 与 README 双语对补充了别名说明。
