---
packages: root, opencode
---

- `/pr-deep-review` now emits a merge signal computed from the finding tally: the middle verdict token is renamed `needs review` → `needs fixes`, each accepted PR finding carries a `Merge class` (`must-fix` | `should-fix` | `nit`), and the output shape gains `- score_pct:` (derived, `max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)`, floor 0) and `- tally:` with four counts. The verdict is derived from the tally (`must-fix ≥ 1` → `blocked`, else `should-fix ≥ 1` → `needs fixes`, else `ship it`); `score_pct` is display-only and never overrides it. Chat and the GitHub Review `body` open with `{verdict} · {score_pct}%` plus the tally line; `event` remains `COMMENT`. The list cut now applies to nits only — every `must-fix` / `should-fix` is listed. Formula and rules are SSOT'd in `skills/mstar-audit/references/pr-review.md` § Verdict synthesis / Tally and derived score.

<!-- CN -->
- `/pr-deep-review` 现在基于 finding 计数（tally）输出合并信号：中间结论词 `needs review` 更名为 `needs fixes`，每个已接受的 PR finding 携带 `Merge class`（`must-fix` | `should-fix` | `nit`），输出形状新增 `- score_pct:`（`max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)`，下限 0）与 `- tally:` 四项计数。结论由 tally 推导（`must-fix ≥ 1` → `blocked`，否则 `should-fix ≥ 1` → `needs fixes`，否则 `ship it`）；`score_pct` 仅为展示反馈，绝不覆盖结论。聊天输出与 GitHub Review `body` 以 `{verdict} · {score_pct}%` 加 tally 行开头；事件仍为 `COMMENT`。发现列表裁剪规则现仅作用于 nits —— 所有 `must-fix` / `should-fix` 都会列出。公式与 tally 标准 SSOT 于 `skills/mstar-audit/references/pr-review.md` § Verdict synthesis / Tally and derived score。
