---
category: Harness
packages: root
---

- **Release prep and Release typecheck through one self-preparing command.** `bun run typecheck` now builds the workspace declaration dists it resolves (`typecheck:prepare`: engine → judgment → commands) instead of depending on each caller's step order, which had left `Release prep` failing on `Cannot find module '@mstar-harness/commands'` since the CLI command-adapter cutover.
- Removed the duplicated declaration-build steps from `ci.yml`, `release.yml` and `release-prep.yml`; the prerequisite chain now exists in exactly one place.

<!-- CN -->
- **Release prep 与 Release 改为经一条自准备命令做类型检查。** `bun run typecheck` 现在自行构建其解析所需的 workspace 声明产物（`typecheck:prepare`：engine → judgment → commands），不再依赖各调用方自己维护的步骤顺序——该顺序在 CLI command-adapter 切换后漏改，导致 `Release prep` 一直因 `Cannot find module '@mstar-harness/commands'` 失败。
- 删除 `ci.yml`、`release.yml`、`release-prep.yml` 中重复的声明构建步骤；前置链现在只有一处实现。
