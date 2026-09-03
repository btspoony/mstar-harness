---
packages: root, cli
---
- Shipped repo-side ZCode marketplace manifests (`.claude-plugin/marketplace.json`, with root `marketplace.json` as fallback) so ZCode's `github`-source marketplace refresh can discover the catalog in-repo — previously refresh failed with `Marketplace manifest not found in GitHub repo`. Plugin entries use the `github` source with no pinned version; install-time versions come from `.zcode-plugin/plugin.json`.
- Aligned the `zcode` adapter: the local marketplace snapshot written by `init` no longer pins a plugin version, and `doctor` accepts version-less plugin entries (a successful ZCode refresh overwrites the snapshot with the repo manifest).

<!-- CN -->
- 仓库内置 ZCode marketplace manifest(`.claude-plugin/marketplace.json`,根 `marketplace.json` 作回退),ZCode 刷新 `github` 源 marketplace 时可直接在仓库内发现目录——此前刷新会报 `Marketplace manifest not found in GitHub repo`。插件条目使用 `github` source 且不钉版本,安装时版本取自 `.zcode-plugin/plugin.json`。
- 对齐 `zcode` 适配器:`init` 写入的本地 marketplace 快照不再钉插件版本,`doctor` 接受无版本条目(ZCode 刷新成功后会用仓库 manifest 覆盖该快照)。
