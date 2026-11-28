---
category: Added
packages: root
---

- Enforced per-plan layer publication: a compass `Done` plan without a `PR stack` row is now reported by `mstar lint --type iteration`, reported by the phase-2 iteration gate, refused by the phase-3 gate, and refuses the next `mstar plan complete` with `coordination.layer-unpublished`.
- Updated the `mstar-iteration` Phase 2 and `pr-stack` references and promoted the ADR to `docs/adr/implemented/process/`.

<!-- CN -->
- 新增逐层发布强制：compass 中 `Done` 却没有 `PR stack` 行的 plan，现由 `mstar lint --type iteration` 报告、phase-2 iteration gate 报告、phase-3 gate 拒绝，并让下一次 `mstar plan complete` 以 `coordination.layer-unpublished` 拒绝。
- 更新 `mstar-iteration` Phase 2 与 `pr-stack` 参考，并将 ADR 提升至 `docs/adr/implemented/process/`。
