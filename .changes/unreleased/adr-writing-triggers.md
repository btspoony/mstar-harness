---
category: Changed
packages: root
---

- Point the ADR record contract at the moments a decision is made: the `clarify` closing summary now marks settled decisions meeting the admission test (`ADR:` or `ADR: none`), and a plan's `## Review Gate Summary` carries the same `ADR: <path>|none` pointer that PM Acceptance checks.
- Close the standalone-plan gap: `compound` now performs the ADR judgement for a standalone development plan before its PR, where previously only iteration Phase 3 owned promotion.
- Align iteration Phase 3 §3.2 with the contract — `When a record is required` is the only criterion, without narrowing it to cross-iteration decisions; already-recorded decisions are only checked for freshness and supersession.

<!-- CN -->
- 把 ADR 记录契约挂到决策发生的时刻：`clarify` 收口摘要须标出满足准入条件的已决事项（`ADR:` 或 `ADR: none`），plan 的 `## Review Gate Summary` 带同一 `ADR: <path>|none` 指针，由 PM Acceptance 核对。
- 堵住 standalone plan 的缺口：`compound` 现在为独立 development plan 在 PR 前完成 ADR 判定；此前只有迭代 Phase 3 承担提升。
- 迭代 Phase 3 §3.2 与契约对齐——以 `When a record is required` 为唯一判据，不再收窄为「跨迭代」决策；已记录的只核对 freshness 与 supersession。
