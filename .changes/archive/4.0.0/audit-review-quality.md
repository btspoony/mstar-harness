---
category: Harness
packages: root, cli, engine, commands, dsh, omp
---

- Added the `/amazing-test-audit` entry (Codex/dsh project command installation included) and the `mstar-audit` test-suite deep method `references/test-audit.md` — value bar, authoring gate, junk-pattern sweep, retention bar, per-candidate evidence, discovery lanes, and whole-subsystem campaign (per-test R/F/C/D ledger); wired into SKILL.md variant dispatch, playbook § 4, and the full-audit scope variants.
- Added the four canonical audit command definitions with bounded scaffold/promotion writes and the existing secret and supply-chain scanners.
- Routed the audit CLI identities through the shared command definitions and added fixture-backed family coverage.
- **Test-authoring audit check:** codebase, test-suite and PR reviews now report incidental, source-shape, wiring or environment-constant assertions with the conclusion “delete, or replace with a product-behaviour assertion”. Aligned implementer and reviewer contracts include the four PR #280 counter-examples while preserving product-behaviour assertions and fails-first regression defences; rejected assertions are never renamed or re-pinned.
- **PR-review score is now a diminishing-deduction score with bands.** `computePrTally` deducts per finding within a class — must-fix 45 then 15 each additional; should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…; nit 2 then 1 each (class cap 8); unverified 5 each (class cap 15) — floors `score_pct` at 0, and annotates the result with a **score band**: `mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60. Verdict derivation is unchanged (count-driven, 3 tokens) and score/band never override it. New engine exports `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`; `PrTallyResult` gains `band`.
- The chat display header is now `{verdict} · {score_pct}% ({band})`, and the posted report's Verdict heading reads `· Score <score_pct>% (<band>)` — the derived number is labeled **Score** (the per-finding `- **Confidence**:` evidence field is a different concept and stays unchanged).
- `mstar pr-review validate-report` recomputes `score_pct` from the same locked schedule (no second formula), and `mstar.review/v1` envelopes accept an optional `tally.band` — absent stays valid, present must be a valid band token. The envelope payload schema/help advertises those tokens, and `MstarReviewV1.tally` uses a band-optional envelope tally shape (`MstarReviewTally`) so legacy band-less envelopes still typecheck.
- Updated `mstar-audit/references/pr-review.md` (deduction schedule table, band definition, worked-example check table, display contract), `commands/amazing-pr-review.md` and `docs/commands.md`.

<!-- CN -->
- 新增 `/amazing-test-audit` 入口（含 Codex/dsh 项目级命令安装）与 `mstar-audit` 测试套件深度方法 `references/test-audit.md` —— 价值门槛、撰写门禁、junk 模式扫描、保留门槛、逐候选证据字段、发现泳道，以及整子系统 campaign（逐测试 R/F/C/D 台账）；并接入 SKILL.md 变体分发、playbook § 4 与 full-audit 范围变体。
- 新增四个规范 audit 命令定义，保留有界 scaffold/promote 写入效果及现有 secret、supply-chain 扫描器。
- 将 audit CLI 身份接入共享命令定义，并新增基于真实夹具的家族行为覆盖。
- **测试编写审计检查：**代码库、测试套件及 PR 审查现在须报告偶然性、源码形状、接线或环境常量断言，并给出“删除，或替换为产品行为断言”的结论。实现与审查契约同步纳入 PR #280 的四个反例，同时保留产品行为断言与修复前先失败的回归防线；被拒绝的断言不得改名或重新固定期望值。
- **PR 审查分数改为递减扣分制并引入分数档位。** `computePrTally` 按类内逐条发现递减扣分——must-fix 首条 45、此后每条 15；should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…；nit 首条 2、此后每条 1（类上限 8）；unverified 每条 5（类上限 15）——`score_pct` 下限为 0，并为结果标注**分数档位**：`mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60。verdict 推导不变（按计数、三个 token），分数与档位永不覆盖 verdict。engine 新增导出 `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`；`PrTallyResult` 新增 `band`。
- chat 显示首行现为 `{verdict} · {score_pct}% ({band})`，GitHub 报告结论标题现为 `· Score <score_pct>% (<band>)`——该推导值标注为 **Score**（每条发现证据字段中的 `- **Confidence**:` 属另一概念，保持不变）。
- `mstar pr-review validate-report` 依据同一套锁定扣分表重算 `score_pct`（不存在第二套公式）；`mstar.review/v1` 信封接受可选的 `tally.band`——缺省仍合法，存在时必须是合法档位 token。信封 payload schema/帮助文本现已列出这些档位 token，且 `MstarReviewV1.tally` 采用 band 可选的 envelope tally 形状（`MstarReviewTally`），使缺少 band 的历史信封仍可通过类型检查。
- 更新 `mstar-audit/references/pr-review.md`（扣分表、档位定义、worked-example 校验表、显示契约）、`commands/amazing-pr-review.md` 与 `docs/commands.md`。
