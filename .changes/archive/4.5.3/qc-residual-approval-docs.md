---
category: Harness
packages: root
---

- **The QC seat documents the residual approval it already had.** A seat's body conclusion `Approve with residuals` is an `Approve` — the validator reads the body phrase by its longest enum prefix — so the frontmatter keeps one of the four tokens and the leftovers are captured as plan-linked issues under `Findings cleanup: allow-residual`, never as a fifth verdict or a residual-list field. `report-template.md` and `qc-specialist-shared.md` now state that shape, and `qcreview.test.ts` covers a residual-listed approval report validating cleanly.

<!-- CN -->
- **QC 席位文档写明它本已拥有的残余批准形状。** 席位的正文结论 `Approve with residuals` 就是 `Approve`——校验器按最长词表前缀读取正文短语——因此 frontmatter 仍只写四个 token 之一，遗留项按 `Findings cleanup: allow-residual` 捕获为该计划关联 issue，而不是第五个 verdict 或残余清单字段。`report-template.md` 与 `qc-specialist-shared.md` 现已写明该形状，`qcreview.test.ts` 覆盖了带残余的批准报告校验通过。
