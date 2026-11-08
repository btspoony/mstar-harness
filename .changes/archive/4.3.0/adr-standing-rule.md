---
category: Harness
packages: root
---

- Added the **standing ADR rule**: `AGENTS.md` gains a `Where to edit` row and a working rule naming `docs/adr/` as the one home for decision rationale that outlives the plan, while `mstar-artifacts`' durable-summaries reference and `mstar-knowledge`'s archive/deletion rule each keep a single pointer to that tree instead of holding the reason themselves.
- All three additions are pointers: the record contract, its skeletons and its lifecycle stay stated only in `docs/adr/README.md`.

<!-- CN -->
- 新增 **ADR 常驻规则**：`AGENTS.md` 增加一行 `Where to edit` 表项与一条 working rule，明确 `docs/adr/` 是「必须比 plan 更长寿的决策理由」的唯一归属地；`mstar-artifacts` 的 durable-summaries 参考与 `mstar-knowledge` 的归档/删除判定，各以一句指针指向同一棵树，而不是把理由留在自己身上。
- 三处新增均为指针：记录契约、骨架与生命周期仍只在 `docs/adr/README.md` 中陈述。
