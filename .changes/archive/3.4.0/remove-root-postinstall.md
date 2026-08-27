---
category: Harness
packages: root
---

- Drop the root `postinstall` hook (`opencode:bundle-assets` && `dsh:bundle-assets`) flagged by static security scanning as an install-time code-execution surface ([high] R10). Asset mirrors are now synced only when explicitly running `bun run <pkg>:bundle-assets` or via each package's build/prepublish chain.

<!-- CN -->
- 移除根 `package.json` 的 `postinstall` 钩子（`opencode:bundle-assets` && `dsh:bundle-assets`）——静态安全扫描将其标记为安装期代码执行面（[high] R10）。资产镜像仅在显式运行 `bun run <pkg>:bundle-assets` 或各包 build/prepublish 链时同步。
