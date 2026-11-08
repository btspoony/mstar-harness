---
category: Harness
packages: root, engine
---

- **A stored `delivery.proof` block reads as history again.** An intermediate revision persisted that close-owned member, so a store written then failed persisted-state validation (`unknown member(s) proof`), which turned into `PHASE6_INVALID_SNAPSHOT` for the gate and an invalid workflow for `mstar status validate`. `storedDeliveryEvidence` now drops it like `pr` / `completion` / free-text `merge`; every write path still refuses all four.
- **The proof's ownership is stated in one place.** The §4f banner, the `verifyDeliveryEvidence` doc comment, the lifecycle transition's header comment and contract §4(g) now say what the code does: the terminal close runs the merge proof once, and the read-only Phase-6 gate reads the stored terminal facts.
- The merge-proof refusal no longer offers `mstar workflow reopen`, which refuses every terminal status this route can reach.
- **One tolerance, every reader.** The retired members are read as history by the store, the projection, the Phase-6 gate and the host file gates alike — a hand-written snapshot that already carries one stays valid and writable, because rewriting history is not a repair. What still refuses them is the delivery-patch write (`deliveryEvidenceMembers` + the strict delivery shape), so no verb records one; a whole-document path (a hand-written file, or a legacy import carrying the header verbatim) may still deliver one, and reading it back is history preservation.

<!-- CN -->
- **存量 `delivery.proof` 块重新按历史读取。** 中间版本曾持久化这个 close 自有的成员，导致那时写入的 store 在持久状态校验时报 `unknown member(s) proof`，进而变成 gate 的 `PHASE6_INVALID_SNAPSHOT` 与 `mstar status validate` 的 invalid workflow。`storedDeliveryEvidence` 现在像 `pr` / `completion` / 自由文本 `merge` 一样丢弃它；所有写入路径依旧拒绝这四者。
- **证明的归属只在一处陈述。** §4f 段落标题、`verifyDeliveryEvidence` 文档注释、生命周期 transition 的头注释与契约 §4(g) 现在都描述代码实际行为：终态 close 只跑一次 merge 证明，只读 Phase-6 gate 读取已存的终态事实。
- merge 证明的拒绝文案不再建议 `mstar workflow reopen` —— 该命令对这条路径能到达的所有终态都拒绝。
- **一份容忍，所有读者共用。** store、projection、Phase-6 gate 与各 host 的文件门禁都以同样的方式把退役成员读作历史 —— 手写文件中已存在的成员保持有效可写，因为改写历史不是修复。仍然拒绝它们的是 delivery patch 写入（`deliveryEvidenceMembers` + 严格的 delivery 形状），因此没有任何 verb 会记录它们；整文档路径（手写文件，或原样携带 header 的 legacy import）仍可能带进来，把它读回属于保留历史而非修复。
