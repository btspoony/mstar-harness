---
category: Fix
packages: root, cli, engine, commands, dsh
---

- **One severity vocabulary: `critical | high | medium | low | nit`.** The wrong `info` value had spread into the residual/issue severity axis — the engine SSOT, residual validation, CLI payloads and rollups, the dsh view/schema, and the `mstar-artifacts` reference — so every severity site names `nit` again and `info` is refused as an out-of-enum value.
- **Stored severities are converted by a new schema migration**, never by hand-edited rows: it rebuilds the `issues` table with the `nit` CHECK and rewrites the stored `info` values to `nit` while copying, preserving every row. Earlier migration statements and the `warning → low` legacy read normalization are unchanged.

<!-- CN -->
- **唯一 severity 词汇：`critical | high | medium | low | nit`。** 错误的 `info` 已渗入 residual/issue 的 severity 轴 —— 引擎 SSOT、residual 校验、CLI payload 与汇总计数、dsh view/schema，以及 `mstar-artifacts` 参考文档 —— 现在每个 severity 站点重新使用 `nit`，`info` 作为枚举外取值被拒绝。
- **已存储的 severity 由新增 schema 迁移转换**，而非手工改数据：该迁移重建 `issues` 表并使用 `nit` CHECK，在拷贝时将已存的 `info` 改写为 `nit`，保留全部行。更早的迁移语句与 `warning → low` 的 legacy 读取归一化保持不变。
