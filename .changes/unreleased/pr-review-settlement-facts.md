---
category: Harness
packages: root, engine
---

- **PR-review `incomplete` derives from run facts, never from the wall clock.** The token no longer fires on a maxed tier budget: it fires on exactly three conditions — the run stopped before synthesis, a required domain seat never opened, or the resolved diff basis could not be read — and a run that exceeded its budget with full coverage stays settled, publishes its tally-derived verdict (`ship it` / `needs fixes` / `blocked`) and declares the overrun under `- notes:`.
- **One authority, quoted everywhere.** `mstar-audit` → `references/pr-review.md` § Verdict synthesis owns the trigger list; the tier Budget column, the degradation ladder, the seat-supervision rule and the tally override invariant each point at it in one clause, and the entry surfaces (command `description` + launcher body, `docs/commands.md`, both READMEs) state the same three conditions.
- **No carrier change.** The `incomplete` envelope/report frontmatter, the `tally` flags, the display block and the tier budget numbers are unchanged; the engine constant's doc comment and the boundary fixture now record that elapsed time is not a settlement fact.

<!-- CN -->
- **PR-review 的 `incomplete` 由 run 事实决定，不再由 wall clock 决定。** 该 token 不再因 tier 预算耗尽而触发：它只在三种情况下触发——run 在综合之前被中止、必需领域席位从未打开、已解析的 diff basis 不可读——超时但覆盖完整的 run 仍视为 settled，发布由 tally 推导的结论（`ship it` / `needs fixes` / `blocked`），并在 `- notes:` 中声明超时。
- **单一权威，各处引用。** 触发清单的唯一出处是 `mstar-audit` → `references/pr-review.md` § Verdict synthesis；tier Budget 列、降级阶梯、席位监督规则与 tally override invariant 各用一句话指向它，入口面（命令 `description` 与启动正文、`docs/commands.md`、两个 README）陈述同样的三种情况。
- **载体不变。** `incomplete` 的 envelope／报告 frontmatter、`tally` 标志、显示块与 tier 预算数值均未改动；engine 常量注释与边界 fixture 现在记录「耗时不是结算事实」。
