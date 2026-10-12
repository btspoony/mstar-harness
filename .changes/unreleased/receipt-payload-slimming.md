---
category: Harness
packages: root,engine,commands
---

- **Execution receipt payload slimming**: graph-sized operation receipts (workflow creation, lifecycle transitions, terminal adoption) now persist a slim envelope — `{slim, token, storeId, epoch, operationRecovery?}` — instead of the full root graph, and replay re-serves the live data/token pair for those rows. Per-row size becomes a small constant (pinned by a bounded-size test) instead of scaling with the project graph; plan-verb, bind/recovery and catalog receipts stay byte-faithful for the consumers that parse them.
- **Mixed receipt forms are declared**: `result_json` payloads are write-time versioned — pre-slim rows keep their full form and replay from stored bytes, slim rows carry the envelope — and the `store execution restore-preview` surfaces (engine module header, CLI help, `docs/commands.md`) now say so, so inventory differences from mixed forms are declared, not silent. Versioning is forward-only: an older engine reading a slim row refuses `store.corrupt`; restore the matching build.

<!-- CN -->
- **执行回执载荷瘦身**：graph 级回执（workflow 创建、生命周期转换、terminal adoption）不再持久化完整 root graph，改为瘦身 envelope —— `{slim, token, storeId, epoch, operationRecovery?}`；这些行的 replay 改从 live data/token 对重新提供。单行体积变为小常量（由 bounded-size 测试固定），不再随项目 graph 增长；plan 动词、bind/recovery 与 catalog 回执保持字节原样，供解析它们的消费者使用。
- **混合回执形态已声明**：`result_json` 载荷按写入时版本化 —— 瘦身前写入的行保持完整形态并从存储字节 replay，瘦身后的行携带 envelope；`store execution restore-preview` 的三个面（engine 模块头、CLI 帮助、`docs/commands.md`）已声明该事实，混合形态造成的 inventory 差异是显式的。版本化仅向前兼容：旧引擎读到瘦身行会拒绝 `store.corrupt`，需恢复匹配构建。
