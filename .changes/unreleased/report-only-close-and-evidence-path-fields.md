---
category: Harness
packages: root
---

- **Report-only rows now close through the documented route.** `plan complete` refuses with `coordination.invalid-transition` until the workflow records the fulfilment of its registered `completion_policy`, and that refusal now names `mstar workflow evidence` as the recovery instead of asking for the same `plan complete` again. A regression drives a never-prepared `verification/report-only` row `progress` → `complete` → `status workflow-close` to `Done` and a closed lifecycle.
- **Plan-area evidence refusals name the offending payload field.** `assertEvidenceInsidePlanArea` now receives every evidence value with the field that carried it (`qc.reports[]`, `qc.consolidated`, `qa.report`, `evidence_paths[]`, `progress.evidence_paths[]`) and reports `field`, `value` and `allowed` roots in the details and the message, so a prose value or an out-of-area path no longer leaves the caller guessing which member is wrong.
- **`plan complete` publishes the evidence-path rule.** The `qc.reports[]`, `qc.consolidated`, `qa.report` and `evidence_paths[]` schema descriptions and the `--evidence` / `--file` help state that each value is an absolute path to an existing file inside the plan area.

<!-- CN -->
- **report-only 行现在能沿文档化路径关单。** 在 workflow 记录其注册 `completion_policy` 的履行之前，`plan complete` 以 `coordination.invalid-transition` 拒绝，且该拒绝现在把 `mstar workflow evidence` 指为恢复路径，而不是要求再次 `plan complete`。新增回归让一个从未 prepare 的 `verification/report-only` 行走完 `progress` → `complete` → `status workflow-close`，最终 `Done` 并关闭生命周期。
- **plan 区域证据拒绝会指出出错的 payload 字段。** `assertEvidenceInsidePlanArea` 现在连同承载该值的字段接收每个证据值（`qc.reports[]`、`qc.consolidated`、`qa.report`、`evidence_paths[]`、`progress.evidence_paths[]`），并在 details 与消息中报告 `field`、`value` 与允许的根目录，散文值或越界路径不再让调用者猜是哪一项出错。
- **`plan complete` 公开证据路径规则。** `qc.reports[]`、`qc.consolidated`、`qa.report`、`evidence_paths[]` 的 schema 描述与 `--evidence` / `--file` 帮助现在声明：每个值都是 plan 区域内某个已存在文件的绝对路径。
