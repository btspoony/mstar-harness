---
category: Harness
packages: root, dsh
---

- **Agent-flow ledger tail read**: `readAgentFlow` now reads large ledgers (above the 64 KiB read gate) as a bounded latest-first tail — seek from EOF, align the window start to a line boundary, and double the window backward until it holds `limit` complete lines — so the catalog pays O(window) at the byte layer instead of parsing every historical line. Small ledgers keep the existing full-read path verbatim; both paths feed the same parse funnel, so tail/full parity is structural. Write path (append + 500-line truncation under the per-workflow lock) is untouched.

<!-- CN -->
- **Agent-flow 台账尾部读取**：`readAgentFlow` 现以有界的最新优先尾部方式读取大台账（超过 64 KiB 读取门限）——从 EOF 后向展开、对齐行边界，成倍回溯直至窗口含 `limit` 条完整行——目录层按字节支付 O(window)，不再解析每条历史行。小台账保留原有全量读取路径不变；两条路径共用同一解析漏斗，尾部/全量结果结构上一致。写入路径（追加 + 锁内 500 行截断）保持不变。
