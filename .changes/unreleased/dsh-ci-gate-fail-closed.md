---
category: Fixed
packages: root, dsh
---

- **The gated composition cases can no longer pass the dsh job by not running.** `isCiEnvironment()` now accepts a nonempty `GITHUB_ACTIONS` as well as a nonempty `CI` (nonempty-string semantics unchanged, including the literal `"false"`), so a runner child that unsets `CI` still executes the ten `test.if(...)` real-composition cases instead of demoting them to skips.
- **A scoped JUnit check counts only the gated cases.** `Test dsh` emits `.junit-dsh.xml` and a following `check:composition-report` step requires, for the two gated spec files only, a present suite, zero skipped **gated** cases, and at least the pinned **gated** count (2 and 8, held beside the file list). A gated case is one whose reported title carries the recorded skip reason, so the ordinary cases those two files also contain cannot stand in for a deleted gated one: a missing report, no executed gated case (including a many-case file whose gated cases were all deleted), one skipped gated case, or one gated case short of the pinned count fails the job. More gated cases than pinned pass, so a parametrized case cannot wedge the gate. Skips of ordinary cases — including inside the gated spec files — and skips in other files stay permitted, and the test step's own exit status is untouched because the check is a separate step.

<!-- CN -->
- **门禁覆盖的真实组合用例不能再「没跑也算过」地放行 dsh 作业。** `isCiEnvironment()` 现在同时接受非空的 `GITHUB_ACTIONS` 与非空的 `CI`（非空字符串语义不变，字面量 `"false"` 也算已设置），因此未设置 `CI` 的 runner 子进程依旧会执行这十个 `test.if(...)` 真实组合用例，而不是把它们降级为 skip。
- **限定范围的 JUnit 校验只统计受门禁用例。** `Test dsh` 会输出 `.junit-dsh.xml`，紧随其后的 `check:composition-report` 步骤只针对两个带门禁的 spec 文件要求：suite 存在、被跳过的**受门禁用例**为零、**受门禁用例**的执行数量达到清单钉住的下限（2 与 8，与文件清单位于同一处）。受门禁用例以「报告标题带记录在案的 skip 原因」为准，因此这两个文件里同时存在的普通用例不能顶替被删掉的受门禁用例：报告缺失、没有任何已执行的受门禁用例（包括用例很多但受门禁用例被全部删掉的文件）、任一受门禁用例被跳过，或受门禁用例少一个，都会让作业变红。受门禁用例多于下限则放行，参数化不会卡死门禁。普通用例的 skip（包括这两个文件内部的）以及其它文件里的 skip 仍然允许；因为校验是独立步骤，测试步骤自身的退出状态不受影响。
