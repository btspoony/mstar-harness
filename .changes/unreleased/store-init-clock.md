---
category: Fixed
packages: engine
---

- **A supplied clock now stamps every row `store init` writes.** `initializeStore` accepted a `now` clock, but only the two `activated_at` columns read it: the immutable migration SQL seeds `store_meta.created_at`, `execution_meta.root_updated_at` and `projection_meta.checked_at` with SQLite's own `now`, and each `schema_version.applied_at` row took a fresh ambient reading. One store could therefore record `created_at` later than `activated_at`. The creation transaction now reads that clock once and re-stamps the rows the immutable SQL seeded, together with the version ledger it just recorded, so a supplied instant is the only instant a fresh store carries. The shared migration runner keeps its own ambient reading per version row, so an upgrade stamp is unchanged. No new clock option, no configuration, no schema change: a caller that passes nothing still gets the wall clock.

<!-- CN -->
- **传入的时钟现在为 `store init` 写入的每一行打戳。** `initializeStore` 早已接受 `now` 时钟，但只有两个 `activated_at` 列读取它：不可变的迁移 SQL 用 SQLite 自己的 `now` 播种 `store_meta.created_at`、`execution_meta.root_updated_at` 与 `projection_meta.checked_at`，而每行 `schema_version.applied_at` 各取一次环境时钟。同一个 store 因此可能记录出晚于 `activated_at` 的 `created_at`。创建事务现在只读取该时钟一次，并重打不可变 SQL 播种的那些行，以及它刚记录的版本账本，因此新 store 只承载传入的那一个瞬间。共用的迁移运行器仍按行取环境时钟，升级路径打戳行为不变。无新时钟选项、无配置、无 schema 变更：不传时钟的调用方仍得到墙钟时间。
