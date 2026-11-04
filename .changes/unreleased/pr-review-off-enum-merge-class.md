---
category: Harness
packages: root, engine
---

- **PR review refuses an off-enum merge class instead of silently counting it as `nit`.** `computePrTally` now throws a `TypeError` for a finding whose `mergeClass` is not one of the four harness classes, matching the boundary posture of its other input guards; a misspelled class previously lost a blocking finding while the tally still looked consistent.
- Corrected the PR-review reference's surface matrix so a wrong `low`-band document is `may-fix`, stated the AC entry shape (`unsafeToShip` required boolean, optional `surface`) beside the tally, and re-measured the published MCP surface to pin it at 33,629.

<!-- CN -->
- **PR 评审对非法合并等级直接拒绝，不再静默计入 `nit`。** `computePrTally` 现对不属于四个 harness 等级的 `mergeClass` 抛出 `TypeError`，与其它输入守卫一致；此前拼错的等级会丢失一个阻断性 finding，而 tally 表面仍然自洽。
- 修正 PR 评审参考文档的表面矩阵，使错误的 `low` 档文档归为 `may-fix`；在 tally 旁说明 AC 条目形状（`unsafeToShip` 必填布尔、`surface` 可选）；重新测量 MCP 已发布表面并钉定为 33,629。
