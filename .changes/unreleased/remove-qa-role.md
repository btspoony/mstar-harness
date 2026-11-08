---
category: Harness
packages: root
---

- **PM Acceptance replaces the QA role:** removes the dedicated `qa-engineer` role and risk-tiered dispatch. The primary PM owns evidence-backed acceptance for every feature size, bug fix, UI/residual-bearing and report-only scope; L2 review and independent QC remain unchanged.
- **Bounded checks, preserved evidence:** PM may directly fill a named acceptance gap with a short bounded check, never implementation, test authoring, long suites or ops. Every required AC retains evidence/results/applicability and issue dispositions. The existing `qa` completion carrier remains; active historical `mandatory` rows recover through ordinary prepare with `--qa-gate pm-acceptance`, preserving prior records and authorship.
- **Historical completion replay:** an exact retry of an already committed `mandatory` completion returns its original receipt; new `mandatory` completions remain refused.
- **Delivery policy alignment:** routing identifies the primary PM rather than an acceptance procedure; report-only completion uses registered policy plus QC/PM Acceptance without an extra fulfilment payload, and reprepare preserves recorded cleanup when `findingsCleanup` is omitted.

<!-- CN -->
- **PM Acceptance 替代 QA 角色：**移除专职 `qa-engineer` 与风险分级派发。所有规模功能、缺陷修复、UI／残留问题及 report-only 范围均由主 PM 负责证据驱动验收，L2 review 与独立 QC 保持不变。
- **有界检查、保留证据：**PM 可为具名验收缺口直接执行短小有界检查，但不得代做实现、编写测试、长套件或运维。每条必需 AC 保留证据、结果、适用性与 issue 处置。沿用 `qa` 完成载体；历史在途 `mandatory` 行通过普通 prepare 的 `--qa-gate pm-acceptance` 恢复，保留旧记录与真实作者。
- **历史完成回执重放：**对已提交的 `mandatory` 完成请求精确重试时返回原回执；新的 `mandatory` 完成请求仍会被拒绝。
- **交付策略对齐：**路由标识主 PM 而非验收流程；report-only 按已登记政策与 QC／PM Acceptance 完成，无需额外 fulfilment payload；reprepare 省略 `findingsCleanup` 时保留已记录的清理策略。
