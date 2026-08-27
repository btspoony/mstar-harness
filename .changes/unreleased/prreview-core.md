---
category: Harness
packages: root, cli, engine
---

- PR-review deterministic arithmetic and naming contracts moved from LLM hand-computation into tested engine code, exposed as the new `mstar pr-review` command group: `tally` (locked-formula tally/verdict/score + verbatim two-line chat header from accepted findings JSON), `report-path` (local-report/evidence filename resolver with same-day `-r2`/`-r3` collision escalation and never-fabricated SHAs), and `validate-report` (saved-report frontmatter validation: verdict-from-tally, score recompute, comments tri-state). `mstar-audit/references/pr-review.md` § Tally / § Local report archive naming / § Output shape now carry engine-check callouts pointing at these commands.

<!-- CN -->
- PR 审查的确定性算术与命名契约从 LLM 手算迁入经测试的 engine 代码，并以新的 `mstar pr-review` 命令组暴露：`tally`（由已采纳 findings JSON 计算锁定公式的 tally/verdict/score 并输出逐字两行 chat header）、`report-path`（本地报告/证据文件名解析器，含同日 `-r2`/`-r3` 碰撞递增、绝不捏造 SHA）、`validate-report`（已存报告 frontmatter 校验：verdict 由 tally 推导、score 公式重算、comments 三态）。`mstar-audit/references/pr-review.md` 的 § Tally / § 本地报告命名 / § Output shape 现带有指向这些命令的 engine-check callout。
