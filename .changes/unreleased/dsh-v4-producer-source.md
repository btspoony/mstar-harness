---
category: Changed
packages: dsh
---

- **dsh plugin**: the engine-status catalog row now emits the producer-owned `{ kind: 'mstar-engine', form: 'catalog' }` source instead of the retired `{ kind: 'plugin', plugin: 'mstar-engine' }` wrapper. dsh session-format V4 refuses that wrapper at message admission (`format v4 message requires a producer-owned source kind`), so every composed step failed to persist; the panel anchor reader now accepts the V3→V4-migrated legacy kinds (`plugin:mstar-engine` and `plugin:mstar-engine-status`), keeping existing sessions anchored.
- Added a regression test that runs the real composed row through dsh's V4 row admission, and proves that admission refuses the retired wrapper.

<!-- CN -->
- **dsh 插件**：engine-status catalog 行改为发出生产者自有的 `{ kind: 'mstar-engine', form: 'catalog' }` source，不再使用已退役的 `{ kind: 'plugin', plugin: 'mstar-engine' }` 包装。dsh session-format V4 在消息准入处拒绝该包装（`format v4 message requires a producer-owned source kind`），导致每个组合步骤都无法持久化；面板锚点读取方现同时接受 V3→V4 迁移后的旧 kind（`plugin:mstar-engine` 与 `plugin:mstar-engine-status`），既有会话的锚点保持可用。
- 新增回归测试：把真实组合出的行送入 dsh V4 行准入校验，并证明该校验会拒绝已退役的包装。
