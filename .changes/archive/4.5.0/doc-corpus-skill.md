---
category: Harness
packages: root, engine
---

- Added **`mstar-doc-corpus`** — the standalone contract for the three-layer document corpus (layer boundary, specs skeleton, ADR record contract, knowledge document shape). It loads no lifecycle topic and needs no store; `mstar-knowledge/references/schema.yaml`, `category-mapping.md` and the track skeleton moved into it.
- `mstar-knowledge` keeps capture and maintenance only: the frontmatter field table is now a pointer, and its catalog step (Capture Phase 6, Maintain Phase 4) applies **only when the harness store is active** — with no store the result records `catalog: n/a (no store)`.
- `mstar-artifacts/references/knowledge-and-designs.md` now owns process artifacts only (iteration, plan, SDD, project references, residuals) and delegates the three layers; every inbound pointer was split accordingly.
- `packages/engine/src/roles.ts`: `lintLoadOrder` exempts `mstar-doc-corpus` from core-first by exact name — corpus authoring precedes, and must not require, lifecycle loading.
- `mstar lint --type adr`, `mstar lint --type specs` and `mstar compound validate <doc>` are unchanged and documented as **optional** validators that run without a store.

<!-- CN -->
- 新增 **`mstar-doc-corpus`** —— 三层文档语料的独立契约（层间边界、specs 骨架、ADR 记录契约、knowledge 文档形状）。它不加载任何生命周期专题、不需要 store；`mstar-knowledge/references/schema.yaml`、`category-mapping.md` 与两轨骨架已迁入其中。
- `mstar-knowledge` 只保留采集与维护：frontmatter 字段表改为指针，catalog 步骤（Capture Phase 6、Maintain Phase 4）**仅在 harness store active 时**适用——无 store 时结果记录 `catalog: n/a (no store)`。
- `mstar-artifacts/references/knowledge-and-designs.md` 现在只拥有过程产物（iteration、plan、SDD、project references、residuals）并委派三层语料；所有入站指针按此拆分。
- `packages/engine/src/roles.ts`：`lintLoadOrder` 按精确名字豁免 `mstar-doc-corpus` 的 core-first 规则——语料撰写先于、且不得要求生命周期加载。
- `mstar lint --type adr`、`mstar lint --type specs` 与 `mstar compound validate <doc>` 行为不变，文档化为**可选**校验器，无需 store 即可运行。
