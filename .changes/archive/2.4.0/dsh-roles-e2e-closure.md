---
packages: dsh, root
---

- **dsh full support (docs)**: the `packages/dsh` README triple's Install section now documents the one-command CLI entry (`init --target dsh` — the two `dsh plugin --profile web add` installs, orchestrated) and what a user gets zero-config once both rows are installed: the 13 `mode: subagent` mstar role seeds with mirror-default personas (revertible in settings; runtime advisory reports overrides), plus a fresh-publish `minimumReleaseAge` window note (re-run init or pin the version). The installed-deployment e2e closes the loop: a real CLI install into a temp `DSH_HOME`, booted from the installed artifacts, asserts all 13 roles seeded with non-empty personas. Root README pair adds the dsh full-support one-liner.

<!-- CN -->
- **dsh 全量支持（文档）**：`packages/dsh` README 三联的 Install 节现写明一条命令的 CLI 入口（`init --target dsh`——编排两条 `dsh plugin --profile web add` 安装）以及两条行装齐后零配置获得什么：13 个 `mode: subagent` mstar 角色种子、persona 取镜像默认（settings 可 revert、运行时 advisory 报告覆盖），并附 fresh publish 的 `minimumReleaseAge` 窗口提示（重跑 init 或显式 pin 版本）。installed-deployment e2e 闭环：真实 CLI 安装进临时 `DSH_HOME`、从安装产物 boot，断言 13 角色全部 seeded 且 persona 非空。根 README 双语对补充 dsh 全量支持一句。
