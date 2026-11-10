---
category: Fixed
packages: root, dsh
---

- **The gated composition cases can no longer pass the dsh job by not running.** `isCiEnvironment()` now accepts a nonempty `GITHUB_ACTIONS` as well as a nonempty `CI` (nonempty-string semantics unchanged, including the literal `"false"`), so a runner child that unsets `CI` still executes the ten `test.if(...)` real-composition cases instead of demoting them to skips.
- **A scoped JUnit check reads what the run actually executed.** `Test dsh` emits `.junit-dsh.xml` and a following `check:composition-report` step requires, for the two gated spec files only, a present suite, zero skipped cases, and at least the pinned executed count (2 and 8, held beside the file list) — a missing report, a report with no executed case, one skipped gated case, or a gated case deleted from the run fails the job. More executed cases than pinned pass, so a parametrized case cannot wedge the gate. Skipped cases in other files stay permitted, and the test step's own exit status is untouched because the check is a separate step.

<!-- CN -->
- **门禁覆盖的真实组合用例不能再「没跑也算过」地放行 dsh 作业。** `isCiEnvironment()` 现在同时接受非空的 `GITHUB_ACTIONS` 与非空的 `CI`（非空字符串语义不变，字面量 `"false"` 也算已设置），因此未设置 `CI` 的 runner 子进程依旧会执行这十个 `test.if(...)` 真实组合用例，而不是把它们降级为 skip。
- **限定范围的 JUnit 校验读取这一轮实际执行了什么。** `Test dsh` 会输出 `.junit-dsh.xml`，紧随其后的 `check:composition-report` 步骤只针对两个带门禁的 spec 文件要求：suite 存在、skipped 为零、执行数量达到清单钉住的下限（2 与 8，与文件清单位于同一处）—— 报告缺失、报告中没有任何执行用例、任一受门禁用例被跳过，或受门禁用例被删除，都会让作业变红。执行数量多于下限则放行，参数化不会卡死门禁。其它文件里的 skip 仍然允许；因为校验是独立步骤，测试步骤自身的退出状态不受影响。
