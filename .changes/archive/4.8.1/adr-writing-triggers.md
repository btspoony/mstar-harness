---
category: Changed
packages: root
---

- Point the ADR record contract at the moment a decision is made: the `clarify` closing summary now marks settled decisions meeting the admission test (`ADR:` or `ADR: none`), and a plan's `## Review Gate Summary` carries `ADR: <path>|none` before `Done`, checked by PM Acceptance.
- Make the plan-level judgement cover standalone plans too: their record is written before `Done` and acceptance, not in `compound` — whose knowledge scoring could skip the step.
- Align iteration Phase 3 §3.2 with the contract — `When a record is required` is the only criterion, without narrowing it to cross-iteration decisions; already-recorded decisions are only checked for freshness and supersession.

<!-- CN -->
- 把 ADR 记录契约挂到决策发生的时刻：`clarify` 收口摘要须标出满足准入条件的已决事项（`ADR:` 或 `ADR: none`），plan 的 `## Review Gate Summary` 在 `Done` 前带同一 `ADR: <path>|none` 指针，由 PM Acceptance 核对。
- 让 plan 级判定覆盖 standalone plan：记录在 `Done` 与验收之前写入，不放在 `compound`——其知识结晶评分可能整步跳过。
- 迭代 Phase 3 §3.2 与契约对齐——以 `When a record is required` 为唯一判据，不再收窄为「跨迭代」决策；已记录的只核对 freshness 与 supersession。
