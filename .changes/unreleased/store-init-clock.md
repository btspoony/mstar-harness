---
category: Fixed
packages: engine
---

- **A supplied clock now stamps every row an `initializeStore` transaction writes.** `store init` accepted a `now` clock, but only the two `activated_at` columns read it: the immutable migration SQL seeds `store_meta.created_at`, `execution_meta.root_updated_at` and `projection_meta.checked_at` with SQLite's own `now`, and every `schema_version.applied_at` row took a fresh ambient reading. One store could therefore record `created_at` later than `activated_at`. The creation transaction now reads that clock once and re-stamps the rows it just inserted, and the migration runner stamps a batch's version rows from one reading instead of one per row. No new clock option, no configuration, no schema change: a caller that passes nothing still gets the wall clock, exactly once.

<!-- CN -->
- **传入的时钟现在为 `initializeStore` 事务写入的每一行打戳。** `store init` 早已接受 `now` 时钟，但只有两个 `activated_at` 列读取它：不可变的迁移 SQL 用 SQLite 自己的 `now` 播种 `store_meta.created_at`、`execution_meta.root_updated_at` 与 `projection_meta.checked_at`，而每行 `schema_version.applied_at` 各取一次环境时钟。同一个 store 因此可能记录出晚于 `activated_at` 的 `created_at`。创建事务现在只读取该时钟一次并重打它刚插入的行；迁移运行器也用单次读数打整批版本行，而非逐行读取。无新时钟选项、无配置、无 schema 变更：不传时钟的调用方仍得到墙钟时间，且只读一次。
