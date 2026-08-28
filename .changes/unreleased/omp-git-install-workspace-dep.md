---
packages: root
---

- Fixed git/hosted installs (`omp plugin install github:btspoony/mstar-harness`, `bun add github:…`) failing at dependency resolution: the root manifest's `@mstar-harness/engine` dependency used the pack-time-only `workspace:*` protocol, unresolvable outside the monorepo. It is now `^3.5.0`, fetched from npm on hosted installs, while dev checkouts still link the workspace member.

<!-- CN -->
- 修复 git/托管安装（`omp plugin install github:btspoony/mstar-harness`、`bun add github:…`）在依赖解析阶段失败的问题：根清单的 `@mstar-harness/engine` 依赖使用了仅在打包期可用的 `workspace:*` 协议，脱离 monorepo 无法解析。现改为 `^3.5.0`，托管安装从 npm 拉取；本地开发检出仍链接 workspace 成员。
