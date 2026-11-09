---
category: Harness
packages: root
---

- **Retained check output is optional again.** The task report's command + observed result is the default evidence; redirecting a check into `{SDD_DIR}/evidence/<task-id>.log` is worth doing only when the Assignment asks for it or the raw text is material to review (long, truncated, disputed).
- Updated `mstar-sdd` (`file-handoffs.md` § Optional retained output, both implementer prompts, `SKILL.md`), `mstar-review-qc`, and `qa-engineer` (+ `acceptance-gate.md`): reviewers and QA apply the retained-log mapping only when a log is cited, and the integrity, coverage, reuse and no-rerun rules are unchanged.

<!-- CN -->
- **保留检查输出重新变为可选。** 任务报告中的命令 + 实测结果即默认证据；仅当 Assignment 要求、或原始文本对评审确实重要（很长、被截断、有争议）时，才值得把检查重定向到 `{SDD_DIR}/evidence/<task-id>.log`。
- 更新 `mstar-sdd`（`file-handoffs.md` § Optional retained output、两份 implementer prompt、`SKILL.md`）、`mstar-review-qc` 与 `qa-engineer`（含 `acceptance-gate.md`）：评审者与 QA 仅在任务报告引用日志时套用保留日志映射，完整性、覆盖、复用与绝不重跑规则保持不变。
