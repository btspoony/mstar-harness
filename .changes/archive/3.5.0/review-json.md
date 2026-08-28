---
category: Harness
packages: root, cli, engine
---

- Added a first-class **review JSON kind** (`mstar.review/v1`): `synthesizeReview` folds vetted findings into a validated envelope (verdict/tally from `computePrTally`), `mstar-harness persist review` validates the envelope before put (inspector M1 vocab rejected), and `pr-deep-review` / `amazing-pr-review` Stage 3 must persist the envelope — the Markdown report is the optional human copy.

<!-- CN -->
- 新增一等公民 **review JSON kind**（`mstar.review/v1`）：`synthesizeReview` 将已核验 findings 折叠为可校验的 envelope（verdict/tally 来自 `computePrTally`），`mstar-harness persist review` 在写入前校验 envelope（拒绝 inspector M1 词汇），`pr-deep-review` / `amazing-pr-review` Stage 3 必须持久化该 envelope —— Markdown 报告仅为可选的人工副本。
