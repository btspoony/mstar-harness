---
packages: root
---
- Removed the INSTALL.md marketplace version anchor and its release tooling: `release:prepare` no longer bumps a quoted `"version"` field in INSTALL.md and `release:validate` no longer requires one — the ZCode marketplace example (and the marketplace catalogs) are version-less; install-time versions come from `.zcode-plugin/plugin.json`. Follow-up to #183/#184: the anchor's only purpose was being bumped by the release tooling, so it was removed together with the tooling instead of restored.

<!-- CN -->
- 移除 INSTALL.md marketplace 版本锚点及其发布工具链:`release:prepare` 不再 bump INSTALL.md 中带引号的 `"version"` 字段,`release:validate` 也不再要求它——ZCode marketplace 示例与各 marketplace catalog 均无版本字段,安装时版本取自 `.zcode-plugin/plugin.json`。作为 #183/#184 的后续:该锚点唯一的用途就是被发布工具 bump,因此连同工具一起移除,而非恢复。
