---
category: Changed
packages: root
---

- **PR review tier ladder states the `too-large` bypass:** a `default`-tier run on a PR that `mstar pr-review size` calls `too-large` bypassed the inference ladder — the budget it quotes is the `default` row of `PR_REVIEW_TIER_BUDGETS`, not the ladder's answer for that head — so the `deep`-tier run's verdict is the one to read. No budget constant changed; lengthening `default` would have papered over the tier bypass.

<!-- CN -->
- **PR review 层级阶梯写明 `too-large` 绕过情形**：对 `mstar pr-review size` 判为 `too-large` 的 PR 运行 `default` 层级，等于绕过了推理阶梯——它引用的是 `PR_REVIEW_TIER_BUDGETS` 的 `default` 行，而非阶梯对该 head 的答案——因此应以 `deep` 层级的判定为准。预算常量未改；把 `default` 拉长只会掩盖这次层级绕过。
