---
category: Harness
packages: root, engine, cli
---

- Added a **round-bounding dispatch gate**: when `Execute as` is a review seat (`qc-specialist`, `qc-specialist-2`, `qc-specialist-3`, `code-reviewer`, `qa-engineer`) or `Task category` is `audit`, the Assignment must declare both **`Budget (review / QC seats)`** and **`Return shape (review / QC seats)`**. `mstar dispatch validate` now fails such an Assignment when either field is absent, empty, or `N/A`, naming the missing field; implement / ops / docs rounds are unaffected. Only field **presence** is checked — the field values are prose and are never parsed.
- Added **`validateQcReport`** (`@mstar-harness/engine`) and **`mstar qc validate-report <report.md>`** for plan-QC seat reports. The gate checks that the report opens with `---` frontmatter carrying the required `qc` fields, that the frontmatter `verdict` is an enum member and agrees with the body verdict line, that each `## Summary` tally matches the number of entries in its `## Findings` section, that the verdict follows from those counts (no `Approve` with an open Critical or Warning; any `Unconfirmed` count requires the `Unconfirmed` verdict), and that a present `Truncated coverage:` line is never reported as `Unconfirmed` — a cap stop is a scope cut, not a failed evidence channel. Undecidable cases stay silent rather than guessing.
- The report gate reads the **last** verdict line, and `## Summary` is the report's **single current count** — an in-place revalidation refreshes `## Summary` and `## Findings` rather than appending a second tally, so a revalidated report is judged on its current state and every count rule shares one source.
- Wired the checks into the runtime skills: one Engine-check callout in `mstar-review-qc` § 席位预算与截断, pointers from `qc-specialist-shared.md` and the QC report template, and the round-bounding bullet in `mstar-harness-core` § 定向执行与验证边界 now names both required Assignment fields.
- No audit-chain behaviour, verdict vocabulary, severity semantics, register schema, or existing report contract was changed.

<!-- CN -->
- 新增**回合边界派发门禁**：当 `Execute as` 为审查席位（`qc-specialist`、`qc-specialist-2`、`qc-specialist-3`、`code-reviewer`、`qa-engineer`）或 `Task category` 为 `audit` 时，Assignment 必须同时声明 **`Budget (review / QC seats)`** 与 **`Return shape (review / QC seats)`**。`mstar dispatch validate` 在字段缺失、为空或为 `N/A` 时报错并指出缺的是哪一个；implement / ops / docs 轮不受影响。只校验字段**是否存在** —— 字段值是散文，从不解析。
- 新增 **`validateQcReport`**（`@mstar-harness/engine`）与 **`mstar qc validate-report <report.md>`**，用于 plan-QC 席位报告。门禁检查：报告以 `---` frontmatter 开头且带 `qc` 必需字段；frontmatter `verdict` 在枚举内且与正文 verdict 行一致；`## Summary` 各项计数与对应 `## Findings` 区的条目数一致；verdict 由计数推出（存在未解决的 Critical / Warning 时不得 `Approve`；`Unconfirmed` 计数不为 0 时 verdict 必须为 `Unconfirmed`）；已声明的 `Truncated coverage:` 行不得被判为 `Unconfirmed` —— 触顶收口是范围裁剪，不是证据通道失败。无法判定的情况保持静默，不做猜测。
- 报告门禁读取**最后一条** verdict 行，因此"原地复审"实践（编辑同一份报告、更新 frontmatter verdict）按当前 verdict 判定，而计数规则仍将每张表与其对应的 findings 配对。
- 将检查接入运行时 skills：`mstar-review-qc` § 席位预算与截断 新增唯一一条 Engine-check callout，`qc-specialist-shared.md` 与 QC 报告模板给出指针，`mstar-harness-core` § 定向执行与验证边界 的回合边界条目现点名两个必需字段。
- 未改变审计链行为、verdict 词汇、severity 语义、register schema 或既有报告契约。
