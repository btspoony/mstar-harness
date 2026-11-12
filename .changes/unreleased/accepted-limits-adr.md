---
category: Documentation
packages: root
---

- **The accepted-limits record is implemented, and no limit changed.** `docs/adr/proposed/architecture/2026-11-12-low-sweep-accepted-limits.md` moves to `docs/adr/implemented/architecture/` with its `Proposal` rewritten as a present-tense `Decision` and its acceptance criteria and risks folded into `Consequences`. The five limits (`I-000906`, `I-000907`, `I-000913`, `I-000939`, `I-000196`) keep their reasons and reversal conditions unchanged, and no code behavior changed. The module comments in `store-read.ts`, `projection.ts` and `execution-ledgers.ts` now cite the implemented path.

<!-- CN -->
- **已采纳的边界记录转入 implemented 桶，且没有任何一条边界被改动。** `docs/adr/proposed/architecture/2026-11-12-low-sweep-accepted-limits.md` 迁至 `docs/adr/implemented/architecture/`，原 `Proposal` 改写为现在时 `Decision`，验收标准与风险并入 `Consequences`。五条边界（`I-000906`、`I-000907`、`I-000913`、`I-000939`、`I-000196`）的理由与反转条件保持不变，代码行为无变更。`store-read.ts`、`projection.ts`、`execution-ledgers.ts` 中的模块注释改为引用 implemented 路径。
