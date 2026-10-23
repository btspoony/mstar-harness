---
category: Changed
packages: engine
---

- **`mstar.review/v1` is a closed key set.** `validateMstarReviewV1` now refuses any key outside the envelope it documents — `schema`, `verdict`, `summary_md`, `findings`, `incomplete`, `tally`, `target` — and any key outside a provided tally's `PrTallyResult` members, reporting one `review.unknown-key` violation per offending key with its full path (`declaredScopes`, `tally.declaredScopes`). The key sets are derived from what the validator already reads and `synthesizeReview` already produces, so every previously valid envelope stays valid; a stray key is refused instead of persisted as an unreadable claim.

<!-- CN -->
- **`mstar.review/v1` 成为封闭键集。** `validateMstarReviewV1` 现在会拒绝其所声明 envelope 之外的任何键——`schema`、`verdict`、`summary_md`、`findings`、`incomplete`、`tally`、`target`——以及所提供 tally 中 `PrTallyResult` 成员之外的任何键，每个越界键报一条 `review.unknown-key` 违规并携带完整路径（`declaredScopes`、`tally.declaredScopes`）。键集从校验器已读取的字段与 `synthesizeReview` 已产出的字段推导而来，因此所有原本合法的 envelope 仍然合法；越界键不再作为不可解读的声明被持久化，而是被拒绝。
