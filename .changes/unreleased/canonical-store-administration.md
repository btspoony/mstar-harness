---
category: Fixed
packages: root, commands, cli
---

- **Canonical store administration:** CLI and MCP store operations now accept the project's canonical control root through explicit `--harness` selection or normal project discovery. Backup verification, maintenance locks and migration/activation attestation guards remain in force; command help documents the supported target.

<!-- CN -->
- **Canonical store 管理入口：** CLI 和 MCP 的 store 操作现在支持通过 `--harness` 显式选择或正常项目发现定位 canonical control root。备份校验、维护锁及迁移/激活 attestation 守卫保持生效；命令帮助明确说明支持的目标。
