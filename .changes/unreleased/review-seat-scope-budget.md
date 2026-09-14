---
category: Harness
packages: root
---

- Added a **review-seat termination contract** in `mstar-harness-core` § 定向执行与验证边界: read-only review / QC / L2 seats are bounded by a default seat budget, stop there instead of expanding until a human steers, and declare `Truncated coverage:` — which stays distinct from `Unconfirmed`.
- Extended the canonical Assignment template with **`Budget` / `Return shape` / `Severity bar` / `Input provenance`** for review / QC rounds, plus a quantitative-stop dispatch invariant, an unbounded-negative-acceptance anti-pattern, and two PM self-check rules for artifact claims and `path:line` citations.
- Threaded the rule through the seat side (`qc-specialist-shared`, `reviewer-workflow`, `report-template`, `mstar-sdd` task reviewer) and PM orchestration (`mstar-review-qc`): a truncated seat stops and declares its coverage, and a gate decision on uncovered scope is not an approval. Tightened the residual **severity bar** in `mstar-artifacts`: `critical` vs `high` now turns on whether the unsafe outcome is reachable on this merge, independently of the QC report section the finding was filed under, so an unsafe reachable finding cannot ride `Approve with residuals`; grading is by consequence, not uncertainty, and a documentation defect grades by its own consequence when it would drive an unsafe outcome — removing the "when unsure, use `high`" default that turned non-blocking documentation findings into blocking ones.

<!-- CN -->
- 在 `mstar-harness-core` § 定向执行与验证边界 新增**只读审查席位终止契约**：review / QC / L2 席位受默认席位预算约束，触达即停止扩展而非等到人工干预，并声明 `Truncated coverage:`——该状态与 `Unconfirmed` 保持区分。
- 规范化 Assignment 模板新增 review / QC 轮次的 **`Budget` / `Return shape` / `Severity bar` / `Input provenance`** 字段，并补充定量停止派发不变量、无界否证式验收反模式，以及两条 PM 自检规则（产物声明与 `path:line` 引用来源）。
- 将规则贯通到席位侧（`qc-specialist-shared`、`reviewer-workflow`、`report-template`、`mstar-sdd` task reviewer）与 PM 编排（`mstar-review-qc`）：截断的席位停止并声明其覆盖范围，未覆盖范围上的 gate decision 不构成批准。收紧 `mstar-artifacts` 的 residual **severity bar**：`critical` 与 `high` 现以「不安全后果在本次 merge 上是否可达」区分，与 finding 落在哪个 QC 报告 section 无关，因此可达的不安全 finding 无法借 `Approve with residuals` 过关；分级按后果而非不确定度，文档缺陷若本身会导致不安全后果则按该后果分级——并移除把非阻断文档发现升级为阻断项的 “when unsure, use `high`” 默认。
