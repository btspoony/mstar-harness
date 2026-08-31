---
packages: root
---

- Prerelease versions (`X.Y.Z-suffix`, e.g. `3.6.0-alpha.1`) now flow through `release:prepare` / `release:validate` / publish: npm publishes under the dist-tag `alpha` (never `latest`), the GitHub Release is flagged prerelease, and the INSTALL.md marketplace example stays on the last stable release.

<!-- CN -->
- 预发布版本（`X.Y.Z-suffix`，如 `3.6.0-alpha.1`）现可完整走通 `release:prepare` / `release:validate` / 发布流程：npm 以 `alpha` dist-tag 发布（绝不触碰 `latest`），GitHub Release 标记为预发布，INSTALL.md 市场示例保持在上一个稳定版本。
