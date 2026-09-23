---
category: Harness
packages: root
---

- Recorded the repository's CLI-usage rule in `AGENTS.md`: run this checkout's own build (`bun run --cwd packages/cli build`, then `packages/cli/dist/mstar-harness.js`) rather than a globally installed `mstar`/`mstar-harness`. A global install is the released package for other projects — linking this checkout into it makes those projects run unreleased code, and invoking the global copy here runs a released CLI against unreleased engine behavior.

<!-- CN -->
- 在 `AGENTS.md` 记录本仓库的 CLI 使用规则：运行本检出自己的构建（`bun run --cwd packages/cli build`，随后 `packages/cli/dist/mstar-harness.js`），而不是全局安装的 `mstar`/`mstar-harness`。全局安装是给其他项目用的已发布包——把本检出 link 进去会让那些项目跑到未发布代码，而在这里调用全局副本则是用已发布 CLI 去操作未发布的引擎行为。
