---
category: Harness
packages: root, engine
---

- **A stored `delivery.proof` block reads as history again.** An intermediate revision persisted that close-owned member, so a store written then failed persisted-state validation (`unknown member(s) proof`), which turned into `PHASE6_INVALID_SNAPSHOT` for the gate and an invalid workflow for `mstar status validate`. `storedDeliveryEvidence` now drops it like `pr` / `completion` / free-text `merge`; every write path still refuses all four.
- **The proof's ownership is stated in one place.** The §4f banner, the `verifyDeliveryEvidence` doc comment, the lifecycle transition's header comment and contract §4(g) now say what the code does: the terminal close runs the merge proof once, and the read-only Phase-6 gate reads the stored terminal facts.
- The merge-proof refusal no longer offers `mstar workflow reopen`, which refuses every terminal status this route can reach.

<!-- CN -->
- **存量 `delivery.proof` 块重新按历史读取。** 中间版本曾持久化这个 close 自有的成员，导致那时写入的 store 在持久状态校验时报 `unknown member(s) proof`，进而变成 gate 的 `PHASE6_INVALID_SNAPSHOT` 与 `mstar status validate` 的 invalid workflow。`storedDeliveryEvidence` 现在像 `pr` / `completion` / 自由文本 `merge` 一样丢弃它；所有写入路径依旧拒绝这四者。
- **证明的归属只在一处陈述。** §4f 段落标题、`verifyDeliveryEvidence` 文档注释、生命周期 transition 的头注释与契约 §4(g) 现在都描述代码实际行为：终态 close 只跑一次 merge 证明，只读 Phase-6 gate 读取已存的终态事实。
- merge 证明的拒绝文案不再建议 `mstar workflow reopen` —— 该命令对这条路径能到达的所有终态都拒绝。
