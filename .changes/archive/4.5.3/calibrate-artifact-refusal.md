---
category: Harness
packages: root
---

- **`calibrate` reads its gold and source shards through the artifact helper**, so a missing `gold/adjudicated.jsonl` or `sources/shard-N.jsonl` refuses with `jev.artifact-missing: <relative path>` instead of leaking a raw `ENOENT` with the absolute run root. The exit code and fail-closed behaviour are unchanged.

<!-- CN -->
- **`calibrate` 现通过 artifact helper 读取 gold 与来源分片**：缺失 `gold/adjudicated.jsonl` 或 `sources/shard-N.jsonl` 时以 `jev.artifact-missing: <相对路径>` 拒绝，而不再泄漏带绝对 run root 的原始 `ENOENT`。退出码与 fail-closed 行为不变。
