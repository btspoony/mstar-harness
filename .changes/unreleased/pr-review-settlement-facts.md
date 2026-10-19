---
category: Harness
packages: root, engine
---

- **PR-review `incomplete` derives from run facts, never from the wall clock.** The token no longer fires on a maxed tier budget: it fires on exactly three conditions — the run stopped before synthesis, a required domain seat never opened, or the resolved diff basis could not be read — and a run that exceeded its budget with full coverage stays settled, publishes its tally-derived verdict (`ship it` / `needs fixes` / `blocked`) and declares the overrun under `- notes:`.
- **One authority, quoted everywhere.** `mstar-audit` → `references/pr-review.md` § Verdict synthesis owns the trigger list; the tier Budget column, the degradation ladder, the seat-supervision rule and the tally override invariant each point at it in one clause, and the entry surfaces (command `description` + launcher body, `docs/commands.md`, both READMEs) state the same three conditions.
- **No carrier change.** The `incomplete` envelope/report frontmatter, the display block and the tier budget numbers are unchanged; the engine constant's doc comment and the boundary fixture now record that elapsed time is not a settlement fact.
- **Replaced `tally` inputs.** The free-text `--incomplete-reason` cause and the `--unscanned` scope are gone: the CLI now takes the run's own facts — required `--required-domains`, `--opened-domains` (an explicitly empty value means nothing opened) and `--diff-basis readable|unreadable`, plus the optional `--stopped`. Omitting any of the three required facts is refused with the other field diagnostics in one response, never inferred.

<!-- CN -->
- **PR-review 的 `incomplete` 由 run 事实决定，不再由 wall clock 决定。** 该 token 不再因 tier 预算耗尽而触发：它只在三种情况下触发——run 在综合之前被中止、必需领域席位从未打开、已解析的 diff basis 不可读——超时但覆盖完整的 run 仍视为 settled，发布由 tally 推导的结论（`ship it` / `needs fixes` / `blocked`），并在 `- notes:` 中声明超时。
- **单一权威，各处引用。** 触发清单的唯一出处是 `mstar-audit` → `references/pr-review.md` § Verdict synthesis；tier Budget 列、降级阶梯、席位监督规则与 tally override invariant 各用一句话指向它，入口面（命令 `description` 与启动正文、`docs/commands.md`、两个 README）陈述同样的三种情况。
- **载体不变。** `incomplete` 的 envelope／报告 frontmatter、显示块与 tier 预算数值均未改动；engine 常量注释与边界 fixture 现在记录「耗时不是结算事实」。
- **`tally` 入参被替换。** 自由文本的 `--incomplete-reason` 原因与 `--unscanned` 范围已移除：CLI 改为接收 run 自身的事实——必需的 `--required-domains`、`--opened-domains`（显式空值表示没有打开任何领域）与 `--diff-basis readable|unreadable`，外加可选的 `--stopped`。三个必需事实中任一被省略时会被拒绝，并与其它字段诊断一起在同一次响应中报告，绝不推断。
