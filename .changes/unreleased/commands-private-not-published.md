---
category: Harness
packages: root
---

- **`@mstar-harness/commands` is now strictly internal.** It is marked `private`, consumed as a workspace `devDependency`, and inlined into the CLI bundle, so the Release workflow no longer publishes it (the publish step could never succeed: the package has never existed on npm and OIDC trusted publishing cannot create a package).
- **The root manifest no longer references commands at all.** It is removed from both `dependencies` and `devDependencies`, because the root package is the git-install entry (`omp plugin install github:btspoony/mstar-harness`, `bun add github:…`) and the `workspace:` protocol does not resolve outside the workspace — a git install that also installs devDependencies would fail to install. Workspace packages still link commands directly, and `release:prepare` keeps bumping its version in lockstep.
- **A partially published release is now resumable.** Re-dispatching the Release workflow (`workflow_dispatch`, from the release commit's ref) runs a pre-publish check that classifies every publishable package as `publish` or `skip` (already on the registry) and refuses on any unknown registry state, so a resumed release skips what is already published instead of failing on npm's duplicate-version refusal, and still skips an existing tag. CI also proves the workflow's publish set matches the non-private workspace packages.

<!-- CN -->
- **`@mstar-harness/commands` 现为严格内部包。** 它标记为 `private`，作为 workspace `devDependency` 消费并内联进 CLI bundle，因此 Release workflow 不再发布它（该发布步骤永远无法成功：该包从未存在于 npm，且 OIDC 可信发布无法创建新包）。
- **根 manifest 完全不再引用 commands。** 它已从 `dependencies` 和 `devDependencies` 中一并删除——根包即 git 安装入口（`omp plugin install github:btspoony/mstar-harness`、`bun add github:…`），而 `workspace:` 协议在工作区之外无法解析，会安装 devDependencies 的 git 安装将因此失败。workspace 内各包仍直接 link commands，`release:prepare` 仍让它的版本与发布同步。
- **部分发布的 release 现可恢复。** 重新派发 Release workflow（`workflow_dispatch`，从 release 提交所在的 ref）会先做发布前检查：把每个可发布包分类为 `publish` 或 `skip`（已在 registry 上），并在任何 registry 状态未知时拒绝，因此恢复的 release 会跳过已发布的包，而不是因 npm 的重复版本拒绝而失败；已存在的 tag 仍会跳过。CI 还会断言 workflow 的发布集合与非 private 的 workspace 包一致。
