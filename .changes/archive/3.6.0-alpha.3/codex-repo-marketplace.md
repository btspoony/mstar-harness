---
category: CLI
packages: root, cli
---
- Codex installs now use a repo-bundled marketplace: the harness repo ships `.agents/plugins/marketplace.json` (name `mstar-repo`, plugin root = repo root), and `npx @mstar-harness/cli init --target codex` registers it via `codex plugin marketplace add btspoony/mstar-harness --ref main`. Install with `codex plugin add morning-star-harness@mstar-repo`; refresh snapshots with `codex plugin marketplace upgrade`. `doctor --target codex` validates the marketplace registration via the codex CLI and reports legacy `personal` marketplace entries as a migration note; Codex custom-agent `.toml` symlinks continue to come from the shared `~/.mstar/harness` checkout.

<!-- CN -->
- Codex 安装改为仓库自带 marketplace：仓库新增 `.agents/plugins/marketplace.json`（marketplace 名 `mstar-repo`，插件根 = 仓库根），`npx @mstar-harness/cli init --target codex` 通过 `codex plugin marketplace add btspoony/mstar-harness --ref main` 注册 git marketplace（本地条目路径由 `~/.agents/plugins/marketplace.json` 迁移到仓库 marketplace）。安装命令为 `codex plugin add morning-star-harness@mstar-repo`；`codex plugin marketplace upgrade` 可刷新快照。`doctor --target codex` 通过 codex CLI 校验 marketplace 注册，旧 `personal` 条目以迁移提示展示；Codex 自定义 agent `.toml` 软链接仍来自共享 `~/.mstar/harness` checkout。