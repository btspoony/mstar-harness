---
category: Harness
packages: root
---

- **`@mstar-harness/commands` is now strictly internal.** It is marked `private`, consumed as a workspace `devDependency`, and inlined into the CLI bundle, so the Release workflow no longer publishes it (the publish step could never succeed: the package has never existed on npm and OIDC trusted publishing cannot create a package).
- **The root manifest no longer references commands at all.** It is removed from both `dependencies` and `devDependencies`, because the root package is the git-install entry (`omp plugin install github:btspoony/mstar-harness`, `bun add github:…`) and the `workspace:` protocol does not resolve outside the workspace — a git install that also installs devDependencies would fail to install. Workspace packages still link commands directly, and `release:prepare` keeps bumping its version in lockstep.
- **A publish step for a version already on the registry is a reported skip, not a failure.** A pre-publish check classifies every publishable package as `publish` or `skip` (already on the registry) and refuses on any unknown registry state, so each publish step either publishes or states that the version is already there. It checks manifest publishability and registry state only — it cannot verify npm trusted-publisher/OIDC authorization, which only an actual publish attempt proves. CI also asserts the workflow's publish set equals the non-private workspace packages.

<!-- CN -->
- **`@mstar-harness/commands` 现为严格内部包。** 它标记为 `private`，作为 workspace `devDependency` 消费并内联进 CLI bundle，因此 Release workflow 不再发布它（该发布步骤永远无法成功：该包从未存在于 npm，且 OIDC 可信发布无法创建新包）。
- **根 manifest 完全不再引用 commands。** 它已从 `dependencies` 和 `devDependencies` 中一并删除——根包即 git 安装入口（`omp plugin install github:btspoony/mstar-harness`、`bun add github:…`），而 `workspace:` 协议在工作区之外无法解析，会安装 devDependencies 的 git 安装将因此失败。workspace 内各包仍直接 link commands，`release:prepare` 仍让它的版本与发布同步。
- **已在 registry 上的版本，其发布步骤会被报告为跳过而非失败。** 发布前检查把每个可发布包分类为 `publish` 或 `skip`（已在 registry 上），并在任何 registry 状态未知时拒绝，因此每个发布步骤要么发布、要么明确说明该版本已存在。它只检查 manifest 可发布性与 registry 状态——无法验证 npm 可信发布者/OIDC 授权，那只能由真实发布尝试证明。CI 还会断言 workflow 的发布集合与非 private 的 workspace 包一致。
